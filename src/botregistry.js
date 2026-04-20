/**
 * botregistry.js — Maya's bot awareness system
 *
 * Maya knows which bots live in each server, what they do,
 * and can parse their output into meaningful context.
 *
 * Three-tier awareness:
 *   1. Known bots (seeded + auto-discovered) — fully parsed
 *   2. Unknown bots — silently logged, added to registry over time
 *   3. Webhooks — ignored entirely
 *
 * Bot output categories:
 *   game_event   — OwO battle, gambling result, hunt — conversationally relevant
 *   transaction  — economy commands (deposit, pay, transfer) — low relevance
 *   system       — level up, welcome, role assign — informational only
 *   command_echo — the command itself ($dep, owo hunt) — ignore
 */

import db from './db.js';

// ── In-memory registry cache ──────────────────────────────────────────────────
// key: `${guildId}:${botUserId}`
const _registry  = new Map();
let _loadedAt    = 0;
const CACHE_TTL  = 10 * 60_000;  // 10 min

// ── Per-channel bot event buffer ──────────────────────────────────────────────
// Stores recent bot events for context injection
// key: channelId → [{ botName, category, summary, ts }]
const _botEvents = new Map();
const EVENT_TTL  = 15 * 60_000;  // 15 min
const EVENT_MAX  = 5;             // max events per channel

// ── Hardcoded seed registry (well-known bots) ─────────────────────────────────
// These are always available even before DB is seeded.
// guild_id: null = applies to any guild
const SEED_BOTS = [
  {
    bot_name:       'OwO',
    command_prefix: 'owo',
    bot_purpose:    'pet battles and hunting game',
    category_rules: [
      { pattern: /owo battle|battled|won the battle|lost the battle|\bvs\b.*hp/i,  category: 'game_event'   },
      { pattern: /caught a|found a|you found|hunted|owohunt/i,                     category: 'game_event'   },
      { pattern: /gained.*exp|level.*up|rank.*up/i,                                category: 'game_event'   },
      { pattern: /cowoncy|owo cash|balance/i,                                      category: 'transaction'  },
      { pattern: /^owo /i,                                                          category: 'command_echo' },
    ],
    should_track: true,
  },
  {
    bot_name:       'UnbelievaBoat',
    command_prefix: '$',
    bot_purpose:    'economy and money management',
    category_rules: [
      { pattern: /you (won|lost|gained|earned).*\$|jackpot|prize/i,    category: 'game_event'   },
      { pattern: /deposited|withdrew|transferred|paid|balance/i,       category: 'transaction'  },
      { pattern: /^\$(dep|with|pay|bal|work|crime|rob|slots|bj|cf)\b/i, category: 'command_echo' },
    ],
    should_track: true,
  },
  {
    bot_name:       'MEE6',
    command_prefix: '!',
    bot_purpose:    'moderation and leveling',
    category_rules: [
      { pattern: /level.*up|reached level|new role/i,   category: 'system'       },
      { pattern: /muted|warned|kicked|banned/i,          category: 'system'       },
      { pattern: /^!/i,                                   category: 'command_echo' },
    ],
    should_track: false,  // level ups aren't conversationally interesting
  },
  {
    bot_name:       'Dank Memer',
    command_prefix: 'pls',
    bot_purpose:    'memes and economy',
    category_rules: [
      { pattern: /robbed|stole|heist|won|lost.*coins/i,  category: 'game_event'   },
      { pattern: /^pls /i,                                category: 'command_echo' },
    ],
    should_track: true,
  },
  {
    bot_name:       'Ticket Tool',
    command_prefix: null,
    bot_purpose:    'ticket management',
    category_rules: [
      { pattern: /.*/,  category: 'system' },
    ],
    should_track: false,
  },
  {
    bot_name:       'Carl-bot',
    command_prefix: '!',
    bot_purpose:    'moderation and automod',
    category_rules: [
      { pattern: /.*/,  category: 'system' },
    ],
    should_track: false,
  },
];

