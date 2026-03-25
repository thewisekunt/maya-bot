import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, ActivityType } from 'discord.js';
import { config } from './config.js';
import { handleMessage } from './handler.js';
import { acquireLock, releaseLock } from './lock.js';

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, () => {
  console.log(`[bot] Logged in as ${client.user.tag} ✓`);
  client.user.setActivity('your messages 👀', { type: ActivityType.Watching });
});

// ── Message handler ───────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (msg) => {
  // Ignore bots (including self)
  if (msg.author.bot) return;

  const content = msg.content.trim();
  if (!content) return;

  // ── Channel filter ──────────────────────────────────────────────────────────
  const allowed = config.discord.allowedChannels;
  if (allowed.length > 0 && msg.guild && !allowed.includes(msg.channel.id)) return;

  // ── Trigger detection ───────────────────────────────────────────────────────
  const isMention  = msg.mentions.has(client.user);
  const isDM       = !msg.guild;
  // Keyword match: message contains "maya" as a word (case-insensitive)
  const hasKeyword = /\bmaya\b/i.test(content);

  if (!isMention && !isDM && !hasKeyword) return;

  // ── Distributed lock — only ONE instance processes each message ─────────────
  // Uses the DB so all Koyeb instances share the same lock state
  const lockKey = `msg_${msg.id}`;
  const locked  = await acquireLock(lockKey);
  if (!locked) {
    // Another instance already grabbed this message — skip silently
    console.log(`[bot] Lock miss for ${msg.id} — another instance handling it`);
    return;
  }

  // ── Clean text: strip @mentions ────────────────────────────────────────────
  let text = content.replace(/<@!?\d+>/g, '').trim();

  if (!text) {
    await msg.reply('Bol bhai, kuch toh bol! 😏').catch(() => {});
    await releaseLock(lockKey);
    return;
  }

  // ── Typing indicator ────────────────────────────────────────────────────────
  if (config.bot.typingIndicator) {
    await msg.channel.sendTyping().catch(() => {});
  }

  // ── Process ─────────────────────────────────────────────────────────────────
  try {
    const result = await handleMessage({
      userId:      msg.author.id,
      username:    msg.author.username,
      displayName: msg.member?.displayName || msg.author.username,
      avatarUrl:   msg.author.displayAvatarURL({ size: 64 }),
      message:     text,
      msg:         msg,
      guildId:     msg.guild?.id || null,
    });

    if (result.type === 'react') {
      await msg.react(result.emoji).catch(async () => {
        await msg.reply('😏').catch(() => {});
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
    console.error('[bot] handleMessage FULL ERROR:', err);
    await msg.reply('Yaar kuch gadbad ho gayi, try again kar! 😅').catch(() => {});
  } finally {
    await releaseLock(lockKey);
  }
});

// ── Global error handling ─────────────────────────────────────────────────────
client.on(Events.Error, err => console.error('[bot] Client error:', err));
process.on('unhandledRejection', err => console.error('[bot] Unhandled rejection:', err));

// ── Login ─────────────────────────────────────────────────────────────────────
client.login(config.discord.token);
