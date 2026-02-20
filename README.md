# Telegram/MAX bridge

Бот маршрутизирует сообщения между сетями по явным правилам из `config/routes.json`.

## 1) Переменные `.env`

Заполните:

- `TELEGRAM_BOT_TOKEN`
- `MAX_BOT_TOKEN`
- `TELEGRAM_API_BASE_URL` (`https://api.telegram.org` или ваш self-hosted Bot API)
- `ROUTING_CONFIG_PATH` (обычно `config/routes.json`)
- `DEFAULT_*` (глобальные дефолты, если не заданы в маршруте)

`REMOTE_*` используются `scripts/deploy.sh`.

## 2) Маршруты

Файл маршрутов: `config/routes.json`.

Пример структуры:

```json
{
  "routes": [
    {
      "id": "debug_tg_to_max",
      "enabled": true,
      "source": {
        "network": "telegram",
        "chat_id": -4720219405
      },
      "destinations": [
        {
          "network": "max",
          "chat_id": -71276213876121
        }
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

Поддерживаемые источники:

- `telegram`: `chat_id` и/или `chat_username`
- `max`: `chat_id`

Поддерживаемые назначения:

- `max`: ровно одно из `chat_id` или `user_id`
- `telegram`: `chat_id`

## 3) Что уже добавлено

В `config/routes.json` добавлены 2 маршрута:

- `debug_tg_to_max` (включен): Telegram debug -> MAX `Test Channel`
- `prod_tg_to_max` (выключен): Telegram source (placeholder) -> MAX `Shuvaev`

Для прод-маршрута укажите реальный `source` и включите `"enabled": true`.

## 4) Запуск и деплой

```bash
npm install
npm start
```

```bash
./scripts/deploy.sh
```

Логи:

```bash
pm2 logs max-repost-bot --lines 100
```

## 5) Важно про медиа

- Telegram альбомы (`media_group`) отправляются в MAX одним сообщением с несколькими вложениями.
- При использовании публичного Bot API большие файлы могут не скачиваться (`file is too big`).
- Для больших видео/аудио используйте self-hosted `telegram-bot-api` и задайте `TELEGRAM_API_BASE_URL`.

## 6) Безопасность

- Бот не принимает сообщения из произвольных чатов.
- Репост происходит только если источник совпал с явным `source` в `config/routes.json`.
- Если кто-то добавит вашего бота в сторонний канал, сообщения из него будут игнорироваться.
