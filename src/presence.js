/**
 * presence.js — Maya's Conversational Presence Engine
 *
 * Three modes per channel:
 *   PASSIVE   — default. Only responds when directly addressed.
 *   OBSERVING — post-mention. Watching, selectively engages.
 *   ENGAGED   — active back-and-forth. Responds freely in conversation.
 *
 * Key fixes over previous version:
 *   - onMention never downgrades ENGAGED → OBSERVING
 *   - Intent detection uses prior message context (was the previous
 *     message directed at Maya? Was there a back-and-forth?)
 *   - Engaged continuation: if Maya just replied, next message from
 *     same user is treated as continuation regardless of content
 */

import { classify } from './nlp.js';
import db from './db.js';

// ── Per-channel state ─────────────────────────────────────────────────────────
const channels = new Map();
const MODES = { PASSIVE: 0, OBSERVING: 1, ENGAGED: 2 };

function getChannel(channelId) {
  if (!channels.has(channelId)) {
    channels.set(channelId, {
      mode:              MODES.PASSIVE,
      modeSetAt:         0,
      lastMayaReply:     0,
      lastMayaReplyTo:   null,    // userId Maya last replied to
      lastMayaReact:     0,
      recentMessages:    [],      // timestamps for velocity
      recentSpeakers:    [],      // last 6 speaker IDs
      lastSpeakerId:     null,
      engagedUserId:     null,
      mentionCount:      0,
      // Conversation history (last 6 intent signals)
      // Each: { userId, intent, wasForMaya, ts }
      intentHistory:     [],
    });
  }
  return channels.get(channelId);
}

// ── Cooldowns ─────────────────────────────────────────────────────────────────
const COOLDOWN_REPLY_MS  = 22_000;   // 22s between replies when not engaged
const COOLDOWN_REACT_MS  = 10_000;
const ENGAGED_REPLY_MS   = 7_000;    // 7s between replies when engaged
const MODE_OBSERVING_TTL = 5 * 60_000;
const MODE_ENGAGED_TTL   = 5 * 60_000;   // extended: 5 min engaged (was 3)

// ── DB-backed cross-instance cooldown ─────────────────────────────────────────
async function _setDBCooldown(channelId, key, ttlMs) {
  const expires = new Date(Date.now() + ttlMs).toISOString();
  await db.execute(
    `INSERT INTO maya_state (state_key, value) VALUES (?,?)
     ON DUPLICATE KEY UPDATE value=VALUES(value), updated_at=NOW()`,
    [`${key}_${channelId}`, expires]
  ).catch(() => {});
}

async function _checkDBCooldown(channelId, key) {
  try {
    const [[row]] = await db.execute(
      `SELECT value FROM maya_state WHERE state_key=? LIMIT 1`,
      [`${key}_${channelId}`]
    );
    if (!row) return false;
    return Date.now() < new Date(row.value).getTime();
  } catch { return false; }
}

// ── Public state updaters ─────────────────────────────────────────────────────

export function observeMessage(channelId, userId, isMayaReply = false) {
  const ch  = getChannel(channelId);
  const now = Date.now();

  ch.recentMessages = ch.recentMessages.filter(t => now - t < 60_000);
  ch.recentMessages.push(now);

  if (!isMayaReply) {
    ch.recentSpeakers = [...ch.recentSpeakers.slice(-5), userId];
    ch.lastSpeakerId  = userId;
  }

  // Auto-decay
  if (ch.mode === MODES.OBSERVING && now - ch.modeSetAt > MODE_OBSERVING_TTL) {
    ch.mode = MODES.PASSIVE;
    console.log(`[presence] ${channelId} → PASSIVE (observing TTL expired)`);
  }
  if (ch.mode === MODES.ENGAGED && now - ch.modeSetAt > MODE_ENGAGED_TTL) {
    ch.mode = MODES.OBSERVING;
    console.log(`[presence] ${channelId} → OBSERVING (engaged TTL expired)`);
  }
}

export function onMention(channelId, byUserId) {
  const ch = getChannel(channelId);

  // CRITICAL FIX: never downgrade ENGAGED → OBSERVING on mention.
  // If Maya is already in an active conversation, a new mention should
  // extend the engaged window, not reset it downward.
  if (ch.mode === MODES.ENGAGED) {
    ch.modeSetAt = Date.now();   // just refresh the timer
    ch.engagedUserId = byUserId; // update who she's engaging with
    console.log(`[presence] ${channelId} ENGAGED refreshed (mention by ${byUserId})`);
    return;
  }

  ch.mode      = MODES.OBSERVING;
  ch.modeSetAt = Date.now();
  ch.mentionCount++;
  console.log(`[presence] ${channelId} → OBSERVING (mention by ${byUserId})`);
}

