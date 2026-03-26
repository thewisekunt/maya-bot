/**
 * persona.js — User profiles, trust, aliases, and structured facts
 *
 * Trust model (1–5):
 *   Calculated from interaction history, not static.
 *   DMs count more than server (3x weight — more personal).
 *   Consistency over time matters — someone who talked once 3 months ago
 *   is less trusted than someone who talks every day.
 *   Thresholds (total weighted score):
 *     < 10   → 1 (stranger)
 *     10–30  → 2 (acquaintance)
 *     30–80  → 3 (known)
 *     80–200 → 4 (friend)
 *     > 200  → 5 (close friend)
 *
 * Alias system:
 *   When Maya hears "ask Mario" or "Mario said", she extracts "Mario"
 *   and tries to map it to a known discord user in the same guild.
 *   self_declared (conflict_score=0) > observed > inferred.
 *
 * Fact system:
 *   Facts have conflict_score 0–1.
 *   0 = objective/confirmed (laws of physics, self-declared identity).
 *   0.5 = inferred from speech (I love X → probably true).
 *   1 = contested (contradicted by other statements).
 *   Only conflict_score < 0.3 facts are injected into LLM context.
 */

import db from './db.js';

// ── Trust thresholds ──────────────────────────────────────────────────────────
function calcTrust(dmCount, serverCount, daysSinceFirst, daysSinceLast) {
  // DMs are 3x more intimate than server messages
  const weighted = (dmCount * 3) + serverCount;

  // Recency: talked recently = still relevant
  const recencyBonus = daysSinceLast <= 1  ? 15
                     : daysSinceLast <= 7  ? 10
                     : daysSinceLast <= 30 ? 5
                     : 0;

  // Consistency: relationship built over time
  const consistencyBonus = daysSinceFirst >= 60  ? 15
                         : daysSinceFirst >= 30  ? 8
                         : daysSinceFirst >= 7   ? 4
                         : 0;

  const score = weighted + recencyBonus + consistencyBonus;

  // Trust levels:
  //   1 = stranger      (< 5 weighted interactions)
  //   2 = acquaintance  (5–20)
  //   3 = known         (20–60, default zone)
  //   4 = friend        (60–150)
  //   5 = close friend  (150+)
  if (score >= 150) return 5;
  if (score >= 60)  return 4;
  if (score >= 20)  return 3;
  if (score >= 5)   return 2;
  return 1;
}

// ── User upsert ───────────────────────────────────────────────────────────────

export async function upsertUser({ userId, username, displayName, avatarUrl, guildId, channelId }) {
  await db.execute(
    `INSERT INTO maya_users
       (discord_user_id, username, display_name, avatar_url,
        last_active_guild, last_active_channel, message_count)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       username             = VALUES(username),
       display_name         = VALUES(display_name),
       avatar_url           = VALUES(avatar_url),
       last_active_guild    = COALESCE(VALUES(last_active_guild), last_active_guild),
       last_active_channel  = COALESCE(VALUES(last_active_channel), last_active_channel),
       message_count        = message_count + 1,
       last_seen            = CURRENT_TIMESTAMP`,
    [userId, username, displayName || username, avatarUrl || '',
     guildId || null, channelId || null]
  );

  const [[row]] = await db.execute(
    `SELECT preferred_name, display_name, username FROM maya_users
     WHERE discord_user_id = ? LIMIT 1`,
    [userId]
  );

  // Register self-declared aliases (username and display name)
  await _registerAlias(userId, username, guildId, 'self_declared', 0.0);
  if (displayName && displayName !== username) {
    await _registerAlias(userId, displayName, guildId, 'self_declared', 0.0);
  }

  return row?.preferred_name || row?.display_name || row?.username || username;
}

// ── Preferred name set ────────────────────────────────────────────────────────

