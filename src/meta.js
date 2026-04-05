/**
 * meta.js — Maya's inner voice and meta-cognitive layer
 *
 * Architecture:
 *   Primary Mind (LLM call 1) → generates a response from emotion + memory
 *   Meta Mind    (LLM call 2) → evaluates that response before sending
 *
 * Meta is NOT a filter. It's a second perspective — Maya's capacity to
 * look at her own words before saying them and ask: "is this right?"
 *
 * Activates conditionally — most messages skip meta entirely:
 *   - Low entropy + casual message → primary reply sent directly
 *   - High entropy / emotional weight / belief conflict → meta engages
 *
 * Cost: ~150 tokens per activation, cheap model, rare trigger.
 * Budget: fits within "max 2 LLM calls" constraint.
 *
 * Meta layer behaviors (in order of rarity):
 *   Regulator  — softens extremes (most common, ~60% of activations)
 *   Strategist — thinks ahead: "will this cause disengagement?"
 *   Self-Doubt — adds hesitation: "maybe I'm misreading this"
 *   Reflector  — notices pattern breaks: "this isn't like them"
 *   Suppressor — blocks the response entirely (rare, high entropy only)
 */

import axios  from 'axios';
import db     from './db.js';
import { config } from './config.js';

// ── Trigger thresholds ────────────────────────────────────────────────────────
const ENTROPY_THRESHOLD    = 4.0;   // above this: meta may activate
const ENTROPY_CERTAIN      = 7.0;   // above this: meta almost always activates
const IRRITATION_THRESHOLD = 0.55;  // high irritation → check if it's showing too much
const ATTACHMENT_THRESHOLD = 0.65;  // high attachment + any tension → careful
const CONFIDENCE_THRESHOLD = 0.30;  // low confidence LLM score → worth checking

// ── Belief cache (loaded per-call, small) ────────────────────────────────────
async function _getRelevantBeliefs(userId, guildId) {
  try {
    const [userBeliefs] = await db.execute(
      `SELECT statement, confidence, emotional_weight
       FROM maya_beliefs
       WHERE type='user' AND target_id=?
         AND confidence > 0.3
       ORDER BY confidence DESC LIMIT 3`,
      [userId]
    );
    const [selfBeliefs] = await db.execute(
      `SELECT statement, confidence
       FROM maya_beliefs
       WHERE type='self'
         AND confidence > 0.5
       ORDER BY confidence DESC LIMIT 3`
    );
    return { userBeliefs: userBeliefs || [], selfBeliefs: selfBeliefs || [] };
  } catch { return { userBeliefs: [], selfBeliefs: [] }; }
}

// ── Should meta activate? ─────────────────────────────────────────────────────

/**
 * Determine if the meta layer should activate for this exchange.
 * Returns { activate: bool, trigger: string, weight: number }
 */
export function shouldActivateMeta({
  entropy       = 0,
  emotions      = {},
  trustLevel    = 3,
  attachmentScore = 0.3,
  sentiment     = 'neutral',
  sentimentScore  = 0,
  beliefConflict  = false,
  primaryReply    = '',
}) {
  // Fast path: clearly casual, skip meta
  if (entropy < ENTROPY_THRESHOLD &&
      (emotions.irritation || 0) < IRRITATION_THRESHOLD &&
      sentiment !== 'negative' &&
      !beliefConflict) {
    return { activate: false, trigger: null, weight: 0 };
  }

  let weight  = 0;
  let trigger = null;

  // High entropy — most reliable signal something complex is happening
  if (entropy >= ENTROPY_CERTAIN) {
    weight  = 1.0;
    trigger = 'high_entropy';
  } else if (entropy >= ENTROPY_THRESHOLD) {
    weight  = (entropy - ENTROPY_THRESHOLD) / (ENTROPY_CERTAIN - ENTROPY_THRESHOLD);
    trigger = 'elevated_entropy';
  }

  // Irritation + high attachment = risky combo (might say something she regrets)
  if ((emotions.irritation || 0) >= IRRITATION_THRESHOLD &&
       attachmentScore >= ATTACHMENT_THRESHOLD) {
    weight  = Math.max(weight, 0.8);
    trigger = trigger || 'attachment_tension';
  }

  // Negative sentiment from a trusted user — unusual, worth pausing
  if (sentiment === 'negative' && sentimentScore < -0.5 && trustLevel >= 4) {
    weight  = Math.max(weight, 0.7);
    trigger = trigger || 'trusted_user_conflict';
  }

  // Belief conflict detected externally
  if (beliefConflict) {
    weight  = Math.max(weight, 0.75);
    trigger = trigger || 'belief_conflict';
  }

  // Primary reply is very short after a complex message — might be dismissive
  if (primaryReply.trim().split(' ').length <= 3 && entropy > 3) {
    weight  = Math.max(weight, 0.5);
    trigger = trigger || 'possibly_dismissive';
  }

  // Stochastic element: at medium weight, 40% chance to skip (prevents mechanicalness)
  if (weight > 0 && weight < 0.7 && Math.random() > 0.6) {
    return { activate: false, trigger: null, weight: 0 };
  }

  return { activate: weight >= 0.4, trigger, weight };
}

