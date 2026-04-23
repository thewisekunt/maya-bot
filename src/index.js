import 'dotenv/config';
import { Client } from 'discord.js-selfbot-v13';
import { config } from './config.js';
import { handleMessage } from './handler.js';
import { acquireLock, releaseLock } from './lock.js';
import { onMention, onMayaReply, onMayaReact, observeMessage, getEngagedUser } from './presence.js';
import { startDreamLoop } from './dream.js';
import { startInitiationEngine, trackInitiationSent, updateAttachment } from './initiate.js';
import { startCommitmentEngine } from './commitments.js';
import { startSleepEngine, isSleeping } from './sleep.js';
import { initPsyche } from './psyche.js';
import { trainNLP } from './nlp.js';
import { replyDelay } from './llm.js';
import { startSTM, openSession, recordSessionMessage } from './stm.js';
import { generateImage } from './imagegen.js';
import { refreshAliases } from './scanner.js';
import { parseNotification, resolveReplyNotif } from './notification.js';
import { observe, shouldTriggerObservation, resetPull, getObservationState } from './observation.js';
import { processBotMessage, recordBotEvent, looksLikeBotCommand } from './botregistry.js';
import { checkSpam, notifyReplied } from './spamguard.js';
import db from './db.js';
import { evaluate } from './notif.js';
import { loadSignalsFromDB } from './signals.js';
import { saveNotification, markSeen, processMorningInbox, dismissOldNotifications } from './inbox.js';
import { markMissing } from './context_enricher.js';
import { observeEmojis, observeReactionEmoji, getEmojiHint, logReactionReceived } from './emoji.js';

// Selfbot client — no intents/partials needed, user accounts receive all events
const client = new Client({ checkUpdate: false });

// ── Resolve Discord @mentions to display names ────────────────────────────────
function _resolveMentions(msg) {
  let text = msg.content;
  if (!text) return '';
  text = text.replace(/<@!?(\d+)>/g, (match, userId) => {
    // Keep @ prefix so Maya knows this was an address/mention, not just a name
    // "@horse how are you" vs "horse how are you" — huge semantic difference
    const member = msg.guild?.members?.cache?.get(userId);
    if (member) return '@' + (member.displayName || member.user?.username || userId);
    const user = msg.client?.users?.cache?.get(userId);
    if (user) return '@' + (user.username || userId);
    return '@' + userId;  // fallback: show ID with @ so it's still recognizable as mention
  });
  text = text.replace(/<@&(\d+)>/g, (match, roleId) => {
    const role = msg.guild?.roles?.cache?.get(roleId);
    return role ? `@${role.name}` : '';
  });
  text = text.replace(/<#\d+>/g, '');
  return text.trim();
}

// ── Resolve @Name → <@userId> in Maya's outgoing replies ──────────────────────
// The LLM writes "@mario" — we need to convert that to "<@userId>" for Discord
// to actually ping them. Uses guild member cache by displayName/username match.
function _resolveOutgoingMentions(text, guild) {
  if (!text || !guild) return text;
  // Match @Word or @Two Words (up to 3 words, handles display names with spaces)
  return text.replace(/@([\w\s]{1,40}?)(?=\s|$|[,!?.])/g, (match, name) => {
    const nameLower = name.trim().toLowerCase();
    if (!nameLower) return match;

    // Search guild member cache by displayName or username
    const member = guild.members.cache.find(m =>
      (m.displayName?.toLowerCase() === nameLower) ||
      (m.user?.username?.toLowerCase() === nameLower) ||
      (m.displayName?.toLowerCase().startsWith(nameLower)) ||
      (m.user?.username?.toLowerCase().startsWith(nameLower))
    );

    if (member) return `<@${member.user.id}>`;
    return match;  // no match — leave as-is (still readable, just won't ping)
  });
}

// ── Spam batcher ──────────────────────────────────────────────────────────────
const _spamBatch   = new Map();
const BATCH_WINDOW = 1500;

const _typingMap = new Map();

export function recordTyping(channelId, userId) {
  const key = `${channelId}:${userId}`;
  _typingMap.set(key, Date.now() + 8000);
  for (const bk of [`notif:${channelId}:${userId}`, `${channelId}:${userId}`]) {
    const existing = _spamBatch.get(bk);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => { _spamBatch.delete(bk); existing.flush(existing.items); }, 3000);
    }
  }
}

