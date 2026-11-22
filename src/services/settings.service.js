'use strict';

const { admin, one } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { GAME_REWARDS } = require('../config/constants');
const audit = require('./audit.service');

/**
 * Cached platform configuration.
 *
 * `app_settings` is small, read on hot paths (match settlement, SEO, flags)
 * and written rarely, so a short in-process cache removes almost every read
 * without making a saved setting go stale for long.
 */
const TTL_MS = 15_000;
const CACHE = new Map();

const DEFAULTS = Object.freeze({
  game: {
    rewards: GAME_REWARDS,
    ranks: [
      { minLevel: 1, title: 'Bronze' },
      { minLevel: 10, title: 'Silver' },
      { minLevel: 20, title: 'Gold' },
      { minLevel: 30, title: 'Platinum' },
      { minLevel: 40, title: 'Diamond' }
    ],
    turnSeconds: 30,
    disconnectForfeitSeconds: 10,
    matchmakingMaxSeconds: 300,
    chatMaxWords: 20
  },
  seo: {
    siteTitle: 'TicTacArena',
    titleTemplate: '%s - TicTacArena',
    description:
      'Fast, competitive multiplayer tic-tac-toe. Play live matches, climb the ranked ladder, complete achievements and earn rewards.',
    keywords: 'tic tac toe, multiplayer game, online games, ranked ladder, tournaments',
    ogImage: '',
    faviconUrl: '/assets/favicon/favicon.svg',
    twitterHandle: '',
    canonicalBase: '',
    googleVerification: '',
    bingVerification: '',
    robotsExtra: '',
    indexingEnabled: true
  },
  branding: {
    brandName: 'TicTacArena',
    tagline: 'Play. Compete. Climb.',
    logoUrl: '',
    accentColor: '#4169E1',
    supportEmail: '',
    discordUrl: '',
    xUrl: '',
    instagramUrl: '',
    youtubeUrl: ''
  },
  retention: {
    adminLoginDays: 180,
    auditDays: 730,
    errorDays: 90,
    notificationDays: 365,
    chatDays: 365
  },
  moderation: { bannedWords: [], autoMuteEnabled: false, linkBlocking: true },
  version: { current: '2.0.0', minimumClient: '2.0.0', releaseNotes: '', releasedAt: null },
  maintenance: { enabled: false, message: '', ends_at: null },
  chat: { worldChatEnabled: true, maxWords: 20, slowModeSeconds: 0 }
});

const CLONE = (value) => JSON.parse(JSON.stringify(value));

function invalidate(key) {
  if (key) CACHE.delete(String(key));
  else CACHE.clear();
}

async function readRow(key) {
  return one(
    admin.from('app_settings').select('key, value, updated_at').eq('key', key).maybeSingle(),
    'Could not load platform settings'
  );
}

async function get(key, fallback = null) {
  const cacheKey = String(key);
  const cached = CACHE.get(cacheKey);
  if (cached && cached.expires > Date.now()) return CLONE(cached.value);

  let row = null;
  try {
    row = await readRow(cacheKey);
  } catch (error) {
    if (fallback !== null) return CLONE(fallback);
    throw error;
  }
  const value = row?.value ?? (fallback !== null ? fallback : DEFAULTS[cacheKey] ?? null);
  CACHE.set(cacheKey, { value: CLONE(value), expires: Date.now() + TTL_MS });
  while (CACHE.size > 50) CACHE.delete(CACHE.keys().next().value);
  return CLONE(value);
}

async function getMany(keys) {
  const values = {};
  await Promise.all(
    keys.map(async (key) => {
      values[key] = await get(key, DEFAULTS[key] ?? null);
    })
  );
  return values;
}

function boundedNumber(value, { min = 0, max = 1_000_000, fallback = 0, integer = true } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const bounded = Math.min(Math.max(number, min), max);
  return integer ? Math.round(bounded) : bounded;
}

