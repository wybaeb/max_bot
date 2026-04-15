# Telegram / API → MAX Bridge Bot

Русский | **[English](README.md)**

Лёгкий Node.js-мост, который автоматически репостит сообщения из **Telegram**-каналов/групп и **внешних API-источников** в каналы **MAX** (max.ru) и **Telegram** — с поддержкой форматирования текста, изображений, видео, аудио и файловых вложений.

---

## Возможности

- **Текст** — markdown-сущности Telegram (жирный, курсив, ссылки, код, …) конвертируются в markdown MAX
- **Изображения** — пересылаются через upload API MAX
- **Видео / Аудио / Файлы** — скачиваются из Telegram и загружаются в MAX
- **Большие видео (> 20 МБ)** — скачиваются через MTProto (требует `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`)
- **Медиагруппы** — альбом из Telegram приходит одним сообщением MAX с несколькими вложениями
- **Футер источника** — опциональная подпись «tg: [Канал](ссылка)» под каждым репостом
- **Имя отправителя** — опциональная подпись жирным с именем автора сообщения (для мостов группа→группа)
- **Несколько маршрутов** — один источник → несколько назначений, или много независимых пар
- **API-приём** — приём сообщений от внешних систем через авторизованный HTTP-эндпоинт (`POST /api/message`)
- **Очередь с задержкой** — настраиваемая задержка репоста для обхода rate-limit
- **Группы и супергруппы** — работает с каналами, группами и супергруппами Telegram в качестве источника

---

## Требования

