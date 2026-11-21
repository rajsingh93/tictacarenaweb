'use strict';

const { admin, one, many, count, rpc } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { SESSION_USER_COLUMNS, sessionUser, notificationView } = require('../utils/mappers');
const { cleanText, cleanMultiline } = require('../utils/sanitize');

const NOTIF_COLUMNS = 'id, type, title, description, reward_coins, reward_claimed, is_read, created_at';

const toRow = notificationView;

function categoryFilter(query, category) {
  if (category === 'mail') return query.in('type', ['reward', 'system']);
  if (category === 'game') return query.in('type', ['friend', 'match']);
  return query;
}

async function list(userId, category, limit = 50, offset = 0) {
  const size = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const start = Math.max(Number(offset) || 0, 0);
  const base = admin
    .from('notifications')
    .select(NOTIF_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    // One extra row reports whether another page exists, without a count query.
    .range(start, start + size);

  const rows = await many(categoryFilter(base, category), 'Could not load notifications');
  return {
    notifications: rows.slice(0, size).map(toRow),
    hasMore: rows.length > size
  };
}

async function unreadCount(userId) {
  return count(
    admin
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false),
    'Could not count notifications'
  );
}

async function create({ userId, type = 'system', title, description, actionData = null, rewardCoins = 0 }) {
  if (!userId) return null;
  const cleanTitle = cleanText(title, 120) || 'Notification';
  const cleanDescription = cleanMultiline(description, 1000);
  const { data, error } = await admin
    .from('notifications')
    .insert({
      user_id: userId,
      type: ['friend', 'match', 'reward', 'system'].includes(type) ? type : 'system',
      title: cleanTitle,
      description: cleanDescription,
      action_data: actionData,
      reward_coins: Math.max(0, Number(rewardCoins) || 0)
    })
    .select(NOTIF_COLUMNS)
    .single();
  if (error) return null;
  return toRow(data);
}

async function createMany(userIds, payload) {
  const unique = [...new Set((userIds || []).map(Number).filter(Boolean))];
  if (!unique.length) return 0;
  const rows = unique.map((userId) => ({
    user_id: userId,
    type: ['friend', 'match', 'reward', 'system'].includes(payload.type) ? payload.type : 'system',
    title: cleanText(payload.title, 120) || 'Notification',
    description: cleanMultiline(payload.description, 1000),
    action_data: payload.actionData || null,
    reward_coins: Math.max(0, Number(payload.rewardCoins) || 0)
  }));
  const inserted = await many(
    admin.from('notifications').insert(rows).select('id'),
    'Could not deliver notifications'
  );
  return inserted.length;
}

/**
 * Delivers one notification to every active human account in a single SQL
 * statement. This avoids fetching an unbounded user list into Node.
 */
async function broadcast({ title, description, type = 'system', rewardCoins = 0, actionData = null }) {
  const sent = await rpc(
    'broadcast_notification',
    {
      p_title: cleanText(title, 120) || 'Announcement',
      p_description: cleanMultiline(description, 2000),
      p_type: ['friend', 'match', 'reward', 'system'].includes(type) ? type : 'system',
      p_reward_coins: Math.max(0, Number(rewardCoins) || 0),
      p_action_data: actionData || null
    },
    'Could not deliver the announcement'
  );
  return Number(sent) || 0;
}

async function markRead(userId, id) {
  const row = await one(
    admin
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', userId)
      .select(NOTIF_COLUMNS)
      .maybeSingle(),
    'Could not mark the notification as read'
  );
  if (!row) throw ApiError.notFound('NOTIFICATION_NOT_FOUND', 'Notification not found');
  return { message: 'Marked as read', notification: toRow(row) };
}

async function markAllRead(userId, category) {
  let query = admin.from('notifications').update({ is_read: true }).eq('user_id', userId).eq('is_read', false);
  if (category === 'mail') query = query.in('type', ['reward', 'system']);
  if (category === 'game') query = query.in('type', ['friend', 'match']);
  const rows = await many(query.select('id'), 'Could not mark notifications as read');
  return { message: 'All notifications marked as read', updated: rows.length };
}

async function remove(userId, id) {
  const row = await one(
    admin
      .from('notifications')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle(),
    'Could not delete the notification'
  );
  if (!row) throw ApiError.notFound('NOTIFICATION_NOT_FOUND', 'Notification not found');
  return { message: 'Notification deleted' };
}

async function claim(userId, id) {
  const row = await one(
    admin.from('notifications').select('id, reward_coins, reward_claimed').eq('id', id).eq('user_id', userId).maybeSingle(),
    'Could not load the notification'
  );
  if (!row) throw ApiError.notFound('NOTIFICATION_NOT_FOUND', 'Mail not found');
  if (row.reward_coins <= 0) throw ApiError.badRequest('NO_REWARD', 'This mail has no attached reward');
  if (row.reward_claimed) throw ApiError.conflict('ALREADY_CLAIMED', 'This reward has already been claimed');

  const result = await require('../utils/db').rpc(
    'claim_notification_reward',
    { p_user_id: userId, p_notification_id: Number(id) },
    'Could not claim the reward'
  );

  const refreshed = await one(
    admin.from('users').select(SESSION_USER_COLUMNS).eq('id', userId).single(),
    'Could not refresh your account'
  );

  return {
    message: 'Reward claimed',
    coins: result?.coins ?? refreshed.coins,
    amount: result?.amount ?? row.reward_coins,
    user: sessionUser(refreshed)
  };
}

async function markAllInCategoryRead(userId, category) {
  return markAllRead(userId, category);
}

module.exports = {
  list,
  unreadCount,
  create,
  createMany,
  broadcast,
  markRead,
  markAllRead,
  markAllInCategoryRead,
  remove,
  claim,
  toRow
};
