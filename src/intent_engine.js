/**
 * intent_engine.js — Unified decision layer
 *
 * Takes the output of inner_voice.js (cognition snapshot)
 * and resolves a single action.
 *
 * Replaces:
 *   - decide() in presence.js (scattered scoring logic)
 *   - evaluate() in notif.js (rule-based notification gating)
 *   - shouldDeliberate() trigger in think.js (now handled by tool plan)
 *
 * Actions:
 *   reply    — full LLM response
 *   react    — emoji only
 *   initiate — Maya starts the conversation (no incoming trigger)
 *   ignore   — deliberate silence
 *   lurk     — stay in observing mode, don't respond yet
 *
 * The engine is intentionally simple — the complexity lives in inner_voice.js.
 * This function just maps scores to actions with clear thresholds.
 */

import { ZONES } from './observation.js';

/**
 * Resolve the final action from inner voice cognition.
 *
 * @param {object} inner — output from runInnerVoice()
 * @param {object} opts
 *   isMention  {bool}
 *   isDM       {bool}
 *   isReply    {bool}
 *   isSleeping {bool}
 * @returns {{ action, reason, emoji? }}
 */
export function resolveIntent(inner, opts = {}) {
  const {
    intentScore,
    contextForce,
    internalPressure,
    socialRisk,
    psyche,
    obsState,
    energy,
    situation,
    activeDesires = [],
    desireModifier = 0,
  } = inner;

  // Identity anchor check — some desires are blocked by who Maya IS
  // e.g. if she has a strong "I don't grovel" self-belief, avoid can't force groveling
  // This is kept simple: desire creates distance only adjusts thresholds, not overrides
  const targetUserId = opts.userId || null;
  const hasAvoidDesire  = activeDesires.some(d => d.desire_type === 'avoid'  && d.target_id === targetUserId);
  const hasTalkDesire   = activeDesires.some(d => d.desire_type === 'talk_to' && d.target_id === targetUserId);
  const hasResolveDesire = activeDesires.some(d => d.desire_type === 'resolve_conflict' && d.target_id === targetUserId);

  const { isMention = false, isDM = false, isReply = false, isSleeping = false } = opts;

  // ── Sleeping — hard pings only ────────────────────────────────────────────
  if (isSleeping) {
    if (isMention || isDM || isReply) {
      return { action: 'reply', reason: 'sleeping but directly addressed' };
    }
    return { action: 'ignore', reason: 'sleeping' };
  }

  // ── Energy gate (pipeline level, not just tone) ────────────────────────────
  // Momentum override: if conversation is hot, she pushes through
  const momentumOverride = (inner.momentum || 0) >= 6;

  if (energy < 0.25 && !momentumOverride) {
    if (!isMention && !isDM && !isReply) {
      return { action: 'ignore', reason: 'exhausted — not directly addressed' };
    }
  } else if (energy < 0.45 && !momentumOverride) {
    if (!isMention && !isDM && !isReply && (psyche?.trustLevel || 3) < 4) {
      if (Math.random() > 0.25) {
        return { action: 'ignore', reason: 'drained — low priority' };
      }
    }
  }

  // ── Avoid desire overrides low intent (but not hard pings) ──────────────
  if (hasAvoidDesire && !isMention && !isDM && !isReply && intentScore < 0.70) {
    return { action: 'ignore', reason: 'desire to avoid this user' };
  }

  // ── Hard address — always respond ─────────────────────────────────────────
  if (contextForce >= 0.70 || isDM) {
    // Resolve_conflict desire: even hard pings get a warmer response signal
    const reason = hasResolveDesire ? 'directly addressed (wants to resolve)' : 'directly addressed';
    return { action: 'reply', reason };
  }

  // ── Talk_to desire lowers the threshold for engagement ────────────────────
  if (hasTalkDesire && intentScore >= 0.35) {
    return { action: 'reply', reason: 'desire to connect with this user' };
  }

  // ── Below engagement threshold — silence ──────────────────────────────────
  if (intentScore < 0.28) {
    // In evolving zone, maybe lurk instead of full ignore
    if (obsState?.zone === ZONES.EVOLVING && obsState.pullScore > 0.3) {
      return { action: 'lurk', reason: 'low intent but channel is interesting' };
    }
    return { action: 'ignore', reason: 'low intent score' };
  }

  // ── Internal drive without external trigger — initiation ──────────────────
  if (internalPressure > 0.65 && contextForce < 0.20) {
    return { action: 'initiate', reason: 'internal pressure without external trigger' };
  }

  // ── Chaos zone — react instead of full reply (lower risk) ─────────────────
  if (obsState?.zone === ZONES.CHAOS && !situation?.isDirect && socialRisk > 0.5) {
    return {
      action:  'react',
      reason:  'chaos zone — react to stay present without disrupting',
      emoji:   _pickEmoji(psyche),
    };
  }

  // ── Mid-range intent — react or reply based on score ──────────────────────
  if (intentScore < 0.50) {
    // Low-mid: react
    return {
      action:  'react',
      reason:  `moderate engagement (score=${intentScore.toFixed(2)})`,
      emoji:   _pickEmoji(psyche),
    };
  }

  // ── Identity influence ────────────────────────────────────────────────────
  // High-confidence self-beliefs (anchors) shape behavior even at moderate intent
  const identity = inner.identityCore || [];
  const isPlayfulIdentity = identity.some(b => /playful|fun|joke|humor/i.test(b.statement));
  const isSelectiveIdentity = identity.some(b => /selective|few people|choose/i.test(b.statement));

  // Desire-modulated action — if strong avoid desire, react instead of reply
  const avoidDesire = (inner.activeDesires || []).find(d => d.type === 'avoid');
  if (avoidDesire && avoidDesire.intensity > 0.6 && !situation?.isDirect) {
    return { action: 'react', reason: 'avoid desire active', emoji: '👀' };
  }

  // Selective identity + mid intent = more likely to react than reply
  if (isSelectiveIdentity && intentScore < 0.65 && !situation?.isDirect) {
    return { action: 'react', reason: 'selective identity — not compelled', emoji: '👀' };
  }

  // ── High intent — full reply ───────────────────────────────────────────────
  return { action: 'reply', reason: `high engagement (score=${intentScore.toFixed(2)})` };
}

function _pickEmoji(psyche) {
  const e = psyche?.emotions || {};
  const h = psyche?.hormones || {};

  if ((e.joy        || 0) > 0.6) return ['😂','💀','🔥'][Math.floor(Math.random()*3)];
  if ((e.affection  || 0) > 0.6) return ['🫶','❤️','😭'][Math.floor(Math.random()*3)];
  if ((e.irritation || 0) > 0.6) return ['💀','😑','🤦'][Math.floor(Math.random()*3)];
  if ((e.curiosity  || 0) > 0.6) return ['👀','🤔','💭'][Math.floor(Math.random()*3)];
  if ((h.dopamine   || 0.5) > 0.7) return ['🔥','💥','⚡'][Math.floor(Math.random()*3)];
  return ['👀','💀','😌','🫡'][Math.floor(Math.random()*4)];
}
