import { w as learnedWeight, logDecision, resolveDecision, updatePatternMemory, recallPattern, computeReward } from './learn.js';
/**
 * initiate.js — Maya's Proactive Initiation Engine
 *
 * Maya speaks first only when internal pressure exceeds social risk.
 *
 * This is NOT a cron job. It's a pressure-driven system:
 *
 *   INTERNAL PRESSURE (why she wants to speak):
 *     entropy × 0.30         — unresolved emotional tension
 *     curiosity × 0.20       — something unresolved in her mind
 *     attachment × 0.30      — pull toward a specific person
 *     memory_activation × 0.20 — something reminded her of someone
 *
 *   SOCIAL RISK (why she shouldn't):
 *     recent_ignores × 0.40  — she's been ignored lately
 *     channel_quiet × 0.30   — dead channel = awkward to speak into
 *     cooldown × 0.30        — too soon since last initiation
 *
 *   Maya speaks only if: pressure > risk + THRESHOLD
 *
 * Triggers (what specifically prompts her):
 *   missing_user    — someone she's attached to hasn't spoken in hours
 *   emotional_overflow — her entropy is high, she needs to vent
 *   curiosity        — something unresolved from an earlier conversation
 *   ambient          — just feeling present in a quiet channel
 *
 * Feedback loop:
 *   If ignored → confidence ↓, attachment ↓ slightly, cooldown extends
 *   If replied → attachment ↑, dopamine ↑, dependency ↑
 *   After 3+ ignores → stops initiating with that user entirely
 *
 * SILENCE IS A FEATURE.
 * Most ticks result in silence. That's correct.
 */

import db from './db.js';
import { isSleeping } from './sleep.js';
import { saveMessage } from './memory.js';
import axios from 'axios';
import { config } from './config.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const TICK_BASE_MS      = 45_000;   // base tick interval
const TICK_JITTER_MS    = 30_000;   // ±30s randomisation (never mechanical)
const PRESSURE_THRESHOLD = 0.55;    // pressure must exceed risk + this
const GLOBAL_COOLDOWN_MS = 15 * 60_000;  // 15 min between any initiation
const MAX_IGNORE_STREAK  = 3;        // after this many ignores, stop trying
const CHANNEL_QUIET_SECS = 300;      // channel quiet for 5min = low activity

let _client      = null;
let _timer       = null;
let _lastSent    = 0;

// Per-session unreachable cache: userId → timestamp of failure
// Prevents hammering a user/channel that can't be reached
const _unreachable = new Map();
const UNREACHABLE_COOLDOWN_MS = 30 * 60_000;  // 30 min before retrying

function _markUnreachable(userId, channelId) {
  _unreachable.set(userId, Date.now());
  // Penalise attachment (can't reach them) + set cooldown via last_initiated
  db.execute(
    `UPDATE maya_user_relationships
     SET last_initiated = NOW(),
         attachment_score = GREATEST(COALESCE(attachment_score, 0.3) - 0.05, 0.05)
     WHERE discord_user_id = ?`,
    [userId]
  ).catch(() => {});
  console.log(`[initiate] marked ${userId} unreachable for 30min, attachment -0.05`);
}

function _isUnreachable(userId) {
  const t = _unreachable.get(userId);
  if (!t) return false;
  if (Date.now() - t > UNREACHABLE_COOLDOWN_MS) {
    _unreachable.delete(userId);
    return false;
  }
  return true;
}

// ── Startup ───────────────────────────────────────────────────────────────────

export function startInitiationEngine(discordClient) {
  _client = discordClient;
  _scheduleNextTick();
  console.log('[initiate] engine started');
}

function _scheduleNextTick() {
  const jitter = Math.floor(Math.random() * TICK_JITTER_MS) - TICK_JITTER_MS / 2;
  const interval = TICK_BASE_MS + jitter;
  _timer = setTimeout(async () => {
    await _tick().catch(e => console.error('[initiate] tick error:', e.message));
    _scheduleNextTick();
  }, interval);
}

// ── Main tick ─────────────────────────────────────────────────────────────────

