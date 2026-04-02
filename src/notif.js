/**
 * notif.js — Notification Evaluator
 *
 * Receives a notification from scanner.js.
 * Fetches surrounding conversation with full threading context.
 * Evaluates whether Maya should engage.
 *
 * Two-stage evaluation:
 *   1. NLP (local, instant) — classify intent from trigger text
 *   2. LLM (API, ~1s) — only if NLP uncertain (score < 0.7)
 *
 * Conversation awareness:
 *   - Reply threading: tracks who is replying to whom
 *   - @mention resolution: replaces user IDs with display names
 *   - Directed message detection: if trigger is replying to someone
 *     else's message, Maya is almost certainly not the target
 *
 * Online learning:
 *   - Logs (text, nlp_intent, llm_intent) to DB when LLM overrides NLP
 *   - These become training examples for nightly NLP retraining
 */

import { classify } from './nlp.js';
import { config } from './config.js';
import db from './db.js';
import axios from 'axios';

const CONTEXT_WINDOW = 10;
const NLP_THRESHOLD  = 0.7;

// ── Main export ───────────────────────────────────────────────────────────────

export async function evaluate(notif, botId) {
  const { msg, triggerType, triggerWord, isDM } = notif;

  if (isDM) return { action: 'reply', reason: 'DM', confidence: 1.0, context: [] };

  // ── Fetch context with threading metadata ─────────────────────────────────
  const context = await _fetchContext(msg, CONTEXT_WINDOW);

  // ── Resolve mentions in context (userId → displayName) ────────────────────
  const userMap = _buildUserMap(context, botId);

  // ── Check reply threading — who is this message actually directed at? ─────
  const threadTarget = await _resolveThreadTarget(msg, botId);

  // If replying to another person's message, check if Maya is still explicitly addressed
  // e.g. replying to Sai's message but tagging @Maya in the reply = still for Maya
  if (threadTarget.isReplyToOther) {
    const isMentionedInContent = msg.mentions?.users?.has(botId) ||
      /\bmaya\b/i.test(msg.content);
    if (!isMentionedInContent) {
      // Not addressed to Maya at all — skip
      console.log(`[notif] skip: reply to ${threadTarget.targetName}, Maya not mentioned`);
      await _logTraining(msg.content, 'directed_at_other', 'hard_rule', null, null, null, 1.0);
      return { action: 'ignore', reason: `reply-thread: directed at ${threadTarget.targetName}`, confidence: 1.0, context };
    }
    // Maya IS mentioned in a reply to someone else — e.g. "maya what do you think of this?"
    // while replying to a post. Continue evaluating as normal.
    console.log(`[notif] reply to ${threadTarget.targetName} but Maya mentioned in content — evaluating`);
  }

  // ── Build rich context text ───────────────────────────────────────────────
  const contextText = _buildContextText(context, msg, botId, userMap);

  // ── Stage 1: NLP ─────────────────────────────────────────────────────────
  const triggerText = _cleanText(msg.content, userMap);
  const nlpResult   = await classify(triggerText);

  console.log(`[notif] trigger="${triggerWord}" type=${triggerType} nlp=${nlpResult.intent}(${nlpResult.score.toFixed(2)}) thread=${threadTarget.summary}`);

  if (nlpResult.score >= NLP_THRESHOLD) {
    const action = _nlpToAction(nlpResult.intent, triggerType, nlpResult.score, threadTarget);
    // Log confirmed NLP decisions (LLM agreed) for future training
    await _logTraining(triggerText, action === 'reply' ? nlpResult.intent : nlpResult.intent,
      'nlp_confirm', nlpResult.intent, nlpResult.score, null, nlpResult.score);
    return { action, reason: `nlp:${nlpResult.intent}@${nlpResult.score.toFixed(2)}`, confidence: nlpResult.score, context };
  }

  // ── Stage 2: LLM ─────────────────────────────────────────────────────────
  console.log(`[notif] NLP uncertain (${nlpResult.score.toFixed(2)}) — escalating to LLM`);
  const llmAction = await _llmEvaluate(contextText, triggerText, triggerWord, triggerType, threadTarget);

  // Log: LLM overrode NLP — this is a training example
  const finalIntent = llmAction.action === 'reply' ? 'question_to_maya'
                    : llmAction.action === 'ignore' ? 'directed_at_other'
                    : llmAction.action === 'react'  ? 'engaged_reply'
                    : 'random_mention';

  await _logTraining(triggerText, finalIntent, 'llm_override',
    nlpResult.intent, nlpResult.score, finalIntent, null);

  return { ...llmAction, confidence: 0.5, context };
}

// ── Reply thread resolution ───────────────────────────────────────────────────

async function _resolveThreadTarget(msg, botId) {
  if (!msg.reference?.messageId) {
    return { isReplyToMaya: false, isReplyToOther: false, targetName: null, summary: 'no-thread' };
  }

  try {
    const ref = await msg.channel.messages.fetch(msg.reference.messageId);
    if (ref.author.id === botId) {
      return { isReplyToMaya: true, isReplyToOther: false, targetName: 'Maya', summary: 'reply-to-maya' };
    }
    const targetName = ref.member?.displayName || ref.author.username;
    return { isReplyToMaya: false, isReplyToOther: true, targetName, summary: `reply-to-${targetName}` };
  } catch {
    return { isReplyToMaya: false, isReplyToOther: false, targetName: null, summary: 'thread-fetch-failed' };
  }
}

// ── Context fetch ─────────────────────────────────────────────────────────────

