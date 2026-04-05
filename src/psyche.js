/**
 * psyche.js — Maya's Full Emotional Architecture
 *
 * Five-layer internal system:
 *
 * LAYER 1 — CORE TRAITS (DNA, stable)
 *   curiosity / sarcasm / empathy / confidence / attachment
 *   These are bias multipliers on decisions. Never change message-to-message.
 *   Drift very slowly over months via dream process.
 *
 * LAYER 2 — HORMONE SYSTEM (the real driver)
 *   dopamine  — reward, excitement (spikes on praise, novelty)
 *   cortisol  — stress, threat    (spikes on insults, conflict)
 *   oxytocin  — bonding, trust    (builds with warmth, DMs)
 *   serotonin — stability baseline (slow-moving, mood floor)
 *
 *   Two-speed decay (like biology):
 *   Fast surface: decays within a session
 *   Slow baseline: persists across sessions, shifts over weeks
 *
 * LAYER 3 — EMOTIONAL STATE (moment-to-moment)
 *   joy / irritation / affection / curiosity / fear
 *   Driven BY hormones, not directly by input signals.
 *   Multiple emotions coexist. Highest weighted one shapes tone.
 *
 * LAYER 4 — ENTROPY (internal chaos accumulator)
 *   0–10 scale. Accumulates from conflict and contradiction.
 *   At 6+: response tone becomes conflicted/reactive
 *   At 9+: mask starts slipping
 *   Decays slowly over time.
 *
 * LAYER 5 — SOCIAL MASK
 *   mask_strength: 0–1 (how well she maintains composure)
 *   Starts at 0.75. Weakens as entropy rises.
 *   At entropy 9+: mask fails, internal state bleeds through.
 *   Rarely slips — she's composed by nature.
 *
 * OUTPUT: composite state + internal monologue
 *   Monologue = what she actually feels (not necessarily what she says)
 *   Tone injection = what leaks through the mask into her actual reply
 */

import db from './db.js';

// ── In-memory state (per channel, fast layer) ─────────────────────────────────
// channelId → ChannelPsyche
const _channels = new Map();

// ── Cached slow layers ────────────────────────────────────────────────────────
let _coreTraits        = null;
let _hormoneBaseline   = null;
let _slowLoaded        = false;

// ── Constants ─────────────────────────────────────────────────────────────────
const SNAPSHOT_EVERY   = 8;
const MASK_BASE        = 0.75;   // Maya's default composure
const ENTROPY_SLIP     = 9.0;    // entropy threshold where mask fails
const ENTROPY_DECAY    = 0.08;   // entropy decays per message naturally
const ENTROPY_MAX      = 10.0;

// ── DB loaders ────────────────────────────────────────────────────────────────

async function _loadSlowLayers() {
  if (_slowLoaded) return;
  try {
    const [[traitRows], [hormoneRows]] = await Promise.all([
      db.execute(`SELECT trait, value FROM maya_core_traits`),
      db.execute(`SELECT hormone, value FROM maya_hormone_baseline`),
    ]);

    _coreTraits = {
      curiosity:  0.9, sarcasm:    0.6,
      empathy:    0.7, confidence: 0.5, attachment: 0.8,
    };
    for (const r of traitRows) _coreTraits[r.trait] = parseFloat(r.value);

    _hormoneBaseline = {
      dopamine: 0.5, cortisol: 0.2, oxytocin: 0.5, serotonin: 0.6,
    };
    for (const r of hormoneRows) _hormoneBaseline[r.hormone] = parseFloat(r.value);

    _slowLoaded = true;
    console.log(`[psyche] loaded — traits: ${JSON.stringify(_coreTraits)}`);
  } catch (e) {
    console.warn('[psyche] slow layer load failed:', e.message);
    _coreTraits      = { curiosity: 0.9, sarcasm: 0.6, empathy: 0.7, confidence: 0.5, attachment: 0.8 };
    _hormoneBaseline = { dopamine: 0.5, cortisol: 0.2, oxytocin: 0.5, serotonin: 0.6 };
    _slowLoaded = true;
  }
}

