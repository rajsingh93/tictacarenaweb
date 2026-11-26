'use strict';

/**
 * Legacy admin helpers that are still shared by the current admin services.
 * The old standalone admin routes were replaced by /admin/control; the
 * duplicate CRUD implementations that lived here were removed so there is one
 * code path per operation.
 */

const os = require('os');
const { admin, one, many, count } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { ADMIN_USER_COLUMNS, adminUserDetail, settingsView } = require('../utils/mappers');
const { cleanText } = require('../utils/sanitize');
const notificationService = require('./notification.service');
const uploadService = require('./upload.service');
const operations = require('./operations.service');

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

const USER_COLUMNS = `${ADMIN_USER_COLUMNS}, is_bot`;
const SETTINGS_COLUMNS =
  'sound, music, haptics, auto_rematch, profile_visibility, who_can_message, block_invites, push_notifications, match_invites, rewards, friend_activity, language';
const AVATAR_COLUMNS = 'id, name, image_url, price, rarity, type, emoji';

async function userById(id) {
  const user = await one(
    admin.from('users').select(USER_COLUMNS).eq('id', id).maybeSingle(),
    'Could not load that user'
  );
  if (!user) throw ApiError.notFound('USER_NOT_FOUND', 'User not found');
  return user;
}

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

  // Empty means "use the emoji"; the old default path was never shipped.
  let imageUrl = '';
  let cloudinaryId = null;
  if (file) {
    const uploaded = await uploadService.uploadImage(file, { folder: 'tictacarena/avatars' });
    imageUrl = uploaded.url;
    cloudinaryId = uploaded.public_id;
  }

  // Exact match, not ILIKE: underscores in an item name are literal and must
  // not block an unrelated name such as "a_b".
  const existing = await one(
    admin.from('avatars').select('id').eq('name', name).maybeSingle(),
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

module.exports = {
  serverHealth,
  userDetail,
  notifyUser,
  avatars,
  createAvatar,
  deleteAvatar
};