function _batch(key, item, onFlush) {
  const existing = _spamBatch.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    existing.items.push(item);
    existing.flush = onFlush;
    existing.timer = setTimeout(() => { _spamBatch.delete(key); onFlush(existing.items); }, BATCH_WINDOW);
  } else {
    const b = {
      items: [item],
      flush: onFlush,
      timer: setTimeout(() => { _spamBatch.delete(key); onFlush(b.items); }, BATCH_WINDOW),
    };
    _spamBatch.set(key, b);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`[bot] Logged in as ${client.user.username} ✓`);
  _botUsername = client.user.username;
  _botDisplayName = client.user.globalName || client.user.username;
  // Update bio with a dynamically generated one based on Maya's current mood
  // Bio update disabled — Discord blocks selfbot profile edits with captcha
  const { ensureCollection } = await import('./vector.js');
  await ensureCollection().catch(e => console.warn('[bot] Qdrant:', e.message));
  await trainNLP().catch(e => console.warn('[bot] NLP:', e.message));
  await initPsyche().catch(e => console.warn('[bot] psyche:', e.message));
  await refreshAliases(null).catch(() => {});
  startDreamLoop();
  startSTM();
  startInitiationEngine(client);
  startCommitmentEngine(client);
  startSleepEngine(client);
  console.log('[initiate] engine started');
  setGlobalClient(client);  // make client available to mayaSpeak
  loadSignalsFromDB().catch(() => {});  // restore behavioral signals from DB
});

// ── Message handler ───────────────────────────────────────────────────────────

client.on('messageCreate', async (msg) => {
  // Selfbot: ignore own messages
  if (msg.author.id === client.user.id) return;
  // Webhooks: always ignore
  if (msg.webhookId) return;

  // Bot messages: route through bot awareness system instead of hard-ignoring
  if (msg.author.bot) {
    // Only process bots in allowed channels (same gate as human messages)
    const _allowed = config.discord.allowedChannels;
    const _chanId  = msg.channel?.id;
    const _guildId = msg.guild?.id || null;
    if (_allowed.length > 0 && msg.guild && !_allowed.includes(_chanId)) return;

    // Process through bot registry — fire and forget
    processBotMessage(msg).then(event => {
      if (event) {
        recordBotEvent(_chanId, event);
        console.log(`[bot] tracked ${event.botName} (${event.category}) in ${_chanId}`);
      }
    }).catch(() => {});
    return;
  }

  // ── Sleep gate ────────────────────────────────────────────────────────────
  if (isSleeping()) {
    const isMentioned = msg.mentions.has(client.user);
    if (!isMentioned) return;
    const sleepyReplies = ['zzz', 'hmm', 'kya', 'sone de', 'baad mein', '...'];
    const reply = sleepyReplies[Math.floor(Math.random() * sleepyReplies.length)];
    await msg.reply(reply).catch(() => {});
    return;
  }

  const content   = msg.content.trim();
  const channelId = msg.channel.id;
  const isDM      = !msg.guild;
  const guildId   = msg.guild?.id || null;

  const hasMedia = msg.attachments.size > 0 || msg.embeds.length > 0 || msg.stickers.size > 0;
  if (!content && !hasMedia) return;

  // Channel allowlist
  const allowed = config.discord.allowedChannels;
  if (allowed.length > 0 && msg.guild && !allowed.includes(channelId)) return;

  // ── Observe custom emojis (fire-and-forget, every message) ──────────────
  if (guildId && content) observeEmojis(msg, guildId, msg.author.id).catch(() => {});

  // ── Always observe ────────────────────────────────────────────────────────
  if (!isDM) {
    const { estimateEntropy: estEnt } = await import('./persona.js');
    const msgEnt = estEnt(content || '');
    observeMessage(channelId, msg.author.id, false, msgEnt);
    notifyUserSpoke(msg.author.id, channelId);
  }

  // ── Bot command filter — human sending a bot command, skip NLP routing ───
  // Don't let "$dep all" or "owo hunt" go through notification pipeline
  if (!isDM && looksLikeBotCommand(content)) return;

  // ── PATH 1: Engaged continuation ─────────────────────────────────────────
  const engagedWith = isDM ? null : getEngagedUser(channelId);
  if (engagedWith === msg.author.id) {
    _batch(`${channelId}:${msg.author.id}`, msg, (msgs) => {
      _processEngaged(msgs, client).catch(e => console.error('[bot] engaged error:', e.message));
    });
    return;
  }

  // ── TWO-TIER ROUTING ─────────────────────────────────────────────────────
  // Tier 1: Hard notifications (@mention, reply, DM, alias) → direct pipeline
  // Tier 2: Everything else → observation buffer → inner voice triggered when ready

  let notif = parseNotification(msg, client.user.id);

  // Complete reply check if needed (requires async fetch)
  if (!notif && msg.reference?.messageId) {
    const partial = { msg, channelId, guildId, userId: msg.author.id, isDM, content };
    partial._checkReply = true;
    notif = await resolveReplyNotif(partial, client.user.id).catch(() => null);
  }

  if (notif) {
    // ── TIER 1: Hard notification ─────────────────────────────────────────
    // Attach notification to msg so handler can access it
    msg._notification = notif;
    _batch(`notif:${channelId}:${msg.author.id}`, msg, (msgs) => {
      _processNotification(msgs, notif, client).catch(e => console.error('[bot] notif error:', e.message));
    });
  } else {
    // ── TIER 2: Passive observation ───────────────────────────────────────
    // Add to channel observation buffer. Inner voice checks pull score.
    const obsState = observe(channelId, {
      userId:    msg.author.id,
      username:  msg.member?.displayName || msg.author.username,
      content,
      entropy:   0.4,  // fast estimate — real entropy computed in handler
      sentiment: 'neutral',
      intent:    'group_chatter',
      timestamp: msg.createdTimestamp,
    });

    // Check if accumulated observation should trigger inner voice
    if (!isDM && shouldTriggerObservation(channelId)) {
      resetPull(channelId);
      // Synthesize a "virtual notification" from observation context
      // This lets Maya engage from the observation buffer, not just hard pings
      const obsNotif = {
        msg, channelId, guildId,
        userId:      msg.author.id,
        isDM:        false,
        type:        'observation',
        triggerType: 'observation',
        urgency:     obsState.pullScore,
        content,
      };
      msg._notification = obsNotif;
      _batch(`obs:${channelId}`, msg, (msgs) => {
        _processNotification(msgs, obsNotif, client).catch(e => console.error('[bot] obs error:', e.message));
      });
    }
  }
});

