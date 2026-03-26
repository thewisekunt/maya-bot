/**
 * salience.js — Environmental Salience Filter
 *
 * Gate that runs BEFORE the LLM.
 * Decides whether Maya should respond at all, react silently, or reply.
 *
 * Returns:
 *   { action: 'ignore' }
 *   { action: 'react',  emoji: '😂' }
 *   { action: 'reply' }
 *
 * Rules are evaluated top-to-bottom. First match wins.
 * No API calls — all local, instant.
 */

// ── Tunables (tweak via env if you want) ─────────────────────────────────────
const IGNORE_PROB_BASE   = 0.0;   // extra random-ignore chance on low-salience msgs (0 = off)
const MIN_WORDS_FOR_REPLY = 2;    // messages shorter than this lean toward react/ignore

// ── Patterns that should always be IGNORED ───────────────────────────────────
// Background chatter that needs no response from Maya
const IGNORE_PATTERNS = [
  /^(ok|okay|k|kk|noted|sure|yep|nope|nah|mhm|hmm+|uh+|ah+|oh+)\.?$/i,
  /^(lol|lmao|lmfao|haha|hehe|heh|😂|💀|👀|🔥|😭|🙏|👍|👎|❤️|🤣)\.?$/i,
  /^(same|mood|facts|true|real|based|valid|fair|gg|brb|gtg|afk|omg)\.?$/i,
  /^(bye|cya|ttyl|gn|goodnight|good night|night night)\.?$/i,
  /^(thanks|thank you|ty|thx|tysm|thank u)\.?$/i,  // thanks with no question
  /^(wow|whoa|damn|dang|oof|bruh|bro|sis|yikes)\.?$/i,
  /^\.+$|^\?+$|^!+$/,                               // just punctuation
];

// ── Patterns that deserve a REACT (emoji only, no words) ─────────────────────
const REACT_PATTERNS = [
  /^(nice|cool|sick|fire|lit|dope|epic|poggers?|pog|noice)\.?$/i,
  /^(rip|f in chat|f$|press f)\.?$/i,
  /^(gg|well played|wp)\.?$/i,
  /^(ngl|tbh|imo|imho|lowkey|highkey)\s/i,          // opinion openers, brief
  /^(fr|fr fr|no cap|deadass|periodt?)\.?$/i,
  /\bgm\b|\bgn\b/i,                                  // good morning / good night
];

// ── Patterns that ALWAYS get a REPLY (high salience) ─────────────────────────
const FORCE_REPLY_PATTERNS = [
  /\?/,                                              // any question mark
  /\bmaya\b/i,                                       // name mentioned
  /\bhelp\b|\badvice\b|\bwhat do (you|u) think\b/i, // asking for input
  /\btell me\b|\bexplain\b|\bwhy\b|\bhow\b/i,
  /\bremember\b|\bdidn't you\b|\byou said\b/i,      // calling back memory
  /\bfight\b|\bargue\b|\bdebate\b/i,
  /\bi (love|hate|miss|need|want)\b/i,               // emotional statements
  /\bwhat('s| is| are| do)\b/i,
  /\bcan you\b|\bwill you\b|\bwould you\b/i,
];

// ── Emoji-only react choices per message mood ─────────────────────────────────
const REACT_EMOJIS = {
  positive: ['❤️', '🔥', '💯', '😍', '✨', '🫶'],
  neutral:  ['👀', '💀', '😌', '🤝', '🫡'],
  hype:     ['🔥', '💥', '🫡', '😤', '⚡'],
  rip:      ['🫡', '💀', 'F', '😔'],
};

/**
 * Main salience decision function.
 *
 * @param {string}  text          — Cleaned message text (mentions stripped)
 * @param {boolean} isMention     — Was Maya directly @mentioned?
 * @param {boolean} isDM          — Is this a DM?
 * @param {boolean} isReply       — Is this a reply to Maya's message?
 * @param {number}  trustLevel    — 1–5 from relationship (higher = more likely to respond)
 * @param {number}  entropy       — 0–1 message energy estimate
 *
 * @returns {{ action: 'ignore'|'react'|'reply', emoji?: string, reason?: string }}
 */
export function checkSalience({
  text,
  isMention  = false,
  isDM       = false,
  isReply    = false,
  trustLevel = 3,
  entropy    = 0.4,
}) {
  const words    = text.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // ── Rule 0: Direct interactions always get a reply ────────────────────────
  if (isMention) return reply('direct mention');
  if (isDM)      return reply('DM always replied');
  if (isReply)   return reply('reply to Maya');

  // ── Rule 1: Force-reply patterns override everything ─────────────────────
  for (const pat of FORCE_REPLY_PATTERNS) {
    if (pat.test(text)) return reply(`force-reply pattern: ${pat}`);
  }

  // ── Rule 2: Hard ignore patterns — no response at all ────────────────────
  for (const pat of IGNORE_PATTERNS) {
    if (pat.test(text.trim())) return ignore(`ignore pattern: ${pat}`);
  }

  // ── Rule 3: React patterns — emoji only ──────────────────────────────────
  for (const pat of REACT_PATTERNS) {
    if (pat.test(text.trim())) {
      return react(pickReactEmoji('neutral'), `react pattern: ${pat}`);
    }
  }

  // ── Rule 4: Very short messages with low entropy ──────────────────────────
  if (wordCount <= MIN_WORDS_FOR_REPLY && entropy < 0.35) {
    // Short, chill message in server — probably not aimed at Maya
    // Higher trust = more likely to engage anyway
    if (trustLevel >= 4) return react(pickReactEmoji('neutral'), 'short+low-entropy but trusted');
    return ignore('short + low entropy + not trusted enough');
  }

  // ── Rule 5: Medium message, low entropy, not in question form ────────────
  if (wordCount <= 5 && entropy < 0.3 && !/\?/.test(text)) {
    return ignore('medium-short, low entropy, no question');
  }

  // ── Rule 6: High entropy / energetic = engage ────────────────────────────
  if (entropy > 0.65) return reply('high entropy message');

  // ── Rule 7: Trusted users get more engagement ────────────────────────────
  if (trustLevel >= 4 && wordCount >= 4) return reply('trusted user with enough content');

  // ── Default: reply if substantial enough, else ignore ────────────────────
  if (wordCount >= 6) return reply('default: enough words');
  if (wordCount >= 3) return react(pickReactEmoji('neutral'), 'default: borderline, react');
  return ignore('default: too short, no trigger');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function reply(reason)        { return { action: 'reply',  reason }; }
function ignore(reason)       { return { action: 'ignore', reason }; }
function react(emoji, reason) { return { action: 'react',  emoji, reason }; }

function pickReactEmoji(mood = 'neutral') {
  const pool = REACT_EMOJIS[mood] || REACT_EMOJIS.neutral;
  return pool[Math.floor(Math.random() * pool.length)];
}
