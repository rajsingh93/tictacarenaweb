'use strict';

const { admin, one, many, rpc } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { cleanText, countWords } = require('../utils/sanitize');
const friendService = require('./friend.service');
const userService = require('./user.service');
const settingsService = require('./settings.service');
const restrictionService = require('./restriction.service');
const { CHAT_FRIEND_COLUMNS, chatFriend } = require('../utils/mappers');

const HISTORY_LIMIT = 50;
// Public chat surfaces render the latest 50 messages and nothing older.
const WORLD_HISTORY_LIMIT = 50;
const LINK_RE = /\b(?:https?:\/\/|www\.)\S+/i;

function validateMessage(message, maxWords = 20) {
  const clean = cleanText(message, 500);
  if (!clean) throw ApiError.badRequest('EMPTY_MESSAGE', 'Message cannot be empty');
  const limit = Math.min(Math.max(Number(maxWords) || 20, 1), 200);
  if (countWords(clean) > limit) {
    throw ApiError.badRequest('MESSAGE_TOO_LONG', `Message cannot exceed ${limit} words`);
  }
  return clean;
}

async function applyModerationPolicy(message) {
  const policy = await settingsService.moderation();
  if (policy.linkBlocking && LINK_RE.test(message)) {
    throw ApiError.badRequest('LINKS_BLOCKED', 'Links are not allowed in chat');
  }
  const banned = Array.isArray(policy.bannedWords) ? policy.bannedWords : [];
  if (banned.length) {
    const lower = message.toLowerCase();
    const hit = banned.find((word) => word && lower.includes(String(word).toLowerCase()));
    if (hit) throw ApiError.badRequest('BLOCKED_WORD', 'That message contains blocked language');
  }
  return message;
}

async function chatPolicy() {
  const [chat, moderation] = await Promise.all([
    settingsService.chat(),
    settingsService.moderation()
  ]);
  return { chat, moderation };
}

async function canMessage(sender, receiverId) {
  if (String(sender.id) === String(receiverId)) {
    throw ApiError.badRequest('CANNOT_MESSAGE_SELF', 'You cannot message yourself');
  }
  const receiver = await one(
    admin.from('users').select('id, username, is_bot').eq('id', receiverId).maybeSingle(),
    'Could not find that player'
  );
  if (!receiver) throw ApiError.notFound('USER_NOT_FOUND', 'Player not found');
  if (receiver.is_bot) throw ApiError.badRequest('CANNOT_MESSAGE_BOT', 'You cannot message the training bot');

  const blocked = await friendService.isBlocked(receiverId, sender.id);
  if (blocked) throw ApiError.forbidden('BLOCKED', 'You cannot message this player');

  const settings = await userService.getSettings(receiverId);
  if (settings.who_can_message === 'No One' && String(receiver.id) !== String(sender.id)) {
    throw ApiError.forbidden('MESSAGES_DISABLED', 'This player does not accept messages');
  }
  if (settings.who_can_message === 'Friends Only') {
    const friends = await friendService.areFriends(sender.id, receiverId);
    if (!friends) throw ApiError.forbidden('FRIENDS_ONLY', 'You can only message friends');
  }
  return receiver;
}

async function list(user) {
  const data = await rpc('get_chat_list', { p_user_id: user.id }, 'Could not load your conversations');
  return { chats: Array.isArray(data) ? data : [] };
}

async function conversation(user, friendId, { before = null } = {}) {
  const id = Number(friendId);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('INVALID_USER', 'Invalid player');

  const beforeId = before === null || before === undefined || before === ''
    ? null
    : Number(before);
  if (beforeId !== null && (!Number.isInteger(beforeId) || beforeId <= 0)) {
    throw ApiError.badRequest('INVALID_CURSOR', 'Invalid message cursor');
  }

  const friendRow = await one(
    admin.from('users').select(CHAT_FRIEND_COLUMNS).eq('id', id).maybeSingle(),
    'Could not load that player'
  );
  if (!friendRow) throw ApiError.notFound('USER_NOT_FOUND', 'Player not found');

  const friends = await friendService.areFriends(user.id, id);
  if (!friends) throw ApiError.forbidden('NOT_FRIENDS', 'You can only chat with friends');

  let query = admin
    .from('chat_messages')
    .select('id, sender_id, message, created_at')
    .or(
      `and(sender_id.eq.${user.id},receiver_id.eq.${id}),and(sender_id.eq.${id},receiver_id.eq.${user.id})`
    );

  if (beforeId) query = query.lt('id', beforeId);

  const rows = await many(
    query.order('id', { ascending: false }).limit(HISTORY_LIMIT + 1),
    'Could not load the conversation'
  );

  const hasMore = rows.length > HISTORY_LIMIT;
  const messages = rows.slice(0, HISTORY_LIMIT).reverse();

  await admin
    .from('chat_messages')
    .update({ is_read: true })
    .eq('sender_id', id)
    .eq('receiver_id', user.id)
    .eq('is_read', false);

  return {
    friend: chatFriend(friendRow),
    messages,
    hasMore,
    nextBefore: messages.length ? messages[0].id : null
  };
}

