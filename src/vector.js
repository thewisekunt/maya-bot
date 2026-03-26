/**
 * vector.js — Qdrant client
 *
 * All Qdrant operations go through here. Pure REST, no SDK needed.
 *
 * Collection schema (one collection: maya_memories):
 * {
 *   id:      string (UUID — same as mysql memory id prefixed)
 *   vector:  float[] (1536-dim from text-embedding-3-small)
 *   payload: {
 *     mysql_id:     number,     — maya_memory.id for reverse lookup
 *     discord_user_id: string,
 *     user_name:    string,
 *     guild_id:     string|null,
 *     context_type: 'dm'|'server',
 *     is_private:   boolean,
 *     sender:       'user'|'maya',
 *     message:      string,
 *     entropy:      number,
 *     weight:       number,     — 1.0 base, higher for dream summaries
 *     is_dream:     boolean,    — true if this is a consolidated dream memory
 *     created_at:   string,     — ISO timestamp
 *   }
 * }
 */

import axios from 'axios';

const QDRANT_URL        = process.env.QDRANT_URL;
const QDRANT_API_KEY    = process.env.QDRANT_API_KEY;
const COLLECTION        = process.env.QDRANT_COLLECTION || 'maya_memories';
const EMBED_DIM         = parseInt(process.env.EMBED_DIM || '1536');

// Qdrant HTTP client
const q = axios.create({
  baseURL: QDRANT_URL,
  headers: {
    'Content-Type': 'application/json',
    'api-key':      QDRANT_API_KEY,
  },
  timeout: 20_000,
  validateStatus: () => true,
});

// ── Collection bootstrap ──────────────────────────────────────────────────────

/**
 * Ensure the collection exists. Call once at startup.
 */
export async function ensureCollection() {
  if (!QDRANT_URL || !QDRANT_API_KEY) {
    console.warn('[vector] Qdrant not configured — semantic memory disabled');
    return false;
  }

  // Check if collection exists
  const check = await q.get(`/collections/${COLLECTION}`);
  if (check.status === 200) {
    console.log(`[vector] Collection "${COLLECTION}" ready ✓`);
    return true;
  }

  // Create it
  const create = await q.put(`/collections/${COLLECTION}`, {
    vectors: {
      size:     EMBED_DIM,
      distance: 'Cosine',
    },
    optimizers_config: {
      default_segment_number: 2,
    },
    replication_factor: 1,
  });

  if (create.status === 200) {
    console.log(`[vector] Collection "${COLLECTION}" created ✓`);
    // Create payload indexes for fast filtering
    await q.put(`/collections/${COLLECTION}/index`, {
      field_name: 'discord_user_id',
      field_schema: 'keyword',
    });
    await q.put(`/collections/${COLLECTION}/index`, {
      field_name: 'context_type',
      field_schema: 'keyword',
    });
    await q.put(`/collections/${COLLECTION}/index`, {
      field_name: 'is_private',
      field_schema: 'bool',
    });
    await q.put(`/collections/${COLLECTION}/index`, {
      field_name: 'guild_id',
      field_schema: 'keyword',
    });
    return true;
  }

  console.error('[vector] Failed to create collection:', create.data);
  return false;
}

// ── Upsert ────────────────────────────────────────────────────────────────────

/**
 * Upsert a single memory point.
 * @param {string} pointId   — unique string ID (e.g. "mem_12345")
 * @param {number[]} vector  — embedding vector
 * @param {object} payload   — metadata
 */
export async function upsertMemory(pointId, vector, payload) {
  const res = await q.put(`/collections/${COLLECTION}/points`, {
    points: [{ id: _toUuid(pointId), vector, payload }],
  });
  if (res.status !== 200) {
    throw new Error(`upsertMemory HTTP ${res.status}: ${JSON.stringify(res.data).slice(0,200)}`);
  }
}

/**
 * Batch upsert — more efficient for dream process.
 */
export async function upsertBatch(points) {
  if (!points.length) return;
  const res = await q.put(`/collections/${COLLECTION}/points`, {
    points: points.map(p => ({
      id:      _toUuid(p.id),
      vector:  p.vector,
      payload: p.payload,
    })),
  });
  if (res.status !== 200) {
    throw new Error(`upsertBatch HTTP ${res.status}: ${JSON.stringify(res.data).slice(0,200)}`);
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Semantic search — find the most relevant memories for a given query vector.
 *
 * @param {number[]} queryVector  — embedded query
 * @param {object}   filter       — Qdrant filter object
 * @param {number}   limit        — max results
 * @param {number}   scoreThreshold — min cosine similarity (0–1)
 *
 * @returns {{ message, sender, score, payload }[]}
 */
export async function searchMemories(queryVector, filter = {}, limit = 8, scoreThreshold = 0.72) {
  const body = {
    vector:           queryVector,
    limit,
    score_threshold:  scoreThreshold,
    with_payload:     true,
    with_vector:      false,
  };

  if (Object.keys(filter).length > 0) {
    body.filter = filter;
  }

  const res = await q.post(`/collections/${COLLECTION}/points/search`, body);

  if (res.status !== 200) {
    throw new Error(`searchMemories HTTP ${res.status}: ${JSON.stringify(res.data).slice(0,200)}`);
  }

  return (res.data?.result || []).map(r => ({
    message:  r.payload.message,
    sender:   r.payload.sender,
    userName: r.payload.user_name,
    isDream:  r.payload.is_dream || false,
    weight:   r.payload.weight   || 1.0,
    score:    r.score,
    payload:  r.payload,
  }));
}

/**
 * Build a Qdrant filter for a specific user + context.
 * Private DM memories are never returned in server queries.
 */
export function buildFilter({ userId, contextType, guildId, isDM }) {
  const must = [
    { key: 'discord_user_id', match: { value: userId } },
  ];

  if (isDM) {
    // DM recall: only DM memories
    must.push({ key: 'context_type', match: { value: 'dm' } });
  } else {
    // Server recall: server memories only, never private DMs
    must.push({ key: 'context_type', match: { value: 'server' } });
    must.push({ key: 'is_private',   match: { value: false } });
    if (guildId) {
      must.push({ key: 'guild_id', match: { value: guildId } });
    }
  }

  return { must };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function isConfigured() {
  return !!(QDRANT_URL && QDRANT_API_KEY);
}

// Qdrant requires UUID-format IDs. We hash our string IDs into UUID v5 format.
function _toUuid(id) {
  // Simple deterministic UUID from string using fnv32 hash
  const str  = String(id);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  const hex = h.toString(16).padStart(8, '0');
  // Fill remaining UUID segments deterministically
  const h2 = (h * 1000003) >>> 0;
  const h3 = (h2 * 1000003) >>> 0;
  const h4 = (h3 * 1000003) >>> 0;
  return `${hex}-${h2.toString(16).padStart(4,'0')}-4${h3.toString(16).padStart(3,'0')}-8${h4.toString(16).padStart(3,'0')}-${str.length.toString(16).padStart(12,'0')}`;
}
