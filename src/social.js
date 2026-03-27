/**
 * social.js — Maya's social graph awareness
 *
 * Gives Maya the ability to answer:
 *   "who do I know in this server?"
 *   "who have I talked to in DMs?"
 *   "how well do I know Danish?"
 *   "who are Danish's friends here?"
 *
 * All data comes from existing tables:
 *   maya_users            — every person Maya has seen
 *   maya_user_relationships — trust + interaction stats
 *   maya_observed_relations — user↔user pairs Maya has seen interact
 *   maya_sessions          — which channels/guilds conversations happened
 */

import db from './db.js';

// ── Server social graph ───────────────────────────────────────────────────────

/**
 * Get everyone Maya knows in a guild, sorted by trust + interaction count.
 * Returns a structured summary ready for LLM injection.
 */
export async function getServerSocialGraph(guildId) {
  try {
    const [rows] = await db.execute(
      `SELECT
         u.discord_user_id,
         COALESCE(u.preferred_name, u.display_name, u.username) AS name,
         u.message_count,
         u.last_seen,
         r.trust_level,
         r.dm_count,
         r.server_count,
         r.total_messages
       FROM maya_users u
       LEFT JOIN maya_user_relationships r ON r.discord_user_id = u.discord_user_id
       WHERE u.last_active_guild = ?
          OR u.discord_user_id IN (
            SELECT DISTINCT discord_user_id FROM maya_memory
            WHERE guild_id = ? AND discord_user_id != 'maya'
          )
       ORDER BY COALESCE(r.trust_level, 1) DESC,
                COALESCE(r.total_messages, 0) DESC
       LIMIT 30`,
      [guildId, guildId]
    );
    return rows;
  } catch { return []; }
}

/**
 * Build a short social summary string for Maya's LLM context.
 * Only injected when Maya is asked a social question.
 *
 * Example output:
 * "In this server Maya knows: Mario (close friend, 234 msgs),
 *  Danish (friend, 89 msgs), Sai (acquaintance, 12 msgs)..."
 */
export async function buildServerSocialSummary(guildId, currentUserId) {
  const people = await getServerSocialGraph(guildId);
  if (!people.length) return '';

  const TRUST_LABELS = { 5:'close friend', 4:'friend', 3:'known', 2:'acquaintance', 1:'stranger' };

  const lines = people
    .filter(p => p.discord_user_id !== currentUserId)  // exclude current speaker
    .slice(0, 10)
    .map(p => {
      const trust = TRUST_LABELS[p.trust_level] || 'stranger';
      const msgs  = p.total_messages || p.message_count || 0;
      const dm    = p.dm_count > 0 ? ', DMs' : '';
      return `${p.name} (${trust}${dm}, ~${msgs} msgs)`;
    })
    .join(', ');

  return lines ? `Maya knows in this server: ${lines}` : '';
}

/**
 * Get Maya's DM contacts — people she's talked to privately.
 */
export async function getDMContacts(limit = 10) {
  try {
    const [rows] = await db.execute(
      `SELECT
         u.discord_user_id,
         COALESCE(u.preferred_name, u.display_name, u.username) AS name,
         r.trust_level,
         r.dm_count,
         r.last_interaction
       FROM maya_user_relationships r
       JOIN maya_users u ON u.discord_user_id = r.discord_user_id
       WHERE r.dm_count > 0
       ORDER BY r.dm_count DESC, r.last_interaction DESC
       LIMIT ?`,
      [limit]
    );
    return rows;
  } catch { return []; }
}

/**
 * Detect if the current message is a social query — asking about people/network.
 */
export function isSocialQuery(text) {
  return /\b(who do (i|you) know|how many people|anyone in|who('s| is) here|do (i|you) know [a-z]+|my friends|your friends|who have (i|you) (talked|spoken|chatted)|people (i|you) know|who is [a-z]+)\b/i.test(text);
}

/**
 * Build a full social context block for injection when a social query is detected.
 */
export async function buildSocialContext(guildId, currentUserId, isDM) {
  const parts = [];

  if (!isDM && guildId) {
    const serverSummary = await buildServerSocialSummary(guildId, currentUserId);
    if (serverSummary) parts.push(serverSummary);
  }

  const dmContacts = await getDMContacts(5);
  if (dmContacts.length) {
    const dmNames = dmContacts.map(p => p.name).join(', ');
    parts.push(`Maya has had private DM conversations with: ${dmNames}`);
  }

  return parts.join('\n');
}

/**
 * Get observed relationships between two users — for answering
 * "do Danish and Mario know each other?"
 */
export async function getUserRelationship(userAId, userBId, guildId) {
  const [a, b] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];
  try {
    const [[row]] = await db.execute(
      `SELECT r.relation_type, r.interaction_count,
              ua.preferred_name AS name_a, ub.preferred_name AS name_b
       FROM maya_observed_relations r
       JOIN maya_users ua ON ua.discord_user_id = r.user_a_id
       JOIN maya_users ub ON ub.discord_user_id = r.user_b_id
       WHERE r.user_a_id=? AND r.user_b_id=?
         AND (r.guild_id=? OR r.guild_id IS NULL)`,
      [a, b, guildId || null]
    );
    return row || null;
  } catch { return null; }
}
