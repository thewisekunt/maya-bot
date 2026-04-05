/**
 * entity.js — Entity resolution engine
 *
 * When someone says "Mario said something earlier" or "@Vexy hie", Maya should
 * understand WHO those names refer to and fetch relevant facts/context about them.
 *
 * Architecture:
 *   1. Scan message text for known member names / aliases
 *   2. For each matched entity, fetch their facts + relationship data
 *   3. Inject as structured context into the LLM prompt
 *   4. Update maya_member_index when new members are seen
 */

import db from './db.js';

// ── Member index ──────────────────────────────────────────────────────────────

/**
 * Upsert a guild member into the local index.
 * Call this every time Maya sees a message (cheap DB write, ON DUPLICATE KEY).
 */
export async function indexMember(guildId, userId, displayName, username) {
  if (!guildId || !userId || !displayName) return;
  try {
    await db.execute(
      `INSERT INTO maya_member_index
         (guild_id, discord_user_id, display_name, username, name_lower, last_seen)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         display_name  = VALUES(display_name),
         username      = VALUES(username),
         name_lower    = VALUES(name_lower),
         last_seen     = NOW()`,
      [guildId, userId, displayName, username || displayName, displayName.toLowerCase()]
    );
  } catch { /* non-fatal */ }
}

/**
 * Scan message text for mentions of known members.
 * Returns array of { userId, displayName, matchedName } for each entity found.
 *
 * Matching strategy:
 *   1. Discord @mentions (<@userId>) — exact
 *   2. Known display names (case-insensitive, word boundary)
 *   3. Known aliases from maya_aliases
 */
export async function resolveEntities(text, guildId, speakerId, botId) {
  if (!text || !guildId) return [];

  const found = new Map();  // userId → match info

  // Phase 1: resolve Discord @mentions
  const mentionRe = /<@!?(\d+)>/g;
  let m;
  while ((m = mentionRe.exec(text)) !== null) {
    const uid = m[1];
    if (uid === botId || uid === speakerId) continue;  // skip Maya and speaker
    const [[member]] = await db.execute(
      `SELECT display_name, username FROM maya_member_index
       WHERE guild_id=? AND discord_user_id=? LIMIT 1`,
      [guildId, uid]
    ).catch(() => [[null]]);
    if (member) {
      found.set(uid, { userId: uid, displayName: member.display_name, matchedName: member.display_name, source: 'mention' });
    }
  }

  // Phase 2: match known display names in text
  const [members] = await db.execute(
    `SELECT discord_user_id, display_name, username, name_lower
     FROM maya_member_index WHERE guild_id=? AND last_seen > DATE_SUB(NOW(), INTERVAL 30 DAY)
     ORDER BY mention_count DESC LIMIT 50`,
    [guildId]
  ).catch(() => [[]]);

  const textLower = text.toLowerCase();
  for (const member of members) {
    if (found.has(member.discord_user_id)) continue;
    if (member.discord_user_id === speakerId || member.discord_user_id === botId) continue;

    // Check display name (word boundary match)
    const nameLower = member.name_lower;
    if (nameLower.length < 2) continue;

    const idx = textLower.indexOf(nameLower);
    if (idx === -1) continue;

    // Verify word boundary (not mid-word)
    const before = idx > 0 ? textLower[idx - 1] : ' ';
    const after  = idx + nameLower.length < textLower.length ? textLower[idx + nameLower.length] : ' ';
    if (/\w/.test(before) || /\w/.test(after)) continue;

    found.set(member.discord_user_id, {
      userId:      member.discord_user_id,
      displayName: member.display_name,
      matchedName: member.display_name,
      source:      'name_match',
    });
  }

  return [...found.values()];
}

/**
 * Fetch context about a specific user to inject into Maya's prompt.
 * Returns a compact string: facts + relationship summary.
 */
export async function getUserContext(userId, guildId) {
  const parts = [];

  // Relationship data
  const [[rel]] = await db.execute(
    `SELECT trust_level, vibe, attachment_score, harmony_count, conflict_count,
            last_interaction, total_messages
     FROM maya_user_relationships WHERE discord_user_id=? LIMIT 1`,
    [userId]
  ).catch(() => [[null]]);

  if (rel) {
    const trust = ['stranger','acquaintance','friend','close friend','bestie'][rel.trust_level - 1] || 'unknown';
    const msgs  = rel.total_messages || 0;
    parts.push(`${trust}, ~${msgs} msgs`);
    if (rel.vibe && rel.vibe !== 'neutral') parts.push(`vibe: ${rel.vibe}`);
    if (rel.attachment_score > 0.6) parts.push('Maya is attached to them');
    if (rel.conflict_count > 3) parts.push('some conflict history');
  }

  // Facts Maya knows about them
  const [facts] = await db.execute(
    `SELECT fact FROM maya_facts
     WHERE discord_user_id=? AND conflict_score < 0.4
     ORDER BY memory_strength DESC, updated_at DESC LIMIT 4`,
    [userId]
  ).catch(() => [[]]);

  for (const f of facts) parts.push(f.fact);

  return parts.length > 0 ? parts.join('; ') : null;
}

/**
 * Build the entity context block to inject into the LLM prompt.
 * Called from handler.js when entities are found in the message.
 */
export async function buildEntityContext(entities, guildId) {
  if (!entities.length) return null;

  const lines = [];
  for (const entity of entities.slice(0, 4)) {  // max 4 entities
    const ctx = await getUserContext(entity.userId, guildId);
    if (ctx) {
      lines.push(`${entity.displayName}: ${ctx}`);
    }
  }

  return lines.length > 0
    ? `People mentioned in this message:
${lines.map(l => `  • ${l}`).join('\n')}`
    : null;
}

/**
 * Is this message primarily addressed to someone ELSE (not Maya)?
 * Used to decide if Maya should stay quiet even when mentioned.
 *
 * Heuristic: message has @otherUser at the START and Maya is not @mentioned,
 * OR message has a name at the start that isn't Maya.
 */
export function isAddressedToOther(text, entities, botId) {
  if (!entities.length) return false;

  const firstChunk = text.slice(0, 30).toLowerCase().trim();

  for (const entity of entities) {
    if (entity.userId === botId) continue;
    const nameLower = entity.displayName.toLowerCase();
    // If message starts with the other person's name/mention → it's for them
    if (firstChunk.startsWith(nameLower) || firstChunk.startsWith(`<@${entity.userId}>`)) {
      return true;
    }
  }
  return false;
}