export async function detectNameSet(userId, message, guildId) {
  const m = message.match(/\bmy\s+name\s+is\s+([a-zA-Z][a-zA-Z\s]{0,30})/i);
  if (!m) return null;
  const newName = m[1].trim();
  await db.execute(
    `UPDATE maya_users SET preferred_name = ? WHERE discord_user_id = ?`,
    [newName, userId]
  );
  // Self-declared name → conflict_score = 0 (confirmed fact)
  await _registerAlias(userId, newName, guildId, 'self_declared', 0.0);
  return newName;
}

// ── Relationship: trust + context ─────────────────────────────────────────────

export async function getOrCreateRelationship(userId, contextType) {
  const col = contextType === 'dm' ? 'dm_count' : 'server_count';

  await db.execute(
    `INSERT INTO maya_user_relationships
       (discord_user_id, total_messages, ${col}, last_interaction)
     VALUES (?, 1, 1, NOW())
     ON DUPLICATE KEY UPDATE
       total_messages   = total_messages + 1,
       ${col}           = ${col} + 1,
       last_interaction = NOW()`,
    [userId]
  );

  const [[rel]] = await db.execute(
    `SELECT r.trust_level, r.vibe, r.nickname_for_user,
            r.inside_jokes, r.topics_they_like,
            r.total_messages, r.dm_count, r.server_count,
            r.created_at, r.last_interaction
     FROM maya_user_relationships r
     WHERE r.discord_user_id = ? LIMIT 1`,
    [userId]
  );

  if (!rel) return _defaultRel();

  // ── Recalculate trust dynamically ─────────────────────────────────────────
  const now           = Date.now();
  const firstMs       = new Date(rel.created_at).getTime();
  const lastMs        = new Date(rel.last_interaction).getTime();
  const daysSinceFirst = Math.floor((now - firstMs) / 86400000);
  const daysSinceLast  = Math.floor((now - lastMs)  / 86400000);

  const newTrust = calcTrust(
    rel.dm_count     || 0,
    rel.server_count || 0,
    daysSinceFirst,
    daysSinceLast
  );

  // Cap trust drops at 1 level per recalculation (prevents sudden cliff drops)
  const currentTrust = rel.trust_level || 3;
  const clampedTrust = Math.max(newTrust, currentTrust - 1);

  if (clampedTrust !== currentTrust) {
    await db.execute(
      `UPDATE maya_user_relationships SET trust_level = ? WHERE discord_user_id = ?`,
      [clampedTrust, userId]
    ).catch(() => {});
    console.log(`[trust] ${userId} → trust ${currentTrust} → ${clampedTrust} (dm=${rel.dm_count} srv=${rel.server_count} days=${daysSinceFirst})`);
  }

  return {
    trustLevel:     clampedTrust,
    vibe:           rel.vibe          || 'neutral',
    nickname:       rel.nickname_for_user || null,
    insideJokes:    _parseJson(rel.inside_jokes,    []),
    topicsTheyLike: _parseJson(rel.topics_they_like, []),
    totalMessages:  rel.total_messages || 0,
    dmCount:        rel.dm_count       || 0,
    serverCount:    rel.server_count   || 0,
  };
}

function _defaultRel() {
  return { trustLevel: 1, vibe: 'neutral', nickname: null,
           insideJokes: [], topicsTheyLike: [], totalMessages: 0,
           dmCount: 0, serverCount: 0 };
}

// ── Alias extraction ──────────────────────────────────────────────────────────

/**
 * Scan a message for name references and try to map them to known users.
 * "ask Mario", "Mario said", "@Mario" → look up who Mario is in this guild.
 */
