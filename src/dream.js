/**
 * dream.js — Background memory consolidation process
 *
 * "Dreaming" = taking raw recent memories, embedding them into vectors,
 * and consolidating related ones into higher-weight summary memories.
 *
 * Triggers (whichever hits first):
 *   - Time: every DREAM_INTERVAL_MINUTES minutes
 *   - Volume: every DREAM_MESSAGE_THRESHOLD unembedded messages
 *
 * What it does each cycle:
 *   1. Fetch all unembedded messages from MySQL (embedded=0)
 *   2. Embed them in batches via embedder.js
 *   3. Upsert into Qdrant
 *   4. Mark as embedded in MySQL (embedded=1, vector_id=pointId)
 *   5. Consolidate: if 3+ memories from same user are semantically
 *      close (cosine > 0.88), collapse into a single dream summary
 *      with higher weight — so Maya "remembers" the gist, not
 *      each individual message
 *
 * Consolidation example:
 *   "I love cats" + "my cat is named Mochi" + "adopted a cat last year"
 *   → dream: "User loves cats, has a cat named Mochi, adopted last year"
 *   weight: 2.0 (surfaced more strongly in recall)
 */

import db from './db.js';
import { embed, embedBatch } from './embedder.js';
import { upsertMemory, upsertBatch, searchMemories,
         buildFilter, isConfigured } from './vector.js';
import { getMayaReply } from './llm.js';

const DREAM_INTERVAL_MS  = parseInt(process.env.DREAM_INTERVAL_MINUTES || '30') * 60 * 1000;
const MSG_THRESHOLD      = parseInt(process.env.DREAM_MESSAGE_THRESHOLD || '50');
const BATCH_SIZE         = 20;     // embed this many per cycle
const CONSOLIDATE_THRESH = 0.88;   // cosine similarity to merge memories
const MIN_CLUSTER_SIZE   = 3;      // min memories needed to consolidate

let _timer       = null;
let _msgCount    = 0;
let _running     = false;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the dream loop. Call once at bot startup.
 */
export function startDreamLoop() {
  if (!isConfigured()) {
    console.log('[dream] Qdrant not configured — dream loop disabled');
    return;
  }

  console.log(`[dream] loop started (interval=${DREAM_INTERVAL_MS/60000}min, threshold=${MSG_THRESHOLD} msgs)`);
  _timer = setInterval(() => runDream('timer'), DREAM_INTERVAL_MS);
}

/**
 * Increment message counter. When threshold hit, trigger a dream.
 * Call this after every saved message.
 */
export function notifyNewMessage() {
  if (!isConfigured()) return;
  _msgCount++;
  if (_msgCount >= MSG_THRESHOLD) {
    _msgCount = 0;
    runDream('threshold').catch(e => console.error('[dream] threshold trigger error:', e.message));
  }
}

/**
 * Run one dream cycle. Safe to call concurrently — skips if already running.
 */
export async function runDream(trigger = 'manual') {
  if (_running) {
    console.log(`[dream] already running, skipping (triggered by ${trigger})`);
    return;
  }
  _running = true;
  const start = Date.now();
  console.log(`[dream] cycle started (trigger=${trigger})`);

  try {
    // ── Phase 1: Embed unprocessed memories ────────────────────────────────
    const embedded = await _embedPendingMemories();
    console.log(`[dream] embedded ${embedded} new memories`);

    // ── Phase 2: Consolidate close memories into dream summaries ───────────
    if (embedded > 0) {
      const consolidated = await _consolidateMemories();
      console.log(`[dream] consolidated ${consolidated} memory clusters`);
    }

  } catch (e) {
    console.error('[dream] cycle error:', e.message);
  } finally {
    _running = false;
    console.log(`[dream] cycle done in ${Date.now() - start}ms`);
  }
}

// ── Phase 1: Embed pending ────────────────────────────────────────────────────

