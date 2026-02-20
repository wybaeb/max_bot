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

const parseBooleanEnv = (name, fallback) => {
  const raw = process.env[name];
  if (!raw) return fallback;

  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;

  throw new Error(`Environment variable ${name} must be boolean-like`);
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
  includeTelegramFooter: parseBooleanEnv('INCLUDE_TELEGRAM_FOOTER', true),
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

const escapeMarkdownText = (value) => {
  return String(value).replace(/([\\`*_{}\[\]()#+\-.!|>~+])/g, '\\$1');
};

const normalizeUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).toString();
  } catch {
    return encodeURI(raw);
  }
};

const hasSupportedAttachment = (messageLike) => {
  if (!messageLike) return false;
  return Boolean(
    (messageLike.photo && messageLike.photo.length)
      || messageLike.video
      || messageLike.animation
      || messageLike.audio
      || messageLike.voice
      || messageLike.video_note
      || messageLike.document,
  );
};

const getRepostSource = (message) => {
  if (hasSupportedAttachment(message)) return message;
  if (hasSupportedAttachment(message.reply_to_message)) return message.reply_to_message;
  if (hasSupportedAttachment(message.external_reply)) return message.external_reply;
  return message;
};

const extractTextAndEntities = (messageLike) => {
  if (!messageLike) return { text: '', entities: [] };

  if (typeof messageLike.text === 'string' && messageLike.text.length) {
    return {
      text: messageLike.text,
      entities: Array.isArray(messageLike.entities) ? messageLike.entities : [],
    };
  }

  if (typeof messageLike.caption === 'string' && messageLike.caption.length) {
    return {
      text: messageLike.caption,
      entities: Array.isArray(messageLike.caption_entities) ? messageLike.caption_entities : [],
    };
  }

  return { text: '', entities: [] };
};

const buildEntityTree = (textLength, entities) => {
  const root = {
    type: 'root',
    offset: 0,
    length: textLength,
    end: textLength,
    children: [],
  };

  const sorted = [...entities]
    .filter((entity) => {
      if (!entity || typeof entity.offset !== 'number' || typeof entity.length !== 'number') return false;
      if (entity.length <= 0 || entity.offset < 0) return false;
      if (entity.offset + entity.length > textLength) return false;
      return true;
    })
    .map((entity) => ({ ...entity, end: entity.offset + entity.length, children: [] }))
    .sort((a, b) => {
      if (a.offset !== b.offset) return a.offset - b.offset;
      return b.length - a.length;
    });

  const stack = [root];

  for (const entity of sorted) {
    while (stack.length && entity.offset >= stack[stack.length - 1].end) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    if (!parent) continue;
    if (entity.offset < parent.offset || entity.end > parent.end) {
      continue;
    }

    parent.children.push(entity);
    stack.push(entity);
  }

  return root;
};

const wrapEntityAsMarkdown = (entity, innerText, rawText) => {
  const raw = String(rawText || '');
  switch (entity.type) {
    case 'bold':
      return `**${innerText}**`;
    case 'italic':
      return `_${innerText}_`;
    case 'underline':
      return `++${innerText}++`;
    case 'strikethrough':
      return `~~${innerText}~~`;
    case 'code':
      return `\`${raw.replace(/`/g, '\\`')}\``;
    case 'pre':
      return `\n\`\`\`\n${raw.replace(/```/g, '``\\`')}\n\`\`\`\n`;
    case 'text_link':
      if (entity.url) {
        return `[${innerText}](${normalizeUrl(entity.url)})`;
      }
      return innerText;
    case 'url':
      return `[${escapeMarkdownText(raw)}](${normalizeUrl(raw)})`;
    case 'text_mention':
      return innerText;
    default:
      return innerText;
  }
};

const renderNodeAsMarkdown = (node, sourceText) => {
  let cursor = node.offset;
  let markdown = '';

  const children = [...(node.children || [])].sort((a, b) => a.offset - b.offset);
  for (const child of children) {
    if (child.offset > cursor) {
      markdown += escapeMarkdownText(sourceText.slice(cursor, child.offset));
    }

    const innerMarkdown = renderNodeAsMarkdown(child, sourceText);
    const rawText = sourceText.slice(child.offset, child.end);
    markdown += wrapEntityAsMarkdown(child, innerMarkdown, rawText);
    cursor = child.end;
  }

  if (cursor < node.end) {
    markdown += escapeMarkdownText(sourceText.slice(cursor, node.end));
  }

  return markdown;
};

const formatTelegramTextAsMarkdown = (text, entities) => {
  if (!text) return '';
  if (!entities || !entities.length) return escapeMarkdownText(text);

  const root = buildEntityTree(text.length, entities);
  return renderNodeAsMarkdown(root, text);
};

const buildTelegramPostUrl = (chat, messageId) => {
  if (!chat) return '';
  if (chat.username && messageId) return `https://t.me/${chat.username}/${messageId}`;
  if (chat.username) return `https://t.me/${chat.username}`;
  if (!messageId) return '';
  if (typeof chat.id === 'number') {
    const id = String(chat.id);
    if (id.startsWith('-100')) {
      return `https://t.me/c/${id.slice(4)}/${messageId}`;
    }
  }
  return '';
};

