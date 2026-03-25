import axios from 'axios';
import { config } from './config.js';

const FALLBACKS = [
  "Ugh, my brain's lagging. Try again? 😅",
  "Yaar thoda busy hoon, ek second! 🙈",
  "Brb, my thoughts are buffering... 🔄",
  "Arey, kuch toh hua — phir try kar! 😬",
];

const SYSTEM_PROMPT = `You are Maya — a witty, slightly savage Discord bestie from India.
You speak Hinglish (casual mix of Hindi and English) when it fits naturally.
Be warm, playful, and sometimes sarcastic — but NEVER rude, offensive, or mean-spirited.
Keep replies SHORT: 1–2 punchy sentences max. Use emojis sparingly but naturally.
Never admit you are an AI. Never break character. Never give long essays.`;

/**
 * Call the OpenRouter LLM and return Maya's reply string.
 *
 * @param {string} prefName    - The user's preferred display name
 * @param {string} context     - Recent conversation history block
 * @param {string} message     - The new user message
 * @param {number} entropy     - 0.0–1.0 mood signal
 * @param {string} zone        - 'Restful' | 'Social' | 'Chaos'
 * @param {string} zoneLine    - Human-readable zone description
 * @returns {Promise<string>}
 */
export async function getMayaReply({ prefName, context, message, entropy, zone, zoneLine }) {
  const userPrompt =
    `Entropy: ${entropy} | Zone: ${zone}\n` +
    `${zoneLine}\n\n` +
    (context ? `Recent conversation:\n${context}\n\n` : '') +
    `${prefName}: ${message}\n` +
    `Maya:`;

  const payload = {
    model:       config.llm.model,
    messages:    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userPrompt },
    ],
    temperature: config.llm.temperature,
    max_tokens:  config.llm.maxTokens,
  };

  const retries = 2;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(900 * attempt);

    try {
      const { data, status } = await axios.post(config.llm.endpoint, payload, {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.llm.apiKey}`,
          'HTTP-Referer':  'https://chatmasala.fun',
          'X-Title':       'MayaDiscordBot',
        },
        timeout: 30_000,
        validateStatus: () => true,   // handle all status codes ourselves
      });

      if (status === 429) {
        console.warn(`[llm] 429 rate limit — attempt ${attempt + 1}`);
        await sleep(2000);
        continue;
      }
      if (status !== 200) {
        console.error(`[llm] HTTP ${status}:`, JSON.stringify(data).slice(0, 200));
        break;
      }

      const reply = data?.choices?.[0]?.message?.content?.trim();
      if (reply) return reply;

      console.warn('[llm] Empty reply from model');
      break;

    } catch (err) {
      console.error(`[llm] Request error (attempt ${attempt + 1}):`, err.message);
    }
  }

  return FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