export async function extractAliasReferences(message, guildId, mentionedUserIds = []) {
  // Extract @mentions directly — these are ground truth
  for (const uid of mentionedUserIds) {
    // The display name of this mentioned user is a confirmed alias
    // Already handled in upsertUser — nothing extra needed
  }

  // Extract name references from text patterns
  const namePatterns = [
    /\b([A-Z][a-z]{2,20})\s+(?:said|says|told|mentioned|asked|bro|yaar|ne)/g,
    /\bask\s+([A-Z][a-z]{2,20})\b/gi,
    /\btell\s+([A-Z][a-z]{2,20})\b/gi,
    /^([A-Z][a-z]{2,20})[,:]?\s/gm,   // "Mario: hey" or "Mario, what"
  ];

  const foundNames = new Set();
  for (const pat of namePatterns) {
    let m;
    while ((m = pat.exec(message)) !== null) {
      const name = m[1].trim();
      if (name.length >= 3) foundNames.add(name);
    }
  }

  return [...foundNames];
}

/**
 * Given a name string, find which discord user it maps to in this guild.
 */
export async function resolveAlias(name, guildId) {
  if (!name || name.length < 2) return null;
  try {
    const [rows] = await db.execute(
      `SELECT a.discord_user_id, a.conflict_score, a.source,
              u.preferred_name, u.display_name, u.username
       FROM maya_aliases a
       JOIN maya_users u ON u.discord_user_id = a.discord_user_id
       WHERE a.alias LIKE ?
         AND (a.guild_id = ? OR a.guild_id IS NULL)
       ORDER BY a.conflict_score ASC, a.mention_count DESC
       LIMIT 1`,
      [`%${name}%`, guildId || null]
    );
    return rows[0] || null;
  } catch { return null; }
}

/**
 * Register an alias for a user. Increments mention_count if already exists.
 */
async function _registerAlias(userId, alias, guildId, source = 'observed', conflictScore = 0.5) {
  if (!alias || alias.length < 2) return;
  try {
    await db.execute(
      `INSERT INTO maya_aliases (discord_user_id, alias, guild_id, source, conflict_score)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         mention_count  = mention_count + 1,
         conflict_score = LEAST(conflict_score, VALUES(conflict_score)),
         updated_at     = CURRENT_TIMESTAMP`,
      [userId, alias.slice(0, 100), guildId || null, source, conflictScore]
    );
  } catch { /* non-fatal */ }
}

export async function registerObservedAlias(userId, alias, guildId) {
  await _registerAlias(userId, alias, guildId, 'observed', 0.4);
}

// ── Get all known names in a guild (for lurk salience) ───────────────────────

export async function getKnownNames(guildId, limit = 30) {
  try {
    const [rows] = await db.execute(
      `SELECT DISTINCT alias FROM maya_aliases
       WHERE (guild_id = ? OR guild_id IS NULL)
         AND conflict_score < 0.5
         AND LENGTH(alias) >= 3
       ORDER BY mention_count DESC
       LIMIT ?`,
      [guildId || null, limit]
    );
    return rows.map(r => r.alias);
  } catch { return []; }
}

// ── Structured facts ──────────────────────────────────────────────────────────

