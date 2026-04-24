/**
 * centroid.js — User mental model centroid computation
 *
 * Maintains a per-user "felt sense" vector — the geometric center of all
 * memories for a user, weighted by recency and entropy.
 *
 * What this gives you:
 *   - Anomaly detection: "this message feels different from the Vecna I know"
 *   - Gap fill direction: search toward the centroid to find typical memories
 *   - Drift detection: centroid moving over time = the person is changing
 *
 * Storage: MySQL maya_user_models table (derived artifact, not a memory)
 * Update:  async after every memory store — non-blocking
 *
 * Weighting:
 *   - Recency: exponential decay — recent memories count more
 *   - Entropy: high entropy memories count more (meaningful moments)
 *   - Combined: weight = recency_weight * (1 + entropy_boost)
 *
 * Window: last 100 memories per user (sufficient after ~20 interactions)
 */

import db from './db.js';
import axios from 'axios';
import { config } from './config.js';

const QDRANT_URL     = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION     = process.env.QDRANT_COLLECTION || 'maya_memories';
const EMBED_DIM      = parseInt(process.env.EMBED_DIM || '1536');
const WINDOW_SIZE    = 100;    // max memories to pull per recompute
const DECAY_RATE     = 0.015;  // exponential decay per day — ~50 day half-life
const ENTROPY_BOOST  = 0.5;    // how much entropy amplifies weight (0.5 = up to 50% more)
const MIN_MEMORIES   = 5;      // don't compute centroid until we have enough data

const q = axios.create({
  baseURL: QDRANT_URL,
  headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
  timeout: 20_000,
  validateStatus: () => true,
});

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Recompute and store the centroid for a user after a new memory is stored.
 * Called async from vector.js — non-blocking, errors are swallowed.
 *
 * @param {string} userId
 * @param {string} guildId
 */
export async function updateCentroid(userId, guildId) {
  if (!QDRANT_URL || !QDRANT_API_KEY) return;
  if (!userId || userId === 'maya') return;  // no centroid for Maya's own memories

  try {
    // Fetch last WINDOW_SIZE memory points for this user with vectors
    const points = await _fetchUserVectors(userId, guildId);
    if (points.length < MIN_MEMORIES) return;  // not enough data yet

    // Compute weighted centroid
    const centroid = _weightedCentroid(points);
    if (!centroid) return;

    // Compute anomaly threshold — std deviation of distances from centroid
    const distances  = points.map(p => _cosineDistance(centroid, p.vector));
    const meanDist   = distances.reduce((a, b) => a + b, 0) / distances.length;
    const variance   = distances.reduce((a, d) => a + (d - meanDist) ** 2, 0) / distances.length;
    const stdDev     = Math.sqrt(variance);
    // Anomaly threshold: mean + 1.5 standard deviations
    const threshold  = Math.min(0.85, meanDist + (stdDev * 1.5));

    // Persist to MySQL
    await _saveCentroid(userId, guildId, centroid, points.length, threshold);

  } catch (e) {
    // Non-fatal — centroid update failure never breaks the main flow
    if (!e.message?.includes('connect')) {
      console.warn('[centroid] update failed for', userId, ':', e.message);
    }
  }
}

/**
 * Read centroid + anomaly threshold for a user.
 * Returns null if not enough data yet.
 *
 * @param {string} userId
 * @param {string} guildId
 * @returns {{ centroid: number[], threshold: number, sampleSize: number } | null}
 */