function sanitizeGame(input = {}) {
  const base = CLONE(DEFAULTS.game);
  const rewards = {};
  for (const mode of ['ranked', 'friendly', 'training']) {
    rewards[mode] = {};
    for (const outcome of ['win', 'loss', 'draw']) {
      const fallback = base.rewards[mode][outcome];
      const source = input?.rewards?.[mode]?.[outcome] || {};
      rewards[mode][outcome] = {
        xp: boundedNumber(source.xp, { max: 100000, fallback: fallback.xp }),
        coins: boundedNumber(source.coins, { max: 1000000, fallback: fallback.coins }),
        score: boundedNumber(source.score, { max: 1000000, fallback: fallback.score })
      };
    }
  }

  const ranks = Array.isArray(input.ranks)
    ? input.ranks
        .map((rank) => ({
          minLevel: boundedNumber(rank?.minLevel, { min: 1, max: 10000, fallback: 1 }),
          title: String(rank?.title || '').trim().slice(0, 24)
        }))
        .filter((rank) => rank.title)
        .sort((a, b) => a.minLevel - b.minLevel)
        .slice(0, 20)
    : base.ranks;

  return {
    rewards,
    ranks: ranks.length ? ranks : base.ranks,
    turnSeconds: boundedNumber(input.turnSeconds, { min: 5, max: 300, fallback: base.turnSeconds }),
    disconnectForfeitSeconds: boundedNumber(input.disconnectForfeitSeconds, {
      min: 3,
      max: 300,
      fallback: base.disconnectForfeitSeconds
    }),
    matchmakingMaxSeconds: boundedNumber(input.matchmakingMaxSeconds, {
      min: 10,
      max: 3600,
      fallback: base.matchmakingMaxSeconds
    }),
    chatMaxWords: boundedNumber(input.chatMaxWords, { min: 1, max: 200, fallback: base.chatMaxWords })
  };
}

function sanitizeSeo(input = {}) {
  const base = DEFAULTS.seo;
  const text = (value, max) => String(value || '').trim().slice(0, max);
  const imageUrl = (value) => {
    const url = text(value, 1000);
    if (!url) return '';
    if (/^https:\/\//i.test(url)) return url;
    if (url.startsWith('/') && !url.startsWith('//')) return url;
    return '';
  };
  const canonical = text(input.canonicalBase, 300).replace(/\/$/, '');
  return {
    siteTitle: text(input.siteTitle || base.siteTitle, 80),
    titleTemplate: text(input.titleTemplate || base.titleTemplate, 120),
    description: text(input.description || base.description, 320),
    keywords: text(input.keywords ?? base.keywords, 500),
    ogImage: imageUrl(input.ogImage),
    faviconUrl: imageUrl(input.faviconUrl || base.faviconUrl),
    twitterHandle: text(input.twitterHandle, 60),
    canonicalBase: /^https?:\/\/\S+$/i.test(canonical) ? canonical : '',
    googleVerification: text(input.googleVerification, 200),
    bingVerification: text(input.bingVerification, 200),
    robotsExtra: text(input.robotsExtra, 1000),
    indexingEnabled: input.indexingEnabled === undefined ? true : Boolean(input.indexingEnabled)
  };
}

function sanitizeBranding(input = {}) {
  const base = DEFAULTS.branding;
  const text = (value, max) => String(value || '').trim().slice(0, max);
  const color = text(input.accentColor, 20);
  return {
    brandName: text(input.brandName || base.brandName, 80),
    tagline: text(input.tagline || base.tagline, 160),
    logoUrl: text(input.logoUrl, 1000),
    accentColor: /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : base.accentColor,
    supportEmail: text(input.supportEmail, 254),
    discordUrl: text(input.discordUrl, 500),
    xUrl: text(input.xUrl, 500),
    instagramUrl: text(input.instagramUrl, 500),
    youtubeUrl: text(input.youtubeUrl, 500)
  };
}

function sanitizeRetention(input = {}) {
  return {
    adminLoginDays: boundedNumber(input.adminLoginDays, { min: 7, max: 3650, fallback: 180 }),
    auditDays: boundedNumber(input.auditDays, { min: 30, max: 3650, fallback: 730 }),
    errorDays: boundedNumber(input.errorDays, { min: 7, max: 3650, fallback: 90 }),
    notificationDays: boundedNumber(input.notificationDays, { min: 7, max: 3650, fallback: 365 }),
    chatDays: boundedNumber(input.chatDays, { min: 7, max: 3650, fallback: 365 })
  };
}

function sanitizeModeration(input = {}) {
  const words = Array.isArray(input.bannedWords)
    ? [...new Set(input.bannedWords.map((word) => String(word || '').trim().toLowerCase()).filter(Boolean))].slice(0, 500)
    : [];
  return {
    bannedWords: words.map((word) => word.slice(0, 40)),
    autoMuteEnabled: Boolean(input.autoMuteEnabled),
    linkBlocking: input.linkBlocking === undefined ? true : Boolean(input.linkBlocking)
  };
}

function sanitizeVersion(input = {}) {
  const releasedAt = input.releasedAt ? new Date(input.releasedAt) : null;
  return {
    current: String(input.current || DEFAULTS.version.current).trim().slice(0, 40),
    minimumClient: String(input.minimumClient || DEFAULTS.version.minimumClient).trim().slice(0, 40),
    releaseNotes: String(input.releaseNotes || '').trim().slice(0, 8000),
    releasedAt: releasedAt && !Number.isNaN(releasedAt.getTime()) ? releasedAt.toISOString() : null
  };
}

function sanitizeMaintenance(input = {}) {
  const endsAt = input.ends_at ? new Date(input.ends_at) : null;
  return {
    enabled: Boolean(input.enabled),
    message: String(input.message || '').trim().slice(0, 500),
    ends_at: Boolean(input.enabled) && endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt.toISOString() : null
  };
}

function sanitizeChat(input = {}) {
  return {
    worldChatEnabled: input.worldChatEnabled === undefined ? true : Boolean(input.worldChatEnabled),
    maxWords: boundedNumber(input.maxWords, { min: 1, max: 200, fallback: 20 }),
    slowModeSeconds: boundedNumber(input.slowModeSeconds, { min: 0, max: 3600, fallback: 0 })
  };
}

const SANITIZERS = {
  game: sanitizeGame,
  seo: sanitizeSeo,
  branding: sanitizeBranding,
  retention: sanitizeRetention,
  moderation: sanitizeModeration,
  version: sanitizeVersion,
  maintenance: sanitizeMaintenance,
  chat: sanitizeChat
};

function sanitize(key, value) {
  const sanitizer = SANITIZERS[key];
  if (!sanitizer) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw ApiError.badRequest('INVALID_SETTING', 'Setting values must be objects');
    }
    return value;
  }
  return sanitizer(value);
}

