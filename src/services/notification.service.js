'use strict';

const { admin, one, many, count, rpc } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { SESSION_USER_COLUMNS, sessionUser, notificationView } = require('../utils/mappers');
const { cleanText, cleanMultiline } = require('../utils/sanitize');

const NOTIF_COLUMNS = 'id, type, title, description, reward_coins, reward_claimed, is_read, action_data, created_at';

const toRow = notificationView;

function categoryFilter(query, category) {
  if (category === 'mail') return query.in('type', ['reward', 'system']);
  if (category === 'game') return query.in('type', ['friend', 'match']);
  return query;
}

// The active inbox is capped at five rows per player by a database trigger.
// The API never pages it: older mail is archived automatically and cleaned by
// the retention job, so a caller cannot request an unbounded list.
const INBOX_LIMIT = 5;

async function list(userId, category, _limit, _offset, { withUnread = false } = {}) {
  const base = admin
    .from('notifications')
    .select(NOTIF_COLUMNS)
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(INBOX_LIMIT);

  const rows = await many(categoryFilter(base, category), 'Could not load notifications');
  const payload = {
    notifications: rows.map(toRow),
    hasMore: false,
    limit: INBOX_LIMIT
  };
  if (withUnread) {
    let unreadQuery = admin
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false)
      .is('archived_at', null);
    unreadQuery = categoryFilter(unreadQuery, category);
    payload.unread = await count(unreadQuery, 'Could not count unread mail');
  }
  return payload;
}

async function unreadCount(userId, category) {
  let query = admin
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false)
    .is('archived_at', null);
  query = categoryFilter(query, category);
  return count(query, 'Could not count notifications');
}

async function sendUserMail(sender, { recipient, subject, message } = {}) {
  if (!sender?.id) throw ApiError.unauthorized('SESSION_REQUIRED', 'Sign in to send mail');
  const term = cleanText(recipient, 80);
  const cleanSubject = cleanText(subject, 120);
  const cleanMessage = cleanMultiline(message, 1000);
  if (!term) throw ApiError.badRequest('RECIPIENT_REQUIRED', 'Enter a recipient username or player ID');
  if (!cleanSubject) throw ApiError.badRequest('SUBJECT_REQUIRED', 'Enter a subject');
  if (!cleanMessage) throw ApiError.badRequest('MESSAGE_REQUIRED', 'Write a message');

  let target = null;
  if (/^\d+$/.test(term)) {
    target = await one(
      admin.from('users').select('id, username, is_banned').eq('is_bot', false).eq('id', Number(term)).maybeSingle(),
      'Could not find that player'
    );
  } else {
    // Compare the returned name exactly; ILIKE wildcards must not redirect
    // mail to a different player.
    const rows = await many(
      admin.from('users').select('id, username, is_banned').eq('is_bot', false).ilike('username', term).limit(20),
      'Could not find that player'
    );
    target = rows.find(
      (row) => String(row.username || '').trim().toLowerCase() === term.toLowerCase()
    );
  }
  if (!target) throw ApiError.notFound('RECIPIENT_NOT_FOUND', 'No player matches that username or ID');
  if (String(target.id) === String(sender.id)) throw ApiError.badRequest('SELF_MAIL', 'You cannot send mail to yourself');

  const settings = await one(
    admin.from('user_settings').select('who_can_message').eq('user_id', target.id).maybeSingle(),
    'Could not check the recipient settings'
  ).catch(() => null);
  const whoCanMessage = settings?.who_can_message || 'Friends Only';
  if (whoCanMessage === 'No One') throw ApiError.forbidden('MAIL_DISABLED', 'This player does not accept messages');
  if (whoCanMessage === 'Friends Only') {
    const friendship = await one(
      admin
        .from('friends')
        .select('id, status')
        .or(`and(user_id.eq.${sender.id},friend_id.eq.${target.id}),and(user_id.eq.${target.id},friend_id.eq.${sender.id})`)
        .eq('status', 'accepted')
        .maybeSingle(),
      'Could not check friendship'
    );
    if (!friendship) throw ApiError.forbidden('FRIENDS_ONLY_MAIL', 'This player only accepts mail from friends');
  }

  const created = await create({
    userId: target.id,
    type: 'system',
    title: `Mail from ${sender.username}: ${cleanSubject}`,
    description: cleanMessage,
    actionData: {
      kind: 'user_mail',
      senderId: sender.id,
      senderName: sender.username,
      subject: cleanSubject
    }
  });
  if (!created) throw new ApiError(502, 'MAIL_DELIVERY_FAILED', 'The mail could not be stored');
  return { message: 'Mail sent', mail: created };
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
  // Only write when the row is actually unread. Repeated clicks, retries and
  // duplicate events therefore do not cause a write.
  const row = await one(
    admin
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', userId)
      .eq('is_read', false)
      .select(NOTIF_COLUMNS)
      .maybeSingle(),
    'Could not mark the notification as read'
  );
  if (row) return { message: 'Marked as read', notification: toRow(row) };

  const existing = await one(
    admin.from('notifications').select(NOTIF_COLUMNS).eq('id', id).eq('user_id', userId).maybeSingle(),
    'Could not load the notification'
  );
  if (!existing) throw ApiError.notFound('NOTIFICATION_NOT_FOUND', 'Notification not found');
  return { message: 'Already read', notification: toRow(existing) };
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
  sendUserMail,
  broadcast,
  markRead,
  markAllRead,
  markAllInCategoryRead,
  remove,
  claim,
  toRow
};
