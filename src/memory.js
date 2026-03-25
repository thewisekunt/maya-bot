import db from './db.js';
import { config } from './config.js';

/**
 * Fetch the last N messages for a user as a formatted context string.
 * @returns string like "Shruti: hello\nMaya: hi bestie!\n..."
 */
export async function getContext(userId, prefName) {
  const [rows] = await db.execute(
    `SELECT sender, message FROM maya_memory
     WHERE discord_user_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [userId, config.bot.memoryLimit]
  );

  return rows
    .reverse()
    .map(r => `${r.sender === 'maya' ? 'Maya' : prefName}: ${r.message}`)
    .join('\n');
}

/**
 * Store one message (either 'user' or 'maya') into memory.
 */
export async function saveMessage({ userId, prefName, guildId, sender, message, entropy }) {
  await db.execute(
    `INSERT INTO maya_memory
       (discord_user_id, user_name, guild_id, sender, message, entropy)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, prefName, guildId || null, sender, message, entropy]
  );
}