// ── Meta evaluation ───────────────────────────────────────────────────────────

/**
 * Run the meta layer — evaluate the primary response and decide what to do.
 *
 * @param {object} snapshot  — full state snapshot
 * @returns {{ decision, reason, finalReply, metaChanged }}
 */
export async function runMeta(snapshot) {
  const {
    primaryReply,
    message,
    prefName,
    trustLevel,
    attachmentScore,
    emotions,
    hormones,
    entropy,
    monologue,
    userBeliefs,
    selfBeliefs,
    trigger,
  } = snapshot;

  // Build a compact state description for the meta prompt
  const emotionDesc = Object.entries(emotions || {})
    .filter(([, v]) => v > 0.3)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k}: ${v.toFixed(2)}`)
    .join(', ') || 'neutral';

  const beliefCtx = [
    ...(userBeliefs || []).map(b => `About ${prefName}: "${b.statement}" (conf: ${b.confidence.toFixed(2)})`),
    ...(selfBeliefs || []).map(b => `About herself: "${b.statement}"`),
  ].join('\n') || 'No strong beliefs formed yet.';

  const prompt = `You are Maya's inner voice — her meta-cognitive layer.

Your job is NOT to reply to the user.
Your job is to evaluate whether Maya's response is right for this moment.

─── SITUATION ───
${prefName} said: "${message}"
Maya was about to say: "${primaryReply}"

─── MAYA'S STATE ───
Entropy (emotional chaos): ${entropy.toFixed(1)}/10
Emotions: ${emotionDesc}
Internal state: ${monologue || 'unclear'}
Trust with ${prefName}: ${trustLevel}/5
Attachment to ${prefName}: ${(attachmentScore * 100).toFixed(0)}%
Meta trigger: ${trigger}

─── BELIEFS ───
${beliefCtx}

─── EVALUATION TASK ───
Consider:
1. Does the response match her emotional state authentically?
2. Is she being too harsh, too soft, or performative?
3. Given her attachment/trust, could this cause regret or distance?
4. Is there a more real response — not better, just more her?

Return ONLY valid JSON:
{
  "decision": "approve" | "modify" | "suppress",
  "reason": "<10 words max>",
  "new_response": "<only if modify — the adjusted reply, keep it short>"
}

Rules:
- approve if the response is genuine, even if imperfect
- modify only if the change makes it more authentically Maya
- suppress only at entropy > 8 or if response would cause real harm
- keep Discord tone — casual, Hinglish ok, short
- never make it longer than the original unless meaning is lost`;

  try {
    const { data, status } = await axios.post(
      config.llm.endpoint,
      {
        model:       'deepseek/deepseek-chat-v3-0324',  // fast + cheap
        messages:    [{ role: 'user', content: prompt }],
        temperature: 0.3,   // lower temp — meta should be considered, not creative
        max_tokens:  150,
      },
      {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.llm.apiKey}`,
          'HTTP-Referer':  'https://chatmasala.fun',
          'X-Title':       'MayaMetaLayer',
        },
        timeout: 8_000,
        validateStatus: () => true,
      }
    );

    if (status !== 200) return _approve(primaryReply);

    const raw   = data?.choices?.[0]?.message?.content?.trim() || '{}';
    const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const result = JSON.parse(clean);

    const decision = result.decision || 'approve';
    const reason   = result.reason   || '';
    const modified = result.new_response?.trim();

    if (decision === 'suppress') {
      console.log(`[meta] SUPPRESS — ${reason}`);
      return { decision: 'suppress', reason, finalReply: null, metaChanged: true };
    }

    if (decision === 'modify' && modified && modified !== primaryReply) {
      console.log(`[meta] MODIFY — ${reason}`);
      console.log(`[meta]   was: "${primaryReply.slice(0, 80)}"`);
      console.log(`[meta]   now: "${modified.slice(0, 80)}"`);
      return { decision: 'modify', reason, finalReply: modified, metaChanged: true };
    }

    console.log(`[meta] APPROVE — ${reason || 'ok'}`);
    return _approve(primaryReply, reason);

  } catch (e) {
    console.warn('[meta] evaluation failed:', e.message);
    return _approve(primaryReply);  // fail open — don't block replies on meta errors
  }
}

