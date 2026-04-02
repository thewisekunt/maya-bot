import { w as learnedWeight, logDecision } from './learn.js';
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
const COOLDOWN_REACT_MS  = 10_000;
const MODE_OBSERVING_TTL = 5 * 60_000;
const MODE_ENGAGED_TTL   = 5 * 60_000;   // extended: 5 min engaged (was 3)


// ── Public state updaters ─────────────────────────────────────────────────────

export function observeMessage(channelId, userId, isMayaReply = false, messageEntropy = null) {
  const ch  = getChannel(channelId);
  const now = Date.now();

  ch.recentMessages = ch.recentMessages.filter(t => now - t < 60_000);
  ch.recentMessages.push(now);

  if (!isMayaReply) {
    ch.recentSpeakers = [...ch.recentSpeakers.slice(-5), userId];
    ch.lastSpeakerId  = userId;
    // Track per-channel running entropy (EMA α=0.1 — slow moving channel baseline)
    if (messageEntropy !== null) {
      ch.channelEntropy = ch.channelEntropy * 0.9 + messageEntropy * 0.1;
      ch.entropyCount++;
    }
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
  // No time-based reply cooldown — scanner→notif pipeline handles gatekeeping.
  // Only guard: don't reply if Maya was literally the last speaker.

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
    case 'random_mention':
      // Only penalise if it's NOT a direct mention — if scanner triggered this,
      // the word "maya" appeared but it's unclear context. Penalise less than group_chatter.
      if (!isMention) silenceScore += 1.5 * conf;
      break;
    case 'group_chatter':     silenceScore += 3 * conf;   break;
  }

  // Sentiment: negative = someone might need support
  const negBonus = await learnedWeight('presence', 'negative_bonus', 1.5);
  if (sentiment === 'negative' && sentimentScore < -0.3) expressScore += negBonus;

  // Context signals
  if (trustLevel >= 5)                           expressScore += 4;
  else if (trustLevel >= 4)                      expressScore += 2;
  if (isDeadConvo && ch.mode >= MODES.OBSERVING) expressScore += 1.5;
  if (hasMedia && ch.mode >= MODES.OBSERVING)    expressScore += 0.5;
  if (entropy > 0.6)                             expressScore += 0.5;

  // Solo conversation signal — if only one person has been speaking recently,
  // they're almost certainly talking to Maya (no one else to talk to)
  // Busy channel = Maya is unaware, quiet channel = she should notice
  // Solo convo: only meaningful in server channels
  // In DMs there's always only one speaker — don't boost from that
  const recentUniqueUsers = new Set(ch.recentSpeakers.slice(-8)).size;
  const isSoloConvo = !isDM && recentUniqueUsers <= 1 && ch.mode >= MODES.OBSERVING;
  if (isSoloConvo) {
    expressScore += 2;
    console.log(`[presence] solo convo detected — expressScore +2`);
  }

  // Known name mentioned
  if (knownNames.length > 0) {
    const ltext = text.toLowerCase();
    const hit   = knownNames.find(n => n.length >= 3 && ltext.includes(n.toLowerCase()));
    if (hit && intent !== 'directed_at_other') expressScore += 1.5;
  }

  // Silence penalties
  if (isHotConvo)                              silenceScore += 5;
  if (isGroupConvo && trustLevel < 4)          silenceScore += 3;  // high trust bypasses group penalty
  if (ch.mode === MODES.PASSIVE && !isMention) silenceScore += 4;
  if (wc < 3 && entropy < 0.3)                silenceScore += 1.5;
  if (recentlyReacted && !isMention)           silenceScore += 2;  // never silence a mention just because we reacted

  const netScore  = expressScore - silenceScore;
  const modeLabel = ['PASSIVE','OBSERVING','ENGAGED'][ch.mode];

  // ── 6. MODE THRESHOLD ────────────────────────────────────────────────────
  const passiveSilence   = await learnedWeight('presence', 'passive_silence',   7);
  const observingSilence = await learnedWeight('presence', 'observing_silence', 4);
  const threshold = ch.mode === MODES.PASSIVE   ? passiveSilence
                  : ch.mode === MODES.OBSERVING  ? observingSilence
                  :                               2;   // ENGAGED always 2

  const reason = `score=${netScore.toFixed(1)} intent=${intent}(${conf.toFixed(2)}) mode=${modeLabel} sent=${sentiment}`;

  // Hard override: trust-5 user with a direct mention never gets silenced
  if (trustLevel >= 5 && isMention) {
    console.log(`[presence] trust-5 mention override — always reply`);
    // Fall through to response type determination
  } else if (netScore < threshold) {
    return _ignore(`${reason} → below ${threshold}`);
  }

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
  // In ENGAGED mode with this specific user, ambiguous/short messages = continuation
  // NLP returning None means classifier uncertain — trust the mode context instead
  if (ch.mode === MODES.ENGAGED && ch.engagedUserId === userId) return 'engaged_reply';
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
/**
 * Get the running entropy baseline for a channel.
 * Reflects how energetic/chaotic this channel typically is.
 */
export function getChannelEntropy(channelId) {
  const ch = channels.get(channelId);
  return ch ? ch.channelEntropy : 0.4;
}

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
