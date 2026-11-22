'use strict';

/**
 * TicTacArena — Admin Control Center: economy, ladder and community moderation.
 *
 * Coin changes never write a balance directly. They go through the
 * `admin_adjust_coins` SQL routine, which locks the wallet, writes the ledger
 * row and returns the same result for a retried request id. That makes a
 * double-click or a network retry safe.
 */

const { admin, one, many, rpc, count } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { cleanText, cleanMultiline } = require('../utils/sanitize');
const adminService = require('./admin.service');
const adminOverview = require('./adminOverview.service');
const audit = require('./audit.service');
const notificationService = require('./notification.service');
const leaderboardService = require('./leaderboard.service');
const operations = require('./operations.service');
const settingsService = require('./settings.service');
const restrictionService = require('./restriction.service');

const MAX_PAGE = 100;
const TX_TYPES = new Set([
  'match_reward',
  'shop_purchase',
  'topup',
  'admin_gift',
  'achievement_reward',
  'mail_reward',
  'refund',
  'initial'
]);
const RESTRICTION_TYPES = new Set(['chat', 'world_chat', 'matchmaking', 'login']);
const REPORT_STATUSES = new Set(['open', 'reviewing', 'resolved', 'dismissed']);

function toId(value, label = 'identifier') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('INVALID_ID', `Choose a valid ${label}`);
  return id;
}

function listParams(query = {}, fallback = 25) {
  const limit = Math.min(Math.max(Number(query.limit) || fallback, 1), MAX_PAGE);
  const page = Math.min(Math.max(Number(query.page) || 1, 1), 100000);
  return { limit, page, from: (page - 1) * limit, to: page * limit - 1 };
}

function searchTerm(value, max = 60) {
  return cleanText(value, max).replace(/[(),%*]/g, '').trim();
}

