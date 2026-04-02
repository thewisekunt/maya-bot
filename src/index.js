import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, ActivityType } from 'discord.js';
import { config } from './config.js';
import { handleMessage } from './handler.js';
import { acquireLock, releaseLock } from './lock.js';
import { onMention, onMayaReply, onMayaReact, observeMessage, getEngagedUser } from './presence.js';
import { startDreamLoop } from './dream.js';
import { startInitiationEngine, checkInitiationReply, trackInitiationSent, updateAttachment } from './initiate.js';
import { initPsyche } from './psyche.js';
import { trainNLP } from './nlp.js';
import { replyDelay } from './llm.js';
import { startSTM, openSession, recordSessionMessage } from './stm.js';
import { generateImage } from './imagegen.js';
import { scan, refreshAliases } from './scanner.js';
import { checkSpam, notifyReplied } from './spamguard.js';
import db from './db.js';
import { evaluate } from './notif.js';

// Resolve Discord @mentions to display names instead of stripping them
// "@maya meet @nier" → "maya meet nier🫰🏻" (not "meet")
function _resolveMentions(msg) {
  let text = msg.content;
  if (!text) return '';
  // Replace user mentions with display names
  text = text.replace(/<@!?(\d+)>/g, (match, userId) => {
    const member = msg.guild?.members?.cache?.get(userId);
    if (member) return member.displayName || member.user?.username || '';
    const user = msg.client?.users?.cache?.get(userId);
    if (user) return user.username || '';
    return '';  // unknown user — remove
  });
  // Replace role mentions with role names
  text = text.replace(/<@&(\d+)>/g, (match, roleId) => {
    const role = msg.guild?.roles?.cache?.get(roleId);
    return role ? `@${role.name}` : '';
  });
  // Strip channel mentions (not useful in text)
  text = text.replace(/<#\d+>/g, '');
  return text.trim();
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,  // for reaction mirroring
    GatewayIntentBits.GuildMessageTyping,     // for typing awareness
    GatewayIntentBits.DirectMessageTyping,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

// ── Spam batcher ──────────────────────────────────────────────────────────────
const _spamBatch    = new Map();
const BATCH_WINDOW  = 1500;   // base window
const TYPING_EXTEND = 3000;   // extend by this much when user is typing

// Track who is currently typing: key = `${channelId}:${userId}` → expiry timestamp
const _typingMap = new Map();

export function recordTyping(channelId, userId) {
  const key = `${channelId}:${userId}`;
  _typingMap.set(key, Date.now() + 8000);   // typing indicator lasts ~8s in Discord
  // If a batch is in progress for this user, extend it
  const batchKey = `notif:${channelId}:${userId}`;
  const engBatchKey = `${channelId}:${userId}`;
  for (const bk of [batchKey, engBatchKey]) {
    const existing = _spamBatch.get(bk);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        _spamBatch.delete(bk);
        existing.flush(existing.items);
      }, TYPING_EXTEND);
      console.log(`[batch] extended window for ${userId} (typing)`);
    }
  }
}

function _isTyping(channelId, userId) {
  const key = `${channelId}:${userId}`;
  const exp = _typingMap.get(key);
  if (!exp) return false;
  if (Date.now() > exp) { _typingMap.delete(key); return false; }
  return true;
}