// ── PATH 1: Engaged ───────────────────────────────────────────────────────────

async function _processEngaged(messages, client) {
  const msg       = messages[messages.length - 1];
  const channelId = msg.channel.id;
  const isDM      = !msg.guild;

  const allTexts = messages.map(m => _resolveMentions(m)).filter(Boolean);
  let text = allTexts.join(' ').trim();
  const hasMedia = msg.attachments.size > 0 || msg.embeds.length > 0 || msg.stickers.size > 0;
  if (!text && hasMedia) text = '[media]';
  if (!text) return;

  if (msg.guild) {
    const { indexMember } = await import('./entity.js');
    indexMember(msg.guild.id, msg.author.id, msg.member?.displayName || msg.author.username, msg.author.username).catch(() => {});
  }

  const spamEngaged = checkSpam(channelId, msg.author.id, text, msg.mentions.has(client.user), isDM);
  if (spamEngaged.isSpam) {
    console.log(`[spamguard] engaged-ignore ${msg.author.username}: ${spamEngaged.reason}`);
    return;
  }

  const lockKey = `msg_${msg.id}`;
  if (!await acquireLock(lockKey)) return;

  try {
    let isReply = false;
    let isReplyToOther = false;
    let replyTargetName = null;

    // Selfbot: msg.reference uses messageId (same as v13)
    if (msg.reference?.messageId) {
      try {
        const ref = await msg.channel.messages.fetch(msg.reference.messageId);
        if (ref?.author?.id === client.user.id) {
          isReply = true;
        } else if (ref?.author?.id !== msg.author.id) {
          isReplyToOther = true;
          replyTargetName = ref?.member?.displayName || ref?.author?.username || 'someone';
        }
      } catch {}
    }

    const isMention = msg.mentions.has(client.user);

    if (isReplyToOther && !isMention) {
      if (!/\bmaya\b/i.test(text)) {
        console.log(`[engaged] skip: ${msg.author.username} is replying to ${replyTargetName}, Maya not involved`);
        return;
      }
    }

    const result = await handleMessage({
      userId: msg.author.id, username: msg.author.username,
      displayName: msg.member?.displayName || msg.author.username,
      avatarUrl: msg.author.displayAvatarURL({ size: 64 }),
      message: text, guildId: msg.guild?.id || null,
      msg, isMention, isReply, hasMedia,
    });

    if (!isDM) openSession(channelId, msg.guild?.id || null, msg.author.id).catch(() => {});
    _recordSession(msg, channelId, isDM, text, result);
    await _send(msg, result, channelId, isDM, text, client);

  } finally {
    await releaseLock(lockKey);
  }
}

// ── PATH 2: Notification ──────────────────────────────────────────────────────

