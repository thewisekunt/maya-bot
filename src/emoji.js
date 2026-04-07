/**
 * emoji.js — Server emoji pipeline
 *
 * Observes custom Discord emojis in messages, builds a registry of
 * server emojis with preference weights. This registry is used to
 * inject contextually appropriate emojis into Maya's replies.
 *
 * Two preference axes:
 *   sv_use_weight  — server-level: how common/accepted is this emoji here
 *   maya_affinity  — Maya's personal feeling toward this emoji (built over time)
 *
 * Tone classification (inferred from emoji name + usage context):
 *   funny | hype | sad | love | chaotic | cool | awkward | hype | neutral
 */

import db from './db.js';

// Regex to extract custom Discord emojis: <:name:id> or <a:name:id>
const CUSTOM_EMOJI_RE = /<(a?):([a-zA-Z0-9_]+):(\d+)>/g;

// In-memory cache per guild to avoid per-message DB reads
// Structure: guildId → Map(emojiId → { name, weight, affinity, tone })
const _cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 min
const _cacheTs  = new Map();

// ── Observation pipeline ──────────────────────────────────────────────────────

/**
 * Parse all custom emojis from a message and save/update the registry.
 * Called on every message Maya processes — fire and forget.
 *
 * @param {Message} msg        — Discord message
 * @param {string}  guildId
 * @param {string}  userId     — who sent it
 */
export async function observeEmojis(msg, guildId, userId) {
  if (!msg?.content || !guildId) return;

  const matches = [...msg.content.matchAll(CUSTOM_EMOJI_RE)];
  if (!matches.length) return;

  for (const [, animated, name, id] of matches) {
    try {
      // Infer tone from emoji name heuristics
      const tone = _inferTone(name);

      // Upsert into server registry
      await db.execute(
        `INSERT INTO maya_server_emojis
           (emoji_id, emoji_name, guild_id, animated, tone, sv_seen_count, sv_last_seen)
         VALUES (?, ?, ?, ?, ?, 1, NOW())
         ON DUPLICATE KEY UPDATE
           sv_seen_count = sv_seen_count + 1,
           sv_last_seen  = NOW(),
           tone          = COALESCE(tone, VALUES(tone)),
           sv_use_weight = LEAST(0.95, sv_use_weight + 0.01)`,
        [id, name, guildId, animated === 'a' ? 1 : 0, tone]
      );

      // Track per-user usage
      if (userId) {
        await db.execute(
          `INSERT INTO maya_user_emoji_pref
             (discord_user_id, emoji_id, guild_id, use_count, last_used)
           VALUES (?, ?, ?, 1, NOW())
           ON DUPLICATE KEY UPDATE
             use_count = use_count + 1,
             last_used = NOW()`,
          [userId, id, guildId]
        );
      }

      // Invalidate cache for this guild
      _cacheTs.delete(guildId);

    } catch { /* non-fatal per emoji */ }
  }
}

/**
 * Observe emojis used in reactions too.
 */
export async function observeReactionEmoji(reaction, userId, guildId) {
  if (!reaction.emoji.id) return; // standard emoji, not custom
  const id   = reaction.emoji.id;
  const name = reaction.emoji.name;

  try {
    await db.execute(
      `INSERT INTO maya_server_emojis
         (emoji_id, emoji_name, guild_id, animated, tone, sv_seen_count, sv_last_seen)
       VALUES (?, ?, ?, ?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE
         sv_seen_count = sv_seen_count + 1,
         sv_last_seen  = NOW()`,
      [id, name, guildId, reaction.emoji.animated ? 1 : 0, _inferTone(name)]
    );
    if (userId) {
      await db.execute(
        `INSERT INTO maya_user_emoji_pref
           (discord_user_id, emoji_id, guild_id, reaction_count, last_used)
         VALUES (?, ?, ?, 1, NOW())
         ON DUPLICATE KEY UPDATE
           reaction_count = reaction_count + 1,
           last_used      = NOW()`,
        [userId, id, guildId]
      );
    }
    _cacheTs.delete(guildId);
  } catch { /* non-fatal */ }
}

// ── Retrieval — inject emojis into replies ────────────────────────────────────

/**
 * Get emojis appropriate for Maya to use in a reply.
 * Filtered by tone match, server weight, and Maya's own affinity.
 *
 * @param {string}  guildId
 * @param {string}  tone      — desired tone: funny|hype|sad|love|chaotic|neutral
 * @param {string}  userId    — who she's replying to (for user preference boost)
 * @param {number}  limit
 * @returns {Array<{id, name, animated, formatted}>}
 */