function rangeOf(query = {}) {
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

async function notify(userId, payload) {
  try {
    await notificationService.create({ userId, ...payload });
  } catch (_) {
    /* courtesy notification */
  }
}

/* ------------------------------------------------------------
   Coin economy
   ------------------------------------------------------------ */

async function economySummary(query = {}) {
  const window = adminOverview.range(query);
  const data = await rpc(
    'get_admin_economy_summary',
    { p_start: window.start, p_end: window.end },
    'Could not load the coin economy'
  );
  const pendingTopups = await count(
    admin.from('topup_orders').select('id', { count: 'exact', head: true }).eq('status', 'pending')
  ).catch(() => 0);
  return {
    range: window,
    ...(data || {}),
    pendingTopups,
    generatedAt: new Date().toISOString()
  };
}

async function listTransactions(query = {}) {
  const params = listParams(query, 30);
  const type = TX_TYPES.has(query.type) ? query.type : null;
  const direction = query.direction === 'credit' ? 'credit' : query.direction === 'debit' ? 'debit' : null;
  const term = searchTerm(query.q);
  const range = rangeOf(query);
  const min = Number(query.min);
  const max = Number(query.max);

  let userIds = null;
  if (term) {
    const players = await many(
      admin.from('users').select('id').or(`username.ilike.%${term}%,email.ilike.%${term}%`).limit(25),
      'Could not search players'
    );
    userIds = players.map((row) => Number(row.id)).filter(Boolean);
    if (!userIds.length) return pageResult([], 0, params);
  }

  let base = admin
    .from('coin_transactions')
    .select('id, user_id, amount, type, description, reference_type, reference_id, created_at, user:users(id, username, email, avatar_emoji, avatar_url)', { count: 'exact' });
  if (type) base = base.eq('type', type);
  if (direction === 'credit') base = base.gt('amount', 0);
  if (direction === 'debit') base = base.lt('amount', 0);
  if (Number.isFinite(min)) base = base.gte('amount', min);
  if (Number.isFinite(max)) base = base.lte('amount', max);
  if (range.from) base = base.gte('created_at', range.from);
  if (range.to) base = base.lte('created_at', range.to);
  if (userIds) base = base.in('user_id', userIds);

  const { data, error, count: total } = await base
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(params.from, params.to);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load coin transactions');

  const rows = (data || []).map((row) => ({
    id: row.id,
    user_id: row.user_id,
    amount: row.amount,
    type: row.type,
    description: row.description,
    reference_type: row.reference_type,
    reference_id: row.reference_id,
    created_at: row.created_at,
    user: row.user
      ? {
          id: row.user.id,
          username: row.user.username,
          email: row.user.email,
          avatar_emoji: row.user.avatar_emoji,
          avatar_url: row.user.avatar_url
        }
      : null
  }));
  return pageResult(rows, total, params);
}

async function adjustCoins(actor, req, payload = {}) {
  const requestId = cleanText(payload.requestId, 80);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
    throw ApiError.badRequest('INVALID_REQUEST_ID', 'A unique request id is required');
  }
  const amount = Number(payload.amount);
  if (!Number.isInteger(amount) || amount === 0) {
    throw ApiError.badRequest('INVALID_AMOUNT', 'Enter a non-zero whole coin amount');
  }
  if (Math.abs(amount) > 10000000) throw ApiError.badRequest('AMOUNT_TOO_LARGE', 'The maximum adjustment is 10,000,000 coins');
  const reason = cleanText(payload.reason, 300);
  if (reason.length < 3) throw ApiError.badRequest('REASON_REQUIRED', 'Give a reason for this adjustment (3+ characters)');

  let playerId;
  if (payload.userId) playerId = toId(payload.userId, 'player');
  else {
    const username = cleanText(payload.username, 24);
    if (!username) throw ApiError.badRequest('USER_REQUIRED', 'Choose a player');
    const player = await one(
      admin.from('users').select('id, is_bot').ilike('username', username).maybeSingle(),
      'Could not find that player'
    );
    if (!player) throw ApiError.notFound('USER_NOT_FOUND', 'Player not found');
    if (player.is_bot) throw ApiError.badRequest('BOT_ACCOUNT', 'Bot accounts cannot receive coin adjustments');
    playerId = player.id;
  }

  const target = await one(
    admin.from('users').select('id, username, coins, is_bot').eq('id', playerId).maybeSingle(),
    'Could not load that player'
  );
  if (!target) throw ApiError.notFound('USER_NOT_FOUND', 'Player not found');
  if (target.is_bot) throw ApiError.badRequest('BOT_ACCOUNT', 'Bot accounts cannot receive coin adjustments');

  const result = await rpc(
    'admin_adjust_coins',
    {
      p_request_id: requestId,
      p_user_id: playerId,
      p_admin_id: actor.id,
      p_amount: amount,
      p_reason: reason
    },
    'Could not adjust the coin balance'
  );

  if (!result?.duplicate) {
    await notify(playerId, {
      type: 'reward',
      title: amount > 0 ? '💰 Coins added' : 'Coin balance adjusted',
      description: `${amount > 0 ? '+' : ''}${amount.toLocaleString()} coins — ${reason}`
    });
    await audit.record(actor, 'economy.adjust', {
      targetType: 'user',
      targetId: playerId,
      details: {
        requestId,
        amount,
        reason,
        balanceBefore: result?.balanceBefore,
        balanceAfter: result?.coins
      },
      req
    });
  }

  return {
    duplicate: Boolean(result?.duplicate),
    message: result?.duplicate
      ? 'This adjustment was already processed'
      : `${amount > 0 ? 'Added' : 'Deducted'} ${Math.abs(amount).toLocaleString()} coins`,
    coins: result?.coins,
    amount: result?.amount,
    username: target.username
  };
}

