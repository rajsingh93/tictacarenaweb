'use strict';

const { admin, one, many } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');

async function activeBanners() {
  const rows = await many(
    admin
      .from('banners')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .limit(10),
    'Could not load banners'
  );
  return { banners: rows };
}

async function allBanners() {
  const rows = await many(
    admin.from('banners').select('*').order('sort_order', { ascending: true }),
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
      admin.from('banners').update(patch).eq('id', input.id).select('*').single(),
      'Could not save the banner'
    );
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
      .select('*')
      .single(),
    'Could not create the banner'
  );
  return { message: 'Banner created', banner: row };
}

async function remove(id) {
  const row = await one(
    admin.from('banners').delete().eq('id', id).select('id').maybeSingle(),
    'Could not delete the banner'
  );
  if (!row) throw ApiError.notFound('BANNER_NOT_FOUND', 'Banner not found');
  return { message: 'Banner deleted' };
}

async function publicConfig() {
  const rows = await many(
    admin.from('app_settings').select('key, value').in('key', ['maintenance', 'site', 'chat']),
    'Could not load app settings'
  );
  const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    site: map.site || { name: 'TicTacArena', version: '1.4.2' },
    chat: map.chat || { maxWords: 20, worldHistoryLimit: 50 },
    maintenance: {
      enabled: Boolean(map.maintenance?.enabled),
      message: map.maintenance?.message || '',
      ends_at: map.maintenance?.ends_at || null
    }
  };
}

module.exports = { activeBanners, allBanners, save, remove, publicConfig };
