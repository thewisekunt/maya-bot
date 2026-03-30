import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, ActivityType } from 'discord.js';
import { config } from './config.js';
import { handleMessage } from './handler.js';
import { acquireLock, releaseLock } from './lock.js';
import { onMention, onMayaReply, onMayaReact, observeMessage, getEngagedUser } from './presence.js';
import { startDreamLoop } from './dream.js';
import { trainNLP } from './nlp.js';
import { replyDelay } from './llm.js';
import { startSTM, openSession, recordSessionMessage } from './stm.js';
import { generateImage } from './imagegen.js';
import { scan, refreshAliases } from './scanner.js';
import { evaluate } from './notif.js';
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
const _spamBatch   = new Map();
const BATCH_WINDOW = 1500;

function _batch(key, item, onFlush) {
  const existing = _spamBatch.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    existing.items.push(item);
    existing.timer = setTimeout(() => { _spamBatch.delete(key); onFlush(existing.items); }, BATCH_WINDOW);
  } else {
    const b = { items: [item], timer: setTimeout(() => { _spamBatch.delete(key); onFlush(b.items); }, BATCH_WINDOW) };
    _spamBatch.set(key, b);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async () => {
  console.log(`[bot] Logged in as ${client.user.tag} ✓`);
  client.user.setActivity('your messages 👀', { type: ActivityType.Watching });
  const { ensureCollection } = await import('./vector.js');
  await ensureCollection().catch(e => console.warn('[bot] Qdrant:', e.message));
  await trainNLP().catch(e => console.warn('[bot] NLP:', e.message));
  startDreamLoop();
  startSTM();
});

// ── Message handler ───────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;

  const content   = msg.content.trim();
  const channelId = msg.channel.id;
  const isDM      = !msg.guild;
  const guildId   = msg.guild?.id || null;

  const hasMedia = msg.attachments.size > 0 || msg.embeds.length > 0 || msg.stickers.size > 0;
  if (!content && !hasMedia) return;

  // Channel allowlist
  const allowed = config.discord.allowedChannels;
  if (allowed.length > 0 && msg.guild && !allowed.includes(channelId)) return;

  // ── Always observe for conversation state ────────────────────────────────
  if (!isDM) {
    observeMessage(channelId, msg.author.id);
    // Refresh alias cache periodically (uses guildId)
    refreshAliases(guildId).catch(() => {});
  }

  // ── PATH 1: Engaged continuation (no scan needed) ────────────────────────
  // If Maya is actively engaged with this user, let messages through directly
  const engagedWith = isDM ? null : getEngagedUser(channelId);
  if (engagedWith === msg.author.id) {
    _batch(`${channelId}:${msg.author.id}`, msg, (msgs) => {
      _processEngaged(msgs, client).catch(e => console.error('[bot] engaged error:', e.message));
    });
    return;
  }

  // ── PATH 2: Scanner → Notification → Evaluate ────────────────────────────
  const notif = scan(msg, client.user.id);
  if (!notif) return;   // no trigger — silent observation only

  // Batch rapid messages from same user before evaluating
  _batch(`notif:${channelId}:${msg.author.id}`, msg, (msgs) => {
    _processNotification(msgs, notif, client).catch(e => console.error('[bot] notif error:', e.message));
  });
});

// ── PATH 1: Engaged continuation ─────────────────────────────────────────────
// Maya is already in active conversation — skip notification evaluation,
// go straight to handler with presence deciding action

async function _processEngaged(messages, client) {
  const msg       = messages[messages.length - 1];
  const channelId = msg.channel.id;
  const isDM      = !msg.guild;

  const allTexts = messages.map(m => m.content.replace(/<@!?\d+>/g, '').trim()).filter(Boolean);
  let text = allTexts.join(' ').trim();
  const hasMedia = msg.attachments.size > 0 || msg.embeds.length > 0 || msg.stickers.size > 0;
  if (!text && hasMedia) text = '[media]';
  if (!text) return;

  const lockKey = `msg_${msg.id}`;
  if (!await acquireLock(lockKey)) return;

  try {
    await _setPreCooldown(channelId, isDM, true);

    let isReply = false;
    if (msg.reference?.messageId) {
      try {
        const ref = await msg.channel.messages.fetch(msg.reference.messageId);
        isReply = ref?.author?.id === client.user.id;
      } catch {}
    }

    const isMention = msg.mentions.has(client.user);
    const result = await handleMessage({
      userId: msg.author.id, username: msg.author.username,
      displayName: msg.member?.displayName || msg.author.username,
      avatarUrl: msg.author.displayAvatarURL({ size: 64 }),
      message: text, guildId: msg.guild?.id || null,
      msg, isMention, isReply, hasMedia,
    });

    if (isMention && !isDM) {
      onMention(channelId, msg.author.id);
      openSession(channelId, msg.guild?.id || null, msg.author.id).catch(() => {});
    }

    _recordSession(msg, channelId, isDM, text, result);
    await _send(msg, result, channelId, isDM, text, client);

  } finally {
    await releaseLock(lockKey);
  }
}

// ── PATH 2: Notification evaluation ──────────────────────────────────────────
// Scanner found a trigger — evaluate context, then decide

