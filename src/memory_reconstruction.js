/**
 * memory_reconstruction.js — Human-like memory reconstruction engine
 *
 * Replaces the flat "query → top-8 memories" retrieval with a
 * spreading activation model that mirrors how human memory works:
 *
 *   1. Seed retrieval    — standard semantic search (what memory.js does now)
 *   2. Anomaly check     — is this message "on-brand" for this user?
 *   3. Mental model      — inject structured understanding of the person
 *   4. Cascade expansion — spread from seeds via shared user/emotion/topic
 *   5. Emotional blend   — current psyche state colors reconstruction
 *   6. Prune + rank      — score each hop, limit depth, cut noise
 *   7. Reconsolidation   — update centroid async (memory of recall)
 *
 * Called from memory.js buildContext() — drops in as an enriched wrapper
 * around the existing retrieval. The existing searches still run as seed;
 * this layer adds the cascade and mental model on top.
 *
 * Cascade depth: max 2 hops
 * Hop score decay: hop1 = 0.75×, hop2 = 0.50×
 * Max total memories injected: 12 (seeds + cascade)
 */

import { searchMemories } from './vector.js';
import { getCentroidVector, checkAnomaly, updateCentroid } from './centroid.js';
import { getModel } from './mental_model.js';
import db from './db.js';

const MAX_CASCADE_RESULTS = 12;   // total memories including seeds
const HOP1_DECAY          = 0.75; // score multiplier for hop 1
const HOP2_DECAY          = 0.50; // score multiplier for hop 2
const MIN_CASCADE_SCORE   = 0.30; // prune anything below this after decay
const CASCADE_LIMIT_PER_HOP = 4;  // max memories added per hop

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Reconstruct memory context for a user+message.
 * Returns an object with enriched memories and mental model metadata.
 *
 * @param {object} opts
 *   userId        {string}
 *   guildId       {string}
 *   prefName      {string}   — display name
 *   queryVector   {number[]} — already-computed embedding of current message
 *   seedMemories  {object[]} — results from existing memory.js searches
 *   psycheState   {object}   — { dopamine, cortisol, oxytocin } for emotional blend
 *   isDM          {boolean}
 *
 * @returns {{
 *   memories:     object[],   — reconstructed + ranked memories
 *   mentalModel:  string|null,— formatted model string for prompt injection
 *   anomaly:      object|null,— { isAnomaly, distance, threshold } or null
 *   cascadeDepth: number,     — how many hops were taken
 *   note:         string|null — e.g. "acting differently today"
 * }}
 */
export async function reconstruct({
  userId, guildId, prefName, queryVector,
  seedMemories = [], psycheState = {}, isDM = false,
}) {
  const result = {
    memories:     [...seedMemories],
    mentalModel:  null,
    anomaly:      null,
    cascadeDepth: 0,
    note:         null,
  };

  try {
    // ── 1. Mental model — read structured understanding ───────────────────
    result.mentalModel = await getModel(userId, guildId).catch(() => null);

    // ── 2. Anomaly check — is this message on-brand? ─────────────────────
    if (queryVector) {
      const anomaly = await checkAnomaly(userId, guildId, queryVector).catch(() => null);
      if (anomaly) {
        result.anomaly = anomaly;
        if (anomaly.isAnomaly) {
          result.note = `${prefName} seems to be acting differently than usual today (distance=${anomaly.distance})`;
          console.log(`[reconstruction] anomaly detected for ${prefName}: distance=${anomaly.distance} threshold=${anomaly.threshold}`);
        }
      }
    }

    // ── 3. Cascade expansion — hop 1: shared user + emotion + topic ──────
    if (seedMemories.length > 0 && queryVector) {
      const hop1 = await _hop1Expansion(seedMemories, userId, guildId, isDM);
      if (hop1.length > 0) {
        result.cascadeDepth = 1;
        result.memories = _merge(result.memories, hop1, HOP1_DECAY);
      }

      // ── 4. Cascade — hop 2: from hop1 results ────────────────────────
      if (hop1.length > 0) {
        const hop2 = await _hop2Expansion(hop1, userId, guildId, seedMemories, isDM);
        if (hop2.length > 0) {
          result.cascadeDepth = 2;
          result.memories = _merge(result.memories, hop2, HOP2_DECAY);
        }
      }
    }

    // ── 5. Gap fill via centroid — find "typical" memories ───────────────
    // If seed retrieval was sparse (< 2 memories), search toward centroid
    // to fill gaps with memories that are characteristic of this user
    if (seedMemories.length < 2 && queryVector) {
      const centroidVec = await getCentroidVector(userId, guildId).catch(() => null);
      if (centroidVec) {
        const gapFill = await _centroidGapFill(centroidVec, userId, guildId, isDM);
        if (gapFill.length > 0) {
          result.memories = _merge(result.memories, gapFill, HOP1_DECAY);
          result.note = (result.note ? result.note + '. ' : '') + 'Gap filled from typical memory pattern.';
          console.log(`[reconstruction] centroid gap fill: +${gapFill.length} memories for ${prefName}`);
        }
      }
    }

    // ── 6. Emotional blend — psyche state colors recall ──────────────────
    result.memories = _emotionalBlend(result.memories, psycheState);

    // ── 7. Prune + rank ──────────────────────────────────────────────────
    result.memories = _pruneAndRank(result.memories);

    // ── 8. Reconsolidation — update centroid async ───────────────────────
    // Recalling memories is itself an event that slightly updates the felt sense
    if (userId && userId !== 'maya') {
      updateCentroid(userId, guildId).catch(() => {});
    }

  } catch (e) {
    console.warn('[reconstruction] failed, returning seeds:', e.message);
    // Always return at least the seeds — never break the main pipeline
    result.memories = seedMemories;
  }

  return result;
}