async function _processNotification(messages, triggerNotif, client) {
  const msg       = messages[messages.length - 1];
  const channelId = msg.channel.id;
  const isDM      = !msg.guild;
  const guildId   = msg.guild?.id || null;

  const allTexts = messages.map(m => _resolveMentions(m)).filter(Boolean);
  let text = allTexts.join(' ').trim();
  const hasMedia = msg.attachments.size > 0 || msg.embeds.length > 0 || msg.stickers.size > 0;
  if (!text && hasMedia) text = '[media]';
  if (!text && !hasMedia) return;

  if (messages.length > 1) console.log(`[bot] batched ${messages.length} msgs: "${text.slice(0, 60)}"`);

  const isMentionCheck = msg.mentions.has(client.user);
  const spam = checkSpam(channelId, msg.author.id, text, isMentionCheck, isDM);
  if (spam.isSpam) {
    console.log(`[spamguard] ignoring ${msg.author.username}: ${spam.reason}`);
    return;
  }

  // Save to inbox
  const notifId = await saveNotification({
    userId: msg.author.id, guildId, channelId,
    messageId: msg.id,
    triggerType: triggerNotif.triggerType || 'mention',
    content: text,
    context: msg.reference?.messageId ? { referencedMessageId: msg.reference.messageId } : null,
  });
  if (notifId) await markSeen(notifId);
  msg._notifId = notifId;

  const lockKey = `msg_${msg.id}`;
  if (!await acquireLock(lockKey)) return;

  try {
    const notif = { ...triggerNotif, msg };
    const evaluation = await evaluate(notif, client.user.id);

    console.log(`[notif] action=${evaluation.action} reason="${evaluation.reason}" trigger=${triggerNotif.triggerWord || triggerNotif.type || 'unknown'}`);

    if (evaluation.action === 'ignore') return;

    if (evaluation.action === 'lurk') {
      if (isSleeping()) return;
      onMention(channelId, msg.author.id);
      openSession(channelId, guildId, msg.author.id).catch(() => {});
      console.log(`[bot] lurk mode entered for channel ${channelId}`);
      return;
    }

    if (evaluation.action === 'react') {
      const emoji = evaluation.emoji || '👀';
      await msg.react(emoji).catch(() => {});
      onMayaReact(channelId);
      onMention(channelId, msg.author.id);
      return;
    }

    // ── REPLY ─────────────────────────────────────────────────────────────
    let isReply = false;
    if (msg.reference?.messageId) {
      try {
        const ref = await msg.channel.messages.fetch(msg.reference.messageId);
        isReply = ref?.author?.id === client.user.id;
      } catch {}
    }

    const isMention = msg.mentions.has(client.user);
    // Pass want_out flag from notif evaluation to handler via msg metadata
    if (evaluation.wantOut) msg._wantOut = true;

    const result = await handleMessage({
      userId: msg.author.id, username: msg.author.username,
      displayName: msg.member?.displayName || msg.author.username,
      avatarUrl: msg.author.displayAvatarURL({ size: 64 }),
      message: text, guildId, msg, isMention, isReply, hasMedia,
    });

    if (!isDM) openSession(channelId, guildId, msg.author.id).catch(() => {});
    _recordSession(msg, channelId, isDM, text, result);
    await _send(msg, result, channelId, isDM, text, client);

  } finally {
    await releaseLock(lockKey);
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function _recordSession(msg, channelId, isDM, text, result) {
  if (!channelId) return;
  recordSessionMessage(channelId, {
    userId: msg.author.id,
    userName: msg.member?.displayName || msg.author.username,
    sender: 'user', message: text,
  }).catch(() => {});
  if (result?.type === 'reply') {
    recordSessionMessage(channelId, {
      userId: 'maya', userName: 'Maya', sender: 'maya', message: result.text,
    }).catch(() => {});
  }
}

async function _send(msg, result, channelId, isDM, text, client) {
  if (!result) return;
  // LLM chose silence — honor it, save user msg to memory but don't reply
  if (result.type === 'ignore') {
    const { saveMessage } = await import('./memory.js');
    saveMessage({
      userId: msg.author.id, prefName: msg.member?.displayName || msg.author.username,
      guildId: msg.guild?.id || null, channelId,
      contextType: isDM ? 'dm' : 'server', isPrivate: isDM,
      sender: 'user', message: text, entropy: 0.3,
    }).catch(() => {});
    return;
  }

  const guildId    = msg.guild?.id || null;
  const userId     = msg.author.id;
  const userName   = msg.member?.displayName || msg.author.username;
  const contextType = isDM ? 'dm' : 'server';

  // Helper: record Maya's action into both STM and persistent memory
  // Every output — reply, react, image, initiation — must be in context
  const _recordMayaAction = async (actionText, label = 'action') => {
    const { saveMessage: saveMsgFn } = await import('./memory.js');
    // STM session
    recordSessionMessage(channelId, {
      userId: 'maya', userName: 'Maya', sender: 'maya', message: actionText,
    }).catch(() => {});
    // Persistent memory
    saveMsgFn({
      userId: 'maya', prefName: 'Maya', guildId, channelId,
      contextType, isPrivate: isDM, sender: 'maya', message: actionText, entropy: 0.2,
    }).catch(() => {});
  };

  if (result.type === 'reply') {
    const delayMs = replyDelay(text.length);
    await msg.channel.sendTyping().catch(() => {});
    await new Promise(r => setTimeout(r, delayMs));
  }

  // ── Go offline if signal demands it ───────────────────────────────────────
  // The signal attacher in llm.js detected that Maya said she'd go offline.
  // Honor it: actually set Discord presence to invisible.
  if (result.attachedSignal?.type === 'go_offline' || result.attachedSignal?.type === 'disengage') {
    const presenceStatus = result.attachedSignal.type === 'go_offline' ? 'invisible' : 'idle';
    client.user?.setPresence({ status: presenceStatus }).catch(() => {});
    console.log('[signal] presence set to ' + presenceStatus + ' for ' + (result.attachedSignal.type));
    // Auto-restore after signal duration
    const restoreAfter = result.attachedSignal.duration || 20 * 60 * 1000;
    setTimeout(() => {
      client.user?.setPresence({ status: 'online' }).catch(() => {});
      console.log('[signal] presence restored to online after timeout');
    }, restoreAfter);
  }

  if (result.type === 'react') {
    onMayaReact(channelId);
    // Validate custom emoji is accessible before attempting
    let emojiToUse = result.emoji;
    const customMatch = result.emoji?.match(/^<a?:(\w+):(\d+)>$/);
    if (customMatch) {
      const emojiId = customMatch[2];
      // Check if this emoji exists in the current guild
      const guildEmoji = msg.guild?.emojis?.cache?.get(emojiId);
      if (!guildEmoji) {
        // Emoji not in this guild — fall back to unicode
        const { getReactEmoji } = await import('./emoji.js');
        const psycheForEmoji = { emotions: {}, hormones: {} };
        emojiToUse = await getReactEmoji(null, psycheForEmoji).catch(() => '👀');
        console.log(`[bot] react emoji not in guild — using fallback ${emojiToUse}`);
      }
    }
    await msg.react(emojiToUse).catch((err) => {
      console.warn('[bot] react failed:', emojiToUse, err.message?.slice(0, 50));
      // Feed negative affinity back if it's a custom emoji
      if (customMatch && guildId) {
        const { updateEmojiAffinity } = require('./emoji.js');
        // Can't use import here easily, just log
      }
    });
    // Record reaction in context
    await _recordMayaAction(`[reacted ${emojiToUse} to: "${text.slice(0, 80)}"]`);

  } else if (result.type === 'image') {
    await msg.channel.sendTyping().catch(() => {});
    try {
      const { buffer, filename } = await generateImage(result.prompt);
      await msg.reply({ content: 'here you go ✨', files: [{ attachment: buffer, name: filename }] });
      await _recordMayaAction(`[sent image: ${result.prompt?.slice(0, 100) || 'generated image'}]`);
    } catch (err) {
      console.error('[imagegen] failed:', err.message);
      await msg.reply('ugh image nahi bana 😭').catch(() => {});
      await _recordMayaAction('[image generation failed]');
    }

  } else if (result.type === 'reply') {
    onMayaReply(channelId, msg.author.id);
    notifyReplied(channelId, msg.author.id);
    // Resolve @Name → <@userId> for actual Discord pings
    const rawReplyText  = result.text || '';
    const replyText     = _resolveOutgoingMentions(rawReplyText, msg.guild);
    if (replyText.length <= 2000) {
      await msg.reply(replyText).catch(async (err) => {
        // Reply fails if original message was deleted — fall back to channel send
        if (err.code === 10008 || err.message?.includes('Unknown message')) {
          await msg.channel.send(replyText).catch(() => {});
        }
      });
    } else {
      for (const chunk of replyText.match(/[\s\S]{1,1990}/g) || [replyText]) {
        await msg.channel.send(chunk).catch(() => {});
      }
    }
    // Reply is already recorded by _recordSession in the caller
    // But record here too for completeness if _recordSession missed it
    _scheduleImplicitReward(msg.author.id, channelId, 90_000);
  }
}


// ── mayaSpeak() — unified proactive send pipeline ─────────────────────────────
//
// Everything Maya says proactively (commitments, sleep/wake, initiation)
// must go through this function. It routes through the full handler pipeline:
//   context → IV → psyche → LLM → send
// so Maya's voice, memory, and state all apply — no more hardcoded arrays.
//
// @param {object} opts
//   channelId   — where to send (null = use DM)
//   userId      — who Maya is talking to (for context + trust)
//   guildId     — guild context (null for DMs)
//   isDM        — whether to open a DM channel instead
//   trigger     — 'commitment' | 'wake' | 'sleep' | 'initiation'
//   context     — free-form context string injected into Maya's system prompt
//                 e.g. "Maya made a commitment to follow up about X"
//   client      — Discord client instance
//
export async function mayaSpeak({ channelId, userId, guildId, isDM = false, trigger, context: speakContext, client: speakClient }) {
  const _cli = speakClient || _globalClient;
  if (!_cli?.isReady()) return false;

  try {
    // ── Resolve channel ────────────────────────────────────────────────────
    let channel;
    if (isDM && userId) {
      const user = await _cli.users.fetch(userId).catch(() => null);
      if (!user) return false;
      channel = await user.createDM().catch(() => null);
    } else if (channelId) {
      channel = await _cli.channels.fetch(channelId).catch(() => null);
    }
    if (!channel) return false;

    // ── Look up user info ──────────────────────────────────────────────────
    let displayName = 'there';
    let username    = 'user';
    let avatarUrl   = null;
    if (userId) {
      try {
        const member = channel.guild?.members?.cache?.get(userId)
          || await channel.guild?.members?.fetch(userId).catch(() => null);
        displayName = member?.displayName || (await _cli.users.fetch(userId).catch(() => null))?.username || 'there';
        username    = displayName;
        avatarUrl   = member?.user?.displayAvatarURL({ size: 64 }) || null;
      } catch { /* non-fatal */ }
    }

    // ── Build synthetic message for handler ───────────────────────────────
    // We inject the trigger context as the "message" Maya is responding to.
    // The handler sees this as if a virtual notification arrived.
    const syntheticMessage = `[${trigger}] ${speakContext || ''}`.trim();

    // ── Run through full handler pipeline ─────────────────────────────────
    console.log(`[mayaSpeak] trigger=${trigger} → ${isDM ? 'DM' : channelId} (${displayName})`);

    const result = await handleMessage({
      userId:      userId || 'system',
      username,
      displayName,
      avatarUrl,
      message:     syntheticMessage,
      guildId:     isDM ? null : (guildId || channel.guild?.id || null),
      msg:         _makeSyntheticMsg(channel, userId, syntheticMessage, _cli),
      isMention:   true,   // treat as direct — Maya is speaking TO this person
      isReply:     false,
      hasMedia:    false,
      _proactive:  true,   // flag so handler knows this is Maya initiating
      _trigger:    trigger,
    });

    if (!result || result.type === 'ignore') {
      console.log(`[mayaSpeak] handler returned ${result?.type || 'null'} — staying silent`);
      return false;
    }

    // ── Send the result ────────────────────────────────────────────────────
    if (result.type === 'reply' && result.text) {
      const replyText = result.text.trim();
      if (!replyText) return false;

      await channel.sendTyping().catch(() => {});
      await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));

      const mentions = userId && !isDM ? `<@${userId}> ` : '';
      const content  = isDM ? replyText : `${mentions}${replyText}`;

      await channel.send(content.slice(0, 2000)).catch(e => {
        console.error('[mayaSpeak] send failed:', e.message);
      });

      // Record in memory
      const { saveMessage: _saveFn } = await import('./memory.js');
      const cId = channel.id;
      const gId = isDM ? null : (guildId || channel.guild?.id || null);
      recordSessionMessage(cId, { userId: 'maya', userName: 'Maya', sender: 'maya', message: replyText }).catch(() => {});
      _saveFn({ userId: 'maya', prefName: 'Maya', guildId: gId, channelId: cId,
        contextType: isDM ? 'dm' : 'server', isPrivate: isDM,
        sender: 'maya', message: `[${trigger}] ${replyText}`, entropy: 0.2 }).catch(() => {});

      console.log(`[mayaSpeak] sent: "${replyText.slice(0, 80)}"`);
      return true;
    }

    return false;
  } catch (e) {
    console.error('[mayaSpeak] error:', e.message);
    return false;
  }
}

