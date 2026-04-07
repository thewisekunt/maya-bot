/**
 * roam.js — Maya's channel browsing tool
 *
 * Lets Maya fetch recent messages from other channels in the same guild
 * to improve context. Used by the inner voice tool plan.
 *
 * Use cases:
 *   - "there's an announcement in #announcements" → fetch it
 *   - "did you see what happened in #general?" → fetch recent
 *   - Someone references a conversation in another channel → read it
 *   - Maya wants to know what's happening before engaging
 *
 * Rate-limited and cached to avoid API spam.
 * Only fetches channels Maya already has access to (no permission escalation).
 *
 * Returns formatted context strings ready to inject into the LLM prompt.
 */

import db from './db.js';

// ── Rate limiting ─────────────────────────────────────────────────────────────
const _cache    = new Map();  // channelId → { messages, ts }
const CACHE_TTL = 3 * 60 * 1000;  // 3 min — don't hammer the API
const RATE_LIMIT = new Map();  // channelId → last fetch timestamp
const MIN_INTERVAL = 30 * 1000;  // 30s between fetches of same channel

// ── Main fetch ────────────────────────────────────────────────────────────────

/**
 * Fetch recent messages from a channel.
 * Returns a formatted string for LLM context injection.
 *
 * @param {Client}  client
 * @param {string}  channelId     — channel to read
 * @param {string}  sourceGuildId — guild Maya is currently in (safety check)
 * @param {number}  limit         — how many messages to fetch (max 15)
 * @param {string}  reason        — why Maya is roaming (for logging)
 * @returns {string|null}
 */
export async function fetchChannelContext(client, channelId, sourceGuildId, limit = 10, reason = '') {
  if (!client || !channelId) return null;
  limit = Math.min(limit, 15);

  // Rate limit check
  const lastFetch = RATE_LIMIT.get(channelId) || 0;
  if (Date.now() - lastFetch < MIN_INTERVAL) {
    // Return cached version if available
    const cached = _cache.get(channelId);
    if (cached) return cached.formatted;
    return null;
  }

  // Cache hit
  const cached = _cache.get(channelId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.formatted;
  }

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return null;

    // Safety: only read channels in the same guild
    if (channel.guildId && channel.guildId !== sourceGuildId) {
      console.warn(`[roam] blocked cross-guild read: ${channelId}`);
      return null;
    }

    // Fetch messages
    const messages = await channel.messages.fetch({ limit }).catch(() => null);
    if (!messages?.size) return null;

    RATE_LIMIT.set(channelId, Date.now());

    // Format for LLM consumption
    const formatted = _formatMessages(messages, channel.name || channelId, reason);
    _cache.set(channelId, { formatted, ts: Date.now() });

    console.log(`[roam] fetched #${channel.name || channelId}: ${messages.size} messages (${reason})`);
    return formatted;

  } catch (e) {
    console.warn('[roam] fetch failed:', e.message);
    return null;
  }
}

/**
 * Find and fetch a channel by name or type hint.
 * Used when the message references "the announcements" or "#general".
 *
 * @param {Client}  client
 * @param {string}  guildId
 * @param {string}  hint      — "announcements", "general", "media", etc.
 * @param {number}  limit
 * @returns {string|null}
 */
export async function fetchChannelByName(client, guildId, hint, limit = 8) {
  if (!client || !guildId || !hint) return null;

  try {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return null;

    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) return null;

    // Find matching channel (text channels only)
    const normalHint = hint.toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = channels.find(ch =>
      ch?.isText?.() &&
      ch.name?.toLowerCase().replace(/[^a-z0-9]/g, '').includes(normalHint)
    );

    if (!match) return null;
    return fetchChannelContext(client, match.id, guildId, limit, `searching for "${hint}"`);

  } catch (e) {
    console.warn('[roam] name search failed:', e.message);
    return null;
  }
}

/**
 * List accessible text channels in a guild.
 * Used by inner voice to know what channels are available to roam.
 *
 * @returns {Array<{ id, name, topic }>}
 */
export async function listAccessibleChannels(client, guildId) {
  if (!client || !guildId) return [];
  try {
    const guild    = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return [];
    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) return [];

    return channels
      .filter(ch => ch?.isText?.())
      .map(ch => ({ id: ch.id, name: ch.name, topic: ch.topic?.slice(0, 80) }))
      .slice(0, 20);
  } catch { return []; }
}

/**
 * Fetch a DM channel with a specific user.
 * Used when inner voice decides Maya needs more context from a past DM.
 */
export async function fetchDMContext(client, userId, limit = 8) {
  if (!client || !userId) return null;
  try {
    const user   = await client.users.fetch(userId).catch(() => null);
    if (!user) return null;
    const dmChan = await user.createDM().catch(() => null);
    if (!dmChan) return null;

    return fetchChannelContext(client, dmChan.id, null, limit, 'DM context lookup');
  } catch { return null; }
}

// ── Format ────────────────────────────────────────────────────────────────────

function _formatMessages(messages, channelName, reason) {
  const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const lines = sorted
    .filter(m => m.content || m.embeds?.length || m.attachments?.size)
    .map(m => {
      const name    = m.member?.displayName || m.author?.username || 'unknown';
      const content = m.content?.slice(0, 200) || (m.embeds?.length ? '[embed]' : '[media]');
      const ts      = _relTime(m.createdTimestamp);
      return `  ${name} [${ts}]: ${content}`;
    })
    .join('\n');

  return `[Channel context from #${channelName}${reason ? ` — ${reason}` : ''}:\n${lines}]`;
}

function _relTime(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60)    return `${Math.floor(diff)}s ago`;
  if (diff < 3600)  return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return `${Math.floor(diff/86400)}d ago`;
}