async function suspiciousTransactions(query = {}) {
  const days = Math.min(Math.max(Number(query.days) || 7, 1), 30);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await many(
    admin
      .from('coin_transactions')
      .select('id, user_id, amount, type, description, created_at, user:users(id, username, avatar_emoji)')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(2000),
    'Could not analyse transactions'
  );

  const byUser = new Map();
  rows.forEach((row) => {
    const key = String(row.user_id);
    const entry = byUser.get(key) || { user: row.user, count: 0, net: 0, largest: 0, lastAt: null };
    entry.count += 1;
    entry.net += Number(row.amount) || 0;
    entry.largest = Math.max(entry.largest, Math.abs(Number(row.amount) || 0));
    entry.lastAt = entry.lastAt || row.created_at;
    byUser.set(key, entry);
  });

  const flags = [];
  rows.forEach((row) => {
    const amount = Math.abs(Number(row.amount) || 0);
    const reasons = [];
    if (amount >= 100000) reasons.push('Single adjustment of 100,000+ coins');
    if (row.type === 'admin_gift' && amount >= 25000) reasons.push('Large administrator grant');
    if (reasons.length) flags.push({ transaction: row, reasons });
  });

  byUser.forEach((entry) => {
    const reasons = [];
    if (entry.count >= 20) reasons.push(`${entry.count} wallet movements in ${days} days`);
    if (Math.abs(entry.net) >= 250000) reasons.push(`${entry.net > 0 ? 'Net inflow' : 'Net outflow'} of ${Math.abs(entry.net).toLocaleString()} coins`);
    if (reasons.length) flags.push({ transaction: null, user: entry.user, summary: { count: entry.count, net: entry.net }, reasons });
  });

  return { days, analysed: rows.length, flagged: flags.slice(0, 100) };
}

async function shopItems() {
  return adminService.avatars();
}

async function createShopItem(actor, req, input, file) {
  const result = await adminService.createAvatar(input, file);
  await audit.record(actor, 'shop.item.create', {
    targetType: 'shop_item',
    targetId: result?.avatar?.id,
    details: { name: result?.avatar?.name, price: result?.avatar?.price },
    req
  });
  return result;
}

async function deleteShopItem(actor, req, id) {
  const result = await adminService.deleteAvatar(toId(id, 'item'));
  await audit.record(actor, 'shop.item.delete', { targetType: 'shop_item', targetId: id, req });
  return result;
}

/* ------------------------------------------------------------
   Leaderboard
   ------------------------------------------------------------ */

const LADDER_TYPES = new Set(['global', 'weekly', 'monthly']);

async function ladder(query = {}) {
  const type = LADDER_TYPES.has(query.type) ? query.type : 'global';
  const data = await leaderboardService.get({ id: 0 }, type);
  const players = (data.players || []).map((player, index) => ({
    ...player,
    position: player.globalRank || index + 1,
    xp: player.xp || 0
  }));
  const suspicious = players.filter((player) => {
    const games = Number(player.wins || 0) + Number(player.losses || 0);
    const rate = games ? Number(player.wins || 0) / games : 0;
    return (games >= 15 && rate >= 0.95) || (Number(player.score) >= 5000 && games < 20);
  });
  return { type, players, myRank: data.myRank ?? null, suspicious };
}

async function listSnapshots(query = {}) {
  const params = listParams(query, 20);
  const type = ['weekly', 'monthly', 'all_time'].includes(query.periodType) ? query.periodType : null;
  let base = admin
    .from('leaderboard_snapshots')
    .select('id, period_type, period_key, label, entries, created_at, created_by', { count: 'exact' });
  if (type) base = base.eq('period_type', type);
  const { data, error, count: total } = await base
    .order('created_at', { ascending: false })
    .range(params.from, params.to);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load leaderboard snapshots');
  const rows = (data || []).map((row) => ({
    ...row,
    entry_count: Array.isArray(row.entries) ? row.entries.length : 0,
    entries: Array.isArray(row.entries) ? row.entries.slice(0, 100) : []
  }));
  return pageResult(rows, total, params);
}

