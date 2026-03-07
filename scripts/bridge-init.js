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

const parseArgValue = (flag) => {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  return arg ? arg.slice(flag.length + 1) : null;
};

const config = {
  telegramToken: requireEnv('TELEGRAM_BOT_TOKEN'),
  maxToken: requireEnv('MAX_BOT_TOKEN'),
  routingConfigPath: process.env.ROUTING_CONFIG_PATH
    ? path.resolve(process.cwd(), process.env.ROUTING_CONFIG_PATH)
    : path.resolve(process.cwd(), 'config/routes.json'),
  discoveredChatsPath: path.resolve(process.cwd(), 'config/discovered-chats.json'),
  defaultRepostDelayMs: parseIntEnv('DEFAULT_REPOST_DELAY_MS', 3000),
  defaultMediaGroupCollectMs: parseIntEnv('DEFAULT_MEDIA_GROUP_COLLECT_MS', 1200),
  defaultIncludeTelegramFooter: parseBooleanEnv('DEFAULT_INCLUDE_TELEGRAM_FOOTER', true),
  forceRewrite: process.argv.includes('--force'),
  mergeMode: process.argv.includes('--merge'),
  addPairMode: process.argv.includes('--add-pair'),
  manualTgChatId: parseArgValue('--tg-chat-id') ? Number(parseArgValue('--tg-chat-id')) : null,
  manualMaxChatId: parseArgValue('--max-chat-id') ? Number(parseArgValue('--max-chat-id')) : null,
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

const loadDiscoveredChats = () => {
  if (!fs.existsSync(config.discoveredChatsPath)) return [];
  try {
    const raw = fs.readFileSync(config.discoveredChatsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Object.values(parsed.chats || {});
  } catch {
    return [];
  }
};

const SUPPORTED_TYPES = new Set(['channel', 'group', 'supergroup']);

const discoverTelegramSources = async (telegram) => {
  const me = await telegram.getMe();

  // In merge mode try the persistent registry first (avoids conflict with
  // the running main bot that already consumed getUpdates).
  const registryChats = config.mergeMode ? loadDiscoveredChats() : [];

  const uniqueChats = new Map();

  if (registryChats.length) {
    log('Using discovered-chats registry', { count: registryChats.length });
    for (const chat of registryChats) {
      if (SUPPORTED_TYPES.has(chat.type)) {
        uniqueChats.set(String(chat.id), chat);
      }
    }
  } else {
    log('Registry empty or not found, falling back to getUpdates');
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

    for (const update of updates) {
      const chat = chatFromUpdate(update);
      if (!chat) continue;
      if (!SUPPORTED_TYPES.has(chat.type)) continue;
      uniqueChats.set(String(chat.id), chat);
    }
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

const buildRoute = (tg, max) => ({
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

const createRoutes = (tgSources, maxDestinations) => {
  const routes = [];
  for (const tg of tgSources) {
    for (const max of maxDestinations) {
      routes.push(buildRoute(tg, max));
    }
  }
  return routes;
};

const pairedKey = (tgChatId, maxChatId) => `${tgChatId}::${maxChatId}`;

const loadExistingRoutes = () => {
  if (!fs.existsSync(config.routingConfigPath)) return [];
  try {
    const raw = fs.readFileSync(config.routingConfigPath, 'utf8');
    return JSON.parse(raw).routes || [];
  } catch {
    return [];
  }
};

const existingPairs = (routes) => {
  const pairs = new Set();
  for (const route of routes) {
    const tgId = route.source?.chat_id;
    for (const dest of route.destinations || []) {
      if (dest.network === 'max') {
        pairs.add(pairedKey(tgId, dest.chat_id));
      }
    }
  }
  return pairs;
};

const mergeRoutes = (tgSources, maxDestinations) => {
  const existing = loadExistingRoutes();
  const paired = existingPairs(existing);
  const newRoutes = [];

  for (const tg of tgSources) {
    for (const max of maxDestinations) {
      const key = pairedKey(tg.chat_id, max.chat_id);
      if (!paired.has(key)) {
        newRoutes.push(buildRoute(tg, max));
        log('New bridge pair found', { tg_title: tg.title, tg_id: tg.chat_id, max_title: max.title, max_id: max.chat_id });
      } else {
        log('Already paired, skip', { tg_id: tg.chat_id, max_id: max.chat_id });
      }
    }
  }

  return { existing, newRoutes };
};

const main = async () => {
  // --add-pair mode: directly add a single (tg, max) pair by explicit IDs
  if (config.addPairMode) {
    if (!config.manualTgChatId || !config.manualMaxChatId) {
      throw new Error('--add-pair requires both --tg-chat-id=<id> and --max-chat-id=<id>');
    }
    const tg = { chat_id: config.manualTgChatId, title: null };
    const max = { chat_id: config.manualMaxChatId, title: null };
    const { existing, newRoutes } = mergeRoutes([tg], [max]);
    if (!newRoutes.length) {
      log('Pair already exists in routes.json, nothing added');
      return;
    }
    const output = { routes: [...existing, ...newRoutes] };
    ensureDirForFile(config.routingConfigPath);
    fs.writeFileSync(config.routingConfigPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    log('Pair added', { tg_chat_id: config.manualTgChatId, max_chat_id: config.manualMaxChatId, total: output.routes.length });
    return;
  }

  if (config.mergeMode) {
    log('Running in merge mode — discovering unpaired channels');
  } else if (fs.existsSync(config.routingConfigPath) && !config.forceRewrite) {
    log('Routing config already exists, skip generation', {
      path: config.routingConfigPath,
      hint: 'Use --merge to add new unpaired channels, or --force to regenerate from scratch',
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

  if (config.mergeMode) {
    const { existing, newRoutes } = mergeRoutes(tgSources, maxDestinations);

    if (!newRoutes.length) {
      log('No new unpaired channels found — routes.json is up to date');
      return;
    }

    const output = { routes: [...existing, ...newRoutes] };
    ensureDirForFile(config.routingConfigPath);
    fs.writeFileSync(config.routingConfigPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

    log('New routes appended', {
      path: config.routingConfigPath,
      added: newRoutes.length,
      total: output.routes.length,
    });
    return;
  }

  const routes = createRoutes(tgSources, maxDestinations);
  if (!routes.length) {
    throw new Error('No routes were generated (empty TG or MAX set).');
  }

  const output = { routes };

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
