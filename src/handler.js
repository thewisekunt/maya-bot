/**
 * handler.js — Master pipeline
 *
 * Orchestrates: context detection → user upsert → relationship load
 *   → fact extraction → memory fetch → LLM call → persist → return
 */

import { upsertUser, detectNameSet, getEntropyZone, estimateEntropy,
         extractAndStoreFact, getOrCreateRelationship,
         getFrequentInteractors, recordUserInteraction } from './persona.js';
import { getContext, saveMessage } from './memory.js';
import { getMayaReply } from './llm.js';
import { upsertGuild, upsertChannel, buildContextLine } from './context.js';
import { debugLog } from './logger.js';

/**
 * @param {object} params
 *   userId, username, displayName, avatarUrl, message, guildId,
 *   msg   — the raw Discord.js Message object (for guild/channel details)
 *
 * @returns {{ type: 'reply', text } | { type: 'react', emoji }}
 */
export async function handleMessage({
  userId, username, displayName, avatarUrl, message, guildId, msg,
}) {
  // ── 1. Context: guild + channel ─────────────────────────────────────────────
  await upsertGuild(msg.guild);
  const { contextType, isPrivate, channelName, channelId, topic } =
    await upsertChannel(msg);

  const guildName = msg.guild?.name || null;
  const contextLine = buildContextLine(contextType, channelName, guildName, topic);

  // ── 2. User upsert ──────────────────────────────────────────────────────────
  let { prefName, knownFacts } = await upsertUser({
    userId, username, displayName, avatarUrl,
    guildId:   guildId   || null,
    channelId: channelId || null,
  });

  // ── 3. Name override ────────────────────────────────────────────────────────
  const newName = await detectNameSet(userId, message);
  if (newName) prefName = newName;

  // ── 4. Passive fact extraction (non-blocking) ────────────────────────────────
  extractAndStoreFact(userId, message).catch(() => {});

  // ── 5. Relationship load ────────────────────────────────────────────────────
  const relationship = await getOrCreateRelationship(userId, contextType);

  // ── 6. Social graph — who does this user talk to? ───────────────────────────
  const frequentFriends = await getFrequentInteractors(userId, guildId);

  // If this message was a reply to someone, record that interaction
  if (msg.reference?.messageId && msg.guild) {
    try {
      const refMsg = await msg.channel.messages.fetch(msg.reference.messageId);
      if (refMsg && !refMsg.author.bot && refMsg.author.id !== userId) {
        await recordUserInteraction(userId, refMsg.author.id, guildId);
      }
    } catch { /* non-fatal */ }
  }

  // ── 7. Entropy + tone zone ──────────────────────────────────────────────────
  const entropy = estimateEntropy(message);
  const { zone, line: zoneLine } = getEntropyZone(entropy);

  // ── 8. Fetch memory — scoped by context (DM vs server) ──────────────────────
  const context = await getContext(userId, prefName, contextType, guildId);

  // ── 9. Call LLM ─────────────────────────────────────────────────────────────
  const result = await getMayaReply({
    prefName,
    context,
    message,
    entropy,
    zone,
    zoneLine,
    contextLine,
    knownFacts,
    relationship,
    frequentFriends,
  });

  // ── 10. Persist memory with full context ────────────────────────────────────
  const memBase = {
    userId, prefName,
    guildId:     guildId    || null,
    channelId:   channelId  || null,
    contextType,
    isPrivate,
    entropy,
  };

  await saveMessage({ ...memBase, sender: 'user', message });

  const savedReply = result.type === 'react'
    ? `*reacted with ${result.emoji}*`
    : result.text;
  await saveMessage({ ...memBase, sender: 'maya', message: savedReply });

  // ── 11. Debug log ────────────────────────────────────────────────────────────
  debugLog({ userId, prefName, entropy, zone, message, reply: savedReply });

  return result;
}
