/**
 * memory.js — Hybrid recall with memory_type namespacing
 *
 * Context layers (in order of injection into LLM prompt):
 *
 *   1. user_fact   — what Maya knows about THIS user (highest priority)
 *   2. maya_self   — Maya's own consistent traits
 *   3. conversation — relevant past conversation snippets
 *   4. STM session  — current session buffer (from stm.js)
 *   5. SQL recent   — last 5 messages (always, zero latency)
 *
 * Types NEVER mixed in a single query — each Qdrant search
 * filters by memory_type so facts don't bleed into conversation
 * memories and vice versa.
 */

import db from './db.js';
import { p as param } from './params.js';
import { embed } from './embedder.js';
import { searchMemories, isConfigured } from './vector.js';
import { notifyNewMessage } from './dream.js';
import { getSessionContext } from './stm.js';

const SQL_LIMIT  = 5;
const VEC_LIMIT  = 6;  // user facts
// Thresholds per search type — raised from 0.30 which was catching noise
// Cosine similarity on text-embedding-3-small:
//   0.30–0.45: weak match (same topic area)
//   0.45–0.60: moderate (semantically related)
//   0.60–0.80: strong (same idea, different words)
//   0.80+:     near-identical
// Base thresholds — overridden by Maya's learned params at query time
const THRESHOLD_FACT        = 0.52;
const THRESHOLD_SELF        = 0.45;
// THRESHOLD_CONV and THRESHOLD_CONV_GUILD are loaded from params.js per-call

// Schema cache
let _newSchema = null;
async function _hasNewSchema() {
  if (_newSchema !== null) return _newSchema;
  try {
    const [cols] = await db.execute('SHOW COLUMNS FROM maya_memory');
    _newSchema = cols.map(c => c.Field).includes('context_type');
  } catch { _newSchema = false; }
  return _newSchema;
}

// ── Main context builder ──────────────────────────────────────────────────────

/**
 * Build the full context string for the LLM.
 * Each memory type is queried separately and labelled distinctly.
 */