export async function getEmojiForTone(guildId, tone = 'neutral', userId = null, limit = 3) {
  await _refreshCache(guildId);
  const cache = _cache.get(guildId);
  if (!cache) return [];

  // Get user's frequently used emojis for this tone (boost familiar ones)
  let userFaves = new Set();
  if (userId) {
    try {
      const [rows] = await db.execute(
        `SELECT emoji_id FROM maya_user_emoji_pref
         WHERE discord_user_id=? AND guild_id=?
         ORDER BY use_count DESC LIMIT 5`,
        [userId, guildId]
      );
      userFaves = new Set(rows.map(r => r.emoji_id));
    } catch { /* non-fatal */ }
  }

  const candidates = [...cache.values()]
    .filter(e =>
      e.sv_use_weight > 0.3 &&           // used enough in this server
      e.maya_affinity > 0.3 &&           // Maya isn't averse to it
      (tone === 'neutral' || e.tone === tone || e.tone === 'neutral')
    )
    .map(e => ({
      ...e,
      score: e.sv_use_weight * 0.5 +
             e.maya_affinity * 0.3 +
             (userFaves.has(e.emoji_id) ? 0.2 : 0) +  // boost user-familiar emojis
             Math.random() * 0.1,                        // small random variation
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return candidates.map(e => ({
    id:        e.emoji_id,
    name:      e.emoji_name,
    animated:  e.animated,
    formatted: e.animated ? `<a:${e.emoji_name}:${e.emoji_id}>` : `<:${e.emoji_name}:${e.emoji_id}>`,
  }));
}

/**
 * Get a string of emoji suggestions to append to the system prompt.
 * Maya can optionally use these — they're offered, not forced.
 */
/**
 * Get a single emoji for Maya to react with.
 * Tries server emojis first (matching mood/tone), falls back to unicode.
 *
 * @param {string} guildId
 * @param {object} psyche  — emotions + hormones from psyche state
 * @param {string} userId  — who she's reacting to (for preference boost)
 * @returns {string} — either <:name:id> or unicode emoji
 */
export async function getReactEmoji(guildId, psyche, userId = null) {
  if (!guildId) return _unicodeFromPsyche(psyche);

  // Determine target tone from psyche
  const e = psyche?.emotions || {};
  const h = psyche?.hormones || {};
  let tone = 'neutral';
  if ((e.joy        || 0) > 0.5) tone = 'funny';
  else if ((e.affection  || 0) > 0.5) tone = 'love';
  else if ((e.irritation || 0) > 0.5) tone = 'chaotic';
  else if ((h.dopamine   || 0.5) > 0.65) tone = 'hype';

  // Try server emojis first
  const svEmojis = await getEmojiForTone(guildId, tone, userId, 5);
  if (svEmojis.length) {
    // Weighted random pick — higher sv_use_weight = more likely
    const pick = svEmojis[Math.floor(Math.random() * Math.min(3, svEmojis.length))];
    return pick.formatted;
  }

  // Fall back to unicode
  return _unicodeFromPsyche(psyche);
}

function _unicodeFromPsyche(psyche) {
  const e = psyche?.emotions || {};
  const h = psyche?.hormones || {};
  if ((e.joy        || 0) > 0.6) return ['😂','💀','🔥'][Math.floor(Math.random()*3)];
  if ((e.affection  || 0) > 0.6) return ['🫶','❤️','😭'][Math.floor(Math.random()*3)];
  if ((e.irritation || 0) > 0.6) return ['💀','😑','🤦'][Math.floor(Math.random()*3)];
  if ((e.curiosity  || 0) > 0.6) return ['👀','🤔','💭'][Math.floor(Math.random()*3)];
  if ((h.dopamine   || 0.5) > 0.7) return ['🔥','💥','⚡'][Math.floor(Math.random()*3)];
  return ['👀','💀','😌','🫡'][Math.floor(Math.random()*4)];
}

/**
 * Log a reaction Maya received — this is a signal about how her message landed.
 * Classify the signal type from the emoji.
 */
export async function logReactionReceived({ reactorUserId, reactorName, emoji, emojiId, guildId, channelId, messageId, messageContent }) {
  const signal = _classifyReactionSignal(emoji);
  try {
    await db.execute(
      `INSERT INTO maya_reaction_log
         (reactor_user_id, reactor_name, emoji_id, emoji_name, guild_id, channel_id,
          target_message_id, target_content, signal_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reactorUserId, reactorName?.slice(0,100),
        emojiId || null, emoji?.slice(0,100),
        guildId || null, channelId || null,
        messageId || null, messageContent?.slice(0,300),
        signal,
      ]
    );
    // Also update user's emoji preference
    if (emojiId) {
      await db.execute(
        `INSERT INTO maya_user_emoji_pref (discord_user_id, emoji_id, guild_id, reaction_count, last_used)
         VALUES (?, ?, ?, 1, NOW())
         ON DUPLICATE KEY UPDATE reaction_count=reaction_count+1, last_used=NOW()`,
        [reactorUserId, emojiId, guildId || '']
      ).catch(() => {});
    }
    console.log(`[emoji] ${reactorName} reacted ${emoji} → signal=${signal}`);
  } catch { /* non-fatal */ }
}

function _classifyReactionSignal(emoji) {
  const name = (emoji || '').toLowerCase();
  if (/😂|💀|🤣|😭|lmao|skull|dead/.test(name)) return 'funny';
  if (/❤️|🫶|💕|😍|love|heart/.test(name)) return 'approval';
  if (/🔥|💯|⚡|hype|fire|based/.test(name)) return 'hype';
  if (/😒|💀|😑|no|💔|angry|rage/.test(name)) return 'disapproval';
  if (/😢|😔|💙|sad|cry/.test(name)) return 'emotional';
  if (/🤔|👀|think|eyes/.test(name)) return 'curious';
  return 'neutral';
}

/**
 * Update emoji description — called when Maya uses an emoji and it lands well/poorly.
 * Over time Maya builds her own understanding of what each emoji means.
 */
export async function updateEmojiDescription(guildId, emojiId, description) {
  if (!description || !emojiId) return;
  await db.execute(
    `UPDATE maya_server_emojis SET description=? WHERE emoji_id=? AND guild_id=?`,
    [description.slice(0, 200), emojiId, guildId]
  ).catch(() => {});
}

export async function getEmojiHint(guildId, mood, userId) {
  // Map mood/tone states to emoji tone categories
  const toneMap = {
    joyful: 'funny', energized: 'hype', irritated: 'chaotic',
    affectionate: 'love', depleted: 'sad', curious: 'neutral',
  };
  const tone    = toneMap[mood] || 'neutral';
  const emojis  = await getEmojiForTone(guildId, tone, userId, 3);
  if (!emojis.length) return null;
  return `Server emojis you can use if they fit (don't force it): ${emojis.map(e => e.formatted).join(' ')}`;
}

// ── Maya affinity update ──────────────────────────────────────────────────────

/**
 * When Maya uses an emoji and the reply gets a positive reaction,
 * increase her affinity for that emoji.
 * When a reply gets no response, slightly reduce affinity.
 */
export async function updateEmojiAffinity(guildId, emojiId, positive) {
  const delta = positive ? 0.03 : -0.02;
  await db.execute(
    `UPDATE maya_server_emojis
     SET maya_affinity = GREATEST(0.05, LEAST(0.99, maya_affinity + ?))
     WHERE emoji_id=? AND guild_id=?`,
    [delta, emojiId, guildId]
  ).catch(() => {});
  _cacheTs.delete(guildId);
}

// ── Internals ─────────────────────────────────────────────────────────────────

async function _refreshCache(guildId) {
  const ts = _cacheTs.get(guildId) || 0;
  if (Date.now() - ts < CACHE_TTL) return;

  try {
    const [rows] = await db.execute(
      `SELECT emoji_id, emoji_name, animated, tone, description, vibe_tags,
              sv_use_weight, maya_affinity, sv_seen_count
       FROM maya_server_emojis
       WHERE guild_id=? AND sv_use_weight > 0.2
       ORDER BY sv_use_weight DESC LIMIT 100`,
      [guildId]
    );
    const map = new Map();
    for (const r of rows) map.set(r.emoji_id, r);
    _cache.set(guildId, map);
    _cacheTs.set(guildId, Date.now());
  } catch { /* non-fatal */ }
}

function _inferTone(name) {
  const n = name.toLowerCase();
  if (/skull|dead|💀|lmao|cry.*laugh|sob|kms|bruh|pain|dead/.test(n)) return 'funny';
  if (/hype|fire|lit|goat|based|pog|chad|W|win|king|queen|slay/.test(n)) return 'hype';
  if (/sad|sob|cry|hurt|oof|pain|rip|miss|heart_broken/.test(n)) return 'sad';
  if (/love|heart|kiss|blush|uwu|owo|hug|cute|adorable/.test(n)) return 'love';
  if (/chaos|what|tf|wtf|sus|weird|cursed|clown|pensive/.test(n)) return 'chaotic';
  if (/cool|swag|nerd|smart|think|hmm|wave|salute/.test(n)) return 'cool';
  return 'neutral';
}