// Build a lookup by common bot username patterns
const SEED_NAME_PATTERNS = [
  { pattern: /^owo$/i,                    seed: SEED_BOTS[0] },
  { pattern: /unbelievaboat/i,            seed: SEED_BOTS[1] },
  { pattern: /mee6/i,                     seed: SEED_BOTS[2] },
  { pattern: /dank memer/i,               seed: SEED_BOTS[3] },
  { pattern: /ticket tool/i,              seed: SEED_BOTS[4] },
  { pattern: /carl(-bot)?/i,              seed: SEED_BOTS[5] },
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Process a bot message. Main entry point.
 * Returns a BotEvent if the message is worth tracking, null otherwise.
 *
 * @param {Message} msg  Discord.js message (msg.author.bot must be true)
 * @returns {{ botName, category, summary, shouldTrack } | null}
 */
export async function processBotMessage(msg) {
  if (!msg.author.bot) return null;

  const botId    = msg.author.id;
  const botName  = msg.author.username || msg.author.globalName || 'Unknown Bot';
  const guildId  = msg.guild?.id || null;
  const content  = msg.content || '';
  const embeds   = msg.embeds || [];

  // Combine text content and embed descriptions for parsing
  const fullText = [
    content,
    ...embeds.map(e => [e.title, e.description, ...(e.fields || []).map(f => `${f.name}: ${f.value}`)].filter(Boolean).join(' ')),
  ].filter(Boolean).join(' ').trim();

  if (!fullText) return null;

  // ── Look up bot in registry ───────────────────────────────────────────────
  const entry = await _lookupBot(botId, botName, guildId);

  if (!entry) {
    // Unknown bot — silently log for auto-discovery
    _logUnknownBot(botId, botName, guildId).catch(() => {});
    return null;
  }

  // ── Classify the output ───────────────────────────────────────────────────
  const category = _classify(fullText, entry.category_rules);

  // command_echo: the human's own command line — never interesting
  if (category === 'command_echo') return null;
  // system: informational only — skip unless should_track
  if (category === 'system' && !entry.should_track) return null;
  // transaction: skip — not conversationally interesting
  if (category === 'transaction') return null;

  if (!entry.should_track) return null;

  // ── Build a human-readable summary ───────────────────────────────────────
  const summary = _summarize(fullText, entry.bot_name, category);
  if (!summary) return null;

  console.log(`[botregistry] ${entry.bot_name} → ${category}: ${summary.slice(0, 80)}`);

  return {
    botId,
    botName:     entry.bot_name,
    botPurpose:  entry.bot_purpose,
    category,
    summary,
    fullText:    fullText.slice(0, 300),
    shouldTrack: entry.should_track,
    ts:          Date.now(),
  };
}

/**
 * Record a bot event into the channel's event buffer.
 * Called after processBotMessage returns a non-null event.
 */
export function recordBotEvent(channelId, event) {
  if (!channelId || !event) return;

  if (!_botEvents.has(channelId)) _botEvents.set(channelId, []);
  const ch = _botEvents.get(channelId);

  // Prune stale events
  const now = Date.now();
  const fresh = ch.filter(e => now - e.ts < EVENT_TTL);

  fresh.push(event);
  if (fresh.length > EVENT_MAX) fresh.shift();

  _botEvents.set(channelId, fresh);
}

/**
 * Get recent bot events for a channel — for context injection.
 * Returns a formatted string or null if no recent events.
 */
export function getBotContext(channelId) {
  const events = _botEvents.get(channelId);
  if (!events?.length) return null;

  const now    = Date.now();
  const recent = events
    .filter(e => now - e.ts < EVENT_TTL)
    .slice(-3);  // last 3 events max

  if (!recent.length) return null;

  const lines = recent.map(e => {
    const age = _relTime(now - e.ts);
    return `• ${e.summary} [${age}]`;
  });

  return `--- Recent bot activity ---\n${lines.join('\n')}`;
}

/**
 * Check if a message from a human looks like a bot command.
 * Used to pre-filter before NLP so NLP doesn't misclassify commands.
 */
export function looksLikeBotCommand(content) {
  if (!content) return false;
  const t = content.trim();
  // Common bot command prefixes
  return /^(\$|!|owo |pls |o!|r!|m!|-|\.|\?|=|>|>>|,|;)[a-z]/i.test(t) ||
         /^(owo|pls|owo!)\s/i.test(t);
}

// ── Internals ─────────────────────────────────────────────────────────────────

async function _lookupBot(botId, botName, guildId) {
  // 1. Check seed registry by username pattern (no DB needed)
  for (const { pattern, seed } of SEED_NAME_PATTERNS) {
    if (pattern.test(botName)) return seed;
  }

  // 2. Check DB registry
  await _ensureLoaded();
  const key = `${guildId}:${botId}`;
  const globalKey = `null:${botId}`;
  return _registry.get(key) || _registry.get(globalKey) || null;
}

async function _ensureLoaded() {
  if (Date.now() - _loadedAt < CACHE_TTL) return;
  try {
    const [rows] = await db.execute(
      `SELECT bot_user_id, bot_name, bot_purpose, command_prefix,
              output_pattern, should_track, guild_id
       FROM maya_known_bots WHERE should_track = 1`
    );
    _registry.clear();
    for (const r of rows) {
      const key = `${r.guild_id}:${r.bot_user_id}`;
      _registry.set(key, {
        bot_name:       r.bot_name,
        bot_purpose:    r.bot_purpose,
        command_prefix: r.command_prefix,
        should_track:   Boolean(r.should_track),
        category_rules: r.output_pattern
          ? [{ pattern: new RegExp(r.output_pattern, 'i'), category: 'game_event' }]
          : [],
      });
    }
    _loadedAt = Date.now();
  } catch { /* non-fatal — seed registry still works */ }
}

async function _logUnknownBot(botId, botName, guildId) {
  // Auto-discover unknown bots — logged to DB for future seeding
  try {
    await db.execute(
      `INSERT INTO maya_known_bots
         (bot_user_id, bot_name, guild_id, should_track, bot_purpose, command_prefix)
       VALUES (?, ?, ?, 0, 'unknown', NULL)
       ON DUPLICATE KEY UPDATE bot_name=VALUES(bot_name)`,
      [botId, botName?.slice(0, 100), guildId]
    );
  } catch { /* non-fatal */ }
}

function _classify(text, rules) {
  for (const { pattern, category } of rules) {
    if (pattern.test(text)) return category;
  }
  return 'game_event';  // default for known bots
}

function _summarize(text, botName, category) {
  // Clean up common bot output artifacts
  const clean = text
    .replace(/<@!?\d+>/g, match => {
      // Keep @mentions readable
      return match;
    })
    .replace(/\*\*/g, '')    // strip bold
    .replace(/__/g, '')      // strip underline
    .replace(/`{1,3}/g, '')  // strip code blocks
    .replace(/\n+/g, ' ')   // flatten newlines
    .trim()
    .slice(0, 150);

  if (!clean) return null;
  return `${botName}: ${clean}`;
}

function _relTime(ms) {
  if (ms < 60_000)  return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3600_000)}h ago`;
}
