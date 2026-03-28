/**
 * presence.js — Maya's Conversational Presence Engine
 *
 * The core question is not "should I respond to this message?"
 * It's "does this conversation need me right now?"
 *
 * Three modes per channel (auto-managed):
 *   PASSIVE   — default. Only responds when directly addressed.
 *   OBSERVING — post-mention. Watching, rarely speaks.
 *   ENGAGED   — active back-and-forth. More responsive.
 *
 * Decision flow:
 *   1. Hard stops (cooldown, double-reply guard)
 *   2. NLP intent classification (node-nlp, local, no API)
 *   3. Conversation state (velocity, speakers)
 *   4. Silence score vs Expression score — weighted by NLP confidence
 *   5. Mode threshold gate
 *
 * Returns: { action: 'ignore'|'react'|'reply', reason, score }
 */

import { classify } from './nlp.js';

// ── Per-channel state ─────────────────────────────────────────────────────────
const channels = new Map();
const MODES = { PASSIVE: 0, OBSERVING: 1, ENGAGED: 2 };

function getChannel(channelId) {
  if (!channels.has(channelId)) {
    channels.set(channelId, {
      mode:           MODES.PASSIVE,
      modeSetAt:      0,
      lastMayaReply:  0,
      lastMayaReact:  0,
      recentMessages: [],    // timestamps for velocity
      recentSpeakers: [],    // last 6 speaker IDs
      lastSpeakerId:  null,
      engagedUserId:  null,
      mentionCount:   0,
    });
  }
  return channels.get(channelId);
}

// ── Cooldowns ─────────────────────────────────────────────────────────────────
const COOLDOWN_REPLY_MS  = 25_000;
const COOLDOWN_REACT_MS  = 8_000;
const ENGAGED_REPLY_MS   = 8_000;
const MODE_OBSERVING_TTL = 5 * 60_000;
const MODE_ENGAGED_TTL   = 3 * 60_000;

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

  // Auto-decay modes over time
  if (ch.mode === MODES.OBSERVING && now - ch.modeSetAt > MODE_OBSERVING_TTL) {
    ch.mode = MODES.PASSIVE;
    console.log(`[presence] ${channelId} → PASSIVE (observing expired)`);
  }
  if (ch.mode === MODES.ENGAGED && now - ch.modeSetAt > MODE_ENGAGED_TTL) {
    ch.mode = MODES.OBSERVING;
    console.log(`[presence] ${channelId} → OBSERVING (engaged expired)`);
  }
}

export function onMention(channelId, byUserId) {
  const ch = getChannel(channelId);
  ch.mode      = MODES.OBSERVING;
  ch.modeSetAt = Date.now();
  ch.mentionCount++;
  console.log(`[presence] ${channelId} → OBSERVING (mention by ${byUserId})`);
}

export function onMayaReply(channelId, toUserId) {
  const ch = getChannel(channelId);
  ch.lastMayaReply = Date.now();
  ch.mode          = MODES.ENGAGED;
  ch.modeSetAt     = Date.now();
  ch.engagedUserId = toUserId;
  observeMessage(channelId, 'maya', true);
  console.log(`[presence] ${channelId} → ENGAGED with ${toUserId}`);
}

export function onMayaReact(channelId) {
  getChannel(channelId).lastMayaReact = Date.now();
}

// ── Main decision function (async — calls NLP classifier) ─────────────────────

