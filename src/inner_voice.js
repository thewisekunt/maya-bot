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
import { getObservationState, ZONES } from './observation.js';
import { getDesires, getDesirePressure, getDesireContext, fulfillDesire, onGoodInteraction, onConflict } from './desires.js';
import { getIdentityCore } from './meta.js';
import { detectBeliefConflict, getBeliefs } from './meta.js';
import { config } from './config.js';
import axios from 'axios';
import db    from './db.js';

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
  } = input;

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
  const contextForce = _computeContextForce({
    notification, nlpSignal, isMention, isDM, isReply, momentum,
  });

  // ── 5. Social risk ────────────────────────────────────────────────────────
  const socialRisk = _computeSocialRisk({
    obsState, energy, chanEntropy, trustLevel,
  });

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

  return {
    situation,
    toolPlan,
    intentScore: smoothedIntent,  // smoothed via EWMA
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
    const clean  = raw.replace(/^```json\s*/i,'').replace(/```\s*$/i,'').trim();
    const result = JSON.parse(clean);

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
            // Detect channel reference in message
            const chanMatch = message.match(/#([a-z0-9-]+)/i);
            let ctx = null;
            if (chanMatch) {
              ctx = await fetchChannelByName(client, guildId, chanMatch[1], 8).catch(() => null);
            }
            if (ctx) additions.push(ctx);
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
  return {
    isDirect:   !!notification || isMention || isDM || isReply,
    urgency:    notification?.urgency || (isMention ? 0.85 : isDM ? 0.95 : 0),
    emotional:  nlpSignal?.sentiment === 'negative' || (psyche?.emotions?.irritation || 0) > 0.5,
    zone,
    entropy:    psyche?.entropy || 0,
    energy:     (psyche?.hormones?.dopamine || 0.5),
    trustLevel,
    isQuestion: nlpSignal?.intent === 'question_to_maya',
    isEmotional: nlpSignal?.intent === 'emotional',
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
