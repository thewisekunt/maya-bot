/**
 * stm.js — Short Term Memory (Session Management)
 *
 * Sessions are mention-based:
 *   - Opens when Maya is @mentioned in a channel
 *   - Stays alive while messages keep coming (30 min inactivity = close)
 *   - All messages during a session are buffered in maya_session_messages
 *   - On close → dream.js processes the session into LTM
 *
 * In-memory state per channel (fast, no DB for hot path):
 *   { sessionId, lastActivity, participantIds, messageCount }
 *
 * Multi-instance: session open/close uses DB as source of truth.
 * The distributed lock prevents both instances from processing the same session.
 */

import db from './db.js';

const SESSION_IDLE_MS = parseInt(process.env.SESSION_IDLE_MINUTES || '30') * 60 * 1000;

// In-memory session cache: channelId → { sessionId, lastActivity, participants: Set }
const _sessions = new Map();

// Idle checker — runs every 5 minutes
let _idleTimer = null;

export function startSTM() {
  _idleTimer = setInterval(_checkIdleSessions, 5 * 60 * 1000);
  console.log(`[stm] session manager started (idle=${SESSION_IDLE_MS/60000}min)`);
}

// ── Open / touch session ──────────────────────────────────────────────────────

/**
 * Called when Maya is @mentioned. Opens a new session or resets the idle timer
 * on an existing one. Returns the sessionId.
 */
export async function openSession(channelId, guildId, triggeredByUserId) {
  const existing = _sessions.get(channelId);

  if (existing) {
    // Reset idle timer — mention refreshes the session
    existing.lastActivity = Date.now();
    await db.execute(
      `UPDATE maya_sessions SET last_activity=NOW(), message_count=message_count+1
       WHERE id=?`, [existing.sessionId]
    ).catch(() => {});
    console.log(`[stm] session refreshed for channel ${channelId} (id=${existing.sessionId})`);
    return existing.sessionId;
  }

  // Open new session in DB
  const [res] = await db.execute(
    `INSERT INTO maya_sessions
       (channel_id, guild_id, triggered_by, participant_ids, message_count)
     VALUES (?, ?, ?, ?, 1)`,
    [channelId, guildId || null, triggeredByUserId, JSON.stringify([triggeredByUserId])]
  );
  const sessionId = res.insertId;

  _sessions.set(channelId, {
    sessionId,
    lastActivity:  Date.now(),
    participants:  new Set([triggeredByUserId]),
    topicHistory:  [],    // [{topic, startedAt, messageCount}]
    currentTopic:  null,
  });

  console.log(`[stm] session opened for channel ${channelId} (id=${sessionId})`);
  return sessionId;
}

/**
 * Record a message into the active session buffer.
 * Called for every message in an active session — not just mentions.
 */
export async function recordSessionMessage(channelId, {
  userId, userName, sender, message,
}) {
  const sess = _sessions.get(channelId);
  if (!sess) return;   // no active session for this channel

  sess.lastActivity = Date.now();
  if (sender === 'user') sess.participants.add(userId);

  // Fire and forget — don't block the reply on DB write
  // Use separate calls to prevent ECONNRESET from killing both operations
  (async () => {
    try {
      await db.execute(
        `INSERT INTO maya_session_messages
           (session_id, discord_user_id, user_name, sender, message)
         VALUES (?, ?, ?, ?, ?)`,
        [sess.sessionId, userId, userName, sender, message]
      );
    } catch (e) { console.error('[stm] record error:', e.message); return; }
    try {
      await db.execute(
        `UPDATE maya_sessions
         SET last_activity=NOW(),
             message_count=message_count+1,
             participant_ids=?
         WHERE id=?`,
        [JSON.stringify([...sess.participants]), sess.sessionId]
      );
    } catch { /* non-fatal — activity update can fail silently */ }
  })();
}

/**
 * Get the active session ID for a channel, or null if none.
 */