/**
 * Format reconstructed memories into context string blocks.
 * Called from memory.js to replace the inline formatting logic.
 *
 * @param {object} reconstructed  — result of reconstruct()
 * @param {string} prefName
 * @returns {string[]}            — array of context lines to push into parts[]
 */
export function formatReconstructedMemories(reconstructed, prefName) {
  const lines = [];
  const { memories, mentalModel, anomaly, note } = reconstructed;

  // Mental model — inject at top if present
  if (mentalModel) {
    lines.push(mentalModel);
    lines.push('');
  }

  // Anomaly / behavioral note
  if (note) {
    lines.push(`[Behavioral note: ${note}]`);
    lines.push('');
  }

  // Memories — already ranked by _pruneAndRank
  if (memories.length > 0) {
    const facts   = memories.filter(m => m.payload?.memory_type === 'user_fact' || m._type === 'fact');
    const salient = memories.filter(m => m.payload?.memory_type === 'salient_moment');
    const conv    = memories.filter(m =>
      m.payload?.memory_type === 'raw_message' ||
      m.payload?.memory_type === 'conversation'
    );

    if (facts.length > 0) {
      lines.push(`--- What Maya knows about ${prefName} (from memory) ---`);
      facts.forEach(f => {
        const text = f.payload?.fact_text || f.message;
        if (text) {
          const hopNote = f._hop ? ` [recalled via ${f._hop}]` : '';
          lines.push(`• ${text}${hopNote}`);
        }
      });
      lines.push('');
    }

    if (salient.length > 0) {
      lines.push('--- High-importance past moments ---');
      salient.forEach(m => {
        const ts     = m.payload?.created_at ? _relativeTime(new Date(m.payload.created_at)) : '';
        const tsTag  = ts ? ` [${ts}]` : '';
        const emoTag = m.payload?.emotion && m.payload.emotion !== 'neutral'
          ? ` (${m.payload.emotion})` : '';
        lines.push(`• ${(m.message || '').slice(0, 200)}${tsTag}${emoTag}`);
      });
      lines.push('');
    }

    if (conv.length > 0) {
      lines.push('--- Relevant past context ---');
      conv.forEach(mem => {
        const ts     = mem.payload?.created_at ? _relativeTime(new Date(mem.payload.created_at)) : '';
        const tsTag  = ts ? ` [${ts}]` : '';
        const sender = mem.payload?.sender;
        const uname  = mem.payload?.user_name || prefName;
        let   text   = mem.message || '';
        if (!(/^[A-Za-z].{0,20}:/.test(text)) && sender) {
          text = `${sender === 'maya' ? 'Maya' : uname}: ${text}`;
        }
        const cross  = mem._crossUser ? ' [other user]' : '';
        const hop    = mem._hop ? ` [↳${mem._hop}]` : '';
        lines.push(`  ${text}${tsTag}${cross}${hop}`);
      });
      lines.push('');
    }
  }

  return lines;
}

// ── Cascade expansion ─────────────────────────────────────────────────────────

/**
 * Hop 1: expand from seed memories via shared emotion and topic.
 * User is already scoped by seed retrieval — here we find related memories
 * by matching on emotion tags and topic_tags from the seeds.
 */
