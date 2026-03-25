import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, ActivityType } from 'discord.js';
import { config } from './config.js';
import { handleMessage } from './handler.js';

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,   // requires "Message Content Intent" in Dev Portal
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],          // needed for DMs
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

  // ── Trigger: prefix OR @mention OR DM ──────────────────────────────────────
  const isMention  = msg.mentions.has(client.user);
  const hasPrefix  = content.toLowerCase().startsWith(config.discord.prefix.toLowerCase());
  const isDM       = !msg.guild;

  if (!isMention && !hasPrefix && !isDM) return;

  // Strip prefix / mention from the actual message text
  let text = content;
  if (hasPrefix)  text = text.slice(config.discord.prefix.length).trim();
  if (isMention)  text = text.replace(/<@!?\d+>/g, '').trim();

  if (!text) {
    await msg.reply('Bol bhai, kuch toh bol! 😏');
    return;
  }

  // ── Typing indicator ────────────────────────────────────────────────────────
  if (config.bot.typingIndicator) {
    await msg.channel.sendTyping().catch(() => {});
  }

  // ── Process ─────────────────────────────────────────────────────────────────
  try {
    const reply = await handleMessage({
      userId:      msg.author.id,
      username:    msg.author.username,
      displayName: msg.member?.displayName || msg.author.username,
      avatarUrl:   msg.author.displayAvatarURL({ size: 64 }),
      message:     text,
      guildId:     msg.guild?.id || null,
    });

    // Discord message limit is 2000 chars — split if needed
    if (reply.length <= 2000) {
      await msg.reply(reply);
    } else {
      const chunks = reply.match(/[\s\S]{1,1990}/g) || [reply];
      for (const chunk of chunks) {
        await msg.channel.send(chunk);
      }
    }

  } catch (err) {
    console.error('[bot] handleMessage error:', err);
    await msg.reply('Yaar kuch gadbad ho gayi, try again kar! 😅').catch(() => {});
  }
});

// ── Error handling ────────────────────────────────────────────────────────────
client.on(Events.Error, err => console.error('[bot] Client error:', err));
process.on('unhandledRejection', err => console.error('[bot] Unhandled rejection:', err));

// ── Login ─────────────────────────────────────────────────────────────────────
client.login(config.discord.token);
