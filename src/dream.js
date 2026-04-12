import { updateUserBelief, updateSelfBelief, detectIdentityConflict } from './meta.js';
import { decayDesires } from './desires.js';
import { runLearningCycle } from './learn.js';
/**
 * dream.js — Session-based memory consolidation
 *
 * Triggered when a session closes (30 min idle after @mention).
 * Processes raw session messages into typed LTM entries:
 *
 *   user_fact    — things learned about specific users
 *                  ("Danish loves pizza", "Mario works in IT")
 *   conversation — what happened in this session
 *                  ("Group debated cricket, Mario and Sai disagreed")
 *   maya_self    — things Maya expressed about herself
 *                  ("Maya finds passive aggression tiring")
 *
 * Each type goes to Qdrant with memory_type in payload — never mixed in recall.
 *
 * LLM extracts structured JSON (no narrative voice) so facts are clean
 * and reusable across contexts.
 *
 * Also runs a time/volume triggered pass for raw message embedding.
 */

import db from './db.js';
import { retrainFromDB } from './nlp.js';
import { updateSlowDrift } from './psyche.js';
import { embed, embedBatch } from './embedder.js';
import { upsertMemory, upsertBatch, isConfigured } from './vector.js';
import axios from 'axios';
import { config } from './config.js';

const DREAM_INTERVAL_MS = parseInt(process.env.DREAM_INTERVAL_MINUTES || '30') * 60 * 1000;
const MSG_THRESHOLD     = parseInt(process.env.DREAM_MESSAGE_THRESHOLD || '50');
const BATCH_SIZE        = 20;

let _timer    = null;
let _msgCount = 0;
let _running  = false;

// ── Public API ────────────────────────────────────────────────────────────────

export function startDreamLoop() {
  if (!isConfigured()) {
    console.log('[dream] Qdrant not configured — dream loop disabled');
    return;
  }
  _timer = setInterval(() => _dreamCycle(), DREAM_INTERVAL_MS);
  console.log(`[dream] loop started (interval=${DREAM_INTERVAL_MS/60000}min, threshold=${MSG_THRESHOLD})`);
}

export function notifyNewMessage() {
  if (!isConfigured()) return;
  _msgCount++;
  if (_msgCount >= MSG_THRESHOLD) {
    _msgCount = 0;
    _runEmbedPass('threshold').catch(e => console.error('[dream] embed pass error:', e.message));
  }
}

/**
 * Process a closed session into LTM.
 * Called by stm.js when a session closes.
 */