async function _hop1Expansion(seeds, userId, guildId, isDM) {
  const results = [];

  // Extract emotion + topic signals from seeds
  const emotions = _extractPayloadField(seeds, 'emotion').filter(e => e && e !== 'neutral');
  const topics   = _extractPayloadField(seeds, 'topic_tags').flat().filter(Boolean);
  const topTopics = [...new Set(topics)].slice(0, 3);

  // Find memories from this user with matching emotion
  if (emotions.length > 0) {
    const emoMems = await _fetchByPayloadField(userId, guildId, 'emotion', emotions[0], 4, isDM);
    results.push(...emoMems.map(m => ({ ...m, _hop: 'emotion' })));
  }

  // Find memories from this user with matching topics
  if (topTopics.length > 0) {
    // Qdrant doesn't support array-contains in a single filter cleanly
    // Use a semantic search biased toward the topic label instead
    // This is a simpler approach that works without schema changes
    for (const topic of topTopics.slice(0, 2)) {
      const topicMems = await _fetchByTopic(userId, guildId, topic, 3, isDM).catch(() => []);
      results.push(...topicMems.map(m => ({ ...m, _hop: `topic:${topic}` })));
    }
  }

  return results.slice(0, CASCADE_LIMIT_PER_HOP);
}

/**
 * Hop 2: expand from hop1 results toward temporal neighbors.
 * Memories immediately before/after a hop1 result in session context.
 * This captures the "what was happening around this moment" context.
 */
async function _hop2Expansion(hop1Results, userId, guildId, alreadySeen, isDM) {
  const results       = [];
  const seenIds       = new Set([
    ...alreadySeen.map(m => m.payload?.mysql_id),
    ...hop1Results.map(m => m.payload?.mysql_id),
  ].filter(Boolean));

  // For each hop1 result that has a session_id, pull temporal neighbors
  const hop1WithSession = hop1Results.filter(m => m.payload?.session_id);

  for (const mem of hop1WithSession.slice(0, 2)) {
    const sessionId = mem.payload.session_id;
    const mysqlId   = mem.payload?.mysql_id;
    if (!mysqlId || !sessionId) continue;

    // Fetch ±2 messages around this memory in the same session
    const [rows] = await db.execute(
      `SELECT id, sender, user_name, message, created_at
       FROM maya_memory
       WHERE session_id = ?
         AND discord_user_id = ?
         AND id BETWEEN ? AND ?
         AND id != ?
       ORDER BY id
       LIMIT 4`,
      [sessionId, userId, mysqlId - 2, mysqlId + 2, mysqlId]
    ).catch(() => [[]]);

    for (const row of rows) {
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      results.push({
        message:  row.message,
        score:    0.55,  // temporal neighbor — moderate score
        payload:  {
          mysql_id:        row.id,
          memory_type:     'raw_message',
          sender:          row.sender,
          user_name:       row.user_name,
          discord_user_id: userId,
          guild_id:        guildId,
          created_at:      row.created_at,
        },
        _hop: 'temporal',
      });
    }
  }

  return results.slice(0, CASCADE_LIMIT_PER_HOP);
}

/**
 * Centroid gap fill — when seed retrieval is sparse,
 * search toward the centroid to find characteristic memories.
 */
