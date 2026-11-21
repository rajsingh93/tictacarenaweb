'use strict';

const { admin, one, many } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');

let cachedActiveBanners = null;
let activeBannersExpires = 0;
let activeBannersPromise = null;
const BANNERS_CACHE_TTL = 60 * 1000;

let cachedPublicConfig = null;
let publicConfigExpires = 0;
let publicConfigPromise = null;
const CONFIG_CACHE_TTL = 60 * 1000;

function invalidateBannerCache() {
  cachedActiveBanners = null;
  activeBannersExpires = 0;
  activeBannersPromise = null;
}

function invalidateConfigCache() {
  cachedPublicConfig = null;
  publicConfigExpires = 0;
  publicConfigPromise = null;
}

async function activeBanners() {
  if (cachedActiveBanners && Date.now() < activeBannersExpires) {
    return cachedActiveBanners;
  }
  if (activeBannersPromise) return activeBannersPromise;
  activeBannersPromise = (async () => {
    try {
      const rows = await many(
        admin
          .from('banners')
          .select('id, tag, title, sub, decor_emoji, sort_order')
          .eq('is_active', true)
          .order('sort_order', { ascending: true })
          .limit(10),
        'Could not load banners'
      );
      cachedActiveBanners = { banners: rows };
      activeBannersExpires = Date.now() + BANNERS_CACHE_TTL;
      return cachedActiveBanners;
    } finally {
      activeBannersPromise = null;
    }
  })();
  return activeBannersPromise;
}

async function allBanners() {
  const rows = await many(
    admin.from('banners').select('id, tag, title, sub, decor_emoji, is_active, sort_order, created_at').order('sort_order', { ascending: true }),
    'Could not load banners'
  );
  return { banners: rows };
}

async function save(input) {
  const patch = {
    tag: input.tag,
    title: input.title,
    sub: input.sub,
    decor_emoji: input.decor_emoji,
    is_active: input.is_active
  };
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) delete patch[key];
  }

  if (input.id) {
    const existing = await one(
      admin.from('banners').select('id').eq('id', input.id).maybeSingle(),
      'Could not load the banner'
    );
    if (!existing) throw ApiError.notFound('BANNER_NOT_FOUND', 'Banner not found');
    const row = await one(
      admin.from('banners').update(patch).eq('id', input.id).select('id, tag, title, sub, decor_emoji, is_active, sort_order').single(),
      'Could not save the banner'
    );
    invalidateBannerCache();
    return { message: 'Banner updated', banner: row };
  }

  if (!patch.title) throw ApiError.badRequest('TITLE_REQUIRED', 'Banner title is required');
  const max = await one(
    admin.from('banners').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle(),
    'Could not load banners'
  );
  const row = await one(
    admin
      .from('banners')
      .insert({
        tag: patch.tag || 'New',
        title: patch.title,
        sub: patch.sub || '',
        decor_emoji: patch.decor_emoji || '✨',
        is_active: patch.is_active !== false,
        sort_order: (max?.sort_order || 0) + 1
      })
      .select('id, tag, title, sub, decor_emoji, is_active, sort_order')
      .single(),
    'Could not create the banner'
  );
  invalidateBannerCache();
  return { message: 'Banner created', banner: row };
}

async function remove(id) {
  const row = await one(
    admin.from('banners').delete().eq('id', id).select('id').maybeSingle(),
    'Could not delete the banner'
  );
  if (!row) throw ApiError.notFound('BANNER_NOT_FOUND', 'Banner not found');
  invalidateBannerCache();
  return { message: 'Banner deleted' };
}

async function publicConfig() {
  if (cachedPublicConfig && Date.now() < publicConfigExpires) {
    return cachedPublicConfig;
  }
  if (publicConfigPromise) return publicConfigPromise;
  publicConfigPromise = (async () => {
    try {
      const rows = await many(
        admin.from('app_settings').select('key, value').in('key', ['maintenance', 'site', 'chat']),
        'Could not load app settings'
      );
      const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
      cachedPublicConfig = {
        site: map.site || { name: 'TicTacArena', version: '1.4.2' },
        chat: map.chat || { maxWords: 20, worldHistoryLimit: 50 },
        maintenance: {
          enabled: Boolean(map.maintenance?.enabled),
          message: map.maintenance?.message || '',
          ends_at: map.maintenance?.ends_at || null
        }
      };
      publicConfigExpires = Date.now() + CONFIG_CACHE_TTL;
      return cachedPublicConfig;
    } finally {
      publicConfigPromise = null;
    }
  })();
  return publicConfigPromise;
}

module.exports = { activeBanners, allBanners, save, remove, publicConfig, invalidateBannerCache, invalidateConfigCache };