export function getActiveSession(channelId) {
  const sess = _sessions.get(channelId);
  if (!sess) return null;
  // Check if it's gone idle
  if (Date.now() - sess.lastActivity > SESSION_IDLE_MS) {
    _closeSession(channelId);
    return null;
  }
  return sess.sessionId;
}

/**
 * Fetch session messages for building STM context (for LLM prompt).
 * Returns last N exchanges from the current session.
 */
export async function getSessionContext(channelId, limit = 15) {
  const sess = _sessions.get(channelId);
  if (!sess) return [];

  try {
    // Fetch ALL recent messages in channel order — all speakers, not just current user.
    // This is critical: Maya needs to see the full group conversation to know
    // who is talking to whom. Without this she misattributes messages.
    // Maya's own replies always included (they're part of the thread she's in).
    const safeLimit = Math.min(limit, 30);  // expanded for full group context
    const [rows] = await db.execute(
      `SELECT discord_user_id, user_name, sender, message, created_at
       FROM maya_session_messages
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [sess.sessionId, safeLimit]
    );
    // Return in chronological order (oldest first)
    return rows.reverse();
  } catch { return []; }
}

// ── Idle session closer ───────────────────────────────────────────────────────

async function _checkIdleSessions() {
  const now = Date.now();
  for (const [channelId, sess] of _sessions.entries()) {
    if (now - sess.lastActivity > SESSION_IDLE_MS) {
      console.log(`[stm] session idle timeout for channel ${channelId}`);
      await _closeSession(channelId);
    }
  }
}

async function _closeSession(channelId) {
  const sess = _sessions.get(channelId);
  if (!sess) return;

  _sessions.delete(channelId);

  try {
    await db.execute(
      `UPDATE maya_sessions SET ended_at=NOW() WHERE id=? AND ended_at IS NULL`,
      [sess.sessionId]
    );
    console.log(`[stm] session closed (id=${sess.sessionId})`);

    // Trigger dream processing for this session (queued — returns void)
    const { processSession } = await import('./dream.js');
    try { processSession(sess.sessionId); } catch (e) {
      console.error('[stm] dream processSession error:', e.message);
    }
  } catch (e) {
    console.error('[stm] close error:', e.message);
  }
}

/**
 * Update the current topic for a session.
 * Called from handler when inner_voice detects a topic shift.
 * @param {string} channelId
 * @param {string} topic — short label like "gaming", "relationships", "bullying"
 */
export function updateSessionTopic(channelId, topic) {
  const sess = _sessions.get(channelId);
  if (!sess) return;
  // Only update if topic actually changed
  if (sess.currentTopic === topic) {
    // Increment message count for current topic
    if (sess.topicHistory.length > 0) {
      sess.topicHistory[sess.topicHistory.length - 1].messageCount++;
    }
    return;
  }
  // New topic — push to history
  sess.topicHistory.push({
    topic,
    startedAt:    Date.now(),
    messageCount: 1,
  });
  // Keep last 10 topics
  if (sess.topicHistory.length > 10) sess.topicHistory.shift();
  sess.currentTopic = topic;
}

/**
 * Get the episodic topic log for a session — what topics were discussed.
 * Returns ordered list from oldest to newest.
 */
export function getTopicHistory(channelId) {
  const sess = _sessions.get(channelId);
  if (!sess) return [];
  return sess.topicHistory || [];
}

/**
 * Get the previous topic before the current one.
 * Used by inner_voice to answer "what were we talking about before this?"
 */
export function getPreviousTopic(channelId) {
  const sess = _sessions.get(channelId);
  if (!sess || !sess.topicHistory || sess.topicHistory.length < 2) return null;
  return sess.topicHistory[sess.topicHistory.length - 2];
}

/**
 * Get list of participants in current session (for social context).
 */
export function getSessionParticipants(channelId) {
  const sess = _sessions.get(channelId);
  return sess ? [...sess.participants] : [];
}
