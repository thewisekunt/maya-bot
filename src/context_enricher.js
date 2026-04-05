/**
 * context_enricher.js — Enriches handler context with several signals:
 *
 * 1. Referenced message context — when someone tags @maya in a reply to
 *    an old message, the referenced message content is injected so Maya
 *    understands what she's being shown.
 *
 * 2. Cross-server scoping — knownFacts and recent context are filtered
 *    to the current guild. A user is only carried across servers if
 *    they're actually present in both.
 *
 * 3. Gender + role injection — Maya knows the user's gender (inferred
 *    or stated) and their server roles for more natural references.
 *
 * 4. Emotional presence — if Maya is thinking about someone right now
 *    (missing them, happy about them, etc.), that bleeds into how she
 *    talks when that person or their traits come up.
 */

import db from './db.js';

// ── 1. Referenced message context ────────────────────────────────────────────

/**
 * When a user replies to an old message while tagging Maya,
 * fetch the referenced message content and return it as context.
 *
 * @param {Message} msg - the Discord message object
 * @param {string}  botId - Maya's user ID
 * @returns {string|null} - formatted context string or null
 */
export async function getReferencedContext(msg, botId) {
  if (!msg.reference?.messageId) return null;

  try {
    const ref = await msg.channel.messages.fetch(msg.reference.messageId);
    if (!ref) return null;

    const refIsMaya = ref.author.id === botId;
    const who       = refIsMaya ? 'Maya' : (ref.member?.displayName || ref.author?.username || 'someone');
    const content   = ref.content?.slice(0, 400) || '[media/embed]';
    const ts        = _relativeTime(ref.createdAt);

    // Build the chain — we want to understand the TOPIC being referenced
    // not just the single message
    const chain = [];
    chain.push({ who, content, ts, isMaya: refIsMaya });

    // Fetch one level deeper to get topic context
    if (ref.reference?.messageId) {
      try {
        const ref2 = await msg.channel.messages.fetch(ref.reference.messageId);
        if (ref2?.content) {
          const who2   = ref2.author.id === botId ? 'Maya' : (ref2.member?.displayName || ref2.author?.username || 'someone');
          const ts2    = _relativeTime(ref2.createdAt);
          chain.unshift({ who: who2, content: ref2.content.slice(0, 300), ts: ts2, isMaya: ref2.author.id === botId });
        }
      } catch { /* non-fatal */ }
    }

    // Format the chain clearly
    const chainText = chain
      .map(m => `${m.who} [${m.ts}]: "${m.content}"`)
      .join(' → ');

    // Determine likely intent of the tag
    // If user is tagging Maya in a reply to someone else's message,
    // they probably want Maya's opinion on that topic
    const isTaggingForOpinion = !refIsMaya && msg.mentions?.has({ id: botId });
    const intentHint = isTaggingForOpinion
      ? 'Note: user is likely asking for Maya\'s view on the referenced topic, not just the current message.'
      : '';

    return `[Referenced thread — ${chainText}${intentHint ? ' ' + intentHint : ''}]`;

  } catch { return null; }
}