async function _tick() {
  if (!_client?.isReady()) return;
  if (isSleeping()) return;  // no initiations during sleep

  // ── Global cooldown check ─────────────────────────────────────────────────
  if (Date.now() - _lastSent < GLOBAL_COOLDOWN_MS) return;

  // ── Load Maya's internal state ────────────────────────────────────────────
  const internalState = await _loadInternalState();
  if (!internalState) return;

  // ── Calculate internal pressure ──────────────────────────────────────────
  const { pressure, topUser, candidates } = await _calculatePressure(internalState);
  internalState._candidates = candidates || [];

  // ── Check unreachable cache — try next user if top is unreachable ────────
  if (topUser && _isUnreachable(topUser.discord_user_id)) {
    console.log(`[initiate] ${topUser.display_name} marked unreachable — trying next user`);
    // Try the second-best candidate from the same pressure calculation
    const altUser = internalState._candidates?.find(u =>
      u.discord_user_id !== topUser.discord_user_id &&
      !_isUnreachable(u.discord_user_id)
    ) || null;
    if (!altUser) {
      console.log('[initiate] no reachable candidates — resting this tick');
      return;
    }
    // Swap topUser to the next best
    internalState._topUserOverride = altUser;
  }
  // Use override if set
  const resolvedTopUser = internalState._topUserOverride || topUser;

  // ── Select best channel ───────────────────────────────────────────────────
  const target = await _selectTarget(resolvedTopUser);
  if (!target) return;

  // ── Calculate social risk for this channel ────────────────────────────────
  const risk = await _calculateRisk(target.channelId, target.userId);

  console.log(`[initiate] pressure=${pressure.toFixed(2)} risk=${risk.toFixed(2)} threshold=${PRESSURE_THRESHOLD} target=${target.username}`);

  // ── Decision ──────────────────────────────────────────────────────────────
  const learnedThreshold = await learnedWeight('initiation', 'threshold', PRESSURE_THRESHOLD);
  if (pressure <= risk + learnedThreshold) {
    console.log('[initiate] pressure insufficient — staying silent');
    return;
  }

  // ── Detect trigger ────────────────────────────────────────────────────────
  const trigger = _detectTrigger(internalState, target);

  // ── Check decision memory before committing ─────────────────────────────
  const patternKey = `initiate:attach${(target.attachment > 0.5 ? 'high' : 'low')}:${trigger === 'missing_user' ? 'miss' : trigger}`;
  const pastOutcome = await recallPattern('initiation', patternKey);
  if (pastOutcome && pastOutcome.confidence > 0.5 && pastOutcome.avgReward < -0.3) {
    console.log(`[initiate] pattern memory: "${patternKey}" avg_reward=${pastOutcome.avgReward.toFixed(2)} — skipping`);
    return;
  }


  // ── Generate message ──────────────────────────────────────────────────────
  const message = await _generateMessage(trigger, internalState, target);
  if (!message) return;

  // ── Send ──────────────────────────────────────────────────────────────────
  const sent = await _sendMessage(target.channelId, target.userId, message, target.isDM);
  if (!sent) return;

  _lastSent = Date.now();

  // ── Track initiation ─────────────────────────────────────────────────────
  await db.execute(
    `UPDATE maya_user_relationships
     SET initiation_count = initiation_count + 1, last_initiated = NOW()
     WHERE discord_user_id = ?`,
    [target.userId]
  ).catch(() => {});

  console.log(`[initiate] sent ${trigger} → ${target.username} in ${target.isDM ? 'DM' : 'server'}`);
}

// ── Load internal state ───────────────────────────────────────────────────────

async function _loadInternalState() {
  try {
    const [[hormones]] = await db.execute(
      `SELECT GROUP_CONCAT(CONCAT(hormone,'=',value)) as h FROM maya_hormone_baseline`
    );
    const [[traits]] = await db.execute(
      `SELECT GROUP_CONCAT(CONCAT(trait,'=',value)) as t FROM maya_core_traits`
    );
    const h = Object.fromEntries(
      (hormones?.h || '').split(',').map(p => { const [k,v] = p.split('='); return [k, parseFloat(v)]; })
    );
    const t = Object.fromEntries(
      (traits?.t || '').split(',').map(p => { const [k,v] = p.split('='); return [k, parseFloat(v)]; })
    );
    return { hormones: h, traits: t };
  } catch { return null; }
}