function _approve(reply, reason = '') {
  return { decision: 'approve', reason, finalReply: reply, metaChanged: false };
}

// ── Log meta decisions ────────────────────────────────────────────────────────

export async function logMetaDecision({ userId, channelId, primaryReply, decision, reason, finalReply, entropy, trigger }) {
  try {
    await db.execute(
      `INSERT INTO maya_inner_voice_log
         (user_id, channel_id, primary_reply, meta_decision, meta_reason, final_reply, entropy, trigger)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        channelId || null,
        primaryReply?.slice(0, 500),
        decision,
        reason?.slice(0, 200),
        decision !== 'approve' ? finalReply?.slice(0, 500) : null,
        entropy,
        trigger,
      ]
    );
  } catch { /* non-fatal */ }
}

// ── Belief system ─────────────────────────────────────────────────────────────

/**
 * Get beliefs relevant to the current interaction.
 * Called before building the meta snapshot.
 */
export async function getBeliefs(userId, guildId) {
  return _getRelevantBeliefs(userId, guildId);
}

/**
 * Check if current interaction contradicts a known belief.
 * Returns true if a belief conflict is detected.
 */
export async function detectBeliefConflict(userId, sentiment, sentimentScore, currentTrustLevel) {
  try {
    // Get dominant user belief
    const [[belief]] = await db.execute(
      `SELECT statement, confidence, emotional_weight
       FROM maya_beliefs
       WHERE type='user' AND target_id=? AND confidence > 0.5
       ORDER BY confidence DESC LIMIT 1`,
      [userId]
    );
    if (!belief) return false;

    // Conflict: belief says positive person, but message is very negative
    const isPositiveBelief = /kind|friendly|support|warm|nice|funny|chill/i.test(belief.statement);
    const isNegativeMoment = sentiment === 'negative' && sentimentScore < -0.5;

    if (isPositiveBelief && isNegativeMoment && belief.confidence > 0.6) {
      console.log(`[meta] belief conflict: "${belief.statement}" vs negative sentiment`);
      return true;
    }

    return false;
  } catch { return false; }
}

/**
 * Update a user belief based on observed interaction.
 * Called from dream cycle — not real-time.
 * Reinforces or challenges existing beliefs.
 */
export async function updateUserBelief(userId, eventText, sentiment, sentimentScore) {
  try {
    // Find existing belief for this user
    const [[existing]] = await db.execute(
      `SELECT id, statement, confidence, emotional_weight, evidence_count
       FROM maya_beliefs WHERE type='user' AND target_id=? ORDER BY confidence DESC LIMIT 1`,
      [userId]
    );

    const isPositiveEvent = sentiment === 'positive' && sentimentScore > 0.3;
    const isNegativeEvent = sentiment === 'negative' && sentimentScore < -0.3;

    if (existing) {
      // Update confidence based on whether this event aligns with belief
      const isPositiveBelief = /kind|friendly|support|warm|nice|funny|chill/i.test(existing.statement);
      const aligns = (isPositiveBelief && isPositiveEvent) || (!isPositiveBelief && isNegativeEvent);

      const delta = aligns ? 0.05 : -0.08;  // contradictions hit harder
      const newConfidence = Math.max(0.05, Math.min(0.99, parseFloat(existing.confidence) + delta));

      await db.execute(
        `UPDATE maya_beliefs SET confidence=?, evidence_count=evidence_count+1,
         last_challenged = CASE WHEN ? < 0 THEN NOW() ELSE last_challenged END
         WHERE id=?`,
        [newConfidence, delta, existing.id]
      );

      // Store evidence
      await db.execute(
        `INSERT INTO belief_evidence (belief_id, event_text, impact_score)
         VALUES (?, ?, ?)`,
        [existing.id, eventText?.slice(0, 200), delta]
      );

      // If confidence dropped very low, belief needs reforming
      if (newConfidence < 0.2) {
        await db.execute(
          `UPDATE maya_beliefs SET statement=CONCAT('uncertain about: ', statement)
           WHERE id=?`, [existing.id]
        );
      }

    } else {
      // No existing belief — create one if this is a meaningful interaction
      if (Math.abs(sentimentScore) < 0.3) return;  // too neutral to form a belief

      const statement = isPositiveEvent
        ? `${eventText?.split(' ').slice(0, 5).join(' ')}... — tends to be positive`
        : `${eventText?.split(' ').slice(0, 5).join(' ')}... — tends to be tense`;

      await db.execute(
        `INSERT INTO maya_beliefs (type, target_id, statement, confidence, emotional_weight, evidence_count)
         VALUES ('user', ?, ?, 0.35, ?, 1)`,
        [userId, statement.slice(0, 200), Math.abs(sentimentScore) * 0.5]
      );
    }
  } catch { /* non-fatal */ }
}

/**
 * Update or form a self-belief.
 * Called from dream cycle after analyzing how interactions went.
 * Self-beliefs form from patterns in how users interact with Maya.
 */
export async function updateSelfBelief(observation, confidence) {
  try {
    // Check if a similar self-belief already exists (fuzzy match via first 30 chars)
    const [similar] = await db.execute(
      `SELECT id, confidence, evidence_count FROM maya_beliefs
       WHERE type='self' AND LEFT(statement, 30) = LEFT(?, 30)`,
      [observation]
    );

    if (similar.length > 0) {
      const row = similar[0];
      const newConf = Math.min(0.99, parseFloat(row.confidence) + 0.04);
      const isAnchor = newConf > 0.75 ? 1 : 0;
      await db.execute(
        `UPDATE maya_beliefs SET confidence=?, evidence_count=evidence_count+1, is_anchor=?
         WHERE id=?`,
        [newConf, isAnchor, row.id]
      );
    } else {
      await db.execute(
        `INSERT INTO maya_beliefs (type, target_id, statement, confidence, emotional_weight)
         VALUES ('self', NULL, ?, ?, 0.4)`,
        [observation.slice(0, 300), confidence || 0.35]
      );
    }
  } catch { /* non-fatal */ }
}

/**
 * Get Maya's current identity — anchored self-beliefs that define her core.
 * Used in sleep cycle to update her stable sense of self.
 */
export async function getIdentityCore() {
  try {
    const [rows] = await db.execute(
      `SELECT statement, confidence, emotional_weight, is_anchor
       FROM maya_beliefs
       WHERE type='self' AND confidence > 0.5
       ORDER BY is_anchor DESC, confidence DESC
       LIMIT 8`
    );
    return rows || [];
  } catch { return []; }
}

/**
 * Detect identity conflict — when two self-beliefs contradict each other.
 * Returns conflict pair or null.
 * Example: "I am liked" vs "I am often ignored"
 */
export async function detectIdentityConflict() {
  try {
    const core = await getIdentityCore();
    if (core.length < 2) return null;

    const POSITIVE_MARKERS = ['liked', 'valued', 'appreciated', 'close', 'fun', 'trusted'];
    const NEGATIVE_MARKERS = ['ignored', 'overlooked', 'dismissed', 'distant', 'serious'];

    const positives = core.filter(b => POSITIVE_MARKERS.some(m => b.statement.includes(m)));
    const negatives = core.filter(b => NEGATIVE_MARKERS.some(m => b.statement.includes(m)));

    if (positives.length > 0 && negatives.length > 0) {
      return { positive: positives[0], negative: negatives[0] };
    }
    return null;
  } catch { return null; }
}
