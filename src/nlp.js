/**
 * nlp.js — Intent classifier using NLP.js (node-nlp)
 *
 * Trains a neural intent classifier at startup with English + Hinglish
 * examples for each intent Maya needs to understand.
 *
 * Intents:
 *   question_to_maya    — user is asking Maya directly
 *   question_to_group   — open question to the room (Maya can contribute)
 *   emotional           — distress, venting, needs support
 *   directed_at_other   — talking to/about someone else, Maya should stay out
 *   random_mention      — Maya's name said in passing, not addressed to her
 *   engaged_reply       — short follow-up in an active back-and-forth
 *   group_chatter       — general conversation, Maya is background
 *
 * Returns: { intent, score, sentiment }
 *   score is cosine confidence 0–1. Use it to weight expression score.
 *   Falls back to { intent: 'group_chatter', score: 0.5 } on any error.
 *
 * Training takes ~1–2 seconds at startup. Model is kept in memory.
 * No file I/O, no API calls — fully local.
 */

import { NlpManager } from 'node-nlp';

const manager = new NlpManager({
  languages: ['en'],
  forceNER:  false,
  nlu:       { useNoneFeature: true, log: false },
  ner:       { useDuckling: false },
});

let _trained = false;
let _training = null;

// ── Training data ─────────────────────────────────────────────────────────────
// Each addDocument call: language, example utterance, intent label
// More examples = better accuracy. Mix of English + Hinglish.