export function onMayaReply(channelId, toUserId) {
  const ch = getChannel(channelId);
  ch.lastMayaReply   = Date.now();
  ch.lastMayaReplyTo = toUserId;
  ch.mode            = MODES.ENGAGED;
  ch.modeSetAt       = Date.now();
  ch.engagedUserId   = toUserId;
  observeMessage(channelId, 'maya', true);
  // Use ENGAGED cooldown (shorter) when in active conversation
  // so the other instance also respects the shorter window
  _setDBCooldown(channelId, 'reply', ENGAGED_REPLY_MS);
  console.log(`[presence] ${channelId} → ENGAGED with ${toUserId}`);
}

export function onMayaReact(channelId) {
  getChannel(channelId).lastMayaReact = Date.now();
}

// ── Record intent into channel history ────────────────────────────────────────
// Called after intent is determined, so future messages have context
function _recordIntent(ch, userId, intent, wasForMaya) {
  ch.intentHistory = [
    ...ch.intentHistory.slice(-5),
    { userId, intent, wasForMaya, ts: Date.now() },
  ];
}

// ── Main decision (async — calls NLP) ────────────────────────────────────────

export async function decide({
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
  if (isDM) return _reply('DM', 10);

  const ch  = getChannel(channelId);
  const now = Date.now();
  const wc  = text.trim().split(/\s+/).filter(Boolean).length;

  // ── 1. HARD STOPS ─────────────────────────────────────────────────────────
  const replyCooldown = ch.mode === MODES.ENGAGED ? ENGAGED_REPLY_MS : COOLDOWN_REPLY_MS;

  if (!isMention && !isReply) {
    const inMemory = now - ch.lastMayaReply < replyCooldown;
    const inDB     = inMemory ? true : await _checkDBCooldown(channelId, 'reply');
    if (inDB) return _ignore('cooldown');
  }

  if (!isMention && !isReply && ch.lastSpeakerId === 'maya') {
    return _ignore('no double-reply');
  }

  const recentlyReacted = now - ch.lastMayaReact < COOLDOWN_REACT_MS;

  // ── 2. ENGAGED CONTINUATION ────────────────────────────────────────────────
  // If Maya just replied to this user and they're speaking again,
  // treat it as continuation — engage without requiring explicit intent
  const isEngagedContinuation =
    ch.mode === MODES.ENGAGED &&
    ch.engagedUserId === userId &&
    now - ch.lastMayaReply < MODE_ENGAGED_TTL;

  // ── 3. INTENT DETECTION ───────────────────────────────────────────────────
  let intent, intentScore, sentiment, sentimentScore;

  const hard = _hardRules(text, isMention, isReply, ch, userId);
  if (hard) {
    intent = hard; intentScore = 1.0; sentiment = 'neutral'; sentimentScore = 0;
  } else {
    const nlp   = await classify(text);
    intent      = nlp.intent;
    intentScore = nlp.score;
    sentiment   = nlp.sentiment;
    sentimentScore = nlp.sentimentScore;
  }

  // ── Context correction using intent history ─────────────────────────────
  // If the last 2 messages in this channel were NOT directed at Maya,
  // and this message doesn't mention Maya, downweight question_to_maya
  if (intent === 'question_to_maya' && !isMention && !isReply) {
    const recent = ch.intentHistory.slice(-3);
    const nonMayaCount = recent.filter(h => !h.wasForMaya).length;
    if (nonMayaCount >= 2) {
      // Conversation has been between humans, not with Maya
      // This question is probably for the group, not Maya
      intent = 'question_to_group';
      intentScore *= 0.6;
      console.log(`[presence] intent corrected question_to_maya→question_to_group (${nonMayaCount} non-maya recent msgs)`);
    }
  }

  // Record this intent for future context
  const wasForMaya = isMention || isReply ||
    intent === 'question_to_maya' ||
    intent === 'emotional';
  _recordIntent(ch, userId, intent, wasForMaya);

  // ── 4. CONVERSATION STATE ─────────────────────────────────────────────────
  const velocity       = ch.recentMessages.filter(t => now - t < 60_000).length;
  const isHotConvo     = velocity >= 8;
  const isDeadConvo    = velocity <= 1;
  const uniqueSpeakers = new Set(ch.recentSpeakers.slice(-6)).size;
  const isGroupConvo   = uniqueSpeakers >= 3 && !isMention;

  // ── 5. SILENCE vs EXPRESSION SCORE ───────────────────────────────────────
  let expressScore = 0;
  let silenceScore = 0;

  const conf = intentScore;

  // Direct address
  if (isMention)  expressScore += 8;
  if (isReply)    expressScore += 7;

  // Engaged continuation bonus — she's in active convo with this person
  if (isEngagedContinuation) expressScore += 4;

  // NLP-weighted intents
  switch (intent) {
    case 'question_to_maya':  expressScore += 6 * conf;   break;
    case 'emotional':         expressScore += 5 * conf;   break;
    case 'engaged_reply':     expressScore += 3 * conf;   break;
    case 'question_to_group': expressScore += 1.5 * conf; break;
    case 'directed_at_other':
      // In engaged mode with this user, short messages aren't "directed at other"
      // Only penalise if it's a longer, clearly-redirected message
      if (isEngagedContinuation && wc < 6) {
        // Override: treat as engaged_reply instead
        intent = 'engaged_reply';
        expressScore += 3 * conf;
      } else {
        silenceScore += 5 * conf;
      }
      break;
    case 'random_mention':    silenceScore += 3 * conf;   break;
    case 'group_chatter':     silenceScore += 3 * conf;   break;
  }

  // Sentiment: negative = someone might need support
  if (sentiment === 'negative' && sentimentScore < -0.3) expressScore += 1.5;

  // Context signals
  if (trustLevel >= 4)                           expressScore += 1;
  if (isDeadConvo && ch.mode >= MODES.OBSERVING) expressScore += 1.5;
  if (hasMedia && ch.mode >= MODES.OBSERVING)    expressScore += 0.5;
  if (entropy > 0.6)                             expressScore += 0.5;

  // Known name mentioned
  if (knownNames.length > 0) {
    const ltext = text.toLowerCase();
    const hit   = knownNames.find(n => n.length >= 3 && ltext.includes(n.toLowerCase()));
    if (hit && intent !== 'directed_at_other') expressScore += 1.5;
  }

  // Silence penalties
  if (isHotConvo)                              silenceScore += 5;
  if (isGroupConvo)                            silenceScore += 3;
  if (ch.mode === MODES.PASSIVE && !isMention) silenceScore += 4;
  if (wc < 3 && entropy < 0.3)                silenceScore += 1.5;
  if (recentlyReacted)                         silenceScore += 2;

  const netScore  = expressScore - silenceScore;
  const modeLabel = ['PASSIVE','OBSERVING','ENGAGED'][ch.mode];

  // ── 6. MODE THRESHOLD ────────────────────────────────────────────────────
  const threshold = ch.mode === MODES.PASSIVE   ? 7
                  : ch.mode === MODES.OBSERVING  ? 4
                  :                               2;   // ENGAGED

  const reason = `score=${netScore.toFixed(1)} intent=${intent}(${conf.toFixed(2)}) mode=${modeLabel} sent=${sentiment}`;

  if (netScore < threshold) return _ignore(`${reason} → below ${threshold}`);

  // ── 7. RESPONSE TYPE ─────────────────────────────────────────────────────
  const forceReply = netScore >= 6
                  || isMention
                  || isReply
                  || isEngagedContinuation
                  || intent === 'question_to_maya'
                  || (intent === 'emotional' && intentScore > 0.6);

  if (forceReply) return _reply(reason, netScore);
  if (!recentlyReacted) return _react(_pickEmoji(entropy, intent, sentiment), reason);
  return _ignore(`${reason} → react cooldown`);
}

// ── Hard rules (fast path) ────────────────────────────────────────────────────

function _hardRules(text, isMention, isReply, ch, userId) {
  if ((isMention || isReply) && /\?/.test(text))           return 'question_to_maya';
  if (isMention && text.trim().split(/\s+/).length >= 4)   return 'question_to_maya';
  if (/^[😂💀👀🔥😭🙏👍👎❤️🤣😍🫶✨]+$/u.test(text)) return 'group_chatter';
  if (/^(ok|okay|k|kk|lol|lmao|haha|same|mood|brb|gtg|gn|gm)\.?$/i.test(text)) return 'group_chatter';
  return null;
}

// ── Mode info ─────────────────────────────────────────────────────────────────

export function getMode(channelId) {
  return channels.get(channelId)?.mode ?? MODES.PASSIVE;
}

export function getModeLabel(channelId) {
  return ['PASSIVE','OBSERVING','ENGAGED'][getMode(channelId)];
}

/**
 * Returns the userId Maya is currently ENGAGED with in a channel,
 * or null if not engaged. Used by index.js to let continuation
 * messages through the gate without requiring a mention.
 */
export function getEngagedUser(channelId) {
  const ch = channels.get(channelId);
  if (!ch || ch.mode !== MODES.ENGAGED) return null;
  // Check TTL hasn't expired
  if (Date.now() - ch.modeSetAt > MODE_ENGAGED_TTL) return null;
  return ch.engagedUserId || null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _reply(reason, score)  { return { action: 'reply',  reason, score }; }
function _ignore(reason)        { return { action: 'ignore', reason, score: 0 }; }
function _react(emoji, reason)  { return { action: 'react',  emoji,  reason, score: 1 }; }

const REACT_EMOJIS = {
  emotional: ['🫶','❤️','💙'],
  hype:      ['🔥','💥','⚡'],
  neutral:   ['👀','💀','😌','🤝','🫡'],
  question:  ['🤔','👀','💭'],
};

function _pickEmoji(entropy, intent, sentiment) {
  if (intent === 'emotional' || sentiment === 'negative') {
    return REACT_EMOJIS.emotional[Math.floor(Math.random() * 3)];
  }
  if (entropy > 0.65) return REACT_EMOJIS.hype[Math.floor(Math.random() * 3)];
  if (intent === 'question_to_group') return REACT_EMOJIS.question[Math.floor(Math.random() * 3)];
  const pool = REACT_EMOJIS.neutral;
  return pool[Math.floor(Math.random() * pool.length)];
}
