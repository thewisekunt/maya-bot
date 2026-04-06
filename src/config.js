import 'dotenv/config';

// ── Model assignments ─────────────────────────────────────────────────────────
// Each pipeline uses the most appropriate model for its task.
// Override any via env vars (e.g. MODEL_CHAT=anthropic/claude-3-haiku).
//
// Pipeline    │ Model                                  │ Why
// ────────────┼────────────────────────────────────────┼──────────────────────
// chat        │ deepseek/deepseek-v3.2                 │ Best personality + Hinglish
// meta        │ nvidia/nemotron-3-super-120b-a12b:free │ Reasoning, structured JSON
// facts       │ nousresearch/hermes-3-llama-3.1-405b   │ Best JSON instruction follow
// dream       │ meta-llama/llama-3.3-70b-instruct:free │ Async, latency irrelevant
// utility     │ google/gemma-3-27b-it:free             │ Simple gen (welcome, inbox)
// vision      │ openai/gpt-4o-mini                     │ Image description
// fallback    │ openai/gpt-oss-120b:free               │ When primary rate-limits

const MODELS = {
  // Primary chat output — Maya's replies to users
  chat:     process.env.MODEL_CHAT    || 'deepseek/deepseek-v3.2',

  // Meta layer / inner voice — structured JSON, analytical
  meta:     process.env.MODEL_META    || 'nvidia/nemotron-3-super-120b-a12b:free',

  // Fact extraction + conflict scoring — precision JSON, runs rarely
  facts:    process.env.MODEL_FACTS   || 'nousresearch/hermes-3-llama-3.1-405b:free',

  // Dream cycle / belief analysis — async, latency doesn't matter
  dream:    process.env.MODEL_DREAM   || 'meta-llama/llama-3.3-70b-instruct:free',

  // Utility: welcome messages, inbox catchup, commitments, initiation
  // Lightweight generation — don't waste chat quota on these
  utility:  process.env.MODEL_UTILITY || 'google/gemma-3-27b-it:free',

  // Vision: image description
  vision:   process.env.MODEL_VISION  || 'openai/gpt-4o-mini',

  // Deliberation / search / think.js — needs reasoning
  think:    process.env.MODEL_THINK   || 'meta-llama/llama-3.3-70b-instruct:free',

  // Fallback: used when primary is rate-limited (3 retries then this)
  fallback: process.env.MODEL_FALLBACK || 'openai/gpt-oss-120b:free',
};

export const config = {
  discord: {
    token:           process.env.DISCORD_TOKEN,
    prefix:          process.env.BOT_PREFIX          || '!maya',
    allowedChannels: process.env.ALLOWED_CHANNELS
                       ? process.env.ALLOWED_CHANNELS.split(',').map(s => s.trim()).filter(Boolean)
                       : [],
  },
  llm: {
    apiKey:      process.env.OPENROUTER_API_KEY,
    endpoint:    'https://openrouter.ai/api/v1/chat/completions',
    // Named model map — use config.models.X throughout the codebase
    models:      MODELS,
    // Legacy: config.llm.model still works for any callers not yet updated
    model:       MODELS.chat,
    maxTokens:   parseInt(process.env.LLM_MAX_TOKENS   || '120'),
    temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.9'),
  },
  db: {
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT || '3306'),
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
  },
  bot: {
    memoryLimit:     parseInt(process.env.MEMORY_LIMIT  || '24'),
    typingIndicator: process.env.TYPING_INDICATOR !== 'false',
    debugLog:        process.env.DEBUG_LOG        !== 'false',
    aliases:         process.env.BOT_ALIASES
                       ? process.env.BOT_ALIASES.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
                       : [],
  },
};

// Validate required env vars on startup
const required = ['DISCORD_TOKEN', 'OPENROUTER_API_KEY', 'DB_NAME', 'DB_USER', 'DB_PASS'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[config] Missing required env var: ${key}`);
    process.exit(1);
  }
}

// Log model assignments on startup
console.log('[config] Model assignments:');
for (const [role, model] of Object.entries(MODELS)) {
  console.log(`  ${role.padEnd(10)} → ${model}`);
}