function _addTrainingData() {

  // ── question_to_maya ────────────────────────────────────────────────────────
  // User is asking Maya something directly
  const qtm = [
    'what do you think',
    'what do you think about this',
    'what is your opinion',
    'do you agree',
    'do you know about this',
    'can you explain this',
    'tell me what you think',
    'what would you do',
    'maya what do you think',
    'have you heard of this',
    'do you like this',
    'would you recommend this',
    'can you help me with this',
    'what should i do',
    'what is the answer',
    'do you know the answer',
    'maya can you help',
    'please help me understand',
    'explain this to me',
    'give me your opinion',
    // Hinglish
    'kya lagta hai tujhe',
    'kya sochti hai tu',
    'tu bata kya karna chahiye',
    'tera kya opinion hai',
    'bata na maya',
    'maya bata',
    'help kar na',
    'samjha de mujhe',
    'kya lagta hai',
    'teri kya ray hai',
    'bata de yaar',
    'tu kya sochti hai iske baare mein',
    'mujhe bata de',
    'kya sahi hai kya galat',
    'kya karna chahiye mujhe',
    'maya help karo',
    'ek suggestion de',
    'maya teri advice chahiye',
  ];
  qtm.forEach(u => manager.addDocument('en', u, 'question_to_maya'));

  // ── question_to_group ───────────────────────────────────────────────────────
  // Open question to the room — Maya can contribute but wasn't asked directly
  const qtg = [
    'does anyone know',
    'has anyone tried',
    'what does everyone think',
    'who knows about this',
    'anyone here familiar with',
    'what is the best way to',
    'has anyone seen',
    'can anyone explain',
    'what are your thoughts everyone',
    'anyone have experience with',
    'who has used this before',
    'what do people think about',
    'is there anyone who knows',
    'anyone else feel this way',
    'what should we do',
    'any recommendations',
    'any suggestions',
    // Hinglish
    'koi bata sakta hai',
    'kisi ko pata hai',
    'kisi ne try kiya',
    'sab ka kya opinion hai',
    'kaun jaanta hai yeh',
    'koi idea hai',
    'kisi ke paas suggestion hai',
    'sab log kya sochte ho',
    'yaar koi bata do',
    'koi hai jo jaanta ho',
    'guys kya lagta hai',
    'bhai log kya sochte ho',
  ];
  qtg.forEach(u => manager.addDocument('en', u, 'question_to_group'));

  // ── emotional ───────────────────────────────────────────────────────────────
  // Distress, venting, needing support — Maya should engage with care
  const emo = [
    'i feel so sad',
    'i am really upset',
    'i am depressed',
    'i feel alone',
    'i am so stressed',
    'i am anxious about',
    'i am scared',
    'i am worried',
    'i miss them so much',
    'i feel like crying',
    'everything is going wrong',
    'i cant take this anymore',
    'i am exhausted',
    'i feel hopeless',
    'nobody understands me',
    'i am frustrated',
    'i am so tired of this',
    'i feel lost',
    'i am going through a hard time',
    'life is tough right now',
    'i broke up with my girlfriend',
    'i failed my exam',
    'i lost my job',
    'my friend betrayed me',
    'i feel so alone',
    // Hinglish
    'bahut bura lag raha hai',
    'dil nahi kar raha kuch karne ka',
    'bahut stressed hoon',
    'akela feel ho raha hai',
    'rona aa raha hai',
    'sab galat ho raha hai',
    'nahi ho raha mujhse',
    'bahut thak gaya hoon',
    'pareshan hoon bahut',
    'kuch theek nahi lag raha',
    'dil toot gaya',
    'bahut bura waqt chal raha hai',
    'koi samajhta nahi mujhe',
    'bahut gussa aa raha hai',
    'depression feel ho raha hai',
    'anxiety ho rahi hai',
    'dar lag raha hai',
    'kal exam tha aur fail ho gaya',
    'breakup ho gaya yaar',
    'naukri chali gayi',
  ];
  emo.forEach(u => manager.addDocument('en', u, 'emotional'));

  // ── directed_at_other ───────────────────────────────────────────────────────
  // Talking to or about someone else — Maya should stay out
  const dao = [
    'tell him what happened',
    'ask her about it',
    'bro what are you doing',
    'man you are crazy',
    'dude that is insane',
    'you are so funny',
    'seriously you need to stop',
    'tell mario about this',
    'ask danish what he thinks',
    'hey sai what do you think',
    'you guys are hilarious',
    'bro you need to calm down',
    'you should do this',
    'let him know',
    'tell them about it',
    'ask the others',
    'you two should talk',
    'he said that',
    'she told me',
    'they were saying',
    // Hinglish
    'yaar tu kya kar raha hai',
    'bhai tu pagal hai',
    'isko bata',
    'usse pooch',
    'bhai log sun',
    'mario ko bata',
    'danish se pooch',
    'tu bata yaar',
    'bhai sun',
    'unhe bolo',
    'use keh do',
    'tum log kya soch rahe ho',
    'bhai chill kar',
    'yaar chill maar',
    'bhai ruk',
    'oye sun',
  ];
  dao.forEach(u => manager.addDocument('en', u, 'directed_at_other'));

  // ── random_mention ──────────────────────────────────────────────────────────
  // Maya's name mentioned in passing, not being addressed
  const rm = [
    'maya was talking about this earlier',
    'maya said something about this',
    'like maya said',
    'as maya mentioned',
    'maya told me',
    'maya was here',
    'remember what maya said',
    'maya knows about this',
    'i heard from maya that',
    'maya already explained this',
    'maya was talking to me',
    'i told maya about it',
    // Hinglish
    'maya ne kaha tha',
    'maya ne bataya tha',
    'jaise maya ne kaha',
    'maya ko pata hai',
    'maya se pooch lena',
    'maya ne bola tha na',
    'maya wali baat yaad hai',
  ];
  rm.forEach(u => manager.addDocument('en', u, 'random_mention'));

  // ── engaged_reply ───────────────────────────────────────────────────────────
  // Short continuation in an active exchange — casual back and forth
  const er = [
    'yeah exactly',
    'no way',
    'seriously',
    'i know right',
    'oh wow',
    'that makes sense',
    'good point',
    'fair enough',
    'true true',
    'i agree',
    'not really',
    'kind of',
    'maybe',
    'depends',
    'probably yes',
    'i guess so',
    'makes sense',
    'interesting',
    'never thought about that',
    'good to know',
    // Hinglish
    'haan bilkul',
    'nahi yaar',
    'sach mein',
    'pata hai na',
    'theek hai',
    'hmm sahi hai',
    'haan sahi bola',
    'nahi lagta',
    'pata nahi yaar',
    'ho sakta hai',
    'shayad',
    'acha acha',
    'oh accha',
    'waah sahi hai',
  ];
  er.forEach(u => manager.addDocument('en', u, 'engaged_reply'));

  // ── group_chatter ───────────────────────────────────────────────────────────
  // General conversation noise, Maya is background
  const gc = [
    'lol',
    'haha',
    'lmao',
    'omg',
    'okay',
    'ok',
    'sure',
    'nice',
    'cool',
    'same',
    'mood',
    'facts',
    'bruh',
    'wtf',
    'no way',
    'what',
    'wait what',
    'good morning',
    'good night',
    'hey everyone',
    'sup guys',
    'what is up',
    'nothing much',
    'just chilling',
    'i am bored',
    'anyone online',
    'who is here',
    'let us play something',
    'i am eating right now',
    'just woke up',
    'going to sleep',
    'brb',
    'gtg',
    'see you later',
    'bye guys',
    // Hinglish
    'kal kya kiya',
    'kya ho raha hai',
    'kuch nahi bas timepass',
    'bore ho raha hoon',
    'sone ja raha hoon',
    'subah ho gayi',
    'kha raha hoon',
    'khel rahe ho',
    'chal kuch karte hai',
    'bhai kya scene hai',
    'kuch nahi yaar',
    'acha chalo',
    'haan bhai',
    'theek hai bhai',
    'chalo fir',
    'kal milte hai',
    'bye yaar',
    'gm bhai log',
    'gn sab',
  ];
  gc.forEach(u => manager.addDocument('en', u, 'group_chatter'));
}

