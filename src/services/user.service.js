'use strict';

const { admin, one, many, rpc } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const {
  SESSION_USER_COLUMNS,
  PUBLIC_USER_COLUMNS,
  SEARCH_COLUMNS,
  sessionUser,
  publicPlayer,
  searchCard,
  equippedItem
} = require('../utils/mappers');
const achievementService = require('./achievement.service');
const bannerService = require('./banner.service');
const matchService = require('./match.service');
const leaderboardService = require('./leaderboard.service');
const friendService = require('./friend.service');
const shopService = require('./shop.service');
const { cleanText } = require('../utils/sanitize');

const SETTINGS_COLUMNS =
  'sound, music, haptics, auto_rematch, profile_visibility, who_can_message, block_invites, push_notifications, match_invites, rewards, friend_activity, language';

const EQUIPPED_CACHE = new Map();
const EQUIPPED_CACHE_TTL = 30 * 1000;
const EQUIPPED_PROMISES = new Map();
const SETTINGS_CACHE = new Map();
const SETTINGS_CACHE_TTL = 30 * 1000;
const SETTINGS_PROMISES = new Map();

function invalidateEquippedCache(userId) {
  if (userId) {
    EQUIPPED_CACHE.delete(String(userId));
    EQUIPPED_PROMISES.delete(String(userId));
  }
}

function invalidateSettingsCache(userId) {
  if (userId) {
    SETTINGS_CACHE.delete(String(userId));
    SETTINGS_PROMISES.delete(String(userId));
  }
}

async function equippedFor(userId) {
  const key = String(userId);
  const cached = EQUIPPED_CACHE.get(key);
  if (cached && Date.now() - cached.at < EQUIPPED_CACHE_TTL) {
    return cached.items;
  }
  if (EQUIPPED_PROMISES.has(key)) return EQUIPPED_PROMISES.get(key);
  const promise = (async () => {
    try {
      const rows = await many(
        admin
          .from('purchased_avatars')
          .select('equipped, avatars(id, name, type, image_url, emoji, rarity)')
          .eq('user_id', userId)
          .eq('equipped', true),
        'Could not load your equipped items'
      );
      const items = rows.map(equippedItem).filter((item) => item.id);
      if (EQUIPPED_CACHE.size >= 1000) {
        const oldest = EQUIPPED_CACHE.keys().next().value;
        if (oldest !== undefined) EQUIPPED_CACHE.delete(oldest);
      }
      EQUIPPED_CACHE.set(key, { at: Date.now(), items });
      return items;
    } finally {
      EQUIPPED_PROMISES.delete(key);
    }
  })();
  EQUIPPED_PROMISES.set(key, promise);
  return promise;
}

async function getSettings(userId) {
  const key = String(userId);
  const cached = SETTINGS_CACHE.get(key);
  if (cached && Date.now() - cached.at < SETTINGS_CACHE_TTL) {
    return cached.row;
  }
  if (SETTINGS_PROMISES.has(key)) return SETTINGS_PROMISES.get(key);
  const promise = (async () => {
    try {
      let row = await one(
        admin.from('user_settings').select(SETTINGS_COLUMNS).eq('user_id', userId).maybeSingle(),
        'Could not load your settings'
      );
      if (!row) {
        row = await one(
          admin.from('user_settings').upsert({ user_id: userId }, { onConflict: 'user_id' }).select(SETTINGS_COLUMNS).single(),
          'Could not create your settings'
        );
      }
      if (SETTINGS_CACHE.size >= 1000) {
        const oldest = SETTINGS_CACHE.keys().next().value;
        if (oldest !== undefined) SETTINGS_CACHE.delete(oldest);
      }
      SETTINGS_CACHE.set(key, { at: Date.now(), row });
      return row;
    } finally {
      SETTINGS_PROMISES.delete(key);
    }
  })();
  SETTINGS_PROMISES.set(key, promise);
  return promise;
}

