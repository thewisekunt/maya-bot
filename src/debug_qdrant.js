/**
 * debug_qdrant.js — Run this directly: node debug_qdrant.js
 * Tests every step of the vector recall pipeline.
 */

import 'dotenv/config';
import axios from 'axios';

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION = process.env.QDRANT_COLLECTION || 'maya_memories';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';

const q = axios.create({
  baseURL: QDRANT_URL,
  headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
  timeout: 15000,
  validateStatus: () => true,
});

async function run() {
  console.log('\n=== QDRANT DEBUG ===\n');
  console.log('QDRANT_URL:', QDRANT_URL);
  console.log('COLLECTION:', COLLECTION);
  console.log('EMBED_MODEL:', EMBED_MODEL);

  // Step 1: Collection info
  console.log('\n--- Step 1: Collection info ---');
  const info = await q.get(`/collections/${COLLECTION}`);
  console.log('Status:', info.status);
  if (info.status === 200) {
    const c = info.data.result;
    console.log('Points count:', c.points_count);
    console.log('Indexed:', c.indexed_vectors_count);
    console.log('Status:', c.status);
  } else {
    console.log('ERROR:', JSON.stringify(info.data));
    process.exit(1);
  }

  // Step 2: Scroll to see what memory_types actually exist
  console.log('\n--- Step 2: Sample 5 points to see payload structure ---');
  const scroll = await q.post(`/collections/${COLLECTION}/points/scroll`, {
    limit: 5,
    with_payload: true,
    with_vector: false,
  });
  console.log('Scroll status:', scroll.status);
  if (scroll.status === 200) {
    scroll.data.result.points.forEach((p, i) => {
      console.log(`\nPoint ${i+1}:`);
      console.log('  id:', p.id);
      console.log('  memory_type:', p.payload?.memory_type);
      console.log('  discord_user_id:', p.payload?.discord_user_id);
      console.log('  guild_id:', p.payload?.guild_id);
      console.log('  sender:', p.payload?.sender);
      console.log('  message (preview):', (p.payload?.message || '').slice(0, 80));
    });
  }

  // Step 3: Count by memory_type
  console.log('\n--- Step 3: Count by memory_type ---');
  for (const mt of ['raw_message', 'conversation', 'user_fact', 'maya_self']) {
    const r = await q.post(`/collections/${COLLECTION}/points/count`, {
      filter: { must: [{ key: 'memory_type', match: { value: mt } }] },
      exact: true,
    });
    const count = r.data?.result?.count ?? 'ERROR';
    console.log(`  ${mt}: ${count} points`);
  }

  // Step 4: Check if payload index exists for memory_type
  console.log('\n--- Step 4: Check payload indexes ---');
  const info2 = await q.get(`/collections/${COLLECTION}`);
  const indexes = info2.data?.result?.payload_schema || {};
  console.log('Indexed fields:', Object.keys(indexes));
  if (!indexes.memory_type) {
    console.log('⚠️  memory_type is NOT indexed — creating index now...');
    const idx = await q.put(`/collections/${COLLECTION}/index`, {
      field_name: 'memory_type',
      field_schema: 'keyword',
    });
    console.log('Index creation:', idx.status, JSON.stringify(idx.data));
  }

  // Step 5: Test embedding
  console.log('\n--- Step 5: Test embedding ---');
  const embedRes = await axios.post(
    'https://openrouter.ai/api/v1/embeddings',
    { model: EMBED_MODEL, input: 'hello what is up' },
    { headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 10000, validateStatus: () => true }
  );
  console.log('Embed status:', embedRes.status);
  if (embedRes.status === 200) {
    const vec = embedRes.data?.data?.[0]?.embedding;
    console.log('Vector dim:', vec?.length);
    console.log('Vector sample:', vec?.slice(0, 3));

    // Step 6: Raw search with no filter — just find nearest neighbors
    console.log('\n--- Step 6: Raw search with no filter ---');
    const rawSearch = await q.post(`/collections/${COLLECTION}/points/search`, {
      vector: vec,
      limit: 3,
      score_threshold: 0.0,
      with_payload: true,
      with_vector: false,
    });
    console.log('Raw search status:', rawSearch.status);
    if (rawSearch.status === 200) {
      const results = rawSearch.data?.result || [];
      console.log(`Results: ${results.length}`);
      results.forEach((r, i) => {
        console.log(`  [${i+1}] score=${r.score.toFixed(4)} type=${r.payload?.memory_type} msg=${(r.payload?.message||'').slice(0,60)}`);
      });
    } else {
      console.log('Search error:', JSON.stringify(rawSearch.data));
    }

    // Step 7: Search with raw_message filter and user id from first point
    console.log('\n--- Step 7: Filtered search (raw_message type) ---');
    const filteredSearch = await q.post(`/collections/${COLLECTION}/points/search`, {
      vector: vec,
      limit: 3,
      score_threshold: 0.5,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [{ key: 'memory_type', match: { value: 'raw_message' } }]
      }
    });
    console.log('Filtered search status:', filteredSearch.status);
    const fResults = filteredSearch.data?.result || [];
    console.log(`Results: ${fResults.length}`);
    fResults.forEach((r, i) => {
      console.log(`  [${i+1}] score=${r.score.toFixed(4)} user=${r.payload?.discord_user_id} msg=${(r.payload?.message||'').slice(0,60)}`);
    });

    // Step 8: Test the OR filter we're actually using
    console.log('\n--- Step 8: Test OR filter (should/must structure) ---');
    const orSearch = await q.post(`/collections/${COLLECTION}/points/search`, {
      vector: vec,
      limit: 3,
      score_threshold: 0.5,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [
          { should: [
            { key: 'memory_type', match: { value: 'conversation' } },
            { key: 'memory_type', match: { value: 'raw_message' } }
          ]}
        ]
      }
    });
    console.log('OR filter status:', orSearch.status);
    console.log('OR filter response:', JSON.stringify(orSearch.data).slice(0, 300));

  } else {
    console.log('Embed error:', JSON.stringify(embedRes.data).slice(0, 300));
  }

  console.log('\n=== DONE ===\n');
}

run().catch(e => console.error('FATAL:', e.message, e.stack));
