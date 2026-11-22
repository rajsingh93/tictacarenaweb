'use strict';

/**
 * TicTacArena — Admin Control Center: core platform operations.
 *
 * Every function here is server-side only. The route layer enforces the
 * granular permission for the action before a controller reaches this file,
 * so hiding a control in the browser is never the security boundary.
 *
 * Payloads are deliberately narrow: list endpoints return only the columns a
 * table renders, and every list is paginated in SQL (PostgREST range).
 */

const { admin, one, many, rpc, count } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { cleanText, cleanMultiline } = require('../utils/sanitize');
const adminOverview = require('./adminOverview.service');
const adminService = require('./admin.service');
const adminSecurity = require('./adminSecurity.service');
const audit = require('./audit.service');
const notificationService = require('./notification.service');
const leaderboardService = require('./leaderboard.service');

const MAX_PAGE = 100;
const USER_FILTERS = new Set(['all', 'online', 'banned', 'suspended', 'admins', 'verified', 'unverified', 'inactive']);
const MATCH_FILTERS = new Set(['all', 'settled', 'voided', 'disputed']);
const MATCH_MODES = new Set(['ranked', 'friendly', 'training']);
const TOURNAMENT_STATUSES = new Set(['draft', 'open', 'live', 'completed', 'cancelled']);
const TOURNAMENT_FORMATS = new Set(['single_elimination', 'round_robin', 'swiss']);
const SORTS = {
  newest: ['created_at', false],
  oldest: ['created_at', true],
  coins: ['coins', false],
  level: ['level', false],
  score: ['score', false],
  wins: ['wins', false],
  seen: ['last_seen', false],
  username: ['username', true]
};

const USER_LIST_COLUMNS =
  'id, username, email, avatar_url, avatar_emoji, level, xp, coins, wins, losses, draws, score, rank_title, is_admin, is_banned, banned_until, ban_reason, is_online, is_verified, is_bot, created_at, last_seen';

const MATCH_COLUMNS =
  'id, game_key, mode, result, status, duration_seconds, created_at, void_reason, voided_at, ' +
  'player1:users!matches_player1_id_fkey(id, username, avatar_emoji, avatar_url, level, rank_title), ' +
  'player2:users!matches_player2_id_fkey(id, username, avatar_emoji, avatar_url, level, rank_title)';

function toId(value, label = 'identifier') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest('INVALID_ID', `Choose a valid ${label}`);
  }
  return id;
}

function listParams(query = {}, fallbackLimit = 25) {
  const limit = Math.min(Math.max(Number(query.limit) || fallbackLimit, 1), MAX_PAGE);
  const page = Math.min(Math.max(Number(query.page) || 1, 1), 100000);
  return { limit, page, from: (page - 1) * limit, to: page * limit - 1 };
}

function searchTerm(value, max = 60) {
  return cleanText(value, max).replace(/[(),%*]/g, '').trim();
}

function dateRange(query = {}) {
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;
  if (from && Number.isNaN(from.getTime())) throw ApiError.badRequest('INVALID_DATE', 'Enter a valid start date');
  if (to && Number.isNaN(to.getTime())) throw ApiError.badRequest('INVALID_DATE', 'Enter a valid end date');
  return {
    from: from ? from.toISOString() : null,
    to: to ? new Date(to.getTime() + 86400000 - 1).toISOString() : null
  };
}

function pageResult(rows, total, params) {
  return {
    rows,
    total: Number(total) || 0,
    page: params.page,
    limit: params.limit,
    pages: Math.max(1, Math.ceil((Number(total) || 0) / params.limit))
  };
}

function safeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    avatar_url: row.avatar_url,
    avatar_emoji: row.avatar_emoji,
    level: row.level,
    coins: row.coins,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    score: row.score,
    rank_title: row.rank_title,
    is_admin: Boolean(row.is_admin),
    is_banned: Boolean(row.is_banned),
    is_verified: Boolean(row.is_verified),
    is_online: Boolean(row.is_online),
    banned_until: row.banned_until || null,
    ban_reason: row.ban_reason || null,
    created_at: row.created_at,
    last_seen: row.last_seen
  };
}

async function notify(userId, payload) {
  try {
    await notificationService.create({ userId, ...payload });
  } catch (_) {
    /* an action must never fail because its courtesy notification failed */
  }
}

/* ------------------------------------------------------------
   Dashboard and analytics
   ------------------------------------------------------------ */

async function dashboard(input = {}) {
  const window = adminOverview.range(input);
  const [overview, recentUsers, alerts, flags, campaigns, live] = await Promise.all([
    adminOverview.overview(input),
    many(
      admin
        .from('users')
        .select('id, username, email, avatar_emoji, avatar_url, level, is_verified, created_at')
        .eq('is_bot', false)
        .order('created_at', { ascending: false })
        .limit(6),
      'Could not load recent registrations'
    ).catch(() => []),
    alertCounts().catch(() => ({})),
    one(
      admin.from('feature_flags').select('key, enabled').eq('enabled', true).limit(50),
      'Could not load feature flags'
    ).catch(() => []),
    one(
      admin
        .from('notification_campaigns')
        .select('id, name, status, scheduled_at, recipient_count')
        .in('status', ['scheduled', 'sending'])
        .order('scheduled_at', { ascending: true })
        .limit(5),
      'Could not load campaigns'
    ).catch(() => []),
    liveState()
  ]);

  const summary = overview.summary || {};
  const active = Number(summary.activeUsers) || 0;
  const totalUsers = Number(summary.totalUsers) || 0;

  return {
    ...overview,
    summary: {
      ...summary,
      retentionRate: totalUsers ? Math.round((active / totalUsers) * 1000) / 10 : 0,
      matchesPerActiveUser: active ? Math.round((Number(summary.matches) || 0) / active * 10) / 10 : 0
    },
    recentUsers,
    alerts,
    enabledFlags: Array.isArray(flags) ? flags : [],
    campaigns: Array.isArray(campaigns) ? campaigns : [],
    live,
    generatedAt: new Date().toISOString()
  };
}

