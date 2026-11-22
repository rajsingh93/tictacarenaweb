'use strict';

const os = require('os');
const { admin, one, many, rpc, count } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { TABLES } = require('../config/constants');
const {
  ADMIN_USER_COLUMNS,
  adminUserCard,
  adminUserDetail,
  settingsView
} = require('../utils/mappers');
const { cleanText, cleanMultiline } = require('../utils/sanitize');
const notificationService = require('./notification.service');
const supportService = require('./support.service');
const uploadService = require('./upload.service');
const operations = require('./operations.service');

async function stats() {
  const data = await rpc('get_admin_stats', {}, 'Could not load dashboard statistics');
  return { stats: data || {} };
}

async function charts() {
  const data = await rpc('get_admin_charts', {}, 'Could not load charts');
  return data || {};
}

async function traffic() {
  const data = await rpc('get_admin_traffic', {}, 'Could not load traffic');
  return data || { labels: [], signups: [], matches: [], messages: [] };
}

async function serverHealth() {
  const cpus = os.cpus();
  const cpu = cpus.length
    ? cpus.reduce((total, core) => {
        const times = Object.values(core.times).reduce((sum, value) => sum + value, 0);
        return total + ((times - core.times.idle) / times) * 100;
      }, 0) / cpus.length
    : 0;

  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  const maintenance = await one(
    admin.from('app_settings').select('value').eq('key', 'maintenance').maybeSingle(),
    'Could not load maintenance status'
  );

  return {
    cpu: Math.round(cpu * 10) / 10,
    memory: {
      used: Math.round(usedMem / 1024 / 1024),
      total: Math.round(totalMem / 1024 / 1024),
      percent: Math.round((usedMem / totalMem) * 1000) / 10
    },
    uptime: Math.floor(process.uptime()),
    nodeVersion: process.version,
    platform: os.platform(),
    hostname: os.hostname(),
    maintenance: Boolean(maintenance?.value?.enabled),
    timestamp: new Date().toISOString()
  };
}

async function users({ q = '', limit = 100, page = 1 } = {}) {
  // Strip PostgREST filter syntax so a search can never inject an extra
  // predicate into the query.
  const search = cleanText(q, 60).replace(/[(),%*]/g, '').trim();
  const size = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const current = Math.min(Math.max(Number(page) || 1, 1), 1000);

  let base = admin
    .from('users')
    .select(ADMIN_USER_COLUMNS, { count: 'exact' })
    .eq('is_bot', false);

  if (search) base = base.or(`username.ilike.%${search}%,email.ilike.%${search}%`);

  const result = await base
    .order('created_at', { ascending: false })
    .range((current - 1) * size, current * size - 1);
  if (result.error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load users');
  const rows = result.data || [];

  return {
    users: rows.map(adminUserCard),
    total: result.count ?? rows.length,
    page: current,
    limit: size
  };
}

async function me(user) {
  return {
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role || (user.is_admin ? 'admin' : 'player')
    },
    permissions: {
      // Owners can change roles; admins manage day-to-day operations.
      manageRoles: user.role === 'owner',
      manageUsers: Boolean(user.is_admin),
      manageMatches: Boolean(user.is_admin),
      manageRewards: Boolean(user.is_admin),
      manageNotifications: Boolean(user.is_admin),
      manageTournaments: Boolean(user.is_admin)
    }
  };
}

const USER_COLUMNS = `${ADMIN_USER_COLUMNS}, is_bot`;
const SETTINGS_COLUMNS =
  'sound, music, haptics, auto_rematch, profile_visibility, who_can_message, block_invites, push_notifications, match_invites, rewards, friend_activity, language';
const AVATAR_COLUMNS = 'id, name, image_url, price, rarity, type, emoji';