function _batch(key, item, onFlush) {
  const existing = _spamBatch.get(key);
  const window   = BATCH_WINDOW;
  if (existing) {
    clearTimeout(existing.timer);
    existing.items.push(item);
    existing.flush = onFlush;
    existing.timer = setTimeout(() => { _spamBatch.delete(key); onFlush(existing.items); }, window);
  } else {
    const b = {
      items: [item],
      flush: onFlush,
      timer: setTimeout(() => { _spamBatch.delete(key); onFlush(b.items); }, window),
    };
    _spamBatch.set(key, b);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async () => {
  console.log(`[bot] Logged in as ${client.user.tag} ✓`);
  client.user.setActivity('your messages 👀', { type: ActivityType.Watching });
  const { ensureCollection } = await import('./vector.js');
  await ensureCollection().catch(e => console.warn('[bot] Qdrant:', e.message));
  await trainNLP().catch(e => console.warn('[bot] NLP:', e.message));
  await initPsyche().catch(e => console.warn('[bot] psyche:', e.message));
  // Load aliases once at startup (they're static — just bot name + env aliases)
  await refreshAliases(null).catch(() => {});
  startDreamLoop();
  startSTM();
  startInitiationEngine(client);
});

// ── Message handler ───────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;

  const content   = msg.content.trim();
  const channelId = msg.channel.id;
  const isDM      = !msg.guild;
  const guildId   = msg.guild?.id || null;

  const hasMedia = msg.attachments.size > 0 || msg.embeds.length > 0 || msg.stickers.size > 0;
  if (!content && !hasMedia) return;

  // Channel allowlist
  const allowed = config.discord.allowedChannels;
  if (allowed.length > 0 && msg.guild && !allowed.includes(channelId)) return;

  // ── Always observe for conversation state ────────────────────────────────
  if (!isDM) {
    // Quick entropy estimate for channel baseline tracking
    const { estimateEntropy: estEnt } = await import('./persona.js');
    const msgEnt = estEnt(content || '');
    observeMessage(channelId, msg.author.id, false, msgEnt);
    // Implicit reward: user speaking = continuation of Maya's last reply
    notifyUserSpoke(msg.author.id, channelId);
    // Initiation reply check happens in handler.js after NLP (needs context)
  }

  // ── PATH 1: Engaged continuation (no scan needed) ────────────────────────
  // If Maya is actively engaged with this user, let messages through directly
  const engagedWith = isDM ? null : getEngagedUser(channelId);
  if (engagedWith === msg.author.id) {
    _batch(`${channelId}:${msg.author.id}`, msg, (msgs) => {
      _processEngaged(msgs, client).catch(e => console.error('[bot] engaged error:', e.message));
    });
    return;
  }

  // ── PATH 2: Scanner → Notification → Evaluate ────────────────────────────
  const notif = scan(msg, client.user.id);
  if (!notif) return;   // no trigger — silent observation only

  // Batch rapid messages from same user before evaluating
  _batch(`notif:${channelId}:${msg.author.id}`, msg, (msgs) => {
    _processNotification(msgs, notif, client).catch(e => console.error('[bot] notif error:', e.message));
  });
});

// ── PATH 1: Engaged continuation ─────────────────────────────────────────────
// Maya is already in active conversation — skip notification evaluation,
// go straight to handler with presence deciding action

