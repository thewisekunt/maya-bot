/**
 * notif.js — Notification Evaluator
 *
 * Receives a notification from scanner.js.
 * Fetches surrounding conversation context from Discord.
 * Evaluates whether Maya should engage.
 *
 * Two-stage evaluation:
 *   1. NLP (local, instant) — classify intent from context window
 *   2. LLM (API, ~1s) — only if NLP confidence < 0.7 (uncertain)
 *
 * Returns one of:
 *   REPLY    — Maya should reply to this message
 *   REACT    — Maya should react with an emoji but not speak
 *   LURK     — Something happened, Maya should watch but not engage yet
 *   IGNORE   — Not worth Maya's attention
 */

import { classify } from './nlp.js';
import { config } from './config.js';
import axios from 'axios';

const CONTEXT_WINDOW   = 10;   // messages to fetch before the trigger
const NLP_THRESHOLD    = 0.7;  // below this → escalate to LLM

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Evaluate a notification and decide what Maya should do.
 *
 * @param {Notification} notif   — from scanner.js
 * @param {string}       botId   — bot's Discord user ID
 *
 * @returns {Promise<{
 *   action:   'reply'|'react'|'lurk'|'ignore',
 *   reason:   string,
 *   confidence: number,
 *   context:  Message[],   — the surrounding messages fetched
 *   emoji?:   string,
 * }>}
 */
export async function evaluate(notif, botId) {
  const { msg, triggerType, triggerWord, isDM } = notif;

  // ── DMs always get a reply ─────────────────────────────────────────────────
  if (isDM) {
    return { action: 'reply', reason: 'DM', confidence: 1.0, context: [] };
  }

  // ── Fetch surrounding context ─────────────────────────────────────────────
  const context = await _fetchContext(msg, CONTEXT_WINDOW);

  // ── Build context text for analysis ──────────────────────────────────────
  const contextText = _buildContextText(context, msg, botId);

  // ── Stage 1: NLP evaluation ───────────────────────────────────────────────
  const triggerText = msg.content.replace(/<@!?\d+>/g, '').trim();
  const nlpResult   = await classify(triggerText);

  console.log(`[notif] trigger="${triggerWord}" type=${triggerType} nlp=${nlpResult.intent}(${nlpResult.score.toFixed(2)})`);

  // Certain enough — decide from NLP alone
  if (nlpResult.score >= NLP_THRESHOLD) {
    const action = _nlpToAction(nlpResult.intent, triggerType, nlpResult.score);
    return { action, reason: `nlp:${nlpResult.intent}@${nlpResult.score.toFixed(2)}`, confidence: nlpResult.score, context };
  }

  // ── Stage 2: LLM evaluation (NLP uncertain) ───────────────────────────────
  console.log(`[notif] NLP uncertain (${nlpResult.score.toFixed(2)}) — escalating to LLM`);
  const llmAction = await _llmEvaluate(contextText, triggerText, triggerWord, triggerType);
  return { ...llmAction, confidence: 0.5 + (llmAction.action === 'reply' ? 0.3 : 0), context };
}

// ── Fetch surrounding messages ────────────────────────────────────────────────

async function _fetchContext(msg, limit) {
  try {
    // Fetch messages before the trigger
    const before = await msg.channel.messages.fetch({
      limit,
      before: msg.id,
    });

    // Sort chronologically (Discord returns newest first)
    const sorted = [...before.values()].reverse();

    // Include the trigger message itself at the end
    return [...sorted, msg];
  } catch (e) {
    console.error('[notif] context fetch failed:', e.message);
    return [msg];
  }
}

// ── Build readable context text ───────────────────────────────────────────────

function _buildContextText(context, triggerMsg, botId) {
  return context.map(m => {
    const who   = m.author.id === botId ? 'Maya' : (m.member?.displayName || m.author.username);
    const text  = m.content.replace(/<@!?\d+>/g, '').trim() || '[media]';
    const flag  = m.id === triggerMsg.id ? ' ← [TRIGGER]' : '';
    return `${who}: ${text}${flag}`;
  }).join('\n');
}

// ── NLP → action mapping ──────────────────────────────────────────────────────

function _nlpToAction(intent, triggerType, score) {
  // Direct mentions always get at minimum a lurk
  if (triggerType === 'mention') {
    if (intent === 'group_chatter' && score > 0.85) return 'lurk';
    return 'reply';
  }

  switch (intent) {
    case 'question_to_maya':   return 'reply';
    case 'emotional':          return 'reply';
    case 'question_to_group':  return 'lurk';    // watch but don't jump in
    case 'engaged_reply':      return 'reply';
    case 'directed_at_other':  return 'ignore';
    case 'random_mention':     return 'lurk';
    case 'group_chatter':      return 'ignore';
    default:                   return 'lurk';
  }
}

// ── LLM evaluation ────────────────────────────────────────────────────────────

async function _llmEvaluate(contextText, triggerText, triggerWord, triggerType) {
  const prompt = `You are deciding whether an AI called Maya should respond to a Discord message.

Maya was triggered because someone used the word/alias "${triggerWord}" (trigger type: ${triggerType}).

Here is the recent conversation context (10 messages), with the triggering message marked:
${contextText}

Based on this context, decide what Maya should do:
- REPLY: The message is clearly directed at Maya and warrants a verbal response
- REACT: The message acknowledges Maya or is mildly relevant (emoji reaction only)
- LURK: Maya was mentioned in passing or the conversation is interesting but not directed at her
- IGNORE: The mention was incidental, the conversation is between others, Maya would be intruding

Respond with ONLY one word: REPLY, REACT, LURK, or IGNORE
Then on the next line, one sentence explaining why.`;

  try {
    const { data, status } = await axios.post(
      config.llm.endpoint,
      {
        model:       config.llm.model,
        messages:    [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens:  60,
      },
      {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.llm.apiKey}`,
          'HTTP-Referer':  'https://chatmasala.fun',
          'X-Title':       'MayaDiscordBot',
        },
        timeout:        15_000,
        validateStatus: () => true,
      }
    );

    if (status !== 200) throw new Error(`HTTP ${status}`);

    const raw    = data?.choices?.[0]?.message?.content?.trim() || '';
    const lines  = raw.split('\n').filter(Boolean);
    const word   = lines[0]?.toUpperCase().trim();
    const reason = lines[1] || '';

    const action = ['REPLY','REACT','LURK','IGNORE'].includes(word)
      ? word.toLowerCase()
      : 'lurk';

    console.log(`[notif] LLM decided: ${action} — ${reason.slice(0, 80)}`);
    return { action, reason: `llm:${reason.slice(0, 60)}` };

  } catch (e) {
    console.error('[notif] LLM eval failed:', e.message);
    // Fallback: if direct mention, lurk at minimum
    return {
      action: triggerType === 'mention' ? 'lurk' : 'ignore',
      reason: 'llm-fallback',
    };
  }
}
