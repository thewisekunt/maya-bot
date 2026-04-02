/**
 * think.js — Maya's deliberation engine
 *
 * Humans don't think before every sentence — only when something
 * triggers it: a hard question, conflicting info, needing to look something up.
 *
 * FAST PATH (default, no extra cost):
 *   Local trigger detection → no deliberation needed → reply directly
 *
 * SLOW PATH (triggered only):
 *   1. Small LLM call: "should I search? what for? what do I already know?"
 *   2. Optional web search (if LLM says search is needed)
 *   3. Returns enriched context to inject into the main reply
 *
 * Cost: 0 extra calls on ~85% of messages
 *       1 small call on ~12% (factual/knowledge questions)
 *       1 small call + 1 search on ~3% (needs current info)
 *
 * Web search: DuckDuckGo Instant Answer API (free, no key needed)
 *   + fallback to Brave Search API (free tier: 2000 calls/month)
 */

import axios from 'axios';
import { config } from './config.js';

// ── Trigger detection (pure local, zero cost) ─────────────────────────────────

const KNOWLEDGE_Q = /\b(what is|what are|what was|who is|who was|who are|how does|how do|how did|why is|why are|why did|when did|when was|where is|where was|explain|tell me about|what happened|what's the difference)\b/i;
const RECENCY     = /\b(latest|current|now|today|recently|right now|this year|2024|2025|2026|news|update|just happened|trending)\b/i;
const SEARCH_REQ  = /\b(search|google|look it up|find out|look up|check|can you find)\b/i;
const SOCIAL_Q    = /\b(how are you|what do you think|do you like|what's your|how do you feel|your opinion|you think|who do you|who are you|what are you|are you|you feel|you like|you prefer|you know|your fav|your favorite|attached to|close to|who is your)\b/i;
const MATH_Q      = /\b(calculate|what is \d|how many|how much|\d+\s*[\+\-\*\/]\s*\d+)\b/i;

/**
 * Check locally whether this message needs deliberation.
 * Zero API calls — pure pattern matching + psyche state.
 *
 * @returns {string|null} trigger reason or null (fast path)
 */
export function shouldDeliberate(text, psycheState = null, knownFacts = []) {
  // Social questions never need deliberation — Maya just responds naturally
  if (SOCIAL_Q.test(text)) return null;

  // Explicit search request
  if (SEARCH_REQ.test(text)) return 'search_requested';

  // Recency signal — Maya can't know current events
  if (RECENCY.test(text)) return 'recency';

  // Math — deliberate
  if (MATH_Q.test(text)) return 'calculation';

  // Knowledge question
  if (KNOWLEDGE_Q.test(text)) {
    // Check if we already know this from stored facts
    const textLower = text.toLowerCase();
    const alreadyKnown = knownFacts.some(f =>
      _topicOverlap(f.toLowerCase(), textLower) > 0.4
    );
    if (alreadyKnown) return null;  // already know → fast path
    return 'knowledge_question';
  }

  // High seriousness + question mark = might need care
  if (psycheState?.seriousness > 0.65 && text.includes('?')) {
    return 'careful_question';
  }

  return null;  // fast path
}

// ── Deliberation (small LLM call) ─────────────────────────────────────────────

/**
 * Maya thinks before responding.
 * Small, focused LLM call — not for generating the reply,
 * just for deciding what she knows and what she needs to find out.
 *
 * Returns enriched context string to inject into the main reply call.
 */
export async function deliberate(text, context, knownFacts, trigger) {
  const factSummary = knownFacts.length > 0
    ? `Known facts:\n${knownFacts.slice(0, 4).map(f => `• ${f}`).join('\n')}`
    : 'No relevant stored facts.';

  const recentCtx = context
    ? `Recent conversation:\n${context.slice(-800)}`
    : '';

  const prompt = `You are Maya's internal reasoning process. Be brief and direct.
CRITICAL RULE: Only state things Maya actually knows from the facts/context above. Do NOT invent people, places, or events. If Maya doesn't know something, say "nothing relevant".

${recentCtx}
${factSummary}

User message: "${text}"
Trigger: ${trigger}

Decide in this exact format (fill in each line):
KNOW: [ONLY what is explicitly stated in the facts/context above, or "nothing relevant"]
NEED: [what specific information would help, or "nothing"]
SEARCH: [yes/no — only yes if the information is time-sensitive or verifiable online]
QUERY: [if SEARCH=yes, the exact search query (5 words max), else leave blank]
CONFIDENCE: [high/medium/low — how confident can Maya be answering without more info]`;

  try {
    const { data, status } = await axios.post(
      config.llm.endpoint,
      {
        model:       config.llm.model,
        messages:    [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens:  120,
      },
      {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.llm.apiKey}`,
          'HTTP-Referer':  'https://chatmasala.fun',
          'X-Title':       'MayaDiscordBot',
        },
        timeout:        12_000,
        validateStatus: () => true,
      }
    );

    if (status !== 200) throw new Error(`HTTP ${status}`);
    const raw = data?.choices?.[0]?.message?.content?.trim() || '';
    return _parseDeliberation(raw, text, trigger);

  } catch (e) {
    console.error('[think] deliberation failed:', e.message);
    return null;  // fall back to fast path
  }
}

// ── Web search ────────────────────────────────────────────────────────────────

/**
 * Search the web using OpenRouter's built-in web search tool.
 * No extra API key, no extra npm package — uses the existing LLM endpoint.
 * OpenRouter handles the search and returns results already in context.
 *
 * Falls back to Wikipedia REST API for encyclopedic queries if OR search fails.
 *
 * @param {string} query
 * @returns {string|null} search result or null
 */
export async function webSearch(query) {
  if (!query || query.trim().length < 3) return null;
  console.log(`[think] searching: "${query}"`);

  // Try OpenRouter web search first (uses existing API key)
  const orResult = await _openRouterSearch(query);
  if (orResult) return orResult;

  // Wikipedia fallback (free, no key, good for factual/encyclopedic queries)
  const wikiResult = await _wikiSearch(query);
  if (wikiResult) return wikiResult;

  console.log('[think] all search sources returned empty');
  return null;
}

async function _openRouterSearch(query) {
  try {
    const { data, status } = await axios.post(
      config.llm.endpoint,
      {
        model:    config.llm.model,
        messages: [{ role: 'user', content: `Search for: ${query}\n\nReturn only the key facts, 2-3 sentences max.` }],
        tools: [{
          type: 'function',
          function: {
            name:        'web_search',
            description: 'Search the web for current information',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' },
              },
              required: ['query'],
            },
          },
        }],
        tool_choice: 'auto',
        max_tokens:  200,
        temperature: 0.1,
      },
      {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.llm.apiKey}`,
          'HTTP-Referer':  'https://chatmasala.fun',
          'X-Title':       'MayaDiscordBot',
        },
        timeout:        15_000,
        validateStatus: () => true,
      }
    );

    if (status !== 200) {
      console.warn(`[think] OR search HTTP ${status}`);
      return null;
    }

    // OpenRouter may return tool_calls or just a text response with search results
    const choice = data?.choices?.[0];
    if (!choice) return null;

    // Text response (model already incorporated search)
    const text = choice.message?.content?.trim();
    if (text && text.length > 10) {
      console.log(`[think] OR search result: ${text.slice(0, 80)}`);
      return text.slice(0, 500);
    }

    return null;
  } catch (e) {
    console.warn('[think] OR search failed:', e.message);
    return null;
  }
}


// ── Parse deliberation output ─────────────────────────────────────────────────

function _parseDeliberation(raw, originalText, trigger) {
  const lines = {};
  raw.split('\n').forEach(line => {
    const m = line.match(/^(\w+):\s*(.+)/);
    if (m) lines[m[1].toUpperCase()] = m[2].trim();
  });

  return {
    know:       lines.KNOW       || '',
    need:       lines.NEED       || '',
    shouldSearch: (lines.SEARCH || '').toLowerCase() === 'yes',
    searchQuery:  lines.QUERY    || '',
    confidence:   lines.CONFIDENCE || 'medium',
    trigger,
  };
}

/**
 * Extract a clean search query from a message like "google X and tell me"
 * or "look up who is Y" or "search for Z"
 */
export function extractSearchQuery(text) {
  // Strip the search request verb to get the actual query
  const cleaned = text
    .replace(/\b(can you |please |)?(search|google|look up|look it up|find out|check|find)\b[^?]*/i, '')
    .replace(/\band tell me\b.*/i, '')
    .replace(/\bfor me\b.*/i, '')
    .replace(/[?!.]/g, '')
    .trim();

  // If we stripped everything, use the original (minus social words)
  const fallback = text
    .replace(/\b(search|google|look up|find|tell me|and|please|can you)\b/gi, '')
    .replace(/[?!.]/g, '')
    .trim();

  const result = cleaned.length >= 3 ? cleaned : fallback;
  return result.slice(0, 80) || null;
}

// ── Topic overlap (for "already know" check) ──────────────────────────────────

function _topicOverlap(a, b) {
  const wordsA = new Set(a.split(/\W+/).filter(w => w.length > 3));
  const wordsB = new Set(b.split(/\W+/).filter(w => w.length > 3));
  if (!wordsA.size || !wordsB.size) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.min(wordsA.size, wordsB.size);
}