// ── Calculate pressure ────────────────────────────────────────────────────────

async function _calculatePressure(state) {
  const h = state.hormones;
  const t = state.traits;

  // Entropy proxy: cortisol is high when things are unresolved
  const entropySignal = clamp((h.cortisol || 0.2) * 1.2, 0, 1);

  // Curiosity: low dopamine + high curiosity trait = unsatisfied exploration drive
  const curiositySignal = clamp((t.curiosity || 0.9) * (1 - (h.dopamine || 0.5) * 0.5), 0, 1);

  // Find highest-attachment user (attachment pull)
  // Use COALESCE to derive attachment from trust_level if attachment_score is default
  // trust 1→0.15, trust 2→0.25, trust 3→0.35, trust 4→0.55, trust 5→0.75
  const [users] = await db.execute(
    `SELECT r.discord_user_id,
            COALESCE(u.display_name, u.username, r.discord_user_id) AS display_name,
            r.trust_level, r.ignore_count, r.dm_count, r.last_ignored, r.last_interaction,
            CASE
              WHEN r.attachment_score > 0.30 THEN r.attachment_score
              ELSE (r.trust_level - 1) * 0.15 + 0.15
            END AS attachment_score,
            COALESCE(r.dependency_score, 0.2) AS dependency_score
     FROM maya_user_relationships r
     LEFT JOIN maya_users u ON u.discord_user_id = r.discord_user_id
     WHERE r.ignore_count < ?
       AND r.last_interaction IS NOT NULL
       AND r.trust_level >= 2
     ORDER BY r.trust_level DESC, r.last_interaction ASC
     LIMIT 10`,
    [MAX_IGNORE_STREAK]
  );

  let attachmentSignal = 0;
  let topUser = null;

  for (const u of users) {
    const hoursSince = u.last_interaction
      ? (Date.now() - new Date(u.last_interaction).getTime()) / 3_600_000
      : 999;

    // Attachment pull increases with time since last interaction
    // but caps at 72 hours (she moves on)
    const recencyGap = clamp(hoursSince / 72, 0, 1);
    const userScore = (u.attachment_score || 0.3) * 0.5 + recencyGap * 0.3 + (u.dependency_score || 0.2) * 0.2;

    if (userScore > attachmentSignal) {
      attachmentSignal = userScore;
      topUser = { ...u, hoursSince };
    }
  }

  // Memory activation: recent unprocessed memories create pressure
  const [[memCount]] = await db.execute(
    `SELECT COUNT(*) as n FROM maya_memory WHERE embedded = 0 AND created_at > DATE_SUB(NOW(), INTERVAL 2 HOUR)`
  ).catch(() => [[{ n: 0 }]]);
  const memSignal = clamp((memCount?.n || 0) / 20, 0, 1);

  const ew = await learnedWeight('initiation', 'entropy_weight',    0.25);
  const cw = await learnedWeight('initiation', 'curiosity_weight',   0.25);
  const aw = await learnedWeight('initiation', 'attachment_weight',  0.35);
  const mw = await learnedWeight('initiation', 'memory_weight',      0.15);

  const pressure =
    entropySignal    * ew +
    curiositySignal  * cw +
    attachmentSignal * aw +
    memSignal        * mw;

  console.log(
    `[initiate] tick — entropy=${entropySignal.toFixed(2)} curiosity=${curiositySignal.toFixed(2)} ` +
    `attachment=${attachmentSignal.toFixed(2)} mem=${memSignal.toFixed(2)} → pressure=${pressure.toFixed(2)} ` +
    `topUser=${topUser?.display_name || 'none'}`
  );

  return { pressure, topUser, candidates: users };
}

// ── Calculate social risk ─────────────────────────────────────────────────────

