/**
 * context.js
 *
 * Handles all "where is Maya talking" awareness:
 *   - Guild (server) registration
 *   - Channel registration + type detection
 *   - Context type (dm vs server) + privacy flag
 */

import db from './db.js';

/**
 * Upsert guild record when Maya sees a new server.
 */
export async function upsertGuild(guild) {
  if (!guild) return;
  try {
    await db.execute(
      `INSERT INTO maya_guilds (guild_id, guild_name)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE guild_name = VALUES(guild_name)`,
      [guild.id, guild.name || 'Unknown Server']
    );
  } catch (e) {
    console.error('[context] upsertGuild:', e.message);
  }
}

/**
 * Upsert channel record and return context metadata.
 *
 * @returns {{ contextType: 'dm'|'server', isPrivate: boolean, channelName: string }}
 */
export async function upsertChannel(msg) {
  const isDM      = !msg.guild;
  const channelId = msg.channel.id;
  const guildId   = msg.guild?.id || null;

  // Determine channel type string
  let channelType = 'guild_text';
  let channelName = msg.channel.name || null;
  let topic       = msg.channel.topic || null;
  let isNsfw      = msg.channel.nsfw ? 1 : 0;

  if (isDM) {
    channelType = 'dm';
    channelName = `DM:${msg.author.username}`;
    topic       = null;
    isNsfw      = 0;
  } else if (msg.channel.isThread?.()) {
    channelType = 'thread';
  }

  try {
    await db.execute(
      `INSERT INTO maya_channels
         (channel_id, guild_id, channel_name, channel_type, topic, is_nsfw)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         channel_name = VALUES(channel_name),
         topic        = VALUES(topic),
         updated_at   = CURRENT_TIMESTAMP`,
      [channelId, guildId, channelName, channelType, topic, isNsfw]
    );
  } catch (e) {
    console.error('[context] upsertChannel:', e.message);
  }

  return {
    contextType: isDM ? 'dm' : 'server',
    isPrivate:   isDM,          // DMs are private; server messages are not
    channelName: channelName || 'unknown',
    channelId,
    topic,
  };
}

/**
 * Build a short context-awareness string for injection into the LLM prompt.
 * Tells Maya where she is and how she should behave.
 */
export function buildContextLine(contextType, channelName, guildName, topic) {
  if (contextType === 'dm') {
    return `📬 You are in a PRIVATE DM with this user. Be more personal and candid here — this is just between you two.`;
  }

  let line = `💬 You are in the "${channelName}" channel`;
  if (guildName) line += ` on the "${guildName}" server`;
  if (topic)     line += `. Channel topic: "${topic.slice(0, 100)}"`;
  line += `. Keep it relevant to the vibe here.`;
  return line;
}
