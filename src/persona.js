/**
 * persona.js
 *
 * Manages the maya_users table (rich user profiles) and
 * maya_user_relationships (Maya↔User bond tracking).
 */

import db from './db.js';

// ── User upsert ───────────────────────────────────────────────────────────────

/**
 * Upsert user into maya_users.
 * Returns the user's preferred display name.
 */
export async function upsertUser({ userId, username, displayName, avatarUrl, guildId, channelId }) {
  await db.execute(
    `INSERT INTO maya_users
       (discord_user_id, username, display_name, avatar_url,
        last_active_guild, last_active_channel, message_count)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       username              = VALUES(username),
       display_name          = VALUES(display_name),
       avatar_url            = VALUES(avatar_url),
       last_active_guild     = COALESCE(VALUES(last_active_guild), last_active_guild),
       last_active_channel   = COALESCE(VALUES(last_active_channel), last_active_channel),
       message_count         = message_count + 1,
       last_seen             = CURRENT_TIMESTAMP`,
    [userId, username, displayName || username, avatarUrl || '',
     guildId || null, channelId || null]
  );

  const [[row]] = await db.execute(
    `SELECT preferred_name, display_name, username, known_facts
     FROM maya_users WHERE discord_user_id = ? LIMIT 1`,
    [userId]
  );

  return {
    prefName:   row?.preferred_name || row?.display_name || row?.username || username,
    knownFacts: _parseJson(row?.known_facts, []),
  };
}

/**
 * Check for "my name is X" and persist it.
 * Returns new name or null.
 */
export async function detectNameSet(userId, message) {
  const m = message.match(/\bmy\s+name\s+is\s+([a-zA-Z][a-zA-Z\s]{0,30})/i);
  if (!m) return null;
  const newName = m[1].trim();
  await db.execute(
    `UPDATE maya_users SET preferred_name = ? WHERE discord_user_id = ?`,
    [newName, userId]
  );
  return newName;
}

/**
 * Detect and persist quick facts from user messages.
 * Looks for patterns like "I love X", "I hate X", "I'm a X", "I work at X"
 */