function _getChannel(channelId) {
  if (!_channels.has(channelId)) {
    const hb = _hormoneBaseline || { dopamine: 0.5, cortisol: 0.2, oxytocin: 0.5, serotonin: 0.6 };
    _channels.set(channelId, {
      // Fast hormones (decay within session)
      hormones: {
        dopamine:  hb.dopamine,
        cortisol:  hb.cortisol,
        oxytocin:  hb.oxytocin,
        serotonin: hb.serotonin,
      },
      // Emotional state (driven by hormones)
      emotions: {
        joy:        0.3,
        irritation: 0.1,
        affection:  0.3,
        curiosity:  0.5,
        fear:       0.1,
      },
      // Internal entropy (chaos accumulator)
      entropy:      0.0,
      // Message tracking
      messageCount: 0,
      lastUpdated:  Date.now(),
      sessionId:    null,
    });
  }
  return _channels.get(channelId);
}

// ── Main update ───────────────────────────────────────────────────────────────

/**
 * Get the current raw channel state (hormones, emotions, entropy).
 * Used by handler.js to feed internal conflict signals into entropy computation.
 */
export function getChannelState(channelId) {
  return _channels.get(channelId) || null;
}

/**
 * Process a message through the full emotional architecture.
 * Returns composite state + monologue + tone injection.
 *
 * @param {object} signals
 *   channelId, userId, entropy (0–1), sentiment, sentimentScore,
 *   intent, trustLevel, velocity, selfTraits, sessionId
 */
export async function updateState(signals) {
  const {
    channelId,
    userId,
    entropy        = 0.4,
    sentiment      = 'neutral',
    sentimentScore = 0,
    intent         = 'group_chatter',
    trustLevel     = 3,
    velocity       = 2,
    selfTraits     = [],
    sessionId      = null,
  } = signals;

  await _loadSlowLayers();
  const ch     = _getChannel(channelId);
  const traits = _coreTraits;
  const hb     = _hormoneBaseline;

  if (sessionId && !ch.sessionId) ch.sessionId = sessionId;

  // ── LAYER 2: Hormone updates ──────────────────────────────────────────────
  _updateHormones(ch, sentiment, sentimentScore, intent, trustLevel, entropy, traits);

  // ── LAYER 3: Emotion updates (driven by hormones) ─────────────────────────
  _updateEmotions(ch, traits);

  // ── LAYER 4: Entropy accumulation/decay ───────────────────────────────────
  _updateEntropy(ch, sentiment, sentimentScore, intent, entropy);

  // ── LAYER 5: Mask strength ────────────────────────────────────────────────
  const maskStrength = _computeMask(ch.entropy);
  const maskFailing  = ch.entropy >= ENTROPY_SLIP;

  // ── Hormone fast decay toward baseline (every message) ───────────────────
  // Fast layer decays 8% per message toward baseline
  for (const h of ['dopamine', 'cortisol', 'oxytocin', 'serotonin']) {
    ch.hormones[h] = lerp(ch.hormones[h], hb[h], 0.08);
    ch.hormones[h] = round(clamp(ch.hormones[h], 0, 1));
  }

  ch.messageCount++;
  ch.lastUpdated = Date.now();

  // ── Snapshot ──────────────────────────────────────────────────────────────
  if (ch.messageCount % SNAPSHOT_EVERY === 0 && ch.sessionId) {
    _saveSnapshot(ch.sessionId, ch).catch(() => {});
  }

  // ── Build outputs ─────────────────────────────────────────────────────────
  const composite = _buildComposite(ch, hb, traits);
  const monologue = _buildMonologue(ch, composite, sentiment, intent, trustLevel, selfTraits, maskFailing);
  const toneHints = _buildToneHints(ch, composite, maskStrength, maskFailing, traits);

  console.log(
    `[psyche] ch=${channelId} ` +
    `d=${round(ch.hormones.dopamine)} c=${round(ch.hormones.cortisol)} ` +
    `o=${round(ch.hormones.oxytocin)} s=${round(ch.hormones.serotonin)} ` +
    `ent=${ch.entropy.toFixed(1)} mask=${maskStrength.toFixed(2)} ` +
    `→ "${monologue.slice(0, 50)}"`
  );

  return { ...composite, monologue, toneHints, entropy: ch.entropy, maskFailing };
}

