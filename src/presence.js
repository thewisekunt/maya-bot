/**
 * presence.js — Maya's Conversational Presence Engine
 *
 * Replaces both salience.js and lurk.js.
 *
 * The core question is no longer "should I respond to this message?"
 * It's "does this conversation need me right now?"
 *
 * Three modes per channel (auto-managed):
 *   PASSIVE   — default. Only responds when directly addressed.
 *   OBSERVING — post-mention. Watching, builds memory, rarely speaks.
 *   ENGAGED   — active back-and-forth with a user. More responsive.
 *
 * Decision flow:
 *   1. Hard rules (DM, cooldown, spam guard) → instant ignore
 *   2. Intent detection → classify why this message exists
 *   3. Conversation state → how active/fast is this channel right now?
 *   4. Silence score vs Expression score → who wins?
 *   5. Mode gate → does the mode allow this level of engagement?
 *
 * Returns: { action: 'ignore' | 'react' | 'reply', reason, score }
 */

// ── Per-channel state ─────────────────────────────────────────────────────────
// channelId → ChannelState
const channels = new Map();

const MODES = { PASSIVE: 0, OBSERVING: 1, ENGAGED: 2 };

function getChannel(channelId) {
  if (!channels.has(channelId)) {
    channels.set(channelId, {
      mode:            MODES.PASSIVE,
      modeSetAt:       0,
      lastMayaReply:   0,      // timestamp of last reply
      lastMayaReact:   0,      // timestamp of last reaction
      recentMessages:  [],     // last 12 message timestamps (for velocity)
      recentSpeakers:  [],     // last 6 speaker IDs (for conversation awareness)
      lastSpeakerId:   null,   // who spoke last
      engagedUserId:   null,   // who Maya is currently engaged with
      mentionCount:    0,      // mentions since mode set
    });
  }
  return channels.get(channelId);
}

// ── Cooldowns ─────────────────────────────────────────────────────────────────
const COOLDOWN_REPLY_MS  = 25_000;   // 25s between replies in same channel
const COOLDOWN_REACT_MS  = 8_000;    // 8s between reactions
const ENGAGED_REPLY_MS   = 8_000;    // shorter cooldown when engaged
const MODE_OBSERVING_TTL = 5 * 60_000;   // 5 min observing after mention
const MODE_ENGAGED_TTL   = 3 * 60_000;   // 3 min engaged after direct exchange

// ── Public: update state on every message ────────────────────────────────────

/**
 * Call this for EVERY message in a channel Maya sees,
 * before the salience decision. Updates velocity tracking.
 */
export function observeMessage(channelId, userId, isMayaReply = false) {
  const ch = getChannel(channelId);
  const now = Date.now();

  // Track velocity (prune messages older than 60s)
  ch.recentMessages = ch.recentMessages.filter(t => now - t < 60_000);
  ch.recentMessages.push(now);

  // Track speakers (prune older than 5 messages)
  if (!isMayaReply) {
    ch.recentSpeakers = [...ch.recentSpeakers.slice(-5), userId];
    ch.lastSpeakerId = userId;
  }

  // Auto-decay modes
  if (ch.mode === MODES.OBSERVING && now - ch.modeSetAt > MODE_OBSERVING_TTL) {
    ch.mode = MODES.PASSIVE;
  }
  if (ch.mode === MODES.ENGAGED && now - ch.modeSetAt > MODE_ENGAGED_TTL) {
    ch.mode = MODES.OBSERVING;
  }
}

/**
 * Call when Maya is @mentioned. Escalates to OBSERVING mode.
 */
export function onMention(channelId, byUserId) {
  const ch = getChannel(channelId);
  const now = Date.now();
  ch.mode        = MODES.OBSERVING;
  ch.modeSetAt   = now;
  ch.mentionCount++;
  console.log(`[presence] channel ${channelId} → OBSERVING (mention by ${byUserId})`);
}

/**
 * Call when Maya sends a reply. Escalates to ENGAGED with that user.
 */
export function onMayaReply(channelId, toUserId) {
  const ch = getChannel(channelId);
  const now = Date.now();
  ch.lastMayaReply = now;
  ch.mode          = MODES.ENGAGED;
  ch.modeSetAt     = now;
  ch.engagedUserId = toUserId;
  console.log(`[presence] channel ${channelId} → ENGAGED with ${toUserId}`);
}

