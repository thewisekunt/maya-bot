/**
 * memory.js
 *
 * Context-aware memory: DMs and server messages are stored and
 * retrieved separately. Private DM memories never leak into
 * server context and vice versa.
 */

import db from './db.js';
import { config } from './config.js';

/**
 * Fetch recent messages for context.
 * DM context → only DM messages.
 * Server context → only messages from that server (or any server if guildId null).
 *
 * @param {string} userId
 * @param {string} prefName
 * @param {'dm'|'server'} contextType
 * @param {string|null} guildId
 * @returns {Promise<string>}
 */
export async function getContext(userId, prefName, contextType = 'server', guildId = null) {
  let query, params;

  if (contextType === 'dm') {
    // Private DM memory only
    query = `SELECT sender, message FROM maya_memory
             WHERE discord_user_id = ? AND context_type = 'dm'
             ORDER BY created_at DESC LIMIT ?`;
    params = [userId, config.bot.memoryLimit];
  } else {
    // Server memory — scoped to guild if available, else any server
    query = guildId
      ? `SELECT sender, message FROM maya_memory
         WHERE discord_user_id = ? AND context_type = 'server' AND guild_id = ?
         ORDER BY created_at DESC LIMIT ?`
      : `SELECT sender, message FROM maya_memory
         WHERE discord_user_id = ? AND context_type = 'server'
         ORDER BY created_at DESC LIMIT ?`;
    params = guildId
      ? [userId, guildId, config.bot.memoryLimit]
      : [userId, config.bot.memoryLimit];
  }

  const [rows] = await db.execute(query, params);

  return rows
    .reverse()
    .map(r => `${r.sender === 'maya' ? 'Maya' : prefName}: ${r.message}`)
    .join('\n');
}

/**
 * Save one message to memory with full context metadata.
 */
export async function saveMessage({
  userId, prefName, guildId, channelId,
  contextType, isPrivate,
  sender, message, entropy,
}) {
  await db.execute(
    `INSERT INTO maya_memory
       (discord_user_id, user_name, guild_id, channel_id,
        context_type, is_private, sender, message, entropy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId, prefName,
      guildId    || null,
      channelId  || null,
      contextType,
      isPrivate ? 1 : 0,
      sender, message,
      entropy,
    ]
  );
}
