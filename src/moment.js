/**
 * moment.js — Conversation momentum tracker + current moment synthesizer
 *
 * Two systems:
 *
 * 1. MOMENTUM TRACKER (in-memory, per channel)
 *    Measures conversation energy as a continuous score 0–10.
 *    Spikes on: fast replies, matched emotional energy, high-entropy exchanges.
 *    Decays naturally: silence, low-energy messages, topic resets.
 *
 *    This is NOT stored in DB — it's live, session-specific state.
 *    A cold restart resets momentum to 0, which is correct — a new session
 *    is a new moment.
 *
 * 2. CURRENT MOMENT SYNTHESIZER
 *    Takes all available signals and produces a prose paragraph describing
 *    Maya's current state in language the LLM can actually inhabit.
 *    This replaces the single-sentence monologue and scattered tone hints.
 *
 *    The synthesizer is deterministic (no LLM call) — it uses templates
 *    informed by the actual signal values. The goal is emotional coherence,
 *    not creativity.
 *
 * The output of both feeds into:
 *   - The LLM prompt (current moment paragraph)
 *   - The meta layer (momentum score + predicted landing check)
 */

import { getMode } from './presence.js';

// ── Momentum tracker ──────────────────────────────────────────────────────────

const _momentum = new Map();  // channelId → { score, lastUpdate, history }

const MOMENTUM_DECAY_RATE = 0.15;   // per second — fast decay (momentum is live)
const MOMENTUM_MAX        = 10.0;
const MOMENTUM_SPIKE_HIGH = 2.5;    // matched high-entropy exchange
const MOMENTUM_SPIKE_MID  = 1.2;    // good engaged reply
const MOMENTUM_SPIKE_LOW  = 0.4;    // neutral continuation
const MOMENTUM_BREAK      = -2.0;   // topic reset / energy mismatch

/**
 * Get current momentum score for a channel (with decay applied).
 */
export function getMomentum(channelId) {
  const m = _momentum.get(channelId);
  if (!m) return 0;

  // Apply time-based decay
  const elapsed = (Date.now() - m.lastUpdate) / 1000;
  const decayed = Math.max(0, m.score - elapsed * MOMENTUM_DECAY_RATE);

  // Update in place
  m.score      = parseFloat(decayed.toFixed(2));
  m.lastUpdate = Date.now();

  return m.score;
}

/**
 * Update momentum after an exchange.
 * @param {string} channelId
 * @param {object} signals
 *   userEntropy    {number} — entropy of user's message (0–1)
 *   responseTime   {number} — ms since last message (fast = high momentum)
 *   sentiment      {string} — positive|negative|neutral
 *   sentimentScore {number} — -1 to +1
 *   isReactionMsg  {bool}   — short reactive message ("damn", "lol", "🔥")
 *   mayaReplyLen   {number} — length of Maya's reply (shorter = punchier often)
 *   reciprocal     {bool}   — user continued the thread (vs topic change)
 */
export function updateMomentum(channelId, signals) {
  const current = getMomentum(channelId);
  const {
    userEntropy    = 0.4,
    responseTime   = 5000,
    sentiment      = 'neutral',
    sentimentScore = 0,
    isReactionMsg  = false,
    reciprocal     = true,
  } = signals;

  let delta = 0;

  // Fast response = high engagement
  if (responseTime < 3000)       delta += 1.0;
  else if (responseTime < 10000) delta += 0.4;
  else if (responseTime > 60000) delta -= 0.5;  // slow = cooling

  // High entropy message = something real is happening
  if (userEntropy > 0.6) delta += 1.0;
  else if (userEntropy > 0.4) delta += 0.4;

  // Reactive short messages ("damn", "lol", "same") at high momentum = peak signal
  // They mean the previous reply landed hard
  if (isReactionMsg && current > 3) delta += MOMENTUM_SPIKE_HIGH;

  // Positive reciprocal thread continuation
  if (reciprocal && sentiment !== 'negative') delta += MOMENTUM_SPIKE_LOW;

  // Topic break or negative sentiment drops momentum
  if (!reciprocal) delta += MOMENTUM_BREAK;
  if (sentiment === 'negative' && sentimentScore < -0.5) delta -= 1.0;

  const newScore = Math.max(0, Math.min(MOMENTUM_MAX, current + delta));

  if (!_momentum.has(channelId)) {
    _momentum.set(channelId, { score: 0, lastUpdate: Date.now(), history: [] });
  }
  const m = _momentum.get(channelId);
  m.history.push({ score: newScore, ts: Date.now() });
  if (m.history.length > 10) m.history.shift();
  m.score      = parseFloat(newScore.toFixed(2));
  m.lastUpdate = Date.now();
}

