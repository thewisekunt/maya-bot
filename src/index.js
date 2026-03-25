import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, ActivityType } from 'discord.js';
import { config } from './config.js';
import { handleMessage } from './handler.js';

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

// ── Deduplication — prevents double processing if event fires twice ───────────
// Stores message IDs currently being processed. Cleared after response sent.
const processing = new Set();

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

  // ── Dedup guard — drop if already handling this message ID ─────────────────
  if (processing.has(msg.id)) return;

  // ── Channel filter ──────────────────────────────────────────────────────────
  const allowed = config.discord.allowedChannels;
  if (allowed.length > 0 && msg.guild && !allowed.includes(msg.channel.id)) return;

  // ── Trigger: @mention OR DM only (no prefix anymore) ───────────────────────
  const isMention = msg.mentions.has(client.user);
  const isDM      = !msg.guild;

  if (!isMention && !isDM) return;

  // Mark as being processed immediately to block any duplicate event
  processing.add(msg.id);

  // Strip the @mention from text
  let text = content.replace(/<@!?\d+>/g, '').trim();

  if (!text) {
    await msg.reply('Bol bhai, kuch toh bol! 😏').catch(() => {});
    processing.delete(msg.id);
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
      guildId:     msg.guild?.id || null,
    });

    if (result.type === 'react') {
      // Just add an emoji reaction — no text reply
      await msg.react(result.emoji).catch(async () => {
        // If reaction fails (invalid emoji, missing perms), fall back to a reply
        await msg.reply('😏').catch(() => {});
      });

    } else {
      // Normal text reply — split if over Discord's 2000 char limit
      const text = result.text;
      if (text.length <= 2000) {
        await msg.reply(text);
      } else {
        const chunks = text.match(/[\s\S]{1,1990}/g) || [text];
        for (const chunk of chunks) {
          await msg.channel.send(chunk);
        }
      }
    }

  } catch (err) {
    console.error('[bot] handleMessage error:', err);
    await msg.reply('Yaar kuch gadbad ho gayi, try again kar! 😅').catch(() => {});
  } finally {
    // Always clear the dedup entry when done
    processing.delete(msg.id);
  }
});

// ── Global error handling ─────────────────────────────────────────────────────
client.on(Events.Error, err => console.error('[bot] Client error:', err));
process.on('unhandledRejection', err => console.error('[bot] Unhandled rejection:', err));

// ── Login ─────────────────────────────────────────────────────────────────────
client.login(config.discord.token);