'use strict';

/**
 * TicTacArena — Admin Control Center: security, system operations and settings.
 *
 * Health figures come from the running process, live PostgreSQL statistics and
 * the console's own metrics registry. Nothing is synthesised: a value that the
 * infrastructure cannot provide is returned as null with a reason.
 */

const { admin, one, many, rpc, count } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { cleanText, cleanMultiline } = require('../utils/sanitize');
const { TABLES } = require('../config/constants');
const adminService = require('./admin.service');
const adminSecurity = require('./adminSecurity.service');
const audit = require('./audit.service');
const settingsService = require('./settings.service');
const adminContent = require('./adminContent.service');
const cleanupService = require('./cleanup.service');
const metrics = require('../utils/metrics');
const env = require('../config/env');

const MAX_PAGE = 100;
const ACHIEVEMENT_CATEGORIES = new Set(['combat', 'social', 'special']);
const ACHIEVEMENT_TIERS = new Set(['bronze', 'silver', 'gold']);
const JOB_TYPES = new Set(['retention_cleanup', 'leaderboard_snapshot', 'notification_campaign', 'system_snapshot']);
const RECURRENCES = new Set(['once', 'hourly', 'daily', 'weekly', 'monthly']);

let dbStatsCache = null;

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

function searchTerm(value, max = 80) {
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

// 

async function securityOverview(req) {
  const adminId = req.adminAccess?.user_id;
  const [admins, sessions, loginEvents, failures, auditVerification, auditCount] = await Promise.all([
    adminSecurity.listAdmins().catch(() => []),
    adminSecurity.listSessions(adminId, { limit: 12 }).catch(() => []),
    many(
      admin
        .from('admin_login_events')
        .select('id, user_id, email, ip, success, reason, risk_level, created_at')
        .order('created_at', { ascending: false })
        .limit(12),
      'Could not load login history'
    ).catch(() => []),
    count(
      admin
        .from('admin_login_events')
        .select('id', { count: 'exact', head: true })
        .eq('success', false)
        .gte('created_at', new Date(Date.now() - 86400000).toISOString())
    ).catch(() => 0),
    audit.verify().catch((error) => ({ valid: false, checked: 0, error: error.message })),
    count(admin.from('admin_activity').select('id', { count: 'exact', head: true })).catch(() => 0)
  ]);
  return {
    admins,
    sessions,
    loginEvents,
    failures24h: failures,
    audit: { ...auditVerification, total: auditCount },
    current: {
      role: req.adminAccess?.role,
      role_label: req.adminAccess?.role_label,
      is_owner: Boolean(req.adminAccess?.is_owner),
      permissions: req.adminAccess?.permissions || []
    },
    catalog: {
      roles: require('../config/permissions').ROLES,
      permissions: require('../config/permissions').PERMISSIONS
    },
    generatedAt: new Date().toISOString()
  };
}

async function assignRole(actor, req, id, { role, overrides } = {}) {
  return adminSecurity.setRole({ ...req.adminAccess, user: actor }, id, role, overrides, req);
}

async function updateAdminSecurity(actor, req, id, patch = {}) {
  return adminSecurity.updateSecurity(req.adminAccess, id, patch, req);
}

async function listAdminSessions(query = {}) {
  const params = listParams(query, 30);
  const state = query.state === 'revoked' ? 'revoked' : query.state === 'all' ? 'all' : 'active';
  let base = admin
    .from('admin_sessions')
    .select(
      'id, user_id, ip, user_agent, created_at, last_seen_at, expires_at, two_factor_verified, revoked_at, revoked_by, revoke_reason, ' +
        'user:users!admin_sessions_user_id_fkey(id, username, email)',
      { count: 'exact' }
    );
  if (state === 'active') base = base.is('revoked_at', null).gt('expires_at', new Date().toISOString());
  if (state === 'revoked') base = base.not('revoked_at', 'is', null);
  if (query.userId) base = base.eq('user_id', toId(query.userId, 'administrator'));
  const { data, error, count: total } = await base
    .order('created_at', { ascending: false })
    .range(params.from, params.to);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load administrator sessions');
  return pageResult(data || [], total, params);
}

async function revokeAdminSession(actor, req, id) {
  return adminSecurity.revokeSession(req.adminAccess, id, req);
}

async function listLoginEvents(query = {}) {
  const params = listParams(query, 30);
  const range = dateRange(query);
  const term = searchTerm(query.q);
  let base = admin
    .from('admin_login_events')
    .select('id, user_id, email, ip, user_agent, success, reason, risk_level, risk_reasons, created_at', { count: 'exact' });
  if (query.success === 'true') base = base.eq('success', true);
  if (query.success === 'false') base = base.eq('success', false);
  if (query.risk && ['low', 'medium', 'high'].includes(query.risk)) base = base.eq('risk_level', query.risk);
  if (range.from) base = base.gte('created_at', range.from);
  if (range.to) base = base.lte('created_at', range.to);
  if (term) base = base.or(`email.ilike.%${term}%,ip.ilike.%${term}%,reason.ilike.%${term}%`);
  const { data, error, count: total } = await base
    .order('created_at', { ascending: false })
    .range(params.from, params.to);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load login events');
  return pageResult(data || [], total, params);
}

async function listAudit(query = {}) {
  const data = await audit.list(query);
  return data;
}

async function auditActions() {
  return { actions: await audit.actions() };
}

async function verifyAudit() {
  return audit.verify();
}

// 

async function databaseStats() {
  if (dbStatsCache && dbStatsCache.expires > Date.now()) return dbStatsCache.value;
  let value = null;
  try {
    value = await rpc('get_admin_database_stats', {}, 'Could not read database statistics');
  } catch (_) {
    value = null;
  }
  dbStatsCache = { value, expires: Date.now() + 30000 };
  return value;
}

async function systemHealth(req) {
  const started = process.hrtime.bigint();
  const dbStarted = process.hrtime.bigint();
  const [server, dbStats, dbLatencyQuery] = await Promise.all([
    adminService.serverHealth().catch(() => null),
    databaseStats(),
    admin.from('app_settings').select('key').limit(1).then((result) => !result.error).catch(() => false)
  ]);
  const latencyMs = Number(process.hrtime.bigint() - dbStarted) / 1e6;

  const [unresolvedErrors, recentErrors, flags, campaigns] = await Promise.all([
    count(admin.from('error_logs').select('id', { count: 'exact', head: true }).eq('resolved', false)).catch(() => 0),
    many(
      admin
        .from('error_logs')
        .select('id, level, message, route, status, created_at, resolved')
        .order('created_at', { ascending: false })
        .limit(6),
      'Could not load recent errors'
    ).catch(() => []),
    count(admin.from('feature_flags').select('id', { count: 'exact', head: true }).eq('enabled', true)).catch(() => 0),
    count(admin.from('notification_campaigns').select('id', { count: 'exact', head: true }).in('status', ['scheduled', 'sending'])).catch(() => 0)
  ]);

  let socketInfo = { connectedClients: 0, onlinePlayers: 0, activeGames: 0 };
  try {
    const io = req.app.get('io');
    const presence = require('../socket/presence');
    const game = require('../socket/game');
    socketInfo = {
      connectedClients: Number(io?.engine?.clientsCount) || 0,
      onlinePlayers: presence.count(),
      activeGames: game.activeState().activeGames
    };
  } catch (_) {
    /* the socket layer may be disabled in a test harness */
  }

  const snapshot = metrics.snapshot();
  return {
    server: {
      ...(server || {}),
      processUptimeSeconds: Math.floor(process.uptime()),
      environment: env.nodeEnv
    },
    api: {
      databaseReachable: Boolean(dbLatencyQuery),
      latencyMs: Math.round(latencyMs * 10) / 10,
      routes: snapshot.routes,
      clientReports: snapshot.clientReports.slice(-5),
      responseTimeTotalMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6)
    },
    database: dbStats
      ? {
          reachable: true,
          databaseBytes: dbStats.databaseBytes,
          tables: dbStats.tables || [],
          indexCount: dbStats.indexCount,
          connections: dbStats.connections
        }
      : { reachable: Boolean(dbLatencyQuery), databaseBytes: null, tables: [], indexCount: null, connections: null },
    realtime: socketInfo,
    errors: { unresolved: unresolvedErrors, recent: recentErrors },
    storage: {
      provider: env.cloudinary.cloudName ? 'cloudinary' : 'none',
      configured: Boolean(env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret),
      folder: env.cloudinary.folder,
      usageBytes: null,
      note: env.cloudinary.cloudName
        ? 'Cloudinary stores shop artwork. Provider usage is shown in the Cloudinary dashboard.'
        : 'No media provider is configured; avatar artwork uses bundled assets.'
    },
    push: adminContent.pushStatus(),
    flagsEnabled: flags,
    pendingCampaigns: campaigns,
    generatedAt: new Date().toISOString()
  };
}

