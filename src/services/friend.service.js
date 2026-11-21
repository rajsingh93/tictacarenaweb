'use strict';

const { admin, one, many, rpc } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { cleanText } = require('../utils/sanitize');
const { FRIEND_COLUMNS, friendCard } = require('../utils/mappers');

// The UI caps a friend list at 100; never ask the database for more.
const FRIEND_LIST_LIMIT = 100;
const notificationService = require('./notification.service');

async function relationship(userId, otherId) {
  return one(
    admin
      .from('friends')
      .select('id, user_id, friend_id, status, created_at, responded_at')
      .or(
        `and(user_id.eq.${userId},friend_id.eq.${otherId}),and(user_id.eq.${otherId},friend_id.eq.${userId})`
      )
      .maybeSingle(),
    'Could not check friendship'
  );
}

async function loadUsers(ids) {
  if (!ids.length) return [];
  const rows = await many(
    admin.from('users').select(FRIEND_COLUMNS).in('id', ids),
    'Could not load players'
  );
  return rows.map(friendCard);
}

async function listFriends(user) {
  const rows = await many(
    admin
      .from('friends')
      .select('id, user_id, friend_id, responded_at')
      .eq('status', 'accepted')
      .or(`user_id.eq.${user.id},friend_id.eq.${user.id}`)
      .order('responded_at', { ascending: false })
      .limit(FRIEND_LIST_LIMIT),
    'Could not load friends'
  );
  const ids = rows
    .map((row) => (row.user_id === Number(user.id) ? row.friend_id : row.user_id))
    .filter((id) => String(id) !== String(user.id));
  const users = await loadUsers(ids);
  const byId = new Map(users.map((row) => [String(row.id), row]));
  const mapped = ids.map((id) => byId.get(String(id)));
  return {
    friends: mapped.filter(Boolean)
  };
}

async function listRequests(user) {
  const rows = await many(
    admin
      .from('friends')
      .select('id, user_id, friend_id, created_at')
      .eq('status', 'pending')
      .eq('friend_id', user.id)
      .order('created_at', { ascending: false })
      .limit(FRIEND_LIST_LIMIT),
    'Could not load friend requests'
  );
  const users = await loadUsers(rows.map((row) => row.user_id));
  const byId = new Map(users.map((row) => [String(row.id), row]));
  return {
    requests: rows
      .map((row) => {
        const player = byId.get(String(row.user_id));
        return player ? { ...player, requested_at: row.created_at } : null;
      })
      .filter(Boolean)
  };
}

async function listBlocked(user) {
  const rows = await many(
    admin
      .from('friends')
      .select('id, user_id, friend_id, created_at')
      .eq('status', 'blocked')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(FRIEND_LIST_LIMIT),
    'Could not load blocked users'
  );
  const users = await loadUsers(rows.map((row) => row.friend_id));
  const byId = new Map(users.map((row) => [String(row.id), row]));
  return {
    blocked: rows
      .map((row) => {
        const player = byId.get(String(row.friend_id));
        // `blocked_id` is the blocked player's user id, which is what the
        // unblock endpoint expects.
        return player ? { ...player, blocked_id: row.friend_id } : null;
      })
      .filter(Boolean)
  };
}

async function getRelationshipStatus(user, otherId) {
  const id = Number(otherId);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest('INVALID_USER', 'Invalid player');
  }
  if (id === Number(user.id)) return { status: 'self' };

  const row = await relationship(user.id, id);
  if (!row) return { status: 'none' };
  if (row.status === 'accepted') {
    return { status: 'friends', since: row.responded_at || row.created_at };
  }
  if (row.status === 'blocked') {
    return {
      status: String(row.user_id) === String(user.id) ? 'blocked' : 'blocked_by'
    };
  }
  const outgoing = String(row.user_id) === String(user.id);
  return {
    status: outgoing ? 'pending_outgoing' : 'pending_incoming',
    requested_at: row.created_at
  };
}

async function targetById(playerId) {
  const id = Number(playerId);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest('INVALID_USER', 'Invalid player');
  }
  const target = await one(
    admin.from('users').select('id, username, is_bot').eq('id', id).maybeSingle(),
    'Could not find that player'
  );
  if (!target) throw ApiError.notFound('USER_NOT_FOUND', 'Player not found');
  return target;
}

async function targetByUsername(username) {
  const clean = cleanText(username, 24);
  if (!clean) throw ApiError.badRequest('INVALID_USERNAME', 'Enter a username');
  const target = await one(
    admin.from('users').select('id, username, is_bot').ilike('username', clean).maybeSingle(),
    'Could not find that player'
  );
  if (!target) throw ApiError.notFound('USER_NOT_FOUND', 'No player with that username exists');
  return target;
}

