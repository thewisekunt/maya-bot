/**
 * embedder.js — Text embedding via OpenAI API
 *
 * Converts text into dense vectors for semantic similarity search.
 * Uses OpenAI's embedding endpoint (same key as OpenRouter won't work —
 * embeddings need a real OpenAI key OR use OpenRouter's embedding proxy).
 *
 * We use OpenRouter's embedding proxy so only one API key is needed:
 *   https://openrouter.ai/docs#embeddings
 */

import axios from 'axios';
import { config } from './config.js';

const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
const EMBED_DIM   = parseInt(process.env.EMBED_DIM || '1536');

// Cache embeddings in memory to avoid re-embedding the same query
// in the same request cycle (LRU-style, cap at 100 entries)
const _cache = new Map();
const CACHE_MAX = 100;

/**
 * Embed a single string. Returns a Float32Array (dense vector).
 */
export async function embed(text) {
  const key = text.slice(0, 200);
  if (_cache.has(key)) return _cache.get(key);

  const clean = text.trim().replace(/\s+/g, ' ').slice(0, 8000);
  if (!clean) throw new Error('embed: empty text');

  const { data, status } = await axios.post(
    'https://openrouter.ai/api/v1/embeddings',
    { model: EMBED_MODEL, input: clean },
    {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${config.llm.apiKey}`,
        'HTTP-Referer':  'https://chatmasala.fun',
        'X-Title':       'MayaDiscordBot',
      },
      timeout: 15_000,
      validateStatus: () => true,
    }
  );

  if (status !== 200) {
    throw new Error(`embed HTTP ${status}: ${JSON.stringify(data).slice(0, 200)}`);
  }

  const vector = data?.data?.[0]?.embedding;
  if (!vector || !Array.isArray(vector)) {
    throw new Error(`embed: no vector in response: ${JSON.stringify(data).slice(0, 200)}`);
  }

  // Evict oldest if cache is full
  if (_cache.size >= CACHE_MAX) {
    _cache.delete(_cache.keys().next().value);
  }
  _cache.set(key, vector);
  return vector;
}

/**
 * Embed multiple texts in one batch request.
 * Returns array of vectors in the same order.
 */
export async function embedBatch(texts) {
  if (!texts.length) return [];

  const clean = texts.map(t => t.trim().replace(/\s+/g, ' ').slice(0, 8000));

  const { data, status } = await axios.post(
    'https://openrouter.ai/api/v1/embeddings',
    { model: EMBED_MODEL, input: clean },
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

  if (status !== 200) {
    throw new Error(`embedBatch HTTP ${status}: ${JSON.stringify(data).slice(0, 200)}`);
  }

  // Response has items in order matching input
  return data.data
    .sort((a, b) => a.index - b.index)
    .map(item => item.embedding);
}

export { EMBED_DIM };
