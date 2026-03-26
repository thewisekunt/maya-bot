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
 *
 * LURK MODE: After Maya is mentioned, she enters a lurk window for that
 * channel. During this window she evaluates follow-up messages from the
 * same conversation without needing a new ping.
 */

const MIN_WORDS_FOR_REPLY = 2;

// ── Hard ignore — background chatter, never respond ──────────────────────────
const IGNORE_PATTERNS = [
  /^(ok|okay|k|kk|noted|sure|yep|nope|nah|mhm|hmm+|uh+|ah+|oh+)\.?$/i,
  /^(lol|lmao|lmfao|haha|hehe|heh|😂|💀|👀|🔥|😭|🙏|👍|👎|❤️|🤣)\.?$/i,
  /^(same|mood|facts|true|real|based|valid|fair|gg|brb|gtg|afk|omg)\.?$/i,
  /^(bye|cya|ttyl|gn|goodnight|good night|night night)\.?$/i,
  /^(thanks|thank you|ty|thx|tysm|thank u)\.?$/i,
  /^(wow|whoa|damn|dang|oof|bruh|bro|sis|yikes)\.?$/i,
  /^\.+$|^\?+$|^!+$/,
];

// ── React — emoji only, no words ──────────────────────────────────────────────
const REACT_PATTERNS = [
  /^(nice|cool|sick|fire|lit|dope|epic|poggers?|pog|noice)\.?$/i,
  /^(rip|f in chat|f$|press f)\.?$/i,
  /^(gg|well played|wp)\.?$/i,
  /^(ngl|tbh|imo|imho|lowkey|highkey)\s/i,
  /^(fr|fr fr|no cap|deadass|periodt?)\.?$/i,
  /\bgm\b|\bgn\b/i,
];