async function analytics(input = {}) {
  const data = await adminOverview.analytics(input);
  const series = data.series || {};
  const labels = Array.isArray(series.labels) ? series.labels : [];
  const bucket = (key, valueKey) => {
    const map = new Map();
    labels.forEach((label, index) => {
      const date = new Date(`${label}T00:00:00Z`);
      if (Number.isNaN(date.getTime())) return;
      const bucketKey = key === 'week'
        ? `${date.getUTCFullYear()}-W${String(Math.ceil(((date - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7)).padStart(2, '0')}`
        : `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
      map.set(bucketKey, (map.get(bucketKey) || 0) + (Number(series[valueKey]?.[index]) || 0));
    });
    return [...map.entries()].map(([label, value]) => ({ label, value }));
  };

  const summary = data.summary || {};
  const totalUsers = Number(summary.totalUsers) || 0;
  const activeUsers = Number(summary.activeUsers) || 0;
  return {
    ...data,
    weekly: {
      signups: bucket('week', 'signups'),
      matches: bucket('week', 'matches')
    },
    monthly: {
      signups: bucket('month', 'signups'),
      matches: bucket('month', 'matches')
    },
    engagement: {
      activeRate: totalUsers ? Math.round((activeUsers / totalUsers) * 1000) / 10 : 0,
      matchesPerActiveUser: activeUsers ? Math.round((Number(summary.matches) || 0) / activeUsers * 10) / 10 : 0,
      messagesPerActiveUser: activeUsers ? Math.round((Number(summary.chatMessages) + Number(summary.worldMessages)) / activeUsers * 10) / 10 : 0
    }
  };
}

async function alertCounts() {
  const [tickets, disputes, errors, pendingTopups, failedCampaigns, reports] = await Promise.all([
    count(admin.from('support_tickets').select('id', { count: 'exact', head: true }).in('status', ['open', 'in_progress'])).catch(() => 0),
    count(admin.from('match_disputes').select('id', { count: 'exact', head: true }).in('status', ['open', 'reviewing'])).catch(() => 0),
    count(admin.from('error_logs').select('id', { count: 'exact', head: true }).eq('resolved', false)).catch(() => 0),
    count(admin.from('topup_orders').select('id', { count: 'exact', head: true }).eq('status', 'pending')).catch(() => 0),
    count(admin.from('notification_campaigns').select('id', { count: 'exact', head: true }).eq('status', 'failed')).catch(() => 0),
    count(admin.from('content_reports').select('id', { count: 'exact', head: true }).in('status', ['open', 'reviewing'])).catch(() => 0)
  ]);
  return {
    openTickets: tickets,
    openDisputes: disputes,
    unresolvedErrors: errors,
    pendingTopups,
    failedCampaigns,
    openReports: reports
  };
}

async function liveState() {
  let socketState = { onlineUsers: 0, activeGames: 0, playersInQueue: 0 };
  try {
    const game = require('../socket/game');
    const state = game.activeState();
    socketState = {
      onlineUsers: Number(state?.onlineUsers) || 0,
      activeGames: Number(state?.activeGames) || 0,
      playersInQueue: Number(state?.matchmakingQueue) || 0
    };
  } catch (_) {
    /* realtime state is optional when the socket layer is not running */
  }
  const [onlineInDb, liveGames] = await Promise.all([
    count(admin.from('users').select('id', { count: 'exact', head: true }).eq('is_online', true).eq('is_bot', false)).catch(() => 0),
    Promise.resolve(safeLiveGames())
  ]);
  return {
    ...socketState,
    onlineInDb,
    liveGames: liveGames.length,
    games: liveGames.slice(0, 8)
  };
}

function safeLiveGames() {
  try {
    const game = require('../socket/game');
    return game.liveGames().map((entry) => ({
      id: entry.id,
      mode: entry.mode,
      startedAt: entry.startedAt,
      turn: entry.currentTurn,
      durationSeconds: entry.durationSeconds,
      board: entry.board,
      players: [entry.players?.X, entry.players?.O].filter(Boolean)
    }));
  } catch (_) {
    return [];
  }
}

/* ------------------------------------------------------------
   Users
   ------------------------------------------------------------ */

async function listUsers(query = {}) {
  const params = listParams(query);
  const status = USER_FILTERS.has(query.status) ? query.status : 'all';
  const term = searchTerm(query.q);
  const sort = SORTS[query.sort] || SORTS.newest;
  const range = dateRange(query);

  let base = admin.from('users').select(USER_LIST_COLUMNS, { count: 'exact' }).eq('is_bot', false);
  if (term) base = base.or(`username.ilike.%${term}%,email.ilike.%${term}%`);
  if (status === 'online') base = base.eq('is_online', true);
  if (status === 'banned') base = base.eq('is_banned', true);
  if (status === 'suspended') {
    base = base.eq('is_banned', true).gt('banned_until', new Date().toISOString());
  }
  if (status === 'admins') base = base.eq('is_admin', true);
  if (status === 'verified') base = base.eq('is_verified', true);
  if (status === 'unverified') base = base.eq('is_verified', false);
  if (status === 'inactive') {
    base = base.lt('last_seen', new Date(Date.now() - 30 * 86400000).toISOString());
  }
  if (range.from) base = base.gte('created_at', range.from);
  if (range.to) base = base.lte('created_at', range.to);

  const { data, error, count: total } = await base
    .order(sort[0], { ascending: sort[1] })
    .order('id', { ascending: false })
    .range(params.from, params.to);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load players');

  const result = pageResult((data || []).map(safeUser), total, params);
  if (query.counts === '1') result.counts = await userCounts();
  return result;
}

async function userCounts() {
  const [all, online, banned, verified, admins, suspended] = await Promise.all([
    count(admin.from('users').select('id', { count: 'exact', head: true }).eq('is_bot', false)).catch(() => 0),
    count(admin.from('users').select('id', { count: 'exact', head: true }).eq('is_bot', false).eq('is_online', true)).catch(() => 0),
    count(admin.from('users').select('id', { count: 'exact', head: true }).eq('is_bot', false).eq('is_banned', true)).catch(() => 0),
    count(admin.from('users').select('id', { count: 'exact', head: true }).eq('is_bot', false).eq('is_verified', true)).catch(() => 0),
    count(admin.from('users').select('id', { count: 'exact', head: true }).eq('is_admin', true)).catch(() => 0),
    count(
      admin
        .from('users')
        .select('id', { count: 'exact', head: true })
        .eq('is_banned', true)
        .gt('banned_until', new Date().toISOString())
    ).catch(() => 0)
  ]);
  return { all, online, banned, verified, admins, suspended };
}

async function userDetail(id) {
  const userId = toId(id, 'player');
  const base = await adminService.userDetail(userId);
  const [security, verification, restrictions, loginEvents, reports, coinStats, activeGames] = await Promise.all([
    one(admin.from('admin_security').select('role, is_active, totp_enabled, require_2fa').eq('user_id', userId).maybeSingle(), 'Could not load the role').catch(() => null),
    one(admin.from('users').select('is_verified, verification_note').eq('id', userId).maybeSingle(), 'Could not load verification').catch(() => null),
    many(
      admin
        .from('user_restrictions')
        .select('id, type, reason, expires_at, created_at, revoked_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20),
      'Could not load restrictions'
    ).catch(() => []),
    many(
      admin
        .from('admin_login_events')
        .select('id, ip, user_agent, success, reason, risk_level, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20),
      'Could not load login history'
    ).catch(() => []),
    many(
      admin
        .from('content_reports')
        .select('id, target_type, reason, details, status, created_at')
        .eq('target_type', 'user')
        .eq('target_id', String(userId))
        .order('created_at', { ascending: false })
        .limit(10),
      'Could not load reports'
    ).catch(() => []),
    one(
      admin
        .from('coin_transactions')
        .select('amount')
        .eq('user_id', userId)
        .limit(500),
      'Could not load coin history'
    ).catch(() => []),
    Promise.resolve(safeLiveGames().filter((game) => game.players?.some((player) => String(player.id) === String(userId))))
  ]);
  const sessions = security
    ? await adminSecurity.listSessions(userId, { limit: 10 }).catch(() => [])
    : [];

  const amounts = Array.isArray(coinStats) ? coinStats : [];
  return {
    ...base,
    verification: {
      is_verified: Boolean(verification?.is_verified),
      note: verification?.verification_note || null
    },
    security,
    restrictions,
    loginEvents,
    reports,
    sessions,
    activeGames,
    coinSummary: {
      lifetimeEarned: amounts.filter((row) => row.amount > 0).reduce((sum, row) => sum + Number(row.amount), 0),
      lifetimeSpent: Math.abs(amounts.filter((row) => row.amount < 0).reduce((sum, row) => sum + Number(row.amount), 0)),
      sampledTransactions: amounts.length
    }
  };
}

async function updateUser(actor, req, id, patch = {}) {
  const userId = toId(id, 'player');
  const target = await one(
    admin.from('users').select(USER_LIST_COLUMNS).eq('id', userId).maybeSingle(),
    'Could not load that player'
  );
  if (!target) throw ApiError.notFound('USER_NOT_FOUND', 'Player not found');
  if (target.is_bot) throw ApiError.badRequest('BOT_ACCOUNT', 'Bot accounts cannot be edited here');

  const update = {};
  if (patch.username !== undefined) {
    const username = cleanText(patch.username, 20);
    if (!/^[a-zA-Z0-9_ ]{3,20}$/.test(username)) {
      throw ApiError.badRequest('INVALID_USERNAME', 'Usernames are 3–20 letters, numbers, spaces or underscores');
    }
    if (username.toLowerCase() !== String(target.username).toLowerCase()) {
      const existing = await one(
        admin.from('users').select('id').ilike('username', username).maybeSingle(),
        'Could not check the username'
      );
      if (existing) throw ApiError.conflict('USERNAME_TAKEN', 'That username is already in use');
    }
    update.username = username;
  }
  if (patch.bio !== undefined) update.bio = cleanMultiline(patch.bio, 280);
  if (patch.avatar_emoji !== undefined) update.avatar_emoji = cleanText(patch.avatar_emoji, 8) || '👤';
  if (patch.is_verified !== undefined) update.is_verified = Boolean(patch.is_verified);
  if (patch.verification_note !== undefined) update.verification_note = cleanText(patch.verification_note, 300);

  if (!Object.keys(update).length) throw ApiError.badRequest('NO_CHANGES', 'No permitted fields were supplied');

  const row = await one(
    admin.from('users').update(update).eq('id', userId).select(USER_LIST_COLUMNS).single(),
    'Could not update the player'
  );
  if (update.is_verified === true) {
    await notify(userId, {
      type: 'system',
      title: 'Account verified',
      description: 'Your TicTacArena account is now verified. The badge is visible on your profile.'
    });
  }
  await audit.record(actor, 'user.update', {
    targetType: 'user',
    targetId: userId,
    details: { fields: Object.keys(update) },
    req
  });
  return { message: 'Player updated', user: safeUser(row) };
}

async function setBan(actor, req, id, { ban, reason, durationHours } = {}) {
  const userId = toId(id, 'player');
  if (String(actor.id) === String(userId)) throw ApiError.badRequest('CANNOT_BAN_SELF', 'You cannot moderate your own account');
  const target = await one(
    admin.from('users').select('id, username, is_bot, email, is_banned').eq('id', userId).maybeSingle(),
    'Could not load that player'
  );
  if (!target) throw ApiError.notFound('USER_NOT_FOUND', 'Player not found');
  if (target.is_bot) throw ApiError.badRequest('BOT_ACCOUNT', 'Bot accounts cannot be banned');
  if (adminSecurity.isOwnerEmail(target)) {
    throw ApiError.forbidden('OWNER_PROTECTED', 'The site owner account cannot be moderated here');
  }

  const hours = Math.min(Math.max(Number(durationHours) || 0, 0), 24 * 365);
  const update = ban
    ? {
        is_banned: true,
        is_online: false,
        ban_reason: cleanText(reason, 300) || 'Moderated by an administrator',
        banned_by: actor.id,
        banned_until: hours > 0 ? new Date(Date.now() + hours * 3600000).toISOString() : null
      }
    : {
        is_banned: false,
        is_online: false,
        ban_reason: null,
        banned_by: null,
        banned_until: null
      };

  await one(
    admin.from('users').update(update).eq('id', userId).select('id').single(),
    'Could not update the account'
  );
  if (!ban) {
    await notify(userId, {
      type: 'system',
      title: 'Account restored',
      description: 'Your account has been restored. Please follow the arena rules to keep it in good standing.'
    });
  }
  await audit.record(actor, ban ? (hours ? 'user.suspend' : 'user.ban') : 'user.unban', {
    targetType: 'user',
    targetId: userId,
    details: { username: target.username, reason: update.ban_reason, durationHours: hours || null },
    req
  });
  return {
    message: ban ? (hours ? `Player suspended for ${hours} hour${hours === 1 ? '' : 's'}` : 'Player banned') : 'Player unbanned',
    is_banned: Boolean(ban),
    banned_until: update.banned_until
  };
}

async function setVerification(actor, req, id, { verified, note } = {}) {
  const userId = toId(id, 'player');
  const row = await one(
    admin
      .from('users')
      .update({
        is_verified: Boolean(verified),
        verification_note: cleanText(note, 300) || null
      })
      .eq('id', userId)
      .select('id, username, is_verified')
      .maybeSingle(),
    'Could not update verification'
  );
  if (!row) throw ApiError.notFound('USER_NOT_FOUND', 'Player not found');
  await notify(userId, {
    type: 'system',
    title: row.is_verified ? 'Account verified' : 'Verification removed',
    description: row.is_verified
      ? 'Your account is now verified. The badge is visible on your profile.'
      : 'Your account verification badge was removed. Contact support if you believe this is a mistake.'
  });
  await audit.record(actor, row.is_verified ? 'user.verify' : 'user.unverify', {
    targetType: 'user',
    targetId: userId,
    details: { username: row.username, note: cleanText(note, 300) || null },
    req
  });
  return { message: row.is_verified ? 'Account verified' : 'Verification removed', user: row };
}

async function bulkUsers(actor, req, { ids, action, message } = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!list.length) throw ApiError.badRequest('NO_USERS', 'Select at least one player');
  if (list.length > 100) throw ApiError.badRequest('TOO_MANY_USERS', 'Select 100 players or fewer at a time');

  const results = [];
  for (const id of list) {
    try {
      if (action === 'ban') await setBan(actor, req, id, { ban: true });
      else if (action === 'unban') await setBan(actor, req, id, { ban: false });
      else if (action === 'verify') await setVerification(actor, req, id, { verified: true });
      else if (action === 'unverify') await setVerification(actor, req, id, { verified: false });
      else if (action === 'notify') {
        const text = cleanText(message, 500);
        if (!text) throw ApiError.badRequest('EMPTY_MESSAGE', 'Write a notification message');
        await adminService.notifyUser(actor, id, text);
      } else {
        throw ApiError.badRequest('INVALID_BULK_ACTION', 'Choose a supported bulk action');
      }
      results.push({ id, ok: true });
    } catch (error) {
      results.push({ id, ok: false, error: error.message || 'Failed' });
    }
  }
  await audit.record(actor, `user.bulk.${action}`, {
    targetType: 'user',
    targetId: null,
    details: { requested: list.length, succeeded: results.filter((row) => row.ok).length },
    req
  });
  return {
    message: `${results.filter((row) => row.ok).length} of ${list.length} players updated`,
    results
  };
}

async function setUserRole(actor, req, id, { role, overrides } = {}) {
  return adminSecurity.setRole(
    { ...req.adminAccess, user: actor, username: actor.username },
    id,
    role,
    overrides,
    req
  );
}

/* ------------------------------------------------------------
   Matches and disputes
   ------------------------------------------------------------ */

function matchRow(row) {
  return {
    id: row.id,
    game_key: row.game_key,
    mode: row.mode,
    result: row.result,
    status: row.status || 'settled',
    duration_seconds: row.duration_seconds,
    created_at: row.created_at,
    voided_at: row.voided_at,
    void_reason: row.void_reason,
    player1: row.player1
      ? { id: row.player1.id, username: row.player1.username, avatar_emoji: row.player1.avatar_emoji, avatar_url: row.player1.avatar_url, level: row.player1.level, rank_title: row.player1.rank_title }
      : null,
    player2: row.player2
      ? { id: row.player2.id, username: row.player2.username, avatar_emoji: row.player2.avatar_emoji, avatar_url: row.player2.avatar_url, level: row.player2.level, rank_title: row.player2.rank_title }
      : null
  };
}

async function listMatches(query = {}) {
  const params = listParams(query, 30);
  const mode = MATCH_MODES.has(query.mode) ? query.mode : null;
  const status = MATCH_FILTERS.has(query.status) && query.status !== 'all' ? query.status : null;
  const result = ['player1', 'player2', 'draw'].includes(query.result) ? query.result : null;
  const term = searchTerm(query.q);
  const range = dateRange(query);

  let base = admin.from('matches').select(MATCH_COLUMNS, { count: 'exact' });
  if (mode) base = base.eq('mode', mode);
  if (status) base = base.eq('status', status);
  if (result) base = base.eq('result', result);
  if (range.from) base = base.gte('created_at', range.from);
  if (range.to) base = base.lte('created_at', range.to);

  if (term) {
    const players = await many(
      admin.from('users').select('id').ilike('username', `%${term}%`).limit(25),
      'Could not search players'
    );
    const ids = players.map((player) => Number(player.id)).filter(Boolean);
    if (!ids.length) return pageResult([], 0, params);
    base = base.or(`player1_id.in.(${ids.join(',')}),player2_id.in.(${ids.join(',')})`);
  }

  const { data, error, count: total } = await base
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(params.from, params.to);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load matches');
  return pageResult((data || []).map(matchRow), total, params);
}

async function matchDetail(id) {
  const matchId = toId(id, 'match');
  const row = await one(
    admin.from('matches').select(`${MATCH_COLUMNS}, board_state, xp_p1, xp_p2, coins_p1, coins_p2, score_p1, score_p2, voided_by`).eq('id', matchId).maybeSingle(),
    'Could not load that match'
  );
  if (!row) throw ApiError.notFound('MATCH_NOT_FOUND', 'Match not found');
  const [disputes, activity] = await Promise.all([
    many(
      admin
        .from('match_disputes')
        .select('id, reason, details, status, resolution, created_at, resolved_at, reporter:users!match_disputes_reported_by_fkey(id, username)')
        .eq('match_id', matchId)
        .order('created_at', { ascending: false }),
      'Could not load disputes'
    ).catch(() => []),
    audit
      .list({ q: String(matchId), limit: 20 })
      .then((data) => data.activities.filter((entry) => entry.target_type === 'match' && String(entry.target_id) === String(matchId)))
      .catch(() => [])
  ]);
  return {
    match: { ...matchRow(row), board_state: row.board_state, rewards: { player1: { xp: row.xp_p1, coins: row.coins_p1, score: row.score_p1 }, player2: { xp: row.xp_p2, coins: row.coins_p2, score: row.score_p2 } } },
    disputes,
    activity
  };
}

async function voidMatch(actor, req, id, { reason } = {}) {
  const matchId = toId(id, 'match');
  const text = cleanText(reason, 300);
  if (text.length < 5) throw ApiError.badRequest('REASON_REQUIRED', 'Explain why this match is being voided (5+ characters)');
  let result;
  try {
    result = await rpc('void_match', { p_match_id: matchId, p_admin_id: actor.id, p_reason: text }, 'Could not void the match');
  } catch (error) {
    if (/MATCH_ALREADY_VOIDED/.test(String(error.message))) {
      throw ApiError.conflict('MATCH_ALREADY_VOIDED', 'This match has already been voided');
    }
    if (/MATCH_NOT_FOUND/.test(String(error.message))) throw ApiError.notFound('MATCH_NOT_FOUND', 'Match not found');
    throw error;
  }

  const match = result?.match || {};
  await Promise.all([
    notify(match.player1_id, {
      type: 'match',
      title: 'Match voided',
      description: `A ranked result was voided and its rewards reversed. Reason: ${text}`
    }),
    notify(match.player2_id, {
      type: 'match',
      title: 'Match voided',
      description: `A ranked result was voided and its rewards reversed. Reason: ${text}`
    })
  ]);
  await audit.record(actor, 'match.void', {
    targetType: 'match',
    targetId: matchId,
    details: { reason: text, coinsReversedP1: result?.coinsReversedP1, coinsReversedP2: result?.coinsReversedP2 },
    req
  });
  return {
    message: 'Match voided and rewards reversed',
    coinsReversedP1: result?.coinsReversedP1 || 0,
    coinsReversedP2: result?.coinsReversedP2 || 0
  };
}

async function cancelLive(actor, req, gameId) {
  const game = require('../socket/game');
  try {
    game.cancelLiveGame(String(gameId), { reason: 'Cancelled by an administrator', actor });
  } catch (error) {
    throw ApiError.notFound('LIVE_GAME_NOT_FOUND', 'That live game is no longer running');
  }
  await audit.record(actor, 'match.live.cancel', {
    targetType: 'live_game',
    targetId: String(gameId),
    req
  });
  return { message: 'Live game cancelled' };
}

async function listDisputes(query = {}) {
  const params = listParams(query, 25);
  const status = ['open', 'reviewing', 'resolved', 'rejected'].includes(query.status) ? query.status : null;
  let base = admin
    .from('match_disputes')
    .select(
      'id, match_id, reason, details, evidence_url, status, resolution, created_at, resolved_at, ' +
        'reporter:users!match_disputes_reported_by_fkey(id, username), resolver:users!match_disputes_resolved_by_fkey(id, username)',
      { count: 'exact' }
    );
  if (status) base = base.eq('status', status);
  const { data, error, count: total } = await base
    .order('created_at', { ascending: false })
    .range(params.from, params.to);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load disputes');
  return pageResult(data || [], total, params);
}

async function resolveDispute(actor, req, id, { status, resolution, voidMatch: shouldVoid } = {}) {
  const disputeId = toId(id, 'dispute');
  const nextStatus = ['reviewing', 'resolved', 'rejected'].includes(status) ? status : null;
  if (!nextStatus) throw ApiError.badRequest('INVALID_STATUS', 'Choose reviewing, resolved or rejected');
  const note = cleanMultiline(resolution, 1000);
  if (nextStatus === 'resolved' && note.length < 5) {
    throw ApiError.badRequest('RESOLUTION_REQUIRED', 'Describe the resolution (5+ characters)');
  }

  const dispute = await one(
    admin.from('match_disputes').select('id, match_id, status, reported_by').eq('id', disputeId).maybeSingle(),
    'Could not load that dispute'
  );
  if (!dispute) throw ApiError.notFound('DISPUTE_NOT_FOUND', 'Dispute not found');

  if (shouldVoid) {
    await voidMatch(actor, req, dispute.match_id, { reason: note || 'Dispute upheld by an administrator' });
  }

  const row = await one(
    admin
      .from('match_disputes')
      .update({
        status: nextStatus,
        resolution: note || null,
        resolved_by: nextStatus === 'resolved' || nextStatus === 'rejected' ? actor.id : null,
        resolved_at: nextStatus === 'resolved' || nextStatus === 'rejected' ? new Date().toISOString() : null
      })
      .eq('id', disputeId)
      .select('id, match_id, status, resolution, resolved_at')
      .single(),
    'Could not update the dispute'
  );
  if (dispute.reported_by) {
    await notify(dispute.reported_by, {
      type: 'system',
      title: 'Dispute update',
      description: note ? `Your match dispute was ${nextStatus}: ${note}` : `Your match dispute is now ${nextStatus}.`
    });
  }
  await audit.record(actor, 'dispute.update', {
    targetType: 'dispute',
    targetId: disputeId,
    details: { status: nextStatus, voided: Boolean(shouldVoid) },
    req
  });
  return { message: 'Dispute updated', dispute: row };
}

async function suspiciousMatches(query = {}) {
  const days = Math.min(Math.max(Number(query.days) || 7, 1), 30);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await many(
    admin
      .from('matches')
      .select(MATCH_COLUMNS)
      .gte('created_at', since)
      .eq('status', 'settled')
      .order('created_at', { ascending: false })
      .limit(500),
    'Could not analyse matches'
  );
  const pairCounts = new Map();
  rows.forEach((row) => {
    const key = [row.player1?.id, row.player2?.id].sort().join(':');
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
  });
  const flagged = [];
  rows.forEach((row) => {
    const reasons = [];
    if (Number(row.duration_seconds) > 0 && Number(row.duration_seconds) < 12) reasons.push('Completed in under 12 seconds');
    const key = [row.player1?.id, row.player2?.id].sort().join(':');
    if ((pairCounts.get(key) || 0) >= 6) reasons.push(`${pairCounts.get(key)} games between the same two players`);
    if (reasons.length) {
      flagged.push({ match: matchRow(row), reasons });
    }
  });
  return { days, analysed: rows.length, flagged: flagged.slice(0, 100) };
}

/* ------------------------------------------------------------
   Tournaments
   ------------------------------------------------------------ */

const TOURNAMENT_COLUMNS =
  'id, name, description, rules, format, mode, prize_pool, entry_fee, max_players, status, starts_at, created_at, completed_at, cancelled_reason, reward_structure, bracket, created_by';

function tournamentRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rules: row.rules || '',
    format: row.format,
    mode: row.mode,
    prize_pool: row.prize_pool,
    entry_fee: row.entry_fee,
    max_players: row.max_players,
    status: row.status,
    starts_at: row.starts_at,
    created_at: row.created_at,
    completed_at: row.completed_at,
    cancelled_reason: row.cancelled_reason,
    reward_structure: Array.isArray(row.reward_structure) ? row.reward_structure : [],
    bracket: row.bracket || { rounds: [], champion: null },
    entry_count: Number(row.tournament_entries?.[0]?.count || 0)
  };
}

async function listTournaments(query = {}) {
  const params = listParams(query, 25);
  const status = TOURNAMENT_STATUSES.has(query.status) ? query.status : null;
  const term = searchTerm(query.q);
  let base = admin
    .from('tournaments')
    .select(`${TOURNAMENT_COLUMNS}, tournament_entries(count)`, { count: 'exact' });
  if (status) base = base.eq('status', status);
  if (term) base = base.ilike('name', `%${term}%`);
  const { data, error, count: total } = await base
    .order('starts_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(params.from, params.to);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load tournaments');
  return pageResult((data || []).map(tournamentRow), total, params);
}

async function tournamentDetail(id) {
  const tournamentId = toId(id, 'tournament');
  const row = await one(
    admin
      .from('tournaments')
      .select(`${TOURNAMENT_COLUMNS}, tournament_entries(count)`)
      .eq('id', tournamentId)
      .maybeSingle(),
    'Could not load that tournament'
  );
  if (!row) throw ApiError.notFound('TOURNAMENT_NOT_FOUND', 'Tournament not found');
  const entries = await many(
    admin
      .from('tournament_entries')
      .select('user_id, joined_at, user:users(id, username, avatar_emoji, avatar_url, level, rank_title, score, wins, losses)')
      .eq('tournament_id', tournamentId)
      .order('joined_at', { ascending: true }),
    'Could not load entrants'
  );
  return {
    tournament: tournamentRow(row),
    entries: entries.map((entry) => ({ user_id: entry.user_id, joined_at: entry.joined_at, user: entry.user }))
  };
}

function normalizeTournament(input = {}) {
  const name = cleanText(input.name, 80);
  if (name.length < 3) throw ApiError.badRequest('INVALID_NAME', 'Tournament name must be at least 3 characters');
  const format = TOURNAMENT_FORMATS.has(input.format) ? input.format : 'single_elimination';
  const mode = ['ranked', 'friendly'].includes(input.mode) ? input.mode : 'ranked';
  const status = TOURNAMENT_STATUSES.has(input.status) ? input.status : 'draft';
  const maxPlayers = Math.min(Math.max(Number(input.max_players) || 16, 2), 256);
  const entryFee = Math.min(Math.max(Number(input.entry_fee) || 0, 0), 1000000);
  const prizePool = Math.min(Math.max(Number(input.prize_pool) || 0, 0), 10000000);
  const startsAt = input.starts_at ? new Date(input.starts_at) : null;
  if (startsAt && Number.isNaN(startsAt.getTime())) throw ApiError.badRequest('INVALID_DATE', 'Enter a valid start date');

  const rewardStructure = Array.isArray(input.reward_structure)
    ? input.reward_structure
        .map((entry) => ({
          place: Math.min(Math.max(Number(entry?.place) || 1, 1), 64),
          coins: Math.min(Math.max(Number(entry?.coins) || 0, 0), 10000000)
        }))
        .filter((entry) => entry.coins > 0)
        .slice(0, 16)
    : [];

  return {
    name,
    description: cleanMultiline(input.description, 2000),
    rules: cleanMultiline(input.rules, 5000),
    format,
    mode,
    max_players: maxPlayers,
    entry_fee: entryFee,
    prize_pool: prizePool,
    status,
    starts_at: startsAt ? startsAt.toISOString() : null,
    reward_structure: rewardStructure
  };
}

async function saveTournament(actor, req, input = {}) {
  const payload = normalizeTournament(input);
  const id = input.id ? toId(input.id, 'tournament') : null;
  if (id) {
    const existing = await one(admin.from('tournaments').select('id, status').eq('id', id).maybeSingle(), 'Could not load that tournament');
    if (!existing) throw ApiError.notFound('TOURNAMENT_NOT_FOUND', 'Tournament not found');
    if (existing.status === 'completed' && payload.status !== 'completed') {
      throw ApiError.badRequest('TOURNAMENT_COMPLETED', 'A completed tournament cannot be reopened');
    }
    const row = await one(
      admin
        .from('tournaments')
        .update({
          ...payload,
          completed_at: payload.status === 'completed' ? new Date().toISOString() : null,
          cancelled_reason: payload.status === 'cancelled' ? cleanText(input.cancelled_reason, 300) || null : null
        })
        .eq('id', id)
        .select(TOURNAMENT_COLUMNS)
        .single(),
      'Could not update the tournament'
    );
    await audit.record(actor, 'tournament.update', { targetType: 'tournament', targetId: id, details: { name: row.name, status: row.status }, req });
    return { message: 'Tournament updated', tournament: tournamentRow(row) };
  }

  const row = await one(
    admin
      .from('tournaments')
      .insert({ ...payload, created_by: actor.id })
      .select(TOURNAMENT_COLUMNS)
      .single(),
    'Could not create the tournament'
  );
  await audit.record(actor, 'tournament.create', { targetType: 'tournament', targetId: row.id, details: { name: row.name }, req });
  return { message: 'Tournament created', tournament: tournamentRow(row) };
}

async function deleteTournament(actor, req, id) {
  const tournamentId = toId(id, 'tournament');
  const row = await one(admin.from('tournaments').select('id, name').eq('id', tournamentId).maybeSingle(), 'Could not load that tournament');
  if (!row) throw ApiError.notFound('TOURNAMENT_NOT_FOUND', 'Tournament not found');
  await one(admin.from('tournaments').delete().eq('id', tournamentId).select('id'), 'Could not delete the tournament');
  await audit.record(actor, 'tournament.delete', { targetType: 'tournament', targetId: tournamentId, details: { name: row.name }, req });
  return { message: 'Tournament deleted' };
}

function makeEntrant(user) {
  return user ? { id: user.id, username: user.username, avatar_emoji: user.avatar_emoji || '👤' } : null;
}

function buildFirstRound(entrants) {
  const matches = [];
  const pool = entrants.slice();
  let bye = null;
  if (pool.length % 2 === 1) bye = pool.pop();
  for (let index = 0; index < pool.length; index += 2) {
    matches.push({
      id: `r1m${matches.length + 1}`,
      player1: pool[index] || null,
      player2: pool[index + 1] || null,
      winnerId: null,
      status: 'pending'
    });
  }
  if (bye) {
    matches.push({ id: `r1m${matches.length + 1}`, player1: bye, player2: null, winnerId: bye.id, status: 'bye' });
  }
  return matches;
}

async function generateBracket(actor, req, id) {
  const detail = await tournamentDetail(id);
  const tournament = detail.tournament;
  if (!detail.entries.length) throw ApiError.badRequest('NO_ENTRANTS', 'At least one entrant is required');
  if (tournament.bracket?.rounds?.length) {
    throw ApiError.conflict('BRACKET_EXISTS', 'A bracket already exists for this tournament');
  }
  const entrants = detail.entries
    .map((entry) => makeEntrant(entry.user))
    .filter(Boolean)
    .sort((a, b) => Number(a.id) - Number(b.id));
  const rounds = [{ round: 1, matches: buildFirstRound(entrants) }];
  const bracket = { rounds, champion: null, generatedAt: new Date().toISOString() };
  const row = await one(
    admin
      .from('tournaments')
      .update({ bracket, status: 'live', completed_at: null })
      .eq('id', tournament.id)
      .select('id, bracket, status')
      .single(),
    'Could not build the bracket'
  );
  await audit.record(actor, 'tournament.bracket.generate', {
    targetType: 'tournament',
    targetId: tournament.id,
    details: { entrants: entrants.length, rounds: rounds.length },
    req
  });
  return { message: 'Bracket generated', bracket: row.bracket, status: row.status };
}

async function advanceBracket(actor, req, id, { round, matchIndex, winnerId } = {}) {
  const tournamentId = toId(id, 'tournament');
  const roundNumber = Number(round);
  const index = Number(matchIndex);
  const winner = Number(winnerId);
  if (!Number.isInteger(roundNumber) || roundNumber < 1) throw ApiError.badRequest('INVALID_ROUND', 'Choose a valid round');
  if (!Number.isInteger(index) || index < 0) throw ApiError.badRequest('INVALID_MATCH', 'Choose a valid bracket match');
  if (!Number.isInteger(winner) || winner <= 0) throw ApiError.badRequest('INVALID_WINNER', 'Choose the winning player');

  const row = await one(
    admin.from('tournaments').select('id, bracket, status').eq('id', tournamentId).maybeSingle(),
    'Could not load that tournament'
  );
  if (!row) throw ApiError.notFound('TOURNAMENT_NOT_FOUND', 'Tournament not found');
  const bracket = row.bracket || { rounds: [], champion: null };
  const rounds = Array.isArray(bracket.rounds) ? bracket.rounds : [];
  const current = rounds[roundNumber - 1];
  if (!current) throw ApiError.badRequest('ROUND_NOT_FOUND', 'That round has not been generated yet');
  const match = current.matches?.[index];
  if (!match) throw ApiError.badRequest('MATCH_NOT_FOUND', 'That bracket match does not exist');
  if (![match.player1?.id, match.player2?.id].includes(winner)) {
    throw ApiError.badRequest('INVALID_WINNER', 'That player is not in this match');
  }
  match.winnerId = winner;
  match.status = 'completed';

  const allDecided = current.matches.every((entry) => entry.winnerId);
  if (allDecided && !rounds[roundNumber]) {
    const winners = current.matches.map((entry) => entry.player1?.id === entry.winnerId ? entry.player1 : entry.player2);
    if (winners.length <= 1) {
      bracket.champion = winners[0] || null;
    } else {
      rounds.push({ round: roundNumber + 1, matches: buildFirstRound(winners) });
    }
  } else if (allDecided && rounds[roundNumber] && rounds[roundNumber].matches.every((entry) => entry.winnerId)) {
    bracket.champion = bracket.champion || null;
  }

  const finalRound = rounds[rounds.length - 1];
  if (finalRound?.matches?.length === 1 && finalRound.matches[0].winnerId) {
    bracket.champion = finalRound.matches[0].player1?.id === finalRound.matches[0].winnerId
      ? finalRound.matches[0].player1
      : finalRound.matches[0].player2;
  }

  const update = { bracket };
  if (bracket.champion) {
    update.status = 'completed';
    update.completed_at = new Date().toISOString();
  }
  const saved = await one(
    admin.from('tournaments').update(update).eq('id', tournamentId).select('bracket, status, completed_at').single(),
    'Could not save the bracket'
  );
  await audit.record(actor, 'tournament.bracket.advance', {
    targetType: 'tournament',
    targetId: tournamentId,
    details: { round: roundNumber, matchIndex: index, winnerId: winner },
    req
  });
  return { message: bracket.champion ? `${bracket.champion.username} wins the tournament` : 'Bracket updated', ...saved };
}

async function removeEntrant(actor, req, id, userId) {
  const tournamentId = toId(id, 'tournament');
  const playerId = toId(userId, 'player');
  const tournament = await one(
    admin.from('tournaments').select('id, name, status, entry_fee').eq('id', tournamentId).maybeSingle(),
    'Could not load that tournament'
  );
  if (!tournament) throw ApiError.notFound('TOURNAMENT_NOT_FOUND', 'Tournament not found');
  if (tournament.status === 'live') throw ApiError.badRequest('TOURNAMENT_LIVE', 'Entrants cannot be removed from a live tournament');

  const entry = await one(
    admin.from('tournament_entries').select('user_id').eq('tournament_id', tournamentId).eq('user_id', playerId).maybeSingle(),
    'Could not load that entry'
  );
  if (!entry) throw ApiError.notFound('NOT_REGISTERED', 'That player is not registered');

  await one(
    admin.from('tournament_entries').delete().eq('tournament_id', tournamentId).eq('user_id', playerId).select('user_id'),
    'Could not remove the entrant'
  );

  let refunded = 0;
  if (Number(tournament.entry_fee) > 0) {
    const existing = await one(
      admin
        .from('coin_transactions')
        .select('id')
        .eq('user_id', playerId)
        .eq('reference_type', 'refund')
        .eq('reference_id', `tournament_remove:${tournamentId}`)
        .maybeSingle(),
      'Could not check the refund'
    );
    if (!existing) {
      await rpc(
        'credit_coins',
        {
          p_user_id: playerId,
          p_amount: Number(tournament.entry_fee),
          p_type: 'refund',
          p_description: `Entry fee refunded: ${tournament.name}`,
          p_reference_type: 'refund',
          p_reference_id: `tournament_remove:${tournamentId}`
        },
        'Could not refund the entry fee'
      ).catch(() => null);
      refunded = Number(tournament.entry_fee);
    }
  }

  await notify(playerId, {
    type: 'system',
    title: `Removed from ${tournament.name}`,
    description: refunded
      ? `An administrator removed your entry. ${refunded.toLocaleString()} coins were refunded to your wallet.`
      : 'An administrator removed your entry from this tournament.'
  });
  await audit.record(actor, 'tournament.entrant.remove', {
    targetType: 'tournament',
    targetId: tournamentId,
    details: { userId: playerId, refunded },
    req
  });
  return { message: 'Entrant removed', refunded };
}

async function rewardTournament(actor, req, id, { payouts } = {}) {
  const tournamentId = toId(id, 'tournament');
  const tournament = await one(
    admin.from('tournaments').select('id, name, reward_structure, bracket, status').eq('id', tournamentId).maybeSingle(),
    'Could not load that tournament'
  );
  if (!tournament) throw ApiError.notFound('TOURNAMENT_NOT_FOUND', 'Tournament not found');

  let plan = Array.isArray(payouts) ? payouts : [];
  if (!plan.length) {
    const structure = (Array.isArray(tournament.reward_structure) ? tournament.reward_structure : [])
      .slice()
      .sort((a, b) => Number(a.place) - Number(b.place));
    const bracket = tournament.bracket || {};
    const finalRound = bracket.rounds?.[bracket.rounds.length - 1];
    const finalMatch = finalRound?.matches?.[0];
    const champion = bracket.champion;
    const runnerUp = finalMatch
      ? finalMatch.player1?.id === finalMatch.winnerId
        ? finalMatch.player2
        : finalMatch.player1
      : null;
    const winnersByPlace = [champion, runnerUp];
    plan = structure
      .filter((entry) => Number(entry.coins) > 0)
      .slice(0, winnersByPlace.length)
      .map((entry, index) => ({ userId: winnersByPlace[index]?.id, coins: entry.coins, place: entry.place }));
    plan = plan.filter((entry) => entry.userId);
  }

  if (!plan.length) throw ApiError.badRequest('NO_PAYOUTS', 'Configure a reward structure or supply payouts');

  const results = [];
  for (const payout of plan) {
    const playerId = toId(payout.userId, 'player');
    const coins = Math.min(Math.max(Number(payout.coins) || 0, 1), 10000000);
    const referenceId = `${tournamentId}:${playerId}`;
    const existing = await one(
      admin
        .from('coin_transactions')
        .select('id')
        .eq('user_id', playerId)
        .eq('reference_type', 'tournament_reward')
        .eq('reference_id', referenceId)
        .maybeSingle(),
      'Could not check the payout'
    );
    if (existing) {
      results.push({ userId: playerId, coins: 0, skipped: true, reason: 'Already rewarded' });
      continue;
    }
    try {
      await rpc(
        'credit_coins',
        {
          p_user_id: playerId,
          p_amount: coins,
          p_type: 'admin_gift',
          p_description: `${tournament.name} — place #${payout.place || results.length + 1}`,
          p_reference_type: 'tournament_reward',
          p_reference_id: referenceId
        },
        'Could not pay a tournament reward'
      );
      await notify(playerId, {
        type: 'reward',
        title: `🏆 ${tournament.name} reward`,
        description: `You earned ${coins.toLocaleString()} coins for place #${payout.place || results.length + 1}.`
      });
      results.push({ userId: playerId, coins, skipped: false });
    } catch (error) {
      results.push({ userId: playerId, coins: 0, skipped: true, reason: error.message || 'Payout failed' });
    }
  }

  await audit.record(actor, 'tournament.reward', {
    targetType: 'tournament',
    targetId: tournamentId,
    details: { paid: results.filter((row) => !row.skipped).length, plan },
    req
  });
  return {
    message: `${results.filter((row) => !row.skipped).length} tournament payouts sent`,
    results
  };
}