const SETTINGS_UPDATE_FIELDS = [
  'sound', 'music', 'haptics', 'auto_rematch', 'profile_visibility', 'who_can_message',
  'block_invites', 'push_notifications', 'match_invites', 'rewards', 'friend_activity', 'language'
];

async function updateSettings(userId, patch = {}) {
  const payload = { user_id: userId };
  for (const field of SETTINGS_UPDATE_FIELDS) {
    if (patch[field] !== undefined) payload[field] = patch[field];
  }
  if (Object.keys(payload).length === 1) return getSettings(userId);
  const row = await one(
    admin.from('user_settings').upsert(payload, { onConflict: 'user_id' }).select(SETTINGS_COLUMNS).single(),
    'Could not save your settings'
  );
  invalidateSettingsCache(userId);
  return row;
}

async function membership(userId, targetId) {
  if (!userId || !targetId) return null;
  if (String(userId) === String(targetId)) return 'self';
  const row = await one(
    admin
      .from('friends')
      .select('user_id, friend_id, status')
      .or(
        `and(user_id.eq.${userId},friend_id.eq.${targetId}),and(user_id.eq.${targetId},friend_id.eq.${userId})`
      )
      .maybeSingle(),
    'Could not check friendship'
  );
  if (!row) return null;
  if (row.status === 'blocked') return row.user_id === Number(userId) ? 'blocked' : 'blocked_by';
  if (row.status === 'pending') return row.user_id === Number(userId) ? 'request_sent' : 'request_received';
  return 'friends';
}

async function me(user) {
  // Equipped items and all four badge counters are independent, so they run
  // together. The counters are one SQL statement instead of three count
  // round trips on every page that hydrates the account.
  const [equipped, badges] = await Promise.all([
    equippedFor(user.id),
    rpc('get_user_badge_counts', { p_user_id: user.id }, 'Could not load your counters')
  ]);

  return {
    user: {
      ...sessionUser(user),
      friend_count: Number(badges?.friends || 0),
      unread_notifications: Number(badges?.notifications || 0),
      unread_messages: Number(badges?.messages || 0),
      unclaimed_rewards: Number(badges?.rewards || 0)
    },
    equipped
  };
}

async function dashboard(user) {
  const [
    meData,
    bannersData,
    recentMatchData,
    achievementsData,
    topPlayersList,
    friendsData,
    ownedData
  ] = await Promise.all([
    me(user),
    bannerService.activeBanners().catch(() => ({ banners: [] })),
    matchService.history(user, { limit: 1 }).catch(() => ({ matches: [] })),
    achievementService.list(user).catch(() => ({ achievements: [] })),
    leaderboardService.topPlayers('global', 5).catch(() => []),
    friendService.listFriends(user).catch(() => ({ friends: [] })),
    shopService.owned(user).catch(() => ({ items: [] }))
  ]);

  return {
    user: meData.user,
    equipped: meData.equipped,
    banners: bannersData.banners || [],
    recentMatch: (recentMatchData.matches || [])[0] || null,
    achievements: achievementsData.achievements || [],
    leaderboard: topPlayersList || [],
    friends: friendsData.friends || [],
    vault: {
      skins: (ownedData.items || []).filter((item) => item.type === 'skin').length,
      frames: (ownedData.items || []).filter((item) => item.type === 'frame').length,
      rewards: meData.user.unclaimed_rewards || 0,
      coins: meData.user.coins || 0
    }
  };
}