async function createSnapshot(actor, req, { type } = {}) {
  const selected = type === 'weekly' || type === 'monthly' ? type : 'all_time';
  const data = await leaderboardService.get({ id: 0 }, selected === 'all_time' ? 'global' : selected);
  const entries = (data.players || []).slice(0, 100).map((player, index) => ({
    position: index + 1,
    id: player.id,
    username: player.username,
    score: player.score,
    level: player.level,
    rank_title: player.rank_title,
    wins: player.wins,
    losses: player.losses
  }));
  const now = new Date();
  const periodKey =
    selected === 'weekly'
      ? `${now.getUTCFullYear()}-W${String(Math.ceil(((now - Date.UTC(now.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7)).padStart(2, '0')}`
      : selected === 'monthly'
        ? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
        : 'all-time';
  const row = await one(
    admin
      .from('leaderboard_snapshots')
      .insert({
        period_type: selected,
        period_key: periodKey,
        label: `${selected === 'all_time' ? 'All-time' : selected === 'weekly' ? 'Weekly' : 'Monthly'} snapshot · ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        entries,
        created_by: actor.id
      })
      .select('id, period_type, period_key, label, entries, created_at')
      .single(),
    'Could not save the leaderboard snapshot'
  );
  await audit.record(actor, 'leaderboard.snapshot', {
    targetType: 'leaderboard',
    targetId: row.id,
    details: { type: selected, entries: entries.length },
    req
  });
  return { message: `Snapshot saved with ${entries.length} players`, snapshot: row };
}

async function resetLeaderboard(actor, req, { confirmation, includeRecord } = {}) {
  if (String(confirmation || '').trim().toUpperCase() !== 'RESET LEADERBOARD') {
    throw ApiError.badRequest('CONFIRMATION_REQUIRED', 'Type RESET LEADERBOARD to confirm');
  }
  const snapshot = await createSnapshot(actor, req, { type: 'all_time' });
  const affected = await rpc(
    'admin_reset_leaderboard',
    { p_include_record: Boolean(includeRecord) },
    'Could not reset the leaderboard'
  );
  await audit.record(actor, 'leaderboard.reset', {
    targetType: 'leaderboard',
    targetId: 'global',
    details: { affected: Number(affected) || 0, includeRecord: Boolean(includeRecord), snapshotId: snapshot.snapshot?.id },
    req
  });
  return {
    message: `Leaderboard reset for ${Number(affected) || 0} players. A snapshot was saved first.`,
    affected: Number(affected) || 0,
    snapshotId: snapshot.snapshot?.id
  };
}

/* ------------------------------------------------------------
   Community moderation
   ------------------------------------------------------------ */

async function worldChat(query = {}) {
  return operations.worldChat(query);
}

async function deleteWorldMessage(actor, req, id) {
  const result = await operations.deleteWorldMessage(actor, id);
  await audit.record(actor, 'moderation.world_chat.delete', {
    targetType: 'world_message',
    targetId: id,
    req
  });
  return result;
}

async function listReports(query = {}) {
  const params = listParams(query, 25);
  const status = REPORT_STATUSES.has(query.status) ? query.status : null;
  const targetType = ['user', 'chat_message', 'world_message', 'match'].includes(query.targetType)
    ? query.targetType
    : null;
  let base = admin
    .from('content_reports')
    .select(
      'id, reporter_id, target_type, target_id, reason, details, status, resolution, assigned_to, created_at, resolved_at, ' +
        'reporter:users!content_reports_reporter_id_fkey(id, username, avatar_emoji)',
      { count: 'exact' }
    );
  if (status) base = base.eq('status', status);
  if (targetType) base = base.eq('target_type', targetType);
  const { data, error, count: total } = await base
    .order('created_at', { ascending: false })
    .range(params.from, params.to);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load reports');
  return pageResult(data || [], total, params);
}

async function reportTargetUser(report) {
  if (!report) return null;
  if (report.target_type === 'user') return Number(report.target_id) || null;
  if (report.target_type === 'world_message') {
    const row = await one(
      admin.from('world_chat_messages').select('sender_id').eq('id', Number(report.target_id)).maybeSingle(),
      'Could not load the reported message'
    ).catch(() => null);
    return row?.sender_id || null;
  }
  if (report.target_type === 'chat_message') {
    const row = await one(
      admin.from('chat_messages').select('sender_id').eq('id', Number(report.target_id)).maybeSingle(),
      'Could not load the reported message'
    ).catch(() => null);
    return row?.sender_id || null;
  }
  if (report.target_type === 'match') {
    const row = await one(
      admin.from('matches').select('player1_id, player2_id').eq('id', Number(report.target_id)).maybeSingle(),
      'Could not load the reported match'
    ).catch(() => null);
    return row ? [row.player1_id, row.player2_id].filter(Boolean) : null;
  }
  return null;
}

async function updateReport(actor, req, id, { status, resolution, removeContent, restrict } = {}) {
  const reportId = toId(id, 'report');
  const nextStatus = REPORT_STATUSES.has(status) ? status : null;
  if (!nextStatus) throw ApiError.badRequest('INVALID_STATUS', 'Choose open, reviewing, resolved or dismissed');
  const note = cleanMultiline(resolution, 1000);
  if (nextStatus === 'resolved' && note.length < 3) {
    throw ApiError.badRequest('RESOLUTION_REQUIRED', 'Add a short resolution note');
  }

  const report = await one(
    admin.from('content_reports').select('*').eq('id', reportId).maybeSingle(),
    'Could not load that report'
  );
  if (!report) throw ApiError.notFound('REPORT_NOT_FOUND', 'Report not found');

  if (removeContent) {
    if (report.target_type === 'world_message') {
      await admin.from('world_chat_messages').delete().eq('id', Number(report.target_id));
    } else if (report.target_type === 'chat_message') {
      await admin.from('chat_messages').delete().eq('id', Number(report.target_id));
    } else {
      throw ApiError.badRequest('CANNOT_REMOVE', 'This report does not point at removable content');
    }
  }

  const targetUser = await reportTargetUser(report);
  if (restrict && targetUser) {
    const userId = Array.isArray(targetUser) ? targetUser[0] : targetUser;
    await createRestriction(actor, req, {
      userId,
      type: restrict.type || 'world_chat',
      reason: note || `Report #${reportId}: ${report.reason}`,
      hours: restrict.hours || 24
    });
  }

  const row = await one(
    admin
      .from('content_reports')
      .update({
        status: nextStatus,
        resolution: note || null,
        assigned_to: report.assigned_to || actor.id,
        resolved_by: nextStatus === 'resolved' || nextStatus === 'dismissed' ? actor.id : null,
        resolved_at: nextStatus === 'resolved' || nextStatus === 'dismissed' ? new Date().toISOString() : null
      })
      .eq('id', reportId)
      .select('id, status, resolution, assigned_to, resolved_at')
      .single(),
    'Could not update the report'
  );

  if (report.reporter_id) {
    await notify(report.reporter_id, {
      type: 'system',
      title: 'Report update',
      description: note ? `Your report was ${nextStatus}: ${note}` : `Your report is now ${nextStatus}.`
    });
  }
  await audit.record(actor, 'moderation.report.update', {
    targetType: 'content_report',
    targetId: reportId,
    details: { status: nextStatus, removedContent: Boolean(removeContent), restricted: Boolean(restrict) },
    req
  });
  return { message: 'Report updated', report: row };
}

