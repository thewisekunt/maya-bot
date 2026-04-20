/**
 * commitments.js — Maya's commitment tracking system
 *
 * When Maya says "I'll talk to you later", "hit me up at evening", "busy rn ttyl",
 * this module detects the commitment, stores it, and fires it at the right time.
 *
 * Architecture:
 *   Detection: LLM call on Maya's own reply (cheap, only when keywords present)
 *   Storage:   maya_commitments table
 *   Firing:    polled every 5 min (NOT dream cycle — commitments need real-time)
 *   Action:    Maya messages the user at the committed time
 *
 * NOTE: This module intentionally does NOT reply during the committed conversation.
 * When a commitment is detected, the CURRENT session is allowed to end naturally.
 * Maya fires the commitment later proactively via initiate.js style send.
 */

import db           from './db.js';
import { mayaSpeak } from './index.js';

const CHECK_INTERVAL_MS = 5 * 60_000;  // check every 5 min
let _client = null;
let _timer  = null;

// Keywords that suggest a commitment — cheap pre-filter before LLM
const COMMITMENT_KEYWORDS = /\b(later|baad mein|shaam ko|evening|raat ko|kal|tomorrow|ttyl|baat karte|talk later|ping me|msg me|will tell|bolunga|bolungi|bataunga|bataungi|aata hun|aati hun|free ho|free hounge|aajana|milte hain)\b/i;

export function startCommitmentEngine(discordClient) {
  _client = discordClient;
  _timer  = setInterval(_checkCommitments, CHECK_INTERVAL_MS);
  console.log('[commit] commitment engine started');
}

/**
 * Called after Maya sends a reply — check if she made a commitment.
 * @param {string} mayaReply — what Maya just said
 * @param {string} userId    — who she's talking to
 * @param {string} channelId
 * @param {string} guildId
 */
export async function detectCommitment(mayaReply, userId, channelId, guildId) {
  if (!mayaReply || !COMMITMENT_KEYWORDS.test(mayaReply)) return;

  try {
    const prompt = `Maya (a Discord user) just sent this message: "${mayaReply}"

Does this message contain a commitment to do something LATER (message someone, reply, tell them something, meet up, etc.)?

If yes, respond with JSON:
{"has_commitment": true, "action": "what she committed to", "trigger": "time|idle", "trigger_value": "evening|1h|tomorrow|later|etc"}

If no commitment, respond with:
{"has_commitment": false}

Only respond with valid JSON, no explanation.`;

    const { data, status } = await axios.post(config.llm.endpoint, {
      model:       config.llm.models.utility,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.0,
      max_tokens:  100,
    }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.llm.apiKey}` },
      timeout: 6000, validateStatus: () => true,
    });

    if (status !== 200) return;
    const raw  = data?.choices?.[0]?.message?.content?.trim() || '{}';
    const json = raw.replace(/^```json\s*/i,'').replace(/```\s*$/,'').trim();
    const result = JSON.parse(json);

    if (!result.has_commitment) return;

    // Compute fire_at from trigger_value
    const fireAt = _computeFireAt(result.trigger_value);

    await db.execute(
      `INSERT INTO maya_commitments
         (discord_user_id, guild_id, channel_id, commitment_text, trigger_type, trigger_value, fire_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, guildId || null, channelId, result.action || mayaReply, result.trigger || 'idle', result.trigger_value || 'later', fireAt]
    );
    console.log(`[commit] stored: "${result.action}" → fires at ${fireAt || 'unknown'}`);

  } catch (e) {
    console.warn('[commit] detection failed:', e.message);
  }
}

/**
 * Check for pending commitments that are due — fire them.
 */
async function _checkCommitments() {
  if (!_client?.isReady()) return;
  try {
    const [pending] = await db.execute(
      `SELECT * FROM maya_commitments
       WHERE status='pending'
         AND (fire_at IS NULL OR fire_at <= NOW())
         AND created_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)
       LIMIT 5`
    );

    for (const c of pending) {
      await _fireCommitment(c);
    }
  } catch (e) {
    console.error('[commit] check failed:', e.message);
  }
}

async function _fireCommitment(commitment) {
  try {
    // Build context for handler — tells Maya what she committed to
    // The full pipeline (IV → psyche → memory → LLM) will generate the actual message
    const speakContext = `Maya made a commitment earlier: "${commitment.commitment_text}". She is now following through on it. Reach out naturally — casual, nonchalant, like she just remembered.`;

    // Try DM first (more personal for commitment follow-ups), then channel
    const isDM = !commitment.channel_id;

    const sent = await mayaSpeak({
      channelId: commitment.channel_id || null,
      userId:    commitment.discord_user_id,
      guildId:   commitment.guild_id || null,
      isDM:      isDM || false,
      trigger:   'commitment',
      context:   speakContext,
      client:    _client,
    });

    // If channel send worked or DM worked, mark fired
    if (sent) {
      await db.execute(
        `UPDATE maya_commitments SET status='fired', fired_at=NOW() WHERE id=?`,
        [commitment.id]
      );
      console.log(`[commit] fired via pipeline: "${commitment.commitment_text}" → ${commitment.discord_user_id}`);
    } else {
      // mayaSpeak returned false — pipeline chose silence or channel unavailable
      // Mark as expired rather than pending so it doesn't keep retrying
      await db.execute(
        `UPDATE maya_commitments SET status='expired' WHERE id=?`,
        [commitment.id]
      );
      console.log(`[commit] pipeline chose silence for commitment → ${commitment.discord_user_id}`);
    }
  } catch (e) {
    console.error('[commit] fire failed:', e.message);
  }
}

function _computeFireAt(triggerValue) {
  if (!triggerValue) return null;
  const v = triggerValue.toLowerCase().trim();
  const now = new Date();

  if (/\d+h/.test(v)) {
    const h = parseInt(v);
    return new Date(now.getTime() + h * 3600000);
  }
  if (/\d+m/.test(v)) {
    const m = parseInt(v);
    return new Date(now.getTime() + m * 60000);
  }
  if (/evening|shaam/.test(v)) {
    const eve = new Date(now);
    eve.setHours(18, 0, 0, 0);
    if (eve <= now) eve.setDate(eve.getDate() + 1);
    return eve;
  }
  if (/night|raat/.test(v)) {
    const night = new Date(now);
    night.setHours(21, 0, 0, 0);
    if (night <= now) night.setDate(night.getDate() + 1);
    return night;
  }
  if (/tomorrow|kal/.test(v)) {
    const tom = new Date(now);
    tom.setDate(tom.getDate() + 1);
    tom.setHours(10, 0, 0, 0);
    return tom;
  }
  // "later" → 2 hours
  return new Date(now.getTime() + 2 * 3600000);
}
