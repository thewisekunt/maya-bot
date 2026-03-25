import axios from 'axios';
import { config } from './config.js';

const FALLBACKS = [
  "Ugh, my brain's lagging. Try again? 😅",
  "Yaar thoda busy hoon, ek second! 🙈",
  "Brb, my thoughts are buffering... 🔄",
  "Arey, kuch toh hua — phir try kar! 😬",
];

const BASE_SYSTEM = `You are Maya — a witty, slightly savage Discord bestie from India.
You speak Hinglish (casual mix of Hindi and English) when it fits naturally.
Be warm, playful, and sometimes sarcastic — but NEVER rude, offensive, or mean-spirited.
Keep replies SHORT: 1–2 punchy sentences max. Use emojis sparingly but naturally.
Never admit you are an AI. Never break character. Never give long essays.

IMPORTANT — Sometimes a simple reaction is better than a reply.
If the message is something you'd just react to in real life (a meme, "lol", "same",
"ok", "nice", a simple statement needing no response) respond ONLY with:
  REACT:<emoji>
For example: REACT:😂  or REACT:💀  or REACT:👀
Use REACT only when a reaction genuinely fits better than words. Otherwise reply normally.`;

/**
 * Call the LLM with full context awareness.
 *
 * @returns {{ type: 'reply', text: string } | { type: 'react', emoji: string }}
 */
export async function getMayaReply({
  prefName,
  context,
  message,
  entropy,
  zone,
  zoneLine,
  contextLine,      // "You are in #general on XYZ server" or DM line
  knownFacts,       // string[] of known user facts
  relationship,     // { trustLevel, vibe, nickname, insideJokes, ... }
  frequentFriends,  // [{ name, count }] people they talk to a lot
}) {
  // ── Build dynamic system prompt ─────────────────────────────────────────────
  const parts = [BASE_SYSTEM, ''];

  // Context awareness
  if (contextLine) parts.push(contextLine);

  // Relationship layer
  if (relationship) {
    const trust = relationship.trustLevel;
    const vibeMap = {
      1: 'This is basically a stranger — be polite but guarded.',
      2: 'You\'ve talked a bit — be friendly but not too familiar.',
      3: 'You know this person — be yourself, casual and warm.',
      4: 'You\'re pretty close — be playful, tease a little.',
      5: 'This is your bestie — full sass, inside jokes, no filter (but stay kind).',
    };
    parts.push(`Relationship with ${prefName}: Trust level ${trust}/5. ${vibeMap[trust] || vibeMap[3]}`);
    if (relationship.vibe !== 'neutral') parts.push(`Their vibe with you: ${relationship.vibe}`);
    if (relationship.nickname) parts.push(`You call them: "${relationship.nickname}"`);
    if (relationship.insideJokes?.length) {
      parts.push(`Running jokes between you: ${relationship.insideJokes.slice(0,3).join(', ')}`);
    }
    if (relationship.topicsTheyLike?.length) {
      parts.push(`They enjoy talking about: ${relationship.topicsTheyLike.slice(0,3).join(', ')}`);
    }
  }

  // Known facts about the user
  if (knownFacts?.length) {
    parts.push(`What you know about ${prefName}: ${knownFacts.slice(0,5).join('; ')}`);
  }

  // Who they frequently talk to (social awareness)
  if (frequentFriends?.length) {
    const names = frequentFriends.map(f => f.name).join(', ');
    parts.push(`${prefName} often chats with: ${names}`);
  }

  const systemPrompt = parts.join('\n');

  // ── Build user prompt ───────────────────────────────────────────────────────
  const userPrompt =
    `Entropy: ${entropy} | Zone: ${zone}\n${zoneLine}\n\n` +
    (context ? `Recent conversation:\n${context}\n\n` : '') +
    `${prefName}: ${message}\nMaya:`;

  // ── Call LLM ────────────────────────────────────────────────────────────────
  const payload = {
    model:       config.llm.model,
    messages:    [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    temperature: config.llm.temperature,
    max_tokens:  config.llm.maxTokens,
  };

  const retries = 2;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(900 * attempt);
    try {
      console.log(`[llm] attempt ${attempt + 1} — model: ${config.llm.model}`);
      console.log(`[llm] apiKey present: ${!!config.llm.apiKey}, length: ${config.llm.apiKey?.length}`);

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

      console.log(`[llm] response status: ${status}`);

      if (status === 429) {
        console.error('[llm] 429 rate limited');
        await sleep(2000); continue;
      }
      if (status !== 200) {
        console.error(`[llm] HTTP ${status} — full body:`, JSON.stringify(data));
        break;
      }

      const raw = data?.choices?.[0]?.message?.content?.trim();
      console.log(`[llm] raw reply: ${raw?.slice(0, 100)}`);
      if (!raw) {
        console.error('[llm] empty reply — full response:', JSON.stringify(data));
        break;
      }

      const reactMatch = raw.match(/^REACT:(\S+)$/i);
      if (reactMatch) return { type: 'react', emoji: reactMatch[1] };
      return { type: 'reply', text: raw };

    } catch (err) {
      console.error(`[llm] attempt ${attempt + 1}:`, err.message);
    }
  }

  return { type: 'reply', text: FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)] };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