export async function processSession(sessionId) {
  if (!isConfigured()) return;
  console.log(`[dream] processing session ${sessionId}`);

  // Check it hasn't been processed already
  const [[sess]] = await db.execute(
    `SELECT s.*, s.participant_ids FROM maya_sessions s
     WHERE s.id=? AND s.processed=0 AND s.ended_at IS NOT NULL`,
    [sessionId]
  ).catch(() => [[]]);

  if (!sess) {
    console.log(`[dream] session ${sessionId} already processed or not ended`);
    return;
  }

  // Mark as processing immediately (prevent double-processing across instances)
  await db.execute(
    `UPDATE maya_sessions SET processed=1 WHERE id=? AND processed=0`,
    [sessionId]
  ).catch(() => {});

  // Fetch all messages from this session
  const [msgs] = await db.execute(
    `SELECT discord_user_id, user_name, sender, message
     FROM maya_session_messages
     WHERE session_id=?
     ORDER BY created_at ASC`,
    [sessionId]
  ).catch(() => [[]]);

  if (!msgs || msgs.length < 2) {
    console.log(`[dream] session ${sessionId} too short to process`);
    return;
  }

  // Build the transcript
  const transcript = msgs
    .map(m => `${m.sender === 'maya' ? 'Maya' : m.user_name}: ${m.message}`)
    .join('\n');

  const participantIds = _parseJson(sess.participant_ids, []);
  const guildId        = sess.guild_id;

  console.log(`[dream] session ${sessionId}: ${msgs.length} msgs, ${participantIds.length} participants`);

  // ── Extract structured facts via LLM ────────────────────────────────────
  let extracted;
  try {
    extracted = await _extractFacts(transcript, msgs, guildId);
  } catch (e) {
    console.error(`[dream] fact extraction failed for session ${sessionId}:`, e.message);
    return;
  }

  // ── Write to Qdrant with memory_type namespacing ────────────────────────
  const points = [];

  // User facts — one per user per fact
  for (const [userId, facts] of Object.entries(extracted.user_facts || {})) {
    const userName = msgs.find(m => m.discord_user_id === userId)?.user_name || userId;
    for (const fact of facts) {
      const text = `${userName}: ${fact.text}`;
      try {
        const vec = await embed(text);
        points.push({
          id:      `uf_${sessionId}_${userId}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
          vector:  vec,
          payload: {
            memory_type:     'user_fact',
            discord_user_id: userId,
            user_name:       userName,
            guild_id:        guildId || null,
            is_private:      !guildId,
            fact_text:       fact.text,
            category:        fact.category || 'general',
            conflict_score:  fact.conflict_score ?? 0.3,
            message:         text,
            weight:          2.0,
            created_at:      new Date().toISOString(),
          },
        });
      } catch { /* non-fatal */ }
    }
  }

  // Conversation memory — what happened in this session
  if (extracted.conversation_summary) {
    try {
      const vec = await embed(extracted.conversation_summary);
      points.push({
        id:      `conv_${sessionId}_${Date.now()}`,
        vector:  vec,
        payload: {
          memory_type:     'conversation',
          discord_user_id: participantIds[0] || 'unknown',
          guild_id:        guildId || null,
          is_private:      !guildId,
          participants:    participantIds,
          message:         extracted.conversation_summary,
          topics:          extracted.topics || [],
          mood:            extracted.mood || 'neutral',
          weight:          1.5,
          created_at:      new Date().toISOString(),
        },
      });
    } catch { /* non-fatal */ }
  }

  // Maya self-traits extracted from her own replies
  for (const trait of extracted.maya_traits || []) {
    try {
      const vec = await embed(`Maya: ${trait}`);
      points.push({
        id:      `ms_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
        vector:  vec,
        payload: {
          memory_type:     'maya_self',
          discord_user_id: 'maya',
          guild_id:        null,
          is_private:      false,
          message:         `Maya: ${trait}`,
          fact_text:       trait,
          weight:          1.8,
          created_at:      new Date().toISOString(),
        },
      });
    } catch { /* non-fatal */ }
  }

  // Upsert all points
  if (points.length > 0) {
    try {
      await upsertBatch(points);
      console.log(`[dream] session ${sessionId}: upserted ${points.length} LTM points`);
    } catch (e) {
      console.error(`[dream] upsertBatch failed for session ${sessionId}:`, e.message);
    }
  }
}

// ── LLM fact extraction ───────────────────────────────────────────────────────

async function _extractFacts(transcript, msgs, guildId) {
  const participants = [...new Set(
    msgs.filter(m => m.sender === 'user').map(m => `${m.user_name} (id:${m.discord_user_id})`)
  )].join(', ');

  const prompt = `You are a memory extraction system for an AI called Maya.
Analyse this conversation and extract structured facts. Return ONLY valid JSON.

Participants: ${participants}

Conversation:
${transcript.slice(0, 3000)}

Extract and return this exact JSON structure:
{
  "user_facts": {
    "<discord_user_id>": [
      {
        "text": "<name> <fact about them in third person>",
        "category": "preference|identity|relationship|belief|objective",
        "conflict_score": <0.0 to 1.0, 0=certain 1=contested>
      }
    ]
  },
  "conversation_summary": "<1-2 sentences: what happened in this conversation, who was involved, main topics>",
  "topics": ["<topic1>", "<topic2>"],
  "mood": "<overall mood: positive|negative|neutral|chaotic|deep>",
  "maya_traits": ["<thing Maya expressed about herself, third person: Maya finds X interesting>"]
}

Rules:
- Only include facts clearly stated, not inferred
- User facts must use the user's discord_user_id as the key
- Rewrite all first-person ("I love pizza") to third-person ("Danish loves pizza")
- If nothing clear was stated for a field, use null or []
- conflict_score 0.0 = stated as definite fact, 0.5 = opinion/preference, 1.0 = contradicts known info
- Return ONLY the JSON object, no markdown, no explanation`;

  const { data, status } = await axios.post(
    config.llm.endpoint,
    {
      model:       config.llm.models.dream,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.1,   // low temperature for factual extraction
      max_tokens:  1000,
    },
    {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${config.llm.apiKey}`,
        'HTTP-Referer':  'https://chatmasala.fun',
        'X-Title':       'MayaDiscordBot',
      },
      timeout:        30_000,
      validateStatus: () => true,
    }
  );

  if (status !== 200) throw new Error(`LLM HTTP ${status}`);

  const raw = data?.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('Empty LLM response');

  // Strip any markdown fences if present
  const clean = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

  try {
    return JSON.parse(clean);
  } catch {
    console.error('[dream] JSON parse failed:', clean.slice(0, 200));
    throw new Error('Invalid JSON from LLM');
  }
}

// ── Full dream cycle: embed + NLP retrain ────────────────────────────────────

async function _dreamCycle() {
  if (_running) return;
  _running = true;
  const start = Date.now();

  try {
    // Quick check: is there actually work to do?
    const [[pendingEmbed]] = await db.execute(
      `SELECT COUNT(*) as n FROM maya_memory WHERE embedded=0`
    ).catch(() => [[{ n: 0 }]]);
    const [[pendingNLP]] = await db.execute(
      `SELECT COUNT(*) as n FROM maya_nlp_training WHERE used_in_train=0`
    ).catch(() => [[{ n: 0 }]]);
    const [[pendingDecisions]] = await db.execute(
      `SELECT COUNT(*) as n FROM maya_decision_log WHERE resolved_at IS NOT NULL AND reward IS NOT NULL`
    ).catch(() => [[{ n: 0 }]]);

    // Auto-resolve stale decisions older than 1h with neutral reward
    await db.execute(
      `UPDATE maya_decision_log SET reward=0.0, resolved_at=NOW(), state_after=state_before
       WHERE resolved_at IS NULL AND created_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)`
    ).catch(() => {});

    const hasWork = pendingEmbed.n > 0 || pendingNLP.n > 0 || pendingDecisions.n > 0;

    // Beliefs, reaction feedback, self-belief — run every cycle regardless of pending work
    await _applyReactionFeedback().catch(e => console.error('[dream] reaction feedback:', e.message));
    await _updateBeliefs().catch(e => console.error('[dream] belief update:', e.message));
    await _formSelfBeliefs().catch(e => console.error('[dream] self-belief:', e.message));

    if (!hasWork) {
      console.log('[dream] cycle skipped (embed/NLP/decisions) — beliefs still ran');
      _running = false;
      return;
    }

    console.log(`[dream] cycle started — embed=${pendingEmbed.n} nlp=${pendingNLP.n} decisions=${pendingDecisions.n}`);

    // Phase 1: embed pending messages (only if there are any)
    if (pendingEmbed.n > 0) {
      await _runEmbedPass('cycle');
    }

    // Phase 2: retrain NLP (only if new examples accumulated)
    if (pendingNLP.n >= 5) {
      const newExamples = await retrainFromDB();
      if (newExamples > 0) {
        console.log(`[dream] NLP retrained with ${newExamples} new examples`);
      }
    }

    // Phase 3: personality drift (lightweight, always run if anything ran)
    await updateSlowDrift().catch(e => console.error('[dream] drift update:', e.message));

    // Phase 4: learning cycle (only if enough decisions logged)
    if (pendingDecisions.n >= 3) {
      const updates = await runLearningCycle().catch(e => { console.error('[dream] learning cycle:', e.message); return 0; });
      if (updates > 0) console.log(`[dream] learning: ${updates} weight updates`);
    }

    // Phase 4c: desire decay (desires fade without reinforcement)
    await decayDesires().catch(e => console.error('[dream] desire decay:', e.message));

    // Phase 4e: housekeeping — prune stale notifications and orphaned evidence
    await _housekeeping().catch(e => console.error('[dream] housekeeping:', e.message));

    // Phase 4d: stale fact decay
    await _decayStateFacts().catch(e => console.error('[dream] fact decay:', e.message));

    // Phase 5: memory decay (run once per day max — check last run)
    const [[lastDecay]] = await db.execute(
      `SELECT value FROM maya_state WHERE state_key='last_memory_decay'`
    ).catch(() => [[null]]);
    const lastDecayTime = lastDecay ? new Date(lastDecay.value) : new Date(0);
    const hoursSinceDecay = (Date.now() - lastDecayTime.getTime()) / 3600000;
    if (hoursSinceDecay >= 24) {
      await _runMemoryDecay().catch(e => console.error('[dream] memory decay:', e.message));
      await db.execute(
        `INSERT INTO maya_state (state_key, value) VALUES ('last_memory_decay', NOW())
         ON DUPLICATE KEY UPDATE value=NOW()`
      ).catch(() => {});
    }

  } catch (e) {
    console.error('[dream] cycle error:', e.message);
  } finally {
    _running = false;
    console.log(`[dream] cycle done in ${Date.now() - start}ms`);
  }
}

// ── Raw message embed pass (time/volume triggered) ────────────────────────────

async function _runEmbedPass(trigger) {
  if (_running) return;
  _running = true;
  const start = Date.now();
  console.log(`[dream] embed pass started (trigger=${trigger})`);

  try {
    const [rows] = await db.execute(
      `SELECT id, discord_user_id, user_name, guild_id, channel_id,
              context_type, is_private, sender, message, entropy
       FROM maya_memory
       WHERE embedded=0
       ORDER BY created_at ASC LIMIT ?`,
      [BATCH_SIZE]
    ).catch(() => [[]]);

    if (!rows?.length) { _running = false; return; }

    const texts   = rows.map(r => `${r.sender === 'maya' ? 'Maya' : r.user_name}: ${r.message}`);
    const vectors = await embedBatch(texts).catch(() => null);
    if (!vectors) { _running = false; return; }

    const points = rows.map((r, i) => ({
      id:      `raw_${r.id}`,
      vector:  vectors[i],
      payload: {
        memory_type:     'raw_message',
        mysql_id:        r.id,
        discord_user_id: r.discord_user_id,
        user_name:       r.user_name || '',
        guild_id:        r.guild_id  || null,
        context_type:    r.context_type || 'server',
        is_private:      !!(r.is_private),
        sender:          r.sender,
        message:         r.message,
        entropy:         parseFloat(r.entropy) || 0.4,
        weight:          0.8,   // raw messages have lower weight than processed facts
        created_at:      new Date().toISOString(),
      },
    }));

    await upsertBatch(points).catch(e => console.error('[dream] upsertBatch:', e.message));

    const ids = rows.map(r => r.id);
    await db.execute(
      `UPDATE maya_memory SET embedded=1 WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    ).catch(() => {});

    console.log(`[dream] embed pass: ${rows.length} msgs in ${Date.now()-start}ms`);
  } catch (e) {
    console.error('[dream] embed pass error:', e.message);
  } finally {
    _running = false;
  }
}