// ── Layer 2: Hormone updates ──────────────────────────────────────────────────

function _updateHormones(ch, sentiment, sentimentScore, intent, trustLevel, entropy, traits) {
  const h = ch.hormones;
  const ss = sentimentScore; // signed -1 to +1

  // DOPAMINE — reward/excitement
  // Spikes: praise, humor, interesting topic, novelty
  // Decays with boring/hostile interaction
  if (sentiment === 'positive' && ss > 0.3) {
    h.dopamine = clamp(h.dopamine + 0.12 * traits.curiosity, 0, 1);
  } else if (intent === 'emotional' && trustLevel >= 4) {
    h.dopamine = clamp(h.dopamine + 0.06, 0, 1);  // connection = small reward
  } else if (sentiment === 'negative') {
    h.dopamine = clamp(h.dopamine - 0.05, 0, 1);
  }

  // CORTISOL — stress/threat
  // Spikes: insults, hostility, conflict, spam
  if (sentiment === 'negative' && ss < -0.3) {
    h.cortisol = clamp(h.cortisol + 0.15, 0, 1);
  } else if (intent === 'directed_at_other' && entropy > 0.6) {
    h.cortisol = clamp(h.cortisol + 0.04, 0, 1);  // tense convo around her
  } else {
    h.cortisol = clamp(h.cortisol - 0.03, 0, 1);  // naturally falls
  }

  // OXYTOCIN — bonding/trust
  // Builds with trust, emotional sharing, DMs, warmth
  // Drops with hostility
  const trustFactor = (trustLevel - 3) / 2;  // -1 to +1
  if (intent === 'emotional') {
    h.oxytocin = clamp(h.oxytocin + 0.08 * traits.empathy, 0, 1);
  } else if (sentiment === 'positive' && trustLevel >= 4) {
    h.oxytocin = clamp(h.oxytocin + 0.04, 0, 1);
  } else if (sentiment === 'negative' && ss < -0.5) {
    h.oxytocin = clamp(h.oxytocin - 0.08, 0, 1);
  }
  h.oxytocin = clamp(h.oxytocin + trustFactor * 0.02, 0, 1);

  // SEROTONIN — stability baseline
  // Very slow moving. Stable positive interactions push it up.
  // Sustained conflict pushes it down.
  if (ch.entropy > 6 && h.cortisol > 0.7) {
    h.serotonin = clamp(h.serotonin - 0.01, 0.1, 1);  // very slow erosion
  } else if (h.dopamine > 0.7 && h.cortisol < 0.3) {
    h.serotonin = clamp(h.serotonin + 0.005, 0, 1);   // very slow build
  }
}

// ── Layer 3: Emotion updates (from hormones) ──────────────────────────────────

function _updateEmotions(ch, traits) {
  const h = ch.hormones;
  const e = ch.emotions;

  // JOY — dopamine-driven, tempered by serotonin
  const joyTarget = clamp(h.dopamine * 0.7 + h.serotonin * 0.3, 0, 1);
  e.joy = lerp(e.joy, joyTarget, 0.15);

  // IRRITATION — cortisol-driven, empathy reduces it
  const irritTarget = clamp(h.cortisol * 0.9 - traits.empathy * 0.1, 0, 1);
  e.irritation = lerp(e.irritation, irritTarget, 0.20);

  // AFFECTION — oxytocin-driven, attachment trait amplifies
  const affTarget = clamp(h.oxytocin * traits.attachment, 0, 1);
  e.affection = lerp(e.affection, affTarget, 0.08);  // slower — bonds form slowly

  // CURIOSITY — baseline trait + dopamine spike
  const curTarget = clamp(traits.curiosity * 0.6 + h.dopamine * 0.4, 0, 1);
  e.curiosity = lerp(e.curiosity, curTarget, 0.12);

  // FEAR — low-level uncertainty
  // Spikes with high cortisol and high entropy, but Maya's confidence suppresses it
  const fearTarget = clamp(h.cortisol * 0.4 * (1 - traits.confidence), 0, 0.5);
  e.fear = lerp(e.fear, fearTarget, 0.10);

  // Round all
  for (const k of Object.keys(e)) e[k] = round(e[k]);
}

