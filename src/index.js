import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, ActivityType } from 'discord.js';
import { config } from './config.js';
import { handleMessage } from './handler.js';
import { acquireLock, releaseLock } from './lock.js';
import { startDreamLoop } from './dream.js';
import { trainNLP } from './nlp.js';
import { replyDelay } from './llm.js';
import { startSTM, openSession, recordSessionMessage } from './stm.js';
import { generateImage } from './imagegen.js';
import { ensureCollection } from './vector.js';
import { decide, observeMessage, onMention, onMayaReply, onMayaReact, getModeLabel } from './presence.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, async () => {
  console.log(`[bot] Logged in as ${client.user.tag} ✓`);
  client.user.setActivity('your messages 👀', { type: ActivityType.Watching });
  // Start vector memory systems
  await ensureCollection().catch(e => console.warn('[bot] Qdrant setup:', e.message));
  await trainNLP().catch(e => console.warn('[bot] NLP training:', e.message));
  startDreamLoop();
  startSTM();
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;

  const content    = msg.content.trim();
  const channelId  = msg.channel.id;
  const isDM       = !msg.guild;

  // ── Rich content detection ──────────────────────────────────────────────
  const hasAttachments = msg.attachments.size > 0;
  const hasEmbeds      = msg.embeds.length > 0;
  const hasStickers    = msg.stickers.size > 0;
  const hasMedia       = hasAttachments || hasEmbeds || hasStickers;

  if (!content && !hasMedia) return;

  // ── Channel filter ──────────────────────────────────────────────────────
  const allowed = config.discord.allowedChannels;
  if (allowed.length > 0 && msg.guild && !allowed.includes(channelId)) return;

  // ── Trigger detection ───────────────────────────────────────────────────
  const isMention  = msg.mentions.has(client.user);
  const hasKeyword = /\bmaya\b/i.test(content);

  // ── Observe: update channel state regardless of response ───────────────
  if (!isDM) observeMessage(channelId, msg.author.id);

  // ── Gate: should we even process this message? ───────────────────────────
  // In server: only process if mention, keyword, or DM
  // Presence engine handles everything else
  const shouldProcess = isMention || isDM || hasKeyword;

  // For media-only messages in server: only if mentioned
  if (!content && hasMedia && !isMention && !isDM) return;

  if (!shouldProcess) return;

  // ── Distributed lock ─────────────────────────────────────────────────────
  const lockKey = `msg_${msg.id}`;
  const locked  = await acquireLock(lockKey);
  if (!locked) return;

  // ── Is this a reply to one of Maya's messages? ───────────────────────────
  let isReply = false;
  if (msg.reference?.messageId) {
    try {
      const ref = await msg.channel.messages.fetch(msg.reference.messageId);
      isReply = ref?.author?.id === client.user.id;
    } catch { /* non-fatal */ }
  }

  // ── Clean text ───────────────────────────────────────────────────────────
  let text = content.replace(/<@!?\d+>/g, '').trim();
  if (!text && hasMedia) text = '[media]';

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

    // ── If Maya was just mentioned, open/reset lurk window ─────────────────
    // Do this AFTER processing so the lurk window starts fresh for follow-ups
    if (isMention && !isDM) {
      onMention(channelId, msg.author.id);
      openSession(channelId, msg.guild?.id || null, msg.author.id).catch(() => {});
    }

    // Record exchange into session STM buffer
    if (!isDM && channelId) {
      recordSessionMessage(channelId, {
        userId: msg.author.id,
        userName: msg.member?.displayName || msg.author.username,
        sender: 'user', message: text,
      }).catch(() => {});
      if (result?.type === 'reply') {
        recordSessionMessage(channelId, {
          userId: 'maya', userName: 'Maya',
          sender: 'maya', message: result.text,
        }).catch(() => {});
      }
    }

    if (result === null) return;

    // Human-feel delay: reading + thinking + typing simulation
    // Scales with incoming message length so longer messages get more time
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
    await msg.reply('Yaar kuch gadbad ho gayi, try again kar! 😅').catch(() => {});
  } finally {
    await releaseLock(lockKey);
  }
});

client.on(Events.Error, err => console.error('[bot] Client error:', err));
process.on('unhandledRejection', err => console.error('[bot] Unhandled rejection:', err));

client.login(config.discord.token);
