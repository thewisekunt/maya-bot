import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, ActivityType } from 'discord.js';
import { config } from './config.js';
import { handleMessage } from './handler.js';
import { acquireLock, releaseLock } from './lock.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, () => {
  console.log(`[bot] Logged in as ${client.user.tag} ✓`);
  client.user.setActivity('your messages 👀', { type: ActivityType.Watching });
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;

  const content = msg.content.trim();
  if (!content) return;

  // ── Channel filter ──────────────────────────────────────────────────────
  const allowed = config.discord.allowedChannels;
  if (allowed.length > 0 && msg.guild && !allowed.includes(msg.channel.id)) return;

  // ── Trigger detection ───────────────────────────────────────────────────
  const isMention  = msg.mentions.has(client.user);
  const isDM       = !msg.guild;
  const hasKeyword = /\bmaya\b/i.test(content);

  if (!isMention && !isDM && !hasKeyword) return;

  // ── Distributed lock ────────────────────────────────────────────────────
  const lockKey = `msg_${msg.id}`;
  const locked  = await acquireLock(lockKey);
  if (!locked) return;

  // ── Is this a reply to one of Maya's messages? ──────────────────────────
  let isReply = false;
  if (msg.reference?.messageId) {
    try {
      const ref = await msg.channel.messages.fetch(msg.reference.messageId);
      isReply = ref?.author?.id === client.user.id;
    } catch { /* non-fatal */ }
  }

  // ── Clean text ──────────────────────────────────────────────────────────
  let text = content.replace(/<@!?\d+>/g, '').trim();
  if (!text) {
    await msg.reply('Bol bhai, kuch toh bol! 😏').catch(() => {});
    await releaseLock(lockKey);
    return;
  }

  if (config.bot.typingIndicator && !isDM) {
    // Only show typing if salience will likely result in a reply
    // We show it optimistically — salience decides after
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
    });

    // null = salience said IGNORE — do nothing, no reply
    if (result === null) return;

    if (result.type === 'react') {
      await msg.react(result.emoji).catch(async () => {
        // React failed (invalid emoji / missing perms) — silent fail
        console.warn(`[bot] react failed for emoji: ${result.emoji}`);
      });

    } else {
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
