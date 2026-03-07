# Telegram → MAX Bridge Bot

A lightweight Node.js bridge that automatically reposts messages from **Telegram** channels to **MAX** (max.ru) channels, including text formatting, images, videos, audio, and file attachments.

---

## Features

- **Text** — Telegram markdown entities (bold, italic, links, code, …) converted to MAX markdown
- **Images** — forwarded via MAX upload API
- **Video / Audio / Files** — downloaded from Telegram and uploaded to MAX
- **Large videos (> 20 MB)** — downloaded via MTProto (requires optional `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`, see below)
- **Media albums** — Telegram `media_group` arrives as a single MAX message with multiple attachments
- **Source footer** — optional "tg: [Channel](link)" footer on every reposted message
- **Multiple routes** — fan-out from one source to many destinations, or many independent routes
- **Queue with delay** — configurable per-route repost delay to avoid rate limits

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 18.18 | |
| A **Telegram Bot** | [@BotFather](https://t.me/BotFather) — must be added as **admin** to each source channel |
| A **MAX Bot** | [MAX developer portal](https://dev.max.ru) — must be added as **admin** to each destination channel |
| A Linux server | For production (the deploy script uses SSH + PM2) |
| `sshpass` on your local machine | Only if deploying with password auth — `brew install sshpass` / `apt install sshpass` |

---

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/your-org/max_bot.git
cd max_bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env   # or create .env manually (see reference below)
```

### 3. Add bots to channels

- Add your **Telegram bot** as an **admin** (can post messages) to every Telegram source channel.
- Add your **MAX bot** as an **admin** to every MAX destination channel.
- Post at least one message in each Telegram channel so the bot can discover it via updates.

### 4. Deploy

```bash
./scripts/deploy.sh
```

If `config/routes.json` does not exist yet, the script calls `./bridge.sh` automatically to discover channels and generate routes.

---

## Environment variables

Create a `.env` file in the project root. **Never commit it** (already in `.gitignore`).

```dotenv
# ── Required ────────────────────────────────────────────────────────────────

# Telegram Bot token (from @BotFather)
TELEGRAM_BOT_TOKEN=1234567890:AAXXXXXX

# MAX Bot token (from MAX developer portal)
MAX_BOT_TOKEN=your_max_token_here

# ── Deployment (required for deploy.sh) ─────────────────────────────────────

REMOTE_HOST=1.2.3.4
REMOTE_USER=root
REMOTE_PASSWORD=secret          # leave empty to use SSH key auth

# ── Optional – MTProto (for large video support) ─────────────────────────────
#
# The public Telegram Bot API cannot download files larger than 20 MB.
# If TELEGRAM_API_ID and TELEGRAM_API_HASH are provided, the bridge uses
# MTProto (via gramjs) to download oversized videos and re-upload them to MAX.
#
# Without these credentials everything still works — text, images, and videos
# up to 20 MB are bridged normally. Videos over 20 MB will include a warning
# note in the post instead of the video attachment.
#
# How to get your credentials:
#   1. Log in at https://my.telegram.org/apps
#   2. Create an application (any name/platform)
#   3. Copy "App api_id" and "App api_hash"
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
# Path to the MTProto session file (auto-created on first run, gitignored)
# TELEGRAM_MTPROTO_SESSION_FILE=.mtproto_session

# ── Optional – advanced ──────────────────────────────────────────────────────

# Override Telegram API base URL (e.g. for a self-hosted Bot API server)
# TELEGRAM_API_BASE_URL=https://api.telegram.org

# Path to the routing config (default: config/routes.json)
# ROUTING_CONFIG_PATH=config/routes.json

# Delay between reposts in ms (default: 3000)
# DEFAULT_REPOST_DELAY_MS=3000

# Window to collect media_group messages before forwarding (default: 1200)
# DEFAULT_MEDIA_GROUP_COLLECT_MS=1200

# Append a "tg: [Source](link)" footer to every reposted message (default: true)
# DEFAULT_INCLUDE_TELEGRAM_FOOTER=true
```

---

## Routing config

Routes live in `config/routes.json` (gitignored — generated per deployment).

```jsonc
{
  "routes": [
    {
      "id": "my_route",
      "enabled": true,
      "source": {
        "network": "telegram",
        "chat_id": -1001234567890,       // numeric chat id
        "chat_username": "mychannel"     // optional, used as fallback
      },
      "destinations": [
        { "network": "max", "chat_id": -70999000000000 }
      ],
      "options": {
        "repost_delay_ms": 3000,
        "media_group_collect_ms": 1200,
        "include_telegram_footer": true
      }
    }
  ]
}
```

Supported source networks: `telegram`, `max`.  
Supported destination networks: `max`, `telegram`.

### Auto-discovery (`bridge.sh`)

Running `./bridge.sh` (or `./scripts/deploy.sh` on a fresh install) will:

1. Poll Telegram for recent updates to find channels where the bot is an admin.
2. Call MAX API to list channels where the bot is an admin.
3. Generate `config/routes.json` with every Telegram source → every MAX destination.

> **Note:** Telegram Bot API does not expose a full list of the bot's chats. For
> auto-discovery to work, each channel must have had at least one message after
> the bot was added as admin.

To regenerate routes (e.g. after adding new channels):

```bash
./bridge.sh --force
./scripts/deploy.sh
```

---

## Deployment

`scripts/deploy.sh` does the following on the remote server:

1. Creates `/opt/max_bot/` directory structure.
2. Uploads source files via SCP.
3. Runs `npm ci --omit=dev`.
4. Installs PM2 globally (if not present).
5. Starts / restarts the process via `ecosystem.config.js` and saves the PM2 process list.

```bash
./scripts/deploy.sh
```

Monitor logs after deploy:

```bash
# from local machine
source .env
sshpass -p "$REMOTE_PASSWORD" ssh "$REMOTE_USER@$REMOTE_HOST" "pm2 logs max-repost-bot --lines 50"
```

---

## Large video support (MTProto)

The public Telegram Bot API limits file downloads to **20 MB**. To bridge larger videos:

1. Go to [https://my.telegram.org/apps](https://my.telegram.org/apps) and create an app.
2. Add `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` to your `.env`.
3. Deploy — on first start, the bridge authenticates via MTProto and saves a session to `.mtproto_session` (gitignored). Subsequent restarts reuse the session automatically.

When MTProto is active, the bridge will:
- Bypass the Bot API entirely for files it knows are > 20 MB.
- Fall back to MTProto automatically for any `"file is too big"` error.
- Log download progress every 25%: `MTProto download 25% {received_mb: 12}`.

**Without MTProto credentials** everything still works — videos over 20 MB will arrive as a text post with the note:
> *Вложение из Telegram не скопировано: файл слишком большой для Bot API.*

---

## Security

- Messages are only reposted from sources **explicitly listed** in `config/routes.json`.
- If someone adds the bot to an unlisted channel, all messages from it are silently ignored.
- All destination channels are also explicit — no auto-forwarding to discovered chats.

---

## Project structure

```
├── src/
│   └── index.js              # Main bridge runtime (polling + queue + forwarding)
├── scripts/
│   ├── bridge-init.js        # One-shot channel discovery & config generator
│   ├── deploy.sh             # SSH deploy script
│   ├── validate-telegram-org.js   # Check TELEGRAM_API_ID/HASH format
│   └── validate-telegram-org.py  # Live connection test via Telethon (optional)
├── config/
│   └── routes.json           # Generated routing config (gitignored)
├── ecosystem.config.js       # PM2 process config
├── bridge.sh                 # Entry-point: runs bridge-init.js
└── .env                      # Secrets (gitignored)
```

---

## License

MIT
