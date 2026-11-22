'use strict';

/**
 * Response DTOs.
 *
 * Each builder lists exactly the fields a screen renders, and the exported
 * column lists keep the database read in sync with that shape. Internal
 * columns (auth ids, provider references, cloudinary ids, board state on list
 * views, ...) therefore never reach a client by accident.
 */

const SESSION_USER_COLUMNS =
  'id, username, email, avatar_url, avatar_emoji, bio, level, xp, xp_to_next, coins, wins, losses, draws, score, rank_title, is_admin, is_online, last_seen, last_login_date, created_at';
const PUBLIC_USER_COLUMNS =
  'id, username, avatar_url, avatar_emoji, bio, level, xp, xp_to_next, wins, losses, draws, score, rank_title, is_admin, is_online, last_seen, created_at';
const FRIEND_COLUMNS = 'id, username, avatar_url, avatar_emoji, level, rank_title, is_online, last_seen, last_login_date';
const SEARCH_COLUMNS = 'id, username, avatar_url, avatar_emoji, level, rank_title';
const CHAT_FRIEND_COLUMNS = 'id, username, avatar_url, avatar_emoji, is_online';
const LEADERBOARD_COLUMNS = 'id, username, avatar_url, avatar_emoji, level, rank_title, wins, losses, draws, score, is_online';
const ADMIN_USER_COLUMNS =
  'id, username, email, avatar_url, avatar_emoji, level, xp, xp_to_next, coins, wins, losses, draws, score, rank_title, is_admin, is_banned, is_online, created_at';

const SETTINGS_FIELDS = [
  'sound',
  'music',
  'haptics',
  'auto_rematch',
  'profile_visibility',
  'who_can_message',
  'block_invites',
  'push_notifications',
  'match_invites',
  'rewards',
  'friend_activity',
  'language'
];

/** The signed-in account, as cached by the client shell on every page. */
function sessionUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
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
    created_at: user.created_at
  };
}

/** Another player's profile page. Coins are only exposed to the owner. */
function publicPlayer(user, { includeCoins = false } = {}) {
  if (!user) return null;
  const player = {
    id: user.id,
    username: user.username,
    avatar_url: user.avatar_url,
    avatar_emoji: user.avatar_emoji,
    bio: user.bio,
    level: user.level,
    xp: user.xp,
    xp_to_next: user.xp_to_next,
    wins: user.wins,
    losses: user.losses,
    draws: user.draws,
    score: user.score,
    rank_title: user.rank_title,
    is_admin: Boolean(user.is_admin),
    is_online: Boolean(user.is_online),
    last_seen: user.last_seen,
    created_at: user.created_at
  };
  if (includeCoins) player.coins = user.coins;
  return player;
}

/** Friends list, friend requests and blocked players. */
function friendCard(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    avatar_url: user.avatar_url,
    avatar_emoji: user.avatar_emoji,
    level: user.level,
    rank_title: user.rank_title,
    is_online: Boolean(user.is_online),
    last_seen: user.last_seen,
    last_login_date: user.last_login_date
  };
}

/** Username search results in the "add a friend" dialog. */
function searchCard(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    avatar_url: user.avatar_url,
    avatar_emoji: user.avatar_emoji,
    level: user.level,
    rank_title: user.rank_title
  };
}

/** Chat conversation header. */
function chatFriend(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    avatar_url: user.avatar_url,
    avatar_emoji: user.avatar_emoji,
    is_online: Boolean(user.is_online)
  };
}

/** One ladder row. `globalRank` comes from the leaderboard function. */
function ladderEntry(player) {
  return {
    globalRank: player.globalRank ?? player.rank ?? null,
    id: player.id,
    username: player.username,
    avatar_url: player.avatar_url,
    avatar_emoji: player.avatar_emoji,
    level: player.level,
    rank_title: player.rank_title,
    wins: player.wins,
    losses: player.losses,
    draws: player.draws,
    score: player.score,
    is_online: Boolean(player.is_online)
  };
}

