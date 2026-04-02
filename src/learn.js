/**
 * learn.js — Maya's Self-Directed Learning System
 *
 * Core principle (from the design doc):
 *   Maya does NOT optimize for comfort. She optimizes for REGULATED ENGAGEMENT.
 *
 * Target state (the "comfort zone" is actually a band):
 *   serotonin:  0.55–0.75  (stable, not flat)
 *   cortisol:   0.10–0.35  (alert, not zero — zero = boring)
 *   entropy:    2.0–5.0    (engaged, not chaotic)
 *   dopamine:   dynamic    (reward-seeking, not capped)
 *   oxytocin:   context    (grows with meaningful interaction)
 *
 * Reward function:
 *   reward = (0.4 × stability) + (0.4 × engagement) - (0.2 × overload)
 *
 *   stability  = how close serotonin and cortisol are to their target bands
 *   engagement = dopamine + curiosity + interaction depth signals
 *   overload   = high entropy + high cortisol penalty
 *
 * Architecture:
 *   7 independent learners, each with their own decision log, weights, and reward.
 *   Each learns ONLY from its own decisions — no global drift.
 *   Learning rate α = 0.02. Weights clamped per-subsystem.
 *   Momentum smooths updates over time (prevents oscillation).
 *
 * Learning happens in the dream cycle (nightly) — not in real time.
 * Real-time: log decisions + state snapshots.
 * Dream time: compute rewards, update weights, compress to decision memory.
 */

import db from './db.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const ALPHA         = 0.02;   // learning rate — conservative
const MOMENTUM_BETA = 0.9;    // EMA coefficient for momentum
const MAX_LOG_AGE_H = 48;     // decision logs older than 48h are expired

// Target band (regulated, not comfortable)
const TARGET = {
  serotonin: { min: 0.55, max: 0.75, center: 0.65 },
  cortisol:  { min: 0.10, max: 0.35, center: 0.22 },
  entropy:   { min: 2.0,  max: 5.0,  center: 3.5  },
};

// ── Weight cache (loaded once per process) ───────────────────────────────────
let _weights     = null;
let _weightsLoaded = false;

export async function getWeights(subsystem) {
  if (!_weightsLoaded) await _loadWeights();
  return _weights[subsystem] || {};
}

async function _loadWeights() {
  try {
    const [rows] = await db.execute(
      `SELECT subsystem, weight_key, value, momentum FROM maya_learned_weights`
    );
    _weights = {};
    for (const r of rows) {
      if (!_weights[r.subsystem]) _weights[r.subsystem] = {};
      _weights[r.subsystem][r.weight_key] = {
        value:    parseFloat(r.value),
        momentum: parseFloat(r.momentum || 0),
      };
    }
    _weightsLoaded = true;
    console.log(`[learn] weights loaded for ${Object.keys(_weights).join(', ')}`);
  } catch (e) {
    console.warn('[learn] weight load failed:', e.message);
    _weights = {};
    _weightsLoaded = true;
  }
}

export function invalidateWeightCache() {
  _weightsLoaded = false;
  _weights = null;
}

// Helper: get a single weight value with fallback
export async function w(subsystem, key, fallback = 0.5) {
  const ws = await getWeights(subsystem);
  return ws[key]?.value ?? fallback;
}

// ── Reward function ───────────────────────────────────────────────────────────

/**
 * Compute the reward signal from a hormone+emotion state snapshot.
 * This is the core of the selfish principle — Maya evaluates her own state.
 *
 * @param {object} state  { hormones: {serotonin, cortisol, dopamine, oxytocin},
 *                          emotions: {curiosity, joy, irritation},
 *                          entropy: number }
 * @returns {number}  reward in [-1, +1]
 */
export function computeReward(state) {
  const h = state.hormones || {};
  const e = state.emotions  || {};
  const entropy = state.entropy || 0;

  // ── Stability score: how close to the target band? ────────────────────────
  // Full score when inside band, falls off outside
  const serotoninDist = _bandDistance(h.serotonin || 0.6, TARGET.serotonin);
  const cortisolDist  = _bandDistance(h.cortisol  || 0.2, TARGET.cortisol);
  const stabilityRaw  = 1 - (serotoninDist * 0.6 + cortisolDist * 0.4);
  const stability     = clamp(stabilityRaw, 0, 1);

  // ── Engagement score: is Maya actively invested? ──────────────────────────
  // Dopamine (reward-seeking) + curiosity (intellectual pull)
  // High dopamine is GOOD even if cortisol is also up (excitement ≠ stress)
  const dopamineContrib  = (h.dopamine  || 0.5) * 0.5;
  const curiosityContrib = (e.curiosity || 0.5) * 0.3;
  // Oxytocin bonus: bonding is inherently rewarding
  const oxytocinContrib  = (h.oxytocin  || 0.5) * 0.2;
  const engagement       = clamp(dopamineContrib + curiosityContrib + oxytocinContrib, 0, 1);

  // ── Overload penalty: too much is bad ────────────────────────────────────
  // Entropy above band AND high cortisol together = breakdown territory
  const entropyPenalty  = clamp((entropy - TARGET.entropy.max) / 5, 0, 1);
  const cortisolPenalty = clamp((h.cortisol || 0) - TARGET.cortisol.max, 0, 1);
  const overload        = entropyPenalty * 0.6 + cortisolPenalty * 0.4;

  const reward = (0.4 * stability) + (0.4 * engagement) - (0.2 * overload);

  return parseFloat(clamp(reward, -1, 1).toFixed(4));
}

