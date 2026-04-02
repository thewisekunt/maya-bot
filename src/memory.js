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
import { embed } from './embedder.js';
import { searchMemories, isConfigured } from './vector.js';
import { notifyNewMessage } from './dream.js';
import { getSessionContext } from './stm.js';

const SQL_LIMIT  = 5;
const VEC_LIMIT  = 5;
const THRESHOLD  = 0.68;

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
        const speakers = new Set(
          sessionMsgs.filter(m => m.sender !== 'maya').map(m => m.user_name).filter(Boolean)
        );
        const speakerList = [...speakers].join(', ');
        parts.push(`--- Group chat. People here: ${speakerList || 'unknown'}. Maya is one of them. ---`);
        parts.push('--- NOT every message is to Maya. [Maya said] marks what Maya already replied. Only reply to the LAST message. ---');
        parts.push('');

        // Show ALL messages with speaker attribution — including Maya's replies
        // Maya's replies labelled clearly so she knows what she already said
        sessionMsgs.forEach(m => {
          const who    = m.sender === 'maya' ? 'Maya' : (m.user_name || '?');
          const isMaya = m.sender === 'maya';
          const ts     = m.created_at ? _relativeTime(new Date(m.created_at)) : '';
          const tsTag  = ts ? ` [${ts}]` : '';
          // Maya's messages marked with [Maya said:] so LLM knows she already replied
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
    let queryVec;
    try { queryVec = await embed(currentMessage); } catch { return parts.join('\n'); }

    const userFilter = _typeFilter(userId, 'user_fact', isDM, guildId);
    const convFilter = _typeFilter(userId, 'conversation', isDM, guildId);
    const selfFilter = { must: [{ key: 'memory_type', match: { value: 'maya_self' } }] };

    const [userFacts, convMems, selfTraitsVec] = await Promise.all([
      searchMemories(queryVec, userFilter, VEC_LIMIT, THRESHOLD).catch(() => []),
      searchMemories(queryVec, convFilter, 3,         THRESHOLD).catch(() => []),
      searchMemories(queryVec, selfFilter, 3,         THRESHOLD).catch(() => []),
    ]);

    if (userFacts.length > 0) {
      parts.push(`--- What Maya knows about ${prefName} ---`);
      userFacts.forEach(f => parts.push(`• ${f.payload?.fact_text || f.message}`));
      parts.push('');
    }

    if (selfTraitsVec.length > 0) {
      parts.push('--- Maya\'s own traits (be consistent) ---');
      selfTraitsVec.forEach(t => parts.push(`• ${t.payload?.fact_text || t.message}`));
      parts.push('');
    }

    if (convMems.length > 0) {
      parts.push('--- Past relevant context ---');
      convMems.forEach(c => parts.push(c.message));
      parts.push('');
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
  // For DMs: don't filter by is_private — allow recall of server memories too
  // so Maya remembers what was said in the server when talking in DMs.
  // Private (DM) messages are always stored with is_private=true but we
  // can show server memories in DMs — they're not sensitive.
  const must = [
    { key: 'memory_type',     match: { value: memoryType } },
    { key: 'discord_user_id', match: { value: userId } },
  ];
  if (!isDM && guildId) {
    must.push({ key: 'guild_id', match: { value: guildId } });
  }
  return { must };
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
