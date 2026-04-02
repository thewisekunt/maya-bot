/**
 * spamguard.js — Spam detection without LLM cost
 *
 * Detects spam through local pattern signals only.
 * Applies to both server channels and DMs (DMs use higher thresholds).
 *
 * Signals:
 *   1. Velocity      — too many messages in a short window
 *   2. Repetition    — same/near-identical content repeated
 *   3. Low entropy   — keyboard mash, dots, single chars
 *   4. Ping spam     — @mention with no substance
 *   5. Mention flood — repeated short @mentions
 *
 * Online learning:
 *   When spam is detected, logs the pattern to maya_nlp_training
 *   with intent='group_chatter' so NLP learns to classify spam as
 *   low-priority. Over time NLP gets better at filtering it before
 *   it even reaches spamguard.
 */

import db from './db.js';

// ── Config ────────────────────────────────────────────────────────────────────
const VELOCITY_WINDOW_MS  = 30_000;
const VELOCITY_LIMIT      = 6;      // server: 6 msgs/30s
const DM_VELOCITY_LIMIT   = 10;     // DMs: more tolerant (10 msgs/30s)

const REPEAT_WINDOW_MS    = 60_000;
const REPEAT_LIMIT        = 3;      // same message 3x = spam
const DM_REPEAT_LIMIT     = 4;      // DMs: slightly more tolerant

const PENALTY_THRESHOLD   = 8;
const DM_PENALTY_THRESHOLD= 12;     // DMs: higher threshold before ignoring

const COOLING_DURATION_MS = 3 * 60_000;
const PENALTY_DECAY_MS    = 60_000;

// ── Per-user state ─────────────────────────────────────────────────────────────
const _states = new Map();