async function _centroidGapFill(centroidVec, userId, guildId, isDM) {
  const filter = {
    must: [
      { key: 'discord_user_id', match: { value: String(userId) } },
      { key: 'sender',          match: { value: 'user' } },
    ],
  };
  if (!isDM && guildId) {
    filter.must.push({ key: 'guild_id', match: { value: String(guildId) } });
  }

  const results = await searchMemories(centroidVec, filter, 3, 0.40).catch(() => []);
  return results.map(m => ({ ...m, _hop: 'centroid_gap' }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _extractPayloadField(memories, field) {
  return memories
    .map(m => m.payload?.[field])
    .filter(Boolean);
}

async function _fetchByPayloadField(userId, guildId, field, value, limit, isDM) {
  const filter = {
    must: [
      { key: 'discord_user_id', match: { value: String(userId) } },
      { key: 'sender',          match: { value: 'user' } },
      { key: field,             match: { value: String(value) } },
    ],
  };
  if (!isDM && guildId) {
    filter.must.push({ key: 'guild_id', match: { value: String(guildId) } });
  }

  // Use a neutral vector for payload-filtered search (no query bias)
  // We want memories matching the field, not semantically similar ones
  const neutralVec = new Array(1536).fill(0);
  neutralVec[0] = 1;  // minimal non-zero vector

  return searchMemories(neutralVec, filter, limit, 0.0).catch(() => []);
}

async function _fetchByTopic(userId, guildId, topic, limit, isDM) {
  // Build a search from MySQL for messages containing topic keywords
  // (topic_tags index in Qdrant not guaranteed yet — use SQL as fallback)
  const topicKeywords = {
    relationships: ['relationship', 'dating', 'love', 'marriage', 'crush'],
    family:        ['family', 'mom', 'dad', 'sister', 'brother', 'parents'],
    work_study:    ['work', 'job', 'college', 'class', 'study', 'exam'],
    technology:    ['code', 'coding', 'tech', 'software', 'bot', 'ai'],
    mental_health: ['anxious', 'depressed', 'stress', 'overwhelmed', 'lonely'],
    humor:         ['lol', 'lmao', 'funny', 'joke', 'meme'],
    conflict:      ['fight', 'argue', 'problem', 'upset', 'angry'],
    memory:        ['remember', 'forgot', 'used to', 'back then'],
  };

  const keywords = topicKeywords[topic];
  if (!keywords) return [];

  const likeClause = keywords.slice(0, 3).map(() => 'message LIKE ?').join(' OR ');
  const likeParams = keywords.slice(0, 3).map(k => `%${k}%`);

  const [rows] = await db.execute(
    `SELECT id, sender, user_name, message, created_at
     FROM maya_memory
     WHERE discord_user_id = ?
       AND sender = 'user'
       AND (${likeClause})
       ${guildId && !isDM ? 'AND guild_id = ?' : ''}
     ORDER BY created_at DESC
     LIMIT ?`,
    [userId, ...likeParams, ...(guildId && !isDM ? [guildId] : []), limit]
  ).catch(() => [[]]);

  return (rows || []).map(row => ({
    message: row.message,
    score:   0.50,
    payload: {
      mysql_id:        row.id,
      memory_type:     'raw_message',
      sender:          row.sender,
      user_name:       row.user_name,
      discord_user_id: userId,
      guild_id:        guildId,
      created_at:      row.created_at,
    },
    _hop: `topic:${topic}`,
  }));
}

/**
 * Emotional blend — current psyche state slightly shifts memory ranking.
 * High dopamine: positive-valence memories rank higher.
 * High cortisol: high-arousal (intense) memories surface more.
 * High oxytocin: affection/connection memories rank higher.
 */
function _emotionalBlend(memories, psycheState) {
  const { dopamine = 0.5, cortisol = 0.1, oxytocin = 0.5 } = psycheState;

  return memories.map(mem => {
    const valence = mem.payload?.valence ?? 0;
    const arousal = mem.payload?.arousal ?? 0.4;
    const emotion = mem.payload?.emotion || 'neutral';

    let blendBoost = 0;

    // High dopamine → prefer warm/positive memories
    if (dopamine > 0.6) blendBoost += valence * 0.1;

    // High cortisol → prefer intense/high-arousal memories (threat-salience)
    if (cortisol > 0.4) blendBoost += arousal * 0.08;

    // High oxytocin → prefer affection/connection memories
    if (oxytocin > 0.6 && ['affection', 'joy', 'content'].includes(emotion)) {
      blendBoost += 0.05;
    }

    return { ...mem, score: (mem.score || 0.5) + blendBoost };
  });
}

/**
 * Merge new memories into existing set.
 * Deduplicates by mysql_id or message prefix.
 * Applies score decay to new memories.
 */
function _merge(existing, newMems, decay) {
  const seenIds  = new Set(existing.map(m => m.payload?.mysql_id).filter(Boolean));
  const seenMsgs = new Set(existing.map(m => (m.message || '').slice(0, 50)));

  const fresh = newMems.filter(m => {
    const id  = m.payload?.mysql_id;
    const msg = (m.message || '').slice(0, 50);
    if (id && seenIds.has(id)) return false;
    if (seenMsgs.has(msg))     return false;
    return true;
  }).map(m => ({ ...m, score: (m.score || 0.5) * decay }));

  return [...existing, ...fresh];
}

/**
 * Prune memories below MIN_CASCADE_SCORE and rank by score desc.
 * Cap at MAX_CASCADE_RESULTS total.
 */
function _pruneAndRank(memories) {
  return memories
    .filter(m => (m.score || 0) >= MIN_CASCADE_SCORE)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, MAX_CASCADE_RESULTS);
}

// ── Time formatting (shared with memory.js) ───────────────────────────────────
function _relativeTime(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7)   return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 4)  return `${weeks}w ago`;
  return date.toLocaleDateString();
}