function _relativeTime(date) {
  const diff = Date.now() - new Date(date).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── 2. Cross-server context scoping ──────────────────────────────────────────

/**
 * Check if a user is present (has been active) in a guild.
 * Used to decide whether to show their cross-server facts.
 *
 * @returns {boolean}
 */
export async function isUserInGuild(userId, guildId) {
  if (!guildId) return true; // DM — no guild scoping
  try {
    const [[row]] = await db.execute(
      `SELECT COUNT(*) as n FROM maya_memory
       WHERE discord_user_id=? AND guild_id=?
         AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
       LIMIT 1`,
      [userId, guildId]
    );
    return (row?.n || 0) > 0;
  } catch { return true; }
}

/**
 * Get confirmed facts scoped to the current server.
 * Only returns facts that originated from this guild,
 * PLUS global facts (DM-sourced) that are identity-level.
 *
 * @param {string} userId
 * @param {string|null} guildId
 * @param {number} limit
 */
export async function getScopedFacts(userId, guildId, limit = 6) {
  try {
    let rows;
    if (guildId) {
      // Facts from this guild OR identity/location facts (global)
      [rows] = await db.execute(
        `SELECT fact, category, conflict_score, memory_strength
         FROM maya_facts
         WHERE discord_user_id=? AND conflict_score < 0.4
           AND (
             guild_id = ?
             OR guild_id IS NULL
             OR category IN ('identity', 'location', 'relationship')
           )
         ORDER BY
           CASE WHEN guild_id=? THEN 0 ELSE 1 END ASC,
           memory_strength DESC,
           updated_at DESC
         LIMIT ?`,
        [userId, guildId, guildId, limit]
      );
    } else {
      // DM — show all facts regardless of origin
      [rows] = await db.execute(
        `SELECT fact, category, conflict_score, memory_strength
         FROM maya_facts
         WHERE discord_user_id=? AND conflict_score < 0.4
         ORDER BY memory_strength DESC, updated_at DESC
         LIMIT ?`,
        [userId, limit]
      );
    }
    return (rows || []).map(r => r.fact);
  } catch { return []; }
}

// ── 3. Gender + roles ─────────────────────────────────────────────────────────

/**
 * Get a user's gender and server roles for prompt injection.
 * @returns {{ gender: string|null, roles: string[] }}
 */
export async function getUserGenderAndRoles(userId, guildId) {
  let gender = null;
  let roles  = [];

  // Gender
  try {
    const [[u]] = await db.execute(
      `SELECT gender, gender_confidence FROM maya_users WHERE discord_user_id=? LIMIT 1`,
      [userId]
    );
    if (u?.gender && u.gender_confidence > 0) gender = u.gender;
  } catch { /* non-fatal */ }

  // Server roles
  if (guildId) {
    try {
      const [[r]] = await db.execute(
        `SELECT roles FROM maya_user_server_roles
         WHERE discord_user_id=? AND guild_id=? LIMIT 1`,
        [userId, guildId]
      );
      if (r?.roles) roles = JSON.parse(r.roles) || [];
    } catch { /* non-fatal */ }
  }

  return { gender, roles };
}

/**
 * Sync a member's roles to DB. Call when Maya sees a message from them.
 * Cheap upsert — only runs once per session per user.
 */
const _roleSynced = new Set();  // session cache to avoid per-message DB writes

export async function syncMemberRoles(member, guildId) {
  if (!member || !guildId) return;
  const key = `${member.id}:${guildId}`;
  if (_roleSynced.has(key)) return;
  _roleSynced.add(key);

  try {
    // Get role names, filter out @everyone
    const roleNames = member.roles.cache
      .filter(r => r.name !== '@everyone')
      .map(r => r.name)
      .slice(0, 20);  // cap at 20

    await db.execute(
      `INSERT INTO maya_user_server_roles (discord_user_id, guild_id, roles)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE roles=VALUES(roles), updated_at=NOW()`,
      [member.id, guildId, JSON.stringify(roleNames)]
    );

    // Infer gender from role names if not already known
    await _inferGenderFromRoles(member.id, roleNames);

  } catch { /* non-fatal */ }
}

async function _inferGenderFromRoles(userId, roleNames) {
  try {
    const [[u]] = await db.execute(
      `SELECT gender_confidence FROM maya_users WHERE discord_user_id=? LIMIT 1`,
      [userId]
    );
    if (u?.gender_confidence >= 2) return; // already stated — don't overwrite

    const rolesLower = roleNames.map(r => r.toLowerCase());
    let gender = null;

    const maleRoles   = ['he/him', 'he', 'male', 'bro', 'guy', 'mr', 'brother'];
    const femaleRoles = ['she/her', 'she', 'female', 'girl', 'sis', 'sister', 'ms', 'mrs'];
    const nbRoles     = ['they/them', 'nonbinary', 'non-binary', 'nb', 'enby'];

    if (rolesLower.some(r => nbRoles.some(nb => r.includes(nb))))     gender = 'nb';
    else if (rolesLower.some(r => femaleRoles.some(f => r.includes(f)))) gender = 'female';
    else if (rolesLower.some(r => maleRoles.some(m => r.includes(m))))  gender = 'male';

    if (gender) {
      await db.execute(
        `UPDATE maya_users SET gender=?, gender_confidence=1 WHERE discord_user_id=?`,
        [gender, userId]
      );
    }
  } catch { /* non-fatal */ }
}

/**
 * Infer gender from conversation cues (stated pronouns, names, etc.)
 * Call after fact extraction if message contains pronoun signals.
 */
export async function inferGenderFromText(userId, text) {
  try {
    const [[u]] = await db.execute(
      `SELECT gender_confidence FROM maya_users WHERE discord_user_id=? LIMIT 1`,
      [userId]
    );
    if (u?.gender_confidence >= 2) return;

    const t = text.toLowerCase();
    let gender = null;
    let confidence = 1;

    // Stated pronouns
    if (/\bshe\/her\b|\bi am a girl\b|\bi'?m a girl\b/i.test(t)) { gender = 'female'; confidence = 2; }
    else if (/\bhe\/him\b|\bi am a (boy|guy|man)\b|\bi'?m a (boy|guy|man)\b/i.test(t)) { gender = 'male'; confidence = 2; }
    else if (/\bthey\/them\b|\bnon.?binary\b/i.test(t)) { gender = 'nb'; confidence = 2; }

    if (gender) {
      await db.execute(
        `UPDATE maya_users SET gender=?, gender_confidence=? WHERE discord_user_id=?`,
        [gender, confidence, userId]
      );
    }
  } catch { /* non-fatal */ }
}

// ── 4. Emotional presence ─────────────────────────────────────────────────────

/**
 * Store an emotional state Maya has about someone.
 * @param {string} subjectUserId - who Maya is feeling about
 * @param {string} emotionType   - missing|worried|happy_about|annoyed_at|thinking_of
 * @param {number} intensity     - 0-1
 * @param {string} context       - brief note why
 * @param {string} guildId       - which server this originated from
 */
export async function storeEmotionalPresence(subjectUserId, emotionType, intensity, context, guildId) {
  try {
    const expiresAt = new Date(Date.now() + 6 * 3600000); // expires in 6h
    await db.execute(
      `INSERT INTO maya_emotional_presence
         (subject_user_id, emotion_type, intensity, context, guild_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [subjectUserId, emotionType, intensity, context?.slice(0, 200), guildId || null, expiresAt]
    );
  } catch { /* non-fatal */ }
}

/**
 * Get active emotional presence states.
 * Returns what Maya is currently feeling about people.
 */
export async function getActiveEmotions() {
  try {
    const [rows] = await db.execute(
      `SELECT ep.subject_user_id, ep.emotion_type, ep.intensity, ep.context, ep.guild_id,
              COALESCE(u.display_name, u.username) as user_name
       FROM maya_emotional_presence ep
       LEFT JOIN maya_users u ON u.discord_user_id = ep.subject_user_id
       WHERE ep.expires_at > NOW()
         AND ep.intensity >= 0.4
       ORDER BY ep.intensity DESC
       LIMIT 5`
    );
    return rows || [];
  } catch { return []; }
}

/**
 * Check if any active emotion is relevant to the current message.
 * Returns a context string to inject if relevant.
 */
export async function getEmotionalContext(messageText, speakerId) {
  const emotions = await getActiveEmotions();
  if (!emotions.length) return null;

  const relevant = [];

  for (const e of emotions) {
    // Skip if the message IS from the person Maya is thinking about
    if (e.subject_user_id === speakerId) continue;

    // Check if the person's name appears in the message
    const name = e.user_name?.toLowerCase();
    if (!name || name.length < 2) continue;

    if (messageText.toLowerCase().includes(name)) {
      const emotionDesc = {
        missing:      `Maya is missing ${e.user_name} right now`,
        worried:      `Maya is a bit worried about ${e.user_name}`,
        happy_about:  `Maya is happy about something ${e.user_name} said/did`,
        annoyed_at:   `Maya is mildly annoyed at ${e.user_name} right now`,
        thinking_of:  `Maya has ${e.user_name} on her mind`,
      }[e.emotion_type] || `Maya is thinking about ${e.user_name}`;

      relevant.push(emotionDesc);
    }
  }

  if (!relevant.length) return null;

  return `[Maya's current emotional state: ${relevant.join('. ')}. This may subtly colour her tone if relevant — don't force it.]`;
}

/**
 * Auto-generate emotional presence from initiation pressure.
 * When Maya wants to message someone but can't (sleeping, cooldown),
 * store a "missing" emotion that persists until she talks to them.
 */
export async function markMissing(userId, userName, intensity, guildId) {
  // Remove any existing missing emotion for this user first
  await db.execute(
    `DELETE FROM maya_emotional_presence
     WHERE subject_user_id=? AND emotion_type='missing'`,
    [userId]
  ).catch(() => {});

  await storeEmotionalPresence(userId, 'missing', intensity, `${userName} hasn't been around`, guildId);
}

/**
 * Clear emotional presence for a user when Maya actually talks to them.
 */
export async function clearEmotionFor(userId) {
  await db.execute(
    `DELETE FROM maya_emotional_presence WHERE subject_user_id=?`,
    [userId]
  ).catch(() => {});
}