| Компонент | Примечания |
|---|---|
| Node.js ≥ 18.18 | |
| **Telegram-бот** | [@BotFather](https://t.me/BotFather) — добавить **администратором** в каждый исходный канал/группу |
| **MAX-бот** | [Портал разработчика MAX](https://dev.max.ru) — добавить **администратором** в каждый целевой канал |
| Linux-сервер | Для production (деплой через SSH + PM2) |
| `sshpass` на локальной машине | Только при деплое с паролем — `brew install sshpass` / `apt install sshpass` |

---

## Быстрый старт

### 1. Клонировать и установить зависимости

```bash
git clone https://github.com/your-org/max_bot.git
cd max_bot
npm install
```

### 2. Настроить окружение

```bash
cp .env.example .env
```

### 3. Добавить ботов в чаты

- **Telegram-бот** → добавить **администратором** в каждый исходный канал/группу.
- **MAX-бот** → добавить **администратором** в каждый целевой канал.

### 4. Задеплоить

```bash
./scripts/deploy.sh
```

Если `config/routes.json` ещё не существует — скрипт автоматически запустит `./bridge.sh` для обнаружения каналов и генерации маршрутов.

---

## Переменные окружения

Создай файл `.env` в корне проекта. **Никогда не коммить его** (уже в `.gitignore`).

```dotenv
# ── Обязательные ─────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=1234567890:AAXXXXXX
MAX_BOT_TOKEN=your_max_token_here

# ── Деплой (обязательно для deploy.sh) ───────────────────────────────────────
REMOTE_HOST=1.2.3.4
REMOTE_USER=root
REMOTE_PASSWORD=secret          # оставь пустым для авторизации по SSH-ключу

# ── Опционально – MTProto (для видео > 20 МБ) ────────────────────────────────
# Как получить: https://my.telegram.org/apps → создать приложение
TELEGRAM_API_ID=
TELEGRAM_API_HASH=

# ── Опционально – API-приём ──────────────────────────────────────────────────
# API_PORT=3000                          # порт HTTP-сервера (стартует автоматически)
# API_KEY_MY_ROUTE=<случайный-секрет>    # Bearer-токен для маршрута с api_key_env="API_KEY_MY_ROUTE"

# ── Опционально – дополнительные настройки ───────────────────────────────────
# TELEGRAM_API_BASE_URL=https://api.telegram.org
# ROUTING_CONFIG_PATH=config/routes.json
# DEFAULT_REPOST_DELAY_MS=3000
# DEFAULT_MEDIA_GROUP_COLLECT_MS=1200
# DEFAULT_INCLUDE_TELEGRAM_FOOTER=true

# ── Опционально – защита от переполнения диска ────────────────────────────────
# TEMP_MIN_FREE_MB=1000
```

---

## Конфигурация маршрутов

Маршруты хранятся в `config/routes.json` (в `.gitignore` — генерируется под каждый деплой).

```jsonc
{
  "routes": [
    {
      "id": "my_route",
      "enabled": true,
      "source": {
        "network": "telegram",
        "chat_id": -1001234567890,
        "chat_username": "mychannel"     // опционально, резервный идентификатор
      },
      "destinations": [
        { "network": "max", "chat_id": -70999000000000 }
      ],
      "options": {
        "repost_delay_ms": 3000,
        "media_group_collect_ms": 1200,
        "include_telegram_footer": true,
        "include_sender_name": true
      }
    }
  ]
}
```

### Опции маршрута

| Опция | Тип | По умолчанию | Описание |
|---|---|---|---|
| `repost_delay_ms` | number | `3000` | Задержка перед репостом (защита от rate-limit) |
| `media_group_collect_ms` | number | `1200` | Время ожидания всех частей медиагруппы |
| `include_telegram_footer` | boolean | `true` | Добавлять подпись «tg: [Канал](ссылка)» |
| `include_sender_name` | boolean | `false` | Подписывать сообщение **именем отправителя** (жирным) — полезно для мостов группа→группа, чтобы видеть, кто написал |

Поддерживаемые сети-источники: `telegram`, `max`, `api`.  
Поддерживаемые сети-назначения: `max`, `telegram`.

### Источник API

Для приёма сообщений от внешних систем (CI/CD, мониторинг, формы,
вебхуки, другие боты) используй `"network": "api"`. Два способа хранить
Bearer-токен:

**Inline** — прямо в `routes.json` (самодостаточный вариант без
env-переменных; CLI сам генерит стойкий ключ):

```jsonc
{
  "id": "form_leads_to_tg",
  "enabled": true,
  "source": {
    "network": "api",
    "api_key": "Rv-XnHTYA46euHdNuAs-KbzMAWZfBf60HoSRF7_1QBI"  // >= 16 символов
  },
  "destinations": [
    { "network": "telegram", "chat_id": -5075596986 }
  ]
}
```

**Ссылка на env** — ключ лежит в `.env`, `routes.json` хранит только имя.
Удобно, если хочется держать секреты отдельно:

```jsonc
{
  "id": "alerts_to_max",
  "enabled": true,
  "source": {
    "network": "api",
    "api_key_env": "API_KEY_ALERTS"   // имя env-переменной с Bearer-токеном
  },
  "destinations": [
    { "network": "max", "chat_id": -70999000000000 },
    { "network": "telegram", "chat_id": -1001234567890 }
  ],
  "options": { "repost_delay_ms": 0 }
}
```

HTTP-сервер стартует автоматически при наличии хотя бы одного
API-маршрута (или если задан `ADMIN_PASSWORD`). Отправка сообщения:

```bash
curl -X POST http://your-server:3000/api/message \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY_ALERTS" \
  -d '{"text": "**Алерт:** деплой завершён"}'
```

Текст поддерживает markdown: `**жирный**`, `_курсив_`, `` `код` ``, `~~зачёркнутый~~`, `[ссылка](url)` и блоки кода.

---

## CLI моста (`max-bot-bridge`)

Встроенный CLI-инструмент для **живого** управления маршрутами без правки
`routes.json` вручную и без редеплоя. Работает с любым инстансом бота,
у которого в `.env` задан `ADMIN_PASSWORD`.

### Включить admin-API

На **сервере бота** добавить в `.env`:

```dotenv
ADMIN_PASSWORD=<длинный-случайный-секрет>   # пусто = admin-API полностью выключен
# API_PORT=3000                              # по умолчанию; смени, если 3000 занят
```

Перезапустить бота. Когда admin-API включён, `/admin/*` висит на том же
HTTP-порту, что и API-ingest (`API_PORT`, по умолчанию `3000`).

> ⚠️  **Безопасность.** Admin-API ходит по **plain HTTP**. Перед тем как
> торчать им в публичный интернет, либо поставь TLS-прокси (Caddy, Nginx),
> либо тунелируй через SSH:
> ```bash
> ssh -L 3000:localhost:3000 root@your-bot
> max-bot-bridge login localhost
> ```

### Как пользоваться

```bash
# На твоей машине, где склонирован репозиторий и запущен npm install:
npx max-bot-bridge                       # интерактивный TUI (рекомендуется)
npx max-bot-bridge --help                # полное описание команд
npx max-bot-bridge login your-server-ip # пароль спросит интерактивно
npx max-bot-bridge list                  # все маршруты
npx max-bot-bridge show my_route
npx max-bot-bridge show my_route --reveal  # показать inline api_key в явном виде
npx max-bot-bridge disable my_route
npx max-bot-bridge enable  my_route
npx max-bot-bridge add                   # интерактивный визард (любой тип источника)
npx max-bot-bridge add-api form_leads --telegram -5075596986
                                         # в одно действие: сгенерить ключ + напечатать curl
npx max-bot-bridge edit    my_route
npx max-bot-bridge remove  my_route      # спрашивает подтверждение; --force пропускает
```

### Создание API-маршрута одной командой

Для быстрых интеграций (формы, вебхуки, CI-алерты, сторонние боты)
команда `add-api` делает всё за один вызов — без правки `routes.json`,
без изменений в `.env`, без редеплоя:

```bash
max-bot-bridge add-api form_leads --telegram -5075596986
```

В выводе: сгенерированный 32-байтовый Bearer-ключ (показывается **один
раз** — сохрани), маскированное summary и готовый `curl` на твой сервер.
Поддерживаются несколько назначений и ключи из env-переменных:

```bash
# Fan-out сразу в MAX + Telegram, ключ автоген
max-bot-bridge add-api alerts \
  --max -70999607981465 \
  --telegram -1001234567890

# Использовать ключ из .env сервера вместо inline
max-bot-bridge add-api ci-bot --env-var API_KEY_CI --telegram -1001234567890
```

Inline-ключи по умолчанию маскируются в выводе `list`/`show`
(`abcd***wxyz`). Раскрыть обратно: `max-bot-bridge show <id> --reveal`.

Запуск `max-bot-bridge` **без аргументов** — интерактивное меню со стрелками:

```
╭────────────────────────────────────────╮
│      max-bot-bridge — bridge CLI       │
╰────────────────────────────────────────╯

server: http://your-server-ip:3000
routes: 9 enabled / 9 total

? Main menu
❯ 📋  List all routes
  🔧  Manage a route (edit / enable / disable / delete)
  ➕  Add a new route
  👤  Who am I / session info
  🚪  Logout
  ❌  Quit
```

### Хранение сессии

После успешного `login` долгоживущий Bearer-токен (~1 год) сохраняется в
`~/.config/max-bot-bridge/session.json` (права `0600`). **Пароль на диск
не пишется.** `logout` отзывает токен на сервере и стирает локальный файл.

### Скрипты и LLM-дружественный режим

```bash
MAX_BOT_BRIDGE_PASSWORD=$PW max-bot-bridge login 10.0.0.5 \
  --password "$MAX_BOT_BRIDGE_PASSWORD"

max-bot-bridge list --json | jq '.[] | {id, enabled}'
max-bot-bridge show my_route --json
```

Exit-коды: `0` — успех, `1` — generic, `2` — ошибка авторизации, `3` — не найдено.

### HTTP-эндпоинты (для curl / своих скриптов)

Все эндпоинты ждут JSON в теле. После `POST /admin/login` возвращается
токен — его нужно подставлять в `Authorization: Bearer <token>` на всех
последующих запросах.

| Метод  | Путь                              | Тело                 | Примечания                              |
|--------|-----------------------------------|----------------------|-----------------------------------------|
| POST   | `/admin/login`                    | `{password}`         | лимит: 5 попыток/мин/IP                 |
| POST   | `/admin/logout`                   | –                    | отзывает текущий токен                  |
| GET    | `/admin/info`                     | –                    | счётчики маршрутов + срок сессии        |
| GET    | `/admin/routes`                   | –                    | все маршруты                            |
| GET    | `/admin/routes/:id`               | –                    | один маршрут                            |
| POST   | `/admin/routes`                   | полный объект route  | создать; валидация до записи            |
| PUT    | `/admin/routes/:id`               | частичный route      | merge-update, атомарная запись+reload   |
| DELETE | `/admin/routes/:id`               | –                    | удалить                                 |
| POST   | `/admin/routes/:id/enable`        | –                    | включить                                |
| POST   | `/admin/routes/:id/disable`       | –                    | выключить                               |
| GET    | `/admin/settings`                 | –                    | retention + режим бэкапов               |
| PUT    | `/admin/settings`                 | частичные настройки  | валидация + сохранение в settings.json  |
| GET    | `/admin/backups`                  | –                    | список снапшотов (новые сверху)         |
| POST   | `/admin/backups`                  | `{reason}`           | ручной снапшот                          |
| POST   | `/admin/backups/:name/restore`    | –                    | атомарное восстановление из снапшота    |
| DELETE | `/admin/backups/:name`            | –                    | удалить один снапшот                    |

Каждая мутация атомарно перезаписывает `routes.json` и **горячо** применяется
ботом (без рестарта процесса). Если новый конфиг не проходит валидацию —
файл восстанавливается из резервной копии, API возвращает `400` с ошибкой.

### Бэкапы и настройки

Перед каждой мутацией `routes.json` автоматически снимается таймстемп-снапшот
рядом с живым файлом:

```
config/
  routes.json
  settings.json            # рантайм-настройки (retention / режим)
  backups/
    routes-20260411-143022-add_my_route.json
    routes-20260411-143108-disable_debug_tg_to_max.json
    …
```

По умолчанию бот хранит **20 последних** снапшотов и создаёт новый
**перед каждым** изменением (add / edit / enable / disable / remove /
restore). Старые удаляются после создания нового.

Retention и режим задаются двумя настройками:

| Настройка       | По умолчанию | Диапазон / значения | Смысл                                               |
|-----------------|--------------|----------------------|------------------------------------------------------|
| `backups.keep`  | `20`         | integer `1..1000`    | сколько снапшотов хранить                            |
| `backups.mode`  | `auto`       | `auto` \| `manual`   | `auto` снимает перед каждым изменением, `manual` — только вручную через `backup create` |

Менять их в рантайме — через CLI (запись в `config/settings.json`):

```bash
max-bot-bridge settings show
max-bot-bridge settings set backups.keep 50
max-bot-bridge settings set backups.mode manual
```

Либо зафиксировать через `.env` (env-переменные **побеждают** значения
из `settings.json` при каждом чтении):

```dotenv
BACKUPS_KEEP=20
BACKUPS_MODE=auto
```

Управлять снапшотами напрямую:

```bash
max-bot-bridge backup list                           # новые сверху
max-bot-bridge backup create --reason "pre-refactor" # ручной снапшот
max-bot-bridge backup restore routes-20260411-143022-add_my_route.json
max-bot-bridge backup delete  routes-20260411-143022-add_my_route.json --force
```

Восстановление из снапшота проходит ту же валидацию, что и любая другая
мутация — если восстанавливаемый файл не проходит проверку, текущее
состояние остаётся нетронутым, а CLI возвращает ненулевой exit-код.

---

## Управление мостами

### Команда `/chatid`

Отправь `/chatid` в любой Telegram-чат или MAX-канал где присутствует бот — он ответит числовым ID, названием и типом чата. Удобно для ручного создания пар.

### Добавить новый мост автоматически

1. Добавь бота в новую Telegram-группу/канал и новый MAX-канал как администратора.
2. Отправь любое сообщение в новый Telegram-чат — бот запишет его в `config/discovered-chats.json`.
3. Запусти:

```bash
npm run bridge:discover
./scripts/deploy.sh
```

`bridge:discover` читает реестр известных чатов, запрашивает список MAX-каналов через API и добавляет в `routes.json` только **новые** (ещё не спаренные) комбинации. Существующие маршруты не затрагиваются.

### Добавить новый мост вручную по ID

Если ID чатов уже известны (получи их через `/chatid`):

```bash
npm run bridge:pair -- --tg-chat-id=-1001234567890 --max-chat-id=-70999000000000
./scripts/deploy.sh
```

### Пересоздать все маршруты с нуля

```bash
./bridge.sh --force
./scripts/deploy.sh
```

> **Важно:** пока основной бот запущен, он потребляет `getUpdates` — `bridge:discover` в этом случае использует локальный реестр. Если нужно добавить мост немедленно, используй `bridge:pair` с явными ID.

---

## npm-скрипты

| Скрипт | Описание |
|---|---|
| `npm start` | Запустить мост локально |
| `npm run bridge` | Сгенерировать `routes.json` с нуля (пропускает если файл есть) |
| `npm run bridge:discover` | Добавить маршруты для новых незапаренных TG+MAX чатов (неразрушающий) |
| `npm run bridge:pair -- --tg-chat-id=X --max-chat-id=Y` | Вручную добавить одну пару по ID |

---

## Деплой

`scripts/deploy.sh` загружает файлы по SCP и перезапускает PM2 на удалённом сервере:

```bash
./scripts/deploy.sh
```

Просмотр логов после деплоя:

```bash
source .env
sshpass -p "$REMOTE_PASSWORD" ssh "$REMOTE_USER@$REMOTE_HOST" "pm2 logs max-repost-bot --lines 50"
```

---

## Поддержка больших видео (MTProto)

Публичный Bot API Telegram ограничивает скачивание файлов **20 МБ**. Для пересылки больших видео:

1. Зайди на [https://my.telegram.org/apps](https://my.telegram.org/apps) и создай приложение.
2. Добавь `TELEGRAM_API_ID` и `TELEGRAM_API_HASH` в `.env`.
3. Задеплой — при первом запуске мост аутентифицируется через MTProto и сохраняет сессию в `.mtproto_session` (в `.gitignore`). При следующих запусках сессия переиспользуется автоматически.

Без MTProto-учётных данных всё работает в штатном режиме — видео > 20 МБ придут как текстовый пост с пометкой:
> *Вложение из Telegram не скопировано: файл слишком большой для Bot API.*

---

## Защита от переполнения диска

При пересылке медиафайлов бот временно скачивает их на диск сервера, а затем загружает в MAX. Чтобы большой поток видео не «забил» диск, в боте есть несколько уровней защиты:

- **Проверка свободного места.** Перед каждым скачиванием бот проверяет, сколько места осталось на диске. Если свободного места меньше порога — файл не скачивается, а в лог пишется ошибка. Порог задаётся параметром `TEMP_MIN_FREE_MB` (по умолчанию 1000 МБ).
- **Автоматическая уборка.** При запуске и каждые 15 минут бот удаляет временные файлы старше 30 минут, которые могли остаться после предыдущего аварийного выключения.
- **Корректное завершение.** При остановке сервиса все незавершённые временные файлы удаляются автоматически.

Настройка порога в `.env`:

```dotenv
TEMP_MIN_FREE_MB=1000   # минимум свободного места в МБ (по умолчанию 1000)
```

---

## Безопасность

- Репостятся только сообщения из источников, **явно прописанных** в `routes.json`.
- Сообщения из незарегистрированных чатов молча игнорируются.

---

## Структура проекта

```
├── src/
│   └── index.js              # Основной runtime моста (polling + очередь + пересылка)
├── scripts/
│   ├── bridge-init.js        # Обнаружение каналов, генератор конфига, инструмент ручного спаривания
│   └── deploy.sh             # Скрипт SSH-деплоя
├── config/
│   ├── routes.json           # Конфиг маршрутов (gitignored)
│   └── discovered-chats.json # Реестр обнаруженных TG-чатов (gitignored)
├── ecosystem.config.js       # Конфиг PM2
├── bridge.sh                 # Точка входа: запускает bridge-init.js
└── .env                      # Секреты (gitignored)
```

---

## Лицензия

MIT
