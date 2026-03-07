# Telegram → MAX Bridge Bot

**[Русский](README.ru.md)** | English

A lightweight Node.js bridge that automatically reposts messages from **Telegram** channels and groups to **MAX** (max.ru) channels, including text formatting, images, videos, audio, and file attachments.

---

## Features

- **Text** — Telegram markdown entities (bold, italic, links, code, …) converted to MAX markdown
- **Images** — forwarded via MAX upload API
- **Video / Audio / Files** — downloaded from Telegram and uploaded to MAX
- **Large videos (> 20 MB)** — downloaded via MTProto (requires optional `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`)
- **Media albums** — Telegram `media_group` arrives as a single MAX message with multiple attachments
- **Source footer** — optional "tg: [Channel](link)" footer on every reposted message
- **Multiple routes** — fan-out from one source to many destinations, or many independent routes
- **Queue with delay** — configurable per-route repost delay to avoid rate limits
- **Groups & supergroups** — works with Telegram channels, groups, and supergroups as sources

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 18.18 | |
| A **Telegram Bot** | [@BotFather](https://t.me/BotFather) — must be added as **admin** to each source channel/group |
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
cp .env.example .env
```

### 3. Add bots to chats

- Add your **Telegram bot** as **admin** to every Telegram source channel/group.
- Add your **MAX bot** as **admin** to every MAX destination channel.

### 4. Deploy

```bash
./scripts/deploy.sh
```

If `config/routes.json` does not exist yet, the script calls `./bridge.sh` automatically to discover channels and generate routes.

---

## Environment variables

```dotenv
# ── Required ────────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=1234567890:AAXXXXXX
MAX_BOT_TOKEN=your_max_token_here

# ── Deployment (required for deploy.sh) ─────────────────────────────────────
REMOTE_HOST=1.2.3.4
REMOTE_USER=root
REMOTE_PASSWORD=secret          # leave empty to use SSH key auth

# ── Optional – MTProto (for large video > 20 MB) ─────────────────────────────
TELEGRAM_API_ID=
TELEGRAM_API_HASH=

# ── Optional – advanced ──────────────────────────────────────────────────────
# TELEGRAM_API_BASE_URL=https://api.telegram.org
# ROUTING_CONFIG_PATH=config/routes.json
# DEFAULT_REPOST_DELAY_MS=3000
# DEFAULT_MEDIA_GROUP_COLLECT_MS=1200
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
        "chat_id": -1001234567890,
        "chat_username": "mychannel"     // optional fallback
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

---

## Managing bridges

### `/chatid` command

Send `/chatid` in any Telegram chat or MAX channel where the bot is present — it replies with the numeric chat ID, title, and type. Useful for manual pairing.

### Add a new bridge automatically

1. Send any message in the new Telegram group/channel — the bot records it in `config/discovered-chats.json`.
2. Run:

```bash
npm run bridge:discover
./scripts/deploy.sh
```

`bridge:discover` reads the known-chats registry, queries MAX API for channel list, and appends only **new unpaired** combinations to `routes.json`. Existing routes are untouched.

### Add a new bridge manually by ID

```bash
npm run bridge:pair -- --tg-chat-id=-1001234567890 --max-chat-id=-70999000000000
./scripts/deploy.sh
```

### Regenerate all routes from scratch

```bash
./bridge.sh --force
./scripts/deploy.sh
```

> **Note:** while the main bot is running it consumes `getUpdates`, so `bridge:discover` falls back to the local registry. Use `bridge:pair` if you already know both chat IDs.

---

## npm scripts

| Script | Description |
|---|---|
| `npm start` | Start the bridge locally |
| `npm run bridge` | Generate `routes.json` from scratch (skips if file exists) |
| `npm run bridge:discover` | Add routes for new unpaired TG+MAX chats (non-destructive) |
| `npm run bridge:pair -- --tg-chat-id=X --max-chat-id=Y` | Manually add a single bridge pair by ID |

---

## Deployment

`scripts/deploy.sh` uploads files via SCP and restarts PM2 on the remote server:

```bash
./scripts/deploy.sh
```

Monitor logs:

```bash
source .env
sshpass -p "$REMOTE_PASSWORD" ssh "$REMOTE_USER@$REMOTE_HOST" "pm2 logs max-repost-bot --lines 50"
```

---

## Large video support (MTProto)

The public Telegram Bot API limits downloads to **20 MB**. To bridge larger videos:

1. Go to [https://my.telegram.org/apps](https://my.telegram.org/apps) and create an app.
2. Add `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` to `.env`.
3. Deploy — the bridge saves a session to `.mtproto_session` on first run (gitignored).

Without MTProto, videos over 20 MB arrive as a text post with:
> *Вложение из Telegram не скопировано: файл слишком большой для Bot API.*

---

## Security

- Messages are only reposted from sources **explicitly listed** in `routes.json`.
- Messages from unlisted chats are silently ignored.

---

## Project structure

```
├── src/
│   └── index.js              # Main bridge runtime
├── scripts/
│   ├── bridge-init.js        # Discovery, config generator, manual pair tool
│   └── deploy.sh             # SSH deploy script
├── config/
│   ├── routes.json           # Routing config (gitignored)
│   └── discovered-chats.json # Registry of seen TG chats (gitignored)
├── ecosystem.config.js       # PM2 config
├── bridge.sh                 # Runs bridge-init.js
└── .env                      # Secrets (gitignored)
```

---

## License

MIT
