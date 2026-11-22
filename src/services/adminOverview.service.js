'use strict';

const { admin, rpc, count, many } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const audit = require('./audit.service');
const settingsService = require('./settings.service');

const MAX_RANGE_DAYS = 370;

function parseDate(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw ApiError.badRequest('INVALID_DATE', 'Enter a valid date');
  return date;
}

function range(input = {}) {
  const end = parseDate(input.end, new Date());
  const days = Math.min(Math.max(Number(input.days) || 30, 1), MAX_RANGE_DAYS);
  const start = parseDate(input.start, new Date(end.getTime() - (days - 1) * 86400000));
  if (end <= start) throw ApiError.badRequest('INVALID_RANGE', 'The end date must be after the start date');
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 86400000) {
    throw ApiError.badRequest('RANGE_TOO_LARGE', 'Choose a date range of one year or less');
  }
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    days: Math.max(1, Math.ceil((end - start) / 86400000)),
    label: `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`
  };
}

async function overview(input = {}, { live = null } = {}) {
  const window = range(input);
  const [data, economy, admins, recentActivity, version] = await Promise.all([
    rpc('get_admin_overview', { p_start: window.start, p_end: window.end }, 'Could not load dashboard analytics'),
    rpc(
      'get_admin_economy_summary',
      { p_start: window.start, p_end: window.end },
      'Could not load economy analytics'
    ),
    count(
      admin
        .from('admin_security')
        .select('user_id', { count: 'exact', head: true })
        .eq('is_active', true)
    ).catch(() => 0),
    audit.recent(6).catch(() => []),
    settingsService.version().catch(() => null)
  ]);

  return {
    range: window,
    summary: data?.summary || {},
    series: data?.series || { labels: [], signups: [], matches: [], revenueCents: [], messages: [], activeUsers: [] },
    modes: data?.modes || {},
    topupStatuses: data?.topupStatuses || {},
    economy: economy
      ? {
          circulatingCoins: economy.circulatingCoins,
          totalEarned: economy.totalEarned,
          totalSpent: economy.totalSpent,
          transactionCount: economy.transactionCount,
          revenueCents: economy.revenueCents,
          byType: economy.byType || [],
          topHolders: economy.topHolders || []
        }
      : null,
    live: live || null,
    admins,
    recentActivity,
    version,
    generatedAt: new Date().toISOString()
  };
}

async function analytics(input = {}) {
  const window = range(input);
  const [data, economy, topPlayers, modeRows, topupRows] = await Promise.all([
    rpc('get_admin_overview', { p_start: window.start, p_end: window.end }, 'Could not load analytics'),
    rpc(
      'get_admin_economy_summary',
      { p_start: window.start, p_end: window.end },
      'Could not load economy analytics'
    ),
    many(
      admin
        .from('users')
        .select('id, username, avatar_emoji, avatar_url, level, rank_title, score, wins, losses, draws, coins, is_online')
        .eq('is_bot', false)
        .order('score', { ascending: false })
        .limit(10),
      'Could not load top players'
    ).catch(() => []),
    many(
      admin
        .from('matches')
        .select('mode')
        .gte('created_at', window.start)
        .lt('created_at', window.end)
        .limit(50000),
      'Could not load match modes'
    ).catch(() => []),
    many(
      admin
        .from('topup_orders')
        .select('status, price_cents')
        .gte('created_at', window.start)
        .lt('created_at', window.end)
        .limit(50000),
      'Could not load top-up orders'
    ).catch(() => [])
  ]);

  const modes = { ranked: 0, friendly: 0, training: 0 };
  for (const row of modeRows) if (modes[row.mode] !== undefined) modes[row.mode] += 1;
  const topupRevenue = topupRows
    .filter((row) => row.status === 'completed')
    .reduce((sum, row) => sum + Number(row.price_cents || 0), 0);

  return {
    range: window,
    summary: data?.summary || {},
    series: data?.series || {},
    modes,
    topupStatuses: data?.topupStatuses || {},
    economy: economy || null,
    topPlayers,
    topupRevenueCents: topupRevenue,
    generatedAt: new Date().toISOString()
  };
}

module.exports = { range, overview, analytics };