async function userDetail(id) {
  const target = await userById(id);
  const [settings, matches, transactions, achievements, friends] = await Promise.all([
    one(
      admin.from('user_settings').select(SETTINGS_COLUMNS).eq('user_id', target.id).maybeSingle(),
      'Could not load settings'
    ).catch(() => null),
    many(
      admin
        .from('matches')
        .select('id, mode, result, winner_id, duration_seconds, created_at, player1_id, player2_id')
        .or(`player1_id.eq.${target.id},player2_id.eq.${target.id}`)
        .order('created_at', { ascending: false })
        .limit(10),
      'Could not load matches'
    ).catch(() => []),
    many(
      admin
        .from('coin_transactions')
        .select('id, amount, type, description, created_at')
        .eq('user_id', target.id)
        .order('created_at', { ascending: false })
        .limit(10),
      'Could not load transactions'
    ).catch(() => []),
    count(
      admin
        .from('user_achievements')
        .select('user_id', { count: 'exact', head: true })
        .eq('user_id', target.id)
    ).catch(() => 0),
    count(
      admin
        .from('friends')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'accepted')
        .or(`user_id.eq.${target.id},friend_id.eq.${target.id}`)
    ).catch(() => 0)
  ]);

  return {
    user: adminUserDetail(target),
    role: target.is_admin ? 'admin' : 'player',
    settings: settingsView(settings),
    recentMatches: matches,
    recentTransactions: transactions,
    achievements,
    friends
  };
}

async function setRole(adminUser, userId, isAdmin) {
  const target = await userById(userId);
  if (String(adminUser.id) === String(target.id)) {
    throw ApiError.badRequest('CANNOT_CHANGE_OWN_ROLE', 'You cannot change your own role');
  }
  if (target.is_bot) throw ApiError.badRequest('BOT_ACCOUNT', 'Bot accounts cannot be admins');
  await one(
    admin.from('users').update({ is_admin: Boolean(isAdmin) }).eq('id', target.id).select('id').single(),
    'Could not update the role'
  );
  await operations.logActivity(adminUser, isAdmin ? 'user.grant_admin' : 'user.revoke_admin', {
    targetType: 'user',
    targetId: target.id,
    details: { username: target.username }
  });
  return { message: isAdmin ? 'Admin role granted' : 'Admin role revoked' };
}

async function notifyUser(adminUser, userId, message) {
  const target = await userById(userId);
  const text = cleanText(message, 500);
  if (!text) throw ApiError.badRequest('EMPTY_MESSAGE', 'Write a message first');
  await notificationService.create({
    userId: target.id,
    type: 'system',
    title: 'Message from the arena team',
    description: text
  });
  await operations.logActivity(adminUser, 'user.notify', {
    targetType: 'user',
    targetId: target.id,
    details: { message: text.slice(0, 120) }
  });
  return { message: `Notification sent to ${target.username}` };
}

async function userById(id) {
  const user = await one(
    admin.from('users').select(USER_COLUMNS).eq('id', id).maybeSingle(),
    'Could not load that user'
  );
  if (!user) throw ApiError.notFound('USER_NOT_FOUND', 'User not found');
  return user;
}

async function giveCoinsById(adminUser, userId, amount) {
  const target = await userById(userId);
  if (target.is_bot) throw ApiError.badRequest('BOT_ACCOUNT', 'Cannot send coins to a bot');
  const result = await rpc(
    'credit_coins',
    {
      p_user_id: target.id,
      p_amount: amount,
      p_type: 'admin_gift',
      p_description: `Gift from ${adminUser.username}`,
      p_reference_type: 'admin',
      p_reference_id: String(adminUser.id)
    },
    'Could not give coins'
  );
  await notificationService.create({
    userId: target.id,
    type: 'reward',
    title: '💰 Coins Received!',
    description: `${adminUser.username} gave you ${amount.toLocaleString()} coins!`,
    actionData: { coins: amount }
  });
  await operations.logActivity(adminUser, 'user.give_coins', {
    targetType: 'user',
    targetId: target.id,
    details: { amount, coins: result?.coins }
  });
  return { message: `Gave ${amount} coins to ${target.username}`, coins: result?.coins };
}

async function giveCoinsByUsername(adminUser, { username, amount, reason }) {
  const target = await one(
    admin.from('users').select('id, username, is_bot').ilike('username', cleanText(username, 24)).maybeSingle(),
    'Could not find that user'
  );
  if (!target) throw ApiError.notFound('USER_NOT_FOUND', 'User not found');
  if (target.is_bot) throw ApiError.badRequest('BOT_ACCOUNT', 'Cannot send coins to a bot');

  const description = cleanText(reason, 200) || `Gift from ${adminUser.username}`;
  const result = await rpc(
    'credit_coins',
    {
      p_user_id: target.id,
      p_amount: amount,
      p_type: 'admin_gift',
      p_description: description,
      p_reference_type: 'admin',
      p_reference_id: String(adminUser.id)
    },
    'Could not give coins'
  );

  await notificationService.create({
    userId: target.id,
    type: 'reward',
    title: '💰 Coins Received!',
    description: `You received ${amount.toLocaleString()} coins: ${description}`,
    actionData: { coins: amount }
  });

  await operations.logActivity(adminUser, 'user.give_coins', {
    targetType: 'user',
    targetId: target.id,
    details: { amount, reason: description }
  });
  return { message: `Gave ${amount} coins to ${target.username}`, coins: result?.coins };
}

