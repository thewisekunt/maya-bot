/**
 * imagegen.js — Image generation via OpenRouter
 *
 * Model: black-forest-labs/flux-2-flex
 * Available on OpenRouter — same API key, no new service needed.
 *
 * Returns a buffer (image bytes) ready to attach to a Discord message.
 */

import axios from 'axios';
import { config } from './config.js';

const IMAGE_MODEL = process.env.IMAGE_MODEL || 'black-forest-labs/flux-2-flex';

// ── Trigger detection ─────────────────────────────────────────────────────────
// Check before LLM call — no extra API cost for detection

const IMAGE_TRIGGERS = [
  /\b(generate|make|create|draw|paint|render|show me|give me)\b.{0,30}\b(image|picture|photo|pic|illustration|art|drawing|painting)\b/i,
  /\bimage\s+of\b/i,
  /\bpicture\s+of\b/i,
  /\bdraw\s+(me\s+)?(a|an|the)\b/i,
  /\bgenerate\s+(me\s+)?(a|an|the)\b/i,
  /\bmake\s+(me\s+)?(a|an|the)\b.{0,20}\b(image|pic|photo|art)\b/i,
  /\bvisualize\b/i,
  /\billustrate\b/i,
];

/**
 * Returns true if the message is asking for an image.
 */
export function isImageRequest(text) {
  return IMAGE_TRIGGERS.some(pat => pat.test(text));
}

/**
 * Extract a clean image prompt from the user's message.
 * Strips the "generate/make/draw" wrapper and returns just the subject.
 */
export function extractImagePrompt(text) {
  // Remove common request prefixes
  let prompt = text
    .replace(/^@?\w+\s*/i, '')                                    // strip @Maya
    .replace(/\b(please|can you|could you|hey|yo|bhai|yaar)\b/gi, '')
    .replace(/\b(generate|make|create|draw|paint|render|show me|give me|visualize|illustrate)\b/gi, '')
    .replace(/\b(me\s+)?(a|an|the)?\s*(image|picture|photo|pic|illustration|art|drawing|painting)\s*(of|showing|with)?\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // If too short after stripping, use original
  if (prompt.length < 5) prompt = text;

  // Add quality boosters if not already descriptive
  if (prompt.length < 50) {
    prompt += ', high quality, detailed';
  }

  return prompt;
}

/**
 * Generate an image and return the image buffer + filename.
 *
 * @param {string} prompt  — image description
 * @returns {Promise<{ buffer: Buffer, filename: string, prompt: string }>}
 */
export async function generateImage(prompt) {
  console.log(`[imagegen] generating: "${prompt.slice(0, 80)}"`);

  const { data, status } = await axios.post(
    config.llm.endpoint,   // https://openrouter.ai/api/v1/chat/completions
    {
      model:  IMAGE_MODEL,
      prompt: prompt,       // image gen models use 'prompt' not 'messages'
    },
    {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${config.llm.apiKey}`,
        'HTTP-Referer':  'https://chatmasala.fun',
        'X-Title':       'MayaDiscordBot',
      },
      timeout:        60_000,   // image gen can take up to 30s
      validateStatus: () => true,
    }
  );

  if (status !== 200) {
    console.error(`[imagegen] HTTP ${status}:`, JSON.stringify(data).slice(0, 300));
    throw new Error(`Image generation failed (HTTP ${status})`);
  }

  // OpenRouter returns image gen results in data[0].url or b64_json
  const result = data?.data?.[0];
  if (!result) {
    console.error('[imagegen] unexpected response:', JSON.stringify(data).slice(0, 300));
    throw new Error('No image in response');
  }

  // If URL returned — download it
  if (result.url) {
    console.log(`[imagegen] downloading from: ${result.url.slice(0, 60)}`);
    const imgRes = await axios.get(result.url, {
      responseType:    'arraybuffer',
      timeout:         20_000,
      validateStatus:  () => true,
    });
    if (imgRes.status !== 200) {
      throw new Error(`Image download failed (HTTP ${imgRes.status})`);
    }
    return {
      buffer:   Buffer.from(imgRes.data),
      filename: 'maya_gen.png',
      prompt,
    };
  }

  // If base64 returned
  if (result.b64_json) {
    return {
      buffer:   Buffer.from(result.b64_json, 'base64'),
      filename: 'maya_gen.png',
      prompt,
    };
  }

  throw new Error('Response had neither url nor b64_json');
}