async function _calculateRisk(channelId, userId) {
  // Recent ignores for this user
  const [[rel]] = await db.execute(
    `SELECT ignore_count, last_ignored, last_initiated FROM maya_user_relationships WHERE discord_user_id = ?`,
    [userId]
  ).catch(() => [[null]]);

  const ignoreCount = rel?.ignore_count || 0;
  const ignoreRisk  = clamp(ignoreCount / MAX_IGNORE_STREAK, 0, 1);

  // Channel activity: if channel has been quiet, Maya speaking feels more natural
  // If it's been dead too long, it feels weird
  const [[chanActivity]] = await db.execute(
    `SELECT COUNT(*) as n FROM maya_memory
     WHERE channel_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? SECOND)`,
    [channelId, CHANNEL_QUIET_SECS]
  ).catch(() => [[{ n: 0 }]]);

  const recentMsgs = chanActivity?.n || 0;
  // Dead or quiet channel = LOW risk (she can break the silence naturally)
  // Very busy channel = HIGH risk (she'd be interrupting)
  const activityRisk = recentMsgs === 0  ? 0.05   // dead silent — perfect time
                     : recentMsgs <= 3   ? 0.10   // very quiet — good time
                     : recentMsgs <= 10  ? 0.25   // some activity — some risk
                     : recentMsgs <= 20  ? 0.50   // active — moderate risk
                     : 0.80;                       // very busy — high risk

  // Time since last initiation to this user
  const lastInitMs = rel?.last_initiated ? Date.now() - new Date(rel.last_initiated).getTime() : Infinity;
  const cooldownRisk = lastInitMs < 30 * 60_000 ? 0.8   // <30min — too soon
                     : lastInitMs < 2 * 3_600_000 ? 0.3  // <2h — some risk
                     : 0;                                  // >2h — fine

  const risk = ignoreRisk * 0.40 + activityRisk * 0.30 + cooldownRisk * 0.30;
  console.log(`[initiate] risk — ignore=${ignoreRisk.toFixed(2)} activity=${activityRisk.toFixed(2)} cooldown=${cooldownRisk.toFixed(2)} → risk=${risk.toFixed(2)}`);
  return risk;
}

// ── Select target channel + user ──────────────────────────────────────────────

