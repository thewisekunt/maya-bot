/**
 * memory.js — Hybrid memory recall
 *
 * Context building strategy:
 *   1. SQL: last 5 messages (always relevant, zero latency)
 *   2. Qdrant: top-k semantically relevant long-term memories
 *      - Only if Qdrant is configured
 *      - Filters by context_type (DM vs server)
 *      - Never leaks private DM memories into server context
 *      - Dream summaries (weight=2.0) surface above raw memories
 *   3. Merge: deduplicate, sort by recency+weight, format as context string
 *
 * Save strategy:
 *   - Always write to MySQL immediately (source of truth)
 *   - Notify dream loop (which handles async embedding)
 */

import db from './db.js';
import { config } from './config.js';
import { embed } from './embedder.js';
import { searchMemories, buildFilter, isConfigured } from './vector.js';
import { notifyNewMessage } from './dream.js';

const RECENT_SQL_LIMIT    = 5;    // always pull these from SQL
const SEMANTIC_LIMIT      = 8;    // top-k from Qdrant
const SCORE_THRESHOLD     = 0.70; // min cosine similarity

// Schema detection cache
let _hasNewCols = null;
async function _hasNewSchema() {
  if (_hasNewCols !== null) return _hasNewCols;
  try {
    const [cols] = await db.execute('SHOW COLUMNS FROM maya_memory');
    _hasNewCols = cols.map(c => c.Field).includes('context_type');
  } catch { _hasNewCols = false; }
  return _hasNewCols;
}

// ── Main recall ───────────────────────────────────────────────────────────────

/**
 * Build the full memory context string for the LLM prompt.
 *
 * @param {string} userId
 * @param {string} prefName
 * @param {'dm'|'server'} contextType
 * @param {string|null} guildId
 * @param {string} currentMessage  — the current user message (used as semantic query)
 *
 * @returns {Promise<string>}
 */
export async function buildContext(userId, prefName, contextType, guildId, currentMessage) {
  // ── Layer 1: Recent SQL messages (always) ──────────────────────────────────
  const recent = await _getRecentSQL(userId, prefName, contextType, guildId);

  // ── Layer 2: Semantic recall from Qdrant (if available) ───────────────────
  let semantic = [];
  if (isConfigured() && currentMessage) {
    try {
      semantic = await _getSemanticMemories(
        userId, prefName, contextType, guildId, currentMessage, recent
      );
    } catch (e) {
      console.warn('[memory] semantic recall failed (non-fatal):', e.message);
    }
  }

  // ── Merge and format ────────────────────────────────────────────────────────
  return _formatContext(recent, semantic, prefName);
}

async function _getRecentSQL(userId, prefName, contextType, guildId) {
  const newSchema = await _hasNewSchema();
  let rows = [];

  try {
    if (newSchema) {
      [rows] = contextType === 'dm'
        ? await db.execute(
            `SELECT sender, message, created_at FROM maya_memory
             WHERE discord_user_id=? AND context_type='dm'
             ORDER BY created_at DESC LIMIT ?`,
            [userId, RECENT_SQL_LIMIT]
          )
        : guildId
          ? await db.execute(
              `SELECT sender, message, created_at FROM maya_memory
               WHERE discord_user_id=? AND context_type='server' AND guild_id=?
               ORDER BY created_at DESC LIMIT ?`,
              [userId, guildId, RECENT_SQL_LIMIT]
            )
          : await db.execute(
              `SELECT sender, message, created_at FROM maya_memory
               WHERE discord_user_id=? AND context_type='server'
               ORDER BY created_at DESC LIMIT ?`,
              [userId, RECENT_SQL_LIMIT]
            );
    } else {
      [rows] = await db.execute(
        `SELECT sender, message, created_at FROM maya_memory
         WHERE discord_user_id=? ORDER BY created_at DESC LIMIT ?`,
        [userId, RECENT_SQL_LIMIT]
      );
    }
  } catch (e) {
    console.error('[memory] SQL recall error:', e.message);
  }

  return rows.reverse().map(r => ({
    sender:  r.sender,
    message: r.message,
    source:  'recent',
    weight:  1.5,   // recent messages are slightly higher weight
    ts:      r.created_at,
  }));
}

async function _getSemanticMemories(userId, prefName, contextType, guildId,
                                     currentMessage, recentRows) {
  // Embed the current message as the query
  const queryVec = await embed(currentMessage);

  const filter = buildFilter({
    userId,
    contextType,
    guildId: contextType === 'server' ? guildId : null,
    isDM:    contextType === 'dm',
  });

  const results = await searchMemories(queryVec, filter, SEMANTIC_LIMIT, SCORE_THRESHOLD);

  // Build set of recent messages to avoid duplicates
  const recentSet = new Set(recentRows.map(r => r.message));

  return results
    .filter(r => !recentSet.has(r.message))  // don't repeat recent SQL rows
    .map(r => ({
      sender:  r.sender,
      message: r.message,
      source:  r.isDream ? 'dream' : 'semantic',
      weight:  r.weight || 1.0,
      score:   r.score,
    }));
}

function _formatContext(recent, semantic, prefName) {
  const parts = [];

  // Semantic / dream memories first (longer-term context)
  if (semantic.length > 0) {
    const dreamSummaries = semantic.filter(s => s.source === 'dream');
    const regularSemantic = semantic.filter(s => s.source === 'semantic');

    if (dreamSummaries.length > 0) {
      parts.push('--- What Maya remembers ---');
      dreamSummaries.forEach(s => parts.push(s.message));
      parts.push('');
    }

    if (regularSemantic.length > 0) {
      parts.push('--- Relevant past context ---');
      regularSemantic.slice(0, 4).forEach(s => {
        const who = s.sender === 'maya' ? 'Maya' : prefName;
        parts.push(`${who}: ${s.message}`);
      });
      parts.push('');
    }
  }

  // Recent messages last (most immediate context)
  if (recent.length > 0) {
    if (semantic.length > 0) parts.push('--- Recent ---');
    recent.forEach(r => {
      const who = r.sender === 'maya' ? 'Maya' : prefName;
      parts.push(`${who}: ${r.message}`);
    });
  }

  return parts.join('\n');
}

// ── Save ──────────────────────────────────────────────────────────────────────

/**
 * Save a message to MySQL and notify the dream loop for async embedding.
 */
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
    console.error('[memory] save error:', e.message);
    throw e;
  }

  // Notify dream loop — may trigger embedding if threshold hit
  notifyNewMessage();
}

// Keep old getContext export for backward compat
export async function getContext(userId, prefName, contextType = 'server', guildId = null) {
  return buildContext(userId, prefName, contextType, guildId, null);
}
