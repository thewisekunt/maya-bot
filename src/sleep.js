import { processMorningInbox, dismissOldNotifications } from './inbox.js';
import { saveMessage } from './memory.js';
import { mayaSpeak } from './index.js';
/**
 * sleep.js — Maya's nightly sleep cycle
 *
 * Maya sleeps from 1:30am to 7:00am IST.
 * During sleep:
 *   1. She stops replying (handler checks isSleeping())
 *   2. Deep memory consolidation runs:
 *      a. Score all raw_message points by importance
 *      b. Cluster related messages → compress into summaries
 *      c. Upgrade high-importance raw points to typed (user_fact/conversation)
 *      d. Prune low-importance noise from Qdrant
 *      e. Boost weight of frequently recalled points
 *   3. Full learning cycle runs (weights update)
 *   4. NLP retrains
 *   5. Personality drift updates
 *
 * Architecture principle:
 *   Raw messages = cheap, noisy, equal weight (current state)
 *   After consolidation = typed, scored, weighted by importance
 *   This is what makes recall progressively better over time
 */

import axios  from 'axios';
import db     from './db.js';
import { config } from './config.js';
import { embed, embedBatch } from './embedder.js';
import { upsertBatch, isConfigured } from './vector.js';
import { retrainFromDB } from './nlp.js';
import { updateSlowDrift } from './psyche.js';
import { runLearningCycle } from './learn.js';

// ── Sleep schedule (IST) ─────────────────────────────────────────────────────
const SLEEP_START_HOUR = 1;   // 1:30am IST
const SLEEP_START_MIN  = 30;
const WAKE_HOUR        = 7;   // 7:00am IST
const WAKE_MIN         = 0;

// IST = UTC+5:30
function _nowIST() {
  const utc = new Date();
  return new Date(utc.getTime() + (5.5 * 60 * 60 * 1000));
}

function _isSleepTime() {
  const ist = _nowIST();
  const h = ist.getHours();
  const m = ist.getMinutes();
  const mins = h * 60 + m;
  const sleepMins = SLEEP_START_HOUR * 60 + SLEEP_START_MIN;  // 90 = 1:30am
  const wakeMins  = WAKE_HOUR * 60 + WAKE_MIN;                // 420 = 7:00am
  // Sleep window is within the same calendar day (1:30am–7:00am)
  // Both are low values — just check if we're between them
  return mins >= sleepMins && mins < wakeMins;
}

let _sleeping    = false;
let _sleepTimer  = null;
let _client      = null;
let _sleepLogId  = null;

export function isSleeping() {
  // Double-check: if flag says sleeping but time says awake, fix the flag
  if (_sleeping && !_isSleepTime()) {
    console.log('[sleep] flag stuck — forcing wake');
    _sleeping = false;
    // Run exit async (fire and forget)
    _exitSleep().catch(() => {});
  }
  return _sleeping;
}

export function startSleepEngine(discordClient) {
  _client = discordClient;
  _sleepTimer = setInterval(_checkSleepSchedule, 60_000);  // check every minute
  _checkSleepSchedule();  // check immediately on startup
  console.log('[sleep] engine started');
}

async function _checkSleepSchedule() {
  const ist  = _nowIST();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const shouldSleep = _isSleepTime();

  // Log state every 10 minutes to make sleep issues visible
  if (mins % 10 === 0) {
    const istTime = `${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}`;
    console.log(`[sleep] status: sleeping=${_sleeping} shouldSleep=${shouldSleep} time=${istTime} IST`);
  }

  if (shouldSleep && !_sleeping) {
    await _enterSleep();
  } else if (!shouldSleep && _sleeping) {
    console.log('[sleep] waking up — sleep window ended');
    await _exitSleep();
  }
}

async function _enterSleep() {
  _sleeping = true;
  const ist = _nowIST();
  const istStr = `${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}`;
  console.log(`[sleep] Maya going to sleep at ${istStr} IST`);

  // Log sleep start
  try {
    const [res] = await db.execute(
      `INSERT INTO maya_sleep_log (sleep_start, status) VALUES (NOW(), 'sleeping')`
    );
    _sleepLogId = res.insertId;
  } catch { /* non-fatal */ }

  // Post AFK message so Dyno can set AFK status
  await _postSleepMessage().catch(() => {});

  // Run deep consolidation (non-blocking)
  _runConsolidation().catch(e => console.error('[sleep] consolidation error:', e.message));
}