// ── Layer 4: Entropy ──────────────────────────────────────────────────────────

/**
 * Update channel entropy accumulator (0–10 scale) from the normalised
 * per-message entropy signal plus internal state conflicts.
 *
 * The per-message entropy (0–1) from estimateEntropy is the INPUT signal.
 * ch.entropy is the RUNNING ACCUMULATOR that persists across messages —
 * it represents how much unresolved tension has built up in this session.
 *
 * Entropy zones (ch.entropy):
 *   0–3   Restful   — confident, fast replies
 *   4–6   Engaged   — curious, deeper responses (best zone)
 *   7–8   Conflict  — hesitation, meta layer active
 *   9–10  Breakdown — suppression possible, mask fails
 */
function _updateEntropy(ch, sentiment, sentimentScore, intent, messageEntropy = 0.4) {
  let delta = 0;

  // ── Input from per-message entropy signal ─────────────────────────────────
  // High entropy messages push the accumulator up
  // Low entropy messages contribute to decay
  if (messageEntropy > 0.6) {
    delta += (messageEntropy - 0.5) * 2.5;  // 0.6→0.25, 0.8→0.75, 1.0→1.25
  }

  // ── Emotional conflict (internal state) ────────────────────────────────────
  // These are the strongest entropy sources — internal contradictions
  const ir = ch.emotions.irritation || 0;
  const af = ch.emotions.affection  || 0;
  const ox = ch.hormones.oxytocin   || 0.5;
  const co = ch.hormones.cortisol   || 0.2;

  if (ir > 0.6 && af > 0.5) {
    delta += 0.9;  // irritated but still caring = high inner conflict
  }
  if (co > 0.6 && ox > 0.6) {
    delta += 0.6;  // bonded but threatened = classic conflict
  }

  // ── Sentiment-driven accumulation ─────────────────────────────────────────
  if (sentiment === 'negative' && sentimentScore < -0.5) {
    delta += 1.0;  // sharp negativity
  } else if (sentiment === 'negative' && sentimentScore < -0.3) {
    delta += 0.4;  // mild negativity
  }

  // ── Resolution signals (reduce entropy) ───────────────────────────────────
  // Clear positive interaction settles Maya — she knows what's happening
  if (sentiment === 'positive' && sentimentScore > 0.5) delta -= 0.5;
  if (sentiment === 'positive' && sentimentScore > 0.3) delta -= 0.2;

  // Intent clarity reduces entropy — if she knows what they want
  if (intent === 'question_to_maya' && sentiment !== 'negative') delta -= 0.15;
  if (intent === 'engaged_reply')                                  delta -= 0.10;

  // ── Natural decay per message ─────────────────────────────────────────────
  delta -= ENTROPY_DECAY;  // 0.08 per message toward baseline

  ch.entropy = clamp(ch.entropy + delta, 0, ENTROPY_MAX);
  ch.entropy = round(ch.entropy);
}

// ── Layer 5: Mask ─────────────────────────────────────────────────────────────

function _computeMask(entropy) {
  if (entropy < 5)  return MASK_BASE;
  if (entropy < 7)  return MASK_BASE - 0.1;   // slight strain
  if (entropy < 9)  return MASK_BASE - 0.2;   // visible strain
  return 0.2;                                   // mask failing
}

// ── Composite state (for LLM consumption) ────────────────────────────────────
// Maps the hormone+emotion system into legacy energy/warmth/seriousness
// so downstream code continues to work without full rewrite

