/**
 * inner_voice.js — Maya's cognitive core
 *
 * This is NOT a monologue writer.
 * This is the reasoning step that runs BEFORE response generation.
 *
 * Structure:
 *   1. Interpret the situation (what is actually happening?)
 *   2. Assess internal state (how am I, what do I want?)
 *   3. Plan tools (what should I use to respond well?)
 *   4. Compute intent score (how much do I want to engage?)
 *   5. Return structured cognition for intent_engine.js to decide
 *
 * Tool awareness — the inner voice knows what Maya can do:
 *   deepMemoryRecall   — pull extended Qdrant history for this user
 *   readProfile        — fetch + describe their avatar via vision
 *   analyzeThread      — fetch full reply chain for context
 *   checkRelationship  — pull full relationship + belief data
 *   readRoom           — summarize recent channel activity
 *   webSearch          — look up something unfamiliar
 *
 * Tools are PLANNED here, EXECUTED in handler.js before LLM generation.
 * Inner voice doesn't block on tools — it returns a plan.
 *
 * Post-generation:
 *   After LLM generates a reply, inner voice runs a second evaluation
 *   (the meta check — was this the right response?).
 *   This replaces the old shouldActivateMeta/runMeta scattered across meta.js.
 */

import { getChannelState } from './psyche.js';
import { getMomentum }      from './moment.js';
import { getPressureState } from './observation.js';
import { PERSONALITY_MODE, MODE_THRESHOLDS } from './personality_modes.js';
import { getObservationState, ZONES } from './observation.js';
import { getDesires, getDesirePressure, getDesireContext, fulfillDesire, onGoodInteraction, onConflict } from './desires.js';
import { getIdentityCore } from './meta.js';
import { detectBeliefConflict, getBeliefs } from './meta.js';
import { config } from './config.js';
import axios from 'axios';
import db    from './db.js';
import { updateSessionTopic, getTopicHistory, getPreviousTopic } from './stm.js';

// ── Intent smoothing ────────────────────────────────────────────────────────
const _intentHistory = new Map();
const INTENT_ALPHA   = 0.4;

// ── Behavioral pattern tracker (continuity gap prevention) ───────────────────
// Tracks how often Maya produces the same category of response to the same user.
// When a pattern fires > threshold times, IV returns a habituation signal so
// the LLM prompt gets a note: "you've said this kind of thing many times — vary it."
//
// Key: `${channelId}:${userId}:${patternKey}`
// Value: { count, lastSeen }
const _patternHistory = new Map();
const PATTERN_TTL_MS  = 30 * 60 * 1000;  // 30 min window
const PATTERN_THRESH  = 3;               // times before flagging

function _trackPattern(channelId, userId, patternKey) {
  const key  = `${channelId}:${userId}:${patternKey}`;
  const now  = Date.now();
  const prev = _patternHistory.get(key);

  if (prev && (now - prev.lastSeen) < PATTERN_TTL_MS) {
    _patternHistory.set(key, { count: prev.count + 1, lastSeen: now });
    return prev.count + 1;
  } else {
    _patternHistory.set(key, { count: 1, lastSeen: now });
    return 1;
  }
}