async function listRestrictions(query = {}) {
  const params = listParams(query, 25);
  const status = query.status === 'active' || query.status === 'revoked' ? query.status : 'active';
  let base = admin
    .from('user_restrictions')
    .select(
      'id, user_id, type, reason, expires_at, revoked_at, created_at, ' +
        'user:users!user_restrictions_user_id_fkey(id, username, avatar_emoji, avatar_url), ' +
        'creator:users!user_restrictions_created_by_fkey(id, username)',
      { count: 'exact' }
    );
  if (status === 'revoked') base = base.not('revoked_at', 'is', null);
  else base = base.is('revoked_at', null).or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
  if (query.type && RESTRICTION_TYPES.has(query.type)) base = base.eq('type', query.type);
  const { data, error, count: total } = await base
    .order('created_at', { ascending: false })
    .range(params.from, params.to);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load restrictions');
  return pageResult(data || [], total, params);
}

async function createRestriction(actor, req, { userId, username, type, reason, hours } = {}) {
  let playerId = userId ? toId(userId, 'player') : null;
  if (!playerId) {
    const name = cleanText(username, 24);
    if (!name) throw ApiError.badRequest('USER_REQUIRED', 'Choose a player');
    const player = await one(admin.from('users').select('id').ilike('username', name).maybeSingle(), 'Could not find that player');
    if (!player) throw ApiError.notFound('USER_NOT_FOUND', 'Player not found');
    playerId = player.id;
  }
  const kind = RESTRICTION_TYPES.has(type) ? type : 'world_chat';
  const duration = Math.min(Math.max(Number(hours) || 0, 0), 24 * 365);
  const row = await one(
    admin
      .from('user_restrictions')
      .insert({
        user_id: playerId,
        type: kind,
        reason: cleanText(reason, 300) || 'Community guidelines',
        expires_at: duration > 0 ? new Date(Date.now() + duration * 3600000).toISOString() : null,
        created_by: actor.id
      })
      .select('id, user_id, type, reason, expires_at, created_at')
      .single(),
    'Could not apply the restriction'
  );
  restrictionService.invalidate(playerId);
  await notify(playerId, {
    type: 'system',
    title: 'Account restriction',
    description: `You are restricted from ${kind.replace('_', ' ')}${duration ? ` for ${duration} hour${duration === 1 ? '' : 's'}` : ''}. Reason: ${row.reason}`
  });
  await audit.record(actor, 'moderation.restriction.create', {
    targetType: 'user',
    targetId: playerId,
    details: { type: kind, hours: duration, reason: row.reason },
    req
  });
  return { message: 'Restriction applied', restriction: row };
}

