'use strict';

const { admin, one, many, count, rpc } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { publicUser } = require('../utils/mappers');
const { cleanText, cleanMultiline } = require('../utils/sanitize');

const ICONS = { friend: '👥', match: '🎮', reward: '🎁', system: '📢' };

function toRow(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    desc: row.description,
    icon: ICONS[row.type] || '📢',
    action_data: row.action_data || null,
    reward_coins: row.reward_coins || 0,
    reward_claimed: Boolean(row.reward_claimed),
    unread: !row.is_read,
    is_read: Boolean(row.is_read),
    created_at: row.created_at,
    time: row.created_at
  };
}

function categoryFilter(query, category) {
  if (category === 'mail') return query.in('type', ['reward', 'system']);
  if (category === 'game') return query.in('type', ['friend', 'match']);
  return query;
}

async function list(userId, category, limit = 50) {
  const base = admin
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 100));

  const rows = await many(categoryFilter(base, category), 'Could not load notifications');
  const unread = await unreadCount(userId);
  return { notifications: rows.map(toRow), total: rows.length, unread };
}

async function unreadCount(userId) {
  return count(
    admin
      .from('notifications')
      .select('*', { count: 'exact', head: true })
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
    .select('*')
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
      .select('*')
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
    admin.from('notifications').select('*').eq('id', id).eq('user_id', userId).maybeSingle(),
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
    admin.from('users').select('*').eq('id', userId).single(),
    'Could not refresh your account'
  );

  return {
    message: 'Reward claimed',
    coins: result?.coins ?? refreshed.coins,
    amount: result?.amount ?? row.reward_coins,
    user: publicUser(refreshed, { includePrivate: true })
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