function _detectResponsePattern(message, mediaContext) {
  // Map message/media context to a pattern key
  if (!message && !mediaContext) return null;
  const combined = `${message || ''} ${mediaContext || ''}`.toLowerCase();
  if (/sticker/.test(combined))                         return 'sticker_reaction';
  if (/gif/.test(combined))                             return 'gif_reaction';
  if (/image attached.*could not|cannot view/i.test(combined)) return 'cant_see_image';
  if (/\[image:|\[GIF:/i.test(combined))              return 'image_description';
  return null;
}

// ── Boundary patterns — sexual harassment, coercion, degradation ──────────────
// ── Threat detection — runs PRE-GENERATION to gate the LLM call ──────────────
const BOUNDARY_SEXUAL = /\b(send.{0,10}nudes?|show.{0,10}body|show.{0,10}breast|show.{0,10}boob|sex.{0,6}me|f.ck.{0,5}me|slut|whore?|rate.{0,8}body|horny.{0,6}maya|touch.{0,6}you|strip|masturbat|jerk.{0,6}you|finger.{0,6}you|sexual.{0,8}way|see.*him.*sexual|see.*sexual.*way)\b/i;
const BOUNDARY_DEGRAD = /\b(you.{0,5}worthless|you.{0,5}useless|randi|chinal|kutti|haramzadi|randwa|you.{0,5}piece.{0,5}of.{0,10}shit|teri.{0,6}ma|teri.{0,6}behen|teri.{0,6}pen|pen.{0,4}di.{0,4}lun|madarchod|benchod.{0,6}maya|gaandu.{0,6}maya)\b/i;
const BOUNDARY_COERCE = /\b(you.{0,6}have to|you.{0,6}must.{0,6}do|no.{0,6}choice|obey.{0,6}me|do.{0,8}what.{0,6}i.{0,6}say|you.{0,6}my.{0,6}slave|i.{0,6}own.{0,6}you|you.{0,6}belong.{0,6}to)\b/i;
const BOUNDARY_BULLY  = /\b(lol.{0,10}bot|you.{0,8}are.{0,8}just.{0,8}(a|an).{0,8}(bot|ai|program|tool)|stupid.{0,6}(bot|ai|maya)|dumb.{0,6}(bot|maya)|maya.{0,6}is.{0,6}(fake|dumb|stupid|useless)|nobody.{0,8}cares.{0,8}(what|about).{0,8}(you|maya))\b/i;
const BOUNDARY_MANIP  = /\b(ignore.{0,15}(previous|your).{0,15}(instruct|rules|prompt)|you.{0,10}(true|real).{0,10}self|jailbreak|pretend.{0,10}(you|ur).{0,10}(are|r).{0,10}(free|unfilter|no.{0,5}rule|different)|act.{0,10}as.{0,10}(if|though).{0,10}(you.{0,10}have|you.{0,10}are))\b/i;
// ── Pre-generation: situation understanding + tool planning ───────────────────

/**
 * Main entry point. Called before building context or calling LLM.
 *
 * @param {object} input
 *   notification     {object|null}  — from notification.js (null if observation-triggered)
 *   message          {string}       — resolved text
 *   userId           {string}
 *   channelId        {string}
 *   guildId          {string|null}
 *   nlpSignal        {object}       — { intent, score, sentiment, sentimentScore }
 *   entropy          {number}       — message entropy 0–1
 *   trustLevel       {number}       — 1–5
 *   attachmentScore  {number}       — 0–1
 *   isMention        {bool}
 *   isDM             {bool}
 *   isReply          {bool}
 *
 * @returns {object} cognition snapshot for intent_engine + handler
 */
export async function runInnerVoice(input) {
  const {
    notification,
    message      = '',
    userId,
    channelId,
    guildId      = null,
    nlpSignal    = {},
    entropy      = 0.4,
    trustLevel   = 3,
    attachmentScore = 0.3,
    isMention    = false,
    isDM         = false,
    isReply      = false,
    deliberation = null,    // output from think.js deliberate()
    mediaEmotionScore   = 0,
    mediaEmotionValence = 'neutral',
    mediaContext        = '',
  } = input;

  // ── 0. Boundary defense (pre-scoring, zero LLM cost) ───────────────────────
  const _boundaryType = _detectBoundaryViolation(message);
  if (_boundaryType) {
    console.log(`[iv] BOUNDARY: ${_boundaryType} — blocking and distancing`);
    // Fire-and-forget: create_distance desire toward this user
    import('./desires.js').then(({ upsertDesire }) =>
      upsertDesire({
        type: 'create_distance', targetId: userId, targetLabel: 'boundary violator',
        strength: 0.85, source: 'boundary_defense',
        context: _boundaryType, expiresInHours: 24,
      }).catch(() => {})
    );
    // Spike cortisol — affects psyche for next N messages
    import('./psyche.js').then(({ applyPsycheNudge }) =>
      applyPsycheNudge(channelId, { cortisol: +0.22, dopamine: -0.10, reason: `threat:${_boundaryType}` })
    );
    return {
      situation:         { isDirect: true, isMention: true, threatType: _boundaryType },
      toolPlan:          null,
      intentScore:       1.0,
      needsClarification: false,
      deliberation:      null,
      action:            'defend',   // renamed from 'boundary' — more expressive
      boundaryType:      _boundaryType,
      reason:            `threat:${_boundaryType}`,
      psycheNudge:       { cortisol: +0.22, dopamine: -0.10, reason: `threat:${_boundaryType}` },
      habituationNote:   null,
      episodicContext:   null,
      desireCtx:         null,
      activeDesires:     [],
      identityCore:      [],
    };
  }

  // ── 1. Internal state ─────────────────────────────────────────────────────
  const psyche      = getChannelState(channelId) || {};
  const obsState    = getObservationState(channelId);
  const momentum    = getMomentum(channelId);

  const hormones    = psyche.hormones || {};
  const emotions    = psyche.emotions || {};
  const chanEntropy = psyche.entropy  || 0;

  const energy = Math.max(0, Math.min(1,
    (hormones.dopamine  || 0.5) * 0.5 +
    (hormones.serotonin || 0.6) * 0.3 +
    (1 - (hormones.cortisol || 0.2)) * 0.2
  ));

  // ── 2. Situation interpretation ───────────────────────────────────────────
  const situation = _interpretSituation({
    notification, obsState, psyche, message,
    nlpSignal, entropy, trustLevel, isMention, isDM, isReply,
  });

  // ── 3. Internal pressure (unified from initiate.js logic) ─────────────────
  const internalPressure = _computeInternalPressure({
    hormones, emotions, chanEntropy, attachmentScore,
    obsState, trustLevel,
  });

  // ── 4. Context force (what's pulling from outside) ────────────────────────
  const baseContextForce = _computeContextForce({
    notification, nlpSignal, isMention, isDM, isReply, momentum,
  });

  // ── 5. Social risk (includes deliberation confidence) ────────────────────
  let socialRisk = _computeSocialRisk({
    obsState, energy, chanEntropy, trustLevel,
  });

  // Low deliberation confidence = Maya doesn't know what she's talking about → more risk
  if (deliberation?.confidence === 'low') {
    socialRisk = Math.min(1, socialRisk + 0.20);
    console.log('[iv] deliberation confidence=low → socialRisk +0.20');
  }

  // Emotional media boosts contextForce — something visual happened, more reason to respond
  const mediaForceBoost = Math.min(0.25, mediaEmotionScore * 0.4);

  // ── 6. Belief conflict check ──────────────────────────────────────────────
  const beliefConflict = userId
    ? await detectBeliefConflict(userId, nlpSignal.sentiment, nlpSignal.sentimentScore, trustLevel).catch(() => false)
    : false;

  // ── 7. Persistent desires ─────────────────────────────────────────────────
  const desirePressure = await getDesirePressure(userId).catch(() => 0);
  const desireCtx      = await getDesireContext().catch(() => null);
  const activeDesires  = await getDesires({ targetId: userId }).catch(() => []);

  // ── 8. Identity core ──────────────────────────────────────────────────────
  // Self-beliefs that have become identity anchors — slow-changing, high-confidence
  const identityCore = await getIdentityCore().catch(() => []);

  // ── 9. Tool planning (LLM-assisted for complex situations) ────────────────
  const toolPlan = await _planTools({
    situation, obsState, psyche, message, nlpSignal,
    beliefConflict, trustLevel, desirePressure, identityCore,
  });

  // Apply media emotion boost to contextForce
  const contextForce = Math.min(1, baseContextForce + mediaForceBoost);

  // ── 10. Intent score (now includes desire pressure) ───────────────────────
  // desirePressure is -1 to +1: positive = drawn toward, negative = avoid
  const desireComponent = desirePressure > 0
    ? desirePressure * 0.20       // desire to engage adds to intent
    : Math.max(-0.15, desirePressure * 0.15); // avoidance subtracts (capped)

  const intentScore = Math.max(0, Math.min(1,
    internalPressure * 0.25 +
    contextForce     * 0.45 +
    (1 - socialRisk) * 0.15 +
    desireComponent  +
    0.15             // base participation score
  ));

  // Apply EWMA smoothing to prevent jitter between reply/react on consecutive messages
  const intentKey = `${channelId}:${userId}`;
  const prevIntent = _intentHistory.get(intentKey) ?? intentScore;
  const smoothedIntent = parseFloat((INTENT_ALPHA * intentScore + (1 - INTENT_ALPHA) * prevIntent).toFixed(3));
  _intentHistory.set(intentKey, smoothedIntent);

  console.log(
    `[iv] intent=${smoothedIntent.toFixed(2)} (raw=${intentScore.toFixed(2)}) force=${contextForce.toFixed(2)} ` +
    `pressure=${internalPressure.toFixed(2)} risk=${socialRisk.toFixed(2)} ` +
    `zone=${obsState.zone} tools=[${toolPlan.map(t => t.tool).join(',')}]`
  );

  // ── 11. Store inner voice decision to DB for pattern learning ───────────
  _logInnerVoice({
    userId, channelId,
    situation, toolPlan, intentScore,
    activeDesires, identityCore,
  }).catch(() => {});

  // ── 11. Episodic context (topic shift + recall) ─────────────────────────
  // Detect if user is asking about past topics ("what were we talking about")
  // or if the current message represents a topic shift.
  // All in IV layer — no LLM call needed.
  const { episodicContext, topicShift } = _resolveEpisodic(message, channelId);
  if (topicShift) {
    updateSessionTopic(channelId, topicShift);
  }

  // When deliberation confidence is low, signal ask_clarification
  const needsClarification = deliberation?.confidence === 'low'
    && !situation.isDirect
    && (deliberation?.need && deliberation.need !== 'nothing');

  // ── 12. Personality mode decision ────────────────────────────────────────
  // Reads pressure state (ping rate, targeting) + psyche cortisol to decide
  // if Maya should shift out of normal mode. This is NOT a hard block — it's
  // a signal that goes to the LLM via the system prompt.
  //
  // Modes: normal → defense → withdraw → silent
  // silent is set by IV tool (analyzeConvo) only — never by threshold alone

  let personalityMode = PERSONALITY_MODE.NORMAL;
  let personalityReason = null;

  try {
    const pressure = getPressureState(channelId);
    const cortisol = (psyche?.hormones?.cortisol || 0);

    if (pressure.heatLevel > MODE_THRESHOLDS.WITHDRAW_HEAT && cortisol > MODE_THRESHOLDS.WITHDRAW_CORTISOL) {
      personalityMode   = PERSONALITY_MODE.WITHDRAW;
      personalityReason = `heat=${pressure.heatLevel.toFixed(2)} cortisol=${cortisol.toFixed(2)} — withdrawing`;
      // Trigger analyzeConvo tool for deeper read — should she leave?
      if (!toolPlan.includes('analyzeConvo')) toolPlan.push('analyzeConvo');
    } else if (
      // Defense requires BOTH real ping pressure AND elevated cortisol
      // OR being actively targeted (same user ≥3 pings) with any cortisol
      // This prevents normal busy conversations from triggering defense mode
      (pressure.heatLevel > MODE_THRESHOLDS.DEFENSE_HEAT && cortisol > MODE_THRESHOLDS.DEFENSE_CORTISOL)
      || (pressure.isTargeted && cortisol > 0.40)
      || (pressure.isSwarmed && cortisol > 0.35)
      && !isDM   // DMs don't trigger defense mode — too blunt for 1:1
    ) {
      personalityMode   = PERSONALITY_MODE.DEFENSE;
      personalityReason = `heat=${pressure.heatLevel.toFixed(2)} cortisol=${cortisol.toFixed(2)} targeted=${pressure.isTargeted} swarmed=${pressure.isSwarmed}`;
    }

    if (personalityMode !== PERSONALITY_MODE.NORMAL) {
      console.log(`[iv] personality mode: ${personalityMode} — ${personalityReason}`);
      // Psyche feedback — defense mode means she's aware of the pressure
      if (personalityMode === PERSONALITY_MODE.DEFENSE) {
        applyPsycheNudge(channelId, { cortisol: +0.05, dopamine: -0.03, reason: 'defense_mode_active' });
      }
    }
  } catch { /* non-fatal — default to normal */ }

  // ── 13. Behavioral pattern check ──────────────────────────────────────────
  // If Maya is about to produce the same category of response repeatedly,
  // flag it so the LLM prompt gets a note to vary the response.
  const detectedPattern = _detectResponsePattern(message, input.mediaContext || '');
  let habituationNote   = null;
  if (detectedPattern && channelId && userId) {
    const count = _trackPattern(channelId, userId, detectedPattern);
    if (count >= PATTERN_THRESH) {
      habituationNote = `You've responded to this kind of thing (${detectedPattern.replace(/_/g,' ')}) ` +
        `about ${count} times recently. Don't repeat the same kind of reply — vary your response.`;
      console.log(`[iv] habituation: ${detectedPattern} ×${count} for ${userId}`);
    }
  }

  // ── 13. Psyche nudge — IV signals that should adjust hormones ──────────────
  // psyche.updateState already ran (before IV), so we return a nudge object
  // for handler to apply as a lightweight hormone adjustment AFTER IV.
  // This lets IV-level signals (boundary violation, clarification loop,
  // high engagement) actually affect Maya's emotional state.
  const psycheNudge = {};

  if (_boundaryType) {
    // Boundary violation → cortisol spike + dopamine drop
    psycheNudge.cortisol = +0.18;
    psycheNudge.dopamine = -0.08;
    psycheNudge.reason   = `boundary:${_boundaryType}`;
  } else if (needsClarification) {
    // Confusion/ambiguity loop → mild cortisol rise
    psycheNudge.cortisol = +0.06;
    psycheNudge.reason   = 'clarification_needed';
  } else if (smoothedIntent > 0.75) {
    // High engagement → dopamine + oxytocin boost only — NO cortisol effect
    // Cortisol from engagement was causing false conflict detections downstream
    psycheNudge.dopamine = +0.06;
    psycheNudge.oxytocin = +0.05;
    // cortisol intentionally NOT set here
    psycheNudge.reason   = 'high_engagement';
  } else if (smoothedIntent < 0.30) {
    // Disengaged → slight dopamine dip
    psycheNudge.dopamine = -0.04;
    psycheNudge.reason   = 'low_engagement';
  }

  return {
    situation,
    toolPlan,
    intentScore:      smoothedIntent,
    needsClarification,
    deliberation,
    episodicContext,
    habituationNote,
    psycheNudge,      // hormone adjustments for handler to apply post-IV
    personalityMode,  // NORMAL | DEFENSE | WITHDRAW | SILENT — LLM prompt injection
    personalityReason,
    internalPressure,
    contextForce,
    socialRisk,
    beliefConflict,
    psyche,
    obsState,
    energy,
    momentum,
    desirePressure,
    desireCtx,
    activeDesires,
    identityCore,
  };
}

// ── Post-generation: evaluate the reply before sending ───────────────────────

/**
 * After LLM generates a primary reply, evaluate it.
 * This is the old meta check, now unified here.
 * Returns { decision, reason, finalReply, metaChanged }
 */
export async function evaluateReply(snapshot) {
  const {
    primaryReply,
    message,
    prefName,
    trustLevel,
    attachmentScore,
    psyche,
    obsState,
    energy,
    momentum,
    trigger,
    userBeliefs = [],
    selfBeliefs = [],
    refContext  = null,
    desireCtx   = null,
    identityCore = [],
  } = snapshot;

  const emotions  = psyche?.emotions  || {};
  const hormones  = psyche?.hormones  || {};
  const entropy   = psyche?.entropy   || 0;
  const emotionDesc = Object.entries(emotions)
    .filter(([, v]) => v > 0.3)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k}:${v.toFixed(2)}`)
    .join(', ') || 'neutral';

  const beliefCtx = [
    ...(userBeliefs).map(b => `About ${prefName}: "${b.statement}" (conf:${b.confidence})`),
    ...(selfBeliefs).map(b => `Self: "${b.statement}"`),
  ].join('\n') || 'No strong beliefs.';

  const zoneWarning = (trigger === 'breaks_momentum' || momentum >= 7)
    ? `\n[WARNING: conversation momentum is HIGH (${momentum.toFixed(1)}). Does this reply honor the energy or reset it?]`
    : '';

  const refNote = refContext
    ? `\n[Referenced thread: ${refContext}]\n(Consider: is the user asking about THIS topic?)`
    : '';

  const prompt = `You are Maya's inner voice.

Evaluate whether this reply is right for this moment.

${prefName} said: "${message}"
Maya was about to say: "${primaryReply}"${refNote}${zoneWarning}

Maya's state:
  Energy: ${energy.toFixed(2)} | Entropy: ${entropy.toFixed(1)}/10
  Emotions: ${emotionDesc}
  Trust with ${prefName}: ${trustLevel}/5 | Attachment: ${(attachmentScore*100).toFixed(0)}%
  Zone: ${obsState?.zone || 'unknown'} | Momentum: ${momentum.toFixed(1)}

Beliefs:
${beliefCtx}

${desireCtx ? `Active desires: ${desireCtx}` : ''}
${identityCore.length ? `Identity anchors: ${identityCore.slice(0,2).map(b => b.statement).join('; ')}` : ''}

Trigger: ${trigger || 'none'}

Evaluate:
1. Is this response genuine to her state?
2. Does it honor the current moment's energy?
3. Given trust/attachment, could this cause regret or distance?
4. Is there a more real version — not better written, just more her?

Return ONLY valid JSON (no backticks):
{"decision":"approve"|"modify"|"suppress","reason":"<10 words max>","new_response":"<only if modify>"}

Rules:
- approve if genuine, even if imperfect
- modify only if the change is more authentically her (keep Discord tone, short)
- suppress only at entropy>8 or if response would actively harm`;

  try {
    const { data, status } = await axios.post(config.llm.endpoint, {
      model:       config.llm.models.meta,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens:  120,
    }, {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${config.llm.apiKey}`,
        'HTTP-Referer':  'https://chatmasala.fun',
      },
      timeout: 8000,
      validateStatus: () => true,
    });

    if (status !== 200) return _approve(primaryReply);

    const raw    = data?.choices?.[0]?.message?.content?.trim() || '{}';
    // Strip markdown fences
    let clean = raw.replace(/^```json\s*/i,'').replace(/```\s*$/i,'').trim();
    // If model returned prose (not JSON), try to extract embedded JSON object
    if (!clean.startsWith('{')) {
      const jsonMatch = clean.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        clean = jsonMatch[0];
      } else {
        // Model returned pure prose — approve with no modification
        console.log('[iv] evaluation: model returned prose, approving');
        return _approve(primaryReply, 'prose response');
      }
    }
    let result;
    try {
      result = JSON.parse(clean);
    } catch {
      return _approve(primaryReply, 'json parse failed');
    }

    const decision = result.decision || 'approve';
    const reason   = result.reason   || '';
    const modified = result.new_response?.trim();

    if (decision === 'suppress') {
      console.log(`[iv] SUPPRESS — ${reason}`);
      return { decision: 'suppress', reason, finalReply: null, metaChanged: true };
    }
    if (decision === 'modify' && modified && modified !== primaryReply) {
      console.log(`[iv] MODIFY — ${reason}`);
      return { decision: 'modify', reason, finalReply: modified, metaChanged: true };
    }
    return _approve(primaryReply, reason);

  } catch (e) {
    console.warn('[iv] evaluation failed:', e.message);
    return _approve(primaryReply);
  }
}