async function _postSleepMessage() {
  if (!_client?.isReady()) return;

  const [[ch]] = await db.execute(
    `SELECT channel_id FROM maya_memory
     WHERE context_type='server' AND channel_id IS NOT NULL
       AND created_at > DATE_SUB(NOW(), INTERVAL 6 HOUR)
     GROUP BY channel_id ORDER BY COUNT(*) DESC LIMIT 1`
  ).catch(() => [[null]]);

  if (!ch?.channel_id) return;

  // Route through full pipeline — Maya says goodnight in her own voice
  await mayaSpeak({
    channelId: ch.channel_id,
    userId:    null,
    guildId:   null,
    isDM:      false,
    trigger:   'sleep',
    context:   'Maya is going to sleep now. Say goodnight to the channel in her own casual Hinglish way — short, natural, no drama. Something like "afk sone ja rahi hun" or "gn log". One line only.',
    client:    _client,
  }).catch(() => {});
  console.log('[sleep] posted sleep message via pipeline');
}

async function _exitSleep() {
  _sleeping = false;
  const ist = _nowIST();
  const istStr = `${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}`;
  console.log(`[sleep] Maya waking up at ${istStr} IST`);

  if (_sleepLogId) {
    await db.execute(
      `UPDATE maya_sleep_log SET sleep_end=NOW(), status='done' WHERE id=?`,
      [_sleepLogId]
    ).catch(() => {});
    _sleepLogId = null;
  }

  // Process pending notifications from sleep
  if (_client) {
    await processMorningInbox(_client).catch(e => console.error('[sleep] inbox:', e.message));
    await dismissOldNotifications().catch(() => {});
  }

  // Post wake message
  await _postWakeMessage().catch(() => {});
}

async function _postWakeMessage() {
  if (!_client?.isReady()) return;

  const [[ch]] = await db.execute(
    `SELECT channel_id FROM maya_memory
     WHERE context_type='server' AND channel_id IS NOT NULL
       AND created_at > DATE_SUB(NOW(), INTERVAL 12 HOUR)
     GROUP BY channel_id ORDER BY COUNT(*) DESC LIMIT 1`
  ).catch(() => [[null]]);

  if (!ch?.channel_id) return;

  // Route through full pipeline — Maya wakes up in her own voice
  await mayaSpeak({
    channelId: ch.channel_id,
    userId:    null,
    guildId:   null,
    isDM:      false,
    trigger:   'wake',
    context:   'Maya just woke up. Say good morning or announce she is back in her own casual Hinglish way — short, grumpy, nonchalant. Something like "woke up" or "ugh morning" or "kya hua sone ke baad". One line only.',
    client:    _client,
  }).catch(() => {});
  console.log('[sleep] posted wake message via pipeline');
}

// ── Deep consolidation pipeline ───────────────────────────────────────────────

async function _runConsolidation() {
  if (!isConfigured()) return;

  console.log('[sleep] starting deep memory consolidation');
  const stats = { upgraded: 0, pruned: 0, clusters: 0, scored: 0 };

  try {
    // Phase 1: Score all unscored raw messages by importance
    await _scoreMessages(stats);

    // Phase 2: Cluster related messages per user per guild → compress to summaries
    await _clusterAndSummarise(stats);

    // Phase 3: Boost weight of frequently recalled points in Qdrant
    await _boostRecalledPoints(stats);

    // Phase 4: Prune low-importance, unrecalled old points
    await _pruneNoise(stats);

    // Phase 5: Run all dream cycle tasks (learning, NLP, drift)
    await _runDreamTasks();

    // Update sleep log with stats
    if (_sleepLogId) {
      await db.execute(
        `UPDATE maya_sleep_log
         SET points_upgraded=?, points_pruned=?, clusters_formed=?, raw_msgs_processed=?
         WHERE id=?`,
        [stats.upgraded, stats.pruned, stats.clusters, stats.scored, _sleepLogId]
      ).catch(() => {});
    }

    console.log(`[sleep] consolidation complete — scored=${stats.scored} upgraded=${stats.upgraded} clusters=${stats.clusters} pruned=${stats.pruned}`);

  } catch (e) {
    console.error('[sleep] consolidation failed:', e.message);
    if (_sleepLogId) {
      await db.execute(
        `UPDATE maya_sleep_log SET status='interrupted' WHERE id=?`, [_sleepLogId]
      ).catch(() => {});
    }
  }
}

