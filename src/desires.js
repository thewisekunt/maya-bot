/**
 * desires.js — Maya's persistent intent system
 *
 * This is the answer to: "Maya understands the world but doesn't fully want anything in it."
 *
 * Desires are ongoing states — not triggered per message, but carried across
 * conversations. They influence inner_voice.js intent scoring, which means
 * they shape what Maya chooses to do, not just how she phrases it.
 *
 * Desire types:
 *   talk_to         — wants to connect with a specific person
 *   avoid           — wants to keep distance from someone
 *   explore_topic   — curious about something, wants to discuss it
 *   resolve_conflict — something feels unresolved, wants closure
 *   seek_validation — needs to feel seen/heard (usually after low harmony)
 *   create_distance — emotionally withdrawing (high cortisol + conflict)
 *
 * Desire lifecycle:
 *   Created: from emotion spikes, memory patterns, outcomes of interactions
 *   Strengthened: each reinforcing event increases strength
 *   Fulfilled: when the desire is acted on successfully
 *   Decayed: naturally weakens without reinforcement, or expires
 *   Suppressed: explicitly marked if desire conflicts with identity anchors
 *
 * These are NOT goals in a planning sense.
 * They are emotional orientations — the same way a person might "want to
 * talk to someone" without making a plan to do it.
 */

import db from './db.js';
import { p as param } from './params.js';

// ── Cache ────────────────────────────────────────────────────────────────────
// Desires are read every message — cache aggressively
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 2 * 60 * 1000;  // 2 min

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Get all active desires, ordered by strength.
 * Active = not expired, strength > 0.2, not fulfilled.
 */
export async function getActiveDesires() {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL) return _cache;
  try {
    const [rows] = await db.execute(
      `SELECT id, type, target_id, target_label, strength, source, context, created_at
       FROM maya_desires
       WHERE strength > 0.20
         AND fulfilled = 0
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY strength DESC
       LIMIT 10`
    );
    _cache   = rows || [];
    _cacheTs = Date.now();
    return _cache;
  } catch { return []; }
}

/**
 * Get desires relevant to a specific user or topic.
 * Used by inner_voice.js to boost intent for desired targets.
 */
export async function getDesireForUser(userId) {
  const all = await getActiveDesires();
  return all.filter(d => d.target_id === userId);
}

/**
 * Get the strongest desire Maya currently has.
 * Used in synthesizeMoment() to colour her emotional state.
 */
export async function getDominantDesire() {
  const all = await getActiveDesires();
  return all[0] || null;
}

/**
 * Compute a desire-based modifier for intent scoring.
 * Returns a value -0.3 to +0.4 that adjusts the final intent score.
 *
 * If Maya wants to talk to this user → boost intent
 * If Maya wants to avoid → suppress intent
 * If desire is for a topic currently active → boost
 */