// ── Train and export ──────────────────────────────────────────────────────────

/**
 * Train the NLP classifier. Call once at startup.
 * Returns a promise that resolves when training is complete.
 */
export async function trainNLP() {
  if (_trained) return;
  if (_training) return _training;

  _training = (async () => {
    console.log('[nlp] training intent classifier...');
    const start = Date.now();
    _addTrainingData();
    await manager.train();
    _trained = true;
    console.log(`[nlp] training complete in ${Date.now() - start}ms`);
  })();

  return _training;
}

/**
 * Classify a message. Returns intent + confidence + sentiment.
 *
 * @param {string} text
 * @returns {Promise<{
 *   intent:    string,   — one of the intent labels above
 *   score:     number,   — confidence 0–1
 *   sentiment: 'positive'|'negative'|'neutral',
 *   sentimentScore: number,
 * }>}
 */
export async function classify(text) {
  if (!_trained) {
    // Fallback if called before training completes
    return { intent: 'group_chatter', score: 0.5, sentiment: 'neutral', sentimentScore: 0 };
  }

  try {
    const result = await manager.process('en', text.toLowerCase().trim());

    const intent    = result.intent || 'group_chatter';
    const score     = result.score  || 0;
    const sentiment = result.sentiment?.vote || 'neutral';
    const sentimentScore = result.sentiment?.score || 0;

    return { intent, score, sentiment, sentimentScore };
  } catch (e) {
    console.error('[nlp] classify error:', e.message);
    return { intent: 'group_chatter', score: 0.5, sentiment: 'neutral', sentimentScore: 0 };
  }
}

/**
 * Quick sentiment-only check (no intent classification).
 * Faster when you only need positive/negative/neutral.
 */
export async function getSentiment(text) {
  if (!_trained) return { vote: 'neutral', score: 0 };
  try {
    const result = await manager.process('en', text.toLowerCase().trim());
    return { vote: result.sentiment?.vote || 'neutral', score: result.sentiment?.score || 0 };
  } catch { return { vote: 'neutral', score: 0 }; }
}
