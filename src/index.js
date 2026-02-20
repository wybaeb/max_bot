'use strict';

require('dotenv').config();

const fs = require('node:fs');
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

const trimSlash = (value) => String(value || '').replace(/\/+$/, '');

const config = {
  telegramToken: requireEnv('TELEGRAM_BOT_TOKEN'),
  maxToken: requireEnv('MAX_BOT_TOKEN'),
  telegramApiBaseUrl: trimSlash(process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org'),
  maxTargetChatId: process.env.MAX_TARGET_CHAT_ID
    ? parseIntEnv('MAX_TARGET_CHAT_ID')
    : undefined,
  maxTargetUserId: process.env.MAX_TARGET_USER_ID
    ? parseIntEnv('MAX_TARGET_USER_ID')
    : undefined,
  repostDelayMs: parseIntEnv('REPOST_DELAY_MS', 3000),
  mediaGroupCollectMs: parseIntEnv('MEDIA_GROUP_COLLECT_MS', 1200),
  sourceChatIds: parseIdList(process.env.TELEGRAM_SOURCE_CHAT_IDS || ''),
  includeTelegramFooter: parseBooleanEnv('INCLUDE_TELEGRAM_FOOTER', true),
};

if (config.maxTargetChatId && config.maxTargetUserId) {
  throw new Error('Set only one target: MAX_TARGET_CHAT_ID or MAX_TARGET_USER_ID');
}

if (config.repostDelayMs < 0) {
  throw new Error('REPOST_DELAY_MS must be >= 0');
}
if (config.mediaGroupCollectMs < 0) {
  throw new Error('MEDIA_GROUP_COLLECT_MS must be >= 0');
}

const telegram = new TelegramBot(config.telegramToken, { polling: true });
const maxBot = new MaxBot(config.maxToken);

const queue = [];
const mediaGroupBuffer = new Map();
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

const getMessageCandidates = (message) => {
  return [message, message.reply_to_message, message.external_reply].filter(Boolean);
};

const hasValidFileId = (value) => typeof value === 'string' && value.length > 0;

const resolveDocumentKind = (document) => {
  const mime = typeof document?.mime_type === 'string' ? document.mime_type.toLowerCase() : '';
  const fileName = typeof document?.file_name === 'string' ? document.file_name.toLowerCase() : '';

  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';

  if (fileName.endsWith('.mp4') || fileName.endsWith('.mov') || fileName.endsWith('.mkv') || fileName.endsWith('.webm')) {
    return 'video';
  }
  if (fileName.endsWith('.mp3') || fileName.endsWith('.m4a') || fileName.endsWith('.wav') || fileName.endsWith('.ogg')) {
    return 'audio';
  }

  return 'file';
};

const buildMediaCandidates = (messageLike, label) => {
  const results = [];
  if (!messageLike) return results;

  if (Array.isArray(messageLike.photo) && messageLike.photo.length) {
    for (let i = messageLike.photo.length - 1; i >= 0; i -= 1) {
      const photo = messageLike.photo[i];
      if (!hasValidFileId(photo?.file_id)) continue;
      results.push({
        label,
        kind: 'image',
        fileId: photo.file_id,
      });
    }
  }

  if (hasValidFileId(messageLike.video?.file_id)) {
    results.push({
      label,
      kind: 'video',
      fileId: messageLike.video.file_id,
    });
  }

  if (hasValidFileId(messageLike.animation?.file_id)) {
    results.push({
      label,
      kind: 'video',
      fileId: messageLike.animation.file_id,
    });
  }

  if (hasValidFileId(messageLike.audio?.file_id)) {
    results.push({
      label,
      kind: 'audio',
      fileId: messageLike.audio.file_id,
    });
  }

  if (hasValidFileId(messageLike.voice?.file_id)) {
    results.push({
      label,
      kind: 'audio',
      fileId: messageLike.voice.file_id,
    });
  }

  if (hasValidFileId(messageLike.video_note?.file_id)) {
    results.push({
      label,
      kind: 'video',
      fileId: messageLike.video_note.file_id,
    });
  }

  if (hasValidFileId(messageLike.document?.file_id)) {
    results.push({
      label,
      kind: resolveDocumentKind(messageLike.document),
      fileId: messageLike.document.file_id,
    });
  }

  return results;
};

const chooseTextSource = (message) => {
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
  const source = chooseTextSource(message);
  const sourceLink = getLinkCandidate(message, source);
  if (!sourceLink) return '';

  return `tg: [${escapeMarkdownText(sourceLink.name)}](${sourceLink.url})`;
};

const getMessageText = (message, warningText = '') => {
  const own = extractTextAndEntities(message);
  const repostSource = chooseTextSource(message);
  const repost = repostSource === message ? { text: '', entities: [] } : extractTextAndEntities(repostSource);
  const footer = getTelegramFooter(message);

  const parts = [];
  if (own.text) parts.push(formatTelegramTextAsMarkdown(own.text, own.entities));
  if (repost.text) parts.push(formatTelegramTextAsMarkdown(repost.text, repost.entities));
  if (warningText) parts.push(escapeMarkdownText(warningText));
  if (footer) parts.push(footer);

  return parts.join('\n\n');
};

const tgResolveFileLocation = async (fileId) => {
  const endpoint = `${config.telegramApiBaseUrl}/bot${config.telegramToken}/getFile`;
  const response = await fetch(`${endpoint}?file_id=${encodeURIComponent(fileId)}`);

  if (!response.ok) {
    throw new Error(`Telegram getFile HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(payload.description || 'Telegram getFile failed');
  }

  const filePath = payload.result?.file_path;
  if (!filePath) {
    throw new Error(`Telegram did not return file_path for file_id=${fileId}`);
  }

  // Local Bot API server can return absolute paths in --local mode.
  if (filePath.startsWith('/') && fs.existsSync(filePath)) {
    return {
      type: 'source',
      value: filePath,
    };
  }

  const normalized = filePath.replace(/^\/+/, '');
  return {
    type: 'url',
    value: `${config.telegramApiBaseUrl}/file/bot${config.telegramToken}/${normalized}`,
  };
};

const isTooBigTelegramError = (err) => {
  const text = err instanceof Error ? err.message : String(err);
  return /file is too big/i.test(text);
};

const uploadMediaCandidate = async (candidate) => {
  const location = await tgResolveFileLocation(candidate.fileId);
  const input = location.type === 'source'
    ? { source: location.value }
    : { url: location.value };

  if (candidate.kind === 'image') {
    return (await maxBot.api.uploadImage(input)).toJson();
  }
  if (candidate.kind === 'video') {
    return (await maxBot.api.uploadVideo(input)).toJson();
  }
  if (candidate.kind === 'audio') {
    return (await maxBot.api.uploadAudio(input)).toJson();
  }
  return (await maxBot.api.uploadFile(input)).toJson();
};

const buildAttachments = async (message) => {
  const candidates = getMessageCandidates(message);
  const mediaCandidates = [
    ...buildMediaCandidates(candidates[0], 'message'),
    ...buildMediaCandidates(candidates[1], 'reply_to_message'),
    ...buildMediaCandidates(candidates[2], 'external_reply'),
  ];

  if (!mediaCandidates.length) {
    if (candidates.some((item) => hasSupportedAttachment(item))) {
      log('Media exists but no downloadable file_id', {
        telegram_chat_id: message.chat.id,
        telegram_message_id: message.message_id,
        candidate_flags: candidates.map((item) => ({
          has_supported_attachment: hasSupportedAttachment(item),
          has_protected_content: Boolean(item?.has_protected_content),
          has_video: Boolean(item?.video),
          has_audio: Boolean(item?.audio),
          has_document: Boolean(item?.document),
          has_external_reply: Boolean(item?.external_reply),
        })),
      });
    }
    return { attachments: [], warningText: '' };
  }

  let tooBigErrorSeen = false;
  let lastError = null;

  try {
    for (const candidate of mediaCandidates) {
      try {
        const attachment = await uploadMediaCandidate(candidate);
        return {
          attachments: [attachment],
          warningText: '',
        };
      } catch (err) {
        lastError = err;
        if (isTooBigTelegramError(err)) {
          tooBigErrorSeen = true;
        }
        log('Attachment candidate failed', {
          telegram_chat_id: message.chat.id,
          telegram_message_id: message.message_id,
          candidate_label: candidate.label,
          candidate_kind: candidate.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const warningText = tooBigErrorSeen
      ? 'Вложение из Telegram не скопировано: файл слишком большой для Bot API.'
      : 'Вложение из Telegram не скопировано: файл недоступен через Bot API.';

    log('Attachment upload failed', {
      error: lastError instanceof Error ? lastError.message : String(lastError),
      telegram_chat_id: message.chat.id,
      telegram_message_id: message.message_id,
      candidates_tried: mediaCandidates.map((item) => ({ label: item.label, kind: item.kind })),
    });

    return {
      attachments: [],
      warningText,
    };
  } catch (err) {
    log('Attachment upload failed unexpectedly', {
      error: err instanceof Error ? err.message : String(err),
      telegram_chat_id: message.chat.id,
      telegram_message_id: message.message_id,
    });
    return {
      attachments: [],
      warningText: 'Вложение из Telegram не скопировано: внутренняя ошибка.',
    };
  }
};

const collectMediaGroup = (message) => {
  const key = `${message.chat.id}:${message.media_group_id}`;
  const existing = mediaGroupBuffer.get(key) || {
    messages: [],
    timer: null,
  };

  if (!existing.messages.some((item) => item.message_id === message.message_id)) {
    existing.messages.push(message);
  }

  if (existing.timer) clearTimeout(existing.timer);
  existing.timer = setTimeout(() => {
    mediaGroupBuffer.delete(key);
    const messages = [...existing.messages].sort((a, b) => a.message_id - b.message_id);
    queue.push({
      kind: 'media_group',
      runAt: Date.now() + config.repostDelayMs,
      messages,
    });
    void processQueue();
  }, config.mediaGroupCollectMs);

  mediaGroupBuffer.set(key, existing);
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

const forwardMediaGroupToMax = async (messages) => {
  const ordered = [...messages].sort((a, b) => a.message_id - b.message_id);
  const anchor = ordered.find((item) => extractTextAndEntities(item).text) || ordered[0];

  const attachments = [];
  const warnings = new Set();

  for (const message of ordered) {
    const built = await buildAttachments(message);
    if (built.attachments.length) {
      attachments.push(...built.attachments);
    }
    if (built.warningText) {
      warnings.add(built.warningText);
    }
  }

  const warningText = warnings.size ? Array.from(warnings).join('\n') : '';
  const text = getMessageText(anchor, warningText);
  await sendToMax(text, attachments);

  log('Reposted media group', {
    telegram_chat_id: anchor.chat.id,
    telegram_media_group_id: anchor.media_group_id,
    telegram_messages: ordered.length,
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
        if (next.kind === 'media_group') {
          await forwardMediaGroupToMax(next.messages);
        } else {
          await forwardToMax(next.message);
        }
      } catch (err) {
        log('Failed to repost message', {
          error: err instanceof Error ? err.message : String(err),
          telegram_chat_id: next.message?.chat?.id || next.messages?.[0]?.chat?.id,
          telegram_message_id: next.message?.message_id || next.messages?.[0]?.message_id,
        });
      }
    }
  } finally {
    queueBusy = false;
  }
};

const enqueueMessage = (message) => {
  queue.push({
    kind: 'single',
    message,
    runAt: Date.now() + config.repostDelayMs,
  });
  void processQueue();
};

const onTelegramMessage = (message) => {
  if (!isAllowedSource(message.chat.id)) return;
  if (message.media_group_id) {
    collectMediaGroup(message);
    return;
  }
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
