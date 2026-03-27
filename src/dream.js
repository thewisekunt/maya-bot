/**
 * dream.js — Session-based memory consolidation
 *
 * Triggered when a session closes (30 min idle after @mention).
 * Processes raw session messages into typed LTM entries:
 *
 *   user_fact    — things learned about specific users
 *                  ("Danish loves pizza", "Mario works in IT")
 *   conversation — what happened in this session
 *                  ("Group debated cricket, Mario and Sai disagreed")
 *   maya_self    — things Maya expressed about herself
 *                  ("Maya finds passive aggression tiring")
 *
 * Each type goes to Qdrant with memory_type in payload — never mixed in recall.
 *
 * LLM extracts structured JSON (no narrative voice) so facts are clean
 * and reusable across contexts.
 *
 * Also runs a time/volume triggered pass for raw message embedding.
 */

import db from './db.js';
import { embed, embedBatch } from './embedder.js';
import { upsertMemory, upsertBatch, isConfigured } from './vector.js';
import axios from 'axios';
import { config } from './config.js';

const DREAM_INTERVAL_MS = parseInt(process.env.DREAM_INTERVAL_MINUTES || '30') * 60 * 1000;
const MSG_THRESHOLD     = parseInt(process.env.DREAM_MESSAGE_THRESHOLD || '50');
const BATCH_SIZE        = 20;

let _timer    = null;
let _msgCount = 0;
let _running  = false;

// ── Public API ────────────────────────────────────────────────────────────────

export function startDreamLoop() {
  if (!isConfigured()) {
    console.log('[dream] Qdrant not configured — dream loop disabled');
    return;
  }
  _timer = setInterval(() => _runEmbedPass('timer'), DREAM_INTERVAL_MS);
  console.log(`[dream] loop started (interval=${DREAM_INTERVAL_MS/60000}min, threshold=${MSG_THRESHOLD})`);
}

export function notifyNewMessage() {
  if (!isConfigured()) return;
  _msgCount++;
  if (_msgCount >= MSG_THRESHOLD) {
    _msgCount = 0;
    _runEmbedPass('threshold').catch(e => console.error('[dream] embed pass error:', e.message));
  }
}

/**
 * Process a closed session into LTM.
 * Called by stm.js when a session closes.
 */