const FACT_PATTERNS = [
  { re: /\bi (?:love|really love|adore)\s+(.{3,50})/i,          cat: 'preference',  score: 0.3 },
  { re: /\bi (?:hate|can't stand|dislike)\s+(.{3,50})/i,        cat: 'preference',  score: 0.3 },
  { re: /\bi(?:'m| am) (?:a |an )?([a-zA-Z\s]{3,40})/i,        cat: 'identity',    score: 0.2 },
  { re: /\bi work (?:at|in|for)\s+(.{3,50})/i,                  cat: 'identity',    score: 0.2 },
  { re: /\bmy (?:name) is\s+([a-zA-Z\s]{2,30})/i,               cat: 'identity',    score: 0.0 },
  { re: /\bi(?:'m| am) from\s+(.{3,40})/i,                      cat: 'identity',    score: 0.1 },
  { re: /\bi (?:study|studied)\s+(.{3,50})/i,                   cat: 'identity',    score: 0.3 },
  { re: /\bmy (?:fav(?:ou?rite)?)\s+(?:is\s+)?(.{3,40})/i,     cat: 'preference',  score: 0.4 },
  // Objective facts (user states something about the world, not themselves)
  { re: /\b(?:the\s+)?(?:first|second|third) law (?:of\s+)?(.{5,60})/i, cat: 'objective', score: 0.0 },
  { re: /\bscience says\s+(.{5,80})/i,                          cat: 'objective',   score: 0.1 },
];

export async function extractAndStoreFact(userId, message) {
  for (const { re, cat, score } of FACT_PATTERNS) {
    const m = message.match(re);
    if (!m) continue;
    const fact = m[0].trim().slice(0, 200);
    try {
      // Check for conflict — if similar fact exists with different content
      const [existing] = await db.execute(
        `SELECT id, fact, conflict_score FROM maya_facts
         WHERE discord_user_id = ? AND category = ?
         ORDER BY created_at DESC LIMIT 5`,
        [userId, cat]
      );
      // Simple conflict detection: if category already has a fact, bump score slightly
      const adjustedScore = existing.length > 0 ? Math.min(score + 0.1, 0.9) : score;

      await db.execute(
        `INSERT INTO maya_facts
           (discord_user_id, fact, category, conflict_score, source_message)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, fact, cat, adjustedScore, message.slice(0, 500)]
      );
    } catch { /* non-fatal */ }
    break; // one fact per message
  }
}

/**
 * Get confirmed/low-conflict facts for a user to inject into LLM context.
 * Only returns facts with conflict_score < 0.4.
 */
export async function getConfirmedFacts(userId, limit = 6) {
  try {
    const [rows] = await db.execute(
      `SELECT fact, category, conflict_score FROM maya_facts
       WHERE discord_user_id = ? AND conflict_score < 0.4
       ORDER BY conflict_score ASC, updated_at DESC
       LIMIT ?`,
      [userId, limit]
    );
    return rows.map(r => `[${r.category}] ${r.fact}`);
  } catch { return []; }
}

// ── User↔User observed relations ─────────────────────────────────────────────

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
  } catch { /* non-fatal */ }
}

export async function getFrequentInteractors(userId, guildId, limit = 3) {
  try {
    const [rows] = await db.execute(
      `SELECT CASE WHEN user_a_id=? THEN user_b_id ELSE user_a_id END AS other_id,
              interaction_count
       FROM maya_observed_relations
       WHERE (user_a_id=? OR user_b_id=?)
         AND (guild_id=? OR guild_id IS NULL)
       ORDER BY interaction_count DESC LIMIT ?`,
      [userId, userId, userId, guildId || null, limit]
    );
    if (!rows.length) return [];
    const ids = rows.map(r => r.other_id);
    const ph  = ids.map(() => '?').join(',');
    const [users] = await db.execute(
      `SELECT discord_user_id, preferred_name, display_name, username
       FROM maya_users WHERE discord_user_id IN (${ph})`, ids
    );
    return users.map(u => ({
      id:    u.discord_user_id,
      name:  u.preferred_name || u.display_name || u.username,
      count: rows.find(r => r.other_id === u.discord_user_id)?.interaction_count || 0,
    }));
  } catch { return []; }
}

// ── Entropy helpers ───────────────────────────────────────────────────────────

export function getEntropyZone(entropy) {
  if (entropy < 0.3) return { zone: 'Restful', line: 'low energy' };
  if (entropy > 0.7) return { zone: 'Chaos',   line: 'high energy' };
  return              { zone: 'Social',  line: 'normal energy' };
}

export function estimateEntropy(text) {
  const len          = Math.min(text.length / 200, 1.0);
  const exclamations = (text.match(/!/g)  || []).length;
  const questions    = (text.match(/\?/g) || []).length;
  const caps         = (text.match(/\b[A-Z]{2,}\b/g) || []).length;
  const score = 0.1 + len * 0.3 + exclamations * 0.06 + questions * 0.04 + caps * 0.04;
  return Math.min(parseFloat(score.toFixed(2)), 1.0);
}

// ── Internal ──────────────────────────────────────────────────────────────────
function _parseJson(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}