async function resetStats(adminUser, userId) {
  const target = await userById(userId);
  if (target.is_bot) throw ApiError.badRequest('BOT_ACCOUNT', 'Cannot reset bot stats');
  await one(
    admin
      .from('users')
      .update({
        wins: 0,
        losses: 0,
        draws: 0,
        score: 0,
        xp: 0,
        level: 1,
        xp_to_next: 1000,
        rank_title: 'Bronze',
        login_streak: 0,
        comeback_wins: 0
      })
      .eq('id', target.id)
      .select('id')
      .single(),
    'Could not reset stats'
  );
  await operations.logActivity(adminUser, 'user.reset_stats', {
    targetType: 'user',
    targetId: target.id,
    details: { username: target.username }
  });
  return { message: 'User stats reset' };
}

async function setBan(adminUser, userId, ban) {
  if (String(adminUser.id) === String(userId)) {
    throw ApiError.badRequest('CANNOT_BAN_SELF', 'You cannot ban your own account');
  }
  const target = await userById(userId);
  if (target.is_bot) throw ApiError.badRequest('BOT_ACCOUNT', 'Cannot ban a bot');
  await one(
    admin.from('users').update({ is_banned: Boolean(ban), is_online: false }).eq('id', target.id).select('id').single(),
    'Could not update the user'
  );
  await operations.logActivity(adminUser, ban ? 'user.ban' : 'user.unban', {
    targetType: 'user',
    targetId: target.id,
    details: { username: target.username }
  });
  return { message: ban ? 'User banned' : 'User unbanned' };
}

async function avatars() {
  const rows = await many(
    admin
      .from('avatars')
      .select('id, name, image_url, price, rarity, type, emoji, purchased_avatars(count)')
      .order('created_at', { ascending: false }),
    'Could not load shop items'
  );
  return {
    avatars: rows.map((row) => ({
      id: row.id,
      name: row.name,
      image_url: row.image_url,
      price: row.price,
      rarity: row.rarity,
      type: row.type,
      emoji: row.emoji,
      purchase_count: Array.isArray(row.purchased_avatars)
        ? Number(row.purchased_avatars[0]?.count || 0)
        : 0
    }))
  };
}

async function createAvatar(input, file) {
  const name = cleanText(input.name, 50);
  if (!name) throw ApiError.badRequest('NAME_REQUIRED', 'Item name is required');
  const price = Number(input.price);
  if (!Number.isInteger(price) || price < 0) {
    throw ApiError.badRequest('INVALID_PRICE', 'Price must be a non-negative number');
  }
  const type = ['avatar', 'frame', 'skin', 'effect'].includes(input.type) ? input.type : 'avatar';
  const rarity = ['common', 'rare', 'epic', 'legendary'].includes(input.rarity) ? input.rarity : 'common';
  const emoji = cleanText(input.emoji, 8) || '🎨';

  let imageUrl = '/img/avatars/default.png';
  let cloudinaryId = null;
  if (file) {
    const uploaded = await uploadService.uploadImage(file, { folder: 'tictacarena/avatars' });
    imageUrl = uploaded.url;
    cloudinaryId = uploaded.public_id;
  }

  const existing = await one(
    admin.from('avatars').select('id').ilike('name', name).maybeSingle(),
    'Could not check the item name'
  );
  if (existing) throw ApiError.conflict('ITEM_EXISTS', 'An item with that name already exists');

  const row = await one(
    admin
      .from('avatars')
      .insert({ name, image_url: imageUrl, cloudinary_id: cloudinaryId, price, rarity, type, emoji })
      .select(AVATAR_COLUMNS)
      .single(),
    'Could not create the item'
  );
  return { message: 'Item created', avatar: row };
}

