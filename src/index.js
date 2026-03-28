import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, ActivityType } from 'discord.js';
import { config } from './config.js';
import { handleMessage } from './handler.js';
import { acquireLock, releaseLock } from './lock.js';
import { decide, observeMessage, onMention, onMayaReply, onMayaReact, getModeLabel, getEngagedUser } from './presence.js';
import { startDreamLoop } from './dream.js';
import { trainNLP } from './nlp.js';
import { replyDelay } from './llm.js';
import { startSTM, openSession, recordSessionMessage } from './stm.js';
import { generateImage } from './imagegen.js';
import db from './db.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// ── Spam batcher ──────────────────────────────────────────────────────────────
// When a user sends multiple messages rapidly in the same channel,
// buffer them and process only the combined/last message.
// Key: `${channelId}:${userId}` → { timer, messages[] }
const _spamBatch = new Map();
const BATCH_WINDOW_MS = 1500;   // wait 1.5s for more messages before processing

function _batchMessage(channelId, userId, msg, onFlush) {
  const key = `${channelId}:${userId}`;
  const existing = _spamBatch.get(key);

  if (existing) {
    // More messages from same user — add to batch and reset timer
    clearTimeout(existing.timer);
    existing.messages.push(msg);
    existing.timer = setTimeout(() => {
      _spamBatch.delete(key);
      onFlush(existing.messages);
    }, BATCH_WINDOW_MS);
  } else {
    // First message — start batch window
    const batch = {
      messages: [msg],
      timer: setTimeout(() => {
        _spamBatch.delete(key);
        onFlush(batch.messages);
      }, BATCH_WINDOW_MS),
    };
    _spamBatch.set(key, batch);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async () => {
  console.log(`[bot] Logged in as ${client.user.tag} ✓`);
  client.user.setActivity('your messages 👀', { type: ActivityType.Watching });
  const { ensureCollection } = await import('./vector.js');
  await ensureCollection().catch(e => console.warn('[bot] Qdrant setup:', e.message));
  await trainNLP().catch(e => console.warn('[bot] NLP training:', e.message));
  startDreamLoop();
  startSTM();
});

// ── Message handler ───────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;

  const content    = msg.content.trim();
  const channelId  = msg.channel.id;
  const isDM       = !msg.guild;

  const hasAttachments = msg.attachments.size > 0;
  const hasEmbeds      = msg.embeds.length > 0;
  const hasStickers    = msg.stickers.size > 0;
  const hasMedia       = hasAttachments || hasEmbeds || hasStickers;

  if (!content && !hasMedia) return;

  const allowed = config.discord.allowedChannels;
  if (allowed.length > 0 && msg.guild && !allowed.includes(channelId)) return;

  // Observe every message for conversation state tracking (always)
  if (!isDM) observeMessage(channelId, msg.author.id);

  const isMention  = msg.mentions.has(client.user);
  const hasKeyword = /\bmaya\b/i.test(content);

  // Check if Maya is in an active conversation with this user
  // If ENGAGED with this specific user, let their messages through
  // even without a mention — that's what continuation means
  const engagedWith = isDM ? null : getEngagedUser(channelId);
  const isEngaged   = engagedWith === msg.author.id;

  // Gate: process if directly addressed, DM, keyword, or continuation
  const shouldProcess = isMention || isDM || hasKeyword || isEngaged;
  if (!content && hasMedia && !isMention && !isDM && !isEngaged) return;
  if (!shouldProcess) return;

  // ── Spam batching — applies to BOTH server and DMs ─────────────────────
  // Buffer rapid messages from same user and process as one combined message
  _batchMessage(channelId, msg.author.id, msg, (messages) => {
    _processMessages(messages, client).catch(e =>
      console.error('[bot] batch process error:', e.message)
    );
  });
  // Always return here — processing happens in the flush callback
});

// ── Core processing ───────────────────────────────────────────────────────────

