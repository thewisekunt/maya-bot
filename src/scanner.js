/**
 * scanner.js — Environmental Salience Scanner
 *
 * Watches EVERY message in allowed channels.
 * Pure pattern matching — no LLM, no NLP, no DB reads.
 * Sub-millisecond per message.
 *
 * Emits a notification when a message matches:
 *   1. @mention of Maya
 *   2. The word "maya" (case-insensitive, word boundary)
 *   3. Any registered alias (loaded from DB at startup, refreshed every 5 min)
 *   4. DM (always a notification)
 *
 * Does NOT decide whether to reply — that's notif.js's job.
 * Does NOT filter channels — caller does that.
 */

import db from './db.js';
import { config } from './config.js';

// ── Alias cache ───────────────────────────────────────────────────────────────
// Loaded from DB at startup and refreshed every 5 min.
// Stored as an array of lowercase strings for fast iteration.
let _aliases      = [];
let _aliasRefresh = 0;
const ALIAS_TTL   = 5 * 60_000;

// Static aliases from env (always checked, no DB needed)
const STATIC_ALIASES = config.bot.aliases || [];

/**
 * Load/refresh aliases from DB.
 * Merges DB aliases + static env aliases + hardcoded "maya".
 */
export async function refreshAliases(guildId) {
  const now = Date.now();
  if (now - _aliasRefresh < ALIAS_TTL) return;  // still fresh

  try {
    // Only load aliases for Maya's bot identity (discord_user_id = 'maya_bot')
    // NOT user aliases — those are for mapping human names to users
    // Maya's own aliases: hardcoded + env BOT_ALIASES only
    // DB lookup kept for future: custom server nicknames for the bot
    _aliases = [
      ...new Set([
        'maya',
        'delelumaya',
        ...STATIC_ALIASES,
      ])
    ].filter(a => a.length >= 3);
    _aliasRefresh = now;
    console.log(`[scanner] aliases loaded: ${_aliases.slice(0, 8).join(', ')}${_aliases.length > 8 ? '...' : ''}`);
  } catch (e) {
    console.error('[scanner] alias refresh failed:', e.message);
  }
}

/**
 * Scan a message and return a notification if it matches.
 *
 * @param {Message} msg          Discord.js message
 * @param {string}  botUserId    Bot's own Discord user ID
 *
 * @returns {Notification | null}
 *
 * Notification shape:
 * {
 *   msg,           — the triggering message
 *   triggerType,   — 'mention' | 'keyword' | 'alias' | 'dm'
 *   triggerWord,   — what matched (e.g. 'maya', 'delu')
 *   channelId,
 *   guildId,
 *   userId,
 *   isDM,
 * }
 */
export function scan(msg, botUserId) {
  const content   = msg.content || '';
  const channelId = msg.channel.id;
  const guildId   = msg.guild?.id || null;
  const userId    = msg.author.id;
  const isDM      = !msg.guild;

  const base = { msg, channelId, guildId, userId, isDM };

  // DM — always a notification
  if (isDM) {
    return { ...base, triggerType: 'dm', triggerWord: 'dm' };
  }

  // @mention
  if (msg.mentions?.users?.has(botUserId)) {
    return { ...base, triggerType: 'mention', triggerWord: '@mention' };
  }

  // Alias scan (includes "maya" as first alias)
  const lower = content.toLowerCase();
  for (const alias of _aliases) {
    // Word boundary check: not part of a longer word
    const idx = lower.indexOf(alias);
    if (idx === -1) continue;
    const before = idx === 0 ? ' ' : lower[idx - 1];
    const after  = idx + alias.length >= lower.length ? ' ' : lower[idx + alias.length];
    const wordBoundary = !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
    if (wordBoundary) {
      return {
        ...base,
        triggerType: alias === 'maya' ? 'keyword' : 'alias',
        triggerWord: alias,
      };
    }
  }

  return null;   // no match
}

export function getAliases() { return [..._aliases]; }