async function cancelTournament(actor, req, id, { reason, refund = true } = {}) {
  const tournamentId = toId(id, 'tournament');
  const tournament = await one(
    admin.from('tournaments').select('id, name, status, entry_fee').eq('id', tournamentId).maybeSingle(),
    'Could not load that tournament'
  );
  if (!tournament) throw ApiError.notFound('TOURNAMENT_NOT_FOUND', 'Tournament not found');
  if (tournament.status === 'completed') throw ApiError.badRequest('TOURNAMENT_COMPLETED', 'A completed tournament cannot be cancelled');

  const entries = await many(
    admin.from('tournament_entries').select('user_id').eq('tournament_id', tournamentId),
    'Could not load entrants'
  );
  await one(
    admin
      .from('tournaments')
      .update({ status: 'cancelled', cancelled_reason: cleanText(reason, 300) || 'Cancelled by an administrator' })
      .eq('id', tournamentId)
      .select('id')
      .single(),
    'Could not cancel the tournament'
  );

  let refunded = 0;
  if (refund && Number(tournament.entry_fee) > 0) {
    for (const entry of entries) {
      await notify(entry.user_id, {
        type: 'system',
        title: `${tournament.name} cancelled`,
        description: `The tournament was cancelled. Your ${Number(tournament.entry_fee).toLocaleString()} coin entry fee will be refunded.`
      });
      const existing = await one(
        admin
          .from('coin_transactions')
          .select('id')
          .eq('user_id', entry.user_id)
          .eq('reference_type', 'refund')
          .eq('reference_id', `tournament_cancel:${tournamentId}`)
          .maybeSingle(),
        'Could not check refunds'
      );
      if (existing) continue;
      try {
        await rpc(
          'credit_coins',
          {
            p_user_id: entry.user_id,
            p_amount: Number(tournament.entry_fee),
            p_type: 'refund',
            p_description: `Refund: ${tournament.name} was cancelled`,
            p_reference_type: 'refund',
            p_reference_id: `tournament_cancel:${tournamentId}`
          },
          'Could not refund an entrant'
        );
        refunded += 1;
      } catch (_) {
        /* continue paying the remaining entrants */
      }
    }
  } else {
    for (const entry of entries) {
      await notify(entry.user_id, {
        type: 'system',
        title: `${tournament.name} cancelled`,
        description: 'The tournament was cancelled by the arena team.'
      });
    }
  }

  await audit.record(actor, 'tournament.cancel', {
    targetType: 'tournament',
    targetId: tournamentId,
    details: { reason: cleanText(reason, 300), refunded },
    req
  });
  return { message: 'Tournament cancelled', refunded };
}

