'use strict';

const { admin, many, rpc } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { equippedItem, shopItem } = require('../utils/mappers');

let activeAvatarsCache = null;
let activeAvatarsExpiry = 0;
const SHOP_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function invalidateShopCache() {
  activeAvatarsCache = null;
  activeAvatarsExpiry = 0;
}

async function getActiveAvatars() {
  const now = Date.now();
  if (activeAvatarsCache && now < activeAvatarsExpiry) {
    return activeAvatarsCache;
  }
  const rows = await many(
    admin
      .from('avatars')
      .select('id, name, type, price, image_url, emoji, rarity')
      .eq('is_active', true)
      .order('price', { ascending: false })
      .order('id', { ascending: true }),
    'Could not load shop items'
  );
  activeAvatarsCache = rows;
  activeAvatarsExpiry = now + SHOP_CACHE_TTL;
  return rows;
}

async function listItems(user, type) {
  const allActive = await getActiveAvatars();
  const filtered = type && type !== 'all' ? allActive.filter((i) => i.type === type) : allActive;

  const ownedRows = await many(
    admin.from('purchased_avatars').select('avatar_id, equipped').eq('user_id', user.id),
    'Could not load your items'
  );

  const ownedMap = new Map(ownedRows.map((row) => [String(row.avatar_id), row]));
  return {
    items: filtered.map((item) => shopItem(item, ownedMap.get(String(item.id))))
  };
}

async function owned(user) {
  const rows = await many(
    admin
      .from('purchased_avatars')
      .select('equipped, avatars(id, name, type, image_url, emoji, rarity)')
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
    item: result?.item ? equippedItem({ avatars: result.item, equipped: true }) : null
  };
}

async function equip(user, itemId) {
  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('INVALID_ITEM', 'Invalid shop item');
  const result = await rpc('equip_item', { p_user_id: user.id, p_avatar_id: id }, 'Could not equip that item');
  return {
    message: result?.message || 'Item equipped',
    item: result?.item ? equippedItem({ avatars: result.item, equipped: true }) : null
  };
}

module.exports = { listItems, owned, buy, equip, invalidateShopCache };
