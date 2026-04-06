/**
 * notification.js — Tier 1: Hard notification pipeline
 *
 * Handles only the messages that MUST reach Maya regardless of state:
 *   @mention, @reply to Maya, DM, role pings, @here/@everyone
 *
 * These bypass observation entirely. They go directly to inner_voice.js.
 * Everything else goes to observation.js.
 *
 * Structure matches Discord's own notification model:
 *   humans get a badge + sound for these, nothing for the rest.
 */

import { getAliases } from './scanner.js';

// ── Notification types with urgency scores ────────────────────────────────────
// urgency 0–1: how much this demands an immediate response
export const NOTIF_TYPES = {
  dm:           { urgency: 0.95, label: 'DM' },
  mention:      { urgency: 0.85, label: '@mention' },
  reply:        { urgency: 0.80, label: 'reply to Maya' },
  role_ping:    { urgency: 0.60, label: 'role ping' },
  here_everyone:{ urgency: 0.50, label: '@here/@everyone' },
  alias:        { urgency: 0.70, label: 'name mention' },
  keyword:      { urgency: 0.55, label: 'keyword trigger' },
};

/**
 * Parse a Discord message into a structured notification.
 * Returns null if the message is NOT a hard notification —
 * it should go to observation.js instead.
 *
 * @param {Message} msg
 * @param {string}  botUserId
 * @param {string|null} lastMayaMsgId — ID of Maya's last message (for reply detection)
 * @returns {object|null}
 */
export function parseNotification(msg, botUserId, lastMayaMsgId = null) {
  const content   = msg.content || '';
  const channelId = msg.channel.id;
  const guildId   = msg.guild?.id || null;
  const userId    = msg.author.id;
  const isDM      = !msg.guild;

  const base = {
    msg, channelId, guildId, userId, isDM,
    content, timestamp: msg.createdTimestamp || Date.now(),
  };

  // ── DM — always tier 1 ────────────────────────────────────────────────────
  if (isDM) {
    return { ...base, ...NOTIF_TYPES.dm, type: 'dm', triggerType: 'dm' };
  }

  // ── @mention of Maya ──────────────────────────────────────────────────────
  if (msg.mentions?.users?.has(botUserId)) {
    return { ...base, ...NOTIF_TYPES.mention, type: 'mention', triggerType: 'mention' };
  }

  // ── Reply to Maya's message ───────────────────────────────────────────────
  if (msg.reference?.messageId) {
    // We'll check if the referenced message is Maya's in index.js
    // Flag it here so the caller can complete the check with a fetch
    base._checkReply = true;
  }

  // ── Role ping / @here / @everyone ─────────────────────────────────────────
  if (msg.mentions?.everyone) {
    return { ...base, ...NOTIF_TYPES.here_everyone, type: 'here_everyone', triggerType: 'here_everyone' };
  }
  if (msg.mentions?.roles?.size > 0) {
    return { ...base, ...NOTIF_TYPES.role_ping, type: 'role_ping', triggerType: 'role_ping' };
  }

  // ── Alias / name mention ───────────────────────────────────────────────────
  const lower  = content.toLowerCase();
  const aliases = getAliases();
  for (const alias of aliases) {
    const idx = lower.indexOf(alias);
    if (idx === -1) continue;
    const before = idx === 0 ? ' ' : lower[idx - 1];
    const after  = idx + alias.length >= lower.length ? ' ' : lower[idx + alias.length];
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
      const type = alias === 'maya' ? 'keyword' : 'alias';
      return { ...base, ...NOTIF_TYPES[type], type, triggerType: type, triggerWord: alias };
    }
  }

  // ── Not a hard notification — goes to observation ─────────────────────────
  return null;
}

/**
 * Complete the reply check that requires a message fetch.
 * Call after parseNotification if _checkReply is true.
 */
export async function resolveReplyNotif(partialNotif, botUserId) {
  const { msg } = partialNotif;
  if (!msg.reference?.messageId) return null;
  try {
    const ref = await msg.channel.messages.fetch(msg.reference.messageId);
    if (ref?.author?.id === botUserId) {
      return { ...partialNotif, ...NOTIF_TYPES.reply, type: 'reply', triggerType: 'reply' };
    }
  } catch { /* non-fatal */ }
  return null;
}