export async function extractAndStoreFact(userId, message) {
  const patterns = [
    /\bi (?:love|really love|adore)\s+(.{3,40})/i,
    /\bi (?:hate|can't stand|dislike)\s+(.{3,40})/i,
    /\bi(?:'m| am) (?:a |an )?(.{3,40})/i,
    /\bi work (?:at|in|for)\s+(.{3,40})/i,
    /\bmy (?:fav(?:ou?rite)?)\s+(?:is\s+)?(.{3,40})/i,
  ];

  for (const pattern of patterns) {
    const m = message.match(pattern);
    if (!m) continue;
    const fact = m[0].trim().slice(0, 80);
    // Load existing facts, add new one if not duplicate
    const [[row]] = await db.execute(
      `SELECT known_facts FROM maya_users WHERE discord_user_id = ? LIMIT 1`,
      [userId]
    );
    const facts = _parseJson(row?.known_facts, []);
    if (!facts.includes(fact) && facts.length < 20) {
      facts.push(fact);
      await db.execute(
        `UPDATE maya_users SET known_facts = ? WHERE discord_user_id = ?`,
        [JSON.stringify(facts), userId]
      );
    }
    break; // one fact per message is enough
  }
}

// ── Maya↔User relationship ────────────────────────────────────────────────────

/**
 * Upsert the Maya↔User relationship row and return relationship context.
 */
export async function getOrCreateRelationship(userId, contextType) {
  // Increment appropriate counter
  const counterCol = contextType === 'dm' ? 'dm_count' : 'server_count';

  await db.execute(
    `INSERT INTO maya_user_relationships
       (discord_user_id, total_messages, ${counterCol}, last_interaction)
     VALUES (?, 1, 1, NOW())
     ON DUPLICATE KEY UPDATE
       total_messages  = total_messages + 1,
       ${counterCol}   = ${counterCol} + 1,
       last_interaction= NOW(),
       updated_at      = CURRENT_TIMESTAMP`,
    [userId]
  );

  const [[rel]] = await db.execute(
    `SELECT trust_level, vibe, nickname_for_user,
            inside_jokes, topics_they_like, topics_to_avoid,
            total_messages, dm_count, server_count
     FROM maya_user_relationships
     WHERE discord_user_id = ? LIMIT 1`,
    [userId]
  );

  return {
    trustLevel:       rel?.trust_level    || 3,
    vibe:             rel?.vibe           || 'neutral',
    nickname:         rel?.nickname_for_user || null,
    insideJokes:      _parseJson(rel?.inside_jokes, []),
    topicsTheyLike:   _parseJson(rel?.topics_they_like, []),
    topicsToAvoid:    _parseJson(rel?.topics_to_avoid, []),
    totalMessages:    rel?.total_messages || 0,
    dmCount:          rel?.dm_count       || 0,
    serverCount:      rel?.server_count   || 0,
  };
}

/**
 * Update Maya's vibe/trust toward a user after an exchange.
 * Called optionally after LLM reply to nudge relationship over time.
 */
export async function nudgeRelationship(userId, { positiveSignal = false, negativeSignal = false } = {}) {
  if (!positiveSignal && !negativeSignal) return;
  try {
    if (positiveSignal) {
      await db.execute(
        `UPDATE maya_user_relationships
         SET positive_reactions = positive_reactions + 1,
             trust_level = LEAST(5, trust_level + 0)  -- upgrade manually via admin
         WHERE discord_user_id = ?`,
        [userId]
      );
    }
  } catch (e) {
    // non-fatal
  }
}

// ── User↔User observed relationships ─────────────────────────────────────────

/**
 * Record that Maya saw two users interacting.
 * user_a_id is always the lower snowflake so pairs are canonical.
 */
export async function recordUserInteraction(userAId, userBId, guildId) {
  if (!userAId || !userBId || userAId === userBId) return;
  const [a, b] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];
  try {
    await db.execute(
      `INSERT INTO maya_observed_relations
         (user_a_id, user_b_id, guild_id, interaction_count)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         interaction_count = interaction_count + 1,
         updated_at = CURRENT_TIMESTAMP`,
      [a, b, guildId || null]
    );
  } catch (e) {
    // non-fatal
  }
}

/**
 * Get users that frequently interact with this user (for context).
 */
export async function getFrequentInteractors(userId, guildId, limit = 3) {
  try {
    const [rows] = await db.execute(
      `SELECT
         CASE WHEN user_a_id = ? THEN user_b_id ELSE user_a_id END AS other_user_id,
         interaction_count
       FROM maya_observed_relations
       WHERE (user_a_id = ? OR user_b_id = ?)
         AND (guild_id = ? OR guild_id IS NULL)
       ORDER BY interaction_count DESC
       LIMIT ?`,
      [userId, userId, userId, guildId || null, limit]
    );

    if (!rows.length) return [];

    // Get usernames for those IDs
    const ids = rows.map(r => r.other_user_id);
    const placeholders = ids.map(() => '?').join(',');
    const [users] = await db.execute(
      `SELECT discord_user_id, preferred_name, display_name, username
       FROM maya_users WHERE discord_user_id IN (${placeholders})`,
      ids
    );

    return users.map(u => ({
      id:   u.discord_user_id,
      name: u.preferred_name || u.display_name || u.username,
      count: rows.find(r => r.other_user_id === u.discord_user_id)?.interaction_count || 0,
    }));
  } catch (e) {
    return [];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _parseJson(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// ── Entropy utils (unchanged) ─────────────────────────────────────────────────
export function getEntropyZone(entropy) {
  if (entropy < 0.3)  return { zone: 'Restful', line: 'Mood: chill, laid-back 🫶' };
  if (entropy > 0.7)  return { zone: 'Chaos',   line: 'Mood: high-energy, full-on tease 😏' };
  return               { zone: 'Social',  line: 'Mood: casual friendly vibe ✨' };
}

export function estimateEntropy(text) {
  const len          = Math.min(text.length / 200, 1.0);
  const exclamations = (text.match(/!/g)  || []).length;
  const questions    = (text.match(/\?/g) || []).length;
  const caps         = (text.match(/\b[A-Z]{2,}\b/g) || []).length;
  const score = 0.1 + len * 0.3 + exclamations * 0.06 + questions * 0.04 + caps * 0.04;
  return Math.min(parseFloat(score.toFixed(2)), 1.0);
}