async function sendRequest(user, target) {
  if (String(target.id) === String(user.id)) {
    throw ApiError.badRequest('CANNOT_ADD_SELF', 'You cannot add yourself');
  }
  if (target.is_bot) throw ApiError.badRequest('CANNOT_ADD_BOT', 'You cannot add a training bot');

  const result = await rpc(
    'friend_send_request',
    { p_user_id: user.id, p_target_id: target.id },
    'Could not send the friend request'
  );
  const request = result?.request || null;

  if (result?.status === 'accepted') {
    await notificationService.create({
      userId: target.id,
      type: 'friend',
      title: 'Friend Request Accepted',
      description: `${user.username} accepted your friend request!`,
      actionData: { friend_id: user.id }
    });
    return { message: `You are now friends with ${target.username}`, request };
  }

  if (request) {
    await notificationService.create({
      userId: target.id,
      type: 'friend',
      title: 'New Friend Request',
      description: `${user.username} sent you a friend request.`,
      actionData: { request_id: request.id, friend_id: user.id }
    });
  }

  return { message: `Friend request sent to ${target.username}`, request };
}

async function sendRequestByUsername(user, username) {
  const target = await targetByUsername(username);
  if (String(target.id) === String(user.id)) {
    throw ApiError.badRequest('CANNOT_ADD_SELF', 'You cannot add yourself');
  }
  return sendRequest(user, target);
}

async function acceptRequest(user, senderId) {
  const id = Number(senderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest('INVALID_USER', 'Invalid player');
  }

  const result = await rpc(
    'friend_accept_request',
    { p_user_id: user.id, p_sender_id: id },
    'Could not accept the friend request'
  );

  const sender = await one(
    admin.from('users').select('id, username').eq('id', id).maybeSingle(),
    'Could not load the player'
  );

  if (sender && !result?.duplicate) {
    await notificationService.create({
      userId: sender.id,
      type: 'friend',
      title: 'Friend Request Accepted',
      description: `${user.username} accepted your friend request!`,
      actionData: { friend_id: user.id }
    });
  }

  return { message: result?.duplicate ? 'You are already friends' : 'Friend request accepted' };
}

async function removeFriend(user, otherId) {
  const id = Number(otherId);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest('INVALID_USER', 'Invalid player');
  }
  await rpc(
    'friend_remove',
    { p_user_id: user.id, p_other_id: id },
    'Could not remove that friend'
  );
  return { message: 'Friend removed' };
}

async function declineRequest(user, otherId) {
  const id = Number(otherId);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest('INVALID_USER', 'Invalid player');
  }

  // One endpoint handles both sides of a pending request: declining an
  // incoming request and cancelling an outgoing one.
  const result = await rpc(
    'friend_decline_request',
    { p_user_id: user.id, p_other_id: id },
    'Could not update the friend request'
  );

  return { message: result?.cancelled ? 'Friend request cancelled' : 'Friend request declined' };
}

async function blockUser(user, otherId) {
  const id = Number(otherId);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('INVALID_USER', 'Invalid player');
  if (id === Number(user.id)) throw ApiError.badRequest('CANNOT_BLOCK_SELF', 'You cannot block yourself');

  const result = await rpc(
    'friend_block',
    { p_user_id: user.id, p_target_id: id },
    'Could not block that player'
  );

  return {
    message: 'User blocked',
    blocked_id: result?.request?.friend_id ?? id
  };
}

async function unblockUser(user, otherId) {
  const id = Number(otherId);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('INVALID_USER', 'Invalid player');

  await rpc(
    'friend_unblock',
    { p_user_id: user.id, p_target_id: id },
    'Could not unblock that player'
  );
  return { message: 'User unblocked' };
}

async function areFriends(userId, otherId) {
  const row = await relationship(userId, otherId);
  return Boolean(row && row.status === 'accepted');
}

async function isBlocked(userId, otherId) {
  const row = await relationship(userId, otherId);
  return Boolean(row && row.status === 'blocked');
}

module.exports = {
  listFriends,
  listRequests,
  listBlocked,
  sendRequest,
  sendRequestByUsername,
  acceptRequest,
  removeFriend,
  declineRequest,
  blockUser,
  unblockUser,
  areFriends,
  isBlocked,
  getRelationshipStatus,
  targetById,
  targetByUsername
};
