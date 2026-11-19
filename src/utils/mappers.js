'use strict';

const { NOTIFICATION_ICONS } = require('../config/constants');

function publicUser(user, { includePrivate = false } = {}) {
  if (!user) return null;
  const base = {
    id: user.id,
    username: user.username,
    avatar_url: user.avatar_url,
    avatar_emoji: user.avatar_emoji,
    bio: user.bio,
    level: user.level,
    xp: user.xp,
    xp_to_next: user.xp_to_next,
    coins: user.coins,
    wins: user.wins,
    losses: user.losses,
    draws: user.draws,
    score: user.score,
    rank_title: user.rank_title,
    is_admin: Boolean(user.is_admin),
    is_online: Boolean(user.is_online),
    last_seen: user.last_seen,
    last_login_date: user.last_login_date,
    login_streak: user.login_streak,
    created_at: user.created_at,
    updated_at: user.updated_at
  };
  if (includePrivate) {
    base.email = user.email;
    base.is_banned = Boolean(user.is_banned);
    base.total_topup = user.total_topup;
    base.comeback_wins = user.comeback_wins;
  }
  return base;
}

function notificationRow(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    desc: row.description,
    icon: NOTIFICATION_ICONS[row.type] || '📢',
    action_data: row.action_data || null,
    reward_coins: row.reward_coins || 0,
    reward_claimed: Boolean(row.reward_claimed),
    unread: !row.is_read,
    is_read: Boolean(row.is_read),
    created_at: row.created_at,
    time: row.created_at
  };
}

function matchForUser(match, viewerId) {
  const isP1 = String(match.player1_id) === String(viewerId);
  const me = isP1 ? match.player1 : match.player2;
  const opponent = isP1 ? match.player2 : match.player1;
  let myResult = 'draw';
  if (match.result !== 'draw') {
    const winnerId = String(match.winner_id);
    myResult = winnerId === String(viewerId) ? 'win' : 'loss';
  }
  return {
    ...match,
    my_result: myResult,
    opponent_id: opponent?.id,
    opponent_name: opponent?.username || 'Unknown',
    opponent_avatar: opponent?.avatar_emoji || '👤',
    opponent_avatar_url: opponent?.avatar_url || null,
    xp_earned: isP1 ? match.xp_p1 : match.xp_p2,
    xp_lost: 0,
    coins_earned: isP1 ? match.coins_p1 : match.coins_p2,
    score_earned: isP1 ? match.score_p1 : match.score_p2,
    duration_seconds: match.duration_seconds || 0
  };
}

function equippedItem(row) {
  const avatar = row.avatars || row.avatar || {};
  return {
    ...avatar,
    id: avatar.id,
    equipped: Boolean(row.equipped),
    purchased_at: row.purchased_at,
    type: avatar.type,
    image_url: avatar.image_url,
    emoji: avatar.emoji
  };
}

module.exports = { publicUser, notificationRow, matchForUser, equippedItem };