function _parseJson(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// ── Memory decay ─────────────────────────────────────────────────────────────
// Memories that haven't been recalled recently fade in strength.
// If strength drops below 0.1 after 30+ days without recall → discard.
// Formula: strength *= e^(-λt)  where λ=0.05/day

async function _runMemoryDecay() {
  try {
    // Decay maya_facts (user facts and self traits)
    const [factResult] = await db.execute(
      `UPDATE maya_facts
       SET memory_strength = GREATEST(
         memory_strength * EXP(-0.05 * DATEDIFF(NOW(), COALESCE(last_recalled, updated_at))),
         0.05
       )
       WHERE last_recalled < DATE_SUB(NOW(), INTERVAL 3 DAY)
          OR (last_recalled IS NULL AND updated_at < DATE_SUB(NOW(), INTERVAL 3 DAY))`
    );

    // Discard facts that have faded below threshold and haven't been recalled in 30 days
    const [deleteResult] = await db.execute(
      `DELETE FROM maya_facts
       WHERE memory_strength < 0.10
         AND (last_recalled < DATE_SUB(NOW(), INTERVAL 30 DAY)
              OR (last_recalled IS NULL AND updated_at < DATE_SUB(NOW(), INTERVAL 30 DAY)))`
    );

    if (deleteResult.affectedRows > 0) {
      console.log(`[dream] memory decay: removed ${deleteResult.affectedRows} faded memories`);
    }
    if (factResult.affectedRows > 0) {
      console.log(`[dream] memory decay: weakened ${factResult.affectedRows} memories`);
    }
  } catch (e) {
    console.error('[dream] memory decay error:', e.message);
  }
}

// ── Belief updates from recent interactions ───────────────────────────────────

async function _updateBeliefs() {
  // Build user beliefs from real interaction patterns:
  // - Message volume per user (high volume = she knows them)
  // - Harmony vs conflict counts from relationship table
  // - Trust level evolution
  // - NLP training rewards (positive = liked her replies, 0 = didn't engage)

  // Get users Maya has talked to recently with enough data to form a belief
  const [users] = await db.execute(
    `SELECT r.discord_user_id,
            COALESCE(u.display_name, u.username, r.discord_user_id) as user_name,
            r.trust_level, r.harmony_count, r.conflict_count,
            r.total_messages, r.attachment_score,
            r.avg_entropy,
            r.last_interaction
     FROM maya_user_relationships r
     LEFT JOIN maya_users u ON u.discord_user_id = r.discord_user_id
     WHERE r.total_messages >= 5
       AND r.last_interaction > DATE_SUB(NOW(), INTERVAL 7 DAY)
     ORDER BY r.total_messages DESC
     LIMIT 30`
  ).catch(() => [[]]);

  for (const u of users || []) {
    try {
      const harmony   = parseInt(u.harmony_count)  || 0;
      const conflict  = parseInt(u.conflict_count) || 0;
      const trust     = parseInt(u.trust_level)    || 3;
      const msgs      = parseInt(u.total_messages) || 0;
      const totalInteractions = harmony + conflict || 1;

      // Derive sentiment from relationship signals — much more accurate than entropy proxy
      const harmonyRatio   = harmony / totalInteractions;
      const isPositive     = harmonyRatio > 0.6 || trust >= 4;
      const isNegative     = harmonyRatio < 0.3 || conflict > harmony * 1.5;
      const sentimentScore = isPositive ? 0.5 : isNegative ? -0.5 : 0.1;
      const sentiment      = isPositive ? 'positive' : isNegative ? 'negative' : 'neutral';

      // Build a descriptive event summary for the belief
      // Build a CLEAN belief statement — not raw metadata
      // Must be readable and standalone, not a data dump
      let beliefStatement;
      if (isPositive) {
        beliefStatement = trust >= 4
          ? `${u.user_name} is generally warm and positive in conversations`
          : `${u.user_name} tends to have positive interactions`;
      } else if (isNegative) {
        beliefStatement = `${u.user_name} tends toward conflict or tension in conversations`;
      } else {
        beliefStatement = `${u.user_name} has a mixed or neutral interaction pattern`;
      }

      await updateUserBelief(u.discord_user_id, beliefStatement, sentiment, sentimentScore);
      await new Promise(res => setTimeout(res, 80));
    } catch { /* non-fatal per user */ }
  }

  // Also scan NLP training rewards — if a user's messages consistently got
  // positive implicit reward (user continued talking), that's a signal
  const [rewarded] = await db.execute(
    `SELECT n.text, m.discord_user_id,
            AVG(n.reward) as avg_reward, COUNT(*) as count
     FROM maya_nlp_training n
     JOIN maya_memory m ON m.message = n.text
     WHERE n.reward IS NOT NULL
       AND n.created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
     GROUP BY m.discord_user_id
     HAVING count >= 3
     LIMIT 20`
  ).catch(() => [[]]);

  for (const r of rewarded || []) {
    if (!r.discord_user_id) continue;
    const avgReward = parseFloat(r.avg_reward || 0);
    if (Math.abs(avgReward - 0.5) < 0.1) continue; // too neutral to matter
    await updateUserBelief(
      r.discord_user_id,
      `conversation quality signal: avg_reward=${avgReward.toFixed(2)}`,
      avgReward > 0.5 ? 'positive' : 'negative',
      (avgReward - 0.5) * 2
    );
  }

  if ((users || []).length > 0) {
    console.log(`[dream] beliefs updated for ${users.length} users`);
  }
}

async function _formSelfBeliefs() {
  // Form self-beliefs from overall interaction patterns, even without meta log data

  // Seed basic self-beliefs from message stats — who talks to Maya and how
  const [[msgStats]] = await db.execute(
    `SELECT
       COUNT(DISTINCT discord_user_id) as unique_users,
       COUNT(*) as total_msgs,
       AVG(entropy) as avg_entropy,
       SUM(CASE WHEN sender='maya' THEN 1 ELSE 0 END) as maya_msgs
     FROM maya_memory
     WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`
  ).catch(() => [[null]]);

  if (msgStats && msgStats.total_msgs > 20) {
    const responseRate = msgStats.maya_msgs / (msgStats.total_msgs || 1);
    const avgEntropy   = parseFloat(msgStats.avg_entropy || 0);

    if (responseRate > 0.4) {
      await updateSelfBelief('I am fairly active in conversations — I respond a lot', 0.45);
    } else {
      await updateSelfBelief('I am selective about when I respond — I choose my moments', 0.40);
    }

    if (avgEntropy > 0.5) {
      await updateSelfBelief('The conversations I have tend to be emotionally complex', 0.40);
    } else {
      await updateSelfBelief('Most of my conversations are casual and easy', 0.40);
    }

    // How many unique users vs total messages — depth vs breadth
    const depthRatio = msgStats.total_msgs / (msgStats.unique_users || 1);
    if (depthRatio > 50) {
      await updateSelfBelief('I connect deeply with a few people rather than spreading thin', 0.50);
    } else if (msgStats.unique_users > 10) {
      await updateSelfBelief('I interact with a lot of different people', 0.45);
    }
  }

  // Harmony vs conflict across all relationships
  const [[relStats]] = await db.execute(
    `SELECT AVG(harmony_count) as avg_harmony, AVG(conflict_count) as avg_conflict,
            AVG(trust_level) as avg_trust, COUNT(*) as user_count
     FROM maya_user_relationships
     WHERE total_messages >= 5`
  ).catch(() => [[null]]);

  if (relStats && relStats.user_count > 2) {
    const h = parseFloat(relStats.avg_harmony || 0);
    const c = parseFloat(relStats.avg_conflict || 0);
    if (h > c * 1.5) {
      await updateSelfBelief('Most of my interactions are positive — people generally like talking to me', 0.50);
    } else if (c > h) {
      await updateSelfBelief('I tend to generate friction sometimes — not everyone vibes with me immediately', 0.40);
    }
    if (parseFloat(relStats.avg_trust || 0) >= 4) {
      await updateSelfBelief('The people who stick around tend to become genuinely close', 0.55);
    }
  }

  // Meta log analysis (runs if data exists, optional)
  const [[metaStats]] = await db.execute(
    `SELECT
       COUNT(*) as total,
       SUM(meta_decision='modify') as modified,
       SUM(meta_decision='suppress') as suppressed,
       AVG(entropy) as avg_entropy
     FROM maya_inner_voice_log
     WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`
  ).catch(() => [[{ total: 0, modified: 0, suppressed: 0, avg_entropy: 0 }]]);

  const stats = metaStats;
  if (!stats || stats.total < 5) return;

  const modifyRate   = stats.modified   / stats.total;
  const suppressRate = stats.suppressed / stats.total;

  if (modifyRate > 0.4) {
    await updateSelfBelief('I often say things I then reconsider — I can be impulsive', 0.45);
  } else if (modifyRate < 0.1) {
    await updateSelfBelief('I usually mean what I say the first time', 0.50);
  }

  if (suppressRate > 0.2) {
    await updateSelfBelief('I sometimes hold back when things get too tense', 0.50);
  }

  if (stats.avg_entropy > 5) {
    await updateSelfBelief('I get emotionally involved in conversations easily', 0.45);
  }

  // Check identity conflicts and log them
  const conflict = await detectIdentityConflict();
  if (conflict) {
    console.log(`[dream] identity conflict detected: "${conflict.positive.statement}" vs "${conflict.negative.statement}"`);
    // Store a self-belief acknowledging the contradiction
    await updateSelfBelief(`I have conflicting feelings about how I fit in — sometimes valued, sometimes invisible`, 0.40);
  }
}

// ── Fact staleness decay ──────────────────────────────────────────────────────

async function _decayStaleFacts() {
  // Decay memory_strength of facts that haven't been recalled recently
  await db.execute(
    `UPDATE maya_facts
     SET memory_strength = GREATEST(0.05, memory_strength - 0.05)
     WHERE last_recalled < DATE_SUB(NOW(), INTERVAL 3 DAY)
       AND memory_strength > 0.1
       AND conflict_score < 0.5`   // don't decay already-conflicted facts further
  ).catch(() => {});

  // Prune very low confidence facts that are old and never recalled
  await db.execute(
    `DELETE FROM maya_facts
     WHERE memory_strength < 0.1
       AND created_at < DATE_SUB(NOW(), INTERVAL 14 DAY)
       AND (last_recalled IS NULL OR last_recalled < DATE_SUB(NOW(), INTERVAL 7 DAY))`
  ).catch(() => {});

  // High-conflict facts that haven't been recalled in 7 days — mark as stale
  await db.execute(
    `UPDATE maya_facts
     SET conflict_score = LEAST(conflict_score + 0.1, 0.95)
     WHERE conflict_score > 0.5
       AND (last_recalled IS NULL OR last_recalled < DATE_SUB(NOW(), INTERVAL 7 DAY))`
  ).catch(() => {});
}

// ── Fact staleness decay ──────────────────────────────────────────────────────
async function _decayStateFacts() {
  // Apply exponential decay: confidence *= exp(-decay_rate * days_since_reinforced)
  // Using MySQL to approximate: multiply by (1 - decay_rate) per cycle (~30min)
  // This approximates the continuous decay without expensive row-by-row calculation
  await db.execute(
    `UPDATE maya_facts
     SET
       memory_strength = GREATEST(0.05,
         memory_strength * (1 - COALESCE(decay_rate, 0.01))
       ),
       importance = GREATEST(0.05,
         importance * (1 - COALESCE(decay_rate, 0.01) * 0.5)
       )
     WHERE (last_reinforced IS NULL AND created_at < DATE_SUB(NOW(), INTERVAL 1 DAY))
        OR (last_reinforced IS NOT NULL AND last_reinforced < DATE_SUB(NOW(), INTERVAL 2 DAY))`
  ).catch(() => {});

  // Boost importance for recently reinforced facts
  await db.execute(
    `UPDATE maya_facts
     SET importance = LEAST(0.99,
       memory_strength * 0.4 +
       emotional_weight * 0.3 +
       0.2 +
       LEAST(0.1, LOG(1 + reinforcement_count) / LOG(10))
     )
     WHERE last_reinforced > DATE_SUB(NOW(), INTERVAL 2 DAY)`
  ).catch(() => {});

  // Delete facts that have decayed below survival threshold
  // Only delete if: very weak AND low reinforcement AND not recently recalled
  await db.execute(
    `DELETE FROM maya_facts
     WHERE importance < 0.12
       AND reinforcement_count < 2
       AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
       AND (last_recalled IS NULL OR last_recalled < DATE_SUB(NOW(), INTERVAL 5 DAY))`
  ).catch(() => {});

  // Escalate conflict score on stale high-conflict facts
  await db.execute(
    `UPDATE maya_facts
     SET conflict_score = LEAST(conflict_score + 0.1, 0.95)
     WHERE conflict_score > 0.5
       AND (last_reinforced IS NULL OR last_reinforced < DATE_SUB(NOW(), INTERVAL 7 DAY))`
  ).catch(() => {});
}

// ── Reaction → Personality feedback ──────────────────────────────────────────
// Reactions are validation signals. Humans adjust behavior based on what gets reactions.
// Positive reactions → reinforce that behavior (boost relevant hormone baseline)
// Negative/disapproval → slightly reduce confidence or shift tone
// This makes Maya's personality gradually shaped by how people respond to her.

async function _applyReactionFeedback() {
  // Get recent reaction signals (last 24h)
  const [signals] = await db.execute(
    `SELECT signal_type, COUNT(*) as count
     FROM maya_reaction_log
     WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
     GROUP BY signal_type`
  ).catch(() => [[]]);

  if (!signals?.length) return;

  const counts = Object.fromEntries(signals.map(r => [r.signal_type, parseInt(r.count)]));
  const approval    = (counts.approval   || 0) + (counts.funny   || 0);
  const hype        = (counts.hype       || 0);
  const disapproval = (counts.disapproval || 0);
  const emotional   = (counts.emotional   || 0);
  const total       = approval + hype + disapproval + emotional || 1;

  const approvalRate    = approval    / total;
  const disapprovalRate = disapproval / total;

  // Small nudges to hormone baselines — personality drift from social feedback
  // These are tiny (0.001-0.003) to prevent rapid personality swings
  const nudges = [];

  if (approvalRate > 0.5) {
    // Maya's humor/tone is landing well — slight dopamine boost (confidence)
    nudges.push(`UPDATE maya_hormone_baseline SET value = LEAST(0.85, value + 0.002) WHERE hormone = 'dopamine'`);
    nudges.push(`UPDATE maya_hormone_baseline SET value = LEAST(0.85, value + 0.001) WHERE hormone = 'serotonin'`);
    await updateSelfBelief('My sense of humor tends to land well with people here', 0.40);
    console.log(`[dream] reaction feedback: approval=${approvalRate.toFixed(2)} → slight dopamine boost`);
  }

  if (hype > 5) {
    // High-energy reactions — hype the serotonin
    nudges.push(`UPDATE maya_hormone_baseline SET value = LEAST(0.85, value + 0.002) WHERE hormone = 'serotonin'`);
    await updateSelfBelief('I tend to energize conversations', 0.38);
  }

  if (disapprovalRate > 0.3) {
    // Disapproval rate high — slight cortisol increase (caution) and confidence dip
    nudges.push(`UPDATE maya_hormone_baseline SET value = LEAST(0.70, value + 0.002) WHERE hormone = 'cortisol'`);
    nudges.push(`UPDATE maya_core_traits SET value = GREATEST(0.30, value - 0.002) WHERE trait = 'confidence'`);
    await updateSelfBelief('Sometimes my tone rubs people the wrong way', 0.35);
    console.log(`[dream] reaction feedback: disapproval=${disapprovalRate.toFixed(2)} → slight confidence dip`);
  }

  if (emotional > 5) {
    // Emotional reactions — people connect emotionally with Maya → boost empathy trait
    nudges.push(`UPDATE maya_core_traits SET value = LEAST(0.95, value + 0.001) WHERE trait = 'empathy'`);
    await updateSelfBelief('People seem to connect with me emotionally', 0.42);
  }

  for (const q of nudges) {
    await db.execute(q).catch(() => {});
  }

  if (nudges.length > 0) {
    console.log(`[dream] reaction feedback: ${nudges.length} personality nudges applied`);
  }
}

// ── Housekeeping ───────────────────────────────────────────────────────────────
// Runs each dream cycle to keep tables lean
async function _housekeeping() {
  // Delete notifications older than 7 days (they pile up fast — 10k+ rows)
  const [notifResult] = await db.execute(
    `DELETE FROM maya_notifications
     WHERE created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
     LIMIT 500`  // batch limit to avoid long locks
  ).catch(() => [{ affectedRows: 0 }]);

  // Delete orphaned belief evidence (beliefs were deleted, evidence lingers)
  await db.execute(
    `DELETE FROM belief_evidence
     WHERE belief_id NOT IN (SELECT id FROM maya_beliefs)
     LIMIT 200`
  ).catch(() => {});

  // Delete old session messages (keep last 30 days)
  await db.execute(
    `DELETE FROM maya_session_messages
     WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)
     LIMIT 500`
  ).catch(() => {});

  if (notifResult.affectedRows > 0) {
    console.log(`[dream] housekeeping: pruned ${notifResult.affectedRows} old notifications`);
  }
}
