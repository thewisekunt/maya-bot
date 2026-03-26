/**
 * salience.js — Environmental Salience Filter
 *
 * Gate before LLM. Returns:
 *   { action: 'ignore' }
 *   { action: 'react',  emoji }
 *   { action: 'reply' }
 *
 * LURK philosophy:
 * Maya lurks like a person — she's paying attention but not spamming
 * reactions to every message. She only engages when:
 *   - something is addressed to her (name, topic she knows)
 *   - someone she knows well says something interesting
 *   - a question is asked to the group
 *   - something genuinely funny/interesting happens
 * Random group chatter → IGNORE even during lurk.
 */

const MIN_WORDS_FOR_REPLY = 3;

const IGNORE_PATTERNS = [
  /^(ok|okay|k|kk|noted|sure|yep|nope|nah|mhm|hmm+|uh+|ah+|oh+)\.?$/i,
  /^(lol|lmao|lmfao|haha|hehe|heh)\.?$/i,
  /^(same|mood|facts|true|real|based|valid|fair|gg|brb|gtg|afk|omg)\.?$/i,
  /^(bye|cya|ttyl|gn|goodnight|good night|night night)\.?$/i,
  /^(thanks|thank you|ty|thx|tysm)\.?$/i,
  /^(wow|whoa|damn|dang|oof|bruh|bro|sis|yikes)\.?$/i,
  /^\.+$|^\?+$|^!+$/,
  /^[😂💀👀🔥😭🙏👍👎❤️🤣😍🫶✨]+$/u,   // emoji-only
];

const REACT_PATTERNS = [
  /^(nice|cool|sick|fire|lit|dope|epic|pog)\.?$/i,
  /^(rip|f$|press f)\.?$/i,
  /^(gg|wp)\.?$/i,
  /^(fr|no cap|deadass)\.?$/i,
];

