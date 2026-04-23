/**
 * signals.js — Behavioral signal store
 *
 * Signals are short-lived behavioral flags that the LLM layer attaches
 * to replies when it detects something the earlier pipeline missed.
 *
 * The problem they solve:
 *   NLP misclassifies "leave me alone" → LLM replies correctly → words vanish
 *   Signal system turns Maya's own reply into a behavioral state that persists.
 *
 * Signal types:
 *   disengage   — user wants Maya to stop/reduce engagement (soft)
 *   go_offline  — user explicitly asked Maya to go invisible
 *   cooling_off — user seemed frustrated; give space without full silence
 *   re_engage   — user cleared the signal / came back
 *
 * Storage: in-memory Map (fast, per-process) + MySQL for cross-restart persistence
 * Key: `${userId}:${channelId}`
 *
 * Lifecycle:
 *   attachSignal()  — LLM reply triggers this after detecting disengagement text
 *   getSignals()    — handler reads this BEFORE processing any message
 *   clearSignal()   — user pings Maya or sends positive message → cleared
 *   decaySignals()  — called on each message; removes expired signals
 */

import db from './db.js';

// ── In-memory store ───────────────────────────────────────────────────────────
// key: `${userId}:${channelId}`
// value: Map<signalType, { type, expiresAt, strength, source, attachedAt }>
const _store = new Map();

// Signal durations (ms)
const SIGNAL_DURATIONS = {
  go_offline:  30 * 60 * 1000,   // 30 min — explicit offline request
  disengage:   20 * 60 * 1000,   // 20 min — leave me alone
  cooling_off: 10 * 60 * 1000,   // 10 min — mild frustration, give space
};

// Strength thresholds — below this, signal is treated as expired
const MIN_STRENGTH = 0.15;

function _key(userId, channelId) { return `${userId}:${channelId}`; }

function _getMap(userId, channelId) {
  const k = _key(userId, channelId);
  if (!_store.has(k)) _store.set(k, new Map());
  return _store.get(k);
}

// ── Attach ────────────────────────────────────────────────────────────────────

/**
 * Attach a signal to a user:channel pair.
 * Called from index.js after getMayaReply returns an attachedSignal.
 *
 * @param {string} userId
 * @param {string} channelId
 * @param {string} type        — 'disengage'|'go_offline'|'cooling_off'
 * @param {object} opts
 *   source   {string}  — 'llm_reply'|'nlp_intent'|'user_state'
 *   strength {number}  — 0–1, how strong the signal is (default 0.8)
 *   duration {number}  — override default duration (ms)
 */
export function attachSignal(userId, channelId, type, opts = {}) {
  const signals = _getMap(userId, channelId);
  const duration = opts.duration || SIGNAL_DURATIONS[type] || 15 * 60 * 1000;
  const strength = opts.strength ?? 0.8;

  const signal = {
    type,
    expiresAt:  Date.now() + duration,
    strength,
    source:     opts.source || 'unknown',
    attachedAt: Date.now(),
  };

  signals.set(type, signal);
  console.log(`[signal] attached ${type} for ${userId} | strength=${strength} duration=${Math.round(duration/60000)}min source=${signal.source}`);

  // Persist to DB (non-blocking)
  _persist(userId, channelId, signal).catch(() => {});

  return signal;
}

// ── Get ───────────────────────────────────────────────────────────────────────

/**
 * Get all active (non-expired) signals for a user:channel.
 * Returns an object keyed by signal type for easy lookup.
 *
 * @returns {{ [type]: signal } | {}}
 */
export function getSignals(userId, channelId) {
  _decay(userId, channelId);  // prune expired first
  const signals = _getMap(userId, channelId);
  const result  = {};
  for (const [type, signal] of signals) {
    result[type] = signal;
  }
  return result;
}

/**
 * Check if a specific signal type is active.
 */
export function hasSignal(userId, channelId, type) {
  _decay(userId, channelId);
  return _getMap(userId, channelId).has(type);
}

/**
 * Get the strongest active disengagement signal, if any.
 * Returns the signal or null.
 */
export function getDisengageSignal(userId, channelId) {
  _decay(userId, channelId);
  const signals = _getMap(userId, channelId);
  // Priority: go_offline > disengage > cooling_off
  return signals.get('go_offline')
    || signals.get('disengage')
    || signals.get('cooling_off')
    || null;
}

// ── Clear ─────────────────────────────────────────────────────────────────────

/**
 * Clear a specific signal type (or all signals) for a user.
 * Called when user pings Maya directly, or sends a positive re-engagement message.
 */
export function clearSignal(userId, channelId, type = null) {
  const signals = _getMap(userId, channelId);
  if (type) {
    if (signals.has(type)) {
      console.log(`[signal] cleared ${type} for ${userId}`);
      signals.delete(type);
      _clearFromDB(userId, channelId, type).catch(() => {});
    }
  } else {
    const cleared = [...signals.keys()];
    signals.clear();
    if (cleared.length) {
      console.log(`[signal] cleared all (${cleared.join(', ')}) for ${userId}`);
      _clearFromDB(userId, channelId, null).catch(() => {});
    }
  }
}

