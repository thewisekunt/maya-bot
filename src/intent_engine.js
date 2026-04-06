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
  } = inner;

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

  // ── Hard address — always respond ─────────────────────────────────────────
  if (contextForce >= 0.70 || isDM) {
    return { action: 'reply', reason: 'directly addressed' };
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
