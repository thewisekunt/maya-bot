/**
 * observation.js — Tier 2: Passive channel observation
 *
 * Everything that isn't a hard notification goes here.
 * This is the "reading the room" pipeline.
 *
 * Key difference from old scanner → notif flow:
 *   OLD: every message evaluated independently → trigger or ignore
 *   NEW: messages accumulate into channel state → conversation arc triggers
 *
 * Entropy gradient — three zones that shape Maya's behavior:
 *
 *   STAGNANT (entropy 0–3):
 *     Same few speakers, repetitive topics, low velocity.
 *     Maya sees it like unread notifications she hasn't opened.
 *     Accumulates weakly. Very unlikely to pull her in.
 *
 *   EVOLVING (entropy 3–6):
 *     Multiple speakers, topic shifting, energy building.
 *     Maya is actually reading. Context accumulates into working memory.
 *     This is the zone where her decision to engage is most nuanced.
 *
 *   CHAOS (entropy 6+):
 *     High velocity, emotional, multiple threads.
 *     Maximum pull — but also maximum social risk.
 *     She either gets drawn in or consciously stays out.
 *
 * The observation buffer is per-channel, in-memory.
 * It holds the last N messages as a rolling context window.
 * Inner voice reads this buffer, not individual messages.
 */

import { getChannelState } from './psyche.js';
import { getMomentum, getMomentumZone } from './moment.js';

// ── Channel observation state ─────────────────────────────────────────────────
// key: channelId
// value: { zone, buffer, lastZoneChange, velocity, uniqueSpeakers, topics }

const _channels = new Map();
const BUFFER_MAX   = 20;   // rolling window of messages
const BUFFER_TTL   = 10 * 60 * 1000;  // 10 min — stale messages drop

// ── Zone thresholds ───────────────────────────────────────────────────────────
// Derived from channel-level entropy accumulator (psyche.ch.entropy, 0–10)
export const ZONES = {
  STAGNANT: 'stagnant',
  EVOLVING: 'evolving',
  CHAOS:    'chaos',
};

function _getZone(channelEntropy, velocity) {
  // Combine psyche entropy with message velocity
  const combinedScore = channelEntropy * 0.6 + Math.min(velocity / 10, 1) * 0.4 * 10;
  if (combinedScore < 3) return ZONES.STAGNANT;
  if (combinedScore < 6) return ZONES.EVOLVING;
  return ZONES.CHAOS;
}

// ── Observe a message ─────────────────────────────────────────────────────────

/**
 * Add a message to the observation buffer for a channel.
 * Called for ALL messages that aren't hard notifications.
 *
 * @returns {object} current observation state for this channel
 */
export function observe(channelId, { userId, username, content, entropy, sentiment, intent, timestamp }) {
  if (!_channels.has(channelId)) {
    _channels.set(channelId, {
      buffer:          [],
      velocity:        0,
      uniqueSpeakers:  new Set(),
      lastObserved:    0,
      zone:            ZONES.STAGNANT,
      zoneEnteredAt:   Date.now(),
      pullScore:       0,       // accumulated pull toward engaging
    });
  }

  const ch = _channels.get(channelId);
  const now = timestamp || Date.now();

  // Drop stale messages from buffer
  ch.buffer = ch.buffer.filter(m => now - m.timestamp < BUFFER_TTL);

  // Add new message
  ch.buffer.push({ userId, username, content: content?.slice(0, 200), entropy, sentiment, intent, timestamp: now });
  if (ch.buffer.length > BUFFER_MAX) ch.buffer.shift();

  // Update velocity (messages per minute in last 2min)
  const twoMinAgo = now - 120_000;
  ch.velocity = ch.buffer.filter(m => m.timestamp > twoMinAgo).length;
  ch.uniqueSpeakers = new Set(ch.buffer.filter(m => m.timestamp > twoMinAgo).map(m => m.userId));
  ch.lastObserved = now;

  // Update zone from psyche state
  const psycheCh = getChannelState(channelId);
  const chanEntropy = psycheCh?.entropy || 0;
  const newZone = _getZone(chanEntropy, ch.velocity);

  if (newZone !== ch.zone) {
    console.log(`[obs] ${channelId} zone: ${ch.zone} → ${newZone} (entropy=${chanEntropy.toFixed(1)} vel=${ch.velocity})`);
    ch.zone = newZone;
    ch.zoneEnteredAt = now;
  }

  // Accumulate pull score — evolving/chaos zones create pull
  const pullDelta = {
    [ZONES.STAGNANT]: -0.05,  // stagnant bleeds pull away
    [ZONES.EVOLVING]: +0.10,  // evolving builds pull
    [ZONES.CHAOS]:    +0.15,  // chaos pulls hardest
  }[ch.zone] || 0;
  ch.pullScore = Math.max(0, Math.min(1, ch.pullScore + pullDelta));

  return getObservationState(channelId);
}