async function revokeRestriction(actor, req, id) {
  const restrictionId = toId(id, 'restriction');
  const row = await one(
    admin
      .from('user_restrictions')
      .update({ revoked_at: new Date().toISOString(), revoked_by: actor.id })
      .eq('id', restrictionId)
      .is('revoked_at', null)
      .select('id, user_id, type')
      .maybeSingle(),
    'Could not lift the restriction'
  );
  if (!row) throw ApiError.notFound('RESTRICTION_NOT_FOUND', 'Active restriction not found');
  restrictionService.invalidate(row.user_id);
  await notify(row.user_id, {
    type: 'system',
    title: 'Restriction lifted',
    description: `Your ${String(row.type).replace('_', ' ')} restriction has been lifted by the arena team.`
  });
  await audit.record(actor, 'moderation.restriction.revoke', {
    targetType: 'user',
    targetId: row.user_id,
    details: { restrictionId, type: row.type },
    req
  });
  return { message: 'Restriction lifted' };
}

async function moderationSettings() {
  const [moderation, chat] = await Promise.all([settingsService.moderation(), settingsService.chat()]);
  return { moderation, chat };
}

async function saveModerationSettings(actor, req, { moderation, chat } = {}) {
  const saved = {};
  if (moderation) {
    const row = await settingsService.set(actor, 'moderation', moderation, { req });
    saved.moderation = row.value;
  }
  if (chat) {
    const row = await settingsService.set(actor, 'chat', chat, { req });
    saved.chat = row.value;
  }
  if (!Object.keys(saved).length) throw ApiError.badRequest('NO_CHANGES', 'No moderation settings were supplied');
  return { message: 'Moderation settings saved', ...saved };
}

module.exports = {
  economySummary,
  listTransactions,
  adjustCoins,
  suspiciousTransactions,
  shopItems,
  createShopItem,
  deleteShopItem,
  ladder,
  listSnapshots,
  createSnapshot,
  resetLeaderboard,
  worldChat,
  deleteWorldMessage,
  listReports,
  updateReport,
  reportTargetUser,
  listRestrictions,
  createRestriction,
  revokeRestriction,
  moderationSettings,
  saveModerationSettings
};