async function profile(viewer, targetId) {
  const id = Number(targetId);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('INVALID_USER', 'Invalid player id');

  const target = await one(
    admin.from('users').select(`${PUBLIC_USER_COLUMNS}, coins`).eq('id', id).maybeSingle(),
    'Could not load this profile'
  );
  if (!target) throw ApiError.notFound('USER_NOT_FOUND', 'Player not found');

  const relation = viewer?.id ? (await membership(viewer.id, id)) || 'none' : 'none';
  const targetSettings = await getSettings(id);

  if (relation !== 'self' && relation !== 'friends') {
    if (targetSettings.profile_visibility === 'Private') {
      throw ApiError.forbidden('PROFILE_PRIVATE', 'This profile is private');
    }
    if (targetSettings.profile_visibility === 'Friends Only') {
      throw ApiError.forbidden('PROFILE_FRIENDS_ONLY', 'Only friends can view this profile');
    }
  }

  const equipped = await equippedFor(id);

  return {
    user: publicPlayer(target, { includeCoins: relation === 'self' }),
    equipped,
    friendship_status: relation,
    is_self: relation === 'self'
  };
}

async function profileByUsername(viewer, username) {
  const clean = cleanText(username, 30).trim();
  if (!clean) throw ApiError.badRequest('INVALID_USERNAME', 'Invalid username');

  const target = await one(
    admin.from('users').select('id').ilike('username', clean).maybeSingle(),
    'Could not look up player by username'
  );
  if (!target) throw ApiError.notFound('USER_NOT_FOUND', 'Player not found');

  return profile(viewer, target.id);
}

async function publicAchievements(viewer, targetId) {
  // Re-uses the profile visibility rules, then exposes the same public
  // achievement catalogue the owner sees (no claim/purchase actions).
  await profile(viewer, targetId);
  return achievementService.list({ id: Number(targetId) });
}

const USERNAME_RE = /^[a-zA-Z0-9_ ]{3,20}$/;

function normalizeUsernameInput(value) {
  return cleanText(value, 80).replace(/\s+/g, ' ').trim();
}

function usernameIssue(username) {
  if (username.length < 3) return 'Username must be at least 3 characters';
  if (username.length > 20) return 'Username must be 20 characters or fewer';
  if (!USERNAME_RE.test(username)) {
    return 'Username can only contain letters, numbers, spaces and underscores';
  }
  return '';
}

/**
 * Case-insensitive lookup. ILIKE can treat an underscore as a wildcard, so
 * the returned rows are compared exactly before reporting a name as taken.
 */
async function usernameTaken(username, { ignoreUserId = null } = {}) {
  const needle = username.toLowerCase();

  const users = await many(
    admin.from('users').select('id, username').ilike('username', username),
    'Could not check username availability'
  );
  if (
    users.some(
      (row) =>
        String(row.id) !== String(ignoreUserId) && String(row.username || '').toLowerCase() === needle
    )
  ) {
    return true;
  }

  const intents = await many(
    admin
      .from('signup_intents')
      .select('id, username')
      .ilike('username', username)
      .gte('expires_at', new Date().toISOString()),
    'Could not check username availability'
  );
  return intents.some((row) => String(row.username || '').toLowerCase() === needle);
}

async function usernameAvailability(user, value) {
  const username = normalizeUsernameInput(value);
  const issue = usernameIssue(username);
  if (issue) {
    throw ApiError.badRequest('INVALID_USERNAME', issue, [{ field: 'username', message: issue }]);
  }

  if (String(user.username || '').toLowerCase() === username.toLowerCase()) {
    return { username, available: true, current: true };
  }

  const taken = await usernameTaken(username, { ignoreUserId: user.id });
  return { username, available: !taken, current: false };
}