function _getState(channelId, userId) {
  const key = `${channelId}:${userId}`;
  if (!_states.has(key)) {
    _states.set(key, {
      timestamps:   [],
      recentTexts:  [],
      penalty:      0,
      cooling:      false,
      coolingUntil: 0,
      lastGood:     Date.now(),
      spamTexts:    [],   // for NLP learning — collect spam examples
    });
  }
  return _states.get(key);
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * @param {string}  channelId
 * @param {string}  userId
 * @param {string}  text
 * @param {boolean} isMention
 * @param {boolean} isDM        — use higher thresholds for DMs
 */
export function checkSpam(channelId, userId, text, isMention = false, isDM = false) {
  const state     = _getState(channelId, userId);
  const now       = Date.now();
  const velLimit  = isDM ? DM_VELOCITY_LIMIT  : VELOCITY_LIMIT;
  const repLimit  = isDM ? DM_REPEAT_LIMIT    : REPEAT_LIMIT;
  const threshold = isDM ? DM_PENALTY_THRESHOLD : PENALTY_THRESHOLD;

  // Decay penalty for good behaviour
  const quietMs = now - state.lastGood;
  if (quietMs > PENALTY_DECAY_MS && state.penalty > 0) {
    const decay   = Math.floor(quietMs / PENALTY_DECAY_MS);
    state.penalty = Math.max(0, state.penalty - decay);
  }

  // Check cooling period
  if (state.cooling) {
    if (now < state.coolingUntil) {
      const remaining = Math.round((state.coolingUntil - now) / 1000);
      return { isSpam: true, reason: `cooling: ${remaining}s left`, penalty: state.penalty };
    }
    state.cooling = false;
    state.penalty = Math.floor(state.penalty / 2);
    console.log(`[spamguard] ${userId} cooling ended, penalty=${state.penalty}`);
  }

  // Update state
  state.timestamps  = state.timestamps.filter(t => now - t < VELOCITY_WINDOW_MS);
  state.timestamps.push(now);
  state.recentTexts = state.recentTexts.filter(e => now - e.ts < REPEAT_WINDOW_MS);
  state.recentTexts.push({ text: text.toLowerCase().trim(), ts: now });

  // ── Signal detection ───────────────────────────────────────────────────────
  const signals = [];
  const clean   = text.toLowerCase().trim();

  // Velocity
  if (state.timestamps.length > velLimit) {
    signals.push({ name: 'velocity', points: Math.min((state.timestamps.length - velLimit) * 1.5, 5) });
  }

  // Repetition
  const repeatCount = state.recentTexts.filter(e =>
    e.text === clean || _similarity(e.text, clean) > 0.85
  ).length;
  if (repeatCount >= repLimit) {
    signals.push({ name: 'repetition', points: 4 });
  }

  // Low entropy
  const ent = _entropy(text);
  if (ent < 0.15 && text.length > 0) {
    signals.push({ name: 'low_entropy', points: 2 });
  }

  // Ping spam
  if (isMention && text.replace(/<@!?\d+>/g, '').trim().length < 3) {
    signals.push({ name: 'ping_spam', points: 3 });
  }

  // Mention flood
  const recentShort = state.recentTexts.filter(e => now - e.ts < 20_000 && e.text.length < 10).length;
  if (isMention && recentShort >= 3) {
    signals.push({ name: 'mention_flood', points: 4 });
  }

  // ── Apply penalty ──────────────────────────────────────────────────────────
  if (signals.length > 0) {
    const totalPoints = signals.reduce((sum, s) => sum + s.points, 0);
    state.penalty    += totalPoints;
    const names       = signals.map(s => s.name).join('+');
    console.log(`[spamguard] ${userId} [${names}] penalty=${state.penalty}/${threshold}`);

    // Collect for NLP learning
    if (text.length >= 2 && text.length <= 200) {
      state.spamTexts.push(text);
    }
  } else {
    state.lastGood = now;
  }

  // ── Threshold hit → cooling + NLP logging ──────────────────────────────────
  if (state.penalty >= threshold) {
    state.cooling      = true;
    state.coolingUntil = now + COOLING_DURATION_MS;
    console.log(`[spamguard] ${userId} → cooling ${COOLING_DURATION_MS/1000}s (penalty=${state.penalty})`);

    // Log spam examples to NLP training (fire and forget)
    _logSpamToNLP(state.spamTexts).catch(() => {});
    state.spamTexts = [];   // clear after logging

    return { isSpam: true, reason: `threshold (penalty=${state.penalty})`, penalty: state.penalty };
  }

  return { isSpam: false, reason: 'ok', penalty: state.penalty };
}

export function notifyReplied(channelId, userId) {
  const state = _getState(channelId, userId);
  if (state.penalty > 0) state.penalty = Math.max(0, state.penalty - 1);
  state.lastGood = Date.now();
}

export function getSpamStatus(channelId, userId) {
  const state = _getState(channelId, userId);
  return {
    penalty:  state.penalty,
    cooling:  state.cooling,
    velocity: state.timestamps.filter(t => Date.now() - t < VELOCITY_WINDOW_MS).length,
  };
}

// ── NLP online learning ────────────────────────────────────────────────────────

/**
 * Log spam patterns to maya_nlp_training.
 * Intent = 'group_chatter' (lowest priority) so NLP learns to deprioritise
 * these patterns. Over time NLP filters them before spamguard runs.
 */
async function _logSpamToNLP(texts) {
  if (!texts.length) return;
  try {
    const values = texts
      .filter(t => t && t.length >= 2 && t.length <= 200)
      .slice(0, 10)   // cap at 10 per cooling event
      .map(t => [t, 'group_chatter', 'implicit_reward', null, null, null, 0]);

    if (!values.length) return;

    const ph = values.map(() => '(?,?,?,?,?,?,?)').join(',');
    await db.execute(
      `INSERT IGNORE INTO maya_nlp_training
         (text, intent, source, nlp_intent, nlp_score, llm_intent, reward)
       VALUES ${ph}`,
      values.flat()
    );
    console.log(`[spamguard] logged ${values.length} spam patterns to NLP training`);
  } catch (e) {
    console.error('[spamguard] NLP log failed:', e.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _entropy(str) {
  if (!str || str.length < 2) return 0;
  const freq = {};
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  const len = str.length;
  return Object.values(freq).reduce((sum, count) => {
    const p = count / len;
    return sum - p * Math.log2(p);
  }, 0) / Math.log2(Math.max(len, 2));
}

function _similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const bigrams = s => new Set([...Array(Math.max(0, s.length - 1)).keys()].map(i => s.slice(i, i + 2)));
  const ba = bigrams(a), bb = bigrams(b);
  if (!ba.size && !bb.size) return 1;
  if (!ba.size || !bb.size) return 0;
  let intersect = 0;
  for (const g of ba) if (bb.has(g)) intersect++;
  return intersect / (ba.size + bb.size - intersect);
}