// Phase 1: score messages by importance
// Importance = entropy * trust_weight * recency_factor * interaction_depth
async function _scoreMessages(stats) {
  console.log('[sleep] phase 1: scoring messages');

  const [rows] = await db.execute(
    `SELECT m.id, m.discord_user_id, m.guild_id, m.entropy, m.sender,
            m.message, m.created_at,
            COALESCE(r.trust_level, 3) as trust_level,
            COALESCE(r.harmony_count, 0) as harmony_count
     FROM maya_memory m
     LEFT JOIN maya_user_relationships r ON r.discord_user_id = m.discord_user_id
     WHERE m.consolidated = 0
       AND m.embedded = 1
       AND m.created_at > DATE_SUB(NOW(), INTERVAL 90 DAY)
     LIMIT 500`
  ).catch(() => [[]]);

  if (!rows.length) return;

  const now = Date.now();
  const updates = [];

  for (const r of rows) {
    const ageDays    = (now - new Date(r.created_at).getTime()) / 86400000;
    const recency    = Math.exp(-0.05 * ageDays);           // fades over time
    const trustBoost = (r.trust_level / 5) * 0.4 + 0.6;   // 0.6–1.0
    const entropy    = parseFloat(r.entropy) || 0.4;        // 0–1 content richness
    const depthBonus = r.sender === 'maya' ? 0.1 : 0;      // Maya's own replies slightly more important
    const harmonyBoost = Math.min(r.harmony_count * 0.02, 0.2);

    const score = Math.min(
      (entropy * 0.4 + recency * 0.3 + trustBoost * 0.2 + harmonyBoost * 0.1) + depthBonus,
      1.0
    );

    updates.push([parseFloat(score.toFixed(3)), r.id]);
  }

  // Batch update importance scores
  for (let i = 0; i < updates.length; i += 50) {
    const batch = updates.slice(i, i + 50);
    const cases = batch.map(() => 'WHEN id=? THEN ?').join(' ');
    const vals  = batch.flatMap(([score, id]) => [id, score]);
    const ids   = batch.map(([, id]) => id);
    await db.execute(
      `UPDATE maya_memory SET importance_score = CASE ${cases} END WHERE id IN (${ids.map(() => '?').join(',')})`,
      [...vals, ...ids]
    ).catch(() => {});
  }

  stats.scored = updates.length;
  console.log(`[sleep] scored ${updates.length} messages`);
}

