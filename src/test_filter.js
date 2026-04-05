import 'dotenv/config';
import axios from 'axios';

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION = process.env.QDRANT_COLLECTION || 'maya-memories';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';

const q = axios.create({
  baseURL: QDRANT_URL,
  headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
  timeout: 15000,
  validateStatus: () => true,
});

// Known guild from the payload
const TEST_GUILD = '1410172171996631053';
const TEST_USER  = '641522512261545996';

async function run() {
  // Get a real vector first
  const eRes = await axios.post('https://openrouter.ai/api/v1/embeddings',
    { model: EMBED_MODEL, input: 'what is going on' },
    { headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
      timeout: 10000, validateStatus: () => true }
  );
  const vec = eRes.data?.data?.[0]?.embedding;
  console.log('Vec dim:', vec?.length);

  // Test A: just guild_id filter
  console.log('\n--- A: guild_id only ---');
  const a = await q.post(`/collections/${COLLECTION}/points/search`, {
    vector: vec, limit: 3, score_threshold: 0.0, with_payload: true, with_vector: false,
    filter: { must: [{ key: 'guild_id', match: { value: TEST_GUILD } }] }
  });
  console.log('Status:', a.status, 'Results:', a.data?.result?.length);
  if (a.data?.result?.[0]) console.log('Sample:', a.data.result[0].payload?.message?.slice(0,60));

  // Test B: guild_id + memory_type
  console.log('\n--- B: guild_id + memory_type=raw_message ---');
  const b = await q.post(`/collections/${COLLECTION}/points/search`, {
    vector: vec, limit: 3, score_threshold: 0.0, with_payload: true, with_vector: false,
    filter: { must: [
      { key: 'guild_id',     match: { value: TEST_GUILD } },
      { key: 'memory_type',  match: { value: 'raw_message' } },
    ]}
  });
  console.log('Status:', b.status, 'Results:', b.data?.result?.length);
  if (b.data?.result?.[0]) console.log('Sample:', b.data.result[0].payload?.message?.slice(0,60));

  // Test C: the should-inside-must we're using for conv filter
  console.log('\n--- C: should inside must (our current filter) ---');
  const c = await q.post(`/collections/${COLLECTION}/points/search`, {
    vector: vec, limit: 3, score_threshold: 0.0, with_payload: true, with_vector: false,
    filter: { must: [
      { should: [
        { key: 'memory_type', match: { value: 'conversation' } },
        { key: 'memory_type', match: { value: 'raw_message' } },
      ]},
      { key: 'guild_id', match: { value: TEST_GUILD } },
    ]}
  });
  console.log('Status:', c.status, 'Results:', c.data?.result?.length);
  console.log('Raw:', JSON.stringify(c.data).slice(0,200));

  // Test D: flat must with just memory_type (no should nesting)
  console.log('\n--- D: flat must, memory_type=raw_message + guild ---');
  const d = await q.post(`/collections/${COLLECTION}/points/search`, {
    vector: vec, limit: 3, score_threshold: 0.5, with_payload: true, with_vector: false,
    filter: { must: [
      { key: 'memory_type', match: { value: 'raw_message' } },
      { key: 'guild_id',    match: { value: TEST_GUILD } },
    ]}
  });
  console.log('Status:', d.status, 'Results:', d.data?.result?.length);
  d.data?.result?.forEach((r,i) => console.log(`  [${i+1}] score=${r.score.toFixed(3)} msg=${r.payload?.message?.slice(0,60)}`));

  // Test E: user_fact filter with should nesting (our current userFact filter)
  console.log('\n--- E: user_fact filter with nested should ---');
  const e = await q.post(`/collections/${COLLECTION}/points/search`, {
    vector: vec, limit: 3, score_threshold: 0.0, with_payload: true, with_vector: false,
    filter: { must: [
      { should: [
        { key: 'memory_type', match: { value: 'user_fact' } },
        { key: 'memory_type', match: { value: 'raw_message' } },
      ]},
      { should: [
        { key: 'discord_user_id', match: { value: TEST_USER } },
        { key: 'discord_user_id', match: { value: 'maya' } },
      ]},
      { key: 'guild_id', match: { value: TEST_GUILD } },
    ]}
  });
  console.log('Status:', e.status, 'Results:', e.data?.result?.length);
  console.log('Raw:', JSON.stringify(e.data).slice(0,300));
}

run().catch(e => console.error('FATAL:', e.message));