const FORCE_REPLY_PATTERNS = [
  /\?/,
  /\bmaya\b/i,
  /\bhelp\b|\badvice\b|\bwhat do (you|u) think\b/i,
  /\btell me\b|\bexplain\b|\bwhy\b|\bhow\b/i,
  /\bremember\b|\byou said\b|\bdidn't you\b/i,
  /\bi (love|hate|miss|need|want|feel)\b/i,
  /\bwhat('s| is| are| do)\b/i,
  /\bcan you\b|\bwill you\b|\bwould you\b/i,
];

const REACT_EMOJIS = {
  positive: ['❤️', '🔥', '💯', '✨', '🫶'],
  neutral:  ['👀', '💀', '😌', '🤝', '🫡'],
  hype:     ['🔥', '💥', '⚡'],
};

/**
 * @param {string}   text
 * @param {boolean}  isMention
 * @param {boolean}  isDM
 * @param {boolean}  isReply
 * @param {boolean}  hasMedia
 * @param {boolean}  isLurking
 * @param {number}   lurkDepth
 * @param {number}   trustLevel      1–5
 * @param {number}   entropy         0–1
 * @param {string[]} knownNames      names/aliases Maya knows in this server
 */
export function checkSalience({
  text,
  isMention  = false,
  isDM       = false,
  isReply    = false,
  hasMedia   = false,
  isLurking  = false,
  lurkDepth  = 0,
  trustLevel = 3,
  entropy    = 0.4,
  knownNames = [],    // names of people Maya knows — for name-reference detection
}) {
  const words     = text.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // ── RULE 0: Direct address — always reply ─────────────────────────────────
  if (isMention || isDM || isReply) {
    return reply(isMention ? 'direct mention' : isDM ? 'DM' : 'reply to Maya');
  }

  // ── RULE 1: Force-reply patterns ──────────────────────────────────────────
  for (const pat of FORCE_REPLY_PATTERNS) {
    if (pat.test(text)) return reply(`force: ${pat.source.slice(0,25)}`);
  }

  // ── RULE 2: Hard ignore ───────────────────────────────────────────────────
  for (const pat of IGNORE_PATTERNS) {
    if (pat.test(text.trim())) return ignore('ignore pattern');
  }

  // ── RULE 3: Lurk mode ────────────────────────────────────────────────────
  if (isLurking) {
    return evaluateLurk({ text, words, wordCount, entropy, trustLevel,
                          lurkDepth, hasMedia, knownNames });
  }

  // ── RULE 4: React patterns ────────────────────────────────────────────────
  for (const pat of REACT_PATTERNS) {
    if (pat.test(text.trim())) return react(pickEmoji('neutral'), 'react pattern');
  }

  // ── RULE 5: Short + low energy ────────────────────────────────────────────
  if (wordCount < MIN_WORDS_FOR_REPLY && entropy < 0.35) {
    return ignore('short + low entropy');
  }

  // ── RULE 6: High energy ───────────────────────────────────────────────────
  if (entropy > 0.65) return reply('high entropy');

  // ── RULE 7: Trusted + substantial ────────────────────────────────────────
  if (trustLevel >= 4 && wordCount >= 4) return reply('trusted + substantial');

  // ── Default ───────────────────────────────────────────────────────────────
  if (wordCount >= 7) return reply('enough words');
  return ignore('default: not enough signal');
}

/**
 * Lurk evaluation — Maya is watching but should NOT spam reactions.
 *
 * She engages only when:
 * 1. A question is asked to the group (she might know the answer)
 * 2. A known friend's name is mentioned (she notices)
 * 3. Something is emotionally charged or very high energy
 * 4. A close friend (trust 4+) says something substantial
 *
 * She does NOT react to every 3-word message.
 */
function evaluateLurk({ text, words, wordCount, entropy, trustLevel,
                        lurkDepth, hasMedia, knownNames }) {

  // Expired window — ignore
  if (lurkDepth >= 10) return ignore('lurk: window expired');

  // ── Always ignore these even in lurk ──────────────────────────────────────
  for (const pat of IGNORE_PATTERNS) {
    if (pat.test(text.trim())) return ignore('lurk: ignore pattern');
  }

  // ── Questions to the group — Maya might have something to add ─────────────
  // Only if it's a real question (not just "ok?")
  if (/\?/.test(text) && wordCount >= 4 && lurkDepth <= 6) {
    // React only, don't jump in with a reply unless it's very early
    if (lurkDepth <= 2 && trustLevel >= 3) return reply(`lurk: group question, fresh`);
    if (lurkDepth <= 4) return react(pickEmoji('neutral'), 'lurk: group question, mid');
    return ignore('lurk: question but too deep');
  }

  // ── Known name mentioned — she notices ────────────────────────────────────
  if (knownNames.length > 0) {
    const lowerText = text.toLowerCase();
    const mentioned = knownNames.find(n => {
      const nl = n.toLowerCase();
      return nl.length >= 3 && lowerText.includes(nl);
    });
    if (mentioned && lurkDepth <= 5) {
      // Someone mentioned a person she knows — she's paying attention
      if (wordCount >= 5) return react(pickEmoji('neutral'), `lurk: known name "${mentioned}"`);
    }
  }

  // ── Close friend says something substantial ────────────────────────────────
  if (trustLevel >= 4 && wordCount >= 6 && entropy > 0.3 && lurkDepth <= 4) {
    return react(pickEmoji('neutral'), 'lurk: trusted user, substantial');
  }

  // ── Very high energy — something interesting is happening ─────────────────
  if (entropy > 0.75 && wordCount >= 5 && lurkDepth <= 3) {
    return react(pickEmoji('hype'), 'lurk: high energy');
  }

  // ── Default: ignore — she's watching, not reacting to everything ──────────
  return ignore(`lurk: depth ${lurkDepth}, not enough signal`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function reply(reason)        { return { action: 'reply',  reason }; }
function ignore(reason)       { return { action: 'ignore', reason }; }
function react(emoji, reason) { return { action: 'react',  emoji,  reason }; }

function pickEmoji(mood = 'neutral') {
  const pool = REACT_EMOJIS[mood] || REACT_EMOJIS.neutral;
  return pool[Math.floor(Math.random() * pool.length)];
}