// ── Synthetic message object for handler ──────────────────────────────────────
// handler.js expects a Discord.js Message object for certain lookups.
// We create a minimal proxy that satisfies what handler actually reads.
function _makeSyntheticMsg(channel, userId, content, client) {
  return {
    id:        `synthetic_${Date.now()}`,
    content,
    channel,
    guild:     channel.guild || null,
    author:    { id: userId || 'system', username: 'system', bot: false,
                 displayAvatarURL: () => null },
    member:    channel.guild?.members?.cache?.get(userId) || null,
    mentions:  { has: () => true, users: new Map() },
    reference: null,
    attachments: new Map(),
    embeds:    [],
    stickers:  new Map(),
    createdTimestamp: Date.now(),
    reply:     (content) => channel.send(content),
    react:     () => Promise.resolve(),
    _synthetic: true,
    _notification: {
      triggerType: 'proactive',
      triggerWord: 'proactive',
      userId: userId || 'system',
      channelId: channel.id,
      guildId: channel.guild?.id || null,
      isDM: !channel.guild,
      type: 'proactive',
    },
  };
}

// Store client reference for mayaSpeak
let _globalClient = null;
let _botUsername = null;
let _botDisplayName = null;
export function setGlobalClient(c) { _globalClient = c; }
export function getBotUsername() { return _botUsername || 'harikakdi'; }
export function getBotDisplayName() { return _botDisplayName || 'Maya'; }

