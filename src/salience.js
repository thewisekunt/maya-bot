/**
 * salience.js — Fast-path memory capture
 *
 * Runs after every reply. Computes a salience score from IV signals
 * and psyche state delta. If score exceeds Maya's learned threshold,
 * immediately embeds the exchange into Qdrant as a salient_moment.
 *
 * This is the "trauma-equivalent" fast path — high-intensity experiences
 * don't wait for the dream cycle. They write now.
 *
 * The threshold itself is a learned parameter in maya_params.
 * Maya adjusts it based on whether captured moments actually help future recall.
 *
 * Signals that contribute to salience score:
 *   hormone_delta    — large state change in any hormone (0.35 weight)
 *   sentiment_flip   — negative→positive or reverse in 2 turns (0.30)
 *   belief_conflict  — IV detected a belief clash (0.25)
 *   clarification    — Maya was confused, user explained (0.25)
 *   boundary_fired   — defend action triggered (0.40 — always high)
 *   curiosity_fired  — think.js curiosity trigger (0.20)
 *   trust_shift      — trust score changed this session (0.20)
 *   analyzeConvo     — IV tool returned non-stay (0.35)
 *
 * These weights are fixed. The threshold is learned.
 */

import db from './db.js';
import { embed } from './embedder.js';
import { upsertBatch } from './vector.js';
import { p } from './params.js';
import { getActiveSession } from './stm.js';

// ── Signal weights ─────────────────────────────────────────────────────────────
const SIGNAL_WEIGHTS = {
  hormone_delta:    0.35,
  sentiment_flip:   0.30,
  belief_conflict:  0.25,
  clarification:    0.25,
  boundary_fired:   0.40,
  curiosity_fired:  0.20,
  trust_shift:      0.20,
  analyze_convo:    0.35,
};

// Hormone delta threshold — movement above this in one exchange is significant
const HORMONE_DELTA_THRESHOLD = 0.12;

/**
 * Main entry point. Call fire-and-forget after every reply.
 *
 * @param {object} ctx
 *   userId, channelId, guildId
 *   prevPsyche    — psyche state BEFORE this exchange
 *   currPsyche    — psyche state AFTER this exchange
 *   innerCognition — IV output
 *   prevSentiment  — sentiment of the previous message
 *   currSentiment  — sentiment of the current message
 *   userMessage    — what the user said
 *   mayaReply      — what Maya replied
 *   sessionId      — current session ID
 */
export async function checkSalience(ctx) {
  try {
    const {
      userId, channelId, guildId,
      prevPsyche, currPsyche,
      innerCognition,
      prevSentiment = 'neutral',
      currSentiment = 'neutral',
      userMessage   = '',
      mayaReply     = '',
      sessionId     = null,
    } = ctx;

    // ── Compute salience score ───────────────────────────────────────────────
    const signals = {};
    let score     = 0;

    // 1. Hormone delta — did this exchange move Maya's state significantly?
    if (prevPsyche && currPsyche) {
      const prev = prevPsyche.hormones || {};
      const curr = currPsyche.hormones || {};
      const maxDelta = Math.max(
        Math.abs((curr.dopamine  || 0) - (prev.dopamine  || 0)),
        Math.abs((curr.cortisol  || 0) - (prev.cortisol  || 0)),
        Math.abs((curr.oxytocin  || 0) - (prev.oxytocin  || 0)),
        Math.abs((curr.serotonin || 0) - (prev.serotonin || 0)),
      );
      if (maxDelta > HORMONE_DELTA_THRESHOLD) {
        signals.hormone_delta = maxDelta;
        score += SIGNAL_WEIGHTS.hormone_delta * Math.min(maxDelta / 0.3, 1);
      }
    }

    // 2. Sentiment flip — negative→positive or positive→negative
    const sentFlip = (
      (prevSentiment === 'negative' && currSentiment === 'positive') ||
      (prevSentiment === 'positive' && currSentiment === 'negative')
    );
    if (sentFlip) {
      signals.sentiment_flip = true;
      score += SIGNAL_WEIGHTS.sentiment_flip;
    }

    // 3. Belief conflict from IV
    if (innerCognition?.beliefConflict) {
      signals.belief_conflict = true;
      score += SIGNAL_WEIGHTS.belief_conflict;
    }

    // 4. Maya was confused (needsClarification fired) — user likely explained
    if (innerCognition?.needsClarification) {
      signals.clarification = true;
      score += SIGNAL_WEIGHTS.clarification;
    }

    // 5. Boundary/defend action — always high salience
    if (innerCognition?.action === 'defend' || innerCognition?.boundaryType) {
      signals.boundary_fired = innerCognition.boundaryType || true;
      score += SIGNAL_WEIGHTS.boundary_fired;
    }

    // 6. Curiosity trigger fired in deliberation
    if (innerCognition?.deliberation?.trigger === 'curiosity_trigger') {
      signals.curiosity_fired = true;
      score += SIGNAL_WEIGHTS.curiosity_fired;
    }

    // 7. analyzeConvo returned non-stay (IV was stressed enough to analyze)
    if (innerCognition?.personalityMode && innerCognition.personalityMode !== 'normal') {
      signals.analyze_convo = innerCognition.personalityMode;
      score += SIGNAL_WEIGHTS.analyze_convo;
    }

    score = Math.min(score, 1.0);

    // ── Check against learned threshold ─────────────────────────────────────
    const threshold = await p('salience_threshold') ?? 0.35;

    if (score < threshold) return;  // below threshold — slow path only

    console.log(`[salience] score=${score.toFixed(2)} threshold=${threshold.toFixed(2)} signals=${Object.keys(signals).join(',')}`);

    // ── Embed and store the exchange ─────────────────────────────────────────
    const exchangeText = `${userMessage}\nMaya: ${mayaReply}`.slice(0, 600);
    const vec = await embed(exchangeText).catch(() => null);
    if (!vec) return;

    const qdrantId = `sal_${channelId}_${userId}_${Date.now()}`;
    await upsertBatch([{
      id:     qdrantId,
      vector: vec,
      payload: {
        memory_type:     'salient_moment',
        discord_user_id: userId,
        guild_id:        guildId || null,
        channel_id:      channelId,
        session_id:      sessionId,
        message:         exchangeText,
        salience_score:  score,
        signals_fired:   Object.keys(signals),
        threshold_used:  threshold,
        weight:          2.5,   // higher than facts (1.8) and summaries (1.5)
        created_at:      new Date().toISOString(),
      },
    }]);

    // ── Log to DB for outcome tracking (dream cycle reads this) ───────────────
    await db.execute(
      `INSERT INTO maya_salience_log
         (session_id, channel_id, user_id, salience_score, threshold_used,
          signals_fired, exchange_text, qdrant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        channelId,
        userId,
        score,
        threshold,
        JSON.stringify(Object.keys(signals)),
        exchangeText.slice(0, 500),
        qdrantId,
      ]
    ).catch(() => {});

  } catch (e) {
    console.warn('[salience] check failed:', e.message);
  }
}
