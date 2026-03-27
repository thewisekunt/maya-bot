import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, ActivityType } from 'discord.js';
import { config } from './config.js';
import { handleMessage } from './handler.js';
import { acquireLock, releaseLock } from './lock.js';
import { startDreamLoop } from './dream.js';
import { generateImage } from './imagegen.js';
import { ensureCollection } from './vector.js';
import { triggerLurk, checkLurk } from './lurk.js';

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
  startDreamLoop();
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

  // ── Lurk check ───────────────────────────────────────────────────────────
  // Do this BEFORE the trigger gate so lurking messages pass through
  // even without a mention/keyword
  const { isLurking, lurkDepth } = isDM ? { isLurking: false, lurkDepth: 0 }
                                        : checkLurk(channelId);

  // ── Gate: should we even process this message? ───────────────────────────
  const shouldProcess = isMention || isDM || hasKeyword || isLurking;

  // For media-only messages in server: only if mentioned or lurking
  if (!content && hasMedia && !isMention && !isDM && !isLurking) return;

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

  if (config.bot.typingIndicator) {
    await msg.channel.sendTyping().catch(() => {});
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
      isLurking,
      lurkDepth,
    });

    // ── If Maya was just mentioned, open/reset lurk window ─────────────────
    // Do this AFTER processing so the lurk window starts fresh for follow-ups
    if (isMention && !isDM) {
      triggerLurk(channelId, msg.author.id);
    }

    if (result === null) return;

    if (result.type === 'react') {
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
      // Maya replied verbally — refresh lurk so she stays attentive
      if (isLurking && !isMention) {
        const { refreshLurk } = await import('./lurk.js');
        refreshLurk(channelId);
      }

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