/**
 * Get the current observation state for a channel.
 * This is what inner_voice.js reads.
 */
export function getObservationState(channelId) {
  const ch = _channels.get(channelId);
  if (!ch) return { zone: ZONES.STAGNANT, buffer: [], velocity: 0, pullScore: 0, uniqueSpeakers: [] };

  const momentum = getMomentum(channelId);
  const { zone: momentumZone } = getMomentumZone(momentum);

  return {
    zone:          ch.zone,
    buffer:        ch.buffer,              // full message history for inner voice
    velocity:      ch.velocity,
    uniqueSpeakers: [...ch.uniqueSpeakers],
    pullScore:     ch.pullScore,
    momentum,
    momentumZone,
    zoneAge:       Date.now() - ch.zoneEnteredAt,  // ms in current zone
    // Summary for prompt injection
    summary: _summarizeBuffer(ch.buffer, ch.zone),
  };
}

/**
 * Reset pull score after Maya engages with a channel.
 * So she doesn't immediately re-engage.
 */
export function resetPull(channelId) {
  const ch = _channels.get(channelId);
  if (ch) ch.pullScore = 0;
}

/**
 * Should observation trigger an inner voice check?
 * Called periodically or when pull score crosses threshold.
 */
export function shouldTriggerObservation(channelId) {
  const ch = _channels.get(channelId);
  if (!ch) return false;
  if (ch.zone === ZONES.STAGNANT) return false;

  // Evolving: trigger at pull > 0.6
  // Chaos: trigger at pull > 0.4 (lower threshold — urgency)
  const threshold = ch.zone === ZONES.CHAOS ? 0.4 : 0.6;
  return ch.pullScore >= threshold;
}

// ── Buffer summarizer ─────────────────────────────────────────────────────────

function _summarizeBuffer(buffer, zone) {
  if (!buffer.length) return '';
  const recent = buffer.slice(-8);
  const speakers = [...new Set(recent.map(m => m.username))].join(', ');
  const avgEntropy = recent.reduce((s, m) => s + (m.entropy || 0.4), 0) / recent.length;
  const topics = _extractTopics(recent);

  return [
    `[Observing: ${zone} zone. ${recent.length} recent messages from ${speakers}.`,
    topics ? `Topics: ${topics}.` : '',
    `Avg intensity: ${avgEntropy.toFixed(2)}]`,
  ].filter(Boolean).join(' ');
}

function _extractTopics(buffer) {
  // Simple word frequency — not LLM, just signal words
  const stopWords = new Set(['the','a','an','is','it','this','that','of','to','in','and','or','but','i','you','he','she','they','we']);
  const freq = {};
  for (const m of buffer) {
    if (!m.content) continue;
    for (const word of m.content.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stopWords.has(w))) {
      freq[word] = (freq[word] || 0) + 1;
    }
  }
  return Object.entries(freq)
    .sort(([,a],[,b]) => b - a)
    .slice(0, 3)
    .map(([w]) => w)
    .join(', ');
}