// Phase 2: cluster related raw messages per (user, guild, day) → LLM summary
async function _clusterAndSummarise(stats) {
  console.log('[sleep] phase 2: clustering and summarising');

  // Find user+guild+day clusters with enough messages to summarise
  const [clusters] = await db.execute(
    `SELECT discord_user_id, guild_id,
            DATE(created_at) as day,
            COUNT(*) as msg_count,
            AVG(importance_score) as avg_importance
     FROM maya_memory
     WHERE consolidated = 0
       AND embedded = 1
       AND sender = 'user'
       AND importance_score >= 0.35
       AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
     GROUP BY discord_user_id, guild_id, DATE(created_at)
     HAVING msg_count >= 5
     ORDER BY avg_importance DESC
     LIMIT 20`
  ).catch(() => [[]]);

  for (const cluster of clusters) {
    await _processCluster(cluster, stats);
    // Small delay between clusters to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }
}

async function _processCluster(cluster, stats) {
  const { discord_user_id, guild_id, day } = cluster;

  // Fetch messages for this cluster
  const [msgs] = await db.execute(
    `SELECT id, user_name, sender, message, entropy, importance_score
     FROM maya_memory
     WHERE discord_user_id=? AND (guild_id=? OR (guild_id IS NULL AND ? IS NULL))
       AND DATE(created_at)=?
       AND consolidated=0 AND embedded=1
     ORDER BY created_at ASC LIMIT 30`,
    [discord_user_id, guild_id, guild_id, day]
  ).catch(() => [[]]);

  if (msgs.length < 3) return;

  const userName   = msgs.find(m => m.sender === 'user')?.user_name || discord_user_id;
  const transcript = msgs.map(m =>
    `${m.sender === 'maya' ? 'Maya' : userName}: ${m.message}`
  ).join('\n');

  // LLM: extract consolidated facts from this cluster
  try {
    const prompt = `Extract key facts from this conversation cluster. Be concise and factual.

Speaker: ${userName}
Date: ${day}

Conversation:
${transcript.slice(0, 2000)}

Return JSON only:
{
  "facts": ["<third-person fact about ${userName}>", ...],
  "summary": "<1 sentence: what happened in this cluster>",
  "topics": ["<topic>"],
  "mood": "positive|negative|neutral|mixed"
}

Rules:
- Max 4 facts
- Only clearly stated facts, not inferences
- Third person: "${userName} likes X" not "I like X"
- If nothing factual, return {"facts":[],"summary":"","topics":[],"mood":"neutral"}`;

    const { data, status } = await axios.post(config.llm.endpoint, {
      model:       config.llm.models.utility,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens:  300,
    }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.llm.apiKey}` },
      timeout: 15000, validateStatus: () => true,
    });

    if (status !== 200) return;

    const raw = data?.choices?.[0]?.message?.content?.trim() || '{}';
    // Strip markdown fences (model often returns ```json ... ```)
    let clean = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    // If still wrapped (double fences), strip again
    if (clean.startsWith('`')) clean = clean.replace(/`/g, '');
    // Extract JSON object if embedded in prose
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    clean = jsonMatch[0];
    let result;
    try {
      result = JSON.parse(clean);
    } catch (parseErr) {
      console.log(`[sleep] cluster ${discord_user_id}/${day} JSON parse failed: ${parseErr.message}`);
      return;
    }

    if (!result.facts?.length && !result.summary) return;

    // Embed and upsert consolidated points with higher weight
    const points = [];

    // Summary point
    if (result.summary) {
      const summaryText = `${userName} on ${day}: ${result.summary}`;
      const vec = await embed(summaryText).catch(() => null);
      if (vec) {
        points.push({
          id: `cons_${discord_user_id}_${day}_${Date.now()}`,
          vector: vec,
          payload: {
            memory_type:     'conversation',
            discord_user_id: discord_user_id,
            user_name:       userName,
            guild_id:        guild_id || null,
            is_private:      !guild_id,
            message:         summaryText,
            topics:          result.topics || [],
            mood:            result.mood || 'neutral',
            weight:          2.5,   // consolidated = highest weight
            consolidated:    true,
            created_at:      new Date().toISOString(),
          },
        });
      }
    }

    // Individual fact points
    for (const fact of (result.facts || []).slice(0, 4)) {
      const vec = await embed(fact).catch(() => null);
      if (vec) {
        points.push({
          id: `cf_${discord_user_id}_${day}_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
          vector: vec,
          payload: {
            memory_type:     'user_fact',
            discord_user_id: discord_user_id,
            user_name:       userName,
            guild_id:        guild_id || null,
            is_private:      !guild_id,
            fact_text:       fact,
            message:         fact,
            weight:          2.2,   // consolidated facts > raw messages
            consolidated:    true,
            created_at:      new Date().toISOString(),
          },
        });
      }
    }

    if (points.length > 0) {
      await upsertBatch(points).catch(() => {});
      stats.upgraded += points.length;
      stats.clusters++;
    }

    // Mark source messages as consolidated
    const ids = msgs.map(m => m.id);
    await db.execute(
      `UPDATE maya_memory SET consolidated=1 WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    ).catch(() => {});

  } catch (e) {
    console.warn(`[sleep] cluster ${discord_user_id}/${day} failed:`, e.message);
  }
}

// Phase 3: boost weight of frequently recalled points
async function _boostRecalledPoints(stats) {
  console.log('[sleep] phase 3: boosting recalled points');

  // Get facts with high recall count from SQL
  const [facts] = await db.execute(
    `SELECT fact, discord_user_id FROM maya_facts
     WHERE recall_count >= 3
       AND memory_strength > 0.6
     LIMIT 50`
  ).catch(() => [[]]);

  if (!facts.length) return;

  // For each high-recall fact, find its Qdrant point and boost weight
  // We do this by re-upserting with higher weight
  for (const f of facts) {
    try {
      const vec = await embed(f.fact).catch(() => null);
      if (!vec) continue;

      await upsertBatch([{
        id: `boost_${f.discord_user_id}_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
        vector: vec,
        payload: {
          memory_type:     'user_fact',
          discord_user_id: f.discord_user_id,
          fact_text:       f.fact,
          message:         f.fact,
          weight:          3.0,   // max boost — frequently recalled = very important
          consolidated:    true,
          boosted:         true,
          created_at:      new Date().toISOString(),
        },
      }]).catch(() => {});
    } catch { /* non-fatal */ }

    await new Promise(r => setTimeout(r, 100));
  }
}

// Phase 4: prune low-importance noise from Qdrant
async function _pruneNoise(stats) {
  console.log('[sleep] phase 4: pruning noise');

  // Find old, low-importance, consolidated messages to remove from Qdrant
  const [toDelete] = await db.execute(
    `SELECT id FROM maya_memory
     WHERE importance_score < 0.20
       AND consolidated = 1
       AND created_at < DATE_SUB(NOW(), INTERVAL 14 DAY)
       AND sender = 'user'
     LIMIT 100`
  ).catch(() => [[]]);

  if (!toDelete.length) return;

  // Delete from Qdrant by point ID
  const { default: axios2 } = await import('axios');
  const QDRANT_URL = process.env.QDRANT_URL;
  const QDRANT_KEY = process.env.QDRANT_API_KEY;
  const COLLECTION = process.env.QDRANT_COLLECTION || 'maya-memories';

  const pointIds = toDelete.map(r => `raw_${r.id}`);

  try {
    // Qdrant delete by payload filter (delete low-importance raw messages)
    const res = await axios2.post(
      `${QDRANT_URL}/collections/${COLLECTION}/points/delete`,
      {
        filter: { must: [
          { key: 'memory_type',    match: { value: 'raw_message' } },
          { key: 'importance_score', range: { lt: 0.20 } },
        ]}
      },
      { headers: { 'api-key': QDRANT_KEY, 'Content-Type': 'application/json' }, timeout: 15000, validateStatus: () => true }
    );
    if (res.status === 200) {
      stats.pruned += toDelete.length;
      console.log(`[sleep] pruned ${toDelete.length} low-importance points`);
    }
  } catch { /* non-fatal */ }
}

// Phase 5: run standard dream tasks
async function _runDreamTasks() {
  console.log('[sleep] phase 5: dream tasks (NLP, drift, learning)');
  await retrainFromDB().catch(e => console.error('[sleep] NLP retrain:', e.message));
  await updateSlowDrift().catch(e => console.error('[sleep] drift:', e.message));
  await runLearningCycle().catch(e => console.error('[sleep] learning:', e.message));
}

// ── Wake message ───────────────────────────────────────────────────────────────
// After waking, Maya can optionally post a "good morning" style message
// to her most active channel — but only if she feels like it
export async function maybeSendWakeMessage() {
  if (!_client?.isReady()) return;

  try {
    // Check Maya's mood — only send if she's in good spirits
    const [[hormones]] = await db.execute(
      `SELECT GROUP_CONCAT(CONCAT(hormone,'=',value)) as h FROM maya_hormone_baseline`
    );
    const h = Object.fromEntries(
      (hormones?.h || '').split(',').map(p => p.split('=').map((v, i) => i === 1 ? parseFloat(v) : v))
    );

    if ((h.serotonin || 0.6) < 0.5 || (h.dopamine || 0.5) < 0.4) return;  // not feeling it

    // Find most active channel from recent messages
    const [[ch]] = await db.execute(
      `SELECT channel_id FROM maya_memory
       WHERE context_type='server' AND channel_id IS NOT NULL
         AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
       GROUP BY channel_id ORDER BY COUNT(*) DESC LIMIT 1`
    ).catch(() => [[null]]);

    if (!ch?.channel_id) return;

    const channel = await _client.channels.fetch(ch.channel_id).catch(() => null);
    if (!channel) return;

    const greetings = [
      'good morning ig',
      'ugh morning',
      'finally awake',
      'koi hai',
      'up and kinda awake',
      'chai time',
    ];
    const msg = greetings[Math.floor(Math.random() * greetings.length)];
    await channel.send(msg);

  } catch { /* non-fatal — wake message is optional */ }
}
