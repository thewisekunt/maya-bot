/**
 * handler.js — Master pipeline with salience gate.
 *
 * Flow: context → user → salience check → (ignore/react/LLM) → persist
 */

import { estimateEntropy, getEntropyZone } from './persona.js';
import { getMayaReply } from './llm.js';
import { buildContextLine } from './context.js';
import { checkSalience } from './salience.js';
import { debugLog } from './logger.js';
import db from './db.js';

export async function handleMessage({
  userId, username, displayName, avatarUrl, message, guildId,
  msg,        // raw Discord.js Message
  isMention,  // bool
  isReply,    // bool — is this a reply to Maya's message?
}) {
  // ── 1. Context basics ─────────────────────────────────────────────────────
  const isDM        = !msg.guild;
  const contextType = isDM ? 'dm' : 'server';
  const isPrivate   = isDM;
  const channelId   = msg.channel?.id    || null;
  const channelName = isDM ? 'DM' : (msg.channel?.name || 'unknown');
  const guildName   = msg.guild?.name    || null;
  const topic       = msg.channel?.topic || null;
  const contextLine = buildContextLine(contextType, channelName, guildName, topic);

  // ── 2. Preferred name ─────────────────────────────────────────────────────
  let prefName = displayName || username;
  try {
    const [[u]] = await db.execute(
      `SELECT preferred_name, display_name, username FROM maya_users
       WHERE discord_user_id=? LIMIT 1`, [userId]);
    if (u) prefName = u.preferred_name || u.display_name || u.username || prefName;
  } catch {
    try {
      const [[p]] = await db.execute(
        `SELECT preferred_name, display_name, username FROM maya_personas
         WHERE discord_user_id=? LIMIT 1`, [userId]);
      if (p) prefName = p.preferred_name || p.display_name || p.username || prefName;
    } catch { /* use displayName */ }
  }

  // "My name is X"
  const nameMatch = message.match(/\bmy\s+name\s+is\s+([a-zA-Z][a-zA-Z\s]{0,30})/i);
  if (nameMatch) {
    const newName = nameMatch[1].trim();
    prefName = newName;
    db.execute(`UPDATE maya_users SET preferred_name=? WHERE discord_user_id=?`,
      [newName, userId]).catch(() =>
      db.execute(`UPDATE maya_personas SET preferred_name=? WHERE discord_user_id=?`,
        [newName, userId]).catch(() => {}));
  }

  // ── 3. Entropy + zone ─────────────────────────────────────────────────────
  const entropy = estimateEntropy(message);
  const { zone, line: zoneLine } = getEntropyZone(entropy);

  // ── 4. Load trust level for salience ─────────────────────────────────────
  let trustLevel = 3;
  try {
    const [[rel]] = await db.execute(
      `SELECT trust_level FROM maya_user_relationships
       WHERE discord_user_id=? LIMIT 1`, [userId]);
    if (rel) trustLevel = rel.trust_level || 3;
  } catch { /* default 3 */ }

  // ── 5. SALIENCE GATE — decide before calling LLM ─────────────────────────
  const salience = checkSalience({
    text: message,
    isMention,
    isDM,
    isReply,
    trustLevel,
    entropy,
  });

  console.log(`[salience] user=${prefName} action=${salience.action} reason="${salience.reason}"`);

  // ── IGNORE — save message to memory, return null (no response) ───────────
  if (salience.action === 'ignore') {
    _saveMemory(userId, prefName, guildId, channelId, contextType, isPrivate, entropy, message, null);
    debugLog({ userId, prefName, entropy, zone, message, reply: '[IGNORED]' });
    return null;
  }

  // ── REACT — return emoji immediately, no LLM call ────────────────────────
  if (salience.action === 'react') {
    _saveMemory(userId, prefName, guildId, channelId, contextType, isPrivate, entropy,
      message, `*reacted with ${salience.emoji}*`);
    debugLog({ userId, prefName, entropy, zone, message, reply: `REACT:${salience.emoji}` });
    return { type: 'react', emoji: salience.emoji };
  }

  // ── REPLY — fetch memory + call LLM ──────────────────────────────────────

  // Memory context
  let context = '';
  try {
    const [rows] = isDM
      ? await db.execute(
          `SELECT sender, message FROM maya_memory
           WHERE discord_user_id=? AND context_type='dm'
           ORDER BY created_at DESC LIMIT 20`, [userId])
      : await db.execute(
          `SELECT sender, message FROM maya_memory
           WHERE discord_user_id=? AND context_type='server'
           ORDER BY created_at DESC LIMIT 20`, [userId]);
    context = rows.reverse().map(r =>
      `${r.sender === 'maya' ? 'Maya' : prefName}: ${r.message}`).join('\n');
  } catch {
    try {
      const [rows] = await db.execute(
        `SELECT sender, message FROM maya_memory
         WHERE discord_user_id=? ORDER BY created_at DESC LIMIT 20`, [userId]);
      context = rows.reverse().map(r =>
        `${r.sender === 'maya' ? 'Maya' : prefName}: ${r.message}`).join('\n');
    } catch { /* no context */ }
  }

  // Upsert user (non-fatal)
  db.execute(
    `INSERT INTO maya_users (discord_user_id, username, display_name, avatar_url, message_count)
     VALUES (?,?,?,?,1)
     ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), message_count=message_count+1, last_seen=NOW()`,
    [userId, username, displayName||username, avatarUrl||'']
  ).catch(() =>
    db.execute(
      `INSERT INTO maya_personas (discord_user_id, username, display_name, avatar_url)
       VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE display_name=VALUES(display_name)`,
      [userId, username, displayName||username, avatarUrl||'']
    ).catch(() => {})
  );

  // Call LLM
  const result = await getMayaReply({
    prefName, context, message, entropy, zone, zoneLine,
    contextLine, knownFacts: [], relationship: null, frequentFriends: [],
  });

  const savedReply = result.type === 'react'
    ? `*reacted with ${result.emoji}*`
    : result.text;

  _saveMemory(userId, prefName, guildId, channelId, contextType, isPrivate,
    entropy, message, savedReply);
  debugLog({ userId, prefName, entropy, zone, message, reply: savedReply });

  return result;
}