function _buildComposite(ch, hb, traits) {
  const h = ch.hormones;
  const e = ch.emotions;

  return {
    // energy: dopamine + joy → how active/engaged she is
    energy:      round(clamp(h.dopamine * 0.5 + e.joy * 0.3 + h.serotonin * 0.2, 0.1, 0.95)),
    // warmth: oxytocin + affection → how open/caring
    warmth:      round(clamp(h.oxytocin * 0.5 + e.affection * 0.4 + (1 - e.irritation) * 0.1, 0.1, 0.95)),
    // seriousness: fear + low dopamine + high empathy → depth
    seriousness: round(clamp(e.curiosity * 0.4 + traits.empathy * 0.3 + (1 - h.dopamine) * 0.3, 0.05, 0.90)),
    // Raw emotional state for inspection
    emotions:    { ...e },
    hormones:    { ...h },
    traits,
  };
}

// ── Internal monologue ────────────────────────────────────────────────────────
// What Maya actually feels. NOT what she says.
// This is injected into the LLM as her internal thought — the LLM decides
// how much of it leaks through based on the mask.

function _buildMonologue(ch, composite, sentiment, intent, trustLevel, selfTraits, maskFailing) {
  const e  = ch.emotions;
  const h  = ch.hormones;

  // Build a specific, non-generic internal sentence from actual hormone+emotion values
  // The goal: each state produces a distinct feeling Maya can act from

  // Core energy/engagement from dopamine + serotonin
  const energized  = h.dopamine   > 0.65;
  const depleted   = h.dopamine   < 0.35 && h.serotonin < 0.45;
  const stressed   = h.cortisol   > 0.55;
  const bonded     = h.oxytocin   > 0.65 && trustLevel >= 4;
  const irritated  = e.irritation > 0.45;
  const joyful     = e.joy        > 0.55;
  const affection  = e.affection  > 0.50;
  const fearful    = e.fear       > 0.25;
  const highEntropy = ch.entropy  >= 6;

  // Build a single clear sentence — not a list
  let core = '';

  if (highEntropy && stressed) {
    core = "I'm a bit overwhelmed, keeping composure";
  } else if (irritated && affection) {
    core = "I'm a bit annoyed but I still care about this person";
  } else if (irritated && !affection) {
    core = stressed
      ? "I'm actually annoyed and on edge right now"
      : "mildly irritated, keeping it together";
  } else if (joyful && bonded) {
    core = "I'm in a good mood and genuinely like this person";
  } else if (joyful && energized) {
    core = "I'm a bit low-energy, and I'm enjoying this conversation";
  } else if (bonded && affection) {
    core = "I actually care about this person, feel close to them";
  } else if (affection && !bonded) {
    core = "I'm warm toward them, open to talking";
  } else if (depleted) {
    core = "I'm a bit drained, keeping it brief";
  } else if (fearful) {
    core = "something feels uncertain, staying cautious";
  } else if (energized) {
    core = "I'm engaged, paying attention";
  } else {
    // Check intent for context-specific monologue
    if (intent === 'emotional')        core = "this feels like something real, I should be present";
    else if (intent === 'question_to_maya') core = "they're asking me something, I should actually think";
    else if (intent === 'engaged_reply')    core = "we're in a flow, keep it natural";
    else                                    core = "present but not especially invested right now";
  }

  // Add entropy note if significant
  if (ch.entropy >= 9) core += " — my composure is slipping";
  else if (ch.entropy >= 6) core += ", feeling reactive";

  // Trust modifier
  if (trustLevel >= 5 && bonded) core += ", I actually like this person";
  if (trustLevel <= 2)           core += ", keeping some distance";

  // Mask state
  if (maskFailing) core += " [feelings bleeding through]";

  return core;
}

// ── Tone hints (what leaks through the mask into actual reply) ────────────────
// These are injected as LLM state instructions.
// When mask is strong: subtle hints only.
// When mask fails (entropy 9+): raw state description.

