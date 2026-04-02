import { config } from './config.js';
import axios from 'axios';
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
/**
 * Trust is not just about how many messages were sent —
 * it's about the quality and nature of those conversations.
 *
 * Factors:
 *   - Conversation depth (entropy): low entropy (one-word replies) = shallow
 *     High entropy (varied, expressive messages) = deeper connection
 *   - Harmony vs conflict: repeated conflicts reduce trust
 *   - DMs are still weighted higher (more intimate)
 *   - Recency and consistency bonuses still apply
 */
function calcTrust(dmCount, serverCount, daysSinceFirst, daysSinceLast,
                   avgEntropy = 0.4, conflictCount = 0, harmonyCount = 0) {

  // Base: interaction depth matters more than raw count
  // DMs weighted 3x, but only if conversations had substance (entropy > 0.3)
  const depthMultiplier = avgEntropy > 0.6 ? 1.4   // rich conversations
                        : avgEntropy > 0.4 ? 1.0   // normal
                        : avgEntropy > 0.2 ? 0.7   // shallow/one-liners
                        : 0.4;                      // very low engagement

  const weighted = ((dmCount * 3) + serverCount) * depthMultiplier;

  // Recency bonus
  const recencyBonus = daysSinceLast <= 1  ? 15
                     : daysSinceLast <= 7  ? 10
                     : daysSinceLast <= 30 ? 5
                     : 0;

  // Consistency bonus
  const consistencyBonus = daysSinceFirst >= 60 ? 15
                         : daysSinceFirst >= 30 ? 8
                         : daysSinceFirst >= 7  ? 4
                         : 0;

  // Harmony/conflict adjustment
  // Conflicts reduce the score; positive interactions add a small bonus
  const conflictPenalty = conflictCount * 8;
  const harmonyBonus    = Math.min(harmonyCount * 2, 20);  // capped at +20

  const score = weighted + recencyBonus + consistencyBonus - conflictPenalty + harmonyBonus;

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
    rel.dm_count      || 0,
    rel.server_count  || 0,
    daysSinceFirst,
    daysSinceLast,
    parseFloat(rel.avg_entropy)    || 0.4,
    rel.conflict_count             || 0,
    rel.harmony_count              || 0,
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

// In-memory cache of already-registered aliases to avoid redundant DB writes
// key: `${userId}:${alias}:${guildId}` → true

/**
 * Update conversation quality signals on a relationship.
 * Called after each exchange to track entropy, conflicts, harmony.
 *
 * @param {string} userId
 * @param {number} messageEntropy   — entropy of the user's message (0–1)
 * @param {string} signalType       — 'neutral' | 'conflict' | 'harmony'
 */
export async function updateRelationshipSignals(userId, messageEntropy, signalType = 'neutral') {
  try {
    const conflictDelta = signalType === 'conflict' ? 1 : 0;
    const harmonyDelta  = signalType === 'harmony'  ? 1 : 0;
    await db.execute(
      `UPDATE maya_user_relationships
       SET
         avg_entropy     = COALESCE(avg_entropy, 0.4) * 0.85 + ? * 0.15,
         entropy_samples = entropy_samples + 1,
         conflict_count  = conflict_count + ?,
         harmony_count   = harmony_count  + ?
       WHERE discord_user_id = ?`,
      [messageEntropy, conflictDelta, harmonyDelta, userId]
    );
  } catch { /* non-fatal */ }
}

const _aliasCache = new Set();

/**
 * Register an alias for a user.
 * Only writes to DB once per process lifetime per alias.
 * Aliases are: username, display name, preferred name — not conversation-derived.
 */
async function _registerAlias(userId, alias, guildId, source = 'observed', conflictScore = 0.5) {
  if (!alias || alias.length < 2) return;
  const key = `${userId}:${alias.toLowerCase()}:${guildId || 'global'}`;
  if (_aliasCache.has(key)) return;  // already registered this session

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
    _aliasCache.add(key);
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
  { re: /\bi (?:love|really love|adore)\s+([a-zA-Z][\w\s,'-]{3,50}?)(?:[.!?]|$)/i,         cat: 'preference', score: 0.3 },
  { re: /\bi (?:hate|can't stand|dislike)\s+([a-zA-Z][\w\s,'-]{3,50}?)(?:[.!?]|$)/i,       cat: 'preference', score: 0.3 },
  // Business / occupation ownership
  { re: /\bi (?:have|own|run|manage|operate) (?:a |an |my )?([a-zA-Z][\w\s]{3,50}?)(?:business|company|shop|store|dealership|startup|agency|firm)?(?:[.!?]|$)/i, cat: 'occupation', score: 0.1 },
  { re: /\bmy (?:business|company|shop|store|dealership|startup|agency|firm)\s+(?:is\s+)?([a-zA-Z][\w\s]{0,40}?)(?:[.!?]|$)/i, cat: 'occupation', score: 0.1 },
  // Negation identity facts — "I am not a student", "I don't work at X"
  { re: /\bi(?:'m| am) not (?:a |an )?([a-zA-Z][\w\s]{3,40}?)(?:[.!?]|$)/i,                 cat: 'identity',   score: 0.15 },
  // Identity: require clear role/profession nouns — avoid sentence fragments
  { re: /\bi(?:'m| am) (?:a |an )(developer|student|designer|engineer|doctor|teacher|writer|gamer|artist|musician|streamer|lawyer|nurse|chef|photographer|businessman|entrepreneur|dealer|owner)[\w\s]{0,20}/i, cat: 'identity', score: 0.2 },
  { re: /\bi work (?:at|in|for)\s+([a-zA-Z][\w\s]{3,40}?)(?:[.!?]|$)/i,                   cat: 'identity',   score: 0.2 },
  { re: /\bmy name is\s+([a-zA-Z][a-zA-Z\s]{2,25}?)(?:[.!?\s]|$)/i,                       cat: 'identity',   score: 0.0 },
  { re: /\bi(?:'m| am) from\s+([a-zA-Z][\w\s]{3,35}?)(?:[.!?]|$)/i,                       cat: 'identity',   score: 0.1 },
  { re: /\bi (?:study|studied)\s+([a-zA-Z][\w\s]{3,45}?)(?:[.!?]|$)/i,                    cat: 'identity',   score: 0.3 },
  { re: /\bmy fav(?:ou?rite)?\s+(?:is\s+)?([a-zA-Z][\w\s,'-]{3,40}?)(?:[.!?]|$)/i,      cat: 'preference', score: 0.4 },
  { re: /\bi (?:like|enjoy|prefer)\s+([a-zA-Z][\w\s,'-]{3,45}?)(?:[.!?]|$)/i,            cat: 'preference', score: 0.35 },
  { re: /\bi (?:play|watch|read)\s+([a-zA-Z][\w\s,'-]{3,45}?)(?:[.!?]|$)/i,              cat: 'preference', score: 0.4 },
  // Location / life stage
  { re: /\bi(?:'m| am) (?:in|at)\s+([a-zA-Z][\w\s]{3,40}?)(?:[.!?]|$)/i,                 cat: 'identity',   score: 0.2 },
  // Relationship status
  { re: /\bi(?:'m| am) (?:single|married|engaged|dating|in a relationship)(?:[.!?\s]|$)/i,   cat: 'identity',   score: 0.2 },
];

/**
 * Extract facts from a USER message using a two-stage pipeline:
 *
 * Stage 1 — Fast pre-filter (free):
 *   Skip messages that are too short, pure reactions, or clearly factless.
 *   Regex provides a quick "definitely has a fact" fast-path for common patterns.
 *
 * Stage 2 — LLM extraction (cheap, only when needed):
 *   Small targeted call asking "what facts about this person can be extracted?"
 *   Returns structured JSON. Handles complex phrasing regex never could:
 *   "I have a business I am not a student" → two facts extracted correctly.
 *
 * Facts stored as third-person: "Mario owns a Honda dealership"
 */
export async function extractAndStoreFact(userId, message) {
  // ── Pre-filter: skip messages that can't contain facts ───────────────────────
  const cleaned = message.replace(/<[^>]+>/g, '').trim();  // strip Discord mentions/emotes
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;

  // Too short, pure emoji/reaction, or starts with typical non-fact patterns
  if (wordCount < 4) return;
  if (/^(lol|lmao|haha|ok|okay|k|yep|nope|same|fr|bruh|bro|gg|rip|omg|wtf|damn|nice|cool)/i.test(cleaned)) return;

  // ── Get user's name ───────────────────────────────────────────────────────────
  let userName = 'the user';
  try {
    const [[u]] = await db.execute(
      `SELECT preferred_name, display_name, username FROM maya_users
       WHERE discord_user_id = ? LIMIT 1`, [userId]
    );
    userName = u?.preferred_name || u?.display_name || u?.username || 'the user';
  } catch { /* non-fatal */ }

  // ── Stage 1: Regex fast-path for obvious facts ────────────────────────────────
  // If regex matches, store immediately and also run LLM (might catch more)
  let regexFound = false;
  for (const { re, cat, score } of FACT_PATTERNS) {
    const m = cleaned.match(re);
    if (!m) continue;
    const raw  = m[0].trim();
    const fact = _attributeFact(raw, userName).slice(0, 200);
    await _storeFact(userId, userName, fact, cat, score, cleaned).catch(() => {});
    regexFound = true;
    break;  // store first regex match, LLM will catch the rest
  }

  // ── Stage 2: LLM extraction ───────────────────────────────────────────────────
  // Run if: no regex match (might still have facts) OR message is complex enough
  // that regex probably missed things (long messages, multiple facts, negations)
  const shouldLLMExtract = !regexFound || wordCount >= 10;
  if (!shouldLLMExtract) return;

  try {
    const prompt = `Extract personal facts about the speaker from this message. The speaker's name is "${userName}".

Message: "${cleaned}"

Rules:
- Only extract facts the speaker states about THEMSELVES (not about others)
- Rewrite as third-person: "I have a business" → "${userName} has a business"
- Include negations: "I am not a student" → "${userName} is not a student"
- Categories: occupation | preference | identity | location | relationship
- Only extract CLEAR, SPECIFIC facts. Skip vague statements.
- If no facts, return empty array.

Respond with ONLY valid JSON, no explanation:
[{"fact": "...", "category": "..."}]
or
[]`;

    const { data, status } = await axios.post(
      config.llm.endpoint,
      {
        model:       'deepseek/deepseek-chat-v3-0324',  // cheap + fast for structured output
        messages:    [{ role: 'user', content: prompt }],
        temperature: 0.0,
        max_tokens:  200,
      },
      {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.llm.apiKey}`,
          'HTTP-Referer':  'https://chatmasala.fun',
          'X-Title':       'MayaFactExtraction',
        },
        timeout: 8_000,
        validateStatus: () => true,
      }
    );

    if (status !== 200) return;

    const raw = data?.choices?.[0]?.message?.content?.trim() || '[]';
    // Strip markdown fences if model wraps output
    const jsonStr = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let facts;
    try { facts = JSON.parse(jsonStr); } catch { return; }
    if (!Array.isArray(facts) || facts.length === 0) return;

    for (const { fact, category } of facts) {
      if (!fact || typeof fact !== 'string' || fact.length < 5) continue;
      if (!category) continue;
      // Skip if this exact fact was already stored by regex
      const isDupe = regexFound && fact.toLowerCase().includes(userName.toLowerCase());
      await _storeFact(userId, userName, fact.slice(0, 200), category, 0.05, cleaned).catch(() => {});
    }

  } catch (e) {
    // LLM extraction is non-fatal — regex facts already stored above
    console.warn('[facts] LLM extraction error:', e.message);
  }
}

/**
 * Store a single fact in maya_facts with conflict detection.
 * Shared by both regex fast-path and LLM extraction.
 */
async function _storeFact(userId, userName, fact, category, score, sourceMessage) {
  // Check for near-duplicate (same category, similar start)
  const [existing] = await db.execute(
    `SELECT id, fact FROM maya_facts
     WHERE discord_user_id = ? AND category = ?
     ORDER BY created_at DESC LIMIT 8`,
    [userId, category]
  );

  const isDupe = existing.some(r =>
    r.fact.toLowerCase().slice(0, 35) === fact.toLowerCase().slice(0, 35)
  );
  if (isDupe) return;

  // Conflicting fact? (same category, different content = higher conflict score)
  const adjustedScore = existing.length > 0 ? Math.min(score + 0.05, 0.3) : score;

  await db.execute(
    `INSERT INTO maya_facts
       (discord_user_id, fact, category, conflict_score, source_message)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, fact, category, adjustedScore, sourceMessage.slice(0, 500)]
  );
  console.log(`[facts] stored for ${userName}: "${fact}" (${category})`);
}

/**
 * Rewrite a first-person fact string to third-person attribution.
 * "i love pizza"        → "Danish loves pizza"
 * "i'm a developer"     → "Danish is a developer"
 * "i work at Google"    → "Danish works at Google"
 * "my favourite is X"   → "Danish's favourite is X"
 */
function _attributeFact(raw, name) {
  return raw
    .replace(/^i love\b/i,              `${name} loves`)
    .replace(/^i really love\b/i,       `${name} really loves`)
    .replace(/^i adore\b/i,             `${name} adores`)
    .replace(/^i hate\b/i,              `${name} hates`)
    .replace(/^i can't stand\b/i,       `${name} can't stand`)
    .replace(/^i dislike\b/i,           `${name} dislikes`)
    .replace(/^i like\b/i,              `${name} likes`)
    .replace(/^i enjoy\b/i,             `${name} enjoys`)
    .replace(/^i prefer\b/i,            `${name} prefers`)
    .replace(/^i play\b/i,              `${name} plays`)
    .replace(/^i watch\b/i,             `${name} watches`)
    .replace(/^i read\b/i,              `${name} reads`)
    .replace(/^i have\b/i,              `${name} has`)
    .replace(/^i own\b/i,               `${name} owns`)
    .replace(/^i run\b/i,               `${name} runs`)
    .replace(/^i manage\b/i,            `${name} manages`)
    .replace(/^i operate\b/i,           `${name} operates`)
    .replace(/^i(?:'m| am) not (?:a |an )?/i, `${name} is not `)
    .replace(/^i(?:'m| am) (?:a |an )?/i, `${name} is `)
    .replace(/^i work /i,                `${name} works `)
    .replace(/^i studied?\b/i,          `${name} studies`)
    .replace(/^i(?:'m| am) in\b/i,      `${name} is in`)
    .replace(/^i(?:'m| am) at\b/i,      `${name} is at`)
    .replace(/^i(?:'m| am) single\b/i,  `${name} is single`)
    .replace(/^i(?:'m| am) married\b/i, `${name} is married`)
    .replace(/^my business\b/i,         `${name}'s business`)
    .replace(/^my company\b/i,          `${name}'s company`)
    .replace(/^my name is\b/i,          `${name}'s name is`)
    .replace(/^my fav(?:ou?rite)?\b/i,  `${name}'s favourite`)
    .trim();
}

/**
 * Get confirmed/low-conflict facts for a user to inject into LLM context.
 * Only returns facts with conflict_score < 0.4.
 */
export async function getConfirmedFacts(userId, limit = 6) {
  try {
    const [rows] = await db.execute(
      `SELECT id, fact, category, conflict_score, updated_at FROM maya_facts
       WHERE discord_user_id = ? AND conflict_score < 0.4
         AND discord_user_id != 'maya'
       ORDER BY
         -- Recency: facts updated in last 7 days first
         CASE WHEN updated_at > DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 0 ELSE 1 END ASC,
         -- Then by certainty
         conflict_score ASC,
         -- Then most recent
         updated_at DESC
       LIMIT ?`,
      [userId, limit]
    );
    // Track recall — strengthens memory and resets decay timer
    if (rows.length > 0) {
      const ids = rows.map(r => r.id).filter(Boolean);
      db.execute(
        `UPDATE maya_facts SET recall_count=recall_count+1, last_recalled=NOW(),
         memory_strength=LEAST(COALESCE(memory_strength,0.5)+0.1,1.0)
         WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      ).catch(() => {});
    }
    return rows.map(r => r.fact);
  } catch { return []; }
}

/**
 * Get Maya's own self-traits — stored under discord_user_id = 'maya'.
 * These are things Maya has said about herself across conversations.
 */
export async function getMayaSelfTraits(limit = 8) {
  try {
    const [rows] = await db.execute(
      `SELECT fact, category FROM maya_facts
       WHERE discord_user_id = 'maya'
         AND conflict_score < 0.5
         AND LENGTH(fact) >= 15          -- filter out fragments like "Maya is not"
         AND fact REGEXP '[a-z]{3,}'     -- must have real words
       ORDER BY conflict_score ASC, updated_at DESC
       LIMIT ?`,
      [limit]
    );
    return rows.map(r => r.fact);
  } catch { return []; }
}

// ── Maya self-model ──────────────────────────────────────────────────────────

/**
 * Extract traits from Maya's own reply and store under discord_user_id='maya'.
 * When Maya says "I love the rain" or "I find that boring", that's her opinion —
 * it should be consistent across conversations.
 *
 * Stored with discord_user_id='maya' so it's never confused with user facts.
 * Rewritten as "Maya loves the rain" for clarity in the LLM prompt.
 */
export async function extractMayaTrait(replyText) {
  if (!replyText || replyText.startsWith('*reacted')) return;
  // Strict quality gates — only store meaningful self-statements
  if (replyText.length < 20) return;
  if (replyText.split(/\s+/).length < 5) return;   // minimum 5 words
  // Skip pure acknowledgements
  if (/^(ok|okay|yeah|yep|nope|lol|haha|sure|k|hmm|oh|ah|nice|cool|wow)[.!?\s]?$/i.test(replyText.trim())) return;
  // Skip replies that are primarily about what the USER said — not about Maya
  if (/^(that'?s|it'?s|this|you|your|they|he|she)/i.test(replyText.trim())) return;

  for (const { re, cat, score } of FACT_PATTERNS) {
    const m = replyText.match(re);
    if (!m) continue;

    const raw  = m[0].trim();
    const fact = _attributeFact(raw, 'Maya').slice(0, 200);

    // Quality check: the extracted fact must be meaningful (>= 4 words)
    if (fact.split(/\s+/).length < 4) break;

    // Skip objective facts — Maya stating world facts isn't a self-trait
    if (cat === 'objective') break;

    try {
      const [existing] = await db.execute(
        `SELECT id, fact FROM maya_facts
         WHERE discord_user_id = 'maya' AND category = ?
         ORDER BY created_at DESC LIMIT 5`,
        [cat]
      );

      // Don't store if identical or near-identical already exists
      const isDupe = existing.some(r =>
        r.fact.toLowerCase().slice(0, 40) === fact.toLowerCase().slice(0, 40)
      );
      if (isDupe) break;

      await db.execute(
        `INSERT INTO maya_facts
           (discord_user_id, fact, category, conflict_score, source_message)
         VALUES ('maya', ?, ?, ?, ?)`,
        [fact, cat, score, replyText.slice(0, 500)]
      );
      console.log(`[facts] Maya self-trait stored: "${fact}" (${cat})`);
    } catch { /* non-fatal */ }
    break;
  }
}

// ── User↔User observed relations ─────────────────────────────────────────────────

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
