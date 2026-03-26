/**
 * lurk.js — Lurk window state manager
 *
 * After Maya is mentioned in a channel, she enters a "lurk window"
 * for that channel. During this window she silently watches the
 * conversation and can react or reply to follow-ups without being
 * pinged again.
 *
 * State is kept in-memory (per instance). This is intentional:
 *   - Lurk windows are short (minutes), not persistent state
 *   - If the instance restarts, lurk windows reset — that's fine
 *   - No DB overhead for ephemeral attention state
 *
 * For multi-instance Koyeb: each instance has its own lurk state.
 * This is acceptable — lurk is a "soft" feature, not mission-critical.
 * The worst case: one instance lurks, the other doesn't. Still better
 * than double-responding (which the DB lock prevents).
 *
 * Lurk window structure per channel:
 * {
 *   triggeredAt:  Date       — when Maya was last mentioned
 *   triggeredBy:  userId     — who triggered the lurk
 *   messageCount: number     — messages seen since trigger (depth)
 *   lastSeenAt:   Date       — last message seen in this channel
 *   expiresAt:    Date       — when lurk window ends
 * }
 */

// ── Config ────────────────────────────────────────────────────────────────────
const LURK_DURATION_MS   = 5 * 60 * 1000;   // 5 minutes after last trigger
const LURK_MAX_DEPTH     = 10;              // max messages before auto-expire
const LURK_IDLE_MS       = 3 * 60 * 1000;   // expire if channel goes quiet for 3 min

// channelId → lurk state
const lurkWindows = new Map();

/**
 * Called when Maya is mentioned in a channel.
 * Starts or resets the lurk window for that channel.
 */
export function triggerLurk(channelId, userId) {
  const now = Date.now();
  const existing = lurkWindows.get(channelId);

  lurkWindows.set(channelId, {
    triggeredAt:  now,
    triggeredBy:  userId,
    messageCount: 0,                              // reset depth on new mention
    lastSeenAt:   now,
    expiresAt:    now + LURK_DURATION_MS,
  });

  console.log(`[lurk] window ${existing ? 'reset' : 'opened'} for channel ${channelId} by ${userId}`);
}

/**
 * Check if Maya is currently lurking in a channel.
 * Also increments the depth counter and handles expiry.
 *
 * @returns {{ isLurking: boolean, lurkDepth: number }}
 */
export function checkLurk(channelId) {
  const state = lurkWindows.get(channelId);
  if (!state) return { isLurking: false, lurkDepth: 0 };

  const now = Date.now();

  // ── Expiry checks ─────────────────────────────────────────────────────────
  if (now > state.expiresAt) {
    lurkWindows.delete(channelId);
    console.log(`[lurk] window expired (time) for channel ${channelId}`);
    return { isLurking: false, lurkDepth: 0 };
  }

  if (state.messageCount >= LURK_MAX_DEPTH) {
    lurkWindows.delete(channelId);
    console.log(`[lurk] window expired (depth ${state.messageCount}) for channel ${channelId}`);
    return { isLurking: false, lurkDepth: 0 };
  }

  const idleSince = now - state.lastSeenAt;
  if (idleSince > LURK_IDLE_MS) {
    lurkWindows.delete(channelId);
    console.log(`[lurk] window expired (idle ${Math.round(idleSince/1000)}s) for channel ${channelId}`);
    return { isLurking: false, lurkDepth: 0 };
  }

  // ── Still active — increment depth ───────────────────────────────────────
  const depth = state.messageCount;
  state.messageCount += 1;
  state.lastSeenAt    = now;

  return { isLurking: true, lurkDepth: depth };
}

/**
 * Manually close the lurk window (e.g. if Maya replies verbally,
 * the window resets depth but stays open so she can keep watching).
 */
export function refreshLurk(channelId) {
  const state = lurkWindows.get(channelId);
  if (!state) return;
  // After Maya replies, reset depth so she stays attentive for
  // a few more messages in case there's a follow-up
  state.messageCount = 0;
  state.lastSeenAt   = Date.now();
  state.expiresAt    = Date.now() + LURK_DURATION_MS;
  console.log(`[lurk] window refreshed for channel ${channelId}`);
}

/**
 * Get debug info for all active lurk windows.
 */
export function getLurkStatus() {
  const out = {};
  for (const [channelId, state] of lurkWindows.entries()) {
    out[channelId] = {
      depth:     state.messageCount,
      expiresIn: Math.round((state.expiresAt - Date.now()) / 1000) + 's',
      by:        state.triggeredBy,
    };
  }
  return out;
}