export async function buildContext(userId, prefName, contextType, guildId, currentMessage, channelId) {
  const isDM = contextType === 'dm';
  const parts = [];

  // ── Layer 1: Session STM (current conversation) ───────────────────────────
  if (channelId) {
    const sessionMsgs = await getSessionContext(channelId, 12).catch(() => []);
    if (sessionMsgs.length > 0) {
      if (contextType === 'dm') {
        parts.push('--- Private DM (only this conversation) ---');
        // DM STM only has DM messages — server convo shown separately below from SQL
        sessionMsgs.forEach(m => {
          const who   = m.sender === 'maya' ? 'Maya' : (m.user_name || prefName);
          const ts    = m.created_at ? _relativeTime(new Date(m.created_at)) : '';
          const tsTag = ts ? ` [${ts}]` : '';
          const label = m.sender === 'maya' ? '[Maya replied]' : who;
          parts.push(`${label}${tsTag}: ${m.message}`);
        });
        // Also pull recent server messages for this user so Maya has both contexts
        try {
          const [srvRows] = await db.execute(
            `SELECT sender, user_name, message, created_at FROM maya_memory
             WHERE discord_user_id=? AND context_type='server'
             ORDER BY created_at DESC LIMIT 6`,
            [userId]
          );
          if (srvRows.length > 0) {
            parts.push('');
            parts.push(`--- What ${prefName} said recently in the server ---`);
            srvRows.reverse().forEach(r => {
              const who   = r.sender === 'maya' ? '[Maya replied]' : (r.user_name || prefName);
              const ts    = r.created_at ? _relativeTime(new Date(r.created_at)) : '';
              const tsTag = ts ? ` [${ts}]` : '';
              parts.push(`${who}${tsTag}: ${r.message}`);
            });
          }
        } catch { /* non-fatal */ }
      } else {
        // Group chat — show speakers clearly, track unique speakers
        // Build speaker list — will be updated after collision detection below
        const _speakerRaw = sessionMsgs.filter(m => m.sender !== 'maya');
        // Generate disambiguated speaker list
        const _speakerNames = new Set();
        const _snCount = {};
        _speakerRaw.forEach(r => {
          if (r.user_name) {
            _snCount[r.user_name] = (_snCount[r.user_name] || new Set());
            _snCount[r.user_name].add(r.discord_user_id || '?');
          }
        });
        _speakerRaw.forEach(r => {
          if (!r.user_name) return;
          if (_snCount[r.user_name].size > 1) {
            const uid = r.discord_user_id || '';
            _speakerNames.add(`${r.user_name}#${uid.slice(-4)}`);
          } else {
            _speakerNames.add(r.user_name);
          }
        });
        const speakerList = [..._speakerNames].join(', ');
        parts.push(`--- Group chat. People here: ${speakerList || 'unknown'}. Maya is one of them. ---`);
        parts.push('--- NOT every message is to Maya. [Maya said] marks what Maya already replied. Only reply to the LAST message. ---');
        parts.push('');

        // Show ALL messages with speaker attribution — including Maya's replies
        // Maya's replies labelled clearly so she knows what she already said
        // Build a name→userId collision map so we can disambiguate same-name users
        // If two users share a display name, tag both with a short ID suffix
        const nameCount = {};
        sessionMsgs.forEach(sm => {
          if (sm.sender !== 'maya' && sm.user_name) {
            nameCount[sm.user_name] = (nameCount[sm.user_name] || new Set());
            nameCount[sm.user_name].add(sm.discord_user_id || sm.user_id || '?');
          }
        });
        // Names used by more than one userId → ambiguous, need disambiguation
        const ambiguousNames = new Set(
          Object.entries(nameCount)
            .filter(([, ids]) => ids.size > 1)
            .map(([name]) => name)
        );

        sessionMsgs.forEach(m => {
          const isMaya = m.sender === 'maya';
          const ts     = m.created_at ? _relativeTime(new Date(m.created_at)) : '';
          const tsTag  = ts ? ` [${ts}]` : '';
          let who;
          if (isMaya) {
            who = 'Maya';
          } else {
            const rawName = m.user_name || '?';
            // If this name is used by multiple user IDs, append a short disambiguator
            if (ambiguousNames.has(rawName) && (m.discord_user_id || m.user_id)) {
              const uid = m.discord_user_id || m.user_id || '';
              who = `${rawName}#${uid.slice(-4)}`;  // last 4 chars of discord ID
            } else {
              who = rawName;
            }
          }
          const prefix = isMaya ? `  [Maya said]${tsTag}:` : `  ${who}${tsTag}:`;
          parts.push(`${prefix} ${m.message}`);
        });
        parts.push('');
        parts.push(`--- ${prefName} is now talking to Maya ---`);
      }
      parts.push('');
    }
  }

  // ── Layer 2: SQL recent (fallback / bridge) ───────────────────────────────
  // Only use if no session context (e.g. bot restarted mid-conversation)
  // Fetches channel-wide messages (all speakers) so Maya sees full conversation
  if (parts.length === 0) {
    const recent = await _getRecentSQL(userId, contextType, guildId, channelId);
    if (recent.length > 0) {
      if (contextType !== 'dm') {
        const sqlSpeakers = new Set(recent.filter(r => r.sender !== 'maya').map(r => r.user_name).filter(Boolean));
        parts.push(`--- Recent channel conversation (${[...sqlSpeakers].join(', ') || 'others'}) ---`);
      }
      recent.forEach(r => {
        const ts    = r.created_at ? _relativeTime(new Date(r.created_at)) : '';
        const tsTag = ts ? ` [${ts}]` : '';
        if (r.sender === 'maya') {
          parts.push(`[Maya already replied]${tsTag}: ${r.message}`);
        } else {
          const who = r.user_name || prefName;
          parts.push(`${who}${tsTag}: ${r.message}`);
        }
      });
      parts.push('');
    }
  }

  // ── Semantic layers (only if Qdrant configured and have a query) ──────────
  if (isConfigured() && currentMessage) {
    console.log(`[memory] vector search — userId=${userId} guildId=${guildId} isDM=${isDM} query="${currentMessage?.slice(0,40)}"`);
    let queryVec;
    try {
      queryVec = await embed(currentMessage);
    } catch (e) {
      console.error('[memory] embed failed, skipping vector recall:', e.message);
      return parts.join('\n');
    }

    // Use FLAT filters only — no nested should inside must
    // Qdrant version compatibility: nested should inside must is unreliable
    // Strategy: run separate searches for each type, merge results in JS

    // Search 1: Embedded user_facts (immediately embedded when stored)
    // These are LLM-extracted, confidence-scored facts — highest quality signal
    const userFactFilter = { must: [
      { key: 'memory_type',     match: { value: 'user_fact' } },
      { key: 'discord_user_id', match: { value: String(userId) } },
    ]};

    // Search 2: Raw user messages — semantic recall of what they've said
    // Exclude sender='maya' — her own messages aren't facts ABOUT the user
    const userMust = [
      { key: 'memory_type', match: { value: 'raw_message' } },
      { key: 'discord_user_id', match: { value: String(userId) } },
      { key: 'sender', match: { value: 'user' } },
    ];
    if (guildId) userMust.push({ key: 'guild_id', match: { value: String(guildId) } });
    const userRawFilter = { must: userMust };

    // Conversation: all guild messages for semantic recall
    // If no guildId (shouldn't happen in server but guard anyway), fall back to user-scoped
    let activeConvFilter;
    if (isDM) {
      activeConvFilter = { must: [
        { key: 'memory_type',     match: { value: 'raw_message' } },
        { key: 'discord_user_id', match: { value: String(userId) } },
        { key: 'sender', match: { value: 'user' } },
      ]};
    } else if (guildId) {
      activeConvFilter = { must: [
        { key: 'memory_type', match: { value: 'raw_message' } },
        { key: 'guild_id',    match: { value: String(guildId) } },
      ]};
    } else {
      // No guild — search all raw messages for this user
      activeConvFilter = { must: [
        { key: 'memory_type',     match: { value: 'raw_message' } },
        { key: 'discord_user_id', match: { value: String(userId) } },
      ]};
    }

    const selfFilter = { must: [
      { key: 'memory_type', match: { value: 'maya_self' } },
    ]};

    // Same-session salient moments get priority — high-intensity exchanges from THIS conversation
    const salientFilter = { must: [
      { key: 'memory_type',     match: { value: 'salient_moment' } },
      { key: 'discord_user_id', match: { value: String(userId) } },
    ]};

    // Load Maya's learned memory thresholds
    const [_convT, _guildT] = await Promise.all([
      param('memory_conv_threshold').catch(() => 0.45),
      param('memory_guild_threshold').catch(() => 0.62),
    ]);
    const THRESHOLD_CONV       = _convT  ?? 0.45;
    const THRESHOLD_CONV_GUILD = _guildT ?? 0.62;

    const [embeddedFacts, rawMessages, convMems, selfTraitsVec, guildConvMems, salientMems] = await Promise.all([
      // Embedded user_facts — highest priority, strong threshold
      searchMemories(queryVec, userFactFilter, 6, THRESHOLD_FACT)
        .catch(e => { console.error('[memory] user_fact search:', e.message); return []; }),
      // Raw user messages — moderate threshold
      searchMemories(queryVec, userRawFilter, VEC_LIMIT, THRESHOLD_CONV)
        .catch(e => { console.error('[memory] raw search:', e.message); return []; }),
      // Conversation context — userId-scoped first (threshold), guild wide at stricter threshold
      // Two separate searches merged: ensures current user's memories dominate
      searchMemories(queryVec, userRawFilter, 3, THRESHOLD_CONV)
        .catch(e => { console.error('[memory] conv-user search:', e.message); return []; }),
      // Maya self-traits
      searchMemories(queryVec, selfFilter, 3, THRESHOLD_SELF)
        .catch(e => { console.error('[memory] self search:', e.message); return []; }),
      // Guild-wide conv — stricter threshold to prevent cross-user bleed
      guildId ? searchMemories(queryVec, { must: [
          { key: 'memory_type', match: { value: 'raw_message' } },
          { key: 'guild_id',    match: { value: String(guildId) } },
        ]}, 3, THRESHOLD_CONV_GUILD).catch(() => []) : Promise.resolve([]),
      // Salient moments — high-intensity past exchanges, always surface first
      searchMemories(queryVec, salientFilter, 3, 0.35)
        .catch(() => []),
    ]);

    // Merge user signals — embedded facts first (higher quality), then raw messages
    const embeddedIds  = new Set(embeddedFacts.map(f => f.payload?.mysql_id).filter(Boolean));
    const embeddedMsgs = new Set(embeddedFacts.map(f => f.payload?.message?.slice(0,40)).filter(Boolean));
    // Dedupe raw messages against embedded facts
    const uniqueRaw = rawMessages.filter(r =>
      !embeddedIds.has(r.payload?.mysql_id) &&
      !embeddedMsgs.has(r.payload?.message?.slice(0,40))
    );
    const userFacts = [...embeddedFacts, ...uniqueRaw.slice(0, 3)];

    // Deduplicate conv — user-scoped first, then guild-wide (with cross-user label)
    const userMsgSet  = new Set(userFacts.map(f => f.payload?.mysql_id));
    const rawConvSet  = new Set(convMems.map(f => f.payload?.mysql_id));
    // Tag guild-wide results with the actual speaker name so LLM knows whose memory
    const labelledGuild = (guildConvMems || [])
      .filter(r => !userMsgSet.has(r.payload?.mysql_id) && !rawConvSet.has(r.payload?.mysql_id))
      .map(r => ({ ...r, _crossUser: true }));
    const dedupedConv = [
      ...convMems.filter(r => !userMsgSet.has(r.payload?.mysql_id)),
      ...labelledGuild.slice(0, 2),   // at most 2 cross-user results
    ];

    console.log(`[memory] vector recall: facts=${embeddedFacts.length} raw=${uniqueRaw.length} conv=${dedupedConv.length} self=${selfTraitsVec.length} thresholds=fact:${THRESHOLD_FACT}/conv:${THRESHOLD_CONV}`);

    const convMemsFinal = dedupedConv;

    if (userFacts.length > 0) {
      const cleanFacts = userFacts.filter(f => {
        const text     = f.payload?.fact_text || f.message || '';
        const conflict = f.payload?.conflict_score ?? 0.5;
        // Skip: Maya's own speech misattributed, social deflections, high-conflict facts
        if (f.payload?.sender === 'maya')              return false;
        if (/^maya:/i.test(text))                      return false;
        if (/sorry.*have|have a (bf|gf|boyfriend|girlfriend)/i.test(text)) return false;
        if (conflict > 0.8)                            return false;
        return true;
      });
      if (cleanFacts.length > 0) {
        parts.push(`--- What Maya knows about ${prefName} (from memory) ---`);
        cleanFacts.forEach(f => {
          const text = f.payload?.fact_text || f.message;
          if (text) parts.push(`• ${text}`);
        });
        parts.push('');
      }
    }

    if (selfTraitsVec.length > 0) {
      parts.push('--- Maya\'s own traits (be consistent) ---');
      selfTraitsVec.forEach(t => parts.push(`• ${t.payload?.fact_text || t.message}`));
      parts.push('');
    }

    // Surface salient moments first — these are high-intensity exchanges Maya shouldn't forget
    if (salientMems && salientMems.length > 0) {
      parts.push('--- High-importance past moments (remember these) ---');
      salientMems.forEach(mem => {
        const ts = mem.payload?.created_at
          ? _relativeTime(new Date(mem.payload.created_at)) : '';
        const tsTag = ts ? ` [${ts}]` : '';
        parts.push(`• ${(mem.message || '').slice(0, 200)}${tsTag}`);
      });
      parts.push('');

      // Increment retrieved_count for the outcome feedback loop (fire and forget)
      const qdrantIds = salientMems
        .map(m => m.payload?.qdrant_id || m.id)
        .filter(Boolean);
      if (qdrantIds.length) {
        db.execute(
          `UPDATE maya_salience_log SET retrieved_count = retrieved_count + 1
           WHERE qdrant_id IN (${qdrantIds.map(() => '?').join(',')})`,
          qdrantIds
        ).catch(() => {});
      }
    }

    if (convMemsFinal.length > 0) {
      parts.push('--- Semantically relevant past context ---');
      convMemsFinal.forEach(mem => {
        const ts = mem.payload?.created_at
          ? _relativeTime(new Date(mem.payload.created_at))
          : '';
        const tsTag = ts ? ` [${ts}]` : '';
        // Raw messages may or may not include speaker prefix
        // Dream summaries are standalone sentences
        const isDreamOrSummary = mem.payload?.memory_type === 'conversation';
        if (isDreamOrSummary) {
          parts.push(`• ${mem.message}${tsTag}`);
        } else {
          const sender   = mem.payload?.sender;
          const userName = mem.payload?.user_name || mem.payload?.user_id;
          let msgText    = mem.message || '';
          const alreadyAttributed = /^[A-Za-zऀ-ॿ].{0,30}:/.test(msgText);
          if (!alreadyAttributed && sender) {
            const speakerLabel = sender === 'maya' ? 'Maya' : (userName || 'them');
            msgText = `${speakerLabel}: ${msgText}`;
          }
          // Cross-user results get a clear attribution prefix so Maya doesn't confuse speakers
          const crossNote = mem._crossUser ? ' [other user]' : '';
          parts.push(`  ${msgText}${tsTag}${crossNote}  (score: ${mem.score.toFixed(2)})`);
        }
      });
      parts.push('');
    }
  }

  // ── Bot activity context ───────────────────────────────────────────────────
  // Append recent bot events from the channel — gives Maya awareness of what's
  // been happening (OwO battles, economy transactions, etc.) without LLM calls
  if (channelId) {
    const botCtx = getBotContext(channelId);
    if (botCtx) {
      parts.push('');
      parts.push(botCtx);
    }
  }

  return parts.join('\n').trim();
}