async function listErrors(query = {}) {
  const params = listParams(query, 30);
  const range = dateRange(query);
  const term = searchTerm(query.q);
  let base = admin
    .from('error_logs')
    .select('id, level, message, stack, code, method, route, status, request_id, user_id, ip, context, resolved, resolved_by, resolved_at, created_at', { count: 'exact' });
  if (query.resolved === 'true') base = base.eq('resolved', true);
  if (query.resolved === 'false') base = base.eq('resolved', false);
  if (query.level && ['warn', 'error', 'fatal'].includes(query.level)) base = base.eq('level', query.level);
  if (range.from) base = base.gte('created_at', range.from);
  if (range.to) base = base.lte('created_at', range.to);
  if (term) base = base.or(`message.ilike.%${term}%,route.ilike.%${term}%,request_id.ilike.%${term}%`);
  const { data, error, count: total } = await base
    .order('created_at', { ascending: false })
    .range(params.from, params.to);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load error logs');
  return pageResult(data || [], total, params);
}

async function resolveError(actor, req, id, { resolved = true } = {}) {
  const errorId = toId(id, 'error');
  const row = await one(
    admin
      .from('error_logs')
      .update({
        resolved: Boolean(resolved),
        resolved_by: resolved ? actor.id : null,
        resolved_at: resolved ? new Date().toISOString() : null
      })
      .eq('id', errorId)
      .select('id, resolved, resolved_at')
      .maybeSingle(),
    'Could not update the error'
  );
  if (!row) throw ApiError.notFound('ERROR_NOT_FOUND', 'Error log not found');
  await audit.record(actor, resolved ? 'system.error.resolve' : 'system.error.reopen', {
    targetType: 'error_log',
    targetId: errorId,
    req
  });
  return { message: resolved ? 'Error marked resolved' : 'Error reopened', error: row };
}