async function set(actor, key, value, { req = null, merge = false } = {}) {
  const cleanKey = String(key || '').trim();
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(cleanKey)) {
    throw ApiError.badRequest('INVALID_SETTING_KEY', 'Choose a valid setting key');
  }

  let next = sanitize(cleanKey, value || {});
  if (merge) {
    const existing = await get(cleanKey, DEFAULTS[cleanKey] || {});
    next = sanitize(cleanKey, { ...existing, ...next });
  }

  const row = await one(
    admin
      .from('app_settings')
      .upsert({ key: cleanKey, value: next }, { onConflict: 'key' })
      .select('key, value, updated_at')
      .single(),
    'Could not save platform settings'
  );
  invalidate(cleanKey);
  await audit.record(actor, 'settings.update', {
    targetType: 'setting',
    targetId: cleanKey,
    details: { keys: Object.keys(next) },
    req
  });
  return row;
}

/* ------------------------------------------------------------
   Typed accessors used by gameplay and public pages
   ------------------------------------------------------------ */

async function game() {
  return get('game', DEFAULTS.game);
}

async function rewards(mode, outcome) {
  const config = await game();
  const table = config?.rewards?.[mode] || DEFAULTS.game.rewards[mode] || DEFAULTS.game.rewards.ranked;
  const reward = table?.[outcome] || DEFAULTS.game.rewards.ranked[outcome];
  return {
    xp: boundedNumber(reward?.xp, { max: 100000, fallback: 0 }),
    coins: boundedNumber(reward?.coins, { max: 1000000, fallback: 0 }),
    score: boundedNumber(reward?.score, { max: 1000000, fallback: 0 })
  };
}

async function rankTitle(level) {
  const config = await game();
  const ranks = Array.isArray(config?.ranks) ? config.ranks : DEFAULTS.game.ranks;
  let title = 'Bronze';
  for (const rank of ranks) {
    if (Number(level) >= Number(rank.minLevel)) title = rank.title;
  }
  return title;
}

async function seo() {
  return get('seo', DEFAULTS.seo);
}

async function branding() {
  return get('branding', DEFAULTS.branding);
}

async function retention() {
  return get('retention', DEFAULTS.retention);
}

async function moderation() {
  return get('moderation', DEFAULTS.moderation);
}

async function version() {
  return get('version', DEFAULTS.version);
}

async function maintenance() {
  return get('maintenance', DEFAULTS.maintenance);
}

async function chat() {
  return get('chat', DEFAULTS.chat);
}

module.exports = {
  DEFAULTS,
  TTL_MS,
  invalidate,
  get,
  getMany,
  set,
  sanitize,
  game,
  rewards,
  rankTitle,
  seo,
  branding,
  retention,
  moderation,
  version,
  maintenance,
  chat,
  sanitizers: SANITIZERS
};