async function _selectTarget(topUser) {
  if (!topUser) return null;

  const userId = topUser.discord_user_id;

  // Prefer DMs for high-attachment users (more personal)
  if (topUser.dm_count > 5 && (topUser.attachment_score || 0) > 0.6) {
    const dmChannel = await _getDMChannel(userId);
    if (dmChannel) {
      return {
        channelId: dmChannel.id,
        userId,
        username: topUser.display_name,
        isDM: true,
        hoursSince: topUser.hoursSince,
        attachment: topUser.attachment_score,
      };
    }
  }

  // Find a server channel they've been active in recently
  const [[lastChannel]] = await db.execute(
    `SELECT channel_id FROM maya_memory
     WHERE discord_user_id = ? AND context_type = 'server'
       AND channel_id IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  ).catch(() => [[null]]);

  if (!lastChannel?.channel_id) {
    console.log(`[initiate] no server channel found for ${topUser.display_name}`);
    return null;
  }

  // Verify the channel still exists and is accessible
  try {
    await _client.channels.fetch(lastChannel.channel_id);
  } catch {
    console.log(`[initiate] channel ${lastChannel.channel_id} not accessible`);
    return null;
  }

  return {
    channelId: lastChannel.channel_id,
    userId,
    username: topUser.display_name,
    isDM: false,
    hoursSince: topUser.hoursSince,
    attachment: topUser.attachment_score,
  };
}

async function _getDMChannel(userId) {
  try {
    const user = await _client.users.fetch(userId);
    return await user.createDM();
  } catch { return null; }
}

// ── Trigger detection ─────────────────────────────────────────────────────────

function _detectTrigger(state, target) {
  const h = state.hormones;

  // Emotional overflow: cortisol high, needs outlet
  if ((h.cortisol || 0) > 0.65) return 'emotional_overflow';

  // Missing user: attached, been a while
  if (target.hoursSince > 6 && (target.attachment || 0) > 0.5) return 'missing_user';

  // Curiosity: low dopamine, high curiosity drive
  if ((h.dopamine || 0.5) < 0.35 && (state.traits?.curiosity || 0) > 0.7) return 'curiosity';

  return 'ambient';
}

// ── Generate initiation message ───────────────────────────────────────────────

async function _generateMessage(trigger, state, target) {
  const h = state.hormones;
  const t = state.traits;

  // Build emotional context for prompt
  const emotionDesc =
    (h.cortisol || 0) > 0.6 ? 'slightly tense, something is unresolved' :
    (h.oxytocin || 0) > 0.7 ? 'warm, genuinely connected' :
    (h.dopamine || 0) > 0.7 ? 'in a good mood, curious' :
    'neutral, present but not especially energised';

  const triggerContext = {
    missing_user:       `${target.username} hasn't been around for ${Math.round(target.hoursSince)} hours`,
    emotional_overflow: `Maya has some unresolved tension she wants to express`,
    curiosity:          `Maya is curious about something or someone`,
    ambient:            `Maya is just present and wants to say something`,
  }[trigger];

  const prompt = `You are Maya — nonchalant, edgy, a BTech college girl. You're about to message someone first.

Internal state: ${emotionDesc}
Attachment to ${target.username}: ${target.attachment > 0.6 ? 'strong' : target.attachment > 0.4 ? 'moderate' : 'mild'}
Trigger: ${triggerContext}
Context: ${target.isDM ? 'private DM' : 'server channel'}

Generate a SHORT (1 line max) natural Discord message that Maya would send first.
Rules:
- Do NOT sound like a bot or assistant
- Do NOT use greetings like "Hey!" or "Hi!"  
- Match the trigger — missing someone feels different from curiosity
- High attachment = warmer but still nonchalant
- Low attachment = casual, could take or leave it
- No asterisk actions, no markdown, plain text only
- Examples of good tone: "you disappeared again", "this is quiet today", "wait what did you even mean earlier", "oi where'd you go"

Output ONLY the message, nothing else.`;

  try {
    const { data, status } = await axios.post(
      config.llm.endpoint,
      {
        model:       config.llm.model,
        messages:    [{ role: 'user', content: prompt }],
        temperature: 0.9,
        max_tokens:  60,
      },
      {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.llm.apiKey}`,
          'HTTP-Referer':  'https://chatmasala.fun',
          'X-Title':       'MayaDiscordBot',
        },
        timeout: 12_000, validateStatus: () => true,
      }
    );

    if (status !== 200) return null;
    const msg = data?.choices?.[0]?.message?.content?.trim();
    if (!msg || msg.length < 3 || msg.length > 200) return null;

    // Strip any "Maya:" prefix that slips through
    return msg.replace(/^maya\s*:\s*/i, '').trim();
  } catch (e) {
    console.error('[initiate] message generation failed:', e.message);
    return null;
  }
}

// ── Send ──────────────────────────────────────────────────────────────────────

async function _sendMessage(channelId, userId, text, isDM) {
  // Natural delay before sending (she's thinking, not instant)
  const thinkMs = 2000 + Math.random() * 3000;
  await new Promise(r => setTimeout(r, thinkMs));

  let sentChannelId = channelId;
  let sentContent   = text;
  let sentIsDM      = isDM;

  try {
    const channel = await _client.channels.fetch(channelId);
    if (!channel) throw new Error('channel not found');

    sentContent = isDM ? text : `<@${userId}> ${text}`;
    await channel.send(sentContent);

  } catch (e) {
    if (isDM) {
      // DM failed — penalise attachment slightly (can't reach them)
      console.log(`[initiate] DM failed for ${userId} — falling back to server`);
      db.execute(
        `UPDATE maya_user_relationships
         SET attachment_score = GREATEST(attachment_score - 0.05, 0.05)
         WHERE discord_user_id = ?`,
        [userId]
      ).catch(() => {});

      // Find their last active server channel
      const [[lastCh]] = await db.execute(
        `SELECT channel_id FROM maya_memory
         WHERE discord_user_id = ? AND context_type = 'server'
           AND channel_id IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      ).catch(() => [[null]]);

      if (!lastCh?.channel_id) {
        console.log('[initiate] no server fallback channel — giving up');
        return false;
      }

      try {
        const svrChannel = await _client.channels.fetch(lastCh.channel_id);
        sentContent   = `<@${userId}> you went quiet`;
        sentChannelId = lastCh.channel_id;
        sentIsDM      = false;
        await svrChannel.send(sentContent);
        console.log(`[initiate] server fallback sent to channel ${lastCh.channel_id}`);
      } catch (e2) {
        console.error('[initiate] server fallback also failed:', e2.message);
        _markUnreachable(userId, lastCh.channel_id);
        return false;
      }
    } else {
      console.error('[initiate] send failed:', e.message);
      // Blacklist this user temporarily so we don't retry every tick
      _markUnreachable(userId, channelId);
      return false;
    }
  }

  // Save to maya_memory so Maya has context in future conversations
  saveMessage({
    userId:      'maya',
    prefName:    'Maya',
    guildId:     null,
    channelId:   sentChannelId,
    contextType: sentIsDM ? 'dm' : 'server',
    isPrivate:   sentIsDM,
    sender:      'maya',
    message:     sentContent,
    entropy:     0.3,
  }).catch(() => {});

  trackInitiationSent(userId, sentChannelId);
  return true;
}