async function _processNotification(messages, triggerNotif, client) {
  // Use the last message as the primary trigger for evaluation
  const msg       = messages[messages.length - 1];
  const channelId = msg.channel.id;
  const isDM      = !msg.guild;
  const guildId   = msg.guild?.id || null;

  const allTexts = messages.map(m => m.content.replace(/<@!?\d+>/g, '').trim()).filter(Boolean);
  let text = allTexts.join(' ').trim();
  const hasMedia = msg.attachments.size > 0 || msg.embeds.length > 0 || msg.stickers.size > 0;
  if (!text && hasMedia) text = '[media]';
  if (!text && !hasMedia) return;

  if (messages.length > 1) {
    console.log(`[bot] batched ${messages.length} msgs: "${text.slice(0, 60)}"`);
  }

  const lockKey = `msg_${msg.id}`;
  if (!await acquireLock(lockKey)) return;

  try {
    // ── Evaluate: should Maya respond? ─────────────────────────────────────
    // Update notif to use the batched message
    const notif = { ...triggerNotif, msg };
    const evaluation = await evaluate(notif, client.user.id);

    console.log(`[notif] action=${evaluation.action} reason="${evaluation.reason}" trigger=${triggerNotif.triggerWord}`);

    // ── IGNORE — don't process further ────────────────────────────────────
    if (evaluation.action === 'ignore') return;

    // ── LURK — enter observing mode but don't reply ────────────────────────
    if (evaluation.action === 'lurk') {
      onMention(channelId, msg.author.id);   // enters OBSERVING mode
      openSession(channelId, guildId, msg.author.id).catch(() => {});
      console.log(`[bot] lurk mode entered for channel ${channelId}`);
      return;
    }

    // ── REACT — emoji only ────────────────────────────────────────────────
    if (evaluation.action === 'react') {
      const emoji = evaluation.emoji || '👀';
      await msg.react(emoji).catch(() => {});
      onMayaReact(channelId);
      onMention(channelId, msg.author.id);   // still enter observing after react
      return;
    }

    // ── REPLY — full pipeline ─────────────────────────────────────────────
    await _setPreCooldown(channelId, isDM, false);

    let isReply = false;
    if (msg.reference?.messageId) {
      try {
        const ref = await msg.channel.messages.fetch(msg.reference.messageId);
        isReply = ref?.author?.id === client.user.id;
      } catch {}
    }

    const isMention = msg.mentions.has(client.user);
    const result = await handleMessage({
      userId: msg.author.id, username: msg.author.username,
      displayName: msg.member?.displayName || msg.author.username,
      avatarUrl: msg.author.displayAvatarURL({ size: 64 }),
      message: text, guildId, msg, isMention, isReply, hasMedia,
    });

    // Enter observing/engaged mode after processing
    if (!isDM) {
      onMention(channelId, msg.author.id);
      openSession(channelId, guildId, msg.author.id).catch(() => {});
    }

    _recordSession(msg, channelId, isDM, text, result);
    await _send(msg, result, channelId, isDM, text, client);

  } finally {
    await releaseLock(lockKey);
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function _setPreCooldown(channelId, isDM, isEngaged) {
  if (isDM) return;
  const ttl = isEngaged ? 7_000 : 22_000;
  await db.execute(
    `INSERT INTO maya_state (state_key, value) VALUES (?,?)
     ON DUPLICATE KEY UPDATE value=VALUES(value), updated_at=NOW()`,
    [`reply_${channelId}`, new Date(Date.now() + ttl).toISOString()]
  ).catch(() => {});
}

function _recordSession(msg, channelId, isDM, text, result) {
  if (isDM || !channelId) return;
  recordSessionMessage(channelId, {
    userId: msg.author.id,
    userName: msg.member?.displayName || msg.author.username,
    sender: 'user', message: text,
  }).catch(() => {});
  if (result?.type === 'reply') {
    recordSessionMessage(channelId, {
      userId: 'maya', userName: 'Maya', sender: 'maya', message: result.text,
    }).catch(() => {});
  }
}

async function _send(msg, result, channelId, isDM, text, client) {
  if (!result) return;

  if (result.type === 'reply') {
    const delayMs = replyDelay(text.length);
    await msg.channel.sendTyping().catch(() => {});
    await new Promise(r => setTimeout(r, delayMs));
  }

  if (result.type === 'react') {
    onMayaReact(channelId);
    await msg.react(result.emoji).catch(() => console.warn('[bot] react failed:', result.emoji));

  } else if (result.type === 'image') {
    await msg.channel.sendTyping().catch(() => {});
    try {
      const { buffer, filename } = await generateImage(result.prompt);
      await msg.reply({ content: 'here you go ✨', files: [{ attachment: buffer, name: filename }] });
    } catch (err) {
      console.error('[imagegen] failed:', err.message);
      await msg.reply('ugh image nahi bana 😭').catch(() => {});
    }

  } else if (result.type === 'reply') {
    onMayaReply(channelId, msg.author.id);
    const replyText = result.text || '';
    if (replyText.length <= 2000) {
      await msg.reply(replyText);
    } else {
      for (const chunk of replyText.match(/[\s\S]{1,1990}/g) || [replyText]) {
        await msg.channel.send(chunk);
      }
    }
  }
}

client.on(Events.Error, err => console.error('[bot] Client error:', err));
process.on('unhandledRejection', err => console.error('[bot] Unhandled rejection:', err));

client.login(config.discord.token);