// ── Save ──────────────────────────────────────────────────────────────────────

export async function saveMessage({
  userId, prefName, guildId, channelId,
  contextType = 'server', isPrivate = false,
  sender, message, entropy,
}) {
  const newSchema = await _hasNewSchema();
  try {
    if (newSchema) {
      await db.execute(
        `INSERT INTO maya_memory
           (discord_user_id, user_name, guild_id, channel_id,
            context_type, is_private, sender, message, entropy, embedded)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [userId, prefName, guildId||null, channelId||null,
         contextType, isPrivate?1:0, sender, message, entropy]
      );
    } else {
      await db.execute(
        `INSERT INTO maya_memory
           (discord_user_id, user_name, guild_id, sender, message, entropy)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, prefName, guildId||null, sender, message, entropy]
      );
    }
  } catch (e) {
    console.error('[memory] save:', e.message);
    throw e;
  }
  notifyNewMessage();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _relativeTime(date) {
  if (!date || isNaN(date)) return '';
  const mins = Math.round((Date.now() - date) / 60_000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function _typeFilter(userId, memoryType, isDM, guildId) {
  // All 7988 points use memory_type='raw_message'.
  // Dream summaries use 'conversation' or 'user_fact' (far fewer).
  // We always include raw_message in the search.

  if (memoryType === 'user_fact') {
    // User facts: must be about this specific user
    // Include both processed facts AND raw messages from this user
    const must = [
      { should: [
          { key: 'memory_type', match: { value: 'user_fact' } },
          { key: 'memory_type', match: { value: 'raw_message' } },
      ]},
      { should: [
          { key: 'discord_user_id', match: { value: userId } },
          { key: 'discord_user_id', match: { value: 'maya' } },
      ]},
    ];
    if (!isDM && guildId) {
      must.push({ key: 'guild_id', match: { value: guildId } });
    }
    return { must };
  }

  if (memoryType === 'conversation') {
    // Conversational recall: all messages in this guild (not user-specific)
    // This is what gives semantic depth — any message from any user
    const must = [
      { should: [
          { key: 'memory_type', match: { value: 'conversation' } },
          { key: 'memory_type', match: { value: 'raw_message' } },
      ]},
    ];
    if (!isDM && guildId) {
      // Server: scope to guild so we don't leak other servers
      must.push({ key: 'guild_id', match: { value: guildId } });
    } else if (isDM) {
      // DM: scope to messages involving this user (their msgs + Maya's replies to them)
      must.push({ should: [
        { key: 'discord_user_id', match: { value: userId } },
        { key: 'discord_user_id', match: { value: 'maya' } },
      ]});
    }
    return { must };
  }

  // maya_self or other: simple type filter
  return { must: [{ key: 'memory_type', match: { value: memoryType } }] };
}

async function _getRecentSQL(userId, contextType, guildId, channelId = null) {
  const newSchema = await _hasNewSchema();
  try {
    let rows;
    if (newSchema) {
      if (contextType === 'dm') {
        // DMs: fetch DM history only (server history shown separately below)
        [rows] = await db.execute(
          `SELECT sender, user_name, message, context_type, created_at FROM maya_memory
           WHERE discord_user_id=? AND context_type='dm'
           ORDER BY created_at DESC LIMIT ?`,
          [userId, SQL_LIMIT]
        );
      } else if (channelId) {
        // Server with channelId: fetch ALL recent messages in this channel
        // regardless of who sent them — gives full conversation picture
        [rows] = await db.execute(
          `SELECT sender, user_name, message, context_type, created_at FROM maya_memory
           WHERE channel_id=?
           ORDER BY created_at DESC LIMIT ?`,
          [channelId, SQL_LIMIT * 2]
        );
      } else if (guildId) {
        [rows] = await db.execute(
          `SELECT sender, user_name, message, context_type, created_at FROM maya_memory
           WHERE discord_user_id=? AND context_type='server' AND guild_id=?
           ORDER BY created_at DESC LIMIT ?`,
          [userId, guildId, SQL_LIMIT]);
      } else {
        [rows] = await db.execute(
          `SELECT sender, user_name, message, context_type, created_at FROM maya_memory
           WHERE discord_user_id=? AND context_type='server'
           ORDER BY created_at DESC LIMIT ?`,
          [userId, SQL_LIMIT]);
      }
    } else {
      [rows] = await db.execute(
        `SELECT sender, user_name, message, created_at FROM maya_memory
         WHERE discord_user_id=? ORDER BY created_at DESC LIMIT ?`,
        [userId, SQL_LIMIT]);
    }
    return rows.reverse();
  } catch { return []; }
}

// Backward compat
export async function getContext(userId, prefName, contextType = 'server', guildId = null) {
  return buildContext(userId, prefName, contextType, guildId, null, null);
}