// ── Implicit reward ───────────────────────────────────────────────────────────
const _rewardTimers = new Map();

function _scheduleImplicitReward(userId, channelId, windowMs) {
  const key = `${channelId}:${userId}`;
  if (_rewardTimers.has(key)) clearTimeout(_rewardTimers.get(key).timer);
  const timer = setTimeout(async () => {
    _rewardTimers.delete(key);
    await _writeReward(userId, 0);
  }, windowMs);
  _rewardTimers.set(key, { timer, userId, channelId });
}

export function notifyUserSpoke(userId, channelId) {
  const key = `${channelId}:${userId}`;
  const entry = _rewardTimers.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  _rewardTimers.delete(key);
  _writeReward(userId, 1);
}

async function _writeReward(userId, reward) {
  try {
    await db.execute(
      `UPDATE maya_nlp_training
       SET reward = ?
       WHERE id = (SELECT id FROM (SELECT id FROM maya_nlp_training WHERE reward IS NULL ORDER BY created_at DESC LIMIT 1) t)`,
      [reward]
    );
  } catch { /* non-fatal */ }
}

// ── Typing awareness ──────────────────────────────────────────────────────────
client.on('typingStart', (typing) => {
  // Selfbot: typing.user may be partial — use typing.userId
  const userId    = typing.user?.id || typing.userId;
  const channelId = typing.channel?.id || typing.channelId;
  if (!userId || userId === client.user.id) return;
  recordTyping(channelId, userId);
});

