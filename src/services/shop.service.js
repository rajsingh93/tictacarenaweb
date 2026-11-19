'use strict';

const { admin, one, many, rpc } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { publicUser, equippedItem } = require('../utils/mappers');

async function listItems(user, type) {
  let query = admin
    .from('avatars')
    .select('*')
    .eq('is_active', true)
    .order('price', { ascending: false })
    .order('id', { ascending: true });
  if (type && type !== 'all') query = query.eq('type', type);

  const [items, owned] = await Promise.all([
    many(query, 'Could not load shop items'),
    many(
      admin.from('purchased_avatars').select('avatar_id, equipped').eq('user_id', user.id),
      'Could not load your items'
    )
  ]);

  const ownedMap = new Map(owned.map((row) => [String(row.avatar_id), row]));
  return {
    items: items.map((item) => {
      const purchase = ownedMap.get(String(item.id));
      return {
        ...item,
        owned: Boolean(purchase),
        equipped: Boolean(purchase?.equipped)
      };
    })
  };
}

async function owned(user) {
  const rows = await many(
    admin
      .from('purchased_avatars')
      .select('equipped, purchased_at, avatars(*)')
      .eq('user_id', user.id)
      .order('purchased_at', { ascending: false }),
    'Could not load your vault'
  );
  return { items: rows.map(equippedItem).filter((item) => item.id) };
}

async function buy(user, itemId) {
  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('INVALID_ITEM', 'Invalid shop item');
  const result = await rpc('purchase_item', { p_user_id: user.id, p_avatar_id: id }, 'Could not buy that item');
  return {
    message: result?.message || 'Item purchased',
    coins: result?.coins,
    item: result?.item
  };
}

async function equip(user, itemId) {
  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('INVALID_ITEM', 'Invalid shop item');
  const result = await rpc('equip_item', { p_user_id: user.id, p_avatar_id: id }, 'Could not equip that item');
  const refreshed = await one(
    admin.from('users').select('*').eq('id', user.id).single(),
    'Could not refresh your account'
  );
  return {
    message: result?.message || 'Item equipped',
    item: result?.item,
    user: publicUser(refreshed, { includePrivate: true })
  };
}

module.exports = { listItems, owned, buy, equip };