/* ------------------------------------------------------------
   Global search and exports
   ------------------------------------------------------------ */

async function globalSearch(access, query = {}) {
  const term = searchTerm(query.q, 80);
  if (term.length < 2) return { query: term, groups: [] };
  const can = (permission) => Array.isArray(access?.permissions) && access.permissions.includes(permission);
  const groups = [];

  if (can('users.view')) {
    const rows = await many(
      admin.from('users').select('id, username, email, avatar_emoji, level, is_banned').or(`username.ilike.%${term}%,email.ilike.%${term}%`).limit(6),
      'Could not search players'
    ).catch(() => []);
    if (rows.length) groups.push({ type: 'users', label: 'Players', items: rows.map((row) => ({ id: row.id, title: row.username, subtitle: row.email, badge: row.is_banned ? 'Banned' : `Level ${row.level}`, href: `#/users?user=${row.id}` })) });
  }

  if (can('matches.view')) {
    const players = await many(admin.from('users').select('id').ilike('username', `%${term}%`).limit(10), 'Could not search players').catch(() => []);
    const ids = players.map((row) => Number(row.id)).filter(Boolean);
    let rows = [];
    if (ids.length) {
      rows = await many(
        admin
          .from('matches')
          .select('id, mode, result, created_at, player1:users!matches_player1_id_fkey(username), player2:users!matches_player2_id_fkey(username)')
          .or(`player1_id.in.(${ids.join(',')}),player2_id.in.(${ids.join(',')})`)
          .order('created_at', { ascending: false })
          .limit(5),
        'Could not search matches'
      ).catch(() => []);
    }
    if (rows.length) groups.push({ type: 'matches', label: 'Matches', items: rows.map((row) => ({ id: row.id, title: `${row.player1?.username || '?'} vs ${row.player2?.username || '?'}`, subtitle: `${row.mode} · ${new Date(row.created_at).toLocaleString()}`, href: `#/matches?match=${row.id}` })) });
  }

  if (can('tournaments.view')) {
    const rows = await many(admin.from('tournaments').select('id, name, status, starts_at').ilike('name', `%${term}%`).limit(6), 'Could not search tournaments').catch(() => []);
    if (rows.length) groups.push({ type: 'tournaments', label: 'Tournaments', items: rows.map((row) => ({ id: row.id, title: row.name, subtitle: `${row.status}${row.starts_at ? ` · ${new Date(row.starts_at).toLocaleDateString()}` : ''}`, href: `#/tournaments?tournament=${row.id}` })) });
  }

  if (can('support.view')) {
    const rows = await many(
      admin
        .from('support_tickets')
        .select('id, name, email, subject, status, created_at')
        .or(`name.ilike.%${term}%,email.ilike.%${term}%,message.ilike.%${term}%`)
        .order('created_at', { ascending: false })
        .limit(6),
      'Could not search tickets'
    ).catch(() => []);
    if (rows.length) groups.push({ type: 'support', label: 'Support tickets', items: rows.map((row) => ({ id: row.id, title: row.subject || `Ticket #${row.id}`, subtitle: `${row.name} · ${row.status}`, href: `#/support?ticket=${row.id}` })) });
  }

  if (can('cms.view')) {
    const rows = await many(
      admin.from('cms_pages').select('id, slug, title, status').or(`title.ilike.%${term}%,slug.ilike.%${term}%`).limit(6),
      'Could not search pages'
    ).catch(() => []);
    if (rows.length) groups.push({ type: 'cms', label: 'Content pages', items: rows.map((row) => ({ id: row.id, title: row.title, subtitle: `/${row.slug} · ${row.status}`, href: `#/cms?page=${row.id}` })) });
  }

  if (can('matches.view')) {
    const rows = await many(
      admin.from('match_disputes').select('id, match_id, reason, status, created_at').ilike('reason', `%${term}%`).limit(5),
      'Could not search disputes'
    ).catch(() => []);
    if (rows.length) groups.push({ type: 'disputes', label: 'Disputes', items: rows.map((row) => ({ id: row.id, title: `Match #${row.match_id}`, subtitle: row.reason, href: `#/matches?dispute=${row.id}` })) });
  }

  return { query: term, groups };
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(columns, rows) {
  return [columns.map((column) => csvCell(column.label)).join(','), ...rows.map((row) => columns.map((column) => csvCell(typeof column.value === 'function' ? column.value(row) : row[column.key])).join(','))].join('\r\n');
}

function toXls(title, columns, rows) {
  const escape = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const head = columns.map((column) => `<th>${escape(column.label)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${columns.map((column) => `<td>${escape(typeof column.value === 'function' ? column.value(row) : row[column.key])}</td>`).join('')}</tr>`)
    .join('');
  return `<html><head><meta charset="utf-8"><title>${escape(title)}</title></head><body><table border="1"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

async function exportData(query = {}) {
  const type = String(query.type || 'users');
  const format = query.format === 'xls' ? 'xls' : 'csv';
  const limit = Math.min(Math.max(Number(query.limit) || 5000, 1), 20000);
  let columns;
  let rows;
  let name;

  if (type === 'users') {
    const result = await listUsers({ ...query, limit: 100, page: 1 });
    let data = result.rows;
    let page = 2;
    while (data.length < limit && page <= result.pages) {
      const next = await listUsers({ ...query, limit: 100, page });
      data = data.concat(next.rows);
      page += 1;
    }
    rows = data.slice(0, limit);
    name = 'players';
    columns = [
      { key: 'id', label: 'ID' },
      { key: 'username', label: 'Username' },
      { key: 'email', label: 'Email' },
      { key: 'level', label: 'Level' },
      { key: 'rank_title', label: 'Rank' },
      { key: 'wins', label: 'Wins' },
      { key: 'losses', label: 'Losses' },
      { key: 'draws', label: 'Draws' },
      { key: 'score', label: 'Score' },
      { key: 'coins', label: 'Coins' },
      { key: 'is_verified', label: 'Verified' },
      { key: 'is_banned', label: 'Banned' },
      { key: 'created_at', label: 'Joined' }
    ];
  } else if (type === 'matches') {
    const result = await listMatches({ ...query, limit: 100, page: 1 });
    let data = result.rows;
    let page = 2;
    while (data.length < limit && page <= result.pages) {
      const next = await listMatches({ ...query, limit: 100, page });
      data = data.concat(next.rows);
      page += 1;
    }
    rows = data.slice(0, limit);
    name = 'matches';
    columns = [
      { key: 'id', label: 'Match' },
      { key: 'mode', label: 'Mode' },
      { key: 'status', label: 'Status' },
      { key: 'result', label: 'Result' },
      { label: 'Player 1', value: (row) => row.player1?.username || '' },
      { label: 'Player 2', value: (row) => row.player2?.username || '' },
      { key: 'duration_seconds', label: 'Duration (s)' },
      { key: 'created_at', label: 'Played at' }
    ];
  } else if (type === 'tournaments') {
    const result = await listTournaments({ ...query, limit: 100, page: 1 });
    let data = result.rows;
    let page = 2;
    while (data.length < limit && page <= result.pages) {
      const next = await listTournaments({ ...query, limit: 100, page });
      data = data.concat(next.rows);
      page += 1;
    }
    rows = data.slice(0, limit);
    name = 'tournaments';
    columns = [
      { key: 'id', label: 'ID' },
      { key: 'name', label: 'Name' },
      { key: 'format', label: 'Format' },
      { key: 'status', label: 'Status' },
      { key: 'entry_count', label: 'Entrants' },
      { key: 'entry_fee', label: 'Entry fee' },
      { key: 'prize_pool', label: 'Prize pool' },
      { key: 'starts_at', label: 'Starts at' }
    ];
  } else if (type === 'audit') {
    const data = await audit.list({ page: 1, limit, q: query.q, action: query.action, start: query.from, end: query.to });
    rows = data.activities;
    name = 'audit-trail';
    columns = [
      { key: 'created_at', label: 'Time' },
      { key: 'admin_username', label: 'Administrator' },
      { key: 'action', label: 'Action' },
      { key: 'target_type', label: 'Target type' },
      { key: 'target_id', label: 'Target' },
      { label: 'Details', value: (row) => (row.details ? JSON.stringify(row.details) : '') },
      { key: 'ip', label: 'IP' },
      { key: 'entry_hash', label: 'Chain hash' }
    ];
  } else if (type === 'support') {
    const rowsRaw = await many(
      admin.from('support_tickets').select('id, name, email, subject, category, priority, status, created_at, resolved_at').order('created_at', { ascending: false }).limit(limit),
      'Could not export tickets'
    );
    rows = rowsRaw;
    name = 'support-tickets';
    columns = [
      { key: 'id', label: 'Ticket' },
      { key: 'name', label: 'Player' },
      { key: 'email', label: 'Email' },
      { key: 'subject', label: 'Subject' },
      { key: 'category', label: 'Category' },
      { key: 'priority', label: 'Priority' },
      { key: 'status', label: 'Status' },
      { key: 'created_at', label: 'Created' },
      { key: 'resolved_at', label: 'Resolved' }
    ];
  } else {
    throw ApiError.badRequest('INVALID_EXPORT', 'Choose a supported export type');
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const content = format === 'xls' ? toXls(name, columns, rows) : toCsv(columns, rows);
  return {
    filename: `tictacarena-${name}-${stamp}.${format}`,
    contentType: format === 'xls' ? 'application/vnd.ms-excel; charset=utf-8' : 'text/csv; charset=utf-8',
    content,
    rows: rows.length
  };
}

module.exports = {
  dashboard,
  analytics,
  liveState,
  alertCounts,
  listUsers,
  userCounts,
  userDetail,
  updateUser,
  setBan,
  setVerification,
  bulkUsers,
  setUserRole,
  listMatches,
  matchDetail,
  voidMatch,
  cancelLive,
  listDisputes,
  resolveDispute,
  suspiciousMatches,
  listTournaments,
  tournamentDetail,
  saveTournament,
  deleteTournament,
  generateBracket,
  advanceBracket,
  removeEntrant,
  rewardTournament,
  cancelTournament,
  globalSearch,
  exportData
};