// ── Save both sides of exchange to memory ────────────────────────────────────
function _saveMemory(userId, prefName, guildId, channelId, contextType,
                     isPrivate, entropy, userMsg, mayaReply) {
  const saveNew = () => db.execute(
    `INSERT INTO maya_memory
       (discord_user_id, user_name, guild_id, channel_id, context_type, is_private, sender, message, entropy)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [userId, prefName, guildId||null, channelId, contextType, isPrivate?1:0, 'user', userMsg, entropy]
  ).then(() => mayaReply ? db.execute(
    `INSERT INTO maya_memory
       (discord_user_id, user_name, guild_id, channel_id, context_type, is_private, sender, message, entropy)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [userId, prefName, guildId||null, channelId, contextType, isPrivate?1:0, 'maya', mayaReply, entropy]
  ) : Promise.resolve());

  const saveOld = () => db.execute(
    `INSERT INTO maya_memory (discord_user_id, user_name, guild_id, sender, message, entropy)
     VALUES (?,?,?,'user',?,?)`, [userId, prefName, guildId||null, userMsg, entropy]
  ).then(() => mayaReply ? db.execute(
    `INSERT INTO maya_memory (discord_user_id, user_name, guild_id, sender, message, entropy)
     VALUES (?,?,?,'maya',?,?)`, [userId, prefName, guildId||null, mayaReply, entropy]
  ) : Promise.resolve());

  saveNew().catch(() => saveOld().catch(e =>
    console.error('[handler] save failed:', e.message)));
}