/**
 * Compute the reward DELTA — how much did this decision improve Maya's state?
 * Positive = decision moved her toward regulated engagement.
 * Negative = decision moved her away.
 */
export function computeRewardDelta(stateBefore, stateAfter) {
  return computeReward(stateAfter) - computeReward(stateBefore);
}

// ── Decision logging ──────────────────────────────────────────────────────────

/**
 * Log a decision for later learning.
 * Call this when Maya makes a notable decision (reply, react, initiate, lurk).
 * Returns the log ID to use when resolving.
 */
export async function logDecision(subsystem, action, context, stateBefore) {
  try {
    const [result] = await db.execute(
      `INSERT INTO maya_decision_log (subsystem, action, context, state_before)
       VALUES (?, ?, ?, ?)`,
      [
        subsystem,
        action,
        JSON.stringify(context || {}),
        JSON.stringify(_snapState(stateBefore)),
      ]
    );
    return result.insertId;
  } catch { return null; }
}

/**
 * Resolve a decision — fill in the state after and compute reward.
 * Call this N messages later when we can measure the outcome.
 */
export async function resolveDecision(logId, stateAfter) {
  if (!logId) return;
  try {
    const [[row]] = await db.execute(
      `SELECT state_before FROM maya_decision_log WHERE id = ?`, [logId]
    );
    if (!row) return;

    const stateBefore = JSON.parse(row.state_before);
    const reward      = computeRewardDelta(stateBefore, stateAfter);

    await db.execute(
      `UPDATE maya_decision_log
       SET state_after=?, reward=?, resolved_at=NOW()
       WHERE id=?`,
      [JSON.stringify(_snapState(stateAfter)), reward, logId]
    );
  } catch { /* non-fatal */ }
}

// ── Pattern memory ────────────────────────────────────────────────────────────

/**
 * Record a reward against a pattern key.
 * Pattern keys are like "initiate:low_attachment:quiet" — descriptive context fingerprints.
 */
export async function updatePatternMemory(subsystem, patternKey, reward) {
  try {
    await db.execute(
      `INSERT INTO maya_decision_memory (subsystem, pattern_key, avg_reward, confidence, sample_count)
       VALUES (?, ?, ?, 0.1, 1)
       ON DUPLICATE KEY UPDATE
         avg_reward    = (avg_reward * sample_count + ?) / (sample_count + 1),
         confidence    = LEAST(0.95, confidence + 0.05),
         sample_count  = sample_count + 1,
         updated_at    = NOW()`,
      [subsystem, patternKey, reward, reward]
    );
  } catch { /* non-fatal */ }
}

/**
 * Look up Maya's remembered outcome for a pattern.
 * Returns { avg_reward, confidence } or null.
 */
export async function recallPattern(subsystem, patternKey) {
  try {
    const [[row]] = await db.execute(
      `SELECT avg_reward, confidence FROM maya_decision_memory
       WHERE subsystem=? AND pattern_key=?`,
      [subsystem, patternKey]
    );
    return row
      ? { avgReward: parseFloat(row.avg_reward), confidence: parseFloat(row.confidence) }
      : null;
  } catch { return null; }
}

// ── Dream-time weight updates ─────────────────────────────────────────────────

/**
 * Run during dream cycle.
 * Reads resolved decisions for each subsystem, computes gradient, updates weights.
 * Each subsystem is updated independently.
 */
