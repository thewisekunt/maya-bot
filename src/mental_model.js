/**
 * mental_model.js — Per-user structured mental model
 *
 * The explicit half of Option C. Stores what Maya consciously understands
 * about each person — traits, patterns, relational arc, emotional signature.
 *
 * Unlike facts (raw data) and centroid (felt sense), this is a
 * *generative compression* — a model that can fill gaps, predict behavior,
 * and interpret ambiguous signals.
 *
 * Updated by: dream cycle (refreshModel) — not in real time
 * Read by:    memory_reconstruction.js — injected into every LLM context
 *
 * The model has two functions:
 *   getModel(userId, guildId)      — read current model for prompt injection
 *   refreshModel(userId, guildId)  — LLM pass to rewrite from recent memories
 */

import db from './db.js';
import axios from 'axios';
import { config } from './config.js';

const REFRESH_AFTER_N      = 10;   // refresh model after N new interactions
const REFRESH_IF_DAYS_OLD  = 7;    // always refresh if model is this old
const MAX_MEMORIES_FOR_LLM = 30;   // memories fed to LLM during refresh

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get the current mental model for a user.
 * Returns a formatted string ready for prompt injection, or null if no model yet.
 *
 * @param {string} userId
 * @param {string} guildId
 * @returns {string | null}
 */
export async function getModel(userId, guildId) {
  try {
    const [rows] = await db.execute(
      `SELECT trait_summary, behavioral_signatures, relational_arc,
              emotional_signature, last_trait_update, interaction_count
       FROM maya_user_models
       WHERE user_id = ? AND guild_id = ?`,
      [userId, guildId || 'dm']
    );

    if (!rows.length) return null;
    const row = rows[0];

    // No model built yet
    if (!row.trait_summary && !row.relational_arc) return null;

    const parts = [];

    if (row.trait_summary) {
      parts.push(`Personality: ${row.trait_summary}`);
    }

    if (row.relational_arc) {
      parts.push(`Relationship: ${row.relational_arc}`);
    }

    if (row.behavioral_signatures) {
      try {
        const sigs = JSON.parse(row.behavioral_signatures);
        if (Array.isArray(sigs) && sigs.length) {
          parts.push(`Patterns: ${sigs.slice(0, 4).join(' | ')}`);
        }
      } catch { /* malformed JSON — skip */ }
    }

    if (row.emotional_signature) {
      try {
        const emo = JSON.parse(row.emotional_signature);
        if (emo.dominant) {
          const valenceDesc = emo.avg_valence > 0.3 ? 'positive'
            : emo.avg_valence < -0.3 ? 'tense' : 'mixed';
          parts.push(`Emotional tone: usually ${emo.dominant}, interactions feel ${valenceDesc}`);
        }
      } catch { /* skip */ }
    }

    if (!parts.length) return null;
    return `[Mental model — ${userId.slice(-4)}]\n${parts.join('\n')}`;

  } catch (e) {
    console.warn('[mental_model] getModel failed:', e.message);
    return null;
  }
}

/**
 * Refresh the mental model for a user using recent memories.
 * Called by the dream cycle after N new interactions.
 * LLM pass — generates trait_summary, behavioral_signatures, relational_arc.
 *
 * @param {string} userId
 * @param {string} guildId
 * @param {string} userName   — display name for context
 * @returns {boolean}         — true if model was updated
 */
export async function refreshModel(userId, guildId, userName = 'this person') {
  try {
    // Check if refresh is needed
    const needsRefresh = await _needsRefresh(userId, guildId);
    if (!needsRefresh) return false;

    console.log(`[mental_model] refreshing model for ${userName} (${userId})`);

    // Gather recent memories from MySQL
    const memories = await _fetchRecentMemories(userId, guildId);
    if (memories.length < 5) {
      console.log(`[mental_model] not enough memories for ${userName} — skipping`);
      return false;
    }

    // Get existing model for continuity
    const [existing] = await db.execute(
      `SELECT trait_summary, behavioral_signatures, relational_arc, emotional_signature
       FROM maya_user_models WHERE user_id = ? AND guild_id = ?`,
      [userId, guildId || 'dm']
    );
    const prev = existing[0] || {};

    // Build LLM prompt
    const memoryText = memories
      .map(m => `[${m.sender === 'maya' ? 'Maya' : userName}] ${m.message}`)
      .join('\n');

    const prevModel = prev.trait_summary
      ? `Previous model:\nTraits: ${prev.trait_summary}\nArc: ${prev.relational_arc || 'unknown'}`
      : 'No previous model — build from scratch.';

    const prompt = `You are analyzing Maya's memories about ${userName} to build a mental model.

${prevModel}

Recent memories (newest first):
${memoryText}

Generate a JSON object with exactly these fields:
{
  "trait_summary": "2-3 sentences describing their stable personality. Be specific, not generic. Focus on how they communicate, what they avoid, what they're drawn to.",
  "behavioral_signatures": ["specific observable pattern 1", "specific observable pattern 2", "specific observable pattern 3"],
  "relational_arc": "one sentence: where does the relationship currently stand, how has it evolved",
  "emotional_signature": {
    "dominant": "one word — the most common emotional tone in interactions",
    "secondary": "one word — second most common",
    "avg_valence": 0.0
  }
}

Rules:
- behavioral_signatures must be specific behaviors Maya has actually observed, not adjectives
- avg_valence: -1.0 (very negative) to +1.0 (very positive)
- If unsure, use neutral defaults rather than fabricating
- Return ONLY the JSON object, no explanation`;

    const response = await _callLLM(prompt);
    if (!response) return false;

    // Parse response
    let model;
    try {
      const clean = response.replace(/```json|```/g, '').trim();
      model = JSON.parse(clean);
    } catch (e) {
      console.warn('[mental_model] JSON parse failed:', e.message);
      return false;
    }

    // Validate
    if (!model.trait_summary) return false;

    // Compute emotional signature stats from recent memories
    const emoStats = _computeEmoStats(memories);
    const finalEmo = {
      dominant:    model.emotional_signature?.dominant    || emoStats.dominant,
      secondary:   model.emotional_signature?.secondary   || emoStats.secondary,
      avg_valence: model.emotional_signature?.avg_valence ?? emoStats.avgValence,
    };

    // Persist to DB
    await db.execute(
      `INSERT INTO maya_user_models
         (user_id, guild_id, trait_summary, behavioral_signatures,
          relational_arc, emotional_signature, last_trait_update, interaction_count)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE
         trait_summary         = VALUES(trait_summary),
         behavioral_signatures = VALUES(behavioral_signatures),
         relational_arc        = VALUES(relational_arc),
         emotional_signature   = VALUES(emotional_signature),
         last_trait_update     = NOW()`,
      [
        userId,
        guildId || 'dm',
        model.trait_summary,
        JSON.stringify(model.behavioral_signatures || []),
        model.relational_arc || null,
        JSON.stringify(finalEmo),
        memories.length,
      ]
    );

    console.log(`[mental_model] model refreshed for ${userName}`);
    return true;

  } catch (e) {
    console.warn('[mental_model] refreshModel failed:', e.message);
    return false;
  }
}

