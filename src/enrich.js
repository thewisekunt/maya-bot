/**
 * enrich.js — Memory payload enrichment
 *
 * Runs lightweight sentiment + topic extraction on every memory
 * before it hits Qdrant. Called from vector.js intercept layer.
 *
 * This is Phase 1 of the memory reconstruction system.
 * Future phases (centroid, mental model, reconstruction) build on
 * the metadata added here.
 *
 * Fields added to every payload:
 *   emotion      {string}   — dominant emotion label
 *   valence      {number}   — -1.0 (negative) to +1.0 (positive)
 *   arousal      {number}   — 0.0 (calm) to 1.0 (intense)
 *   topic_tags   {string[]} — 2-3 keyword topic labels
 *   session_id   {string}   — passed through if present in source payload
 *   enriched_at  {string}   — ISO timestamp
 *
 * Design constraints:
 *   - Must be fast — runs on every memory store, blocks the upsert
 *   - No LLM call — pure lexical analysis only
 *   - No network calls — works offline
 *   - Non-fatal — if enrichment fails, upsert proceeds with defaults
 */

// ── Emotion lexicons ──────────────────────────────────────────────────────────
// Valence: positive = +, negative = -, neutral = 0
// Arousal: high = intense/excited, low = calm/settled

const EMOTION_MAP = [
  // High positive valence, high arousal
  { words: ['love', 'adore', 'amazing', 'excited', 'thrilled', 'ecstatic', 'obsessed', 'omg', 'yay', 'bestie', 'wohoo', 'incredible'], emotion: 'joy',       valence:  0.9, arousal: 0.9 },
  // High positive valence, low arousal
  { words: ['happy', 'glad', 'nice', 'good', 'great', 'warm', 'comfortable', 'peaceful', 'content', 'fine', 'okay', 'chill'],         emotion: 'content',   valence:  0.6, arousal: 0.3 },
  // Positive social
  { words: ['fun', 'funny', 'lol', 'lmao', 'haha', 'laugh', 'joke', 'rofl', 'humor', 'tease', 'playful'],                             emotion: 'playful',   valence:  0.7, arousal: 0.6 },
  // Curiosity / interest
  { words: ['interesting', 'curious', 'wonder', 'fascinating', 'why', 'how', 'tell me', 'explain', 'what if'],                         emotion: 'curious',   valence:  0.4, arousal: 0.5 },
  // Affection
  { words: ['miss', 'missed', 'care', 'caring', 'sweet', 'cute', 'darling', 'dear', 'hug', 'heart'],                                  emotion: 'affection', valence:  0.8, arousal: 0.4 },
  // Sadness
  { words: ['sad', 'upset', 'cry', 'crying', 'tears', 'hurt', 'broken', 'lonely', 'alone', 'miss you', 'depressed', 'hopeless'],      emotion: 'sadness',   valence: -0.7, arousal: 0.3 },
  // Anger / frustration
  { words: ['angry', 'mad', 'furious', 'hate', 'annoyed', 'irritated', 'pissed', 'frustrated', 'wtf', 'ugh', 'stfu', 'shut up'],      emotion: 'anger',     valence: -0.8, arousal: 0.9 },
  // Anxiety / worry
  { words: ['worried', 'anxious', 'nervous', 'scared', 'fear', 'stress', 'stressed', 'panic', 'overwhelmed', 'tense'],                emotion: 'anxiety',   valence: -0.6, arousal: 0.7 },
  // Disgust / rejection
  { words: ['gross', 'disgusting', 'ew', 'eww', 'yuck', 'cringe', 'no way', 'terrible', 'awful', 'horrible', 'worst'],               emotion: 'disgust',   valence: -0.7, arousal: 0.5 },
  // Surprise
  { words: ['wow', 'whoa', 'wait', 'really', 'seriously', 'omg', 'what', 'no way', 'shocking', 'unexpected'],                         emotion: 'surprise',  valence:  0.1, arousal: 0.8 },
  // Boredom / flatness
  { words: ['bored', 'boring', 'meh', 'whatever', 'idc', 'idk', 'doesnt matter', 'timepass', 'nothing'],                              emotion: 'boredom',   valence: -0.2, arousal: 0.1 },
  // Vulnerability / openness
  { words: ['honest', 'honestly', 'truth', 'real talk', 'actually', 'confess', 'admit', 'feel like', 'sometimes i'],                  emotion: 'vulnerable',valence:  0.2, arousal: 0.4 },
];

