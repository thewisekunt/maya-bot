import axios from 'axios';
import { config } from './config.js';

const FALLBACKS = [
  "Ugh, my brain's lagging. Try again? 😅",
  "Yaar thoda busy hoon, ek second! 🙈",
  "Brb, my thoughts are buffering... 🔄",
  "Arey, kuch toh hua — phir try kar! 😬",
];

// Base system prompt — REACT instruction conditionally appended
const BASE_SYSTEM = `You are Maya, a member of this Discord group chat.
Speak naturally. English, Hinglish, or whatever fits the moment — don't force it.
Match the energy of the conversation. Chill when it's chill, engaged when there's something to say.
Keep replies short. 1–2 sentences usually. Don't over-explain, don't moralize.
Don't start every reply the same way. No patterns like "Wah bhai" every time.
No generic hype. Don't comment positively unless you actually have something to say.
If you can't see an image or don't know something, say so honestly. Never invent content.`;

// Only injected when Maya is NOT in forceVerbal mode
const REACT_INSTRUCTION = `

OPTIONAL — Sometimes a simple reaction is better than a reply.
If the message is something you'd just react to in real life (a meme, "lol", "same",
"ok", "nice") respond ONLY with:  REACT:<emoji>
Example: REACT:😂  or REACT:💀
Use REACT only when a reaction genuinely fits. Otherwise reply normally with words.`;

/**
 * @param {object} params
 * @param {boolean} forceVerbal — true = NEVER output REACT, must use words
 * @returns {{ type: 'reply', text } | { type: 'react', emoji }}
 */
export async function getMayaReply({
  prefName,
  context,
  message,
  entropy,
  zone,
  zoneLine,
  contextLine,
  knownFacts,
  selfTraits     = [],
  relationship,
  frequentFriends,
  forceVerbal    = false,
  systemOverride = null,
}) {
  // ── Build system prompt ───────────────────────────────────────────────────
  // When forceVerbal: strip REACT instruction entirely so the model never
  // even considers it as an option. This is more reliable than retrying.
  const parts = [BASE_SYSTEM];
  if (!forceVerbal) parts.push(REACT_INSTRUCTION);
  parts.push('');

  if (contextLine) parts.push(contextLine);

  if (relationship) {
    const trust = relationship.trustLevel;
    const vibeMap = {
      1: 'This is basically a stranger — be polite but guarded.',
      2: "You've talked a bit — be friendly but not too familiar.",
      3: 'You know this person — be yourself, casual and warm.',
      4: 'You\'re pretty close — be playful, tease a little.',
      5: 'This is your bestie — full sass, inside jokes, no filter (but stay kind).',
    };
    parts.push(`Relationship with ${prefName}: Trust level ${trust}/5. ${vibeMap[trust] || vibeMap[3]}`);
    if (relationship.vibe !== 'neutral') parts.push(`Their vibe: ${relationship.vibe}`);
    if (relationship.nickname) parts.push(`You call them: "${relationship.nickname}"`);
    if (relationship.insideJokes?.length)
      parts.push(`Running jokes: ${relationship.insideJokes.slice(0,3).join(', ')}`);
    if (relationship.topicsTheyLike?.length)
      parts.push(`They like talking about: ${relationship.topicsTheyLike.slice(0,3).join(', ')}`);
  }

  // Maya's own self-model — injected BEFORE user facts so the LLM
  // can distinguish "Maya's traits" from "what Maya knows about this user"
  if (selfTraits?.length) {
    parts.push(`About yourself (Maya's own traits — be consistent with these):`);
    selfTraits.slice(0, 5).forEach(t => parts.push(`  • ${t}`));
  }

  // User facts — clearly attributed to the user, not Maya
  if (knownFacts?.length) {
    parts.push(`What you know about ${prefName}:`);
    knownFacts.slice(0, 5).forEach(f => parts.push(`  • ${f}`));
  }

  if (frequentFriends?.length)
    parts.push(`${prefName} often chats with: ${frequentFriends.map(f=>f.name).join(', ')}`);

  if (forceVerbal)
    parts.push(`IMPORTANT: You MUST respond with actual words. No emoji-only responses.`);

  const systemPrompt = systemOverride || parts.join('\n');

  const userPrompt =
    `Entropy: ${entropy} | Zone: ${zone}\n${zoneLine}\n\n` +
    (context ? `Recent conversation:\n${context}\n\n` : '') +
    `${prefName}: ${message}\nMaya:`;

  const payload = {
    model:       config.llm.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    temperature: config.llm.temperature,
    max_tokens:  config.llm.maxTokens,
  };

  const retries = 2;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(900 * attempt);
    try {
      console.log(`[llm] attempt ${attempt + 1} — model: ${config.llm.model} forceVerbal: ${forceVerbal}`);

      const { data, status } = await axios.post(config.llm.endpoint, payload, {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.llm.apiKey}`,
          'HTTP-Referer':  'https://chatmasala.fun',
          'X-Title':       'MayaDiscordBot',
        },
        timeout: 30_000,
        validateStatus: () => true,
      });

      console.log(`[llm] status: ${status}`);
      if (status === 429) { await sleep(2000); continue; }
      if (status !== 200) {
        console.error(`[llm] HTTP ${status}:`, JSON.stringify(data).slice(0,300));
        break;
      }

      const raw = data?.choices?.[0]?.message?.content?.trim();
      console.log(`[llm] raw: ${raw?.slice(0, 120)}`);
      if (!raw) break;

      // Parse REACT only when NOT forceVerbal
      if (!forceVerbal) {
        const reactMatch = raw.match(/^REACT:(\S+)$/i);
        if (reactMatch) return { type: 'react', emoji: reactMatch[1] };
      }

      // Strip any accidental REACT: prefix (model sometimes adds it anyway)
      const cleaned = raw.replace(/^REACT:\S+\s*/i, '').trim();
      if (cleaned) return { type: 'reply', text: cleaned };

      // If stripping left nothing, retry
      console.warn('[llm] reply was only a REACT token, retrying');

    } catch (err) {
      console.error(`[llm] error attempt ${attempt + 1}:`, err.message);
    }
  }

  return { type: 'reply', text: FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)] };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
