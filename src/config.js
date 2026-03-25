import 'dotenv/config';

export const config = {
  discord: {
    token:           process.env.DISCORD_TOKEN,
    prefix:          process.env.BOT_PREFIX          || '!maya',
    allowedChannels: process.env.ALLOWED_CHANNELS
                       ? process.env.ALLOWED_CHANNELS.split(',').map(s => s.trim()).filter(Boolean)
                       : [],   // empty = all channels
  },
  llm: {
    apiKey:      process.env.OPENROUTER_API_KEY,
    model:       process.env.LLM_MODEL        || 'openai/gpt-4o-mini',
    maxTokens:   parseInt(process.env.LLM_MAX_TOKENS  || '120'),
    temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.9'),
    endpoint:    'https://openrouter.ai/api/v1/chat/completions',
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