// ── Force reply — always respond with words ───────────────────────────────────
const FORCE_REPLY_PATTERNS = [
  /\?/,
  /\bmaya\b/i,
  /\bhelp\b|\badvice\b|\bwhat do (you|u) think\b/i,
  /\btell me\b|\bexplain\b|\bwhy\b|\bhow\b/i,
  /\bremember\b|\bdidn't you\b|\byou said\b/i,
  /\bfight\b|\bargue\b|\bdebate\b/i,
  /\bi (love|hate|miss|need|want)\b/i,
  /\bwhat('s| is| are| do)\b/i,
  /\bcan you\b|\bwill you\b|\bwould you\b/i,
];

const REACT_EMOJIS = {
  positive: ['❤️', '🔥', '💯', '😍', '✨', '🫶'],
  neutral:  ['👀', '💀', '😌', '🤝', '🫡'],
  hype:     ['🔥', '💥', '🫡', '😤', '⚡'],
  rip:      ['🫡', '💀', '😔'],
};

/**
 * Main salience decision.
 *
 * @param {string}  text
 * @param {boolean} isMention      — @mentioned directly
 * @param {boolean} isDM
 * @param {boolean} isReply        — reply to Maya's own message
 * @param {boolean} hasMedia       — message has image/embed/sticker
 * @param {boolean} isLurking      — Maya is in lurk mode for this channel
 * @param {number}  lurkDepth      — how many messages deep into lurk window (0 = just triggered)
 * @param {number}  trustLevel     — 1–5
 * @param {number}  entropy        — 0–1
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
}) {
  const words     = text.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // ── RULE 0: Direct address — ALWAYS reply with words ─────────────────────
  // isMention + hasMedia: force reply so LLM comments on the image/embed
  // isMention alone: reply
  // DM: always reply
  // Reply to Maya's own message: always reply
  if (isMention || isDM || isReply) {
    return reply(
      isMention ? (hasMedia ? 'mention+media → verbal reply' : 'direct mention')
                : isDM ? 'DM' : 'reply to Maya'
    );
  }

  // ── RULE 1: Lurk mode — Maya is paying attention to this conversation ─────
  // She was recently mentioned and is now silently watching the thread.
  // She won't spam every message, but she'll engage selectively.
  if (isLurking) {
    return evaluateLurk({ text, wordCount, entropy, trustLevel, lurkDepth, hasMedia });
  }

  // ── RULE 2: Force-reply patterns (no ping needed) ────────────────────────
  for (const pat of FORCE_REPLY_PATTERNS) {
    if (pat.test(text)) return reply(`force-reply: ${pat.source.slice(0,30)}`);
  }

  // ── RULE 3: Hard ignore ───────────────────────────────────────────────────
  for (const pat of IGNORE_PATTERNS) {
    if (pat.test(text.trim())) return ignore(`ignore pattern`);
  }

  // ── RULE 4: React patterns ────────────────────────────────────────────────
  for (const pat of REACT_PATTERNS) {
    if (pat.test(text.trim())) return react(pickEmoji('neutral'), `react pattern`);
  }

  // ── RULE 5: Short + low energy ────────────────────────────────────────────
  if (wordCount <= MIN_WORDS_FOR_REPLY && entropy < 0.35) {
    if (trustLevel >= 4) return react(pickEmoji('neutral'), 'short+trusted→react');
    return ignore('short + low entropy');
  }

  // ── RULE 6: Medium, no question ───────────────────────────────────────────
  if (wordCount <= 5 && entropy < 0.3 && !/\?/.test(text)) {
    return ignore('medium-short, low entropy, no question');
  }

  // ── RULE 7: High energy ───────────────────────────────────────────────────
  if (entropy > 0.65) return reply('high entropy');

  // ── RULE 8: Trusted + substantial ────────────────────────────────────────
  if (trustLevel >= 4 && wordCount >= 4) return reply('trusted + substantial');

  // ── Default ───────────────────────────────────────────────────────────────
  if (wordCount >= 6) return reply('enough words');
  if (wordCount >= 3) return react(pickEmoji('neutral'), 'borderline');
  return ignore('too short');
}

/**
 * Lurk mode evaluation — Maya is watching a thread she was recently in.
 * She should feel like a real person paying attention, not a bot that
 * fires on every message.
 *
 * Lurk depth: how many messages have passed since the last engagement.
 * The deeper into the lurk window, the more selective she becomes.
 *
 * Behaviour:
 *   depth 0–2  (fresh) : engage more freely — react to most, reply to rich content
 *   depth 3–5  (mid)   : only reply to questions/emotions, react to hype
 *   depth 6+   (fading): mostly ignore, rare react to very high energy
 */
function evaluateLurk({ text, wordCount, entropy, trustLevel, lurkDepth, hasMedia }) {

  // Images/embeds in an active thread always get at least a react
  if (hasMedia && lurkDepth <= 4) {
    return react(pickEmoji('neutral'), `lurk: media at depth ${lurkDepth}`);
  }

  // Questions always worth answering even mid-lurk
  if (/\?/.test(text) && lurkDepth <= 5) {
    return reply(`lurk: question at depth ${lurkDepth}`);
  }

  // Emotional or high-energy messages
  if (/\bi (love|hate|miss|feel|can't)\b/i.test(text) && lurkDepth <= 4) {
    return reply(`lurk: emotional at depth ${lurkDepth}`);
  }

  if (entropy > 0.7 && lurkDepth <= 3) {
    return reply(`lurk: high entropy at depth ${lurkDepth}`);
  }

  // Fresh lurk (0–2): react to most things
  if (lurkDepth <= 2) {
    for (const pat of IGNORE_PATTERNS) {
      if (pat.test(text.trim())) return ignore('lurk: ignore pattern even when fresh');
    }
    if (wordCount >= 3) return react(pickEmoji('neutral'), `lurk: fresh, wordcount ${wordCount}`);
    return ignore('lurk: too short even when fresh');
  }

  // Mid lurk (3–5): more selective
  if (lurkDepth <= 5) {
    if (wordCount >= 8 && entropy > 0.4) return reply(`lurk: mid, substantial message`);
    if (wordCount >= 4) return react(pickEmoji('neutral'), `lurk: mid, short reaction`);
    return ignore(`lurk: mid, not enough`);
  }

  // Deep lurk (6+): almost done paying attention
  if (entropy > 0.6 && wordCount >= 6) {
    return react(pickEmoji('neutral'), `lurk: deep, high energy`);
  }

  return ignore(`lurk: depth ${lurkDepth}, fading out`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function reply(reason)        { return { action: 'reply',  reason }; }
function ignore(reason)       { return { action: 'ignore', reason }; }
function react(emoji, reason) { return { action: 'react',  emoji,  reason }; }

function pickEmoji(mood = 'neutral') {
  const pool = REACT_EMOJIS[mood] || REACT_EMOJIS.neutral;
  return pool[Math.floor(Math.random() * pool.length)];
}