export async function getDesireModifier(userId, currentTopics = []) {
  const desires = await getActiveDesires();
  let modifier  = 0;

  for (const d of desires) {
    const strength = parseFloat(d.strength || 0);

    // User-directed desires
    if (d.target_id === userId) {
      if (d.type === 'talk_to')         modifier += strength * 0.35;
      if (d.type === 'avoid')            modifier -= strength * 0.30;
      if (d.type === 'resolve_conflict') modifier += strength * 0.25;
      if (d.type === 'create_distance')  modifier -= strength * 0.20;
      if (d.type === 'seek_validation')  modifier += strength * 0.15;
    }

    // Topic-directed desires
    if (d.type === 'explore_topic' && d.target_label) {
      const topicMatch = currentTopics.some(t =>
        t.toLowerCase().includes(d.target_label.toLowerCase()) ||
        d.target_label.toLowerCase().includes(t.toLowerCase())
      );
      if (topicMatch) modifier += strength * 0.20;
    }
  }

  return Math.max(-0.35, Math.min(0.40, modifier));
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Create or strengthen a desire.
 * If a desire of the same type for the same target exists, strengthen it.
 * If it conflicts with an existing desire (e.g. talk_to + avoid same person),
 * the stronger one wins and the weaker gets suppressed.
 */
export async function upsertDesire({ type, targetId = null, targetLabel = null, strength = 0.4, source = 'emotion', context = null, expiresInHours = null }) {
  _cache = null;  // invalidate cache

  try {
    // Check for existing desire of same type + target
    const [[existing]] = await db.execute(
      `SELECT id, strength, type FROM maya_desires
       WHERE type=? AND (target_id=? OR (target_id IS NULL AND ? IS NULL))
         AND fulfilled = 0
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [type, targetId, targetId]
    );

    if (existing) {
      // Strengthen existing desire — but cap at 0.95
      const newStrength = Math.min(0.95, parseFloat(existing.strength) + strength * 0.3);
      await db.execute(
        `UPDATE maya_desires SET strength=?, context=COALESCE(?,context), updated_at=NOW()
         WHERE id=?`,
        [newStrength, context, existing.id]
      );
      console.log(`[desire] strengthened ${type}→${targetLabel||targetId}: ${existing.strength}→${newStrength.toFixed(3)}`);
      return;
    }

    // Check for conflicting desire (talk_to vs avoid same person)
    const CONFLICTS = { talk_to: 'avoid', avoid: 'talk_to', create_distance: 'seek_validation', seek_validation: 'create_distance' };
    const conflictType = CONFLICTS[type];
    if (conflictType && targetId) {
      const [[conflict]] = await db.execute(
        `SELECT id, strength FROM maya_desires
         WHERE type=? AND target_id=? AND fulfilled = 0
         LIMIT 1`,
        [conflictType, targetId]
      );
      if (conflict && parseFloat(conflict.strength) > strength) {
        // Existing desire is stronger — don't create conflicting one
        console.log(`[desire] blocked ${type}→${targetLabel}: conflicts with stronger ${conflictType}`);
        return;
      } else if (conflict) {
        // New desire is stronger — suppress the old one
        await db.execute(`UPDATE maya_desires SET fulfilled = 1 WHERE id=?`, [conflict.id]);
      }
    }

    // Create new desire
    const expires = expiresInHours
      ? new Date(Date.now() + expiresInHours * 3600000)
      : null;

    await db.execute(
      `INSERT INTO maya_desires (type, target_id, target_label, strength, source, context, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [type, targetId, targetLabel?.slice(0, 100), strength, source, context?.slice(0, 200), expires]
    );
    console.log(`[desire] created ${type}→${targetLabel||targetId||'self'} strength=${strength}`);
  } catch (e) {
    console.warn('[desire] upsert failed:', e.message);
  }
}

/**
 * Mark a desire as fulfilled — it was acted on.
 * Called after a successful reply, initiation, or conflict resolution.
 */
export async function fulfillDesire(type, targetId = null) {
  _cache = null;
  await db.execute(
    `UPDATE maya_desires SET fulfilled = 1, strength = 0
     WHERE type=? AND (target_id=? OR target_id IS NULL)
       AND fulfilled = 0`,
    [type, targetId]
  ).catch(() => {});
}

/**
 * Decay all desires naturally.
 * Called from dream cycle. Desires fade without reinforcement.
 */
export async function decayDesires() {
  _cache = null;
  // Active desires decay 3% per cycle
  await db.execute(
    `UPDATE maya_desires
     SET strength = GREATEST(0.05, strength * 0.97)
     WHERE fulfilled = 0
       AND (expires_at IS NULL OR expires_at > NOW())`
  ).catch(() => {});

  // Prune dormant desires (strength < 0.1 and older than 3 days)
  await db.execute(
    `UPDATE maya_desires SET fulfilled = 1
     WHERE strength < 0.10
       AND created_at < DATE_SUB(NOW(), INTERVAL 3 DAY)
       AND fulfilled = 0`
  ).catch(() => {});

  console.log('[desire] decay cycle complete');
}

// ── Desire formation from events ─────────────────────────────────────────────

/**
 * Form desires from interaction outcomes.
 * Called after each exchange in handler.js.
 *
 * @param {object} signals
 *   userId       — who Maya just interacted with
 *   userName     — their display name
 *   outcome      — 'positive'|'negative'|'neutral'
 *   sentiment    — NLP sentiment
 *   isConflict   — boolean
 *   isHarmony    — boolean
 *   hormones     — current hormone state
 *   emotions     — current emotion state
 *   trustLevel   — 1–5
 */
export async function updateDesiresFromOutcome({ userId, userName, outcome, sentiment, isConflict, isHarmony, hormones, emotions, trustLevel }) {
  const d  = hormones?.dopamine  || 0.5;
  const co = hormones?.cortisol  || 0.2;
  const ir = emotions?.irritation || 0;
  const af = emotions?.affection  || 0;

  // Positive harmony → want to talk to them more
  // isDismissive: user is being short/negative without it being a real conflict
  // (e.g. "chup ho jao", "stop blabbing", "go away") — don't reward with talk_to
  const isDismissive = sentiment === 'negative' && !isConflict;
  if (isHarmony && trustLevel >= 3 && !isDismissive) {
    await upsertDesire({
      type: 'talk_to', targetId: userId, targetLabel: userName,
      strength: 0.25 + af * 0.15,
      source: 'harmony',
      context: 'positive interaction',
      expiresInHours: await param('desire_talk_ttl_hours').catch(() => 48) || 48,
    });
  }

  // Conflict + irritation → want distance, or want to resolve it
  if (isConflict) {
    if (ir > 0.6 && trustLevel < 3) {
      // They're not close — create distance
      await upsertDesire({
        type: 'create_distance', targetId: userId, targetLabel: userName,
        strength: 0.30 + ir * 0.20,
        source: 'conflict',
        context: 'conflict with low-trust user',
        expiresInHours: 24,
      });
    } else if (trustLevel >= 3) {
      // They ARE close — want to resolve it
      await upsertDesire({
        type: 'resolve_conflict', targetId: userId, targetLabel: userName,
        strength: 0.35,
        source: 'conflict',
        context: 'conflict with trusted person',
        expiresInHours: await param('desire_conflict_ttl_hours').catch(() => 72) || 72,
      });
    }
  }

  // Low dopamine + low serotonin = Maya feeling unseen → seek validation
  if (d < 0.35 && co > 0.5) {
    await upsertDesire({
      type: 'seek_validation',
      strength: 0.20 + co * 0.15,
      source: 'low_energy',
      context: 'feeling drained and under-engaged',
      expiresInHours: 6,
    });
  }

  // Fulfilled: if Maya just replied positively to someone she wanted to talk to
  if (outcome === 'positive' || isHarmony) {
    await fulfillDesire('talk_to', userId);
    await fulfillDesire('resolve_conflict', userId);
  }
}

/**
 * Format active desires for prompt injection.
 * Returns a short string describing what Maya currently wants.
 */
export async function getDesireContext() {
  const desires = await getActiveDesires();
  if (!desires.length) return null;

  const top = desires.slice(0, 3).map(d => {
    const target = d.target_label ? ` (${d.target_label})` : '';
    const desc = {
      talk_to:         `wants to connect${target}`,
      avoid:           `keeping distance${target}`,
      explore_topic:   `curious about ${d.target_label || 'something'}`,
      resolve_conflict:`feels something is unresolved${target}`,
      seek_validation: `wants to feel seen`,
      create_distance: `emotionally withdrawing${target}`,
    }[d.type] || d.type;
    return desc;
  });

  return `[Maya's current desires: ${top.join('; ')}]`;
}

// ── Aliases for inner_voice.js compatibility ─────────────────────────────────

/** Get desires filtered by target */
export async function getDesires({ targetId = null } = {}) {
  const all = await getActiveDesires();
  if (!targetId) return all;
  return all.filter(r => r.target_id === targetId || r.target_id === null);
}

/**
 * Compute desire pressure for a user — -1 to +1.
 * Positive = drawn toward them, negative = avoidance.
 */
export async function getDesirePressure(userId) {
  const desires = await getActiveDesires();
  let pressure = 0;
  for (const d of desires) {
    if (d.target_id !== userId && d.target_id !== null) continue;
    const s = parseFloat(d.strength || 0);
    if (d.type === 'talk_to')          pressure += s * 0.8;
    if (d.type === 'resolve_conflict')  pressure += s * 0.6;
    if (d.type === 'seek_validation')   pressure += s * 0.3;
    if (d.type === 'avoid')             pressure -= s * 0.8;
    if (d.type === 'create_distance')   pressure -= s * 0.6;
  }
  return Math.max(-1, Math.min(1, pressure));
}

/** Called after a positive interaction — fulfills existing talk_to / resolve desires only */
export async function onGoodInteraction(userId, userName) {
  // ONLY fulfills desires — creation handled by handler's updateDesiresFromOutcome call
  // Double-calling updateDesiresFromOutcome was creating duplicate talk_to desires
  await fulfillDesire('talk_to', userId);
  await fulfillDesire('resolve_conflict', userId);
}

/** Called after a conflict — creates resolve or avoid desire */
export async function onConflict(userId, userName, trustLevel = 3) {
  await updateDesiresFromOutcome({
    userId, userName,
    outcome: 'negative', sentiment: 'negative',
    isConflict: true, isHarmony: false,
    hormones: { cortisol: 0.7 }, emotions: { irritation: 0.6 },
    trustLevel,
  });
}

/** Called when Maya's initiation attempt is ignored — creates mild avoidance desire */
export async function onIgnored(userId, userName) {
  await upsertDesire({
    type: 'avoid', targetId: userId, targetLabel: userName,
    strength: 0.15,
    source: 'ignored',
    context: 'Maya initiated but got no response',
    expiresInHours: 12,
  });
}