/**
 * Call when Maya reacts.
 */
export function onMayaReact(channelId) {
  const ch = getChannel(channelId);
  ch.lastMayaReact = Date.now();
}

// ── Main decision function ────────────────────────────────────────────────────

/**
 * @param {object} params
 *   channelId    string
 *   userId       string   — who sent the message
 *   text         string   — cleaned message text
 *   isMention    boolean  — @Maya
 *   isDM         boolean
 *   isReply      boolean  — reply to Maya's message
 *   hasMedia     boolean
 *   trustLevel   number   1–5
 *   entropy      number   0–1
 *   knownNames   string[] — aliases Maya knows
 *
 * @returns {{ action: 'ignore'|'react'|'reply', reason: string, score: number }}
 */
export function decide({
  channelId,
  userId,
  text,
  isMention  = false,
  isDM       = false,
  isReply    = false,
  hasMedia   = false,
  trustLevel = 3,
  entropy    = 0.4,
  knownNames = [],
}) {
  // DMs bypass everything — always reply
  if (isDM) return _reply('DM', 10);

  const ch    = getChannel(channelId);
  const now   = Date.now();
  const words = text.trim().split(/\s+/).filter(Boolean);
  const wc    = words.length;

  // ── 1. HARD STOPS ─────────────────────────────────────────────────────────

  // Spam guard: Maya just replied, channel is still cooling down
  const replyCooldown = ch.mode === MODES.ENGAGED ? ENGAGED_REPLY_MS : COOLDOWN_REPLY_MS;
  if (!isMention && !isReply && now - ch.lastMayaReply < replyCooldown) {
    return _ignore(`cooldown: ${Math.round((replyCooldown - (now - ch.lastMayaReply))/1000)}s left`);
  }

  // Don't reply twice in a row (last speaker was Maya)
  // Exception: if user directly mentions/replies
  if (!isMention && !isReply && ch.lastSpeakerId === 'maya') {
    return _ignore('no double-reply: Maya spoke last');
  }

  // React cooldown
  const recentlyReacted = now - ch.lastMayaReact < COOLDOWN_REACT_MS;

  // ── 2. INTENT DETECTION ───────────────────────────────────────────────────
  const intent = _detectIntent(text, isMention, isReply, ch, userId, knownNames);

  // ── 3. CONVERSATION STATE ─────────────────────────────────────────────────
  const velocity    = _getVelocity(ch);    // msgs/min in last 60s
  const isHotConvo  = velocity >= 8;       // fast back-and-forth (8+ msgs/min)
  const isDeadConvo = velocity <= 1;

  // Active convo between others — Maya should observe, not barge in
  const uniqueSpeakers = new Set(ch.recentSpeakers.slice(-6)).size;
  const isGroupConvo = uniqueSpeakers >= 3 && !isMention;

  // ── 4. SILENCE vs EXPRESSION SCORE ───────────────────────────────────────
  let expressScore = 0;
  let silenceScore = 0;

  // Expression signals
  if (isMention)                          expressScore += 8;
  if (isReply)                            expressScore += 7;
  if (intent === 'question_to_maya')      expressScore += 6;
  if (intent === 'emotional')             expressScore += 4;
  if (intent === 'question_to_group')     expressScore += 2;
  if (intent === 'known_name_mentioned')  expressScore += 2;
  if (trustLevel >= 4)                    expressScore += 1;
  if (isDeadConvo && ch.mode >= MODES.OBSERVING) expressScore += 2;
  if (hasMedia && ch.mode >= MODES.OBSERVING)    expressScore += 1;
  if (entropy > 0.6)                             expressScore += 1;

  // Silence signals
  if (isHotConvo)                         silenceScore += 5;
  if (isGroupConvo)                       silenceScore += 4;
  if (intent === 'group_chatter')         silenceScore += 4;
  if (intent === 'directed_at_other')     silenceScore += 5;
  if (intent === 'random_mention')        silenceScore += 3;
  if (ch.mode === MODES.PASSIVE && !isMention) silenceScore += 4;
  if (wc < 3 && entropy < 0.3)           silenceScore += 2;
  if (recentlyReacted)                    silenceScore += 3;

  const netScore = expressScore - silenceScore;

  // ── 5. MODE GATE ──────────────────────────────────────────────────────────
  let threshold;
  switch (ch.mode) {
    case MODES.PASSIVE:   threshold = 7;   break;  // very selective
    case MODES.OBSERVING: threshold = 4;   break;  // somewhat selective
    case MODES.ENGAGED:   threshold = 2;   break;  // responsive
  }

  const modeLabel = ['PASSIVE','OBSERVING','ENGAGED'][ch.mode];

  if (netScore < threshold) {
    return _ignore(`score ${netScore} < threshold ${threshold} (${modeLabel}, intent=${intent})`);
  }

  // ── 6. WHAT KIND OF RESPONSE? ─────────────────────────────────────────────

  // Strong signal → reply
  if (netScore >= 6 || isMention || isReply || intent === 'question_to_maya') {
    return _reply(`score=${netScore} intent=${intent} mode=${modeLabel}`, netScore);
  }

  // Medium signal → react (if not on cooldown)
  if (netScore >= threshold && !recentlyReacted) {
    return _react(_pickEmoji(entropy, intent), `score=${netScore} mode=${modeLabel}`);
  }

  // Just above threshold but recently reacted → ignore
  return _ignore(`score=${netScore} but react on cooldown`);
}