export async function processSession(sessionId) {
  if (!isConfigured()) return;
  console.log(`[dream] processing session ${sessionId}`);

  // Check it hasn't been processed already
  const [[sess]] = await db.execute(
    `SELECT s.*, s.participant_ids FROM maya_sessions s
     WHERE s.id=? AND s.processed=0 AND s.ended_at IS NOT NULL`,
    [sessionId]
  ).catch(() => [[]]);

  if (!sess) {
    console.log(`[dream] session ${sessionId} already processed or not ended`);
    return;
  }

  // Mark as processing immediately (prevent double-processing across instances)
  await db.execute(
    `UPDATE maya_sessions SET processed=1 WHERE id=? AND processed=0`,
    [sessionId]
  ).catch(() => {});

  // Fetch all messages from this session
  const [msgs] = await db.execute(
    `SELECT discord_user_id, user_name, sender, message
     FROM maya_session_messages
     WHERE session_id=?
     ORDER BY created_at ASC`,
    [sessionId]
  ).catch(() => [[]]);

  if (!msgs || msgs.length < 2) {
    console.log(`[dream] session ${sessionId} too short to process`);
    return;
  }

  // Build the transcript
  const transcript = msgs
    .map(m => `${m.sender === 'maya' ? 'Maya' : m.user_name}: ${m.message}`)
    .join('\n');

  const participantIds = _parseJson(sess.participant_ids, []);
  const guildId        = sess.guild_id;

  console.log(`[dream] session ${sessionId}: ${msgs.length} msgs, ${participantIds.length} participants`);

  // ── Extract structured facts via LLM ────────────────────────────────────
  let extracted;
  try {
    extracted = await _extractFacts(transcript, msgs, guildId);
  } catch (e) {
    console.error(`[dream] fact extraction failed for session ${sessionId}:`, e.message);
    return;
  }

  // ── Write to Qdrant with memory_type namespacing ────────────────────────
  const points = [];

  // User facts — one per user per fact
  for (const [userId, facts] of Object.entries(extracted.user_facts || {})) {
    const userName = msgs.find(m => m.discord_user_id === userId)?.user_name || userId;
    for (const fact of facts) {
      const text = `${userName}: ${fact.text}`;
      try {
        const vec = await embed(text);
        points.push({
          id:      `uf_${sessionId}_${userId}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
          vector:  vec,
          payload: {
            memory_type:     'user_fact',
            discord_user_id: userId,
            user_name:       userName,
            guild_id:        guildId || null,
            is_private:      !guildId,
            fact_text:       fact.text,
            category:        fact.category || 'general',
            conflict_score:  fact.conflict_score ?? 0.3,
            message:         text,
            weight:          2.0,
            created_at:      new Date().toISOString(),
          },
        });
      } catch { /* non-fatal */ }
    }
  }

  // Conversation memory — what happened in this session
  if (extracted.conversation_summary) {
    try {
      const vec = await embed(extracted.conversation_summary);
      points.push({
        id:      `conv_${sessionId}_${Date.now()}`,
        vector:  vec,
        payload: {
          memory_type:     'conversation',
          discord_user_id: participantIds[0] || 'unknown',
          guild_id:        guildId || null,
          is_private:      !guildId,
          participants:    participantIds,
          message:         extracted.conversation_summary,
          topics:          extracted.topics || [],
          mood:            extracted.mood || 'neutral',
          weight:          1.5,
          created_at:      new Date().toISOString(),
        },
      });
    } catch { /* non-fatal */ }
  }

  // Maya self-traits extracted from her own replies
  for (const trait of extracted.maya_traits || []) {
    try {
      const vec = await embed(`Maya: ${trait}`);
      points.push({
        id:      `ms_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
        vector:  vec,
        payload: {
          memory_type:     'maya_self',
          discord_user_id: 'maya',
          guild_id:        null,
          is_private:      false,
          message:         `Maya: ${trait}`,
          fact_text:       trait,
          weight:          1.8,
          created_at:      new Date().toISOString(),
        },
      });
    } catch { /* non-fatal */ }
  }

  // Upsert all points
  if (points.length > 0) {
    try {
      await upsertBatch(points);
      console.log(`[dream] session ${sessionId}: upserted ${points.length} LTM points`);
    } catch (e) {
      console.error(`[dream] upsertBatch failed for session ${sessionId}:`, e.message);
    }
  }
}

// ── LLM fact extraction ───────────────────────────────────────────────────────

async function _extractFacts(transcript, msgs, guildId) {
  const participants = [...new Set(
    msgs.filter(m => m.sender === 'user').map(m => `${m.user_name} (id:${m.discord_user_id})`)
  )].join(', ');

  const prompt = `You are a memory extraction system for an AI called Maya.
Analyse this conversation and extract structured facts. Return ONLY valid JSON.

Participants: ${participants}

Conversation:
${transcript.slice(0, 3000)}

Extract and return this exact JSON structure:
{
  "user_facts": {
    "<discord_user_id>": [
      {
        "text": "<name> <fact about them in third person>",
        "category": "preference|identity|relationship|belief|objective",
        "conflict_score": <0.0 to 1.0, 0=certain 1=contested>
      }
    ]
  },
  "conversation_summary": "<1-2 sentences: what happened in this conversation, who was involved, main topics>",
  "topics": ["<topic1>", "<topic2>"],
  "mood": "<overall mood: positive|negative|neutral|chaotic|deep>",
  "maya_traits": ["<thing Maya expressed about herself, third person: Maya finds X interesting>"]
}

Rules:
- Only include facts clearly stated, not inferred
- User facts must use the user's discord_user_id as the key
- Rewrite all first-person ("I love pizza") to third-person ("Danish loves pizza")
- If nothing clear was stated for a field, use null or []
- conflict_score 0.0 = stated as definite fact, 0.5 = opinion/preference, 1.0 = contradicts known info
- Return ONLY the JSON object, no markdown, no explanation`;

  const { data, status } = await axios.post(
    config.llm.endpoint,
    {
      model:       config.llm.model,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.1,   // low temperature for factual extraction
      max_tokens:  1000,
    },
    {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${config.llm.apiKey}`,
        'HTTP-Referer':  'https://chatmasala.fun',
        'X-Title':       'MayaDiscordBot',
      },
      timeout:        30_000,
      validateStatus: () => true,
    }
  );

  if (status !== 200) throw new Error(`LLM HTTP ${status}`);

  const raw = data?.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('Empty LLM response');

  // Strip any markdown fences if present
  const clean = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

  try {
    return JSON.parse(clean);
  } catch {
    console.error('[dream] JSON parse failed:', clean.slice(0, 200));
    throw new Error('Invalid JSON from LLM');
  }
}

// ── Raw message embed pass (time/volume triggered) ────────────────────────────

async function _runEmbedPass(trigger) {
  if (_running) return;
  _running = true;
  const start = Date.now();
  console.log(`[dream] embed pass started (trigger=${trigger})`);

  try {
    const [rows] = await db.execute(
      `SELECT id, discord_user_id, user_name, guild_id, channel_id,
              context_type, is_private, sender, message, entropy
       FROM maya_memory
       WHERE embedded=0
       ORDER BY created_at ASC LIMIT ?`,
      [BATCH_SIZE]
    ).catch(() => [[]]);

    if (!rows?.length) { _running = false; return; }

    const texts   = rows.map(r => `${r.sender === 'maya' ? 'Maya' : r.user_name}: ${r.message}`);
    const vectors = await embedBatch(texts).catch(() => null);
    if (!vectors) { _running = false; return; }

    const points = rows.map((r, i) => ({
      id:      `raw_${r.id}`,
      vector:  vectors[i],
      payload: {
        memory_type:     'raw_message',
        mysql_id:        r.id,
        discord_user_id: r.discord_user_id,
        user_name:       r.user_name || '',
        guild_id:        r.guild_id  || null,
        context_type:    r.context_type || 'server',
        is_private:      !!(r.is_private),
        sender:          r.sender,
        message:         r.message,
        entropy:         parseFloat(r.entropy) || 0.4,
        weight:          0.8,   // raw messages have lower weight than processed facts
        created_at:      new Date().toISOString(),
      },
    }));

    await upsertBatch(points).catch(e => console.error('[dream] upsertBatch:', e.message));

    const ids = rows.map(r => r.id);
    await db.execute(
      `UPDATE maya_memory SET embedded=1 WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    ).catch(() => {});

    console.log(`[dream] embed pass: ${rows.length} msgs in ${Date.now()-start}ms`);
  } catch (e) {
    console.error('[dream] embed pass error:', e.message);
  } finally {
    _running = false;
  }
}

function _parseJson(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}
