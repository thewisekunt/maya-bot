/**
 * vision.js — Image and embed reading for Maya
 *
 * Extracts visual/rich content from Discord messages:
 *   - Image attachments (jpg, png, gif, webp)
 *   - Stickers (converted to description)
 *   - Discord embeds (link previews, Spotify, YouTube, Twitter/X, etc.)
 *   - Video/file attachments (described by type only)
 *
 * For images: calls a vision LLM to get a description.
 * For embeds: pure text extraction, no extra API call.
 */

import axios from 'axios';
import { config } from './config.js';

// Vision model — must support image_url content blocks
// gemini-flash is fast, cheap, and great at image description
const VISION_MODEL = process.env.VISION_MODEL || 'google/gemini-flash-1.5';

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'avi', 'mkv']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a']);

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract all rich content from a Discord message.
 *
 * @param {Message} msg  Discord.js message object
 * @returns {Promise<{
 *   hasMedia:    boolean,
 *   imageDescs:  string[],   // LLM descriptions of images
 *   embedSummaries: string[], // text summaries of embeds
 *   mediaContext: string,    // single string ready to inject into prompt
 * }>}
 */
export async function extractMediaContext(msg) {
  const imageUrls     = [];
  const embedSummaries = [];
  const otherMedia    = [];

  // ── 1. Attachments ────────────────────────────────────────────────────────
  for (const att of msg.attachments.values()) {
    const ext = att.name?.split('.').pop()?.toLowerCase() || '';
    if (IMAGE_EXTS.has(ext) || att.contentType?.startsWith('image/')) {
      imageUrls.push({ url: att.url, name: att.name || 'image' });
    } else if (VIDEO_EXTS.has(ext) || att.contentType?.startsWith('video/')) {
      otherMedia.push(`[sent a video: ${att.name || 'video file'}]`);
    } else if (AUDIO_EXTS.has(ext) || att.contentType?.startsWith('audio/')) {
      otherMedia.push(`[sent an audio file: ${att.name || 'audio'}]`);
    } else if (att.name) {
      otherMedia.push(`[sent a file: ${att.name}]`);
    }
  }

  // ── 2. Stickers ───────────────────────────────────────────────────────────
  for (const sticker of msg.stickers.values()) {
    otherMedia.push(`[used sticker: "${sticker.name}"]`);
  }

  // ── 3. Embeds (link previews, bot cards, etc.) ────────────────────────────
  for (const embed of msg.embeds) {
    const summary = summariseEmbed(embed);
    if (summary) embedSummaries.push(summary);
  }

  // ── 4. Describe images via vision LLM ────────────────────────────────────
  const imageDescs = [];
  for (const img of imageUrls) {
    const desc = await describeImage(img.url, img.name);
    if (desc) imageDescs.push(desc);
  }

  // ── 5. Assemble context string ────────────────────────────────────────────
  const parts = [
    ...imageDescs,
    ...embedSummaries,
    ...otherMedia,
  ];

  const hasMedia = parts.length > 0;
  const mediaContext = parts.join('\n');

  return { hasMedia, imageDescs, embedSummaries, mediaContext };
}

// ── Image description via vision LLM ─────────────────────────────────────────

async function describeImage(imageUrl, fileName = 'image') {
  try {
    const { data, status } = await axios.post(
      config.llm.endpoint,
      {
        model: VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: imageUrl },
              },
              {
                type: 'text',
                text: 'Describe this image briefly in 1-2 sentences. Be factual and concise. If it\'s a meme, describe what it shows and the joke/caption if visible.',
              },
            ],
          },
        ],
        max_tokens: 150,
        temperature: 0.3,
      },
      {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.llm.apiKey}`,
          'HTTP-Referer':  'https://chatmasala.fun',
          'X-Title':       'MayaDiscordBot',
        },
        timeout: 20_000,
        validateStatus: () => true,
      }
    );

    if (status !== 200) {
      console.error(`[vision] HTTP ${status} for image description`);
      return `[shared an image: ${fileName}]`;
    }

    const desc = data?.choices?.[0]?.message?.content?.trim();
    if (!desc) return `[shared an image: ${fileName}]`;

    return `[image: ${desc}]`;

  } catch (err) {
    console.error('[vision] describeImage error:', err.message);
    return `[shared an image: ${fileName}]`;
  }
}

// ── Embed text extraction ─────────────────────────────────────────────────────

function summariseEmbed(embed) {
  const parts = [];

  // Detect embed type from provider/url
  const url      = embed.url || embed.video?.url || '';
  const provider = embed.provider?.name?.toLowerCase() || '';
  const type     = embed.type || '';

  // Platform-specific labels
  let platform = '';
  if (provider.includes('youtube') || url.includes('youtube.com') || url.includes('youtu.be')) {
    platform = 'YouTube video';
  } else if (provider.includes('spotify') || url.includes('spotify.com')) {
    platform = 'Spotify';
  } else if (url.includes('twitter.com') || url.includes('x.com')) {
    platform = 'Tweet';
  } else if (url.includes('instagram.com')) {
    platform = 'Instagram post';
  } else if (url.includes('reddit.com')) {
    platform = 'Reddit post';
  } else if (url.includes('github.com')) {
    platform = 'GitHub';
  } else if (url.includes('tenor.com') || url.includes('giphy.com')) {
    platform = 'GIF';
  } else if (type === 'image') {
    platform = 'image link';
  } else if (type === 'video') {
    platform = 'video';
  } else {
    platform = provider || 'link';
  }

  // Build summary
  const label = platform ? `[${platform}` : '[link';

  if (embed.title) {
    parts.push(`${label}: "${embed.title}"${embed.url ? ` — ${embed.url}` : ''}]`);
  } else if (embed.description) {
    const shortDesc = embed.description.slice(0, 120).replace(/\n/g, ' ');
    parts.push(`${label}: ${shortDesc}${embed.description.length > 120 ? '…' : ''}]`);
  } else if (embed.url) {
    parts.push(`${label}: ${embed.url}]`);
  }

  // Author info (useful for tweets, reddit posts)
  if (embed.author?.name) {
    parts.push(`  by ${embed.author.name}`);
  }

  // Fields (Discord bot embeds, GitHub etc.)
  if (embed.fields?.length) {
    const fieldText = embed.fields
      .slice(0, 3)
      .map(f => `  ${f.name}: ${f.value.slice(0, 80)}`)
      .join('\n');
    parts.push(fieldText);
  }

  return parts.join('\n') || null;
}
