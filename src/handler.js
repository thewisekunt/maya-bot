/**
 * handler.js — Full pipeline.
 * context → user → aliases → trust → vision → salience → LLM → persist → facts
 */

import { estimateEntropy, getEntropyZone, getKnownNames, getConfirmedFacts,
         extractAndStoreFact, getOrCreateRelationship, recordUserInteraction,
         upsertUser, detectNameSet, getFrequentInteractors } from './persona.js';
import { getMayaReply } from './llm.js';
import { buildContextLine } from './context.js';
import { checkSalience } from './salience.js';
import { extractMediaContext } from './vision.js';
import { debugLog } from './logger.js';
import db from './db.js';

export async function handleMessage({
  userId, username, displayName, avatarUrl,
  message, guildId, msg,
  isMention, isReply,
  hasMedia   = false,
  isLurking  = false,
  lurkDepth  = 0,
}) {
  // ── 1. Context ────────────────────────────────────────────────────────────
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
       WHERE discord_user_id = ? LIMIT 1`, [userId]);
    if (u) prefName = u.preferred_name || u.display_name || u.username || prefName;
  } catch {
    try {
      const [[p]] = await db.execute(
        `SELECT preferred_name, display_name, username FROM maya_personas
         WHERE discord_user_id = ? LIMIT 1`, [userId]);
      if (p) prefName = p.preferred_name || p.display_name || p.username || prefName;
    } catch { /* use displayName */ }
  }

  // ── 3. Name override ─────────────────────────────────────────────────────
  const nameMatch = message.match(/\bmy\s+name\s+is\s+([a-zA-Z][a-zA-Z\s]{0,30})/i);
  if (nameMatch) {
    const newName = nameMatch[1].trim();
    prefName = newName;
    db.execute(`UPDATE maya_users SET preferred_name=? WHERE discord_user_id=?`,
      [newName, userId]).catch(() =>
      db.execute(`UPDATE maya_personas SET preferred_name=? WHERE discord_user_id=?`,
        [newName, userId]).catch(() => {}));
  }

  // ── 4. Sync aliases — register all known names for this user ─────────────
  // Non-blocking: runs in background
  upsertUser(userId, username, displayName, prefName, guildId).catch(() => {});

  // ── 5. Trust — compute dynamically from interaction history ───────────────
  let trustLevel = 3;
  try {
    // First upsert the relationship row
    const counterCol = contextType === 'dm' ? 'dm_count' : 'server_count';
    await db.execute(
      `INSERT INTO maya_user_relationships
         (discord_user_id, total_messages, ${counterCol}, last_interaction)
       VALUES (?, 1, 1, NOW())
       ON DUPLICATE KEY UPDATE
         total_messages   = total_messages + 1,
         ${counterCol}    = ${counterCol} + 1,
         last_interaction = NOW()`,
      [userId]
    );
    // Then recalculate trust from the updated stats
    trustLevel = await getOrCreateRelationship(userId, contextType).then(r => r.trustLevel);
  } catch (e) {
    console.error('[handler] trust update:', e.message);
  }

  // ── 6. Known names in guild (for lurk friend-awareness) ──────────────────
  let knownUserNames = [];
  if (isLurking && guildId) {
    knownUserNames = await getKnownNames(guildId).catch(() => []);
  }

  // ── 7. Vision extraction ──────────────────────────────────────────────────
  let mediaContext    = '';
  let richMessageText = message;
  let visionWorked    = false;

  if (hasMedia) {
    try {
      const media = await extractMediaContext(msg);
      if (media.hasMedia) {
        mediaContext = media.mediaContext;
        visionWorked = media.visionWorked;
        richMessageText = message === '[media]'
          ? mediaContext
          : `${message}\n${mediaContext}`;
        console.log(`[vision] extracted (visionWorked=${visionWorked}): ${mediaContext.slice(0, 100)}`);
      }
    } catch (e) {
      console.error('[handler] vision:', e.message);
    }
  }

  // ── 8. Entropy + zone ─────────────────────────────────────────────────────
  const entropy = estimateEntropy(richMessageText);
  const { zone, line: zoneLine } = getEntropyZone(entropy);

  // ── 9. SALIENCE GATE ──────────────────────────────────────────────────────
  const salienceEntropy = (isMention || isDM || (hasMedia && visionWorked))
    ? Math.max(entropy, 0.6)
    : entropy;

  const salience = checkSalience({
    text:          richMessageText,
    isMention,
    isDM,
    isReply,
    hasMedia,
    isLurking,
    lurkDepth,
    trustLevel,
    entropy:       salienceEntropy,
    knownUserNames,
  });

  console.log(`[salience] user=${prefName} action=${salience.action} reason="${salience.reason}" trust=${trustLevel} media=${hasMedia}`);

  // ── IGNORE ────────────────────────────────────────────────────────────────
  if (salience.action === 'ignore') {
    _saveMemory(userId, prefName, guildId, channelId, contextType, isPrivate, entropy, message, null);
    debugLog({ userId, prefName, entropy, zone, message: richMessageText, reply: '[IGNORED]' });
    return null;
  }

  // ── REACT ─────────────────────────────────────────────────────────────────
  if (salience.action === 'react') {
    _saveMemory(userId, prefName, guildId, channelId, contextType, isPrivate, entropy,
      message, `*reacted with ${salience.emoji}*`);
    debugLog({ userId, prefName, entropy, zone, message: richMessageText, reply: `REACT:${salience.emoji}` });
    return { type: 'react', emoji: salience.emoji };
  }

  // ── REPLY — fetch memory + known facts + call LLM ────────────────────────

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

  // Reliable facts about this user
  const knownFacts = await getConfirmedFacts(userId).catch(() => []);

  // Upsert user (non-fatal)
  db.execute(
    `INSERT INTO maya_users (discord_user_id, username, display_name, avatar_url, message_count)
     VALUES (?,?,?,?,1)
     ON DUPLICATE KEY UPDATE
       display_name=VALUES(display_name), message_count=message_count+1, last_seen=NOW()`,
    [userId, username, displayName||username, avatarUrl||'']
  ).catch(() =>
    db.execute(
      `INSERT INTO maya_personas (discord_user_id, username, display_name, avatar_url)
       VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE display_name=VALUES(display_name)`,
      [userId, username, displayName||username, avatarUrl||'']
    ).catch(() => {})
  );

  // Build final message (inject "cannot see" if vision failed)
  let finalMessage = richMessageText;
  if (hasMedia && !visionWorked && message !== '[media]') {
    finalMessage = `${message}\n[Note: image/file attached but I cannot view it]`;
  } else if (hasMedia && !visionWorked && message === '[media]') {
    finalMessage = `[User sent an image I cannot view]`;
  }

  const forceVerbal = isMention || isDM || isReply;

  const result = await getMayaReply({
    prefName, context, message: finalMessage, entropy, zone, zoneLine,
    contextLine, knownFacts, relationship: { trustLevel },
    frequentFriends: [], forceVerbal,
  });

  const savedReply = result.type === 'react'
    ? `*reacted with ${result.emoji}*`
    : result.text;

  _saveMemory(userId, prefName, guildId, channelId, contextType, isPrivate,
    entropy, message === '[media]' ? mediaContext : message, savedReply);
  debugLog({ userId, prefName, entropy, zone, message: richMessageText, reply: savedReply });

  // ── Extract and store facts from this message (fire and forget) ─────────────
  extractAndStoreFact(userId, message).catch(() => {});

  return result;
}

// ── Memory save ───────────────────────────────────────────────────────────────
function _saveMemory(userId, prefName, guildId, channelId, contextType,
                     isPrivate, entropy, userMsg, mayaReply) {
  const saveNew = () => db.execute(
    `INSERT INTO maya_memory
       (discord_user_id, user_name, guild_id, channel_id,
        context_type, is_private, sender, message, entropy)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [userId, prefName, guildId||null, channelId,
     contextType, isPrivate?1:0, 'user', userMsg, entropy]
  ).then(() => mayaReply ? db.execute(
    `INSERT INTO maya_memory
       (discord_user_id, user_name, guild_id, channel_id,
        context_type, is_private, sender, message, entropy)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [userId, prefName, guildId||null, channelId,
     contextType, isPrivate?1:0, 'maya', mayaReply, entropy]
  ) : Promise.resolve());

  const saveOld = () => db.execute(
    `INSERT INTO maya_memory (discord_user_id, user_name, guild_id, sender, message, entropy)
     VALUES (?,?,?,'user',?,?)`, [userId, prefName, guildId||null, userMsg, entropy]
  ).then(() => mayaReply ? db.execute(
    `INSERT INTO maya_memory (discord_user_id, user_name, guild_id, sender, message, entropy)
     VALUES (?,?,?,'maya',?,?)`, [userId, prefName, guildId||null, mayaReply, entropy]
  ) : Promise.resolve());

  saveNew().catch(() => saveOld().catch(e => console.error('[handler] save:', e.message)));
}
