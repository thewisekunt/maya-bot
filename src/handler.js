import { upsertPersona, detectNameSet, getEntropyZone, estimateEntropy } from './persona.js';
import { getContext, saveMessage } from './memory.js';
import { getMayaReply } from './llm.js';
import { debugLog } from './logger.js';

/**
 * Full pipeline for one incoming Discord message.
 * Returns { type: 'reply', text } or { type: 'react', emoji }
 */
export async function handleMessage({
  userId, username, displayName, avatarUrl, message, guildId,
}) {
  // 1. Upsert persona — get preferred name
  let prefName = await upsertPersona({ userId, username, displayName, avatarUrl });

  // 2. Check for "my name is X"
  const newName = await detectNameSet(userId, message);
  if (newName) prefName = newName;

  // 3. Entropy + zone
  const entropy = estimateEntropy(message);
  const { zone, line: zoneLine } = getEntropyZone(entropy);

  // 4. Memory context
  const context = await getContext(userId, prefName);

  // 5. Call LLM — returns { type, text|emoji }
  const result = await getMayaReply({ prefName, context, message, entropy, zone, zoneLine });

  // 6. Persist — save what was said and what Maya did
  const memArgs = { userId, prefName, guildId, entropy };
  await saveMessage({ ...memArgs, sender: 'user', message });
  // For reactions, log what emoji was used so memory has context
  const savedReply = result.type === 'react'
    ? `*reacted with ${result.emoji}*`
    : result.text;
  await saveMessage({ ...memArgs, sender: 'maya', message: savedReply });

  // 7. Debug log
  debugLog({ userId, prefName, entropy, zone, message, reply: savedReply });

  return result;
}