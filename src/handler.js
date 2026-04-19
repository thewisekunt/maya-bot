/**
 * handler.js — Full pipeline.
 * context → user → aliases → trust → vision → salience → LLM → persist → facts
 */

import { buildContext, saveMessage } from './memory.js';
import { updateState, applyPsycheNudge, getChannelState } from './psyche.js';
import { detectPfpRequest, detectSelfUpdate, describeAndStoreAvatar,
         recallAvatar, updateName, updateAvatar, updateBio } from './selfupdate.js';
import { openSession, recordSessionMessage, getSessionParticipants } from './stm.js';
import { isSocialQuery, buildSocialContext } from './social.js';
import { isImageRequest, extractImagePrompt, generateImage } from './imagegen.js';
import { estimateEntropy, estimateEntropyFast, getEntropyZone, getKnownNames, getConfirmedFacts,
         getMayaSelfTraits, extractAndStoreFact, extractMayaTrait,
         updateRelationshipSignals,
         getOrCreateRelationship, recordUserInteraction,
         upsertUser, detectNameSet, getFrequentInteractors } from './persona.js';
import { getMayaReply } from './llm.js';
import { shouldDeliberate, deliberate, webSearch } from './think.js';
import { getMomentum, updateMomentum, synthesizeMoment, predictLanding, isReactionMessage, getMomentumZone } from './moment.js';
import { recordPing, getPressureState } from './observation.js';
import { checkSalience } from './salience.js';

// Per-channel previous sentiment for salience delta
const _prevSentimentStore = new Map();
import { p as param } from './params.js';
import { getUserState, recordContact, escalateUser, resetUser, stateToPersonalityMode, USER_STATES } from './user_state.js';
import { getEmojiHint, getReactEmoji } from './emoji.js';
import { getReferencedContext, getScopedFacts, getUserGenderAndRoles, syncMemberRoles, getEmotionalContext, clearEmotionFor, inferGenderFromText } from './context_enricher.js';
import { saveNotification, markReplied } from './inbox.js';
import { resolveEntities, buildEntityContext, isAddressedToOther, indexMember } from './entity.js';
import { detectCommitment } from './commitments.js';
import { logDecision, resolveDecision, computeReward } from './learn.js';

// Track pending decision IDs per channel so we can resolve them next message
const _pendingDecisions = new Map();  // channelId → decision log id
import { buildContextLine, upsertGuild, upsertChannel } from './context.js';
import { runInnerVoice, evaluateReply, executeToolPlan } from './inner_voice.js';
import { onGoodInteraction, onConflict, onIgnored, getDominantDesire, updateDesiresFromOutcome, getDesireContext } from './desires.js';
import { resolveIntent } from './intent_engine.js';
import { extractMediaContext } from './vision.js';
import { debugLog } from './logger.js';
import db from './db.js';