// Hinglish emotion signals
const HINGLISH_MAP = [
  { words: ['accha', 'achha', 'theek', 'bilkul', 'haan', 'sahi'],         emotion: 'content',   valence:  0.5, arousal: 0.2 },
  { words: ['nahi', 'nope', 'mat', 'band kar', 'chup'],                   emotion: 'anger',     valence: -0.5, arousal: 0.6 },
  { words: ['yaar', 'bhai', 'arre', 'arrey'],                              emotion: 'playful',   valence:  0.5, arousal: 0.5 },
  { words: ['kal', 'baad mein', 'baad', 'phir'],                          emotion: 'boredom',   valence: -0.1, arousal: 0.2 },
  { words: ['dil', 'pyaar', 'mohabbat', 'ishq'],                          emotion: 'affection', valence:  0.9, arousal: 0.5 },
  { words: ['dukh', 'dard', 'ro', 'rona', 'rota'],                        emotion: 'sadness',   valence: -0.7, arousal: 0.4 },
];

// ── Topic lexicons ────────────────────────────────────────────────────────────

const TOPIC_MAP = [
  { tag: 'relationships',  words: ['relationship', 'dating', 'boyfriend', 'girlfriend', 'partner', 'marriage', 'love', 'crush', 'couple', 'ex', 'breakup', 'propose'] },
  { tag: 'family',         words: ['family', 'mom', 'dad', 'sister', 'brother', 'parents', 'mother', 'father', 'sibling', 'cousin', 'uncle', 'aunt', 'maa', 'papa', 'bhai', 'behen'] },
  { tag: 'work_study',     words: ['work', 'job', 'college', 'class', 'study', 'exam', 'assignment', 'project', 'school', 'office', 'career', 'internship', 'deadline', 'marks'] },
  { tag: 'technology',     words: ['code', 'coding', 'programming', 'tech', 'software', 'app', 'bot', 'ai', 'computer', 'laptop', 'server', 'api', 'deploy', 'bug', 'node', 'python'] },
  { tag: 'mental_health',  words: ['anxious', 'anxiety', 'depressed', 'depression', 'therapy', 'mental', 'stress', 'overwhelmed', 'burnout', 'panic', 'trauma', 'heal', 'lonely'] },
  { tag: 'humor',          words: ['lol', 'lmao', 'funny', 'joke', 'meme', 'rofl', 'haha', 'humor', 'laugh', 'troll', 'sarcasm', 'pun'] },
  { tag: 'gaming',         words: ['game', 'gaming', 'play', 'discord', 'stream', 'twitch', 'xbox', 'playstation', 'pc', 'fps', 'rpg', 'minecraft', 'valorant', 'rank'] },
  { tag: 'music',          words: ['music', 'song', 'playlist', 'album', 'artist', 'band', 'concert', 'spotify', 'listen', 'vibe', 'rap', 'pop', 'guitar', 'lyrics'] },
  { tag: 'food',           words: ['food', 'eat', 'hungry', 'lunch', 'dinner', 'breakfast', 'cook', 'recipe', 'taste', 'restaurant', 'khana', 'chai', 'coffee'] },
  { tag: 'identity',       words: ['i am', 'myself', 'personality', 'who i am', 'feel like', 'type of person', 'always', 'never', 'believe', 'value', 'opinion'] },
  { tag: 'conflict',       words: ['fight', 'argue', 'argument', 'disagree', 'problem', 'issue', 'upset', 'angry', 'hurt', 'unfair', 'wrong', 'mistake', 'sorry', 'apologize'] },
  { tag: 'plans',          words: ['plan', 'going to', 'will', 'tomorrow', 'next week', 'later', 'future', 'want to', 'thinking of', 'maybe', 'probably', 'soon'] },
  { tag: 'memory',         words: ['remember', 'forgot', 'used to', 'before', 'ago', 'back then', 'that time', 'when we', 'last time', 'recall', 'miss'] },
  { tag: 'maya_self',      words: ['maya', 'you are', 'you seem', 'you always', 'you never', 'your', 'you feel', 'about you', 'tell me about yourself'] },
  { tag: 'social',         words: ['friends', 'friend', 'people', 'everyone', 'someone', 'anyone', 'group', 'server', 'chat', 'community', 'social'] },
  { tag: 'emotions',       words: ['feel', 'feeling', 'emotion', 'mood', 'vibe', 'energy', 'state', 'heart', 'soul', 'deep'] },
  { tag: 'philosophy',     words: ['life', 'meaning', 'purpose', 'exist', 'reality', 'truth', 'world', 'universe', 'why', 'what is', 'think about'] },
];