async function deleteAvatar(id) {
  const item = await one(
    admin.from('avatars').select(`${AVATAR_COLUMNS}, cloudinary_id`).eq('id', id).maybeSingle(),
    'Could not load the item'
  );
  if (!item) throw ApiError.notFound('ITEM_NOT_FOUND', 'Item not found');
  await admin.from('avatars').delete().eq('id', item.id);
  if (item.cloudinary_id) await uploadService.destroy(item.cloudinary_id);
  return { message: 'Item deleted' };
}

async function matches({ limit = 50, mode = 'all', result = 'all', q = '' } = {}) {
  const search = cleanText(q, 60).replace(/[(),%*]/g, '').trim();
  let query = admin
    .from('matches')
    .select(
      'id, mode, result, duration_seconds, created_at, player1:users!matches_player1_id_fkey(id, username), player2:users!matches_player2_id_fkey(id, username)',
      { count: 'exact' }
    );

  if (['ranked', 'friendly', 'training'].includes(mode)) query = query.eq('mode', mode);
  if (['player1', 'player2', 'draw'].includes(result)) query = query.eq('result', result);

  if (search) {
    const players = await many(
      admin.from('users').select('id').ilike('username', `%${search}%`).limit(25),
      'Could not search players'
    );
    const ids = players.map((player) => Number(player.id)).filter((id) => Number.isInteger(id));
    if (!ids.length) return { matches: [], total: 0 };
    query = query.or(`player1_id.in.(${ids.join(',')}),player2_id.in.(${ids.join(',')})`);
  }

  const queryResult = await query
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
  if (queryResult.error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load matches');
  const rows = queryResult.data || [];

  return {
    matches: rows.map((row) => ({
      id: row.id,
      mode: row.mode,
      duration_seconds: row.duration_seconds,
      created_at: row.created_at,
      p1_name: row.player1?.username || 'Unknown',
      p2_name: row.player2?.username || 'Unknown',
      outcome: row.result === 'draw' ? 'draw' : row.result === 'player1' ? 'win' : 'loss'
    })),
    total: queryResult.count ?? rows.length
  };
}

// Tables without an `id` column still need a valid column for a HEAD count.
const COUNT_KEYS = {
  app_settings: 'key',
  user_settings: 'user_id',
  user_achievements: 'user_id',
  purchased_avatars: 'user_id'
};

async function dbInfo() {
  const entries = await Promise.all(
    TABLES.map(async (table) => {
      try {
        const column = COUNT_KEYS[table] || 'id';
        const rows = await count(admin.from(table).select(column, { count: 'exact', head: true }));
        return { table, rows };
      } catch (error) {
        return { table, rows: 0, error: true };
      }
    })
  );
  return { tables: entries };
}

async function sendMail({ subject, body, reward_coins: rewardCoins }) {
  const sent = await notificationService.broadcast({
    type: 'reward',
    title: cleanText(subject, 120),
    description: cleanMultiline(body, 2000),
    actionData: rewardCoins ? { coins: rewardCoins } : null,
    rewardCoins
  });
  return { message: `Mail sent to ${sent} users!`, recipients: sent };
}

async function setMaintenance({ enabled, message }) {
  const current = await one(
    admin.from('app_settings').select('value').eq('key', 'maintenance').maybeSingle(),
    'Could not load maintenance settings'
  );
  const previous = current?.value || {};
  const value = {
    ...previous,
    enabled: Boolean(enabled),
    message: message !== undefined ? cleanText(message, 500) : previous.message || '',
    ends_at: enabled
      ? previous.ends_at && previous.enabled
        ? previous.ends_at
        : new Date(Date.now() + 30 * 60 * 1000).toISOString()
      : null
  };
  await one(
    admin
      .from('app_settings')
      .upsert({ key: 'maintenance', value }, { onConflict: 'key' })
      .select('key')
      .single(),
    'Could not save maintenance settings'
  );
  return { maintenance: value.enabled, message: value.message, ends_at: value.ends_at };
}

async function supportTickets(query) {
  return supportService.list(query);
}

async function updateSupportTicket(id, status) {
  return supportService.updateStatus(id, status);
}

module.exports = {
  stats,
  charts,
  traffic,
  serverHealth,
  users,
  me,
  userDetail,
  setRole,
  notifyUser,
  giveCoinsById,
  giveCoinsByUsername,
  resetStats,
  setBan,
  avatars,
  createAvatar,
  deleteAvatar,
  matches,
  dbInfo,
  sendMail,
  setMaintenance,
  supportTickets,
  updateSupportTicket
};
