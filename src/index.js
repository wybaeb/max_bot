'use strict';

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const { Bot: MaxBot } = require('@maxhub/max-bot-api');

const parseIntEnv = (name, fallback) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer`);
  }
  return parsed;
};

const parseIdList = (value) => {
  if (!value || !value.trim()) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parsed = Number.parseInt(item, 10);
      if (Number.isNaN(parsed)) {
        throw new Error(`Invalid chat id in TELEGRAM_SOURCE_CHAT_IDS: "${item}"`);
      }
      return parsed;
    });
};

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const config = {
  telegramToken: requireEnv('TELEGRAM_BOT_TOKEN'),
  maxToken: requireEnv('MAX_BOT_TOKEN'),
  maxTargetChatId: process.env.MAX_TARGET_CHAT_ID
    ? parseIntEnv('MAX_TARGET_CHAT_ID')
    : undefined,
  maxTargetUserId: process.env.MAX_TARGET_USER_ID
    ? parseIntEnv('MAX_TARGET_USER_ID')
    : undefined,
  repostDelayMs: parseIntEnv('REPOST_DELAY_MS', 3000),
  sourceChatIds: parseIdList(process.env.TELEGRAM_SOURCE_CHAT_IDS || ''),
};

if (config.maxTargetChatId && config.maxTargetUserId) {
  throw new Error('Set only one target: MAX_TARGET_CHAT_ID or MAX_TARGET_USER_ID');
}

if (config.repostDelayMs < 0) {
  throw new Error('REPOST_DELAY_MS must be >= 0');
}

const telegram = new TelegramBot(config.telegramToken, { polling: true });
const maxBot = new MaxBot(config.maxToken);

const queue = [];
let queueBusy = false;
const target = {
  chatId: config.maxTargetChatId,
  userId: config.maxTargetUserId,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (msg, extra = {}) => {
  const payload = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[${new Date().toISOString()}] ${msg}${payload}`);
};

const isAllowedSource = (chatId) => {
  if (!config.sourceChatIds.length) return true;
  return config.sourceChatIds.includes(chatId);
};

const getAuthor = (message) => {
  if (message.sender_chat && message.sender_chat.title) return message.sender_chat.title;
  if (message.from) {
    const fullName = [message.from.first_name, message.from.last_name].filter(Boolean).join(' ').trim();
    if (fullName) return fullName;
    if (message.from.username) return `@${message.from.username}`;
  }
  return 'unknown';
};

const getSource = (message) => {
  const chat = message.chat;
  if (chat.title) return chat.title;
  const fullName = [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim();
  return fullName || String(chat.id);
};

const getMessageText = (message) => {
  const base = message.text || message.caption || '';
  const header = `TG → MAX | ${getSource(message)} | ${getAuthor(message)}`;
  return base ? `${header}\n\n${base}` : header;
};

const tgFileUrl = async (fileId) => {
  const file = await telegram.getFile(fileId);
  if (!file.file_path) {
    throw new Error(`Telegram did not return file_path for file_id=${fileId}`);
  }
  return `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
};

const buildAttachments = async (message) => {
  const attachments = [];

  if (message.photo && message.photo.length) {
    const largest = message.photo[message.photo.length - 1];
    const imageUrl = await tgFileUrl(largest.file_id);
    attachments.push((await maxBot.api.uploadImage({ url: imageUrl })).toJson());
  } else if (message.video) {
    const videoUrl = await tgFileUrl(message.video.file_id);
    attachments.push((await maxBot.api.uploadVideo({ url: videoUrl })).toJson());
  } else if (message.animation) {
    const animationUrl = await tgFileUrl(message.animation.file_id);
    attachments.push((await maxBot.api.uploadVideo({ url: animationUrl })).toJson());
  } else if (message.audio) {
    const audioUrl = await tgFileUrl(message.audio.file_id);
    attachments.push((await maxBot.api.uploadAudio({ url: audioUrl })).toJson());
  } else if (message.voice) {
    const voiceUrl = await tgFileUrl(message.voice.file_id);
    attachments.push((await maxBot.api.uploadAudio({ url: voiceUrl })).toJson());
  } else if (message.document) {
    const documentUrl = await tgFileUrl(message.document.file_id);
    attachments.push((await maxBot.api.uploadFile({ url: documentUrl })).toJson());
  }

  return attachments;
};

const sendToMax = async (text, attachments) => {
  if (!target.chatId && !target.userId) {
    const { chats } = await maxBot.api.getAllChats({ count: 100 });
    if (chats.length === 1) {
      target.chatId = chats[0].chat_id;
      log('Auto-selected MAX target chat', {
        max_target_chat_id: target.chatId,
        title: chats[0].title,
      });
    } else {
      throw new Error(
        `MAX target is not configured. Set MAX_TARGET_CHAT_ID/MAX_TARGET_USER_ID. Visible chats: ${chats.length}`,
      );
    }
  }

  const payload = attachments.length ? { attachments } : undefined;
  if (target.chatId) {
    return maxBot.api.sendMessageToChat(target.chatId, text, payload);
  }
  return maxBot.api.sendMessageToUser(target.userId, text, payload);
};

const forwardToMax = async (message) => {
  const text = getMessageText(message);
  const attachments = await buildAttachments(message);
  await sendToMax(text, attachments);
  log('Reposted message', {
    telegram_chat_id: message.chat.id,
    telegram_message_id: message.message_id,
    attachments: attachments.length,
  });
};

const processQueue = async () => {
  if (queueBusy) return;
  queueBusy = true;

  try {
    while (queue.length) {
      const next = queue[0];
      const waitMs = Math.max(0, next.runAt - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      queue.shift();
      try {
        await forwardToMax(next.message);
      } catch (err) {
        log('Failed to repost message', {
          error: err instanceof Error ? err.message : String(err),
          telegram_chat_id: next.message.chat.id,
          telegram_message_id: next.message.message_id,
        });
      }
    }
  } finally {
    queueBusy = false;
  }
};

const enqueueMessage = (message) => {
  queue.push({
    message,
    runAt: Date.now() + config.repostDelayMs,
  });
  void processQueue();
};

const onTelegramMessage = (message) => {
  if (!isAllowedSource(message.chat.id)) return;
  enqueueMessage(message);
};

const bootstrap = async () => {
  const [tgMe, maxMe] = await Promise.all([
    telegram.getMe(),
    maxBot.api.getMyInfo(),
  ]);

  log('Bridge started', {
    telegram_bot: tgMe.username,
    max_bot_id: maxMe.user_id,
    repost_delay_ms: config.repostDelayMs,
    restricted_sources: config.sourceChatIds.length > 0,
    target_chat_id: target.chatId,
    target_user_id: target.userId,
  });
  if (!target.chatId && !target.userId) {
    log('MAX target is not configured; set MAX_TARGET_CHAT_ID/MAX_TARGET_USER_ID or keep one MAX chat for auto-pick');
  }

  telegram.on('message', onTelegramMessage);
  telegram.on('channel_post', onTelegramMessage);
  telegram.on('polling_error', (err) => {
    log('Telegram polling error', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
};

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

bootstrap().catch((err) => {
  log('Fatal startup error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
