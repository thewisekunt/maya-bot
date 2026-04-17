/**
 * user_state.js — Per-user interaction state machine
 *
 * Tracks Maya's willingness to engage with a specific user within a channel.
 * States escalate on negative signals; de-escalate on positive interactions or time.
 *
 * States:
 *   normal    — reply normally
 *   cautious  — still replying but wary; IV prefers terse responses
 *   withdrawn — minimal engagement; only reply to direct questions at high trust
 *   blocked   — don't reply at all, regardless of pings/mentions
 *
 * Set via:
 *   - IV personality mode decision (analyzeConvo tool returns 'withdraw'/'leave')
 *   - Direct call from handler when spamguard penalty is high
 *   - Auto-escalation when same pattern repeats N times
 *
 * Auto-decays to 'normal' after DECAY_MS of no contact from that user.
 */

import { PERSONALITY_MODE } from './personality_modes.js';

// key: `${channelId}:${userId}`  value: { state, escalations, lastEscalated, lastContact }
const _states = new Map();

const STATES = { NORMAL: 'normal', CAUTIOUS: 'cautious', WITHDRAWN: 'withdrawn', BLOCKED: 'blocked' };
export { STATES as USER_STATES };

const DECAY_MS = {
  cautious:  10 * 60 * 1000,  // 10 min quiet → back to normal
  withdrawn: 30 * 60 * 1000,  // 30 min quiet → back to cautious
  blocked:   60 * 60 * 1000,  // 60 min quiet → back to withdrawn (not normal — needs explicit reset)
};

const ESCALATION_PATH = [STATES.NORMAL, STATES.CAUTIOUS, STATES.WITHDRAWN, STATES.BLOCKED];

function _key(channelId, userId) { return `${channelId}:${userId}`; }

function _get(channelId, userId) {
  const k = _key(channelId, userId);
  if (!_states.has(k)) {
    _states.set(k, { state: STATES.NORMAL, escalations: 0, lastEscalated: 0, lastContact: Date.now() });
  }
  return _states.get(k);
}

/**
 * Get current state — also applies time-based decay.
 */
export function getUserState(channelId, userId) {
  const s   = _get(channelId, userId);
  const now = Date.now();
  const quiet = now - s.lastContact;

  if (s.state !== STATES.NORMAL) {
    const decayMs = DECAY_MS[s.state];
    if (decayMs && quiet > decayMs) {
      const prev = s.state;
      const idx  = ESCALATION_PATH.indexOf(s.state);
      s.state    = ESCALATION_PATH[Math.max(0, idx - 1)];
      s.lastEscalated = 0;
      console.log(`[user_state] ${userId} decay: ${prev} → ${s.state} (quiet ${Math.round(quiet/60000)}min)`);
    }
  }

  return s.state;
}

/**
 * Record a contact (any message from this user to Maya).
 * Updates lastContact for decay tracking.
 */
export function recordContact(channelId, userId) {
  const s = _get(channelId, userId);
  s.lastContact = Date.now();
}

/**
 * Escalate this user's state (normal→cautious→withdrawn→blocked).
 * Called by handler when IV/analyzeConvo signals a problem.
 * @param {string} reason — logged
 * @param {boolean} force — skip one step and go directly to 'blocked'
 */
export function escalateUser(channelId, userId, reason = '', force = false) {
  const s   = _get(channelId, userId);
  const now = Date.now();
  s.escalations++;
  s.lastEscalated = now;

  const idx     = ESCALATION_PATH.indexOf(s.state);
  const newIdx  = force ? ESCALATION_PATH.length - 1 : Math.min(idx + 1, ESCALATION_PATH.length - 1);
  const prev    = s.state;
  s.state       = ESCALATION_PATH[newIdx];

  console.log(`[user_state] ${userId} escalate: ${prev} → ${s.state} (reason: ${reason || 'unspecified'} escalations=${s.escalations})`);
  return s.state;
}

/**
 * Reset a user back to normal (called on positive interaction).
 */
export function resetUser(channelId, userId) {
  const s = _get(channelId, userId);
  if (s.state !== STATES.NORMAL) {
    console.log(`[user_state] ${userId} reset: ${s.state} → normal`);
    s.state = STATES.NORMAL;
    s.escalations = 0;
  }
}

/**
 * Map user state to personality mode for IV.
 * withdrawn/blocked → WITHDRAW/SILENT
 */
export function stateToPersonalityMode(state) {
  if (state === STATES.BLOCKED)   return PERSONALITY_MODE.SILENT;
  if (state === STATES.WITHDRAWN) return PERSONALITY_MODE.WITHDRAW;
  if (state === STATES.CAUTIOUS)  return PERSONALITY_MODE.DEFENSE;
  return PERSONALITY_MODE.NORMAL;
}
