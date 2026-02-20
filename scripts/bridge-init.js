'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const TelegramBot = require('node-telegram-bot-api');
const { Bot: MaxBot } = require('@maxhub/max-bot-api');

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const normalizeUsername = (value) => String(value || '').replace(/^@/, '').trim().toLowerCase();

const parseIntEnv = (name, fallback) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be integer`);
  return parsed;
};

const parseBooleanEnv = (name, fallback) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be boolean-like`);
};

const log = (msg, extra = {}) => {
  const payload = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[bridge-init] ${msg}${payload}`);
};

const ensureDirForFile = (filePath) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const config = {
  telegramToken: requireEnv('TELEGRAM_BOT_TOKEN'),
  maxToken: requireEnv('MAX_BOT_TOKEN'),
  routingConfigPath: process.env.ROUTING_CONFIG_PATH
    ? path.resolve(process.cwd(), process.env.ROUTING_CONFIG_PATH)
    : path.resolve(process.cwd(), 'config/routes.json'),
  defaultRepostDelayMs: parseIntEnv('DEFAULT_REPOST_DELAY_MS', 3000),
  defaultMediaGroupCollectMs: parseIntEnv('DEFAULT_MEDIA_GROUP_COLLECT_MS', 1200),
  defaultIncludeTelegramFooter: parseBooleanEnv('DEFAULT_INCLUDE_TELEGRAM_FOOTER', true),
  forceRewrite: process.argv.includes('--force'),
};

const chatFromUpdate = (update) => {
  return update.channel_post?.chat
    || update.edited_channel_post?.chat
    || update.message?.chat
    || update.edited_message?.chat
    || update.my_chat_member?.chat
    || update.chat_member?.chat
    || null;
};

const isTelegramAdminStatus = (status) => status === 'administrator' || status === 'creator';

const discoverTelegramSources = async (telegram) => {
  const me = await telegram.getMe();
  const updates = await telegram.getUpdates({
    limit: 100,
    timeout: 0,
    allowed_updates: [
      'message',
      'edited_message',
      'channel_post',
      'edited_channel_post',
      'my_chat_member',
      'chat_member',
    ],
  });

  const uniqueChats = new Map();
  for (const update of updates) {
    const chat = chatFromUpdate(update);
    if (!chat) continue;
    if (chat.type !== 'channel') continue;
    uniqueChats.set(String(chat.id), chat);
  }

  const sources = [];
  for (const chat of uniqueChats.values()) {
    try {
      const member = await telegram.getChatMember(chat.id, me.id);
      if (!isTelegramAdminStatus(member.status)) continue;

      sources.push({
        chat_id: chat.id,
        chat_username: chat.username ? normalizeUsername(chat.username) : undefined,
        title: chat.title || null,
      });
    } catch (err) {
      log('Skip telegram chat during admin check', {
        chat_id: chat.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return sources;
};

const discoverMaxDestinations = async (maxBot) => {
  const { chats } = await maxBot.api.getAllChats({ count: 100 });
  const destinations = [];

  for (const chat of chats || []) {
    if (chat.type !== 'channel' || chat.status !== 'active') continue;

    try {
      const membership = await maxBot.api.getChatMembership(chat.chat_id);
      const canPost = Boolean(membership.is_owner || membership.is_admin);
      if (!canPost) continue;

      destinations.push({
        chat_id: chat.chat_id,
        title: chat.title || null,
        link: chat.link || null,
      });
    } catch (err) {
      log('Skip MAX chat during membership check', {
        chat_id: chat.chat_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return destinations;
};

const createRoutes = (tgSources, maxDestinations) => {
  const routes = [];

  for (const tg of tgSources) {
    for (const max of maxDestinations) {
      routes.push({
        id: `auto_tg_${Math.abs(tg.chat_id)}_to_max_${Math.abs(max.chat_id)}`,
        enabled: true,
        source: {
          network: 'telegram',
          chat_id: tg.chat_id,
          ...(tg.chat_username ? { chat_username: tg.chat_username } : {}),
        },
        destinations: [
          {
            network: 'max',
            chat_id: max.chat_id,
          },
        ],
        options: {
          repost_delay_ms: config.defaultRepostDelayMs,
          media_group_collect_ms: config.defaultMediaGroupCollectMs,
          include_telegram_footer: config.defaultIncludeTelegramFooter,
        },
      });
    }
  }

  return routes;
};

const main = async () => {
  if (fs.existsSync(config.routingConfigPath) && !config.forceRewrite) {
    log('Routing config already exists, skip generation', {
      path: config.routingConfigPath,
    });
    return;
  }

  const telegram = new TelegramBot(config.telegramToken, { polling: false });
  const maxBot = new MaxBot(config.maxToken);

  const tgSources = await discoverTelegramSources(telegram);
  if (!tgSources.length) {
    throw new Error(
      'No Telegram source channels found where bot is admin. Add bot as admin in source channel(s), publish at least one post in each, then run bridge.sh again.',
    );
  }

  const maxDestinations = await discoverMaxDestinations(maxBot);
  if (!maxDestinations.length) {
    throw new Error(
      'No MAX destination channels found where bot has admin rights. Add bot as admin in destination channel(s), then run bridge.sh again.',
    );
  }

  const routes = createRoutes(tgSources, maxDestinations);
  if (!routes.length) {
    throw new Error('No routes were generated (empty TG or MAX set).');
  }

  const output = {
    routes,
  };

  ensureDirForFile(config.routingConfigPath);
  fs.writeFileSync(config.routingConfigPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  log('Routing config generated', {
    path: config.routingConfigPath,
    tg_sources: tgSources.length,
    max_destinations: maxDestinations.length,
    routes: routes.length,
  });

  log('Telegram sources', { sources: tgSources });
  log('MAX destinations', { destinations: maxDestinations });
};

main().catch((err) => {
  console.error(`[bridge-init] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