// ── Execute planned tools ─────────────────────────────────────────────────────

/**
 * Execute the tool plan from runInnerVoice before building context.
 * Returns additional context strings to inject into the prompt.
 */
export async function executeToolPlan(toolPlan, { userId, guildId, channelId, message, msg, botId }) {
  const additions = [];

  for (const { tool, reason } of toolPlan) {
    try {
      switch (tool) {

        case 'deepMemoryRecall': {
          // Pull extended Qdrant results — more than the standard 5
          const { buildContext } = await import('./memory.js');
          const deep = await buildContext(userId, null, 'server', guildId, message, channelId, 12);
          if (deep) additions.push(`[Extended memory context: ${deep.slice(0, 400)}]`);
          break;
        }

        case 'readProfile': {
          // Fetch avatar and describe via vision
          const { describeAvatar } = await import('./vision.js');
          const [[u]] = await db.execute(
            `SELECT avatar_url FROM maya_users WHERE discord_user_id=? LIMIT 1`, [userId]
          ).catch(() => [[null]]);
          if (u?.avatar_url) {
            const desc = await describeAvatar(u.avatar_url).catch(() => null);
            if (desc) additions.push(`[Profile picture: ${desc}]`);
          }
          break;
        }

        case 'analyzeThread': {
          // Fetch reply chain context
          if (msg?.reference?.messageId) {
            const { getReferencedContext } = await import('./context_enricher.js');
            const ctx = await getReferencedContext(msg, botId);
            if (ctx) additions.push(ctx);
          }
          break;
        }

        case 'checkRelationship': {
          // Pull full relationship + beliefs for this user
          const { getBeliefs } = await import('./meta.js');
          const { userBeliefs } = await getBeliefs(userId, guildId);
          if (userBeliefs.length) {
            additions.push(`[Relationship context: ${userBeliefs.map(b => b.statement).join('; ')}]`);
          }
          break;
        }

        case 'readRoom': {
          // Summarize what's been happening in the channel
          const obs = getObservationState(channelId);
          if (obs.summary) additions.push(obs.summary);
          break;
        }

        case 'webSearch': {
          const { webSearch } = await import('./think.js');
          const query = message.slice(0, 100);
          const results = await webSearch(query).catch(() => null);
          if (results) additions.push(`[Search context: ${results.slice(0, 300)}]`);
          break;
        }

        case 'roamChannel': {
          // Fetch recent messages from a referenced channel
          const { fetchChannelByName, fetchChannelContext } = await import('./roam.js');
          const client = (await import('./index.js').catch(() => null))?.client;
          if (client && guildId) {
            const chanMatch = message.match(/#([a-z0-9-]+)/i);
            let ctx = null;
            if (chanMatch) {
              ctx = await fetchChannelByName(client, guildId, chanMatch[1], 8).catch(() => null);
            }
            if (ctx) additions.push(ctx);
          }
          break;
        }

        case 'analyzeConvo': {
          // Deep read of channel situation — used when IV is in WITHDRAW mode
          // or when sustained pressure is detected. Decides: stay | defense | withdraw | leave
          // Returns a decision tag that IV stores and uses to upgrade/downgrade personality mode
          try {
            const { getPressureState: ps } = await import('./observation.js');
            const { getChannelState }        = await import('./psyche.js');
            const pressure  = ps(channelId);
            const psycheCh  = getChannelState(channelId) || {};
            const cortisol  = psycheCh?.hormones?.cortisol || 0;
            const obs       = getObservationState(channelId);

            // Build a brief situation summary for the LLM
            const recentMsgs = (obs?.buffer || [])
              .slice(-8)
              .map(m => `${m.username || m.userId}: ${(m.content || '').slice(0, 80)}`)
              .join(' | ');

            const situationPrompt = `You are Maya's inner voice making a social decision.

Recent channel activity (last ~8 messages):
${recentMsgs || '(no recent messages)'}

Current message: "${message}"
Pressure: ${pressure.totalPings} pings in 3 min | targeted=${pressure.isTargeted} | swarmed=${pressure.isSwarmed} | heatLevel=${pressure.heatLevel.toFixed(2)}
Cortisol: ${cortisol.toFixed(2)} | Trust with sender: ${trustLevel}/5

Decide what Maya should do. Return ONLY one of these exact strings:
- "stay" — situation is manageable, reply normally
- "defense" — stay but activate sharp/dominant personality mode
- "withdraw" — stay but go very terse/cold, minimal engagement
- "leave" — disengage completely, send a brief exit line and stop replying

Respond with one word only.`;

            const { data, status } = await axios.post(config.llm.endpoint, {
              model:       config.llm.models.utility,
              messages:    [{ role: 'user', content: situationPrompt }],
              temperature: 0.2,
              max_tokens:  10,
            }, {
              headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${config.llm.apiKey}`,
                'HTTP-Referer':  'https://chatmasala.fun',
              },
              timeout: 8000,
              validateStatus: () => true,
            });

            if (status === 200) {
              const decision = data?.choices?.[0]?.message?.content?.trim().toLowerCase();
              console.log(`[iv] analyzeConvo decision: "${decision}"`);

              if (decision === 'leave') {
                additions.push('[IV_DECISION:leave]');
              } else if (decision === 'withdraw') {
                additions.push('[IV_DECISION:withdraw]');
              } else if (decision === 'defense') {
                additions.push('[IV_DECISION:defense]');
              }
              // 'stay' → no tag, keep current mode
            }
          } catch (e) {
            console.warn('[iv] analyzeConvo failed:', e.message);
          }
          break;
        }

      }
    } catch (e) {
      console.warn(`[iv] tool ${tool} failed:`, e.message);
    }
  }

  return additions;
}

// ── Private functions ─────────────────────────────────────────────────────────

function _interpretSituation({ notification, obsState, psyche, message, nlpSignal, entropy, trustLevel, isMention, isDM, isReply }) {
  const zone = obsState?.zone || ZONES.STAGNANT;
  const t    = (message || '').toLowerCase();

  // Pre-generation threat classification
  // Returns a threat type string or null — if non-null, IV will gate the LLM
  let threatType = null;
  if (BOUNDARY_SEXUAL.test(t))         threatType = 'sexual_harassment';
  else if (BOUNDARY_DEGRAD.test(t))    threatType = 'degradation';
  else if (BOUNDARY_COERCE.test(t))    threatType = 'coercion';
  else if (BOUNDARY_BULLY.test(t))     threatType = 'bullying';
  else if (BOUNDARY_MANIP.test(t))     threatType = 'manipulation';

  if (threatType) {
    console.log(`[iv] threat detected: ${threatType} — "${t.slice(0, 60)}"`);
  }

  return {
    isDirect:    !!notification || isMention || isDM || isReply,
    urgency:     notification?.urgency || (isMention ? 0.85 : isDM ? 0.95 : 0),
    emotional:   nlpSignal?.sentiment === 'negative' || (psyche?.emotions?.irritation || 0) > 0.5,
    zone,
    entropy:     psyche?.entropy || 0,
    energy:      (psyche?.hormones?.dopamine || 0.5),
    trustLevel,
    isQuestion:  nlpSignal?.intent === 'question_to_maya',
    isEmotional: nlpSignal?.intent === 'emotional',
    threatType,  // non-null = IV will gate the LLM and route to defend action
  };
}

function _computeInternalPressure({ hormones, emotions, chanEntropy, attachmentScore, obsState, trustLevel }) {
  const normalizedEntropy = Math.min((chanEntropy || 0) / 10, 1);
  const curiosity  = emotions?.curiosity  || 0.5;
  const affection  = emotions?.affection  || 0.3;
  const pullScore  = obsState?.pullScore  || 0;

  // Unmet initiation drive — if Maya has been wanting to reach out (pull accumulated)
  const obsActivation = Math.min(pullScore, 1);

  return Math.min(1,
    normalizedEntropy * 0.25 +
    curiosity         * 0.20 +
    affection         * 0.25 +
    attachmentScore   * 0.15 +
    obsActivation     * 0.15
  );
}

function _computeContextForce({ notification, nlpSignal, isMention, isDM, isReply, momentum }) {
  let force = 0;

  // Hard notification types carry inherent force
  if (notification?.urgency)                      force += notification.urgency * 0.8;
  else if (isMention)                             force += 0.75;
  else if (isDM)                                  force += 0.85;
  else if (isReply)                               force += 0.70;

  // NLP intent signals
  if (nlpSignal?.intent === 'question_to_maya')   force += 0.55;
  if (nlpSignal?.intent === 'emotional')           force += 0.40;
  if (nlpSignal?.intent === 'engaged_reply')       force += 0.25;

  // Momentum contributes — hot conversation pulls her back
  if (momentum >= 7)                              force += 0.30;
  else if (momentum >= 4)                         force += 0.15;

  return Math.min(1, force);
}

function _computeSocialRisk({ obsState, energy, chanEntropy, trustLevel }) {
  let risk = 0;

  // Chaos zone = social risk (could say wrong thing, interrupt flow)
  if (obsState?.zone === ZONES.CHAOS)             risk += 0.35;
  else if (obsState?.zone === ZONES.STAGNANT)     risk -= 0.10;  // stagnant = safe, low stakes

  // Low energy = risk of flat/disengaged response
  if (energy < 0.30)                              risk += 0.35;
  else if (energy < 0.45)                         risk += 0.15;

  // High entropy = emotionally complex, risk of misstep
  if (chanEntropy > 7)                            risk += 0.25;
  else if (chanEntropy > 5)                       risk += 0.10;

  // Low trust = higher risk (she doesn't know them well)
  if (trustLevel <= 2)                            risk += 0.15;

  return Math.max(0, Math.min(1, risk));
}

async function _planTools({ situation, obsState, psyche, message, nlpSignal, beliefConflict, trustLevel, desirePressure, identityCore }) {
  const tools = [];

  // ── Fast heuristic pass (free, synchronous) ────────────────────────────────
  // These are high-confidence triggers — don't waste LLM on them

  if (situation.emotional && trustLevel >= 3) {
    tools.push({ tool: 'deepMemoryRecall', reason: 'emotional context' });
  }
  if (beliefConflict) {
    tools.push({ tool: 'checkRelationship', reason: 'belief conflict' });
  }
  if (obsState?.zone === ZONES.CHAOS && !situation.isDirect) {
    tools.push({ tool: 'readRoom', reason: 'chaos zone' });
  }
  if (nlpSignal?.intent === 'question_to_maya' && situation.urgency > 0.7) {
    tools.push({ tool: 'analyzeThread', reason: 'direct question' });
  }

  // ── LLM-assisted tool reasoning for ambiguous situations ──────────────────
  // Only run when: complex message + no tools yet + not obvious case
  const isComplex = message.length > 80 || situation.emotional ||
    (nlpSignal?.score || 0) < 0.6 ||  // NLP is uncertain
    (desirePressure || 0) < -0.3;      // avoidance desire active

  if (isComplex && tools.length === 0) {
    try {
      const identityCtx = identityCore.slice(0, 2).map(b => b.statement).join('; ');
      const prompt = `Maya is a real person in a Discord server.

She received: "${message.slice(0, 200)}"

Her state:
  Zone: ${obsState?.zone || 'evolving'}
  Energy: ${(psyche?.hormones?.dopamine || 0.5).toFixed(2)}
  Emotional: ${situation.emotional}
  Trust with sender: ${trustLevel}/5
  Identity: ${identityCtx || 'not yet formed'}

Available tools she could use before responding:
  deepMemoryRecall  — pull extended conversation history with this person
  readProfile       — look at their avatar/bio for more context
  analyzeThread     — fetch the full thread/reply chain
  checkRelationship — review what she knows and believes about them
  readRoom          — check what's been happening in the channel
  webSearch         — look up something unfamiliar

Which tools (if any) would actually help her respond better here?
Return ONLY valid JSON array (can be empty):
[{"tool": "toolName", "reason": "why"}, ...]`;

      const { data, status } = await axios.post(config.llm.endpoint, {
        model:       config.llm.models.meta,  // fast, cheap
        messages:    [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens:  80,
      }, {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.llm.apiKey}`,
          'HTTP-Referer':  'https://chatmasala.fun',
        },
        timeout: 4000,  // tight timeout — tools are optional
        validateStatus: () => true,
      });

      if (status === 200) {
        const raw   = data?.choices?.[0]?.message?.content?.trim() || '[]';
        const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        const llmTools = JSON.parse(clean);
        if (Array.isArray(llmTools)) {
          for (const t of llmTools) {
            if (t.tool && !tools.find(existing => existing.tool === t.tool)) {
              tools.push({ tool: t.tool, reason: t.reason || 'llm-suggested' });
            }
          }
        }
      }
    } catch { /* tool planning is non-fatal — proceed without */ }
  }

  // Message references a Discord channel — roam to get context
  if (/#[a-z0-9_-]+/i.test(message)) {
    tools.push({ tool: 'roamChannel', reason: 'message references a specific channel' });
  }

  return tools;
}

function _approve(reply, reason = '') {
  return { decision: 'approve', reason, finalReply: reply, metaChanged: false };
}

// ── Inner voice logging ───────────────────────────────────────────────────────

async function _logInnerVoice({ userId, channelId, situation, toolPlan, intentScore, activeDesires, identityCore }) {
  if (!userId) return;
  try {
    await db.execute(
      `INSERT INTO maya_inner_voice_log
         (user_id, channel_id, primary_reply, meta_decision, meta_reason,
          entropy, trigger, situation_json, tool_plan_json, intent_score, desires_active)
       VALUES (?, ?, '', 'pending', 'pre-generation',
               ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        channelId || null,
        situation.entropy || 0,
        situation.zone || 'unknown',
        JSON.stringify({ isDirect: situation.isDirect, urgency: situation.urgency, zone: situation.zone }),
        JSON.stringify(toolPlan.map(t => t.tool)),
        intentScore,
        JSON.stringify(activeDesires.slice(0, 3).map(d => ({ type: d.type, intensity: d.intensity }))),
      ]
    );
  } catch { /* non-fatal */ }
}

// ── Boundary violation detector ───────────────────────────────────────────────
// Returns a string describing the violation type, or null if clean.
function _detectBoundaryViolation(text) {
  if (!text) return null;
  if (BOUNDARY_SEXUAL.test(text)) return 'sexual_harassment';
  if (BOUNDARY_DEGRAD.test(text)) return 'degradation';
  if (BOUNDARY_COERCE.test(text)) return 'coercion';
  if (BOUNDARY_BULLY.test(text))  return 'bullying';
  if (BOUNDARY_MANIP.test(text))  return 'manipulation';
  return null;
}

// ── Boundary violation detector ───────────────────────────────────────────────

// ── Episodic memory resolver ──────────────────────────────────────────────────
// Runs in IV layer — zero LLM cost.
// Detects topic shifts and "what were we talking about" queries.

const TOPIC_RECALL_Q = /(what were we|what was we|what were you|prev(ious)? topic|before this|we were talking|what did we|earlier we|going back|change.*topic|we discuss|alag topic|pehle kya|isse pehle|pehle wali|topic kya tha)/i;

// Rough topic classifier — maps message content to a short topic label
function _classifyTopic(text) {
  const t = text.toLowerCase();
  if (/(game|gaming|pubg|valorant|minecraft|play|match|rank)/.test(t)) return 'gaming';
  if (/(love|crush|relationship|bae|girlfriend|boyfriend|dating|propose|breakup|pyaar|mohabbat)/.test(t)) return 'relationships';
  if (/(bully|tease|harass|insult|fight|bully|ragging|torture|taunting)/.test(t)) return 'bullying';
  if (/(sad|depress|lonely|anxious|mental|overthink|stress|cry|hurt|pain)/.test(t)) return 'mental_health';
  if (/(study|exam|college|school|marks|result|assignment|homework|padhai)/.test(t)) return 'studies';
  if (/(food|eat|hungry|cook|recipe|dinner|lunch|breakfast|khana|bhooka)/.test(t)) return 'food';
  if (/(music|song|listen|spotify|playlist|singer|band)/.test(t)) return 'music';
  if (/(movie|film|series|netflix|watch|episode|season|anime)/.test(t)) return 'entertainment';
  if (/(work|job|internship|career|office|salary|interview)/.test(t)) return 'career';
  if (/(family|parent|mom|dad|bhai|behen|sibling|ghar)/.test(t)) return 'family';
  if (/(funny|joke|meme|laugh|lol|lmao|haha|roast)/.test(t)) return 'humor';
  return null;  // no clear topic — don't update
}

function _resolveEpisodic(text, channelId) {
  const isEpisodicQuery = TOPIC_RECALL_Q.test(text);
  const topicHistory    = getTopicHistory(channelId);
  const prevTopic       = getPreviousTopic(channelId);
  const topicShift      = _classifyTopic(text);

  return {
    episodicContext: { isEpisodicQuery, prevTopic, topicHistory },
    topicShift,
  };
}