/**
 * Get list of users whose models need refreshing.
 * Called by dream cycle to batch-process active users.
 *
 * @param {string} guildId
 * @returns {{ userId, guildId, userName, interactionCount }[]}
 */
export async function getUsersNeedingRefresh(guildId) {
  try {
    const [rows] = await db.execute(
      `SELECT m.user_id, m.guild_id, r.display_name as user_name,
              m.interaction_count,
              DATEDIFF(NOW(), COALESCE(m.last_trait_update, '2000-01-01')) as days_since_refresh
       FROM maya_user_models m
       LEFT JOIN maya_user_relationships r ON r.discord_user_id = m.user_id
       WHERE m.guild_id = ?
         AND (m.interaction_count >= ? OR m.last_trait_update IS NULL
              OR DATEDIFF(NOW(), m.last_trait_update) >= ?)
       ORDER BY m.interaction_count DESC
       LIMIT 5`,
      [guildId || 'dm', REFRESH_AFTER_N, REFRESH_IF_DAYS_OLD]
    );
    return rows;
  } catch {
    return [];
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function _needsRefresh(userId, guildId) {
  const [rows] = await db.execute(
    `SELECT interaction_count,
            DATEDIFF(NOW(), COALESCE(last_trait_update, '2000-01-01')) as days_old
     FROM maya_user_models WHERE user_id = ? AND guild_id = ?`,
    [userId, guildId || 'dm']
  ).catch(() => [[]]);

  if (!rows.length) return true;  // no model yet — build one
  const { interaction_count, days_old } = rows[0];
  return interaction_count >= REFRESH_AFTER_N || days_old >= REFRESH_IF_DAYS_OLD;
}

async function _fetchRecentMemories(userId, guildId) {
  const [rows] = await db.execute(
    `SELECT sender, message, created_at
     FROM maya_memory
     WHERE discord_user_id = ?
       AND (guild_id = ? OR guild_id IS NULL)
       AND message IS NOT NULL
       AND LENGTH(message) > 10
     ORDER BY created_at DESC
     LIMIT ?`,
    [userId, guildId || null, MAX_MEMORIES_FOR_LLM]
  ).catch(() => [[]]);
  return rows;
}

function _computeEmoStats(memories) {
  // Simple valence heuristic from memory content
  // (enrich.js does this per-memory; here we aggregate)
  const valences = memories.map(m => {
    const text = (m.message || '').toLowerCase();
    const pos = (text.match(/good|happy|love|nice|fun|great|lol|haha/g) || []).length;
    const neg = (text.match(/sad|angry|bad|hate|upset|hurt|ugh|wtf/g) || []).length;
    return pos > neg ? 0.5 : neg > pos ? -0.5 : 0;
  });

  const avgValence = valences.reduce((a, b) => a + b, 0) / (valences.length || 1);

  return {
    dominant:   avgValence > 0.2 ? 'warm' : avgValence < -0.2 ? 'tense' : 'neutral',
    secondary:  'variable',
    avgValence: Math.round(avgValence * 100) / 100,
  };
}

async function _callLLM(prompt) {
  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model:       'nousresearch/hermes-3-llama-3.1-70b',  // facts model — good at JSON
        max_tokens:  600,
        temperature: 0.3,
        messages:    [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.llm.apiKey}`,
          'HTTP-Referer':  'https://chatmasala.fun',
          'X-Title':       'MayaDiscordBot',
        },
        timeout: 30_000,
        validateStatus: () => true,
      }
    );

    if (res.status !== 200) {
      console.warn('[mental_model] LLM failed:', res.status);
      return null;
    }

    return res.data?.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.warn('[mental_model] LLM call failed:', e.message);
    return null;
  }
}
