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
      parts.push('--- This conversation ---');
      sessionMsgs.forEach(m => {
        const who = m.sender === 'maya' ? 'Maya' : (m.user_name || prefName);
        parts.push(`${who}: ${m.message}`);
      });
      parts.push('');
    }
  }

  // ── Layer 2: SQL recent (fallback / bridge) ───────────────────────────────
  // Only use if no session context (e.g. bot restarted mid-conversation)
  if (parts.length === 0) {
    const recent = await _getRecentSQL(userId, contextType, guildId);
    if (recent.length > 0) {
      recent.forEach(r => {
        const who = r.sender === 'maya' ? 'Maya' : prefName;
        parts.push(`${who}: ${r.message}`);
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

function _typeFilter(userId, memoryType, isDM, guildId) {
  const must = [
    { key: 'memory_type',     match: { value: memoryType } },
    { key: 'discord_user_id', match: { value: userId } },
  ];
  if (isDM) {
    must.push({ key: 'is_private', match: { value: true } });
  } else if (guildId) {
    must.push({ key: 'guild_id', match: { value: guildId } });
  }
  return { must };
}

async function _getRecentSQL(userId, contextType, guildId) {
  const newSchema = await _hasNewSchema();
  try {
    let rows;
    if (newSchema) {
      [rows] = contextType === 'dm'
        ? await db.execute(
            `SELECT sender, message FROM maya_memory
             WHERE discord_user_id=? AND context_type='dm'
             ORDER BY created_at DESC LIMIT ?`, [userId, SQL_LIMIT])
        : guildId
          ? await db.execute(
              `SELECT sender, message FROM maya_memory
               WHERE discord_user_id=? AND context_type='server' AND guild_id=?
               ORDER BY created_at DESC LIMIT ?`, [userId, guildId, SQL_LIMIT])
          : await db.execute(
              `SELECT sender, message FROM maya_memory
               WHERE discord_user_id=? AND context_type='server'
               ORDER BY created_at DESC LIMIT ?`, [userId, SQL_LIMIT]);
    } else {
      [rows] = await db.execute(
        `SELECT sender, message FROM maya_memory
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