async function _fetchContext(msg, limit) {
  try {
    const before = await msg.channel.messages.fetch({ limit, before: msg.id });
    return [...[...before.values()].reverse(), msg];
  } catch (e) {
    console.error('[notif] context fetch failed:', e.message);
    return [msg];
  }
}

// ── User map: userId → displayName ────────────────────────────────────────────

function _buildUserMap(messages, botId) {
  const map = new Map();
  map.set(botId, 'Maya');
  for (const m of messages) {
    if (!map.has(m.author.id)) {
      map.set(m.author.id, m.member?.displayName || m.author.username);
    }
    // Also map from mentions in message
    for (const [uid, user] of (m.mentions?.users || [])) {
      if (!map.has(uid)) {
        const member = m.mentions?.members?.get(uid);
        map.set(uid, member?.displayName || user.username);
      }
    }
  }
  return map;
}

// ── Context text builder (with threading + mention resolution) ────────────────

function _buildContextText(context, triggerMsg, botId, userMap) {
  return context.map(m => {
    const who  = userMap.get(m.author.id) || m.author.username;
    // Resolve @mentions to names instead of stripping them
    const text = _cleanText(m.content, userMap) || '[media]';
    const flag = m.id === triggerMsg.id ? ' ← [TRIGGER]' : '';

    // Show reply-to context if this message is a thread reply
    let replyCtx = '';
    if (m.reference?.messageId) {
      // We don't fetch referenced message here (too slow for each msg)
      // but we can note it's a reply
      replyCtx = ' [replying↑]';
    }

    return `${who}${replyCtx}: ${text}${flag}`;
  }).join('\n');
}

// ── Text cleaner: replace @mentions with names ─────────────────────────────────

function _cleanText(content, userMap) {
  if (!content) return '';
  let text = content;
  // Replace <@userid> and <@!userid> with actual names
  text = text.replace(/<@!?(\d+)>/g, (match, uid) => {
    return userMap?.get(uid) ? `@${userMap.get(uid)}` : match;
  });
  return text.trim();
}

// ── NLP → action ──────────────────────────────────────────────────────────────

function _nlpToAction(intent, triggerType, score, threadTarget) {
  // Reply to Maya's own message → always engage
  if (threadTarget.isReplyToMaya) return 'reply';

  if (triggerType === 'mention') {
    if (intent === 'group_chatter' && score > 0.85) return 'lurk';
    return 'reply';
  }

  switch (intent) {
    case 'question_to_maya':  return 'reply';
    case 'emotional':         return 'reply';
    case 'engaged_reply':     return 'reply';
    case 'question_to_group': return 'lurk';
    case 'random_mention':    return 'lurk';
    case 'directed_at_other': return 'ignore';
    case 'group_chatter':     return 'ignore';
    default:                  return 'lurk';
  }
}

// ── LLM evaluation ────────────────────────────────────────────────────────────

async function _llmEvaluate(contextText, triggerText, triggerWord, triggerType, threadTarget) {
  const threadNote = threadTarget.isReplyToOther
    ? `\nIMPORTANT: The trigger message is a REPLY to ${threadTarget.targetName}'s message, not to Maya.`
    : threadTarget.isReplyToMaya
    ? `\nNOTE: The trigger message is a reply to Maya's own message.`
    : '';

  const prompt = `You are deciding whether an AI called Maya should respond to a Discord message.
Maya was triggered because someone used "${triggerWord}" (trigger type: ${triggerType}).${threadNote}

Recent conversation (messages marked [replying↑] are thread replies to the message above them):
${contextText}

Decide what Maya should do:
- REPLY: Message is clearly directed at Maya, warrants a verbal response
- REACT: Mildly relevant to Maya, emoji reaction only
- LURK: Maya mentioned in passing, interesting but not directed at her
- IGNORE: Conversation is between other people, Maya would be intruding

Respond with ONLY: one word (REPLY/REACT/LURK/IGNORE), then a newline, then one sentence why.`;

  try {
    const { data, status } = await axios.post(
      config.llm.endpoint,
      { model: config.llm.model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 60 },
      {
        headers: {
          'Content-Type': 'application/json', 'Authorization': `Bearer ${config.llm.apiKey}`,
          'HTTP-Referer': 'https://chatmasala.fun', 'X-Title': 'MayaDiscordBot',
        },
        timeout: 15_000, validateStatus: () => true,
      }
    );

    if (status !== 200) throw new Error(`HTTP ${status}`);
    const lines  = (data?.choices?.[0]?.message?.content?.trim() || '').split('\n').filter(Boolean);
    const word   = lines[0]?.toUpperCase().trim();
    const reason = lines[1] || '';
    const action = ['REPLY','REACT','LURK','IGNORE'].includes(word) ? word.toLowerCase() : 'lurk';
    console.log(`[notif] LLM: ${action} — ${reason.slice(0, 80)}`);
    return { action, reason: `llm:${reason.slice(0, 60)}` };

  } catch (e) {
    console.error('[notif] LLM eval failed:', e.message);
    return { action: threadTarget.isReplyToMaya ? 'reply' : triggerType === 'mention' ? 'lurk' : 'ignore', reason: 'llm-fallback' };
  }
}

// ── Online learning: log training examples ────────────────────────────────────

async function _logTraining(text, intent, source, nlpIntent, nlpScore, llmIntent, reward) {
  if (!text || text.length < 3 || text.length > 500) return;
  try {
    await db.execute(
      `INSERT INTO maya_nlp_training
         (text, intent, source, nlp_intent, nlp_score, llm_intent, reward)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [text.slice(0, 500), intent, source, nlpIntent, nlpScore, llmIntent, reward ?? null]
    );
  } catch { /* non-fatal */ }
}
