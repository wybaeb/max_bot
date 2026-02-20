# Telegram -> MAX repost bot

Бот слушает входящие сообщения в Telegram и отправляет их в MAX с задержкой.

## 1) Настройка `.env`

Скопируйте `.env.example` в `.env` и заполните:

- `TELEGRAM_BOT_TOKEN` - токен Telegram-бота
- `MAX_BOT_TOKEN` - токен MAX-бота
- `MAX_TARGET_CHAT_ID` или `MAX_TARGET_USER_ID` - куда отправлять в MAX
- `TELEGRAM_SOURCE_CHAT_IDS` - список Telegram chat id через запятую (опционально)
- `REPOST_DELAY_MS` - задержка перед репостом, по умолчанию `3000`
- `TELEGRAM_API_BASE_URL` - base URL Telegram Bot API (`https://api.telegram.org` по умолчанию)
- `MEDIA_GROUP_COLLECT_MS` - окно сборки Telegram-альбома перед отправкой, по умолчанию `1200`
- `INCLUDE_TELEGRAM_FOOTER` - добавлять/скрывать футер `tg: [channel](url)`, по умолчанию `true`

`REMOTE_*` переменные используются скриптом деплоя.

## 2) Локальный запуск

```bash
npm install
npm start
```

## 3) Деплой на сервер

Скрипт деплоя копирует файлы на сервер в `/opt/max_bot`, устанавливает зависимости и запускает процесс через `pm2`.

```bash
./scripts/deploy.sh
```

Просмотр логов на сервере:

```bash
pm2 logs max-repost-bot --lines 100
```

## Важно

- Telegram-бот должен быть добавлен в нужный чат/канал и иметь доступ к сообщениям.
- MAX-бот должен быть участником целевого чата (если используете `MAX_TARGET_CHAT_ID`).
- Поддерживаются основные типы вложений: фото, видео, анимация, аудио/voice и файлы.
- Telegram альбомы (`media_group`) отправляются в MAX одним сообщением с несколькими вложениями.
- При использовании публичного Telegram Bot API загрузка некоторых файлов может быть ограничена (ошибка `file is too big`).
- Если `MAX_TARGET_*` не задан, бот попробует выбрать цель автоматически, но только если у него в MAX ровно один доступный чат.