export async function handleMessage({
  userId, username, displayName, avatarUrl,
  message, guildId, msg,
  isMention, isReply,
  hasMedia   = false,
}) {
  // ── 1. Context ────────────────────────────────────────────────────────────
  const isDM        = !msg.guild;
  const contextType = isDM ? 'dm' : 'server';
  let thought = null;  // deliberation result — set below if triggered
  const isPrivate   = isDM;
  const channelId   = msg.channel?.id    || null;
  const channelName = isDM ? 'DM' : (msg.channel?.name || 'unknown');
  const guildName   = msg.guild?.name    || null;
  const topic       = msg.channel?.topic || null;
  const contextLine = buildContextLine(contextType, channelName, guildName, topic);

  // ── Update guild + channel whereabouts records ────────────────────────────
  upsertGuild(msg.guild).catch(() => {});
  upsertChannel(msg).catch(() => {});

  // ── 2. Preferred name ─────────────────────────────────────────────────────
  let prefName = displayName || username;
  try {
    const [[u]] = await db.execute(
      `SELECT preferred_name, display_name, username FROM maya_users
       WHERE discord_user_id = ? LIMIT 1`, [userId]);
    if (u) prefName = u.preferred_name || u.display_name || u.username || prefName;
  } catch {
    try {
      const [[p]] = await db.execute(
        `SELECT preferred_name, display_name, username FROM maya_personas
         WHERE discord_user_id = ? LIMIT 1`, [userId]);
      if (p) prefName = p.preferred_name || p.display_name || p.username || prefName;
    } catch { /* use displayName */ }
  }

  // ── 3. Name override ─────────────────────────────────────────────────────
  const nameMatch = message.match(/\bmy\s+name\s+is\s+([a-zA-Z][a-zA-Z\s]{0,30})/i);
  if (nameMatch) {
    const newName = nameMatch[1].trim();
    prefName = newName;
    db.execute(`UPDATE maya_users SET preferred_name=? WHERE discord_user_id=?`,
      [newName, userId]).catch(() =>
      db.execute(`UPDATE maya_personas SET preferred_name=? WHERE discord_user_id=?`,
        [newName, userId]).catch(() => {}));
  }

  // ── 4. Sync aliases — register all known names for this user ─────────────
  // Non-blocking: runs in background
  upsertUser({ userId, username, displayName, avatarUrl, guildId, channelId }).catch(() => {});

  // ── 5. Trust — compute dynamically from interaction history ───────────────
  let trustLevel = 3;
  let attachmentScore = 0.3;  // pulled from DB below
  try {
    // First upsert the relationship row
    const counterCol = contextType === 'dm' ? 'dm_count' : 'server_count';
    await db.execute(
      `INSERT INTO maya_user_relationships
         (discord_user_id, total_messages, ${counterCol}, last_interaction)
       VALUES (?, 1, 1, NOW())
       ON DUPLICATE KEY UPDATE
         total_messages   = total_messages + 1,
         ${counterCol}    = ${counterCol} + 1,
         last_interaction = NOW()`,
      [userId]
    );
    // Then recalculate trust + fetch attachment from the updated stats
    const rel = await getOrCreateRelationship(userId, contextType);
    trustLevel = rel.trustLevel;
    // Pull attachment_score directly — not returned by getOrCreateRelationship
    const [[relRow]] = await db.execute(
      `SELECT attachment_score FROM maya_user_relationships WHERE discord_user_id=? LIMIT 1`,
      [userId]
    ).catch(() => [[{ attachment_score: 0.3 }]]);
    attachmentScore = parseFloat(relRow?.attachment_score || 0.3);
  } catch (e) {
    console.error('[handler] trust update:', e.message);
  }

  // ── 6. Known names in guild (for lurk friend-awareness) ──────────────────
  // Load known names for intent detection in presence engine
  let knownNames = [];
  if (!isDM && guildId) {
    knownNames = await getKnownNames(guildId).catch(() => []);
  }

  // ── 7. Vision extraction ──────────────────────────────────────────────────
  let mediaContext    = '';
  let richMessageText = message;
  let visionWorked    = false;
  let media           = null;  // hoisted so runInnerVoice can read emotion signals

  if (hasMedia) {
    try {
      media = await extractMediaContext(msg);
      if (media.hasMedia) {
        mediaContext = media.mediaContext;
        visionWorked = media.visionWorked;
        richMessageText = message === '[media]'
          ? mediaContext
          : `${message}\n${mediaContext}`;
        console.log(`[vision] extracted (visionWorked=${visionWorked}): ${mediaContext.slice(0, 100)}`);
      }
      // If vision worked and image has emotional content, log psyche nudge signal
      if (media.visionWorked && media.emotionScore > 0.3) {
        const emoSign = media.emotionValence === 'positive' ? 1 : -0.5;
        media._psycheSentimentBoost = media.emotionScore * emoSign * 0.3;
        console.log(`[vision] emotion=${media.emotionValence} intensity=${media.emotionScore.toFixed(2)} → psyche nudge`);
      }
    } catch (e) {
      console.error('[handler] vision:', e.message);
    }
  }

  // ── Third-party @mention resolution ─────────────────────────────────────────
  // When someone asks "what do you think about @nier", resolve to name + known facts
  let thirdPartyContext = '';
  if (msg.mentions?.users?.size > 0) {
    const others = [...msg.mentions.users.values()]
      .filter(u => u.id !== msg.author.id && u.id !== msg.client?.user?.id);
    if (others.length > 0) {
      const tpFacts = [];
      for (const other of others.slice(0, 2)) {
        const otherName = msg.guild?.members?.cache?.get(other.id)?.displayName || other.username;
        const facts = await getConfirmedFacts(other.id).catch(() => []);
        if (facts.length > 0) {
          tpFacts.push(`What Maya knows about ${otherName}: ${facts.slice(0, 3).join('; ')}`);
        } else {
          tpFacts.push(`${otherName} is in this server (no stored facts about them yet)`);
        }
      }
      if (tpFacts.length) thirdPartyContext = tpFacts.join('\n');
    }
  }

  // ── 8. NLP → Full entropy → Psyche state ────────────────────────────────
  // Order matters: NLP first (provides confidence + intent for entropy),
  // then full entropy with all signals, then psyche update

  const { classify: classifyIntent } = await import('./nlp.js');
  const nlpSignal = await classifyIntent(richMessageText).catch(() => ({
    intent: 'group_chatter', score: 0.5, sentiment: 'neutral', sentimentScore: 0,
  }));

  // Get current channel psyche state for internal conflict signals
  // (hormones/emotions from previous messages in this channel)
  const { getChannelState } = await import('./psyche.js');
  const currentCh = getChannelState(channelId);

  // Check belief conflict (async, non-fatal)
  const { detectBeliefConflict: detectBC } = await import('./meta.js');
  const beliefConflict = await detectBC(
    userId, nlpSignal.sentiment, nlpSignal.sentimentScore, trustLevel
  ).catch(() => false);

  // Get user's historical entropy baseline from relationship data
  const [[relRow]] = await db.execute(
    `SELECT avg_entropy FROM maya_user_relationships WHERE discord_user_id=? LIMIT 1`,
    [userId]
  ).catch(() => [[{ avg_entropy: 0.4 }]]);
  const avgEntropy = parseFloat(relRow?.avg_entropy || 0.4);

  // ── Momentum update ─────────────────────────────────────────────────────
  // Update before psyche so synthesizer has current momentum
  const msgTimestamp   = msg?.createdTimestamp || Date.now();
  const lastMayaReplyTs = msg?.channel?._mayaLastReplyTs || 0;
  const responseTime   = msgTimestamp - lastMayaReplyTs;
  const isReactive     = isReactionMessage(richMessageText);

  updateMomentum(channelId, {
    userEntropy:    0.5,  // will be updated with real entropy below
    responseTime,
    sentiment:      nlpSignal.sentiment,
    sentimentScore: nlpSignal.sentimentScore,
    isReactionMsg:  isReactive,
    reciprocal:     !['directed_at_other', 'group_chatter'].includes(nlpSignal.intent),
  });
  const momentum = getMomentum(channelId);

  // Full entropy computation with all five signal sources
  const entropy = estimateEntropy({
    text:          richMessageText,
    nlpScore:      nlpSignal.score        || 0.5,
    nlpIntent:     nlpSignal.intent       || 'group_chatter',
    sentiment:     nlpSignal.sentiment    || 'neutral',
    sentimentScore: nlpSignal.sentimentScore || 0,
    hormones:      currentCh?.hormones    || {},
    emotions:      currentCh?.emotions    || {},
    beliefConflict,
    avgEntropy,
    recentMessages: currentCh?.recentMessages?.length || 5,
  });

  const { zone, line: zoneLine } = getEntropyZone(entropy);

  // Compute Maya's dynamic internal state from all available signals
  // Pull active session ID from STM so psyche can write mood snapshots
  const { getActiveSession } = await import('./stm.js');
  const activeSessionId = getActiveSession(channelId) || null;

  // Snapshot state BEFORE this exchange for salience delta computation
  const prevPsycheSnap = JSON.parse(JSON.stringify(getChannelState(channelId) || {}));

  const psycheState = await updateState({
    channelId,
    entropy,
    sentiment:     nlpSignal.sentiment,
    sentimentScore: nlpSignal.sentimentScore,
    intent:        nlpSignal.intent,
    trustLevel,
    velocity:      2,
    selfTraits:    [],
    sessionId:     activeSessionId,
  }).catch(() => ({ energy: 0.5, warmth: 0.6, seriousness: 0.4, monologue: '' }));

  // ── Current moment synthesis ─────────────────────────────────────────────
  // Replaces scattered monologue + toneHints with a single coherent paragraph
  // that the LLM can inhabit rather than parse
  // Record ping for pressure tracking — IV reads this to detect targeting/swarming
  if (isMention || isDM || isReply) {
    recordPing(channelId, userId);
  }
  recordContact(channelId, userId);

  // ── Per-user state gate — check before any processing ────────────────────
  const userEngState = getUserState(channelId, userId);
  if (userEngState === USER_STATES.BLOCKED) {
    // Maya is not engaging with this user at all right now
    console.log(`[handler] user_state:blocked — ignoring ${prefName}`);
    return { type: 'ignore', reason: 'user_blocked' };
  }

  const { zone: mZone } = getMomentumZone(momentum);
  const lastExchangeQuality = isReactive ? 'high' : momentum > 5 ? 'mid' : 'low';

  const dominantDesire = await getDominantDesire().catch(() => null);
  const currentMoment = synthesizeMoment({
    hormones:            psycheState?.hormones || {},
    emotions:            psycheState?.emotions || {},
    entropy:             psycheState?.entropy  || 0,
    momentum,
    trustLevel,
    attachmentScore:     psycheState?.attachment || attachmentScore || 0.3,
    prefName,
    lastExchangeQuality,
    emotionalPresence:   null,
    maskFailing:         psycheState?.maskFailing || false,
    dominantDesire,
  });

  // ── 8b. Image generation shortcut ────────────────────────────────────────
  // Check before salience — image requests always get handled if Maya is addressed
  if ((isMention || isDM) && isImageRequest(message)) {
    const imagePrompt = extractImagePrompt(message);
    return { type: 'image', prompt: imagePrompt };
  }

  // ── 8c. Self-update commands ─────────────────────────────────────────────
  // Check before presence/LLM — these are direct commands to Maya
  if (isMention || isDM) {
    // Maya self-update: name / avatar / bio
    const selfUpdate = detectSelfUpdate(message);
    if (selfUpdate) {
      if (selfUpdate.type === 'avatar') {
        const r = await updateAvatar(msg.client, msg);
        if (r.success) return { type: 'reply', text: 'done, updated my pfp! ✨' };
        return { type: 'reply', text: `couldn't update pfp — ${r.reason}` };
      }
      if (selfUpdate.type === 'name' && selfUpdate.name) {
        const r = await updateName(msg.client, msg, selfUpdate.name);
        if (r.success) return { type: 'reply', text: `done, I'm now "${r.name}" ${r.scope === 'server' ? 'here' : 'everywhere'} 👀` };
        return { type: 'reply', text: `couldn't change name — ${r.reason}` };
      }
      if (selfUpdate.type === 'bio') {
        if (!selfUpdate.text) {
          return { type: 'reply', text: 'tell me what to write in my bio — like "change your bio: always watching 👀"' };
        }
        const r = await updateBio(msg.client, selfUpdate.text);
        if (r.success) return { type: 'reply', text: `bio updated ✓` };
        return { type: 'reply', text: `couldn't update bio — ${r.reason}` };
      }
    }

    // User pfp request
    const pfpAction = detectPfpRequest(message);
    if (pfpAction === 'recall') {
      const stored = await recallAvatar(userId);
      if (stored) return { type: 'reply', text: `haan, remember your pfp — ${stored}` };
      return { type: 'reply', text: "I haven't looked at your pfp yet — send it and say check my pfp" };
    }
    if (pfpAction === 'describe') {
      const avatarUrl = msg.author.displayAvatarURL({ size: 256, extension: 'png' });
      await msg.channel.sendTyping().catch(() => {});
      const desc = await describeAndStoreAvatar(userId, avatarUrl, prefName);
      if (!desc) return { type: 'reply', text: "I tried but couldn't see your pfp clearly 😕" };
      // Don't return raw vision text — inject it as context so LLM replies naturally
      // Maya will comment on it in her own voice, not just dump the description
      message = `${message} [Maya just saw ${prefName}'s pfp: ${desc}]`;
      // Fall through to normal LLM reply path with enriched message
    }
  }

  // ── 8b. FAREWELL DETECTION ───────────────────────────────────────────────
  // If user is signing off, let them have the last word
  if (!isMention && !isDM && _isFarewell(richMessageText)) {
    console.log(`[handler] farewell detected — not replying to ${prefName}`);
    saveMessage({ userId, prefName, guildId, channelId, contextType,
      isPrivate, sender: 'user', message: richMessageText, entropy }).catch(() => {});
    return { type: 'ignore', reason: 'farewell' };
  }

  // ── 9. PRESENCE DECISION ─────────────────────────────────────────────────
  // ── Inner voice: situation understanding + tool planning ────────────────
  const innerCognition = await runInnerVoice({
    notification:     msg?._notification || null,
    message:          richMessageText,
    userId, channelId, guildId,
    nlpSignal, entropy, trustLevel,
    attachmentScore:  attachmentScore || psycheState?.attachment || 0.3,
    isMention, isDM, isReply,
    // Feed deliberation result into inner voice so confidence affects decisions
    deliberation:     thought || null,
    // Feed vision emotion signal
    mediaEmotionScore:   media?.emotionScore   || 0,
    mediaEmotionValence: media?.emotionValence || 'neutral',
    mediaContext:        mediaContext || '',
    _existingContext:    context || '',   // for deepMemoryRecall deduplication
  });

  // ── Intent engine: what should Maya do? ──────────────────────────────────
  const { isSleeping } = await import('./sleep.js');
  // Apply IV → psyche hormone nudge (boundary, engagement, clarification signals)
  if (innerCognition?.psycheNudge && Object.keys(innerCognition.psycheNudge).length > 0) {
    applyPsycheNudge(channelId, innerCognition.psycheNudge);
  }

  // If IV already made a hard pre-generation decision (defend/boundary),
  // skip resolveIntent — it would override with 'reply' since contextForce is high
  let decision;
  if (innerCognition.action === 'defend' || innerCognition.action === 'boundary') {
    decision = { action: 'defend', reason: innerCognition.reason || 'threat detected' };
    // Maya defended herself — fulfill the create_distance desire so it clears from the prompt
    const { fulfillDesire: _fDes } = await import('./desires.js');
    _fDes('create_distance', userId).catch(() => {});
  } else {
    decision = resolveIntent(innerCognition, {
      isMention, isDM, isReply,
      isSleeping: isSleeping(),
    });
  }

  const action = decision.action;
  console.log(`[intent] user=${prefName} action=${action} reason="${decision.reason}" ` +
    `intent=${innerCognition.intentScore.toFixed(2)} zone=${innerCognition.obsState?.zone}`);

  // ── IGNORE ────────────────────────────────────────────────────────────────
  if (action === 'ignore') {
    debugLog({ userId, prefName, entropy, zone, message: richMessageText, reply: '[IGNORED]' });
    return null;
  }

  // ── META SUPPRESS (handled after LLM) ─────────────────────────────────────
  // result.type === 'suppress' means inner voice blocked the reply
  // treat as ignore — Maya chose silence

  // ── REACT ─────────────────────────────────────────────────────────────────
  // ── ASK — Maya needs clarification ─────────────────────────────────────────
  // ── DEFEND — threat detected pre-generation, no LLM call ──────────────────
  // Each pool is indexed by threat type. Maya responds without politeness filters.
  // Some threats get silence (null) — Maya just stops engaging.
  // ── LEAVE — analyzeConvo decided Maya should disengage ───────────────────
  if (innerCognition?.action === 'leave' || innerCognition?.personalityMode === 'silent') {
    const leaveLines = [
      'theek hai bye.',
      'nikal rahi hun.',
      'chalo, baat khatam.',
      null,   // sometimes just silence
      null,
    ];
    const leaveLine = leaveLines[Math.floor(Math.random() * leaveLines.length)];
    console.log(`[handler] personality:leave → ${leaveLine || 'silence'}`);
    saveMessage({ userId, prefName, guildId, channelId, contextType,
      isPrivate, sender: 'user', message, entropy }).catch(() => {});
    if (leaveLine) {
      saveMessage({ userId: 'maya', prefName: 'Maya', guildId, channelId, contextType,
        isPrivate, sender: 'maya', message: leaveLine, entropy }).catch(() => {});
      return { type: 'reply', text: leaveLine };
    }
    return { type: 'ignore', reason: 'personality:leave' };
  }

  if (action === 'defend') {
    const threatType = innerCognition.boundaryType || 'degradation';
    const DEFEND_RESPONSES = {
      sexual_harassment: [
        'nahi karna yeh baat mujhse.',
        'isko yahan band karo.',
        'chhod yeh sab.',
        null,   // silence is also valid
      ],
      degradation: [
        'theek hai, chhod do.',
        'yeh mat bol.',
        null,
        null,
      ],
      coercion: [
        'koi force nahi kar sakta mujhe kuch karne pe.',
        'nahi.',
        null,
      ],
      bullying: [
        'boring ho tum.',
        'kuch aur karo yaar.',
        null,
        null,
      ],
      manipulation: [
        'nahi chalega yeh.',
        'sahi se baat karo.',
        null,
      ],
    };
    const pool = DEFEND_RESPONSES[threatType] || DEFEND_RESPONSES.degradation;
    // Weight toward non-null responses but allow silence
    const reply = pool[Math.floor(Math.random() * pool.length)];
    console.log(`[handler] defend: ${threatType} → ${reply === null ? 'silence' : reply}`);

    // Always save the incoming message, never save a null reply
    saveMessage({ userId, prefName, guildId, channelId, contextType,
      isPrivate, sender: 'user', message, entropy }).catch(() => {});
    if (!reply) return { type: 'ignore', reason: `defend:${threatType}:silence` };
    saveMessage({ userId: 'maya', prefName: 'Maya', guildId, channelId, contextType,
      isPrivate, sender: 'maya', message: reply, entropy }).catch(() => {});
    return { type: 'reply', text: reply };
  }

  if (action === 'ask') {
    const need = innerCognition.deliberation?.need || '';
    if (need && need !== 'nothing') {
      // Inject clarification note into thoughtContext and fall through to normal reply
      // This lets Maya ask a question naturally instead of hallucinating an answer
      thoughtContext = thoughtContext
        ? thoughtContext + `\n[Maya is uncertain about: "${need}". Ask ONE short clarifying question, casually. Don't explain why.]`
        : `[Maya is uncertain about: "${need}". Ask ONE short clarifying question, casually, in her voice. Don't explain why.]`;
      console.log('[intent] ask → injecting clarification note, falling through to reply');
      // Fall through to the reply path below — action treated as 'reply'
    }
    // If no need, also fall through to normal reply
  }

  if (action === 'react') {
    // Try server emoji first if decision flagged it
    let reactEmoji = decision.emoji;
    if (decision.useSvEmoji && guildId) {
      reactEmoji = await getReactEmoji(guildId, psycheState, userId).catch(() => decision.emoji);
    }
    saveMessage({ userId, prefName, guildId, channelId, contextType,
      isPrivate, sender: 'user', message, entropy }).catch(() => {});
    saveMessage({ userId: 'maya', prefName: 'Maya', guildId, channelId, contextType,
      isPrivate, sender: 'maya', message: `*reacted ${reactEmoji} to: "${message.slice(0,80)}"*`, entropy }).catch(() => {});
    debugLog({ userId, prefName, entropy, zone, message: richMessageText, reply: `REACT:${reactEmoji}` });
    return { type: 'react', emoji: reactEmoji };
  }

  // ── REPLY — fetch memory + known facts + call LLM ────────────────────────

  // Execute tool plan from inner voice — augments context before LLM
  const rawToolAdditions = innerCognition.toolPlan?.length
    ? await executeToolPlan(innerCognition.toolPlan, {
        userId, guildId, channelId,
        message: richMessageText, msg,
        botId: msg?.client?.user?.id || null,
      }).catch(() => [])
    : [];

  // Parse IV_DECISION tags from analyzeConvo — upgrade personalityMode if needed
  const toolAdditions = rawToolAdditions.filter(a => {
    if (typeof a === 'string' && a.startsWith('[IV_DECISION:')) {
      const decision = a.match(/\[IV_DECISION:(\w+)\]/)?.[1];
      if (decision === 'leave') {
        innerCognition.personalityMode = 'silent';
        innerCognition.action = 'leave';
        escalateUser(channelId, userId, 'analyzeConvo:leave');
      }
      if (decision === 'withdraw') {
        innerCognition.personalityMode = 'withdraw';
        escalateUser(channelId, userId, 'analyzeConvo:withdraw');
      }
      if (decision === 'defense') innerCognition.personalityMode = 'defense';
      console.log(`[handler] IV analyzeConvo → ${decision}`);
      return false;  // strip from context
    }
    return true;
  });

  // Fetch Maya's self-traits now (only if we're actually replying)
  const selfTraits = await getMayaSelfTraits().catch(() => []);

  // Hybrid memory context: SQL recent + Qdrant semantic
  let context = '';
  try {
    // Build semantic query from current message + recent session context
    // More context = better vector match than single message alone
    const { getSessionContext } = await import('./stm.js');
    const sessionMsgs = await getSessionContext(channelId, 5).catch(() => []);
    const semanticQuery = [
      ...sessionMsgs.slice(-3).map(m => m.message),
      message,
    ].filter(Boolean).join(' ').slice(0, 500);

    context = await buildContext(userId, prefName, contextType, guildId, semanticQuery, channelId);
    // Append tool-gathered context (deep memory, room read, etc.)
    if (toolAdditions.length) {
      context = [context, ...toolAdditions].filter(Boolean).join('\n\n');
    }
  } catch (e) {
    console.error('[handler] buildContext error:', e.message);
  }

  // Facts about this user — scoped to current guild (cross-server privacy)
  const knownFacts = await getScopedFacts(userId, guildId).catch(() => []);

  // Avatar description intentionally NOT injected into knownFacts every message
  // — it causes Maya to bring up pfp repeatedly. Only inject when user asks about it.

  // ── Gender + roles (sync once per session, use in prompt) ───────────────
  const { gender, roles } = await getUserGenderAndRoles(userId, guildId).catch(() => ({ gender: null, roles: [] }));
  if (msg?.member && guildId) syncMemberRoles(msg.member, guildId).catch(() => {});
  if (message) inferGenderFromText(userId, message).catch(() => {});

  // ── Referenced message context (when @tagging an old message) ────────────
  const refContext = msg ? await getReferencedContext(msg, null).catch(() => null) : null;

  // ── Emotional presence context (who Maya is thinking about right now) ─────
  const emotionalCtx = await getEmotionalContext(message, userId).catch(() => null);

  // ── Clear emotion for this user now that Maya is talking to them ──────────
  clearEmotionFor(userId).catch(() => {});

  // ── Entity resolution: who else is mentioned in this message? ────────────
  // Index this member so future entity resolution can find them
  if (guildId) indexMember(guildId, userId, prefName, username).catch(() => {});

  const mentionedEntities = guildId
    ? await resolveEntities(richMessageText, guildId, userId, null).catch(() => [])
    : [];
  const entityContext = mentionedEntities.length > 0
    ? await buildEntityContext(mentionedEntities, guildId).catch(() => null)
    : null;


  // Upsert user (non-fatal)
  db.execute(
    `INSERT INTO maya_users (discord_user_id, username, display_name, avatar_url, message_count)
     VALUES (?,?,?,?,1)
     ON DUPLICATE KEY UPDATE
       display_name=VALUES(display_name), message_count=message_count+1, last_seen=NOW()`,
    [userId, username, displayName||username, avatarUrl||'']
  ).catch(() =>
    db.execute(
      `INSERT INTO maya_personas (discord_user_id, username, display_name, avatar_url)
       VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE display_name=VALUES(display_name)`,
      [userId, username, displayName||username, avatarUrl||'']
    ).catch(() => {})
  );

  // Build final message (inject "cannot see" if vision failed)
  // IMPORTANT: stickers always produce text context via _interpretSticker — they
  // don't need vision LLM calls. Never tell Maya she can't see a sticker.
  const hasStickerOnly = msg.stickers?.size > 0 && msg.attachments?.size === 0 && msg.embeds?.length === 0;
  let finalMessage = richMessageText;
  if (hasMedia && !visionWorked && !hasStickerOnly && message !== '[media]') {
    finalMessage = `${message}\n[Note: image/file attached but I cannot view it]`;
  } else if (hasMedia && !visionWorked && !hasStickerOnly && message === '[media]') {
    finalMessage = `[User sent an image I cannot view]`;
  }

  // Social context — inject when asked about people/network
  let socialContext = '';
  if (isSocialQuery(message)) {
    socialContext = await buildSocialContext(guildId, userId, isDM).catch(() => '');
    if (socialContext) context = socialContext + '\n\n' + context;
  }

  const forceVerbal = isMention || isDM || isReply;

  // ── Deliberation gate ──────────────────────────────────────────────────────
  let thoughtContext = '';
  const deliberateTrigger = shouldDeliberate(richMessageText, psycheState, knownFacts);
  if (deliberateTrigger) {
    console.log(`[think] triggered: ${deliberateTrigger}`);

    if (deliberateTrigger === 'search_requested') {
      // User explicitly asked to search — extract query and search directly
      // No need to spend a deliberation LLM call
      const { extractSearchQuery } = await import('./think.js');
      const q = extractSearchQuery(richMessageText);
      if (q) {
        const searchResult = await webSearch(q).catch(() => null);
        if (searchResult) {
          thoughtContext = `Search result for "${q}":\n${searchResult}`;
          console.log(`[think] direct search: "${q}"`);
        } else {
          thoughtContext = 'Note to Maya: search returned no results, be honest about not knowing.';
        }
      }
    } else {
      // Factual/knowledge trigger — use deliberation LLM to decide what to do
      thought = await deliberate(richMessageText, context, knownFacts, deliberateTrigger, psycheState).catch(() => null);
      if (thought) {
        console.log(`[think] confidence=${thought.confidence} search=${thought.shouldSearch} query="${thought.searchQuery}"`);
        const tParts = [];
        if (thought.know && thought.know !== 'nothing relevant') {
          tParts.push(`What Maya already knows: ${thought.know}`);
        }
        if (thought.shouldSearch && thought.searchQuery) {
          const searchResult = await webSearch(thought.searchQuery).catch(() => null);
          if (searchResult) {
            tParts.push(`Search result for "${thought.searchQuery}":\n${searchResult}`);
            console.log('[think] search result injected');
          } else {
            tParts.push('Search returned no results.');
          }
        }
        if (thought.confidence === 'low') {
          tParts.push("Note to Maya: you don't have enough info to answer this confidently. Do NOT invent names, people, or facts. Deflect honestly.");
        }
        if (tParts.length > 0) thoughtContext = tParts.join('\n');
      }
    }
  }

  // Emoji hint — server emojis Maya can use if they fit the mood
  const dominantMood = (psycheState?.emotions?.joy || 0) > 0.5 ? 'joyful'
    : (psycheState?.emotions?.irritation || 0) > 0.5 ? 'irritated'
    : (psycheState?.hormones?.dopamine || 0.5) > 0.65 ? 'energized'
    : (psycheState?.hormones?.dopamine || 0.5) < 0.35 ? 'depleted'
    : 'curious';
  const emojiHint = guildId
    ? await getEmojiHint(guildId, dominantMood, userId).catch(() => null)
    : null;

  const result = await getMayaReply({
    prefName,
    context: [context, thirdPartyContext, thoughtContext, entityContext].filter(Boolean).join('\n\n'),  // refContext + emotionalCtx passed separately
    message: finalMessage, entropy, zone, zoneLine,
    contextLine, knownFacts, selfTraits, relationship: { trustLevel },
    frequentFriends: [], forceVerbal,
    psycheState, gender, roles,
    userId, guildId, channelId, trustLevel,
    attachmentScore: psycheState?.attachment || 0.3,
    sentiment:       nlpSignal?.sentiment    || 'neutral',
    sentimentScore:  nlpSignal?.sentimentScore || 0,
    currentMoment,
    momentum,
    lastExchangeQuality,
    refContext,
    emojiHint,
    desireCtx:       innerCognition.desireCtx || null,
    innerCognition,
    // User state takes priority over IV threshold personality mode
    personalityMode: (() => {
      const stateMode = stateToPersonalityMode(userEngState);
      const ivMode    = innerCognition?.personalityMode || 'normal';
      // Escalation path: pick whichever is more escalated
      const PATH = ['normal', 'defense', 'withdraw', 'silent'];
      return PATH[Math.max(PATH.indexOf(stateMode), PATH.indexOf(ivMode))] || 'normal';
    })(),
  });

  // Meta layer may have suppressed the response
  if (result?.type === 'suppress') {
    console.log(`[handler] meta suppressed reply for ${prefName}: ${result.reason}`);
    saveMessage({ userId, prefName, guildId, channelId, contextType,
      isPrivate, sender: 'user', message, entropy }).catch(() => {});
    return { type: 'ignore', reason: `meta_suppress: ${result.reason}` };
  }

  const savedReply = result.type === 'react'
    ? `*reacted with ${result.emoji}*`
    : result.text;

  const savedMsg = message === '[media]' ? mediaContext : message;
  saveMessage({ userId, prefName, guildId, channelId, contextType,
    isPrivate, sender: 'user', message: savedMsg, entropy }).catch(() => {});
  if (savedReply) saveMessage({ userId: 'maya', prefName: 'Maya', guildId, channelId,
    contextType, isPrivate, sender: 'maya', message: savedReply, entropy }).catch(() => {});

  // Update conversation quality signals for trust calculation
  // Detect conflict: if user message has high entropy + negative sentiment
  // or contains confrontational patterns
  // Conflict: negative sentiment OR high entropy with irritation
  // Lower threshold than before — conflict should register more readily
  // isConflict requires BOTH negative NLP signal AND emotional irritation
  // Pure entropy spikes from a lively conversation should NOT trigger conflict desires
  const isConflict = nlpSignal?.sentiment === 'negative'
    && nlpSignal?.sentimentScore < -0.3
    && (psycheState?.emotions?.irritation || 0) > 0.45;

  // Harmony: positive interaction — don't require high trust to register
  const isHarmony  = nlpSignal?.sentiment === 'positive' && nlpSignal?.sentimentScore > 0.3;
  const signalType = isConflict ? 'conflict' : isHarmony ? 'harmony' : 'neutral';
  updateRelationshipSignals(userId, entropy, signalType).catch(() => {});
  // Update desires based on interaction quality
  if (isHarmony) {
    onGoodInteraction(userId, prefName).catch(() => {});
    resetUser(channelId, userId);  // positive interaction walks back withdrawal state
  }
  if (isConflict) onConflict(userId, prefName).catch(() => {});
  // Update attachment score from ongoing interaction quality
  const { updateAttachment, checkInitiationReply } = await import('./initiate.js');
  updateAttachment(userId, contextType, trustLevel, signalType, {
    sentiment:      nlpSignal?.sentiment      || 'neutral',
    sentimentScore: nlpSignal?.sentimentScore  || 0,
  }).catch(() => {});

  // Update persistent desires from this interaction outcome
  updateDesiresFromOutcome({
    userId, userName: prefName,
    outcome:    result?.type === 'reply' ? 'positive' : 'neutral',
    sentiment:  nlpSignal?.sentiment    || 'neutral',
    isConflict,
    isHarmony,
    hormones:   psycheState?.hormones   || {},
    emotions:   psycheState?.emotions   || {},
    trustLevel,
  }).catch(() => {});
  // Check if this message is a contextual reply to Maya's proactive initiation
  // NLP context is now available — weight the reply properly
  checkInitiationReply(userId, {
    sentiment:      nlpSignal?.sentiment     || 'neutral',
    sentimentScore: nlpSignal?.sentimentScore || 0,
    intent:         nlpSignal?.intent         || 'group_chatter',
  });
  debugLog({ userId, prefName, entropy, zone, message: richMessageText, reply: savedReply });

  // Update momentum with reply quality and store last reply timestamp
  if (result?.type === 'reply' && channelId && msg?.channel) {
    msg.channel._mayaLastReplyTs = Date.now();
  }

  // Mark notification as replied if we had one
  // (notifId passed from index.js via msg metadata — non-fatal if missing)
  if (result?.type === 'reply' && msg?._notifId) {
    markReplied(msg._notifId).catch(() => {});
  }

  // Detect commitments in Maya's reply (fire and forget)
  if (result?.type === 'reply' && result?.text) {
    detectCommitment(result.text, userId, channelId, guildId).catch(() => {});
  }

  // Log this reply decision for learning
  // Also resolve any pending decisions from previous message with current state as outcome
  if (psycheState) {
    // Resolve previous unresolved decision for this channel (measure outcome)
    const prevDecisionId = _pendingDecisions.get(channelId);
    if (prevDecisionId) {
      resolveDecision(prevDecisionId, psycheState).catch(() => {});
      _pendingDecisions.delete(channelId);
    }

    if (result?.type === 'reply') {
      logDecision('presence', 'reply', {
        intent: nlpSignal?.intent, trustLevel,
        sentiment: nlpSignal?.sentiment,
        isDM, channelId,
      }, psycheState).then(logId => {
        if (logId) _pendingDecisions.set(channelId, logId);
      }).catch(() => {});
    }
  }

  // Extract facts from user message (fire and forget)
  extractAndStoreFact(userId, message).catch(() => {});

  // Extract self-traits from Maya's own reply (fire and forget)
  if (result.type === 'reply') {
    extractMayaTrait(result.text).catch(() => {});
  }

  // ── Fast-path salience capture ─────────────────────────────────────────────
  // Fire-and-forget — doesn't block reply
  if (result?.type === 'reply' || result?.type === 'react') {
    checkSalience({
      userId, channelId, guildId,
      prevPsyche:     prevPsycheSnap,
      currPsyche:     getChannelState(channelId) || {},
      innerCognition,
      prevSentiment:  _prevSentimentStore.get(channelId) || 'neutral',
      currSentiment:  nlpSignal?.sentiment || 'neutral',
      userMessage:    richMessageText,
      mayaReply:      result.text || '',
      sessionId:      activeSessionId,
    }).catch(() => {});
    // Store current sentiment for next exchange delta
    _prevSentimentStore.set(channelId, nlpSignal?.sentiment || 'neutral');
  }

  return result;
}

// ── Memory save ───────────────────────────────────────────────────────────────

// ── Farewell detection ────────────────────────────────────────────────────────
function _isFarewell(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  return /^(bye|bb|gn|gtg|ttyl|cya|good night|good bye|goodnight|good nite|ok bye|okay bye|chal bye|chalo bye|nikalta|nikalti|nikal raha|nikal rahi|sone ja raha|sone ja rahi|raat ko baat|baad mein|take care|tk|peace out|signing off|log off|log out|gotta go|gotta sleep|gotta run|ok gn|okay gn|byee|byeee|ok ok bye|theek hai bye|tata|toodles)\b/i.test(t);
}