/**
 * Weaken a signal (partial re-engagement — user didn't explicitly clear it).
 * Used when user replies positively but didn't explicitly re-engage.
 */
export function weakenSignal(userId, channelId, type, factor = 0.5) {
  const signals = _getMap(userId, channelId);
  const signal  = signals.get(type);
  if (!signal) return;
  signal.strength *= factor;
  if (signal.strength < MIN_STRENGTH) {
    signals.delete(type);
    console.log(`[signal] ${type} weakened to zero → cleared for ${userId}`);
    _clearFromDB(userId, channelId, type).catch(() => {});
  } else {
    console.log(`[signal] ${type} weakened to ${signal.strength.toFixed(2)} for ${userId}`);
  }
}

// ── Describe ──────────────────────────────────────────────────────────────────

/**
 * Get a human-readable summary of active signals for prompt injection.
 * Used by handler.js to tell Maya what behavioral constraints are active.
 */
export function describeSignals(userId, channelId) {
  _decay(userId, channelId);
  const signals = _getMap(userId, channelId);
  if (!signals.size) return null;

  const parts = [];
  for (const [type, signal] of signals) {
    const minsLeft = Math.round((signal.expiresAt - Date.now()) / 60000);
    const desc = {
      go_offline:  `${userId.slice(-4)} asked you to go offline (${minsLeft}min ago)`,
      disengage:   `${userId.slice(-4)} wanted space (signal active ${minsLeft}min left)`,
      cooling_off: `${userId.slice(-4)} seemed frustrated — give a bit of space`,
    }[type] || `signal:${type}`;
    parts.push(desc);
  }
  return parts.join('; ');
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _decay(userId, channelId) {
  const signals = _getMap(userId, channelId);
  const now = Date.now();
  for (const [type, signal] of signals) {
    if (now >= signal.expiresAt || signal.strength < MIN_STRENGTH) {
      signals.delete(type);
      console.log(`[signal] ${type} expired for ${userId}`);
      _clearFromDB(userId, channelId, type).catch(() => {});
    }
  }
}

// ── DB persistence ────────────────────────────────────────────────────────────
// Table: maya_behavioral_signals (created below)
// This means signals survive Koyeb restarts.

async function _persist(userId, channelId, signal) {
  try {
    await db.execute(
      `INSERT INTO maya_behavioral_signals
         (user_id, channel_id, signal_type, strength, expires_at, source, created_at)
       VALUES (?, ?, ?, ?, FROM_UNIXTIME(?), ?, NOW())
       ON DUPLICATE KEY UPDATE
         strength=VALUES(strength), expires_at=VALUES(expires_at),
         source=VALUES(source), created_at=NOW()`,
      [userId, channelId, signal.type, signal.strength,
       Math.floor(signal.expiresAt / 1000), signal.source]
    );
  } catch (e) {
    // Table may not exist yet — non-fatal
    if (!e.message?.includes("doesn't exist")) {
      console.warn('[signal] persist failed:', e.message);
    }
  }
}

async function _clearFromDB(userId, channelId, type) {
  try {
    if (type) {
      await db.execute(
        `DELETE FROM maya_behavioral_signals WHERE user_id=? AND channel_id=? AND signal_type=?`,
        [userId, channelId, type]
      );
    } else {
      await db.execute(
        `DELETE FROM maya_behavioral_signals WHERE user_id=? AND channel_id=?`,
        [userId, channelId]
      );
    }
  } catch { /* non-fatal */ }
}

/**
 * Load persisted signals from DB on startup.
 * Called once from index.js after DB is ready.
 */
export async function loadSignalsFromDB() {
  try {
    const [rows] = await db.execute(
      `SELECT user_id, channel_id, signal_type, strength, UNIX_TIMESTAMP(expires_at)*1000 AS expires_ms, source
       FROM maya_behavioral_signals
       WHERE expires_at > NOW()`
    );
    let loaded = 0;
    for (const r of rows) {
      const signals = _getMap(r.user_id, r.channel_id);
      signals.set(r.signal_type, {
        type:       r.signal_type,
        expiresAt:  parseInt(r.expires_ms),
        strength:   parseFloat(r.strength),
        source:     r.source,
        attachedAt: Date.now(),
      });
      loaded++;
    }
    if (loaded) console.log(`[signal] loaded ${loaded} persisted signals from DB`);
  } catch (e) {
    if (!e.message?.includes("doesn't exist")) {
      console.warn('[signal] DB load failed:', e.message);
    }
  }
}

/**
 * SQL to create the signals table — paste in phpMyAdmin.
 *
 * CREATE TABLE IF NOT EXISTS maya_behavioral_signals (
 *   id          INT AUTO_INCREMENT PRIMARY KEY,
 *   user_id     VARCHAR(32) NOT NULL,
 *   channel_id  VARCHAR(32) NOT NULL,
 *   signal_type VARCHAR(32) NOT NULL,
 *   strength    FLOAT NOT NULL DEFAULT 0.8,
 *   expires_at  DATETIME NOT NULL,
 *   source      VARCHAR(64),
 *   created_at  DATETIME NOT NULL,
 *   UNIQUE KEY uq_signal (user_id, channel_id, signal_type),
 *   INDEX idx_expires (expires_at)
 * );
 */
