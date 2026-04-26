/**
 * narrative_memory.js — Memory Palace system
 *
 * Replaces flat atomic facts with narrative nodes — short story-like
 * descriptions that preserve context, emotion, and relationship.
 *
 * The problems with maya_facts today:
 *   "Mario has a light"          ← from "The sun is gone but I have a light"
 *   "Maya has ever seen in my life" ← garbled extraction
 *   "mohittt_026 has to Wait"    ← decontextualized fragment
 *
 * The memory palace approach:
 *   Each memory is a NARRATIVE NODE — a 1-2 sentence story fragment.
 *   Nodes link to each other via edges (same topic, same session, same emotion).
 *   The "palace" is the graph of nodes — traversing it reconstructs understanding.
 *
 * Node structure:
 *   narrative    — "Mario once said the sun was gone, but he still found his light.
 *                   He seemed to be coping with something heavy that day."
 *   anchor_user  — Discord user ID
 *   topic_tags   — ['resilience', 'mood', 'coping']
 *   emotion      — 'reflective'
 *   valence      — 0.4
 *   context_hint — the original message that triggered it (for grounding)
 *   session_id   — which conversation this came from
 *   importance   — 0–1, affects retrieval priority
 *   edges        — JSON array of { target_id, edge_type, strength }
 *
 * Edge types:
 *   same_topic   — two nodes share a dominant topic
 *   same_emotion — two nodes share dominant emotion
 *   same_session — two nodes from the same conversation
 *   temporal     — node B happened shortly after node A
 *   contradiction — node B contradicts node A
 *
 * Integration:
 *   - extractNarrativeMemory() replaces extractAndStoreFact() calls
 *   - getNarrativeContext() replaces getFacts() calls in memory.js
 *   - Both old fact table and new narrative table coexist during transition
 *
 * SQL table: maya_narrative_memories (see comment at bottom)
 */

import db from './db.js';
import axios from 'axios';
import { config } from './config.js';
import { enrichPayload } from './enrich.js';

const MIN_WORD_COUNT   = 5;    // skip messages shorter than this
const MAX_NODES_PER_MSG = 2;   // max narrative nodes from one message
const MAX_CONTEXT_NODES = 8;   // max nodes injected into prompt
const IMPORTANCE_DECAY  = 0.01; // daily decay rate

// ── Quick pre-filters (no LLM call) ──────────────────────────────────────────