async function _processMessages(messages, client) {
  // Use the last message as the primary one for replying
  const msg     = messages[messages.length - 1];
  const content = msg.content.trim();
  const channelId = msg.channel.id;
  const isDM    = !msg.guild;

  const hasAttachments = msg.attachments.size > 0;
  const hasEmbeds      = msg.embeds.length > 0;
  const hasStickers    = msg.stickers.size > 0;
  const hasMedia       = hasAttachments || hasEmbeds || hasStickers;

  const isMention = msg.mentions.has(client.user);
  const hasKeyword = /\bmaya\b/i.test(content);

  // If multiple messages were batched, combine their text
  const allTexts = messages
    .map(m => m.content.replace(/<@!?\d+>/g, '').trim())
    .filter(Boolean);

  let text = allTexts.join(' ').trim();
  if (!text && hasMedia) text = '[media]';

  if (!text && !hasMedia) return;

  if (messages.length > 1) {
    console.log(`[bot] batched ${messages.length} msgs from ${msg.author.username}: "${text.slice(0, 60)}"`);
  }

  // ── Distributed lock (use last message ID) ────────────────────────────────
  const lockKey = `msg_${msg.id}`;
  const locked  = await acquireLock(lockKey);
  if (!locked) return;

  // ── Set DB cooldown BEFORE processing ────────────────────────────────────
  // Re-check engaged state inside _processMessages (not available from outer scope)
  if (!isDM) {
    const engagedNow    = getEngagedUser(channelId);
    const isEngagedNow  = engagedNow === msg.author.id;
    const preProcessTTL = isEngagedNow ? 7_000 : 22_000;
    await db.execute(
      `INSERT INTO maya_state (state_key, value) VALUES (?,?)
       ON DUPLICATE KEY UPDATE value=VALUES(value), updated_at=NOW()`,
      [`reply_${channelId}`, new Date(Date.now() + preProcessTTL).toISOString()]
    ).catch(() => {});
  }

  let isReply = false;
  if (msg.reference?.messageId) {
    try {
      const ref = await msg.channel.messages.fetch(msg.reference.messageId);
      isReply = ref?.author?.id === client.user.id;
    } catch { /* non-fatal */ }
  }

  if (!text) {
    await msg.reply('Bol bhai, kuch toh bol! 😏').catch(() => {});
    await releaseLock(lockKey);
    return;
  }

  try {
    const result = await handleMessage({
      userId:      msg.author.id,
      username:    msg.author.username,
      displayName: msg.member?.displayName || msg.author.username,
      avatarUrl:   msg.author.displayAvatarURL({ size: 64 }),
      message:     text,
      guildId:     msg.guild?.id || null,
      msg,
      isMention,
      isReply,
      hasMedia,
    });

    if (isMention && !isDM) {
      onMention(channelId, msg.author.id);
      openSession(channelId, msg.guild?.id || null, msg.author.id).catch(() => {});
    }

    if (!isDM && channelId) {
      recordSessionMessage(channelId, {
        userId:   msg.author.id,
        userName: msg.member?.displayName || msg.author.username,
        sender:   'user',
        message:  text,
      }).catch(() => {});
      if (result?.type === 'reply') {
        recordSessionMessage(channelId, {
          userId: 'maya', userName: 'Maya',
          sender: 'maya', message: result.text,
        }).catch(() => {});
      }
    }

    if (result === null) return;

    // Human-feel delay before reply
    if (result.type === 'reply') {
      const delayMs = replyDelay(text.length);
      await msg.channel.sendTyping().catch(() => {});
      await new Promise(r => setTimeout(r, delayMs));
    }

    if (result.type === 'react') {
      onMayaReact(channelId);
      await msg.react(result.emoji).catch(() => {
        console.warn(`[bot] react failed: ${result.emoji}`);
      });

    } else if (result.type === 'image') {
      await msg.channel.sendTyping().catch(() => {});
      try {
        const { buffer, filename, prompt } = await generateImage(result.prompt);
        await msg.reply({
          content: 'here you go ✨',
          files:   [{ attachment: buffer, name: filename }],
        });
        console.log(`[imagegen] sent for prompt: "${result.prompt.slice(0, 60)}"`);
      } catch (err) {
        console.error('[imagegen] failed:', err.message);
        await msg.reply('ugh image nahi bana, try again? 😭').catch(() => {});
      }

    } else {
      onMayaReply(channelId, msg.author.id);
      const replyText = result.text;
      if (replyText.length <= 2000) {
        await msg.reply(replyText);
      } else {
        const chunks = replyText.match(/[\s\S]{1,1990}/g) || [replyText];
        for (const chunk of chunks) {
          await msg.channel.send(chunk);
        }
      }
    }

  } catch (err) {
    console.error('[bot] pipeline error:', err.message, err.stack);
    await msg.reply('try again? 😅').catch(() => {});
  } finally {
    await releaseLock(lockKey);
  }
}

client.on(Events.Error, err => console.error('[bot] Client error:', err));
process.on('unhandledRejection', err => console.error('[bot] Unhandled rejection:', err));

client.login(config.discord.token);