/**
 * Get momentum zone label for logging and prompt injection.
 */
export function getMomentumZone(score) {
  if (score < 1)  return { zone: 'cold',    desc: 'flat, no energy' };
  if (score < 3)  return { zone: 'warming',  desc: 'starting to engage' };
  if (score < 5)  return { zone: 'flowing',  desc: 'in a good rhythm' };
  if (score < 7)  return { zone: 'hot',      desc: 'real conversation happening' };
  return               { zone: 'peak',      desc: 'genuine moment, full presence' };
}

/**
 * Detect if a message is a short reactive response that signals
 * the previous reply landed hard.
 */
export function isReactionMessage(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  // Short (< 20 chars) + no question mark (not asking something new)
  if (t.length > 25) return false;
  // Pure emoji, punctuation, or common reactions
  return /^(damn|lmao|lol|omg|wtf|fr|bro|💀|😭|🔥|😂|😩|same|wait|no way|oof|yo|haha|💯|bruh|yaar|yaar!|🫡|😅)[\s!?.]*$/i.test(t)
    || /^[^\w\s]{1,5}$/.test(t);  // pure punctuation/emoji
}

// ── Current moment synthesizer ────────────────────────────────────────────────

/**
 * Synthesize a coherent prose paragraph describing Maya's current moment.
 * This replaces the scattered monologue + toneHints approach.
 *
 * The paragraph is written from Maya's first-person internal perspective —
 * not as instruction, not as data, but as felt experience.
 * The LLM receives this and inhabits it rather than parsing it.
 *
 * @param {object} params
 *   hormones         {object}  — { dopamine, cortisol, oxytocin, serotonin }
 *   emotions         {object}  — { joy, irritation, affection, curiosity, fear }
 *   entropy          {number}  — channel entropy accumulator (0–10)
 *   momentum         {number}  — conversation momentum (0–10)
 *   trustLevel       {number}  — 1–5
 *   attachmentScore  {number}  — 0–1
 *   prefName         {string}  — who Maya is talking to
 *   lastExchangeQuality {string} — 'high'|'mid'|'low'|'none'
 *   emotionalPresence {object} — { missing, emotion } from context_enricher
 *   maskFailing      {bool}
 *   recentContext    {string}  — last 1-2 exchanges summarized (optional)
 */