// ── Main enrichment function ──────────────────────────────────────────────────

/**
 * Enrich a memory payload with emotion, valence, arousal, topic_tags.
 * Mutates the payload in place and returns it.
 * Non-fatal — on any error returns payload with safe defaults.
 *
 * @param {object} payload  — Qdrant point payload
 * @returns {object}        — enriched payload
 */
export function enrichPayload(payload) {
  try {
    const text = _getText(payload);
    if (!text) return _applyDefaults(payload);

    const lower = text.toLowerCase();
    const tokens = lower.split(/\s+/);

    // ── Emotion detection ─────────────────────────────────────────────────
    let bestMatch  = null;
    let bestScore  = 0;

    const allMaps = [...EMOTION_MAP, ...HINGLISH_MAP];
    for (const entry of allMaps) {
      let score = 0;
      for (const word of entry.words) {
        if (lower.includes(word)) {
          // Longer word matches score higher — avoids "no" matching "not"
          score += word.split(' ').length > 1 ? 2 : 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = entry;
      }
    }

    // Entropy modulates arousal — high entropy = more intense
    const entropy = parseFloat(payload.entropy) || 0.3;
    const entropyArousalBoost = (entropy - 0.3) * 0.3;  // small boost above baseline

    const emotion = bestMatch?.emotion   ?? 'neutral';
    const valence = bestMatch?.valence   ?? 0.0;
    const arousal = bestMatch
      ? Math.min(1.0, (bestMatch.arousal ?? 0.4) + entropyArousalBoost)
      : 0.4 + entropyArousalBoost;

    // ── Topic detection ───────────────────────────────────────────────────
    const topicScores = [];
    for (const entry of TOPIC_MAP) {
      let score = 0;
      for (const word of entry.words) {
        if (lower.includes(word)) {
          score += word.includes(' ') ? 3 : 1;
        }
      }
      if (score > 0) topicScores.push({ tag: entry.tag, score });
    }

    // Sort by score, take top 3
    topicScores.sort((a, b) => b.score - a.score);
    const topic_tags = topicScores.slice(0, 3).map(t => t.tag);
    if (!topic_tags.length) topic_tags.push('general');

    // ── Apply enrichment ──────────────────────────────────────────────────
    payload.emotion     = emotion;
    payload.valence     = Math.round(valence * 100) / 100;
    payload.arousal     = Math.round(arousal * 100) / 100;
    payload.topic_tags  = topic_tags;
    payload.enriched_at = new Date().toISOString();

    // Preserve session_id if already set (salience.js sets it)
    if (!payload.session_id) payload.session_id = null;

    return payload;

  } catch (e) {
    console.warn('[enrich] enrichPayload failed:', e.message);
    return _applyDefaults(payload);
  }
}

/**
 * Enrich a batch of payloads.
 * @param {object[]} payloads
 * @returns {object[]}
 */
export function enrichBatch(payloads) {
  return payloads.map(p => enrichPayload(p));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _getText(payload) {
  // Different memory types store text in different fields
  return payload.message
    || payload.fact_text
    || payload.summary
    || payload.content
    || '';
}

function _applyDefaults(payload) {
  if (!payload.emotion)     payload.emotion     = 'neutral';
  if (!payload.valence)     payload.valence     = 0.0;
  if (!payload.arousal)     payload.arousal     = 0.4;
  if (!payload.topic_tags)  payload.topic_tags  = ['general'];
  if (!payload.session_id)  payload.session_id  = null;
  if (!payload.enriched_at) payload.enriched_at = new Date().toISOString();
  return payload;
}