async function updateMe(user, input) {
  const patch = {};

  if (input.username !== undefined) {
    const username = normalizeUsernameInput(input.username);
    const issue = usernameIssue(username);
    if (issue) {
      throw ApiError.badRequest('INVALID_USERNAME', issue, [{ field: 'username', message: issue }]);
    }
    if (await usernameTaken(username, { ignoreUserId: user.id })) {
      throw ApiError.conflict('USERNAME_TAKEN', 'That username is already taken');
    }
    patch.username = username;
  }

  if (input.bio !== undefined) patch.bio = cleanText(input.bio, 280);
  if (input.avatar_emoji !== undefined) {
    const emoji = cleanText(input.avatar_emoji, 8);
    if (!emoji) throw ApiError.badRequest('INVALID_AVATAR', 'Choose an avatar emoji');
    patch.avatar_emoji = emoji;
  }

  if (!Object.keys(patch).length) {
    throw ApiError.badRequest('NO_CHANGES', 'No profile changes were supplied');
  }

  const { data: updated, error } = await admin
    .from('users')
    .update(patch)
    .eq('id', user.id)
    .select(SESSION_USER_COLUMNS)
    .single();

  if (error) {
    // The unique index is the final guard against two simultaneous changes.
    if (error.code === '23505' || /duplicate key/i.test(String(error.message))) {
      throw ApiError.conflict('USERNAME_TAKEN', 'That username was just taken. Choose another one.');
    }
    throw new ApiError(502, 'DATABASE_ERROR', 'Could not update your profile');
  }

  if (
    patch.username &&
    String(patch.username).toLowerCase() !== String(user.username || '').toLowerCase()
  ) {
    leaderboardService.invalidateCache();
  }

  return { user: sessionUser(updated), equipped: await equippedFor(user.id) };
}

async function search(user, query) {
  const needle = cleanText(query, 40).replace(/[(),%*_]/g, '').trim();
  if (needle.length < 2) {
    throw ApiError.badRequest('SEARCH_TOO_SHORT', 'Search for at least 2 characters');
  }
  const rows = await many(
    admin
      .from('users')
      .select(SEARCH_COLUMNS)
      .ilike('username', `%${needle}%`)
      .neq('id', user.id)
      .eq('is_bot', false)
      .order('username', { ascending: true })
      .limit(20),
    'Search failed'
  );
  return { users: rows.map(searchCard) };
}

async function setAvatar(user, imageUrl) {
  const updated = await one(
    admin
      .from('users')
      .update({ avatar_url: imageUrl })
      .eq('id', user.id)
      .select(SESSION_USER_COLUMNS)
      .single(),
    'Could not update your avatar'
  );

  // Keep the equipped avatar slot in sync when the user uploads a custom image.
  const current = await one(
    admin
      .from('purchased_avatars')
      .select('avatar_id, avatars(id, type)')
      .eq('user_id', user.id)
      .eq('equipped', true),
    'Could not load your equipped items'
  );

  if (Array.isArray(current)) {
    const avatarRow = current.find((row) => row.avatars && row.avatars.type === 'avatar');
    if (avatarRow?.avatar_id) {
      await admin
        .from('purchased_avatars')
        .update({ equipped: false })
        .eq('user_id', user.id)
        .eq('avatar_id', avatarRow.avatar_id);
    }
  }

  return { user: sessionUser(updated) };
}

async function setOnline(userId, online) {
  const patch = online
    ? { is_online: true, last_seen: new Date().toISOString() }
    : { is_online: false, last_seen: new Date().toISOString() };
  await admin.from('users').update(patch).eq('id', userId);
}

async function unreadSummary(userId) {
  const badges = await rpc('get_user_badge_counts', { p_user_id: userId }, 'Could not load your counters');
  return {
    notifications: Number(badges?.notifications || 0),
    messages: Number(badges?.messages || 0)
  };
}

async function transactions(userId, limit = 30) {
  const rows = await many(
    admin
      .from('coin_transactions')
      .select('id, amount, type, description, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(Number(limit) || 30, 1), 100)),
    'Could not load your coin history'
  );
  return { transactions: rows };
}

module.exports = {
  me,
  dashboard,
  profile,
  profileByUsername,
  publicAchievements,
  updateMe,
  usernameAvailability,
  search,
  setAvatar,
  equippedFor,
  invalidateEquippedCache,
  membership,
  getSettings,
  updateSettings,
  invalidateSettingsCache,
  setOnline,
  unreadSummary,
  transactions
};