/**
 * @returns {Promise<{ action: 'ignore'|'react'|'reply', reason: string, score: number }>}
 */
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
  // DMs always get a reply
  if (isDM) return _reply('DM', 10);

  const ch  = getChannel(channelId);
  const now = Date.now();
  const wc  = text.trim().split(/\s+/).filter(Boolean).length;

  // ── 1. HARD STOPS ─────────────────────────────────────────────────────────
  const replyCooldown = ch.mode === MODES.ENGAGED ? ENGAGED_REPLY_MS : COOLDOWN_REPLY_MS;

  if (!isMention && !isReply && now - ch.lastMayaReply < replyCooldown) {
    return _ignore(`cooldown: ${Math.round((replyCooldown - (now - ch.lastMayaReply))/1000)}s left`);
  }

  // No double-reply (Maya spoke last)
  if (!isMention && !isReply && ch.lastSpeakerId === 'maya') {
    return _ignore('no double-reply');
  }

  const recentlyReacted = now - ch.lastMayaReact < COOLDOWN_REACT_MS;

  // ── 2. NLP INTENT CLASSIFICATION ─────────────────────────────────────────
  // Hard rules first for obvious cases (fast, no classifier overhead)
  let intent, intentScore, sentiment, sentimentScore;

  const hardIntent = _hardRules(text, isMention, isReply, ch, userId, knownNames);
  if (hardIntent) {
    intent      = hardIntent;
    intentScore = 1.0;   // hard rules are always confident
    sentiment   = 'neutral';
    sentimentScore = 0;
  } else {
    // NLP classifier for everything nuanced
    const nlp  = await classify(text);
    intent      = nlp.intent;
    intentScore = nlp.score;
    sentiment   = nlp.sentiment;
    sentimentScore = nlp.sentimentScore;
  }

  // ── 3. CONVERSATION STATE ─────────────────────────────────────────────────
  const velocity       = ch.recentMessages.filter(t => now - t < 60_000).length;
  const isHotConvo     = velocity >= 8;
  const isDeadConvo    = velocity <= 1;
  const uniqueSpeakers = new Set(ch.recentSpeakers.slice(-6)).size;
  const isGroupConvo   = uniqueSpeakers >= 3 && !isMention;

  // ── 4. SILENCE vs EXPRESSION SCORE ───────────────────────────────────────
  // NLP confidence multiplies the intent's base score contribution
  // So a question_to_maya with 0.9 confidence adds more than one with 0.5

  let expressScore = 0;
  let silenceScore = 0;

  // Direct address signals (hard rules — full weight)
  if (isMention)  expressScore += 8;
  if (isReply)    expressScore += 7;

  // NLP-weighted intent signals
  const conf = intentScore;  // 0–1 confidence multiplier
  switch (intent) {
    case 'question_to_maya':  expressScore += 6 * conf;  break;
    case 'emotional':         expressScore += 5 * conf;  break;
    case 'engaged_reply':     expressScore += 3 * conf;  break;
    case 'question_to_group': expressScore += 2 * conf;  break;
    case 'directed_at_other': silenceScore += 5 * conf;  break;
    case 'random_mention':    silenceScore += 3 * conf;  break;
    case 'group_chatter':     silenceScore += 4 * conf;  break;
  }

  // Sentiment bonus — negative sentiment = someone might need support
  if (sentiment === 'negative' && sentimentScore < -0.3) expressScore += 1.5;

  // Context signals
  if (trustLevel >= 4)                           expressScore += 1;
  if (isDeadConvo && ch.mode >= MODES.OBSERVING) expressScore += 1.5;
  if (hasMedia && ch.mode >= MODES.OBSERVING)    expressScore += 0.5;
  if (entropy > 0.6)                             expressScore += 0.5;

  // Known name mentioned (soft signal — she notices)
  if (intent !== 'directed_at_other' && knownNames.length > 0) {
    const ltext = text.toLowerCase();
    const hit   = knownNames.find(n => n.length >= 3 && ltext.includes(n.toLowerCase()));
    if (hit) expressScore += 1.5;
  }

  // Conversation state penalties
  if (isHotConvo)                              silenceScore += 5;
  if (isGroupConvo)                            silenceScore += 3;
  if (ch.mode === MODES.PASSIVE && !isMention) silenceScore += 4;
  if (wc < 3 && entropy < 0.3)                silenceScore += 1.5;
  if (recentlyReacted)                         silenceScore += 2;

  const netScore = expressScore - silenceScore;
  const modeLabel = ['PASSIVE','OBSERVING','ENGAGED'][ch.mode];

  // ── 5. MODE THRESHOLD GATE ────────────────────────────────────────────────
  const threshold = ch.mode === MODES.PASSIVE   ? 7
                  : ch.mode === MODES.OBSERVING  ? 4
                  :                               2;

  const reason = `score=${netScore.toFixed(1)} intent=${intent}(${conf.toFixed(2)}) mode=${modeLabel} sent=${sentiment}`;

  if (netScore < threshold) {
    return _ignore(`${reason} → below threshold ${threshold}`);
  }

  // ── 6. RESPONSE TYPE ─────────────────────────────────────────────────────
  const forceReply = netScore >= 6
                  || isMention
                  || isReply
                  || intent === 'question_to_maya'
                  || (intent === 'emotional' && intentScore > 0.6);

  if (forceReply) return _reply(reason, netScore);

  if (!recentlyReacted) return _react(_pickEmoji(entropy, intent, sentiment), reason);

  return _ignore(`${reason} → react on cooldown`);
}

// ── Hard rules (fast path before NLP) ────────────────────────────────────────
// Only for cases where we're 100% certain from structure alone

function _hardRules(text, isMention, isReply, ch, userId, knownNames) {
  // Direct mention + question mark = definitely question_to_maya
  if ((isMention || isReply) && /\?/.test(text)) return 'question_to_maya';

  // Long direct mention (any substantive message addressed to Maya)
  if (isMention && text.trim().split(/\s+/).length >= 4) return 'question_to_maya';

  // Pure emoji / ack words — always group chatter
  if (/^[😂💀👀🔥😭🙏👍👎❤️🤣😍🫶✨]+$/u.test(text)) return 'group_chatter';
  if (/^(ok|okay|k|kk|lol|lmao|haha|same|mood|brb|gtg|gn|gm)\.?$/i.test(text)) return 'group_chatter';

  // Engaged user continuing conversation — let NLP handle it for nuance
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getMode(channelId) {
  return channels.get(channelId)?.mode ?? MODES.PASSIVE;
}

export function getModeLabel(channelId) {
  return ['PASSIVE','OBSERVING','ENGAGED'][getMode(channelId)];
}

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