// ── Intent detection ──────────────────────────────────────────────────────────

function _detectIntent(text, isMention, isReply, ch, userId, knownNames) {
  const t = text.toLowerCase();

  // Question aimed at Maya
  if ((isMention || isReply) && /\?/.test(text)) return 'question_to_maya';
  if (isMention && text.length > 5)              return 'question_to_maya';

  // Emotional / needs support
  if (/\b(i feel|i'm sad|i'm upset|help me|i'm scared|i'm anxious|i'm stressed|i miss|i'm lonely)\b/i.test(text)) {
    return 'emotional';
  }

  // Question to group (could contribute)
  if (/\?/.test(text) && !isMention && text.split(/\s+/).length >= 5) {
    return 'question_to_group';
  }

  // Directed at someone else (Maya mentioned but they're talking to another user)
  // Heuristic: message ends with a name or has "tell X" / "ask X"
  if (/\b(tell|ask|bro|yaar)\s+[a-z]+\b/i.test(text) && !isMention) {
    return 'directed_at_other';
  }

  // Known name mentioned in conversation
  if (knownNames.length > 0) {
    const mentioned = knownNames.find(n => n.length >= 3 && t.includes(n.toLowerCase()));
    if (mentioned) return 'known_name_mentioned';
  }

  // Maya mentioned but in passing (random mention — someone saying "maya" in a sentence)
  if (/\bmaya\b/i.test(text) && !isMention && text.split(/\s+/).length <= 4) {
    return 'random_mention';
  }

  // Engaged user speaking (continuing the conversation)
  if (ch.engagedUserId === userId && ch.mode === MODES.ENGAGED) {
    return 'engaged_continuation';
  }

  return 'group_chatter';
}

// ── Conversation velocity ─────────────────────────────────────────────────────

function _getVelocity(ch) {
  // Messages per minute in the last 60 seconds
  const now = Date.now();
  const recent = ch.recentMessages.filter(t => now - t < 60_000);
  return recent.length; // msgs/min (since window is 60s)
}

// ── Get mode for external use ─────────────────────────────────────────────────

export function getMode(channelId) {
  return channels.get(channelId)?.mode ?? MODES.PASSIVE;
}

export function getModeLabel(channelId) {
  return ['PASSIVE','OBSERVING','ENGAGED'][getMode(channelId)];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _reply(reason, score)        { return { action: 'reply',  reason, score }; }
function _ignore(reason)              { return { action: 'ignore', reason, score: 0 }; }
function _react(emoji, reason)        { return { action: 'react',  emoji, reason, score: 1 }; }

const REACT_EMOJIS = {
  emotional: ['🫶','❤️','💙'],
  hype:      ['🔥','💥','⚡'],
  neutral:   ['👀','💀','😌','🤝','🫡'],
  question:  ['🤔','👀','💭'],
};

function _pickEmoji(entropy, intent) {
  if (intent === 'emotional')   return REACT_EMOJIS.emotional[Math.floor(Math.random()*3)];
  if (entropy > 0.65)           return REACT_EMOJIS.hype[Math.floor(Math.random()*3)];
  if (intent === 'question_to_group') return REACT_EMOJIS.question[Math.floor(Math.random()*3)];
  const pool = REACT_EMOJIS.neutral;
  return pool[Math.floor(Math.random() * pool.length)];
}