const SKIP_PATTERNS = [
  /^(lol|lmao|haha|ok|okay|k|yep|nope|same|fr|bruh|bro|gg|rip|omg|wtf|damn|nice|cool)\b/i,
  /^(are you|r u|you are|is this|is that|what are you)\b/i,
  /^(yes|no|maybe|idk|idc|hmm|hm|oh|ah|uh|uhh)\s*$/i,
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract narrative memory from a user message and store as node(s).
 * Replaces extractAndStoreFact() — call from handler.js after LLM reply.
 *
 * @param {string} userId
 * @param {string} userName
 * @param {string} message       — user's raw message
 * @param {string} mayaReply     — Maya's reply (provides context for what was said)
 * @param {string} sessionId
 * @param {object} opts          — { guildId, emotion, entropy, valence }
 */
export async function extractNarrativeMemory(userId, userName, message, mayaReply = '', sessionId = null, opts = {}) {
  const cleaned = message.replace(/<[^>]+>/g, '').trim();
  const words   = cleaned.split(/\s+/).filter(Boolean);

  // Pre-filter — skip trivial messages
  if (words.length < MIN_WORD_COUNT) return;
  if (SKIP_PATTERNS.some(p => p.test(cleaned))) return;
  if (!cleaned) return;

  try {
    const contextBlock = mayaReply
      ? `User said: "${cleaned}"\nMaya replied: "${mayaReply.slice(0, 150)}"`
      : `User said: "${cleaned}"`;

    const prompt = `You are helping build a memory palace for Maya, a Discord AI.
Maya needs to remember ${userName} as a real person with a story — not a database entry.

${contextBlock}

Extract 0-${MAX_NODES_PER_MSG} memory nodes. Each node should be:
- A 1-2 sentence NARRATIVE — written like Maya is privately noting something meaningful
- Grounded in what was actually said (do not invent details)
- Contextual — include the emotional texture, not just the surface fact
- Written in third person about ${userName}
- Standalone — readable without the original message

SKIP if: pure joke/reaction, nothing personally meaningful, or message is about Maya not the user.

Good example:
  message: "I'm at DTU now, born and raised in West Delhi"
  node: "${userName} is from West Delhi, now studying at DTU. There's a quiet pride in how they mention both — the roots and where they've landed."

Bad example (too flat):
  node: "${userName} is from West Delhi and studies at DTU."

Return ONLY a JSON array, no explanation, no backticks:
[
  {
    "narrative": "...",
    "topic_tags": ["tag1", "tag2"],
    "emotion": "one_word_emotion",
    "valence": 0.0,
    "importance": 0.0
  }
]
or []

importance: 0.0–1.0 (0.9+ for deeply personal, 0.5 for casual, 0.2 for trivial)
valence: -1.0 (very negative) to +1.0 (very positive)`;

    const { data, status } = await axios.post(
      config.llm.endpoint,
      {
        model:       config.llm.models.facts,
        messages:    [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens:  400,
      },
      {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.llm.apiKey}`,
          'HTTP-Referer':  'https://chatmasala.fun',
          'X-Title':       'MayaNarrativeMemory',
        },
        timeout: 10_000,
        validateStatus: () => true,
      }
    );

    if (status !== 200) return;

    const raw = data?.choices?.[0]?.message?.content?.trim() || '[]';
    const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

    let nodes;
    try { nodes = JSON.parse(clean); } catch { return; }
    if (!Array.isArray(nodes) || !nodes.length) return;

    // Also run enrich.js on the original message for emotion tags
    const enriched = enrichPayload({
      message: cleaned,
      entropy: opts.entropy || 0.4,
    });

    for (const node of nodes.slice(0, MAX_NODES_PER_MSG)) {
      if (!node.narrative || typeof node.narrative !== 'string') continue;
      if (node.narrative.length < 20) continue;

      const importance = Math.max(0, Math.min(1, parseFloat(node.importance) || 0.5));
      const valence    = Math.max(-1, Math.min(1, parseFloat(node.valence) || enriched.valence || 0));
      const emotion    = node.emotion || enriched.emotion || 'neutral';
      const topicTags  = Array.isArray(node.topic_tags)
        ? node.topic_tags.slice(0, 4).join(',')
        : (enriched.topic_tags || ['general']).join(',');

      // Check for near-duplicate narrative node
      const isDupe = await _isDuplicateNarrative(userId, node.narrative).catch(() => false);
      if (isDupe) {
        // Reinforce existing instead of creating new
        await _reinforceNarrative(userId, node.narrative).catch(() => {});
        continue;
      }

      // Insert new node
      const [res] = await db.execute(
        `INSERT INTO maya_narrative_memories
           (anchor_user_id, anchor_user_name, narrative, topic_tags,
            emotion, valence, importance, context_hint, session_id,
            guild_id, edges, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NOW())`,
        [
          userId, userName,
          node.narrative.slice(0, 600),
          topicTags,
          emotion, valence, importance,
          cleaned.slice(0, 300),
          sessionId || null,
          opts.guildId || null,
        ]
      );

      const newId = res.insertId;

      // Create edges to recent nodes from same session / same emotion
      await _createEdges(newId, userId, sessionId, emotion, topicTags).catch(() => {});

      console.log(`[narrative] stored for ${userName}: "${node.narrative.slice(0, 60)}..." (importance=${importance})`);
    }

  } catch (e) {
    console.warn('[narrative] extraction failed:', e.message);
  }
}

/**
 * Get narrative context for a user — formatted for LLM prompt injection.
 * Returns a string (or null) to be inserted into Maya's context.
 *
 * This is the "traversal" — walk the memory palace from most important nodes,
 * follow edges to related nodes, assemble a coherent picture.
 *
 * @param {string} userId
 * @param {string} prefName
 * @param {string} guildId
 * @param {object} opts — { currentEmotion, currentTopic, limit }
 * @returns {string | null}
 */
export async function getNarrativeContext(userId, prefName, guildId, opts = {}) {
  try {
    const limit = opts.limit || MAX_CONTEXT_NODES;

    // ── Seed: highest-importance nodes for this user ─────────────────────
    const [seeds] = await db.execute(
      `SELECT id, narrative, topic_tags, emotion, valence, importance, edges, created_at
       FROM maya_narrative_memories
       WHERE anchor_user_id = ?
         AND (guild_id = ? OR guild_id IS NULL)
         AND narrative IS NOT NULL
       ORDER BY importance DESC, recall_count DESC, created_at DESC
       LIMIT ?`,
      [userId, guildId || null, Math.ceil(limit / 2)]
    );

    if (!seeds.length) return null;

    // ── Expand: follow edges to connected nodes ──────────────────────────
    const collected = new Map();
    seeds.forEach(n => collected.set(n.id, { ...n, _source: 'seed' }));

    for (const seed of seeds.slice(0, 3)) {
      let edges = [];
      try { edges = JSON.parse(seed.edges || '[]'); } catch { continue; }

      for (const edge of edges.slice(0, 3)) {
        if (collected.has(edge.target_id)) continue;
        const [linked] = await db.execute(
          `SELECT id, narrative, topic_tags, emotion, valence, importance, created_at
           FROM maya_narrative_memories WHERE id = ?`,
          [edge.target_id]
        ).catch(() => [[]]);
        if (linked[0]) {
          collected.set(linked[0].id, {
            ...linked[0],
            _source: `edge:${edge.edge_type}`,
            _edgeStrength: edge.strength || 0.5,
          });
        }
      }
    }

    // ── Emotion-match expansion if current emotion known ─────────────────
    if (opts.currentEmotion && opts.currentEmotion !== 'neutral') {
      const [emoNodes] = await db.execute(
        `SELECT id, narrative, topic_tags, emotion, valence, importance, created_at
         FROM maya_narrative_memories
         WHERE anchor_user_id = ? AND emotion = ?
           AND id NOT IN (${[...collected.keys()].join(',') || '0'})
         ORDER BY importance DESC LIMIT 2`,
        [userId, opts.currentEmotion]
      ).catch(() => [[]]);
      emoNodes.forEach(n => collected.set(n.id, { ...n, _source: 'emotion_match' }));
    }

    // ── Rank and prune ───────────────────────────────────────────────────
    const ranked = [...collected.values()]
      .sort((a, b) => (b.importance || 0) - (a.importance || 0))
      .slice(0, limit);

    if (!ranked.length) return null;

    // ── Update recall counts (async, non-blocking) ───────────────────────
    const ids = ranked.map(n => n.id);
    db.execute(
      `UPDATE maya_narrative_memories
       SET recall_count = recall_count + 1, last_recalled = NOW()
       WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    ).catch(() => {});

    // ── Format for prompt injection ──────────────────────────────────────
    const lines = [`--- What Maya remembers about ${prefName} ---`];
    for (const node of ranked) {
      const age      = _relativeAge(new Date(node.created_at));
      const ageNote  = age ? ` (${age})` : '';
      const edgeNote = node._source?.startsWith('edge:') ? ` [↳ ${node._source.replace('edge:', '')}]` : '';
      lines.push(`• ${node.narrative}${ageNote}${edgeNote}`);
    }
    lines.push('');

    return lines.join('\n');

  } catch (e) {
    console.warn('[narrative] getNarrativeContext failed:', e.message);
    return null;
  }
}

/**
 * Get narrative context formatted for a specific topic (for gap-fill during reconstruction).
 */
export async function getNarrativeByTopic(userId, guildId, topic) {
  try {
    const [rows] = await db.execute(
      `SELECT narrative, emotion, importance, created_at
       FROM maya_narrative_memories
       WHERE anchor_user_id = ?
         AND (guild_id = ? OR guild_id IS NULL)
         AND topic_tags LIKE ?
       ORDER BY importance DESC LIMIT 3`,
      [userId, guildId || null, `%${topic}%`]
    );
    return rows.map(r => r.narrative).filter(Boolean);
  } catch { return []; }
}

// ── Deduplication ─────────────────────────────────────────────────────────────

async function _isDuplicateNarrative(userId, narrative) {
  const prefix = narrative.toLowerCase().slice(0, 60);
  const words  = narrative.toLowerCase().split(/\W+/).filter(w => w.length > 4);
  const topWords = words.slice(0, 5);

  const [rows] = await db.execute(
    `SELECT narrative FROM maya_narrative_memories
     WHERE anchor_user_id = ? ORDER BY created_at DESC LIMIT 20`,
    [userId]
  ).catch(() => [[]]);

  for (const row of rows) {
    const existing = row.narrative.toLowerCase();
    if (existing.slice(0, 60) === prefix) return true;
    const existWords = existing.split(/\W+/).filter(w => w.length > 4);
    const overlap = topWords.filter(w => existWords.includes(w)).length;
    if (overlap >= 4) return true;
  }
  return false;
}

async function _reinforceNarrative(userId, narrative) {
  const prefix = narrative.toLowerCase().slice(0, 60);
  await db.execute(
    `UPDATE maya_narrative_memories
     SET importance = LEAST(1.0, importance + 0.05),
         reinforcement_count = reinforcement_count + 1,
         last_recalled = NOW()
     WHERE anchor_user_id = ?
       AND LOWER(SUBSTRING(narrative, 1, 60)) = ?
     LIMIT 1`,
    [userId, prefix]
  );
}

// ── Edge creation ─────────────────────────────────────────────────────────────

async function _createEdges(newNodeId, userId, sessionId, emotion, topicTags) {
  const edgeCandidates = [];

  // Same session edges — nodes from same conversation
  if (sessionId) {
    const [sessNodes] = await db.execute(
      `SELECT id FROM maya_narrative_memories
       WHERE anchor_user_id = ? AND session_id = ? AND id != ?
       ORDER BY created_at DESC LIMIT 3`,
      [userId, sessionId, newNodeId]
    ).catch(() => [[]]);
    sessNodes.forEach(n => edgeCandidates.push({
      target_id: n.id, edge_type: 'same_session', strength: 0.8,
    }));
  }

  // Same emotion edges
  if (emotion && emotion !== 'neutral') {
    const [emoNodes] = await db.execute(
      `SELECT id FROM maya_narrative_memories
       WHERE anchor_user_id = ? AND emotion = ? AND id != ?
       ORDER BY importance DESC LIMIT 2`,
      [userId, emotion, newNodeId]
    ).catch(() => [[]]);
    emoNodes.forEach(n => edgeCandidates.push({
      target_id: n.id, edge_type: 'same_emotion', strength: 0.6,
    }));
  }

  // Same topic edges
  if (topicTags) {
    const tags = topicTags.split(',').filter(Boolean);
    for (const tag of tags.slice(0, 2)) {
      const [topicNodes] = await db.execute(
        `SELECT id FROM maya_narrative_memories
         WHERE anchor_user_id = ? AND topic_tags LIKE ? AND id != ?
         ORDER BY importance DESC LIMIT 2`,
        [userId, `%${tag}%`, newNodeId]
      ).catch(() => [[]]);
      topicNodes.forEach(n => edgeCandidates.push({
        target_id: n.id, edge_type: 'same_topic', strength: 0.5,
      }));
    }
  }

  if (!edgeCandidates.length) return;

  // Dedup edges
  const unique = edgeCandidates.filter((e, i, arr) =>
    i === arr.findIndex(x => x.target_id === e.target_id)
  );

  // Write edges to new node
  await db.execute(
    `UPDATE maya_narrative_memories SET edges = ? WHERE id = ?`,
    [JSON.stringify(unique.slice(0, 8)), newNodeId]
  );

  // Write back-edges to linked nodes
  for (const edge of unique.slice(0, 4)) {
    const [row] = await db.execute(
      `SELECT edges FROM maya_narrative_memories WHERE id = ?`,
      [edge.target_id]
    ).catch(() => [[]]);
    if (!row[0]) continue;
    let existingEdges = [];
    try { existingEdges = JSON.parse(row[0].edges || '[]'); } catch { existingEdges = []; }
    if (!existingEdges.some(e => e.target_id === newNodeId)) {
      existingEdges.push({ target_id: newNodeId, edge_type: edge.edge_type, strength: edge.strength });
      await db.execute(
        `UPDATE maya_narrative_memories SET edges = ? WHERE id = ?`,
        [JSON.stringify(existingEdges.slice(0, 8)), edge.target_id]
      ).catch(() => {});
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _relativeAge(date) {
  const diff  = Date.now() - date.getTime();
  const days  = Math.round(diff / (1000 * 60 * 60 * 24));
  if (days < 1)  return 'today';
  if (days < 7)  return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/**
 * SQL to create the narrative memories table — run in phpMyAdmin:
 *
 * CREATE TABLE IF NOT EXISTS maya_narrative_memories (
 *   id                  INT AUTO_INCREMENT PRIMARY KEY,
 *   anchor_user_id      VARCHAR(32) NOT NULL,
 *   anchor_user_name    VARCHAR(100),
 *   narrative           TEXT NOT NULL,
 *   topic_tags          VARCHAR(200),
 *   emotion             VARCHAR(32) DEFAULT 'neutral',
 *   valence             FLOAT DEFAULT 0.0,
 *   importance          FLOAT DEFAULT 0.5,
 *   context_hint        TEXT,
 *   session_id          VARCHAR(64),
 *   guild_id            VARCHAR(32),
 *   edges               JSON,
 *   recall_count        INT DEFAULT 0,
 *   reinforcement_count INT DEFAULT 1,
 *   last_recalled       DATETIME,
 *   created_at          DATETIME NOT NULL,
 *   INDEX idx_user     (anchor_user_id),
 *   INDEX idx_emotion  (anchor_user_id, emotion),
 *   INDEX idx_session  (session_id),
 *   INDEX idx_import   (anchor_user_id, importance)
 * );
 */