// ── Reaction mirroring ────────────────────────────────────────────────────────
const FUNNY_EMOJI    = new Set(['😂','🤣','💀','😭','😩','🤦','🫡','💯','🔥','👀','😅','😆','🤌']);
const _recentMirrors = new Map();

client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.id === client.user.id) return;
    if (isSleeping()) return;

    if (reaction.partial) await reaction.fetch().catch(() => {});
    if (reaction.message.partial) await reaction.message.fetch().catch(() => {});

    const channelId = reaction.message.channel.id;
    const isDM      = !reaction.message.guild;
    const guildId   = reaction.message.guild?.id || null;

    // ── Log reaction to Maya's own messages ───────────────────────────────
    // This is a signal: approval, disapproval, emotional response, etc.
    if (reaction.message.author?.id === client.user.id) {
      logReactionReceived({
        reactorUserId: user.id,
        reactorName:   user.username,
        emoji:         reaction.emoji.name,
        emojiId:       reaction.emoji.id || null,  // null = unicode
        guildId,
        channelId,
        messageId:     reaction.message.id,
        messageContent: reaction.message.content,
      }).catch(() => {});
    }

    if (isDM) return;

    const { getMode } = await import('./presence.js');
    const mode = getMode(channelId);
    if (mode === 0) return;

    // Never mirror reactions to Maya's OWN messages — she'd be reacting to herself
    if (reaction.message.author?.id === client.user.id) return;

    const lastMirror = _recentMirrors.get(channelId) || 0;
    if (Date.now() - lastMirror < 15_000) return;

    const emoji = reaction.emoji.name;
    if (!FUNNY_EMOJI.has(emoji)) return;

    const count = reaction.count || 1;
    if (count < 2 && Math.random() > 0.4) return;

    const delay = 800 + Math.random() * 2000;
    await new Promise(r => setTimeout(r, delay));

    await reaction.message.react(emoji).catch(() => {});
    _recentMirrors.set(channelId, Date.now());
    console.log(`[react] mirrored ${emoji} in ${channelId} (count=${count})`);
    // Observe custom emojis from reactions too
    observeReactionEmoji(reaction, user.id, reaction.message.guild?.id).catch(() => {});
  } catch { /* non-fatal */ }
});

// ── Member join welcome ──────────────────────────────────────────────────────
// When someone joins while Maya is active, she can welcome them naturally
// Only fires if Maya is not sleeping and has an active channel in this guild

