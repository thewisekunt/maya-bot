/**
 * vision.js — Image and embed reading
 *
 * Downloads images first (fixes 404 from direct Discord CDN URLs in
 * some hosting environments), sends as base64 to vision LLM.
 *
 * Returns structured media context:
 * {
 *   hasMedia:        bool
 *   hasImage:        bool    — at least one image was described
 *   imageDescs:      string[]
 *   embedSummaries:  string[]
 *   otherMedia:      string[]
 *   mediaContext:    string  — ready to inject into prompt
 *   suggestReply:    bool    — true if content seems worth a verbal reply
 * }
 */

import axios from 'axios';
import { config } from './config.js';

const VISION_MODEL = process.env.VISION_MODEL || 'google/gemini-flash-1.5';
const IMAGE_EXTS   = new Set(['jpg','jpeg','png','gif','webp','avif']);
const VIDEO_EXTS   = new Set(['mp4','mov','webm','avi','mkv']);
const AUDIO_EXTS   = new Set(['mp3','wav','ogg','flac','m4a']);

export async function extractMediaContext(msg) {
  const imageJobs      = [];
  const embedSummaries = [];
  const otherMedia     = [];

  // ── Attachments ───────────────────────────────────────────────────────────
  for (const att of msg.attachments.values()) {
    const ext = att.name?.split('.').pop()?.toLowerCase() || '';
    if (IMAGE_EXTS.has(ext) || att.contentType?.startsWith('image/')) {
      imageJobs.push({ url: att.url, name: att.name || 'image', type: 'attachment' });
    } else if (VIDEO_EXTS.has(ext) || att.contentType?.startsWith('video/')) {
      otherMedia.push(`[shared a video: ${att.name || 'video'}]`);
    } else if (AUDIO_EXTS.has(ext) || att.contentType?.startsWith('audio/')) {
      otherMedia.push(`[shared an audio file: ${att.name || 'audio'}]`);
    } else if (att.name) {
      otherMedia.push(`[shared a file: ${att.name}]`);
    }
  }

  // ── Stickers ──────────────────────────────────────────────────────────────
  for (const sticker of msg.stickers.values()) {
    otherMedia.push(`[used sticker: "${sticker.name}"]`);
  }

  // ── Embeds ────────────────────────────────────────────────────────────────
  for (const embed of msg.embeds) {
    const summary = summariseEmbed(embed);
    if (summary) embedSummaries.push(summary);
  }

  // ── Describe images (download first → base64) ─────────────────────────────
  const imageDescs = await Promise.all(imageJobs.map(img => describeImage(img)));

  // ── Decide if content is worth a verbal reply ─────────────────────────────
  // Images with real descriptions (not just fallback), questions in embeds,
  // or interesting media (not just a tenor GIF) suggest a reply is worthwhile
  const hasRealDescription = imageDescs.some(d => d && !d.includes('[shared an image'));
  const isJustGif = embedSummaries.every(s => s.toLowerCase().includes('gif'));
  const hasInterestingEmbed = embedSummaries.length > 0 && !isJustGif;
  const suggestReply = hasRealDescription || hasInterestingEmbed;

  const parts = [
    ...imageDescs.filter(Boolean),
    ...embedSummaries,
    ...otherMedia,
  ];

  return {
    hasMedia:       parts.length > 0,
    hasImage:       imageDescs.some(Boolean),
    imageDescs,
    embedSummaries,
    otherMedia,
    mediaContext:   parts.join('\n'),
    suggestReply,   // hint for salience: this media is worth talking about
  };
}

// ── Image description ─────────────────────────────────────────────────────────

async function describeImage({ url, name }) {
  try {
    // Step 1: Download the image as base64
    // This avoids 404s when the hosting environment can't reach Discord CDN directly
    let base64Data, mimeType;
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15_000,
        headers: { 'User-Agent': 'MayaBot/1.0' },
      });
      base64Data = Buffer.from(response.data).toString('base64');
      mimeType   = response.headers['content-type']?.split(';')[0] || 'image/jpeg';
    } catch (dlErr) {
      console.error(`[vision] download failed for ${name}: ${dlErr.message}`);
      return `[shared an image: ${name}]`;
    }

    // Step 2: Send to vision LLM as base64
    const { data, status } = await axios.post(
      config.llm.endpoint,
      {
        model: VISION_MODEL,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64Data}`,
              },
            },
            {
              type: 'text',
              text: 'Describe this image in 1–2 sentences. Be factual. If it\'s a meme, describe what it shows and the text/joke if any.',
            },
          ],
        }],
        max_tokens:  150,
        temperature: 0.2,
      },
      {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.llm.apiKey}`,
          'HTTP-Referer':  'https://chatmasala.fun',
          'X-Title':       'MayaDiscordBot',
        },
        timeout: 25_000,
        validateStatus: () => true,
      }
    );

    if (status !== 200) {
      console.error(`[vision] LLM HTTP ${status} for ${name}`);
      return `[shared an image: ${name}]`;
    }

    const desc = data?.choices?.[0]?.message?.content?.trim();
    if (!desc) return `[shared an image: ${name}]`;

    console.log(`[vision] described "${name}": ${desc.slice(0, 80)}`);
    return `[image: ${desc}]`;

  } catch (err) {
    console.error(`[vision] describeImage error for ${name}:`, err.message);
    return `[shared an image: ${name}]`;
  }
}

// ── Embed text extraction ─────────────────────────────────────────────────────

function summariseEmbed(embed) {
  const parts = [];
  const url      = embed.url || '';
  const provider = embed.provider?.name?.toLowerCase() || '';

  let platform = '';
  if (provider.includes('youtube') || url.includes('youtu'))   platform = 'YouTube video';
  else if (provider.includes('spotify') || url.includes('spotify')) platform = 'Spotify';
  else if (url.includes('twitter.com') || url.includes('x.com'))    platform = 'Tweet';
  else if (url.includes('instagram.com'))                            platform = 'Instagram post';
  else if (url.includes('reddit.com'))                               platform = 'Reddit post';
  else if (url.includes('github.com'))                               platform = 'GitHub';
  else if (url.includes('tenor.com') || url.includes('giphy.com'))   platform = 'GIF';
  else if (embed.type === 'image')                                    platform = 'image link';
  else if (embed.type === 'video')                                    platform = 'video';
  else platform = provider || 'link';

  const label = `[${platform}`;
  if (embed.title)       parts.push(`${label}: "${embed.title}"${url ? ` — ${url}` : ''}]`);
  else if (embed.description) {
    const short = embed.description.slice(0,120).replace(/\n/g,' ');
    parts.push(`${label}: ${short}${embed.description.length > 120 ? '…' : ''}]`);
  }
  else if (url)          parts.push(`${label}: ${url}]`);

  if (embed.author?.name) parts.push(`  by ${embed.author.name}`);

  if (embed.fields?.length) {
    parts.push(embed.fields.slice(0,3)
      .map(f => `  ${f.name}: ${f.value.slice(0,80)}`).join('\n'));
  }

  return parts.join('\n') || null;
}