async function _embedPendingMemories() {
  // Fetch unembedded messages — limit one batch per cycle
  let rows;
  try {
    [rows] = await db.execute(
      `SELECT id, discord_user_id, user_name, guild_id, channel_id,
              context_type, is_private, sender, message, entropy, embed_weight
       FROM maya_memory
       WHERE embedded = 0
       ORDER BY created_at ASC
       LIMIT ?`,
      [BATCH_SIZE]
    );
  } catch (e) {
    // Fallback: old schema without embedded column
    try {
      [rows] = await db.execute(
        `SELECT id, discord_user_id, user_name, guild_id,
                sender, message, entropy
         FROM maya_memory
         ORDER BY id DESC
         LIMIT ?`,
        [BATCH_SIZE]
      );
      // Can't track embedded state — just process and move on
    } catch { return 0; }
  }

  if (!rows || !rows.length) return 0;

  // Build text to embed for each row
  // Format: "sender_name: message_text" — gives the embedding context about who said it
  const texts = rows.map(r => {
    const who = r.sender === 'maya' ? 'Maya' : (r.user_name || 'User');
    return `${who}: ${r.message}`;
  });

  // Embed in batch
  let vectors;
  try {
    vectors = await embedBatch(texts);
  } catch (e) {
    console.error('[dream] embedBatch failed:', e.message);
    return 0;
  }

  // Build Qdrant points
  const points = rows.map((r, i) => ({
    id:      `mem_${r.id}`,
    vector:  vectors[i],
    payload: {
      mysql_id:        r.id,
      discord_user_id: r.discord_user_id,
      user_name:       r.user_name || '',
      guild_id:        r.guild_id  || null,
      context_type:    r.context_type || 'server',
      is_private:      !!(r.is_private),
      sender:          r.sender,
      message:         r.message,
      entropy:         parseFloat(r.entropy) || 0.4,
      weight:          parseFloat(r.embed_weight) || 1.0,
      is_dream:        false,
      created_at:      new Date().toISOString(),
    },
  }));

  try {
    await upsertBatch(points);
  } catch (e) {
    console.error('[dream] upsertBatch failed:', e.message);
    return 0;
  }

  // Mark as embedded in MySQL
  const ids = rows.map(r => r.id);
  const ph  = ids.map(() => '?').join(',');
  try {
    await db.execute(
      `UPDATE maya_memory SET embedded = 1 WHERE id IN (${ph})`,
      ids
    );
  } catch { /* non-fatal — will retry next cycle */ }

  return rows.length;
}

// ── Phase 2: Consolidate close memories ──────────────────────────────────────

async function _consolidateMemories() {
  // Get distinct users who had messages embedded recently
  let userRows;
  try {
    [userRows] = await db.execute(
      `SELECT DISTINCT discord_user_id, user_name
       FROM maya_memory
       WHERE embedded = 1
         AND created_at > DATE_SUB(NOW(), INTERVAL 2 HOUR)
       LIMIT 20`
    );
  } catch { return 0; }

  let consolidated = 0;

  for (const u of userRows) {
    try {
      consolidated += await _consolidateForUser(u.discord_user_id, u.user_name);
    } catch (e) {
      console.error(`[dream] consolidate error for ${u.discord_user_id}:`, e.message);
    }
  }

  return consolidated;
}

async function _consolidateForUser(userId, userName) {
  // Get recent non-dream memories for this user
  // We use a centroid approach: embed a summary query,
  // find close memories, summarise with LLM
  const summaryQuery = `What has ${userName} talked about recently?`;
  let queryVec;
  try {
    queryVec = await embed(summaryQuery);
  } catch { return 0; }

  const filter  = buildFilter({ userId, contextType: 'server', isDM: false });
  // Only non-dream memories so we don't re-consolidate
  filter.must.push({ key: 'is_dream', match: { value: false } });

  let candidates;
  try {
    candidates = await searchMemories(queryVec, filter, 20, CONSOLIDATE_THRESH);
  } catch { return 0; }

  // Filter to user messages only (not Maya's replies) for consolidation
  const userMsgs = candidates.filter(c => c.sender === 'user' && c.message.length > 10);
  if (userMsgs.length < MIN_CLUSTER_SIZE) return 0;

  // Generate a dream summary using LLM
  const memBlock = userMsgs
    .slice(0, 10)
    .map(m => `- ${m.message}`)
    .join('\n');

  let summary;
  try {
    const result = await getMayaReply({
      prefName:        userName,
      context:         '',
      message:         `Summarise what you know about ${userName} from these messages in 2-3 sentences. Be factual, no fluff:\n${memBlock}`,
      entropy:         0.3,
      zone:            'Restful',
      zoneLine:        '',
      contextLine:     '',
      knownFacts:      [],
      relationship:    null,
      frequentFriends: [],
      forceVerbal:     true,
      systemOverride:  'You are a memory consolidation system. Produce a concise factual summary of what a user has shared. No opinions, no character voice. Just facts.',
    });
    summary = result.text;
  } catch { return 0; }

  if (!summary || summary.length < 10) return 0;

  // Embed the dream summary
  let dreamVec;
  try {
    dreamVec = await embed(`${userName} memory summary: ${summary}`);
  } catch { return 0; }

  // Upsert as a dream point with higher weight
  const dreamId = `dream_${userId}_${Date.now()}`;
  try {
    await upsertMemory(dreamId, dreamVec, {
      mysql_id:        null,
      discord_user_id: userId,
      user_name:       userName,
      guild_id:        null,
      context_type:    'server',
      is_private:      false,
      sender:          'system',
      message:         `[Dream summary] ${summary}`,
      entropy:         0.4,
      weight:          2.0,    // surfaces higher in recall
      is_dream:        true,
      created_at:      new Date().toISOString(),
    });
    console.log(`[dream] created dream for ${userName}: ${summary.slice(0, 80)}`);
    return 1;
  } catch { return 0; }
}
