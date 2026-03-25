import db from './db.js';

/**
 * Upsert a persona row and return the preferred display name.
 */
export async function upsertPersona({ userId, username, displayName, avatarUrl }) {
  await db.execute(
    `INSERT INTO maya_personas (discord_user_id, username, display_name, avatar_url)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       display_name = VALUES(display_name),
       avatar_url   = VALUES(avatar_url),
       updated_at   = CURRENT_TIMESTAMP`,
    [userId, username, displayName || username, avatarUrl || '']
  );

  const [[row]] = await db.execute(
    `SELECT preferred_name, display_name, username
     FROM maya_personas WHERE discord_user_id = ? LIMIT 1`,
    [userId]
  );

  return row?.preferred_name || row?.display_name || row?.username || username;
}

/**
 * If the message contains "my name is X", persist X as preferred_name.
 * Returns the new preferred name, or null if no match.
 */
export async function detectNameSet(userId, message) {
  const m = message.match(/\bmy\s+name\s+is\s+([a-zA-Z][a-zA-Z\s]{0,30})/i);
  if (!m) return null;
  const newName = m[1].trim();
  await db.execute(
    `UPDATE maya_personas SET preferred_name = ? WHERE discord_user_id = ?`,
    [newName, userId]
  );
  return newName;
}

/**
 * Map entropy float (0–1) to a named tone zone + descriptor line.
 */
export function getEntropyZone(entropy) {
  if (entropy < 0.3)  return { zone: 'Restful', line: 'Mood: chill, laid-back 🫶' };
  if (entropy > 0.7)  return { zone: 'Chaos',   line: 'Mood: high-energy, full-on tease 😏' };
  return               { zone: 'Social',  line: 'Mood: casual friendly vibe ✨' };
}

/**
 * Simple entropy estimate from message content (mirrors the PHP version).
 */
export function estimateEntropy(text) {
  const len          = Math.min(text.length / 200, 1.0);
  const exclamations = (text.match(/!/g)  || []).length;
  const questions    = (text.match(/\?/g) || []).length;
  const caps         = (text.match(/\b[A-Z]{2,}\b/g) || []).length;
  const score = 0.1 + len * 0.3 + exclamations * 0.06 + questions * 0.04 + caps * 0.04;
  return Math.min(parseFloat(score.toFixed(2)), 1.0);
}
