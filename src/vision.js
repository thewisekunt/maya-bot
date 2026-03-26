/**
 * vision.js — Image and embed reading for Maya
 *
 * Discord CDN URLs expire and are auth-protected, so direct URL
 * passing to vision LLMs fails with 404.
 *
 * Fix: download image → base64 → send as data URI.
 *
 * Returns a structured result including whether the image was
 * actually described (visionWorked flag). When vision fails,
 * handler tells Maya explicitly she cannot see the image —
 * preventing hallucination.
 */

import axios from 'axios';
import { config } from './config.js';

// Use a vision-capable model. gpt-4o-mini supports vision.
// gemini-flash-1.5 also works but may have different base64 limits.
const VISION_MODEL = process.env.VISION_MODEL || 'openai/gpt-4o-mini';

const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','avif','bmp']);
const VIDEO_EXTS = new Set(['mp4','mov','webm','avi','mkv','m4v']);
const AUDIO_EXTS = new Set(['mp3','wav','ogg','flac','m4a','aac']);

// Max image size to attempt vision on (5MB — larger images are too slow/expensive)
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Message} msg  Discord.js message
 * @returns {Promise<{
 *   hasMedia:        boolean,
 *   visionWorked:    boolean,   ← true if at least one image was described
 *   mediaContext:    string,    ← inject into LLM prompt
 *   embedSummaries:  string[],
 *   imageDescs:      string[],
 * }>}
 */
export async function extractMediaContext(msg) {
  const imageJobs      = [];
  const embedSummaries = [];
  const otherMedia     = [];

  // ── Attachments ───────────────────────────────────────────────────────────
  for (const att of msg.attachments.values()) {
    const ext = att.name?.split('.').pop()?.toLowerCase() || '';
    const ct  = att.contentType || '';
    if (IMAGE_EXTS.has(ext) || ct.startsWith('image/')) {
      imageJobs.push({ url: att.url, name: att.name || 'image', size: att.size || 0 });
    } else if (VIDEO_EXTS.has(ext) || ct.startsWith('video/')) {
      otherMedia.push(`[shared a video: ${att.name || 'video'}]`);
    } else if (AUDIO_EXTS.has(ext) || ct.startsWith('audio/')) {
      otherMedia.push(`[shared audio: ${att.name || 'audio'}]`);
    } else if (att.name) {
      otherMedia.push(`[shared a file: ${att.name}]`);
    }
  }

  // ── Stickers ──────────────────────────────────────────────────────────────
  for (const s of msg.stickers.values()) {
    otherMedia.push(`[used sticker: "${s.name}"]`);
  }

  // ── Embeds ────────────────────────────────────────────────────────────────
  for (const embed of msg.embeds) {
    const s = _summariseEmbed(embed);
    if (s) embedSummaries.push(s);
  }

  // ── Describe images ───────────────────────────────────────────────────────
  // Run in parallel but cap at 3 images max
  const imageResults = await Promise.all(
    imageJobs.slice(0, 3).map(j => _describeImage(j))
  );

  const imageDescs   = imageResults.map(r => r.text);
  const visionWorked = imageResults.some(r => r.described);

  const parts = [
    ...imageDescs.filter(Boolean),
    ...embedSummaries,
    ...otherMedia,
  ];

  return {
    hasMedia:      parts.length > 0,
    visionWorked,
    mediaContext:  parts.join('\n'),
    embedSummaries,
    imageDescs,
  };
}

// ── Image description ─────────────────────────────────────────────────────────

/**
 * @returns {{ text: string, described: boolean }}
 *   described=true  → LLM actually saw and described the image
 *   described=false → fallback label only, LLM should not speculate
 */
async function _describeImage({ url, name, size }) {
  const fallback = { text: `[image attached: could not view]`, described: false };

  // Skip huge images
  if (size && size > MAX_IMAGE_BYTES) {
    console.log(`[vision] skipping large image (${Math.round(size/1024)}KB): ${name}`);
    return { text: `[image attached: too large to view]`, described: false };
  }

  // ── Step 1: Download as buffer ────────────────────────────────────────────
  let base64Data, mimeType;
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout:      15_000,
      maxContentLength: MAX_IMAGE_BYTES,
      headers: {
        // Discord CDN requires a browser-like user agent
        'User-Agent': 'Mozilla/5.0 (compatible; MayaBot/2.0)',
      },
    });
    mimeType   = res.headers['content-type']?.split(';')[0]?.trim() || 'image/jpeg';
    base64Data = Buffer.from(res.data).toString('base64');
    console.log(`[vision] downloaded ${name} (${Math.round(res.data.byteLength/1024)}KB, ${mimeType})`);
  } catch (err) {
    console.warn(`[vision] download failed for ${name}: ${err.message}`);
    return fallback;
  }

  // ── Step 2: Send to vision LLM ────────────────────────────────────────────
  try {
    const { data, status } = await axios.post(
      config.llm.endpoint,
      {
        model: VISION_MODEL,
        messages: [{
          role: 'user',
          content: [
            {
              type:      'image_url',
              image_url: { url: `data:${mimeType};base64,${base64Data}` },
            },
            {
              type: 'text',
              text: 'Describe this image in 1–2 sentences. Be factual and specific. '
                  + 'If it\'s a meme, describe what is shown and the text/joke. '
                  + 'Do not guess or assume anything not visible.',
            },
          ],
        }],
        max_tokens:  150,
        temperature: 0.1,
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

    if (status !== 200) {
      console.warn(`[vision] LLM HTTP ${status} for ${name}:`, JSON.stringify(data).slice(0, 200));
      return fallback;
    }

    const desc = data?.choices?.[0]?.message?.content?.trim();
    if (!desc) return fallback;

    console.log(`[vision] described "${name}": ${desc.slice(0, 100)}`);
    return { text: `[image: ${desc}]`, described: true };

  } catch (err) {
    console.warn(`[vision] LLM call failed for ${name}:`, err.message);
    return fallback;
  }
}

// ── Embed summariser ──────────────────────────────────────────────────────────

function _summariseEmbed(embed) {
  const parts   = [];
  const url     = embed.url || embed.video?.url || '';
  const prov    = (embed.provider?.name || '').toLowerCase();

  let platform = 'link';
  if (prov.includes('youtube') || url.includes('youtu'))       platform = 'YouTube video';
  else if (prov.includes('spotify') || url.includes('spotify')) platform = 'Spotify track';
  else if (url.includes('twitter.com') || url.includes('x.com')) platform = 'Tweet';
  else if (url.includes('instagram.com'))  platform = 'Instagram post';
  else if (url.includes('reddit.com'))     platform = 'Reddit post';
  else if (url.includes('github.com'))     platform = 'GitHub link';
  else if (url.includes('tenor.com') || url.includes('giphy.com')) platform = 'GIF';
  else if (embed.type === 'image')         platform = 'image link';
  else if (embed.type === 'video')         platform = 'video';
  else if (prov)                           platform = prov;

  if (embed.title) {
    parts.push(`[${platform}: "${embed.title}"${url ? ` — ${url}` : ''}]`);
  } else if (embed.description) {
    const d = embed.description.slice(0, 120).replace(/\n/g, ' ');
    parts.push(`[${platform}: ${d}]`);
  } else if (url) {
    parts.push(`[${platform}: ${url}]`);
  }

  if (embed.author?.name)   parts.push(`  by ${embed.author.name}`);
  if (embed.fields?.length) {
    embed.fields.slice(0, 2).forEach(f =>
      parts.push(`  ${f.name}: ${f.value.slice(0, 60)}`)
    );
  }

  return parts.join('\n') || null;
}