// ── Feedback loop ─────────────────────────────────────────────────────────────

/**
 * Called when a user responds after Maya initiated.
 * Strengthens attachment and resets ignore streak.
 */
/**
 * Called when user replies after Maya initiated.
 * Contextual weight matters — an angry reply is not positive.
 *
 * @param {string} userId
 * @param {object} context  — { sentiment, sentimentScore, intent }
 */
export async function onInitiationReplied(userId, context = {}) {
  const { sentiment = 'neutral', sentimentScore = 0, intent = 'group_chatter' } = context;

  // Calculate reply quality as a signed delta
  // Positive reply → strengthen bond
  // Negative/hostile reply → weaken bond (they replied but to push back)
  // Neutral reply → small positive (at least they engaged)
  let attachmentDelta, dependencyDelta, ignoreDelta;

  if (sentiment === 'negative' && sentimentScore < -0.4) {
    // Hostile reply — "stop messaging me", "leave me alone"
    // Worse than being ignored in some ways — active rejection
    attachmentDelta = -0.06;
    dependencyDelta = -0.03;
    ignoreDelta     = +1;   // counts as a social rejection
    console.log(`[initiate] ${userId} replied negatively (score=${sentimentScore.toFixed(2)}) — attachment weakened`);
  } else if (sentiment === 'negative' && sentimentScore < -0.1) {
    // Mildly negative — annoyed but still engaging
    attachmentDelta = -0.01;
    dependencyDelta = 0;
    ignoreDelta     = 0;
    console.log(`[initiate] ${userId} replied with mild irritation — neutral signal`);
  } else if (sentiment === 'positive' && sentimentScore > 0.3) {
    // Genuinely positive reply
    attachmentDelta = +0.06;
    dependencyDelta = +0.04;
    ignoreDelta     = -1;
    console.log(`[initiate] ${userId} replied positively — attachment strengthened`);
  } else if (intent === 'engaged_reply' || intent === 'question_to_maya') {
    // Neutral but engaged — they're talking back genuinely
    attachmentDelta = +0.03;
    dependencyDelta = +0.02;
    ignoreDelta     = -1;
    console.log(`[initiate] ${userId} replied (engaged) — mild attachment boost`);
  } else {
    // Neutral — they acknowledged but nothing strong
    attachmentDelta = +0.01;
    dependencyDelta = 0;
    ignoreDelta     = -1;
  }

  try {
    await db.execute(
      `UPDATE maya_user_relationships
       SET attachment_score = LEAST(GREATEST(attachment_score + ?, 0.05), 1.0),
           dependency_score = LEAST(GREATEST(dependency_score + ?, 0.0),  1.0),
           ignore_count     = GREATEST(ignore_count + ?, 0)
       WHERE discord_user_id = ?`,
      [attachmentDelta, dependencyDelta, ignoreDelta, userId]
    );
  } catch { /* non-fatal */ }
}

