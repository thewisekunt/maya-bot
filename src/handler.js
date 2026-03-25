import { upsertPersona, detectNameSet, getEntropyZone, estimateEntropy } from './persona.js';
import { getContext, saveMessage } from './memory.js';
import { getMayaReply } from './llm.js';
import { debugLog } from './logger.js';

/**
 * Full pipeline for one incoming Discord message.
 *
 * @param {object} params
 *   userId       string  — Discord snowflake
 *   username     string  — Discord username
 *   displayName  string  — Server nickname
 *   avatarUrl    string
 *   message      string  — The actual text
 *   guildId      string  — Server ID (optional)
 *
 * @returns {Promise<string>} Maya's reply
 */
export async function handleMessage({
  userId,
  username,
  displayName,
  avatarUrl,
  message,
  guildId,
}) {
  // 1. Upsert persona — get preferred name
  let prefName = await upsertPersona({ userId, username, displayName, avatarUrl });

  // 2. Check for "my name is X" quick-set
  const newName = await detectNameSet(userId, message);
  if (newName) prefName = newName;

  // 3. Estimate entropy from message content
  const entropy = estimateEntropy(message);
  const { zone, line: zoneLine } = getEntropyZone(entropy);

  // 4. Load memory context
  const context = await getContext(userId, prefName);

  // 5. Call LLM
  const reply = await getMayaReply({ prefName, context, message, entropy, zone, zoneLine });

  // 6. Persist both sides
  const memArgs = { userId, prefName, guildId, entropy };
  await saveMessage({ ...memArgs, sender: 'user', message });
  await saveMessage({ ...memArgs, sender: 'maya', message: reply });

  // 7. Debug log
  debugLog({ userId, prefName, entropy, zone, message, reply });

  return reply;
}