async function saveMessage(sender, receiverId, rawMessage) {
  await restrictionService.assertAllowed(sender.id, 'chat');
  const receiver = await canMessage(sender, receiverId);
  const policy = await chatPolicy();
  const message = await applyModerationPolicy(validateMessage(rawMessage, policy.chat.maxWords));

  const row = await one(
    admin
      .from('chat_messages')
      .insert({ sender_id: sender.id, receiver_id: receiver.id, message })
      .select('id, sender_id, receiver_id, message, created_at')
      .single(),
    'Could not send the message'
  );

  return { row, receiver };
}

async function markRead(user, friendId) {
  const id = Number(friendId);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('INVALID_USER', 'Invalid player');
  await admin
    .from('chat_messages')
    .update({ is_read: true })
    .eq('sender_id', id)
    .eq('receiver_id', user.id)
    .eq('is_read', false);
  return { message: 'Messages marked as read' };
}

async function worldHistory(limit = WORLD_HISTORY_LIMIT, before = null) {
  const safeLimit = Math.min(Math.max(Number(limit) || WORLD_HISTORY_LIMIT, 1), WORLD_HISTORY_LIMIT);
  const beforeId = Number(before);
  let query = admin
    .from('world_chat_messages')
    .select(
      'id, message, created_at, player:users!world_chat_messages_sender_id_fkey(id, username, avatar_url, avatar_emoji, level, rank_title)'
    );
  if (Number.isInteger(beforeId) && beforeId > 0) query = query.lt('id', beforeId);

  const rows = await many(
    query.order('id', { ascending: false }).limit(safeLimit + 1),
    'Could not load world chat'
  );

  const hasMore = rows.length > safeLimit;
  const page = rows.slice(0, safeLimit).reverse();
  return { messages: page.map(worldRow), hasMore, nextBefore: page.length ? page[0].id : null };
}

function worldRow(row) {
  const player = row.player || {};
  return {
    id: row.id,
    message: row.message,
    created_at: row.created_at,
    time: timeAgo(row.created_at),
    player: {
      id: player.id,
      username: player.username,
      avatar_url: player.avatar_url,
      avatar_emoji: player.avatar_emoji,
      level: player.level,
      rank_title: player.rank_title
    }
  };
}

async function saveWorldMessage(sender, rawMessage) {
  const policy = await chatPolicy();
  if (!policy.chat.worldChatEnabled || !(await require('./featureFlag.service').enabled('world_chat'))) {
    throw ApiError.forbidden('WORLD_CHAT_DISABLED', 'World chat is currently disabled');
  }
  await restrictionService.assertAllowed(sender.id, 'world_chat');
  const slowSeconds = Math.max(0, Math.min(Number(policy.chat.slowModeSeconds) || 0, 3600));
  if (slowSeconds > 0) {
    const { data: last } = await admin
      .from('world_chat_messages')
      .select('created_at')
      .eq('sender_id', sender.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const elapsed = last?.created_at ? Date.now() - new Date(last.created_at).getTime() : Infinity;
    if (elapsed < slowSeconds * 1000) {
      const wait = Math.max(1, Math.ceil((slowSeconds * 1000 - elapsed) / 1000));
      throw new ApiError(429, 'SLOW_MODE', `Please wait ${wait}s before sending another message`);
    }
  }
  const message = await applyModerationPolicy(validateMessage(rawMessage, policy.chat.maxWords));
  const row = await one(
    admin
      .from('world_chat_messages')
      .insert({ sender_id: sender.id, message })
      .select(
        'id, message, created_at, player:users!world_chat_messages_sender_id_fkey(id, username, avatar_url, avatar_emoji, level, rank_title)'
      )
      .single(),
    'Could not send the message'
  );
  return worldRow(row);
}

async function world(limit, before) {
  return worldHistory(limit, before);
}

function timeAgo(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

module.exports = {
  list,
  conversation,
  saveMessage,
  markRead,
  worldHistory,
  world,
  saveWorldMessage,
  validateMessage,
  worldRow,
  timeAgo
};
