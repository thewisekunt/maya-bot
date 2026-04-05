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
    // Collection exists — verify ALL required indexes are present
    const schema = check.data?.result?.payload_schema || {};
    const required = [
      { field_name: 'memory_type',     field_schema: 'keyword' },
      { field_name: 'sender',          field_schema: 'keyword' },
      { field_name: 'discord_user_id', field_schema: 'keyword' },
      { field_name: 'guild_id',        field_schema: 'keyword' },
      { field_name: 'is_private',      field_schema: 'bool'    },
    ];
    const missing = required.filter(f => !schema[f.field_name]);
    if (missing.length > 0) {
      for (const idx of missing) {
        await q.put(`/collections/${COLLECTION}/index`, idx).catch(() => {});
      }
      console.log(`[vector] Collection "${COLLECTION}" ready ✓ (added indexes: ${missing.map(f => f.field_name).join(', ')})`);
    } else {
      console.log(`[vector] Collection "${COLLECTION}" ready ✓`);
    }
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
    await q.put(`/collections/${COLLECTION}/index`, {
      field_name: 'memory_type', field_schema: 'keyword',
    });
    await q.put(`/collections/${COLLECTION}/index`, {
      field_name: 'sender', field_schema: 'keyword',
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
    const msg = `searchMemories HTTP ${res.status}: ${JSON.stringify(res.data).slice(0,200)}`;
    console.error('[vector]', msg);
    throw new Error(msg);
  }

  return (res.data?.result || [])
    .map(r => ({
      message:  r.payload.message,
      sender:   r.payload.sender,
      userName: r.payload.user_name,
      isDream:  r.payload.is_dream || false,
      weight:   r.payload.weight   || 1.0,
      score:    r.score,
      // Effective score: similarity × weight — consolidated memories rank higher
      effectiveScore: r.score * (r.payload.weight || 1.0),
      payload:  r.payload,
    }))
    .sort((a, b) => b.effectiveScore - a.effectiveScore);  // re-rank by weighted score
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

// Convert any string ID to a valid UUID v4-format string.
// UUID format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx (8-4-4-4-12)
function _toUuid(id) {
  const str = String(id);
  // FNV-1a 32-bit hash — fast, deterministic
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
    h = h >>> 0;  // keep unsigned 32-bit
  }
  // Generate 4 independent hash values by chaining
  const h1 = h;
  const h2 = ((h * 1000003) ^ (str.length * 31)) >>> 0;
  const h3 = ((h2 * 1000003) ^ h1) >>> 0;
  const h4 = ((h3 * 1000003) ^ h2) >>> 0;
  const h5 = ((h4 * 1000003) ^ h3) >>> 0;

  // Format as proper UUID: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  const p1 = h1.toString(16).padStart(8, '0');                    // 8 chars
  const p2 = (h2 & 0xffff).toString(16).padStart(4, '0');         // 4 chars
  const p3 = '4' + (h3 & 0x0fff).toString(16).padStart(3, '0');  // 4 chars (version 4)
  const p4 = (0x8 | (h4 & 0x3)).toString(16)                      // variant bit
           + (h4 & 0x0fff).toString(16).padStart(3, '0');         // 4 chars total
  const h6 = ((h5 * 1000003) ^ h4) >>> 0;
  // p5 must be exactly 12 hex chars — two clean 32-bit values
  const p5 = (h5.toString(16).padStart(8, '0') + h6.toString(16).padStart(8, '0')).slice(0, 12);

  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}
