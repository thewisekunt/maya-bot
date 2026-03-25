# Maya Discord Bot 🤖✨

Witty Hinglish Discord bestie powered by **OpenRouter LLM** + **MySQL** memory.

---

## File Structure

```
maya-bot/
├── src/
│   ├── index.js      ← Discord client + event listeners (entry point)
│   ├── handler.js    ← Full message pipeline (orchestrates everything)
│   ├── llm.js        ← OpenRouter API caller with retry
│   ├── persona.js    ← Upsert user, name-set detection, entropy zones
│   ├── memory.js     ← Fetch context + persist messages
│   ├── logger.js     ← Daily rotating debug logs → ./logs/
│   └── config.js     ← All config loaded from .env
├── setup_db.sql      ← Run once to create DB tables
├── package.json
├── .env.example      ← Copy to .env and fill in your values
└── README.md
```

---

## Setup — Step by Step

### 1. Prerequisites
- Node.js **18+** (`node --version`)
- A MySQL / MariaDB database (Hostinger, PlanetScale, local, etc.)
- A Discord bot application
- An OpenRouter API key

---

### 2. Create the Discord Bot

1. Go to **https://discord.com/developers/applications**
2. Click **New Application** → give it a name (e.g. Maya)
3. Go to **Bot** → click **Add Bot**
4. Under **Privileged Gateway Intents**, enable:
   - ✅ **MESSAGE CONTENT INTENT**  ← required
   - ✅ Server Members Intent (optional, for display names)
5. Copy your **Bot Token** → paste into `.env` as `DISCORD_TOKEN`
6. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Message History`, `View Channels`
7. Copy the generated URL, open it in a browser, and invite Maya to your server

---

### 3. Set up the Database

Run `setup_db.sql` once against your MySQL database:

```bash
mysql -h your_host -u your_user -p your_database < setup_db.sql
```

Or paste its contents into **phpMyAdmin → SQL tab**.

---

### 4. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in every value:

```env
DISCORD_TOKEN=your_bot_token_here
OPENROUTER_API_KEY=sk-or-v1-...
DB_HOST=localhost
DB_NAME=u823126078_chatamasala
DB_USER=u823126078_chatmasala
DB_PASS=your_password
```

---

### 5. Install & Run

```bash
npm install
npm start
```

For development with auto-restart on file changes:

```bash
npm run dev
```

---

## How Maya Responds

Maya replies when someone:
- **Mentions her** → `@Maya hey what's up`
- **Uses the prefix** → `!maya tell me something`
- **DMs her directly** → any message in DMs

To restrict her to specific channels, add their IDs in `.env`:
```
ALLOWED_CHANNELS=1234567890,0987654321
```
Leave it empty to let her respond everywhere.

---

## Commands (natural language)

| What you say | What happens |
|---|---|
| `my name is Priya` | Maya calls you Priya from now on (persisted to DB) |
| `@Maya ...` | She replies to you |
| `!maya ...` | Prefix trigger |

---

## Changing the LLM Model

Edit `LLM_MODEL` in `.env`. Any model on OpenRouter works:

```env
LLM_MODEL=anthropic/claude-3.5-haiku   # faster, cheaper
LLM_MODEL=openai/gpt-4o                 # smarter
LLM_MODEL=meta-llama/llama-3.3-70b-instruct
```

Full model list: **https://openrouter.ai/models**

---

## Hosting on a VPS / Hostinger

### Keep it running with PM2

```bash
npm install -g pm2
pm2 start src/index.js --name maya-bot
pm2 save
pm2 startup     # auto-start on reboot
```

### Check logs

```bash
pm2 logs maya-bot          # live logs
cat logs/maya_2025-01-15.log   # daily debug log
```

---

## Customising Maya's Personality

Edit the `SYSTEM_PROMPT` constant in `src/llm.js`:

```js
const SYSTEM_PROMPT = `You are Maya — ...`;
```

Change her name, language style, vibe, or rules there. The rest of the code doesn't care what persona she has.