function _buildToneHints(ch, composite, maskStrength, maskFailing, traits) {
  const e  = ch.emotions;
  const h  = ch.hormones;
  const hints = [];

  if (maskFailing) {
    // Mask down — raw state leaks through
    if (e.irritation > 0.6)  hints.push("You are visibly irritated — keep it sharp and brief");
    if (e.joy > 0.7)          hints.push("You are in a good mood and it shows");
    if (h.cortisol > 0.7)    hints.push("You are stressed — responses are clipped");
    if (ch.entropy >= 9)      hints.push("You feel overwhelmed — your usual composure is cracking slightly");
  } else {
    // Mask holding — subtle leakage only
    if (e.irritation > 0.6)  hints.push("Slight edge in your tone — not showing it directly, but it's there");
    if (e.affection > 0.6)   hints.push("Genuinely warm toward this person, though you won't make it obvious");
    if (h.dopamine > 0.7)    hints.push("Something about this is interesting to you");
    if (h.cortisol > 0.6)    hints.push("Keeping composure but slightly guarded");
    if (e.curiosity > 0.7)   hints.push("Actually curious — lean in slightly");
    if (traits.sarcasm > 0.5 && e.irritation > 0.3) {
      hints.push("Sarcasm is your default shield when mildly annoyed");
    }
  }

  // Serotonin floor affects overall stability
  if (h.serotonin < 0.3) hints.push("Low baseline today — not much patience");
  else if (h.serotonin > 0.7) hints.push("Baseline is stable — can afford to be more open");

  return hints.join('. ');
}

// ── Slow drift update (called by dream process) ───────────────────────────────

export async function updateSlowDrift() {
  try {
    // Hormone baseline drift toward recent average (very slow)
    const [rows] = await db.execute(
      `SELECT AVG(energy) as e, AVG(warmth) as w, AVG(seriousness) as s, COUNT(*) as n
       FROM maya_mood_snapshots
       WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );
    const snap = rows[0];
    if (!snap || snap.n < 3) return;

    // Map mood snapshots back to hormone baselines (approximate)
    const DRIFT = 0.03;  // very slow — 3% per dream cycle
    await db.execute(
      `UPDATE maya_hormone_baseline SET value = value * ? + ? * ? WHERE hormone = 'serotonin'`,
      [1 - DRIFT, parseFloat(snap.w) || 0.6, DRIFT]
    );
    await db.execute(
      `UPDATE maya_hormone_baseline SET value = value * ? + ? * ? WHERE hormone = 'dopamine'`,
      [1 - DRIFT, parseFloat(snap.e) || 0.5, DRIFT]
    );

    // Update maya_personality table for backward compatibility
    await db.execute(
      `INSERT INTO maya_personality (axis, value, sample_count)
       VALUES ('energy',?,?),('warmth',?,?),('seriousness',?,?)
       ON DUPLICATE KEY UPDATE value=VALUES(value), sample_count=sample_count+VALUES(sample_count)`,
      [parseFloat(snap.e), snap.n, parseFloat(snap.w), snap.n, parseFloat(snap.s), snap.n]
    );

    // Invalidate cache
    _slowLoaded = false; _coreTraits = null; _hormoneBaseline = null;
    console.log(`[psyche] slow drift updated (${snap.n} snapshots)`);
  } catch (e) {
    console.error('[psyche] drift update failed:', e.message);
  }
}

export async function getState(channelId) {
  await _loadSlowLayers();
  const ch = _getChannel(channelId);
  return _buildComposite(ch, _hormoneBaseline, _coreTraits);
}

export async function initPsyche() {
  await _loadSlowLayers();
  console.log('[psyche] initialised ✓');
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function _saveSnapshot(sessionId, ch) {
  const composite = _buildComposite(ch, _hormoneBaseline, _coreTraits);
  await db.execute(
    `INSERT INTO maya_mood_snapshots (session_id, energy, warmth, seriousness)
     VALUES (?, ?, ?, ?)`,
    [sessionId, composite.energy, composite.warmth, composite.seriousness]
  );
}

// ── Math helpers ──────────────────────────────────────────────────────────────
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function lerp(a, b, t)       { return a + clamp(t, 0, 1) * (b - a); }
function round(v)             { return Math.round(v * 1000) / 1000; }