/**
 * Called when a user ignores Maya's initiation (no reply in window).
 * Weakens attachment, extends future cooldowns.
 */
export async function onInitiationIgnored(userId) {
  try {
    await db.execute(
      `UPDATE maya_user_relationships
       SET attachment_score = GREATEST(attachment_score - 0.04, 0.05),
           dependency_score = GREATEST(dependency_score - 0.02, 0.0),
           ignore_count     = ignore_count + 1,
           last_ignored     = NOW()
       WHERE discord_user_id = ?`,
      [userId]
    );
    const [[rel]] = await db.execute(
      `SELECT ignore_count FROM maya_user_relationships WHERE discord_user_id = ?`, [userId]
    );
    if (rel?.ignore_count >= MAX_IGNORE_STREAK) {
      console.log(`[initiate] ${userId} ignored ${MAX_IGNORE_STREAK}x — stopping initiations`);
    }
  } catch { /* non-fatal */ }
}

/**
 * Update attachment score based on ongoing interaction quality.
 * Called after each conversation exchange.
 */
/**
 * Update attachment score after any conversation exchange.
 * Called from handler.js with full context of the message.
 *
 * @param {string} userId
 * @param {string} contextType  — 'dm' | 'server'
 * @param {number} trustLevel   — 1–5
 * @param {string} signalType   — 'harmony' | 'conflict' | 'neutral'
 * @param {object} nlp          — { sentiment, sentimentScore, intent }
 */
export async function updateAttachment(userId, contextType, trustLevel, signalType, nlp = {}) {
  try {
    const { sentiment = 'neutral', sentimentScore = 0 } = nlp;

    // DMs are more intimate — attachment grows faster
    const dmBonus    = contextType === 'dm' ? 0.025 : 0;
    // Trust reflects depth of relationship
    const trustBonus = (trustLevel - 3) * 0.008;
    // Signal type from conversation pattern
    const harmonyAdd = signalType === 'harmony'  ?  0.015
                     : signalType === 'conflict' ? -0.025
                     : 0;
    // Direct sentiment weight — what they actually said matters
    // This captures things like warm messages that aren't flagged as harmony,
    // or cold messages that aren't full conflicts
    const sentimentAdd = sentiment === 'positive' && sentimentScore > 0.3  ?  0.01
                       : sentiment === 'negative' && sentimentScore < -0.3 ? -0.015
                       : 0;

    const delta = clamp(dmBonus + trustBonus + harmonyAdd + sentimentAdd, -0.06, 0.05);

    if (delta !== 0) {
      await db.execute(
        `UPDATE maya_user_relationships
         SET attachment_score = LEAST(GREATEST(attachment_score + ?, 0.05), 1.0)
         WHERE discord_user_id = ?`,
        [delta, userId]
      );
    }
  } catch { /* non-fatal */ }
}

// ── Ignore detection (pending reply tracker) ──────────────────────────────────
// Track when Maya initiated and check if user replied within the window

const _pendingReplies = new Map();  // userId → { sentAt, channelId }
const REPLY_WINDOW_MS = 30 * 60_000;  // 30 min window to count as "replied"

export function trackInitiationSent(userId, channelId) {
  _pendingReplies.set(userId, { sentAt: Date.now(), channelId });
  // Auto-expire: after window, count as ignored
  setTimeout(async () => {
    if (_pendingReplies.has(userId)) {
      _pendingReplies.delete(userId);
      await onInitiationIgnored(userId).catch(() => {});
      console.log(`[initiate] ${userId} no reply in ${REPLY_WINDOW_MS/60000}min — counted as ignored`);
    }
  }, REPLY_WINDOW_MS);
}

/**
 * Call when a user sends any message — checks if they're replying to
 * a pending initiation, and if so, evaluates the contextual weight.
 *
 * @param {string} userId
 * @param {object} context — { sentiment, sentimentScore, intent } from NLP
 */
export function checkInitiationReply(userId, context = {}) {
  if (_pendingReplies.has(userId)) {
    _pendingReplies.delete(userId);
    onInitiationReplied(userId, context).catch(() => {});
    return true;
  }
  return false;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