/** The viewer's own ladder card. */
function ladderSelf(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    avatar_url: user.avatar_url,
    avatar_emoji: user.avatar_emoji,
    level: user.level,
    rank_title: user.rank_title,
    wins: user.wins,
    losses: user.losses,
    draws: user.draws,
    score: user.score,
    is_online: Boolean(user.is_online)
  };
}

function matchSummary(match, viewerId) {
  const isP1 = String(match.player1_id) === String(viewerId);
  const opponent = isP1 ? match.player2 : match.player1;
  const myResult =
    match.result === 'draw' ? 'draw' : String(match.winner_id) === String(viewerId) ? 'win' : 'loss';
  return {
    id: match.id,
    mode: match.mode,
    my_result: myResult,
    opponent_id: opponent?.id ?? null,
    opponent_name: opponent?.username || 'Unknown',
    opponent_avatar: opponent?.avatar_emoji || '👤',
    opponent_avatar_url: opponent?.avatar_url || null,
    xp_earned: isP1 ? match.xp_p1 : match.xp_p2,
    coins_earned: isP1 ? match.coins_p1 : match.coins_p2,
    duration_seconds: match.duration_seconds || 0,
    created_at: match.created_at
  };
}

/** Detail view adds the board, which list views never need. */
function matchDetail(match, viewerId) {
  return { ...matchSummary(match, viewerId), board_state: match.board_state };
}

/** An owned avatar/frame/skin/effect. */
function equippedItem(row) {
  const avatar = row.avatars || row.avatar || {};
  return {
    id: avatar.id,
    name: avatar.name,
    type: avatar.type,
    image_url: avatar.image_url,
    emoji: avatar.emoji,
    rarity: avatar.rarity,
    equipped: Boolean(row.equipped)
  };
}

/** A shop catalogue row plus the viewer's ownership state. */
function shopItem(item, purchase) {
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    price: item.price,
    image_url: item.image_url,
    emoji: item.emoji,
    rarity: item.rarity,
    owned: Boolean(purchase),
    equipped: Boolean(purchase?.equipped)
  };
}

function notificationView(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    reward_coins: row.reward_coins || 0,
    reward_claimed: Boolean(row.reward_claimed),
    unread: !row.is_read,
    action_data: row.action_data || null,
    created_at: row.created_at
  };
}

function achievementView(achievement, { progress, percent, unlocked, claimed }) {
  return {
    id: achievement.id,
    emoji: achievement.emoji,
    name: achievement.name,
    description: achievement.description,
    category: achievement.category,
    tier: achievement.tier,
    target: achievement.target,
    reward_coins: achievement.reward_coins,
    progress,
    percent,
    unlocked,
    claimed
  };
}

/** User settings; the row id and unused theme column stay server-side. */
function settingsView(row) {
  if (!row) return null;
  const settings = {};
  SETTINGS_FIELDS.forEach((field) => {
    settings[field] = row[field];
  });
  return settings;
}

/** Admin player list row. */
function adminUserCard(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatar_url: user.avatar_url,
    avatar_emoji: user.avatar_emoji,
    level: user.level,
    rank_title: user.rank_title,
    wins: user.wins,
    losses: user.losses,
    draws: user.draws,
    coins: user.coins,
    is_admin: Boolean(user.is_admin),
    is_banned: Boolean(user.is_banned),
    is_online: Boolean(user.is_online),
    created_at: user.created_at
  };
}

/** Admin account detail view. */
function adminUserDetail(user) {
  return { ...adminUserCard(user), xp: user.xp, xp_to_next: user.xp_to_next, score: user.score };
}

module.exports = {
  SESSION_USER_COLUMNS,
  PUBLIC_USER_COLUMNS,
  FRIEND_COLUMNS,
  SEARCH_COLUMNS,
  CHAT_FRIEND_COLUMNS,
  LEADERBOARD_COLUMNS,
  ADMIN_USER_COLUMNS,
  sessionUser,
  publicPlayer,
  friendCard,
  searchCard,
  chatFriend,
  ladderEntry,
  ladderSelf,
  matchSummary,
  matchDetail,
  equippedItem,
  shopItem,
  notificationView,
  achievementView,
  settingsView,
  adminUserCard,
  adminUserDetail
};