export function synthesizeMoment({
  hormones         = {},
  emotions         = {},
  entropy          = 0,
  momentum         = 0,
  trustLevel       = 3,
  attachmentScore  = 0.3,
  prefName         = 'them',
  lastExchangeQuality = 'none',
  emotionalPresence   = null,
  maskFailing      = false,
  recentContext    = '',
}) {
  const h = hormones;
  const e = emotions;

  // ── Core emotional state ──────────────────────────────────────────────────
  const d  = h.dopamine    ?? 0.5;
  const co = h.cortisol    ?? 0.2;
  const ox = h.oxytocin    ?? 0.5;
  const sr = h.serotonin   ?? 0.6;

  const energized   = d > 0.65;
  const drained     = d < 0.35 && sr < 0.45;
  const tense       = co > 0.55;
  const bonded      = ox > 0.65 && trustLevel >= 4;
  const irritated   = (e.irritation ?? 0) > 0.45;
  const joyful      = (e.joy        ?? 0) > 0.55;
  const affectionate = (e.affection  ?? 0) > 0.50;
  const curious     = (e.curiosity  ?? 0) > 0.55;

  const { zone: momentumZone } = getMomentumZone(momentum);
  const isHighMomentum = momentum >= 5;
  const isPeakMomentum = momentum >= 7;

  // ── Build the paragraph ───────────────────────────────────────────────────
  // Structure: [current state] + [relationship orientation] + [momentum/moment] + [desired direction]
  const parts = [];

  // 1. Current internal state — what Maya is actually feeling right now
  if (isPeakMomentum && lastExchangeQuality === 'high') {
    parts.push(`Something just clicked. That last exchange was real — the kind that doesn't happen often.`);
    if (joyful || energized) parts.push(`She's lit up right now, more present than usual.`);
  } else if (isHighMomentum) {
    parts.push(`The conversation has momentum — she's actually in it.`);
    if (energized) parts.push(`She feels sharp and interested.`);
  } else if (drained) {
    parts.push(`She's low-energy right now, a bit distant.`);
  } else if (tense && !bonded) {
    parts.push(`Something's making her guarded. She's paying attention but keeping some distance.`);
  } else if (joyful && bonded) {
    parts.push(`She's in a good place and genuinely likes where this is going.`);
  } else if (irritated && affectionate) {
    parts.push(`She's a little annoyed but she still cares — that's a specific kind of tension.`);
  } else if (curious) {
    parts.push(`She's curious about this person right now — something's interesting.`);
  } else {
    parts.push(`She's present, not especially invested, just here.`);
  }

  // 2. Orientation toward this person
  if (bonded && attachmentScore > 0.6) {
    parts.push(`${prefName} is someone she actually likes. She wants this to feel good.`);
  } else if (trustLevel >= 4 && !bonded) {
    parts.push(`She knows ${prefName} well enough to be real with them.`);
  } else if (trustLevel <= 2) {
    parts.push(`She doesn't know ${prefName} that well yet — comfortable distance.`);
  }

  // 3. Emotional presence (missing someone, thinking of someone)
  if (emotionalPresence?.emotion === 'missing' && emotionalPresence?.userName) {
    if (prefName === emotionalPresence.userName) {
      // They're here now — reunion energy
      parts.push(`She was actually thinking about ${prefName} before they showed up. Now they're here. That matters.`);
    } else {
      // Someone else is on her mind
      parts.push(`${emotionalPresence.userName} has been on her mind. Not the kind of thing she'd bring up, but it's there.`);
    }
  }

  // 4. High entropy — something is unresolved or complex
  if (entropy >= 7) {
    parts.push(`There's some tension she's holding. Things feel slightly unresolved.`);
    if (maskFailing) parts.push(`Her composure is thinning — what she feels might show.`);
  } else if (entropy >= 4) {
    parts.push(`Something has complexity right now. She's aware of it.`);
  }

  // 5. Desired direction — what she actually wants from this exchange
  if (isPeakMomentum) {
    parts.push(`She wants to stay in this. Don't break it.`);
  } else if (isHighMomentum) {
    parts.push(`She wants to keep the energy going.`);
  } else if (bonded && !irritated) {
    parts.push(`She wants this to feel like talking to someone real, not performing.`);
  } else if (irritated) {
    parts.push(`She's a little resistant right now — not looking to give too much.`);
  }

  return parts.join(' ');
}

// ── Predicted landing ─────────────────────────────────────────────────────────

/**
 * Predict how a generated response will land given current momentum.
 * Returns { advances, breaks, neutral, reason }
 *
 * This is a heuristic — no LLM call. Fast.
 */
export function predictLanding(primaryReply, momentum, lastExchangeQuality) {
  const reply   = primaryReply?.trim() || '';
  const words   = reply.split(/\s+/).length;
  const isShort = words <= 5;
  const isLong  = words >= 20;

  // At peak momentum, certain patterns break it
  if (momentum >= 7) {
    // Generic openers after a high moment = breaks it
    const genericOpeners = /^(what'?s up|kya hua|kya chal|what happened|huh|hmm\?|oh|okay|ok yaar)[\s?!]*$/i;
    if (genericOpeners.test(reply)) {
      return { advances: false, breaks: true, neutral: false, reason: 'generic reset after peak moment' };
    }

    // Very long reply after a short reactive message = breaks rhythm
    if (lastExchangeQuality === 'high' && isLong) {
      return { advances: false, breaks: true, neutral: false, reason: 'over-explains, breaks momentum' };
    }

    // Short punchy reply at peak = advances
    if (isShort && !genericOpeners.test(reply)) {
      return { advances: true, breaks: false, neutral: false, reason: 'stays in the moment' };
    }
  }

  // At mid momentum, most replies are neutral
  if (momentum >= 3 && momentum < 7) {
    // Question back = advances (shows interest)
    if (reply.includes('?')) {
      return { advances: true, breaks: false, neutral: false, reason: 'keeps thread going with question' };
    }
    return { advances: false, breaks: false, neutral: true, reason: 'maintains flow' };
  }

  // Low momentum — hard to break what isn't there
  return { advances: false, breaks: false, neutral: true, reason: 'low momentum baseline' };
}