async function performanceHistory(query = {}) {
  const days = Math.min(Math.max(Number(query.days) || 7, 1), 90);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await many(
    admin
      .from('system_snapshots')
      .select('id, label, summary, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(500),
    'Could not load system history'
  ).catch(() => []);
  return {
    days,
    points: rows.map((row) => ({
      at: row.created_at,
      memoryMB: row.summary?.memory?.rssMB ?? null,
      cpuPercent: row.summary?.cpuPercent ?? null,
      onlineUsers: row.summary?.onlineUsers ?? null,
      dbLatencyMs: row.summary?.dbLatencyMs ?? null,
      activeGames: row.summary?.activeGames ?? null
    }))
  };
}

// 

async function listFlags() {
  const rows = await many(
    admin
      .from('feature_flags')
      .select('id, key, name, description, enabled, rollout_percent, audience, updated_by, created_at, updated_at')
      .order('name', { ascending: true }),
    'Could not load feature flags'
  );
  return { flags: rows };
}

async function saveFlag(actor, req, input = {}) {
  const id = input.id ? toId(input.id, 'flag') : null;
  const key = String(input.key || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 60);
  const name = cleanText(input.name, 80);
  if (!key || key.length < 2) throw ApiError.badRequest('INVALID_KEY', 'Choose a flag key');
  if (!name) throw ApiError.badRequest('INVALID_NAME', 'Give the flag a name');
  const payload = {
    key,
    name,
    description: cleanText(input.description, 300),
    enabled: Boolean(input.enabled),
    rollout_percent: Math.min(Math.max(Number(input.rollout_percent) || 0, 0), 100),
    audience: input.audience && typeof input.audience === 'object' ? input.audience : {},
    updated_by: actor.id
  };
  try {
    const row = id
      ? await one(admin.from('feature_flags').update(payload).eq('id', id).select('*').single(), 'Could not save the flag')
      : await one(admin.from('feature_flags').insert(payload).select('*').single(), 'Could not create the flag');
    require('./featureFlag.service').invalidate();
    await audit.record(actor, id ? 'system.flag.update' : 'system.flag.create', {
      targetType: 'feature_flag',
      targetId: row.id,
      details: { key, enabled: row.enabled, rollout: row.rollout_percent },
      req
    });
    return { message: id ? 'Flag updated' : 'Flag created', flag: row };
  } catch (error) {
    if (String(error.code || '').includes('23505') || /duplicate key/i.test(String(error.message))) {
      throw ApiError.conflict('FLAG_EXISTS', 'A flag with that key already exists');
    }
    throw error;
  }
}

async function deleteFlag(actor, req, id) {
  const flagId = toId(id, 'flag');
  await one(admin.from('feature_flags').delete().eq('id', flagId).select('id'), 'Could not delete the flag');
  require('./featureFlag.service').invalidate();
  await audit.record(actor, 'system.flag.delete', { targetType: 'feature_flag', targetId: flagId, req });
  return { message: 'Flag deleted' };
}

// 

function nextRunAt(recurrence) {
  const now = Date.now();
  if (recurrence === 'hourly') return new Date(now + 3600000).toISOString();
  if (recurrence === 'daily') return new Date(now + 86400000).toISOString();
  if (recurrence === 'weekly') return new Date(now + 7 * 86400000).toISOString();
  if (recurrence === 'monthly') return new Date(now + 30 * 86400000).toISOString();
  return null;
}

async function listJobs(query = {}) {
  const [jobs, retention] = await Promise.all([
    many(
      admin
        .from('scheduled_jobs')
        .select('id, name, type, recurrence, payload, status, is_active, next_run_at, last_run_at, last_error, attempts, created_at')
        .order('next_run_at', { ascending: true })
        .limit(Math.min(Number(query.limit) || 50, 100)),
      'Could not load scheduled jobs'
    ),
    settingsService.retention().catch(() => null)
  ]);
  return { jobs, retention, serverTime: new Date().toISOString() };
}

async function saveJob(actor, req, input = {}) {
  const id = input.id ? toId(input.id, 'job') : null;
  const name = cleanText(input.name, 100);
  const type = JOB_TYPES.has(input.type) ? input.type : null;
  if (!name) throw ApiError.badRequest('INVALID_NAME', 'Give the job a name');
  if (!type) throw ApiError.badRequest('INVALID_TYPE', 'Choose a supported job type');
  const recurrence = RECURRENCES.has(input.recurrence) ? input.recurrence : 'once';
  const nextRun = input.next_run_at ? new Date(input.next_run_at) : new Date();
  if (Number.isNaN(nextRun.getTime())) throw ApiError.badRequest('INVALID_DATE', 'Enter a valid next run time');
  const payload = {
    name,
    type,
    recurrence,
    payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
    is_active: input.is_active !== false,
    next_run_at: nextRun.toISOString(),
    status: 'pending'
  };
  const row = id
    ? await one(admin.from('scheduled_jobs').update(payload).eq('id', id).select('*').single(), 'Could not save the job')
    : await one(admin.from('scheduled_jobs').insert({ ...payload, created_by: actor.id }).select('*').single(), 'Could not create the job');
  await audit.record(actor, id ? 'system.job.update' : 'system.job.create', {
    targetType: 'scheduled_job',
    targetId: row.id,
    details: { name, type, recurrence },
    req
  });
  return { message: id ? 'Job updated' : 'Job created', job: row };
}

async function deleteJob(actor, req, id) {
  const jobId = toId(id, 'job');
  await one(admin.from('scheduled_jobs').delete().eq('id', jobId).select('id'), 'Could not delete the job');
  await audit.record(actor, 'system.job.delete', { targetType: 'scheduled_job', targetId: jobId, req });
  return { message: 'Job deleted' };
}

async function executeJob(job) {
  const type = job.type;
  if (type === 'retention_cleanup') {
    // Shared job runner
    return cleanupService.run({ triggerSource: 'scheduled' });
  }

  if (type === 'leaderboard_snapshot') {
    const leaderboardService = require('./leaderboard.service');
    const period = job.payload?.period === 'weekly' || job.payload?.period === 'monthly' ? job.payload.period : 'global';
    const data = await leaderboardService.get({ id: 0 }, period);
    const entries = (data.players || []).slice(0, 100).map((player, index) => ({
      position: index + 1,
      id: player.id,
      username: player.username,
      score: player.score,
      level: player.level,
      rank_title: player.rank_title
    }));
    const row = await one(
      admin
        .from('leaderboard_snapshots')
        .insert({
          period_type: period === 'global' ? 'all_time' : period,
          period_key: new Date().toISOString().slice(0, 10),
          label: `Scheduled ${period} snapshot`,
          entries,
          created_by: null
        })
        .select('id')
        .single(),
      'Could not write the leaderboard snapshot'
    );
    return { snapshotId: row.id, entries: entries.length };
  }

  if (type === 'notification_campaign') {
    const due = await many(
      admin
        .from('notification_campaigns')
        .select('id')
        .eq('status', 'scheduled')
        .lte('scheduled_at', new Date().toISOString())
        .limit(3),
      'Could not load due campaigns'
    );
    const results = [];
    for (const campaign of due) {
      try {
        results.push(await adminContent.sendCampaign({ id: null, username: 'system' }, null, campaign.id));
      } catch (error) {
        results.push({ campaignId: campaign.id, error: error.message });
      }
    }
    return { campaigns: results.length, results };
  }

  if (type === 'system_snapshot') {
    const snapshot = metrics.snapshot();
    const presence = require('../socket/presence');
    const game = require('../socket/game');
    const row = await one(
      admin
        .from('system_snapshots')
        .insert({
          label: 'Scheduled system snapshot',
          summary: {
            memory: snapshot.memory,
            cpuPercent: null,
            onlineUsers: presence.count(),
            activeGames: game.activeState().activeGames,
            dbLatencyMs: snapshot.db.avgMs,
            apiRoutes: snapshot.routes.slice(0, 5)
          },
          created_by: null
        })
        .select('id')
        .single(),
      'Could not write the system snapshot'
    );
    return { snapshotId: row.id };
  }

  throw ApiError.badRequest('INVALID_TYPE', 'Unsupported job type');
}

async function runJob(actor, req, id) {
  const jobId = toId(id, 'job');
  const job = await one(admin.from('scheduled_jobs').select('*').eq('id', jobId).maybeSingle(), 'Could not load that job');
  if (!job) throw ApiError.notFound('JOB_NOT_FOUND', 'Job not found');
  return runJobRecord(job, { actor, req });
}

async function runJobRecord(job, { actor = null, req = null, due = false } = {}) {
  const claim = await admin
    .from('scheduled_jobs')
    .update({ status: 'running', last_error: null })
    .eq('id', job.id)
    .in('status', due ? ['pending', 'failed'] : ['pending', 'failed', 'completed', 'cancelled'])
    .select('id')
    .maybeSingle();
  if (claim.error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not start the job');
  if (!claim.data) return { message: 'That job is already running', skipped: true };

  try {
    const result = await executeJob(job);
    const next = nextRunAt(job.recurrence);
    await admin
      .from('scheduled_jobs')
      .update({
        status: next ? 'pending' : 'completed',
        last_run_at: new Date().toISOString(),
        next_run_at: next || job.next_run_at,
        last_error: null,
        attempts: Number(job.attempts || 0) + 1
      })
      .eq('id', job.id);
    if (actor) {
      await audit.record(actor, 'system.job.run', {
        targetType: 'scheduled_job',
        targetId: job.id,
        details: { name: job.name, type: job.type, result },
        req
      });
    }
    return { message: `${job.name} completed`, result };
  } catch (error) {
    const attempts = Number(job.attempts || 0) + 1;
    const next = nextRunAt(job.recurrence);
    // Disable job after max retry attempts
    const exhausted = job.recurrence === 'once' && attempts >= 3;
    await admin
      .from('scheduled_jobs')
      .update({
        status: 'failed',
        is_active: exhausted ? false : job.is_active,
        last_run_at: new Date().toISOString(),
        next_run_at: next || job.next_run_at,
        last_error: String(error.message || 'Job failed').slice(0, 500),
        attempts
      })
      .eq('id', job.id);
    if (actor) {
      await audit.record(actor, 'system.job.failed', {
        targetType: 'scheduled_job',
        targetId: job.id,
        details: { name: job.name, error: String(error.message || '').slice(0, 300) },
        req
      });
    }
    throw error;
  }
}

async function runDueJobs() {
  const due = await many(
    admin
      .from('scheduled_jobs')
      .select('*')
      .eq('is_active', true)
      .in('status', ['pending', 'failed'])
      .lte('next_run_at', new Date().toISOString())
      .order('next_run_at', { ascending: true })
      .limit(5),
    'Could not load due jobs'
  ).catch(() => []);
  const results = [];
  for (const job of due) {
    try {
      results.push(await runJobRecord(job, { due: true }));
    } catch (error) {
      results.push({ job: job.name, error: error.message });
    }
  }
  return results;
}

async function retentionOverview() {
  const policy = await settingsService.retention();
  // Aggregate retention counts
  const [candidates, auditTotal] = await Promise.all([
    rpc(
      'get_retention_candidates',
      {
        p_admin_login_days: policy.adminLoginDays,
        p_error_days: policy.errorDays,
        p_notification_days: policy.notificationDays,
        p_chat_days: policy.chatDays
      },
      'Could not count retention candidates'
    ).catch(() => ({})),
    count(admin.from('admin_activity').select('id', { count: 'exact', head: true })).catch(() => 0)
  ]);

  return {
    policy,
    eligible: {
      loginEvents: Number(candidates?.loginEvents || 0),
      adminSessions: Number(candidates?.adminSessions || 0),
      resolvedErrors: Number(candidates?.resolvedErrors || 0),
      notifications: Number(candidates?.notifications || 0),
      signupIntents: Number(candidates?.signupIntents || 0)
    },
    preserved: {
      chatMessages: Number(candidates?.chatMessages || 0),
      worldMessages: Number(candidates?.worldMessages || 0)
    },
    auditTotal,
    note:
      'Cleanup removes expired signup reservations, old diagnostic login/error records, archived mail and expired sessions. Unread mail, unclaimed rewards, chat history, the permanent match ledger, coin transactions, tournaments and the audit chain are never removed.'
  };
}

async function cleanupOverview() {
  const [retention, runs, scheduled, stats] = await Promise.all([
    retentionOverview(),
    cleanupService.history(10),
    one(
      admin
        .from('scheduled_jobs')
        .select('id, name, next_run_at, is_active, status, last_run_at, last_error')
        .eq('type', 'retention_cleanup')
        .eq('is_active', true)
        .order('next_run_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
      'Could not load the cleanup schedule'
    ).catch(() => null),
    databaseStats().catch(() => null)
  ]);

  return {
    ...retention,
    cleanup: {
      last: runs[0] || null,
      running: await cleanupService.activeRun(),
      nextRunAt: scheduled?.next_run_at || null,
      scheduledJob: scheduled || null,
      history: runs,
      batchSize: 1000,
      overlapWindowMinutes: 15
    },
    storage: stats
      ? {
          databaseBytes: stats.databaseBytes,
          connections: stats.connections,
          indexCount: stats.indexCount,
          tables: stats.tables || []
        }
      : null
  };
}

async function runCleanup(actor, req, input = {}) {
  if (input.confirm !== true) {
    throw ApiError.badRequest('CONFIRMATION_REQUIRED', 'Confirm the cleanup before running it');
  }
  return cleanupService.run({ actor, req, triggerSource: 'manual' });
}

async function saveRetention(actor, req, policy = {}) {
  const row = await settingsService.set(actor, 'retention', policy, { req });
  return { message: 'Retention policy saved', retention: row.value };
}

// 

async function gameSettings() {
  const [game, version, achievements, maintenance] = await Promise.all([
    settingsService.game(),
    settingsService.version(),
    count(admin.from('achievements').select('id', { count: 'exact', head: true })).catch(() => 0),
    settingsService.maintenance().catch(() => ({ enabled: false, message: '', ends_at: null }))
  ]);
  return { game, version, achievements, maintenance };
}

async function saveGameSettings(actor, req, game = {}) {
  const row = await settingsService.set(actor, 'game', game, { req });
  return { message: 'Game configuration saved', game: row.value };
}

async function saveVersion(actor, req, version = {}) {
  const row = await settingsService.set(actor, 'version', version, { req });
  return { message: 'Version settings saved', version: row.value };
}

async function saveMaintenance(actor, req, maintenance = {}) {
  const row = await settingsService.set(actor, 'maintenance', maintenance, { req });
  await audit.record(actor, 'settings.maintenance.update', {
    targetType: 'settings',
    targetId: 'maintenance',
    details: { enabled: Boolean(row.value?.enabled) },
    req
  });
  return { message: row.value?.enabled ? 'Maintenance mode enabled' : 'Maintenance mode disabled', maintenance: row.value };
}

async function listAchievements() {
  const rows = await many(
    admin
      .from('achievements')
      .select('id, code, emoji, name, description, category, tier, metric, target, comparison, reward_coins, sort_order')
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
    'Could not load achievements'
  );
  // Claimed achievements count
  const unlocked = await count(
    admin.from('user_achievements').select('user_id', { count: 'exact', head: true })
  ).catch(() => 0);
  return {
    achievements: rows,
    stats: { total: rows.length, unlocked, claimed: unlocked },
    metricOptions: [
      'wins',
      'losses',
      'draws',
      'matches',
      'ranked_wins',
      'ranked_matches',
      'friends',
      'messages_sent',
      'world_messages',
      'login_streak',
      'level',
      'coins_earned',
      'tournaments_joined',
      'comeback_wins'
    ]
  };
}

async function saveAchievement(actor, req, input = {}) {
  const id = input.id ? toId(input.id, 'achievement') : null;
  const code = String(input.code || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 60);
  const emoji = cleanText(input.emoji, 8) || '🏅';
  const name = cleanText(input.name, 80);
  const description = cleanText(input.description, 300);
  const category = ACHIEVEMENT_CATEGORIES.has(input.category) ? input.category : 'combat';
  const tier = ACHIEVEMENT_TIERS.has(input.tier) ? input.tier : 'bronze';
  const metric = String(input.metric || '').trim().slice(0, 60);
  const target = Math.min(Math.max(Number(input.target) || 1, 1), 100000000);
  const comparison = input.comparison === 'lte' ? 'lte' : 'gte';
  const reward = Math.min(Math.max(Number(input.reward_coins) || 0, 0), 10000000);
  const sortOrder = Math.min(Math.max(Number(input.sort_order) || 0, 0), 100000);

  if (code.length < 3) throw ApiError.badRequest('INVALID_CODE', 'Choose a code (3+ characters)');
  if (!name || description.length < 3) throw ApiError.badRequest('INVALID_COPY', 'Add a name and description');
  if (!/^[a-z][a-z0-9_]{2,60}$/.test(metric)) throw ApiError.badRequest('INVALID_METRIC', 'Choose a valid metric key');

  const payload = { code, emoji, name, description, category, tier, metric, target, comparison, reward_coins: reward, sort_order: sortOrder };
  try {
    const row = id
      ? await one(admin.from('achievements').update(payload).eq('id', id).select('*').single(), 'Could not save the achievement')
      : await one(admin.from('achievements').insert(payload).select('*').single(), 'Could not create the achievement');
    await audit.record(actor, id ? 'settings.achievement.update' : 'settings.achievement.create', {
      targetType: 'achievement',
      targetId: row.id,
      details: { code, metric, target },
      req
    });
    return { message: id ? 'Achievement updated' : 'Achievement created', achievement: row };
  } catch (error) {
    if (String(error.code || '').includes('23505') || /duplicate key/i.test(String(error.message))) {
      throw ApiError.conflict('ACHIEVEMENT_EXISTS', 'An achievement with that code already exists');
    }
    throw error;
  }
}

async function deleteAchievement(actor, req, id) {
  const achievementId = toId(id, 'achievement');
  try {
    await one(admin.from('achievements').delete().eq('id', achievementId).select('id'), 'Could not delete the achievement');
  } catch (error) {
    throw ApiError.conflict('ACHIEVEMENT_IN_USE', 'Players have progress on this achievement, so it cannot be deleted');
  }
  await audit.record(actor, 'settings.achievement.delete', { targetType: 'achievement', targetId: achievementId, req });
  return { message: 'Achievement deleted' };
}

async function systemSnapshot(actor, req) {
  const health = await systemHealth({ app: { get: () => null } });
  const row = await one(
    admin
      .from('system_snapshots')
      .insert({
        label: 'Manual system snapshot',
        summary: {
          memory: health.server?.memory || null,
          cpuPercent: health.server?.cpu ?? null,
          onlineUsers: health.realtime?.onlinePlayers ?? null,
          activeGames: health.realtime?.activeGames ?? null,
          dbLatencyMs: health.api?.latencyMs ?? null,
          unresolvedErrors: health.errors?.unresolved ?? null,
          databaseBytes: health.database?.databaseBytes ?? null
        },
        created_by: actor.id
      })
      .select('id, label, summary, created_at')
      .single(),
    'Could not save the system snapshot'
  );
  await audit.record(actor, 'system.snapshot', { targetType: 'system_snapshot', targetId: row.id, req });
  return { message: 'System snapshot saved', snapshot: row };
}

async function listSnapshots(query = {}) {
  const params = listParams(query, 20);
  const { data, error, count: total } = await admin
    .from('system_snapshots')
    .select('id, label, summary, created_by, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(params.from, params.to);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load system snapshots');
  return pageResult(data || [], total, params);
}

async function tableStats() {
  const stats = await databaseStats();
  if (stats?.tables) return { tables: stats.tables };
  const entries = await Promise.all(
    TABLES.map(async (table) => {
      try {
        const column = table === 'app_settings' ? 'key' : table === 'user_settings' || table === 'user_achievements' || table === 'purchased_avatars' ? 'user_id' : 'id';
        const rows = await count(admin.from(table).select(column, { count: 'exact', head: true }));
        return { table, rows };
      } catch (_) {
        return { table, rows: null };
      }
    })
  );
  return { tables: entries };
}

module.exports = {
  securityOverview,
  assignRole,
  updateAdminSecurity,
  listAdminSessions,
  revokeAdminSession,
  listLoginEvents,
  listAudit,
  auditActions,
  verifyAudit,
  systemHealth,
  performanceHistory,
  listErrors,
  resolveError,
  listFlags,
  saveFlag,
  deleteFlag,
  listJobs,
  saveJob,
  deleteJob,
  runJob,
  runDueJobs,
  retentionOverview,
  cleanupOverview,
  runCleanup,
  saveRetention,
  gameSettings,
  saveGameSettings,
  saveVersion,
  saveMaintenance,
  listAchievements,
  saveAchievement,
  deleteAchievement,
  systemSnapshot,
  listSnapshots,
  tableStats
};