async function _processEngaged(messages, client) {
  const msg       = messages[messages.length - 1];
  const channelId = msg.channel.id;
  const isDM      = !msg.guild;

  const allTexts = messages.map(m => _resolveMentions(m)).filter(Boolean);
  let text = allTexts.join(' ').trim();
  const hasMedia = msg.attachments.size > 0 || msg.embeds.length > 0 || msg.stickers.size > 0;
  if (!text && hasMedia) text = '[media]';
  if (!text) return;

  // Spam check — applies to both server and DMs
  // DMs get higher velocity/repeat limits (more tolerant) via isDM flag
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
    if (msg.reference?.messageId) {
      try {
        const ref = await msg.channel.messages.fetch(msg.reference.messageId);
        if (ref?.author?.id === client.user.id) {
          isReply = true;  // replying to Maya
        } else if (ref?.author?.id !== msg.author.id) {
          // Replying to someone else entirely
          isReplyToOther = true;
          replyTargetName = ref?.member?.displayName || ref?.author?.username || 'someone';
        }
      } catch {}
    }

    const isMention = msg.mentions.has(client.user);

    // If replying to a third party and NOT mentioning Maya → not for Maya
    // Even in ENGAGED mode, we shouldn't intercept side-conversations
    if (isReplyToOther && !isMention) {
      const hasMayaKeyword = /maya/i.test(text);
      if (!hasMayaKeyword) {
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

    // Open session on mention, but don't reset mode via onMention
    // (_send → onMayaReply will set ENGAGED if we reply)
    if (!isDM) {
      openSession(channelId, msg.guild?.id || null, msg.author.id).catch(() => {});
    }

    _recordSession(msg, channelId, isDM, text, result);
    await _send(msg, result, channelId, isDM, text, client);

  } finally {
    await releaseLock(lockKey);
  }
}

// ── PATH 2: Notification evaluation ──────────────────────────────────────────
// Scanner found a trigger — evaluate context, then decide

async function _processNotification(messages, triggerNotif, client) {
  // Use the last message as the primary trigger for evaluation
  const msg       = messages[messages.length - 1];
  const channelId = msg.channel.id;
  const isDM      = !msg.guild;
  const guildId   = msg.guild?.id || null;

  const allTexts = messages.map(m => _resolveMentions(m)).filter(Boolean);
  let text = allTexts.join(' ').trim();
  const hasMedia = msg.attachments.size > 0 || msg.embeds.length > 0 || msg.stickers.size > 0;
  if (!text && hasMedia) text = '[media]';
  if (!text && !hasMedia) return;

  if (messages.length > 1) {
    console.log(`[bot] batched ${messages.length} msgs: "${text.slice(0, 60)}"`);
  }

  // ── Spam check — applies everywhere including DMs ─────────────────────────
  const isMentionCheck = msg.mentions.has(client.user);
  const spam = checkSpam(channelId, msg.author.id, text, isMentionCheck, isDM);
  if (spam.isSpam) {
    console.log(`[spamguard] ignoring ${msg.author.username}: ${spam.reason}`);
    return;
  }

  const lockKey = `msg_${msg.id}`;
  if (!await acquireLock(lockKey)) return;

  try {
    // ── Evaluate: should Maya respond? ─────────────────────────────────────
    // Update notif to use the batched message
    const notif = { ...triggerNotif, msg };
    const evaluation = await evaluate(notif, client.user.id);

    console.log(`[notif] action=${evaluation.action} reason="${evaluation.reason}" trigger=${triggerNotif.triggerWord}`);

    // ── IGNORE — don't process further ────────────────────────────────────
    if (evaluation.action === 'ignore') return;

    // ── LURK — enter observing mode but don't reply ────────────────────────
    if (evaluation.action === 'lurk') {
      onMention(channelId, msg.author.id);   // enters OBSERVING mode
      openSession(channelId, guildId, msg.author.id).catch(() => {});
      console.log(`[bot] lurk mode entered for channel ${channelId}`);
      return;
    }

    // ── REACT — emoji only ────────────────────────────────────────────────
    if (evaluation.action === 'react') {
      const emoji = evaluation.emoji || '👀';
      await msg.react(emoji).catch(() => {});
      onMayaReact(channelId);
      onMention(channelId, msg.author.id);   // still enter observing after react
      return;
    }

    // ── REPLY — full pipeline ─────────────────────────────────────────────
    let isReply = false;
    if (msg.reference?.messageId) {
      try {
        const ref = await msg.channel.messages.fetch(msg.reference.messageId);
        isReply = ref?.author?.id === client.user.id;
      } catch {}
    }

    const isMention = msg.mentions.has(client.user);
    const result = await handleMessage({
      userId: msg.author.id, username: msg.author.username,
      displayName: msg.member?.displayName || msg.author.username,
      avatarUrl: msg.author.displayAvatarURL({ size: 64 }),
      message: text, guildId, msg, isMention, isReply, hasMedia,
    });

    // Open session — mode is handled by _send → onMayaReply (ENGAGED)
    if (!isDM) {
      openSession(channelId, guildId, msg.author.id).catch(() => {});
    }

    _recordSession(msg, channelId, isDM, text, result);
    await _send(msg, result, channelId, isDM, text, client);

  } finally {
    await releaseLock(lockKey);
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────



function _recordSession(msg, channelId, isDM, text, result) {
  if (!channelId) return;  // channelId always exists, even in DMs
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

  if (result.type === 'reply') {
    const delayMs = replyDelay(text.length);
    await msg.channel.sendTyping().catch(() => {});
    await new Promise(r => setTimeout(r, delayMs));
  }

  if (result.type === 'react') {
    onMayaReact(channelId);
    await msg.react(result.emoji).catch(() => console.warn('[bot] react failed:', result.emoji));
    // Save react context — so Maya knows what she reacted to if asked later
    const { saveMessage: saveMsgFn } = await import('./memory.js');
    saveMsgFn({
      userId, prefName: msg.member?.displayName || msg.author.username,
      guildId: msg.guild?.id || null, channelId,
      contextType: isDM ? 'dm' : 'server', isPrivate: isDM,
      sender: 'maya',
      message: `[reacted ${result.emoji} to: "${(text || '').slice(0, 100)}"]`,
      entropy: 0.3,
    }).catch(() => {});

  } else if (result.type === 'image') {
    await msg.channel.sendTyping().catch(() => {});
    try {
      const { buffer, filename } = await generateImage(result.prompt);
      await msg.reply({ content: 'here you go ✨', files: [{ attachment: buffer, name: filename }] });
    } catch (err) {
      console.error('[imagegen] failed:', err.message);
      await msg.reply('ugh image nahi bana 😭').catch(() => {});
    }

  } else if (result.type === 'reply') {
    onMayaReply(channelId, msg.author.id);
    notifyReplied(channelId, msg.author.id);  // good interaction — reduce spam penalty
    const replyText = result.text || '';
    if (replyText.length <= 2000) {
      await msg.reply(replyText);
    } else {
      for (const chunk of replyText.match(/[\s\S]{1,1990}/g) || [replyText]) {
        await msg.channel.send(chunk);
      }
    }
    // Implicit reward: if user continues talking within 90s → positive signal
    // on the last NLP training example for this user
    _scheduleImplicitReward(msg.author.id, channelId, 90_000);
  }
}

// ── Implicit reward scheduler ─────────────────────────────────────────────────
// After Maya replies, wait 90 seconds. If the same user sends another message,
// mark the most recent NLP training example for that user as positive (reward=1).
// If they don't respond, mark it as negative (reward=0).
const _rewardTimers = new Map();

function _scheduleImplicitReward(userId, channelId, windowMs) {
  const key = `${channelId}:${userId}`;
  if (_rewardTimers.has(key)) clearTimeout(_rewardTimers.get(key));

  const timer = setTimeout(async () => {
    _rewardTimers.delete(key);
    // No continuation — negative signal (Maya may have intruded)
    await _writeReward(userId, 0);
  }, windowMs);

  _rewardTimers.set(key, { timer, userId, channelId });
}

export function notifyUserSpoke(userId, channelId) {
  const key = `${channelId}:${userId}`;
  const entry = _rewardTimers.get(key);
  if (!entry) return;
  // User continued! Positive signal.
  clearTimeout(entry.timer);
  _rewardTimers.delete(key);
  _writeReward(userId, 1);
}

async function _writeReward(userId, reward) {
  try {
    await db.execute(
      `UPDATE maya_nlp_training
       SET reward = ?
       WHERE id = (
         SELECT id FROM (
           SELECT id FROM maya_nlp_training
           WHERE reward IS NULL
           ORDER BY created_at DESC
           LIMIT 1
         ) t
       )`,
      [reward]
    );
  } catch { /* non-fatal */ }
}

// ── Typing awareness ────────────────────────────────────────────────────────
client.on(Events.TypingStart, (typing) => {
  if (typing.user.bot) return;
  const channelId = typing.channel.id;
  const userId    = typing.user.id;
  recordTyping(channelId, userId);
});

// ── Reaction mirroring ────────────────────────────────────────────────────────
// When someone reacts to a message, Maya might react too if it's funny/relevant.
// Uses presence mode: only mirrors reactions in OBSERVING or ENGAGED channels.
// Uses NLP sentiment: only mirrors positive/funny reactions, not negative ones.
const FUNNY_EMOJI    = new Set(['😂','🤣','💀','😭','😩','🤦','🫡','💯','🔥','👀','😅','😆','🤌']);
const _recentMirrors = new Map(); // channelId → last mirror timestamp

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;
    if (user.id === client.user.id) return;  // ignore Maya's own reactions

    // Fetch partial reactions
    if (reaction.partial) await reaction.fetch().catch(() => {});
    if (reaction.message.partial) await reaction.message.fetch().catch(() => {});

    const channelId = reaction.message.channel.id;
    const isDM      = !reaction.message.guild;
    if (isDM) return;  // don't mirror in DMs

    // Only mirror in channels where Maya is observing or engaged
    const { getMode } = await import('./presence.js');
    const mode = getMode(channelId);
    if (mode === 0) return;  // PASSIVE — not paying attention

    // Don't mirror too frequently in same channel
    const lastMirror = _recentMirrors.get(channelId) || 0;
    if (Date.now() - lastMirror < 15_000) return;  // 15s between mirrors

    // Only mirror if it's a funny/positive emoji
    const emoji = reaction.emoji.name;
    if (!FUNNY_EMOJI.has(emoji)) return;

    // Check reaction count — if multiple people reacted with same emoji,
    // it's probably genuinely funny (social proof)
    const count = reaction.count || 1;
    if (count < 2 && Math.random() > 0.4) return;  // solo reaction: 40% chance

    // Small random delay so it doesn't feel instant/bot-like
    const delay = 800 + Math.random() * 2000;
    await new Promise(r => setTimeout(r, delay));

    await reaction.message.react(emoji).catch(() => {});
    _recentMirrors.set(channelId, Date.now());
    console.log(`[react] mirrored ${emoji} in ${channelId} (count=${count})`);

  } catch (e) {
    // Non-fatal — reaction mirroring is optional feature
  }
});

client.on(Events.Error, err => console.error('[bot] Client error:', err));
process.on('unhandledRejection', err => console.error('[bot] Unhandled rejection:', err));

client.login(config.discord.token);