export async function getCentroid(userId, guildId) {
  try {
    const [rows] = await db.execute(
      `SELECT centroid_vector, anomaly_threshold, centroid_sample_size
       FROM maya_user_models WHERE user_id = ? AND guild_id = ?`,
      [userId, guildId || 'dm']
    );
    if (!rows.length || !rows[0].centroid_vector) return null;

    const centroid = JSON.parse(rows[0].centroid_vector);
    return {
      centroid:   centroid,
      threshold:  parseFloat(rows[0].anomaly_threshold) || 0.6,
      sampleSize: parseInt(rows[0].centroid_sample_size) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Check if a given query vector is anomalous for this user.
 * Returns { isAnomaly, distance, threshold } or null if no centroid yet.
 *
 * @param {string}   userId
 * @param {string}   guildId
 * @param {number[]} queryVector  — embedding of the current message
 */
export async function checkAnomaly(userId, guildId, queryVector) {
  const model = await getCentroid(userId, guildId);
  if (!model || model.sampleSize < MIN_MEMORIES) return null;

  const distance  = _cosineDistance(model.centroid, queryVector);
  const isAnomaly = distance > model.threshold;

  return { isAnomaly, distance: Math.round(distance * 100) / 100, threshold: model.threshold };
}

/**
 * Get centroid vector for gap-fill search.
 * Used by memory_reconstruction.js to find "typical" memories for a user.
 */
export async function getCentroidVector(userId, guildId) {
  const model = await getCentroid(userId, guildId);
  return model?.centroid || null;
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function _fetchUserVectors(userId, guildId) {
  const filter = {
    must: [
      { key: 'discord_user_id', match: { value: userId } },
      { key: 'sender',          match: { value: 'user' } },  // user messages only
    ],
  };

  if (guildId) {
    filter.must.push({ key: 'guild_id', match: { value: guildId } });
  }

  const res = await q.post(`/collections/${COLLECTION}/points/scroll`, {
    filter,
    limit:        WINDOW_SIZE,
    with_payload: true,
    with_vector:  true,
    order_by:     { key: 'created_at', direction: 'desc' },
  });

  if (res.status !== 200) return [];
  return (res.data?.result?.points || []).filter(p => p.vector?.length === EMBED_DIM);
}

function _weightedCentroid(points) {
  if (!points.length) return null;

  const now = Date.now();
  const centroid = new Array(EMBED_DIM).fill(0);
  let totalWeight = 0;

  for (const point of points) {
    // Recency weight — exponential decay from created_at
    const createdAt  = new Date(point.payload?.created_at || now).getTime();
    const daysOld    = Math.max(0, (now - createdAt) / (1000 * 60 * 60 * 24));
    const recencyW   = Math.exp(-DECAY_RATE * daysOld);

    // Entropy weight — high entropy memories are more meaningful
    const entropy    = parseFloat(point.payload?.entropy || 0.3);
    const entropyW   = 1 + (entropy * ENTROPY_BOOST);

    const weight = recencyW * entropyW;
    totalWeight += weight;

    // Accumulate weighted vector
    for (let i = 0; i < EMBED_DIM; i++) {
      centroid[i] += (point.vector[i] || 0) * weight;
    }
  }

  if (totalWeight === 0) return null;

  // Normalize by total weight
  for (let i = 0; i < EMBED_DIM; i++) {
    centroid[i] /= totalWeight;
  }

  // L2-normalize to unit sphere (so cosine distance works correctly)
  const norm = Math.sqrt(centroid.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return null;
  return centroid.map(x => x / norm);
}

function _cosineDistance(a, b) {
  // 1 - cosine_similarity (0 = identical, 2 = opposite)
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 1;
  return 1 - (dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

async function _saveCentroid(userId, guildId, centroid, sampleSize, threshold) {
  const vectorJson = JSON.stringify(centroid);
  await db.execute(
    `INSERT INTO maya_user_models
       (user_id, guild_id, centroid_vector, centroid_sample_size, anomaly_threshold,
        last_centroid_update, interaction_count)
     VALUES (?, ?, ?, ?, ?, NOW(), 1)
     ON DUPLICATE KEY UPDATE
       centroid_vector       = VALUES(centroid_vector),
       centroid_sample_size  = VALUES(centroid_sample_size),
       anomaly_threshold     = VALUES(anomaly_threshold),
       last_centroid_update  = NOW(),
       interaction_count     = interaction_count + 1`,
    [userId, guildId || 'dm', vectorJson, sampleSize, threshold]
  );
}