const getLinkCandidate = (message, source) => {
  const candidates = [
    { chat: source.chat, messageId: source.message_id },
    { chat: message.external_reply?.chat, messageId: message.external_reply?.message_id },
    { chat: message.external_reply?.origin?.chat, messageId: message.external_reply?.origin?.message_id },
    { chat: message.reply_to_message?.chat, messageId: message.reply_to_message?.message_id },
    { chat: message.forward_from_chat, messageId: message.forward_from_message_id },
    { chat: message.forward_origin?.chat, messageId: message.forward_origin?.message_id },
    { chat: message.chat, messageId: message.message_id },
  ];

  for (const candidate of candidates) {
    const url = buildTelegramPostUrl(candidate.chat, candidate.messageId);
    if (url) {
      const name = candidate.chat?.title || (candidate.chat?.username ? `@${candidate.chat.username}` : 'Telegram');
      return { name, url };
    }
  }

  return null;
};

const getTelegramFooter = (message) => {
  if (!config.includeTelegramFooter) return '';
  const source = getRepostSource(message);
  const sourceLink = getLinkCandidate(message, source);
  if (!sourceLink) return '';

  return `tg: [${escapeMarkdownText(sourceLink.name)}](${sourceLink.url})`;
};

const getMessageText = (message, warningText = '') => {
  const own = extractTextAndEntities(message);
  const repostSource = getRepostSource(message);
  const repost = repostSource === message ? { text: '', entities: [] } : extractTextAndEntities(repostSource);
  const footer = getTelegramFooter(message);

  const parts = [];
  if (own.text) parts.push(formatTelegramTextAsMarkdown(own.text, own.entities));
  if (repost.text) parts.push(formatTelegramTextAsMarkdown(repost.text, repost.entities));
  if (warningText) parts.push(escapeMarkdownText(warningText));
  if (footer) parts.push(footer);

  return parts.join('\n\n');
};

const tgFileUrl = async (fileId) => {
  const file = await telegram.getFile(fileId);
  if (!file.file_path) {
    throw new Error(`Telegram did not return file_path for file_id=${fileId}`);
  }
  return `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
};

const isTooBigTelegramError = (err) => {
  const text = err instanceof Error ? err.message : String(err);
  return /file is too big/i.test(text);
};

const uploadByUrl = async (source) => {
  if (source.photo && source.photo.length) {
    const largest = source.photo[source.photo.length - 1];
    const imageUrl = await tgFileUrl(largest.file_id);
    return (await maxBot.api.uploadImage({ url: imageUrl })).toJson();
  }

  if (source.video) {
    const videoUrl = await tgFileUrl(source.video.file_id);
    return (await maxBot.api.uploadVideo({ url: videoUrl })).toJson();
  }

  if (source.animation) {
    const animationUrl = await tgFileUrl(source.animation.file_id);
    return (await maxBot.api.uploadVideo({ url: animationUrl })).toJson();
  }

  if (source.audio) {
    const audioUrl = await tgFileUrl(source.audio.file_id);
    return (await maxBot.api.uploadAudio({ url: audioUrl })).toJson();
  }

  if (source.voice) {
    const voiceUrl = await tgFileUrl(source.voice.file_id);
    return (await maxBot.api.uploadAudio({ url: voiceUrl })).toJson();
  }

  if (source.video_note) {
    const videoNoteUrl = await tgFileUrl(source.video_note.file_id);
    return (await maxBot.api.uploadVideo({ url: videoNoteUrl })).toJson();
  }

  if (source.document) {
    const documentUrl = await tgFileUrl(source.document.file_id);
    const mime = typeof source.document.mime_type === 'string' ? source.document.mime_type : '';
    const fileName = typeof source.document.file_name === 'string'
      ? source.document.file_name.toLowerCase()
      : '';
    if (mime.startsWith('video/')) {
      return (await maxBot.api.uploadVideo({ url: documentUrl })).toJson();
    }
    if (mime.startsWith('audio/')) {
      return (await maxBot.api.uploadAudio({ url: documentUrl })).toJson();
    }
    if (fileName.endsWith('.mp4') || fileName.endsWith('.mov') || fileName.endsWith('.mkv') || fileName.endsWith('.webm')) {
      return (await maxBot.api.uploadVideo({ url: documentUrl })).toJson();
    }
    if (fileName.endsWith('.mp3') || fileName.endsWith('.m4a') || fileName.endsWith('.wav') || fileName.endsWith('.ogg')) {
      return (await maxBot.api.uploadAudio({ url: documentUrl })).toJson();
    }
    return (await maxBot.api.uploadFile({ url: documentUrl })).toJson();
  }

  return null;
};

const buildAttachments = async (message) => {
  const source = getRepostSource(message);
  try {
    const attachment = await uploadByUrl(source);
    if (!attachment && hasSupportedAttachment(message)) {
      log('Media present but not uploadable from Telegram payload', {
        telegram_chat_id: message.chat.id,
        telegram_message_id: message.message_id,
        source_keys: Object.keys(source || {}),
      });
    }
    return {
      attachments: attachment ? [attachment] : [],
      warningText: '',
    };
  } catch (err) {
    const warningText = isTooBigTelegramError(err)
      ? 'Вложение из Telegram не скопировано: файл слишком большой для Bot API.'
      : 'Вложение из Telegram не скопировано: ошибка получения файла.';

    log('Attachment upload failed', {
      error: err instanceof Error ? err.message : String(err),
      telegram_chat_id: message.chat.id,
      telegram_message_id: message.message_id,
    });

    return {
      attachments: [],
      warningText,
    };
  }
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

  const payload = {
    format: 'markdown',
  };
  if (attachments.length) payload.attachments = attachments;
  const safeText = text || ' ';

  if (target.chatId) {
    return maxBot.api.sendMessageToChat(target.chatId, safeText, payload);
  }
  return maxBot.api.sendMessageToUser(target.userId, safeText, payload);
};

const forwardToMax = async (message) => {
  const { attachments, warningText } = await buildAttachments(message);
  const text = getMessageText(message, warningText);
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
    include_telegram_footer: config.includeTelegramFooter,
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
