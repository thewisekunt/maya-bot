/**
 * params.js — Maya's self-owned parameter store
 *
 * Maya controls these values through the feedback loop in dream.js.
 * We set initial values. She adjusts them based on outcomes.
 *
 * Usage:
 *   import { p } from './params.js';
 *   const threshold = await p('salience_threshold');   // returns current float
 *
 * The cache refreshes every 10 minutes so dream cycle updates propagate
 * without a restart.
 */

import db from './db.js';

// In-memory cache: param_key → { value, floor, ceiling, learningRate }
let _cache    = null;
let _cacheAt  = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;  // 10 minutes

// Defaults — used if DB is unavailable
const DEFAULTS = {
  salience_threshold:          0.35,
  intent_reply_threshold:      0.50,
  intent_react_threshold:      0.28,
  initiation_threshold:        0.55,
  memory_conv_threshold:       0.45,
  memory_guild_threshold:      0.62,
  defense_heat_threshold:      0.55,
  defense_cortisol_threshold:  0.55,
  trust_decay_rate:            0.85,
  desire_talk_ttl_hours:       48.0,
  desire_conflict_ttl_hours:   72.0,
  cortisol_recovery_rate:      0.08,
  response_length_target:      1.5,
  learning_meta_rate:          0.015,
};

async function _load() {
  try {
    const [rows] = await db.execute(
      `SELECT param_key, value, floor_val, ceiling_val, learning_rate
       FROM maya_params`
    );
    _cache   = {};
    for (const r of rows) {
      _cache[r.param_key] = {
        value:        parseFloat(r.value),
        floor:        parseFloat(r.floor_val),
        ceiling:      parseFloat(r.ceiling_val),
        learningRate: parseFloat(r.learning_rate),
      };
    }
    _cacheAt = Date.now();
  } catch (e) {
    console.warn('[params] load failed, using defaults:', e.message);
    _cache = {};
    _cacheAt = Date.now();
  }
}

async function _ensureLoaded() {
  if (!_cache || Date.now() - _cacheAt > CACHE_TTL_MS) {
    await _load();
  }
}

/**
 * Get a parameter value. Falls back to hardcoded default if not in DB.
 */
export async function p(key) {
  await _ensureLoaded();
  return _cache[key]?.value ?? DEFAULTS[key] ?? null;
}

/**
 * Get full parameter metadata.
 */
export async function getMeta(key) {
  await _ensureLoaded();
  return _cache[key] ?? null;
}

/**
 * Get all params as a flat key→value map (for logging/debug).
 */
export async function getAll() {
  await _ensureLoaded();
  const out = {};
  for (const [k, v] of Object.entries(_cache)) out[k] = v.value;
  return out;
}

/**
 * Adjust a parameter value within its floor/ceiling bounds.
 * Called by dream cycle. Delta is the signed adjustment.
 * Returns the new value.
 */
export async function adjust(key, delta, rewardSignal = null, reason = '') {
  await _ensureLoaded();
  const meta = _cache[key];
  if (!meta) return null;

  const newVal = Math.max(meta.floor, Math.min(meta.ceiling, meta.value + delta));
  if (Math.abs(newVal - meta.value) < 0.0001) return meta.value;  // no meaningful change

  try {
    await db.execute(
      `UPDATE maya_params
       SET value=?, last_adjusted=NOW(), adjustment_count=adjustment_count+1,
           avg_reward_when_adjusted=?, notes=?
       WHERE param_key=?`,
      [newVal, rewardSignal, reason.slice(0, 255), key]
    );
    meta.value = newVal;
    console.log(`[params] ${key}: ${(meta.value + delta - newVal + meta.value - delta).toFixed(3)} → ${newVal.toFixed(3)} (${reason})`);
    return newVal;
  } catch (e) {
    console.warn(`[params] adjust ${key} failed:`, e.message);
    return meta.value;
  }
}

/**
 * Force cache refresh (call after dream cycle completes).
 */
export function invalidateCache() {
  _cache   = null;
  _cacheAt = 0;
}
