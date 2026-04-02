/**
 * selfupdate.js — Maya's self-modification capabilities
 *
 * Lets Maya update her own Discord profile:
 *   - Display name (per-server nickname or global username)
 *   - Avatar (profile picture)
 *   - Bio (about me)
 *
 * Also handles user avatar description requests:
 *   - Detects when someone asks Maya to look at/describe their pfp
 *   - Downloads and describes the avatar via vision LLM
 *   - Stores the description in maya_users for future recall
 *
 * Trigger detection is local (no LLM cost) — regex patterns.
 * The actual description uses the existing vision LLM pipeline.
 */

import axios from 'axios';
import db from './db.js';
import { config } from './config.js';

const VISION_MODEL = process.env.VISION_MODEL || 'openai/gpt-4o-mini';

// ── Trigger detection ─────────────────────────────────────────────────────────

const PFP_REQUEST_PATTERNS = [
  /\b(can you |could you |do you )?(see|look at|check|view|describe|rate)\b.{0,20}\b(my |my pfp|my dp|my avatar|my profile pic)/i,
  /\bwhat do you think of my (pfp|dp|avatar|profile pic)/i,
  /\bhow('s| is) my (pfp|dp|avatar|profile pic)/i,
  /\brate my (pfp|dp|avatar|profile pic)/i,
  /\bcan you see my (pfp|dp|avatar|profile pic)/i,
  /\bdo you (see|notice|remember) my (pfp|dp|avatar|profile pic)/i,
  /\bmy (pfp|dp|avatar|profile pic)\b/i,
  /\b(pfp|dp)\b/i,   // short form, common in Discord
];

const RECALL_PFP_PATTERNS = [
  /\bdo you remember my (pfp|dp|avatar|profile pic)/i,
  /\bwhat('s| is| was) my (pfp|dp|avatar|profile pic)/i,
  /\bdescribe my (pfp|dp|avatar|profile pic)/i,
  /\bremember my (pfp|dp|avatar|profile pic)/i,
];

// Maya self-update triggers
const SELF_NAME_PATTERNS = [
  /\bchange your (name|username|display name|nickname)\b.{0,30}(to |as )?["']?([^"'\n]{2,30})["']?/i,
  /\brename (yourself|you) (to |as )?["']?([^"'\n]{2,30})["']?/i,
];

const SELF_AVATAR_PATTERNS = [
  /\bchange your (pfp|dp|avatar|profile pic)\b/i,
  /\bupdate your (pfp|dp|avatar|profile pic)\b/i,
  /\bset your (pfp|dp|avatar|profile pic)\b/i,
];

const SELF_BIO_PATTERNS = [
  /\bchange your bio\b.{0,60}/i,
  /\bupdate your bio\b.{0,60}/i,
  /\bset your bio\b.{0,60}/i,
  /\bwrite your bio\b.{0,60}/i,
];

// ── Detection ─────────────────────────────────────────────────────────────────

export function detectPfpRequest(text) {
  if (RECALL_PFP_PATTERNS.some(p => p.test(text))) return 'recall';
  if (PFP_REQUEST_PATTERNS.some(p => p.test(text))) return 'describe';
  return null;
}

export function detectSelfUpdate(text) {
  if (SELF_AVATAR_PATTERNS.some(p => p.test(text))) return { type: 'avatar' };
  if (SELF_BIO_PATTERNS.some(p => p.test(text))) {
    // Extract bio text — everything after "bio to/as/:" 
    const m = text.match(/\b(?:change|update|set|write) your bio\b[^:]*:?\s*(.{5,200})/i);
    return { type: 'bio', text: m?.[1]?.trim() || null };
  }
  for (const p of SELF_NAME_PATTERNS) {
    const m = text.match(p);
    if (m) {
      const name = (m[3] || m[2] || '').trim().replace(/['"]/g, '');
      if (name.length >= 2) return { type: 'name', name };
    }
  }
  return null;
}

// ── User avatar description ───────────────────────────────────────────────────

/**
 * Describe a user's avatar and store it in the DB.
 * Called when user asks Maya to look at their pfp.
 *
 * @param {string} userId
 * @param {string} avatarUrl   — Discord CDN URL
 * @param {string} userName
 * @returns {Promise<string>}  — the description
 */
export async function describeAndStoreAvatar(userId, avatarUrl, userName) {
  // Download avatar
  let base64Data, mimeType;
  try {
    const res = await axios.get(avatarUrl, {
      responseType: 'arraybuffer',
      timeout: 15_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MayaBot/2.0)' },
    });
    mimeType   = res.headers['content-type']?.split(';')[0]?.trim() || 'image/jpeg';
    base64Data = Buffer.from(res.data).toString('base64');
    console.log(`[selfupdate] downloaded avatar for ${userName} (${Math.round(res.data.byteLength/1024)}KB)`);
  } catch (e) {
    console.error('[selfupdate] avatar download failed:', e.message);
    return null;
  }

  // Describe via vision LLM
  let description;
  try {
    const { data, status } = await axios.post(
      config.llm.endpoint,
      {
        model: VISION_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } },
            {
              type: 'text',
              text: `Describe this Discord profile picture in 2-3 sentences. Be specific and visual — mention colours, style, subject, mood. This is ${userName}'s avatar.`,
            },
          ],
        }],
        max_tokens: 150,
        temperature: 0.2,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.llm.apiKey}`,
          'HTTP-Referer': 'https://chatmasala.fun',
          'X-Title': 'MayaDiscordBot',
        },
        timeout: 25_000,
        validateStatus: () => true,
      }
    );

    if (status !== 200) throw new Error(`HTTP ${status}`);
    description = data?.choices?.[0]?.message?.content?.trim();
    if (!description) throw new Error('empty response');
    console.log(`[selfupdate] described avatar for ${userName}: ${description.slice(0, 80)}`);
  } catch (e) {
    console.error('[selfupdate] vision failed:', e.message);
    return null;
  }

  // Store in DB
  try {
    await db.execute(
      `UPDATE maya_users
       SET avatar_description = ?, avatar_described_at = NOW()
       WHERE discord_user_id = ?`,
      [description, userId]
    );
  } catch (e) {
    console.error('[selfupdate] DB store failed:', e.message);
  }

  return description;
}

/**
 * Recall a stored avatar description for a user.
 */
export async function recallAvatar(userId) {
  try {
    const [[row]] = await db.execute(
      `SELECT avatar_description, avatar_described_at FROM maya_users
       WHERE discord_user_id = ? LIMIT 1`,
      [userId]
    );
    return row?.avatar_description || null;
  } catch { return null; }
}

// ── Maya self-update ──────────────────────────────────────────────────────────

/**
 * Update Maya's display name.
 * In a server: changes nickname. Global: changes username (rate-limited by Discord).
 *
 * @param {Client}  client
 * @param {Message} msg
 * @param {string}  newName
 */
export async function updateName(client, msg, newName) {
  // Sanitise name
  const clean = newName.replace(/[^\w\s\-_.]/g, '').trim().slice(0, 32);
  if (clean.length < 2) return { success: false, reason: 'name too short or invalid' };

  try {
    if (msg.guild) {
      // Change server nickname (preferred — doesn't affect global username)
      await msg.guild.members.me.setNickname(clean);
      console.log(`[selfupdate] nickname set to "${clean}" in guild ${msg.guild.name}`);
      return { success: true, name: clean, scope: 'server' };
    } else {
      // DM context — change global display name
      // Note: Discord rate-limits username changes to 2 per hour
      await client.user.setUsername(clean);
      console.log(`[selfupdate] global username set to "${clean}"`);
      return { success: true, name: clean, scope: 'global' };
    }
  } catch (e) {
    console.error('[selfupdate] name change failed:', e.message);
    return { success: false, reason: e.message };
  }
}

/**
 * Update Maya's avatar.
 * Expects an image attachment in the message.
 *
 * @param {Client}  client
 * @param {Message} msg
 */
export async function updateAvatar(client, msg) {
  // Find image attachment
  const att = [...msg.attachments.values()].find(a => {
    const ext = a.name?.split('.').pop()?.toLowerCase() || '';
    return ['jpg','jpeg','png','gif','webp'].includes(ext) || a.contentType?.startsWith('image/');
  });

  if (!att) return { success: false, reason: 'no image attached' };

  try {
    const res = await axios.get(att.url, {
      responseType: 'arraybuffer',
      timeout: 15_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MayaBot/2.0)' },
    });
    const buffer = Buffer.from(res.data);
    await client.user.setAvatar(buffer);
    console.log(`[selfupdate] avatar updated`);
    return { success: true };
  } catch (e) {
    console.error('[selfupdate] avatar update failed:', e.message);
    return { success: false, reason: e.message };
  }
}

/**
 * Update Maya's bio (about me).
 * Note: Discord API allows setting bio via REST — discord.js doesn't expose this
 * directly, so we use the raw API endpoint.
 *
 * @param {Client} client
 * @param {string} bioText
 */
export async function updateBio(client, bioText) {
  const clean = bioText.trim().slice(0, 190);  // Discord bio limit: 190 chars
  if (clean.length < 2) return { success: false, reason: 'bio too short' };

  try {
    await axios.patch(
      'https://discord.com/api/v10/users/@me',
      { bio: clean },
      {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bot ${config.discord.token}`,
        },
        timeout: 10_000,
        validateStatus: () => true,
      }
    );
    console.log(`[selfupdate] bio updated: "${clean.slice(0, 50)}..."`);
    return { success: true, bio: clean };
  } catch (e) {
    console.error('[selfupdate] bio update failed:', e.message);
    return { success: false, reason: e.message };
  }
}