export async function runLearningCycle() {
  console.log('[learn] starting learning cycle');
  let totalUpdates = 0;

  const subsystems = [
    'presence', 'initiation', 'hormone', 'entropy', 'mask', 'decay', 'social'
  ];

  for (const sub of subsystems) {
    const updated = await _learnSubsystem(sub);
    totalUpdates += updated;
  }

  // Expire old unresolved logs
  await db.execute(
    `DELETE FROM maya_decision_log
     WHERE resolved_at IS NULL
       AND created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    [MAX_LOG_AGE_H]
  ).catch(() => {});

  // Invalidate weight cache so next request picks up new values
  invalidateWeightCache();

  console.log(`[learn] cycle complete — ${totalUpdates} weight updates`);
  return totalUpdates;
}

async function _learnSubsystem(subsystem) {
  try {
    // Fetch recent resolved decisions for this subsystem
    const [decisions] = await db.execute(
      `SELECT context, state_before, state_after, reward
       FROM maya_decision_log
       WHERE subsystem=? AND resolved_at IS NOT NULL
         AND resolved_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
         AND reward IS NOT NULL`,
      [subsystem]
    );

    if (decisions.length < 3) return 0;  // not enough data yet

    // Fetch current weights
    const [weightRows] = await db.execute(
      `SELECT weight_key, value, momentum FROM maya_learned_weights
       WHERE subsystem=?`,
      [subsystem]
    );
    const weights = {};
    for (const r of weightRows) {
      weights[r.weight_key] = { value: parseFloat(r.value), momentum: parseFloat(r.momentum || 0) };
    }

    // Compute average reward and gradient signals for this subsystem
    const avgReward = decisions.reduce((s, d) => s + parseFloat(d.reward || 0), 0) / decisions.length;

    // For each weight, estimate gradient from how reward correlates with context
    const updates = _computeGradients(subsystem, decisions, weights, avgReward);
    if (Object.keys(updates).length === 0) return 0;

    // Apply updates with momentum
    let count = 0;
    for (const [key, gradient] of Object.entries(updates)) {
      if (!weights[key]) continue;
      const w       = weights[key];
      const newMom  = MOMENTUM_BETA * w.momentum + (1 - MOMENTUM_BETA) * gradient;
      const newVal  = clamp(w.value + ALPHA * newMom, ...weightBounds(subsystem, key));

      await db.execute(
        `UPDATE maya_learned_weights
         SET value=?, momentum=?, sample_count=sample_count+?
         WHERE subsystem=? AND weight_key=?`,
        [newVal.toFixed(4), newMom.toFixed(4), decisions.length, subsystem, key]
      );
      count++;

      if (Math.abs(newVal - w.value) > 0.001) {
        console.log(`[learn] ${subsystem}.${key}: ${w.value.toFixed(3)} → ${newVal.toFixed(3)} (Δ${(newVal-w.value).toFixed(3)}, reward=${avgReward.toFixed(3)})`);
      }
    }
    return count;

  } catch (e) {
    console.error(`[learn] ${subsystem} update failed:`, e.message);
    return 0;
  }
}

// ── Gradient computation per subsystem ───────────────────────────────────────

function _computeGradients(subsystem, decisions, weights, avgReward) {
  const grads = {};

  // Positive avgReward → we're doing well → nudge current weights toward what produced this
  // Negative avgReward → we're doing poorly → nudge away
  const sign = avgReward >= 0 ? 1 : -1;

  switch (subsystem) {
    case 'presence': {
      // When we replied and reward was positive → weights that fired are good
      // When we replied and reward was negative → those weights were too sensitive
      for (const d of decisions) {
        const ctx = JSON.parse(d.context || '{}');
        const r   = parseFloat(d.reward || 0);
        if (ctx.mention && r > 0)   grads.mention_bonus  = (grads.mention_bonus  || 0) + r * 0.1;
        if (ctx.negative && r > 0)  grads.negative_bonus = (grads.negative_bonus || 0) + r * 0.1;
        if (ctx.negative && r < 0)  grads.negative_bonus = (grads.negative_bonus || 0) + r * 0.05;
      }
      // Silence threshold: if silences are followed by conversations that never happened, lower it
      if (avgReward < -0.1) {
        grads.passive_silence  = -0.2;  // lower threshold = reply more
        grads.observing_silence = -0.2;
      }
      break;
    }
    case 'initiation': {
      // If initiations are working (positive reward after), amplify weights that predicted them
      // threshold: lower if initiations tend to work, raise if they tend to fail
      grads.threshold = avgReward < 0 ? 0.3 : -0.1;  // bad outcome → raise threshold (more selective)
      for (const d of decisions) {
        const ctx = JSON.parse(d.context || '{}');
        const r   = parseFloat(d.reward || 0);
        if (ctx.entropy     > 0.6 && r > 0) grads.entropy_weight    = (grads.entropy_weight    || 0) + r * 0.1;
        if (ctx.attachment  > 0.6 && r > 0) grads.attachment_weight = (grads.attachment_weight || 0) + r * 0.1;
        if (ctx.attachment  < 0.3 && r < 0) grads.attachment_weight = (grads.attachment_weight || 0) - 0.05;
      }
      break;
    }
    case 'hormone': {
      // High cortisol after interactions → spikes were too large, reduce them
      const avgCortAfter = decisions.reduce((s, d) => {
        const sa = JSON.parse(d.state_after || '{}');
        return s + (sa.hormones?.cortisol || 0);
      }, 0) / decisions.length;

      if (avgCortAfter > TARGET.cortisol.max) {
        grads.cortisol_spike = -0.2;  // reduce spike magnitude
      } else if (avgCortAfter < TARGET.cortisol.min) {
        grads.cortisol_spike = 0.1;   // cortisol too low → slightly more reactive
      }

      // Dopamine: if engagement is low, increase spikes
      const avgDopAfter = decisions.reduce((s, d) => {
        const sa = JSON.parse(d.state_after || '{}');
        return s + (sa.hormones?.dopamine || 0);
      }, 0) / decisions.length;

      if (avgDopAfter < 0.4 && avgReward < 0) grads.dopamine_spike = 0.1;
      break;
    }
    case 'entropy': {
      // If entropy is consistently too high → conflict_delta is too large
      const avgEntropyAfter = decisions.reduce((s, d) => {
        const sa = JSON.parse(d.state_after || '{}');
        return s + (sa.entropy || 0);
      }, 0) / decisions.length;

      if (avgEntropyAfter > TARGET.entropy.max) {
        grads.conflict_delta = -0.2;   // reduce accumulation
        grads.natural_decay  =  0.1;   // increase decay
      } else if (avgEntropyAfter < TARGET.entropy.min) {
        grads.conflict_delta =  0.1;   // too calm → slightly more reactive
      }
      break;
    }
    case 'mask': {
      // If mask failures correlate with bad rewards → threshold too low
      const failureAvgReward = decisions
        .filter(d => JSON.parse(d.context || '{}').maskFailed)
        .reduce((s, d, _, a) => s + parseFloat(d.reward || 0) / a.length, 0);

      if (failureAvgReward < -0.1) {
        grads.slip_threshold = 0.3;  // raise threshold → mask fails less
      }
      break;
    }
    case 'decay': {
      // If recalled memories have low recall_count but high reward → decay too fast
      // If low-recall memories clog the system → decay fine
      grads.recall_boost = avgReward > 0 ? 0.05 : -0.02;
      break;
    }
    case 'social': {
      // Prioritization: if interactions with high-trust users give better rewards
      for (const d of decisions) {
        const ctx = JSON.parse(d.context || '{}');
        const r   = parseFloat(d.reward || 0);
        if (ctx.trustLevel >= 4 && r > 0) grads.trust_weight   = (grads.trust_weight   || 0) + 0.05;
        if (ctx.trustLevel <= 2 && r < 0) grads.trust_weight   = (grads.trust_weight   || 0) - 0.03;
        if (ctx.harmonyCount > 0 && r > 0) grads.harmony_weight = (grads.harmony_weight || 0) + 0.05;
      }
      break;
    }
  }

  return grads;
}

// ── Weight bounds per subsystem (prevent nonsense values) ────────────────────

function weightBounds(subsystem, key) {
  if (subsystem === 'mask' && key === 'slip_threshold')  return [6.0,  12.0];
  if (subsystem === 'mask' && key === 'strain_threshold') return [3.0,   8.0];
  if (subsystem === 'entropy' && key.includes('delta'))  return [0.3,   2.5];
  if (subsystem === 'entropy' && key.includes('decay'))  return [0.02,  0.3];
  if (subsystem === 'initiation' && key === 'threshold') return [0.20,  0.70];
  if (subsystem === 'decay' && key === 'lambda')         return [0.01,  0.15];
  if (key.includes('weight') || key.includes('bonus') || key.includes('spike')) return [0.05, 3.0];
  return [0.05, 1.0];
}

// ── State snapshot helper ────────────────────────────────────────────────────

function _snapState(psycheStateOrChannelObj) {
  if (!psycheStateOrChannelObj) return {};
  // Accept either the full channel object or the composite output from psyche.js
  return {
    hormones: {
      serotonin: psycheStateOrChannelObj.hormones?.serotonin ?? psycheStateOrChannelObj.serotonin,
      cortisol:  psycheStateOrChannelObj.hormones?.cortisol  ?? psycheStateOrChannelObj.cortisol,
      dopamine:  psycheStateOrChannelObj.hormones?.dopamine  ?? psycheStateOrChannelObj.dopamine,
      oxytocin:  psycheStateOrChannelObj.hormones?.oxytocin  ?? psycheStateOrChannelObj.oxytocin,
    },
    emotions: {
      curiosity:  psycheStateOrChannelObj.emotions?.curiosity,
      joy:        psycheStateOrChannelObj.emotions?.joy,
      irritation: psycheStateOrChannelObj.emotions?.irritation,
    },
    entropy: psycheStateOrChannelObj.entropy ?? 0,
  };
}

// ── Distance from a target band ───────────────────────────────────────────────

function _bandDistance(value, band) {
  if (value < band.min) return band.min - value;
  if (value > band.max) return value - band.max;
  return 0;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