client.on('guildMemberAdd', async (member) => {
  try {
    if (isSleeping()) return;

    const guildId = member.guild.id;
    const userId  = member.id;
    const name    = member.displayName || member.user?.username || 'someone';

    // Find the most active channel Maya has been in for this guild
    const { getMostActiveChannel } = await import('./scanner.js');
    const channelId = await getMostActiveChannel(guildId).catch(() => null);
    if (!channelId) return;

    // Small natural delay — she doesn't want to sound like a bot
    const delay = 3000 + Math.random() * 5000;
    await new Promise(r => setTimeout(r, delay));

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    // Generate a welcome via LLM — casual, not bot-like
    const { default: axiosImport } = await import('axios');
    const { config: cfg } = await import('./config.js');

    const { data, status } = await axiosImport.post(cfg.llm.endpoint, {
      model:       config.llm.models.utility,
      messages:    [{
        role: 'user',
        content: `You are Maya, a real girl in a Discord server. ${name} just joined.
Write a natural, casual welcome — 1 sentence max. Hinglish is fine.
Don't be formal, don't say "welcome to the server", don't use exclamation marks excessively.
Examples of good style: "oi ${name} finally", "oh hey ${name}", "new face 👀 hi ${name}"
Output only the message, nothing else.`
      }],
      temperature: 0.9, max_tokens: 40,
    }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.llm.apiKey}` },
      timeout: 8000, validateStatus: () => true,
    });

    if (status !== 200) return;
    const msg = data?.choices?.[0]?.message?.content?.trim();
    if (!msg) return;

    await channel.send(msg).catch(() => {});

    const { saveMessage } = await import('./memory.js');
    saveMessage({
      userId: 'maya', prefName: 'Maya', guildId, channelId,
      contextType: 'server', isPrivate: false, sender: 'maya',
      message: `[welcomed new member ${name}]: ${msg}`, entropy: 0.2,
    }).catch(() => {});

    console.log(`[welcome] greeted ${name} in ${channelId}`);
  } catch (e) {
    console.warn('[welcome] failed:', e.message);
  }
});

client.on('error', err => console.error('[bot] Client error:', err));
process.on('unhandledRejection', err => console.error('[bot] Unhandled rejection:', err));

// Selfbot login uses user token directly

// ── Bio updater ───────────────────────────────────────────────────────────────
// Generates a fresh bio via LLM based on Maya's current emotional state
// and updates the Discord profile. Runs on startup and optionally periodically.

async function _updateBio(client) {
  // Fetch Maya's current hormone state for mood context
  let moodDesc = 'just vibing';
  try {
    const [rows] = await db.execute(
      `SELECT hormone, value FROM maya_hormone_baseline WHERE hormone IN ('dopamine','serotonin','cortisol')`
    );
    const h = Object.fromEntries(rows.map(r => [r.hormone, parseFloat(r.value)]));
    const d = h.dopamine  || 0.5;
    const s = h.serotonin || 0.6;
    const co = h.cortisol || 0.2;
    if      (d > 0.7 && s > 0.6) moodDesc = 'good mood, curious';
    else if (co > 0.5)            moodDesc = 'a bit stressed';
    else if (s < 0.45)            moodDesc = 'low energy';
    else if (d > 0.6)             moodDesc = 'interested in things';
    else                          moodDesc = 'just existing';
  } catch { /* use default */ }

  // Generate bio via cheap LLM call
  let bio = '';
  try {
    const { default: axios } = await import('axios');
    const { config: cfg } = await import('./config.js');
    const prompt = `Write a short Discord bio for Maya. She is a nonchalant BTech college girl from Delhi, ${moodDesc} right now.
Rules:
- Max 100 characters
- Casual, GenZ tone, can use Hinglish
- No quotes, no labels, no "bio:" prefix
- Examples: "dtu mein phase hun theek hun", "chai > everything", "not always here but when i am 👀"
Output only the bio text, nothing else.`;

    const { data, status } = await axios.post(cfg.llm.endpoint, {
      model:       config.llm.models.utility,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.9,
      max_tokens:  40,
    }, {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${cfg.llm.apiKey}`,
        'HTTP-Referer':  'https://chatmasala.fun',
      },
      timeout: 10000,
      validateStatus: () => true,
    });

    if (status === 200) {
      bio = data?.choices?.[0]?.message?.content?.trim() || '';
      bio = bio.replace(/^["'`]|["'`]$/g, '').trim().slice(0, 100);
    }
  } catch (e) {
    console.warn('[bot] bio LLM failed:', e.message);
    return;
  }

  if (!bio) return;

  // Update Discord profile bio via selfbot setAboutMe
  try {
    await client.user.setAboutMe(bio);
    console.log(`[bot] bio updated: "${bio}"`);
  } catch (e) {
    // setAboutMe may not exist in all selfbot-v13 versions — try REST fallback
    try {
      await client.api.users('@me').patch({ data: { bio } });
      console.log(`[bot] bio updated via REST: "${bio}"`);
    } catch (e2) {
      console.warn('[bot] bio update not supported:', e2.message);
    }
  }

  // Schedule next bio update in 6 hours
  setTimeout(() => _updateBio(client).catch(() => {}), 6 * 60 * 60 * 1000);
}

client.login(config.discord.token);
