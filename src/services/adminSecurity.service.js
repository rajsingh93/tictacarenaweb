'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const { admin, one, many, count } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { verify, sign, signSession } = require('../utils/jwt');
const { sessionTokenFromRequest } = require('../middleware/auth');
const { cleanText, cleanMultiline } = require('../utils/sanitize');
const { normalizeIp, ipMatchesAllowlist, validateAllowlistEntry } = require('../utils/ip');
const { encrypt, decrypt, sha256, safeEqual } = require('../utils/secretBox');
const totp = require('../utils/totp');
const permissions = require('../config/permissions');
const authService = require('./auth.service');
const audit = require('./audit.service');

const ACCESS_TTL_MS = 15_000;
const SESSION_TTL_MS = 10_000;
const ACCESS_CACHE = new Map();
const SESSION_CACHE = new Map();

const PUBLIC_ADMIN_USER_COLUMNS =
  'id, auth_user_id, username, email, avatar_url, avatar_emoji, is_admin, is_banned, is_bot, level, rank_title, created_at';
const SECURITY_COLUMNS =
  'user_id, role, permissions, is_active, require_2fa, totp_enabled, ip_allowlist, last_2fa_at, created_at, updated_at';
const SESSION_COLUMNS =
  'id, user_id, ip, user_agent, created_at, last_seen_at, expires_at, two_factor_verified, revoked_at, revoked_by, revoke_reason';
const LOGIN_COLUMNS =
  'id, user_id, email, ip, user_agent, success, reason, risk_level, risk_reasons, created_at';

function trimCache(cache, max) {
  while (cache.size > max) cache.delete(cache.keys().next().value);
}

function invalidateAccess(userId) {
  if (userId) ACCESS_CACHE.delete(Number(userId));
  else ACCESS_CACHE.clear();
}

function invalidateSession(token) {
  if (!token) return SESSION_CACHE.clear();
  SESSION_CACHE.delete(sha256(token));
}

function isOwnerEmail(userOrEmail) {
  const email = String(typeof userOrEmail === 'string' ? userOrEmail : userOrEmail?.email || '')
    .trim()
    .toLowerCase();
  return Boolean(email) && env.adminEmails.includes(email);
}

function requestIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0];
  return normalizeIp(forwarded || req?.ip || '') || null;
}

function userAgent(req) {
  return String(req?.get?.('user-agent') || req?.headers?.['user-agent'] || '').slice(0, 500) || null;
}

function surfaceSecurity(row) {
  if (!row) {
    return {
      is_active: false,
      require_2fa: false,
      totp_enabled: false,
      ip_allowlist: [],
      last_2fa_at: null
    };
  }
  return {
    is_active: Boolean(row.is_active),
    require_2fa: Boolean(row.require_2fa),
    totp_enabled: Boolean(row.totp_enabled),
    ip_allowlist: Array.isArray(row.ip_allowlist) ? row.ip_allowlist : [],
    last_2fa_at: row.last_2fa_at || null,
    updated_at: row.updated_at || null
  };
}

async function securityRow(userId) {
  return one(
    admin.from('admin_security').select(`${SECURITY_COLUMNS}, recovery_codes, totp_secret, totp_pending_secret`).eq('user_id', userId).maybeSingle(),
    'Could not load administrator security'
  );
}

async function loadUserById(userId) {
  const user = await one(
    admin.from('users').select(PUBLIC_ADMIN_USER_COLUMNS).eq('id', userId).maybeSingle(),
    'Could not load that account'
  );
  if (!user) throw ApiError.unauthorized('SESSION_USER_MISSING', 'Account no longer exists');
  return user;
}

/**
 * Resolve a user's admin identity. Owner emails are always super admins. A
 * legacy is_admin row without an explicit security record is treated as a
 * super admin so rollout never locks an existing operator out.
 */
async function getAccess(user, { refresh = false } = {}) {
  if (!user?.id) return null;
  const id = Number(user.id);
  if (!refresh) {
    const cached = ACCESS_CACHE.get(id);
    if (cached && cached.expires > Date.now()) return cached.value;
  }

  let row = null;
  try {
    row = await securityRow(id);
  } catch (error) {
    // If the migration is not applied yet, preserve the legacy flag.
    if (!user.is_admin) return null;
  }

  const owner = isOwnerEmail(user);
  let role = null;
  if (owner) role = 'super_admin';
  else if (row?.is_active && permissions.isKnownRole(row.role)) role = row.role;
  else if (!row && user.is_admin) role = 'super_admin';

  if (!role) {
    const value = null;
    ACCESS_CACHE.set(id, { value, expires: Date.now() + ACCESS_TTL_MS });
    return value;
  }

  const effective = permissions.effectivePermissions(role, row?.permissions || {});
  const value = {
    user_id: id,
    role,
    role_label: permissions.ROLES[role].label,
    is_owner: owner,
    is_super_admin: role === 'super_admin',
    permissions: effective,
    permission_overrides: row?.permissions || {},
    security: surfaceSecurity(row),
    totp_enabled: Boolean(row?.totp_enabled),
    ip_allowlist: Array.isArray(row?.ip_allowlist) ? row.ip_allowlist : []
  };
  ACCESS_CACHE.set(id, { value, expires: Date.now() + ACCESS_TTL_MS });
  trimCache(ACCESS_CACHE, 1000);
  return value;
}

function hasPermission(access, permission) {
  return permissions.hasPermission(access?.permissions, permission);
}

async function requireAdminAccess(req, res, next) {
  try {
    if (!req.user) throw ApiError.unauthorized('NO_SESSION', 'Please sign in to continue');
    const access = await getAccess(req.user);
    if (!access) {
      throw ApiError.forbidden(
        'ADMIN_ACCESS_REQUIRED',
        'This account does not have administrator access'
      );
    }
    if (access.ip_allowlist.length && !ipMatchesAllowlist(requestIp(req), access.ip_allowlist)) {
      throw ApiError.forbidden(
        'ADMIN_IP_RESTRICTED',
        'This administrator account is restricted to approved networks'
      );
    }
    req.adminAccess = access;
    req.user.role = access.role;
    req.user.is_admin = true;
    next();
  } catch (error) {
    next(error);
  }
}

function requirePermission(...required) {
  const wanted = required.flat();
  return function permissionMiddleware(req, res, next) {
    if (!req.adminAccess) {
      return next(ApiError.unauthorized('NO_SESSION', 'Please sign in to continue'));
    }
    const allowed = wanted.some((permission) => hasPermission(req.adminAccess, permission));
    if (!allowed) {
      return next(
        ApiError.forbidden(
          'ADMIN_PERMISSION_REQUIRED',
          'You do not have permission to perform this action',
          { permission: wanted.join('|') }
        )
      );
    }
    next();
  };
}

// 

async function recordSession(user, token, req, { twoFactorVerified = false } = {}) {
  const payload = verify(token);
  const hash = sha256(token);
  const expiresAt = new Date(Number(payload.exp) * 1000 || Date.now() + env.sessionDays * 86400000);
  const { data, error } = await admin
    .from('admin_sessions')
    .insert({
      user_id: user.id,
      token_hash: hash,
      ip: requestIp(req),
      user_agent: userAgent(req),
      expires_at: expiresAt.toISOString(),
      two_factor_verified: Boolean(twoFactorVerified)
    })
    .select(SESSION_COLUMNS)
    .single();

  if (error && error.code !== '23505') {
    console.warn('[admin-security] session record failed:', error.message);
  }
  const session = data || null;
  if (session) {
    SESSION_CACHE.set(hash, {
      active: true,
      user_id: user.id,
      two_factor_verified: Boolean(twoFactorVerified),
      expires_at: expiresAt.getTime(),
      checked: Date.now(),
      session
    });
  }
  return session;
}

async function ensureAdminSession(req) {
  const token = sessionTokenFromRequest(req);
  if (!token) throw ApiError.unauthorized('NO_SESSION', 'Please sign in to continue');
  const hash = sha256(token);
  const cached = SESSION_CACHE.get(hash);
  if (cached && Date.now() - cached.checked < SESSION_TTL_MS) {
    if (!cached.active) throw ApiError.unauthorized('ADMIN_SESSION_REVOKED', 'This administrator session has ended');
    if (cached.expires_at <= Date.now()) {
      throw ApiError.unauthorized('ADMIN_SESSION_EXPIRED', 'This administrator session has expired');
    }
    if (req.adminAccess?.totp_enabled && !cached.two_factor_verified) {
      throw ApiError.unauthorized('ADMIN_2FA_REQUIRED', 'Two-factor authentication is required');
    }
    req.adminSession = cached.session;
    return cached.session;
  }

  const row = await one(
    admin.from('admin_sessions').select(SESSION_COLUMNS).eq('token_hash', hash).maybeSingle(),
    'Could not verify this administrator session'
  );

  if (!row) {
    const payload = verify(token);
    const verified = !req.adminAccess?.totp_enabled;
    const { data } = await admin
      .from('admin_sessions')
      .insert({
        user_id: req.user.id,
        token_hash: hash,
        ip: requestIp(req),
        user_agent: userAgent(req),
        expires_at: new Date(Number(payload.exp) * 1000).toISOString(),
        two_factor_verified: verified
      })
      .select(SESSION_COLUMNS)
      .single();
    if (data) {
      SESSION_CACHE.set(hash, {
        active: true,
        user_id: req.user.id,
        two_factor_verified: verified,
        expires_at: new Date(data.expires_at).getTime(),
        checked: Date.now(),
        session: data
      });
      req.adminSession = data;
      if (!verified) {
        throw ApiError.unauthorized('ADMIN_2FA_REQUIRED', 'Two-factor authentication is required');
      }
      return data;
    }
    throw ApiError.unauthorized('ADMIN_SESSION_MISSING', 'Please sign in to the admin console again');
  }

  const active = !row.revoked_at && new Date(row.expires_at).getTime() > Date.now();
  SESSION_CACHE.set(hash, {
    active,
    user_id: row.user_id,
    two_factor_verified: Boolean(row.two_factor_verified),
    expires_at: new Date(row.expires_at).getTime(),
    checked: Date.now(),
    session: row
  });
  trimCache(SESSION_CACHE, 2000);

  if (!active) {
    throw ApiError.unauthorized(
      row.revoked_at ? 'ADMIN_SESSION_REVOKED' : 'ADMIN_SESSION_EXPIRED',
      row.revoked_at ? 'This administrator session was revoked' : 'This administrator session has expired'
    );
  }
  if (req.adminAccess?.totp_enabled && !row.two_factor_verified) {
    throw ApiError.unauthorized('ADMIN_2FA_REQUIRED', 'Two-factor authentication is required');
  }

  if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    admin
      .from('admin_sessions')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', row.id)
      .then(() => {})
      .catch(() => {});
  }

  req.adminSession = row;
  return row;
}

async function requireAdminSession(req, res, next) {
  try {
    await ensureAdminSession(req);
    next();
  } catch (error) {
    next(error);
  }
}

async function markCurrentSessionVerified(req, userId, { revokeOthers = false } = {}) {
  const token = sessionTokenFromRequest(req);
  if (!token) return;
  const hash = sha256(token);
  await admin
    .from('admin_sessions')
    .update({ two_factor_verified: true })
    .eq('token_hash', hash)
    .eq('user_id', userId);

  if (revokeOthers) {
    await admin
      .from('admin_sessions')
      .update({
        revoked_at: new Date().toISOString(),
        revoked_by: userId,
        revoke_reason: 'Two-factor authentication was enabled'
      })
      .eq('user_id', userId)
      .neq('token_hash', hash)
      .is('revoked_at', null);
  }
  invalidateSession(token);
}

async function listSessions(userId, { limit = 30 } = {}) {
  return many(
    admin
      .from('admin_sessions')
      .select(SESSION_COLUMNS)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(Number(limit) || 30, 1), 100)),
    'Could not load administrator sessions'
  );
}

async function revokeSession(actor, sessionId, req) {
  const session = await one(
    admin.from('admin_sessions').select(SESSION_COLUMNS).eq('id', sessionId).maybeSingle(),
    'Could not load that session'
  );
  if (!session) throw ApiError.notFound('SESSION_NOT_FOUND', 'Session not found');
  if (session.user_id !== actor.user_id && !hasPermission(actor, 'security.manage')) {
    throw ApiError.forbidden('SESSION_NOT_YOURS', 'You cannot revoke another administrator session');
  }
  if (session.revoked_at) return { message: 'Session was already revoked' };

  await one(
    admin
      .from('admin_sessions')
      .update({
        revoked_at: new Date().toISOString(),
        revoked_by: actor.user_id,
        revoke_reason: 'Revoked from the admin console'
      })
      .eq('id', session.id)
      .select('id')
      .single(),
    'Could not revoke that session'
  );
  SESSION_CACHE.clear();
  await audit.record(actor.user || { id: actor.user_id }, 'security.session.revoke', {
    targetType: 'admin_session',
    targetId: session.id,
    details: { user_id: session.user_id, ip: session.ip },
    req
  });
  return { message: 'Session revoked' };
}

async function revokeCurrentSession(actor, req) {
  const token = sessionTokenFromRequest(req);
  if (!token) return { revoked: false };
  const hash = sha256(token);
  const row = await one(
    admin
      .from('admin_sessions')
      .update({
        revoked_at: new Date().toISOString(),
        revoked_by: actor?.user_id || actor?.id || null,
        revoke_reason: 'Signed out of the admin console'
      })
      .eq('token_hash', hash)
      .is('revoked_at', null)
      .select('id')
      .maybeSingle(),
    'Could not end this administrator session'
  );
  invalidateSession(token);
  if (row) {
    await audit.record(actor?.user || { id: actor?.user_id || actor?.id }, 'security.session.logout', {
      targetType: 'admin_session',
      targetId: row.id,
      req
    });
  }
  return { revoked: Boolean(row) };
}

async function revokeAllSessions(actor, targetUserId, req, { includeCurrent = false } = {}) {
  const userId = Number(targetUserId || actor.user_id);
  const currentToken = sessionTokenFromRequest(req);
  const currentHash = currentToken ? sha256(currentToken) : null;

  let query = admin
    .from('admin_sessions')
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by: actor.user_id,
      revoke_reason: includeCurrent ? 'All sessions revoked' : 'Other sessions revoked'
    })
    .eq('user_id', userId)
    .is('revoked_at', null);
  if (!includeCurrent && currentHash) query = query.neq('token_hash', currentHash);
  const rows = await many(query.select('id'), 'Could not revoke sessions');

  if (includeCurrent) {
    await admin
      .from('users')
      .update({ session_invalid_before: new Date().toISOString() })
      .eq('id', userId);
  }

  SESSION_CACHE.clear();
  await audit.record(actor.user || { id: actor.user_id }, 'security.sessions.revoke_all', {
    targetType: 'user',
    targetId: userId,
    details: { revoked: rows.length, includeCurrent },
    req
  });
  return { message: `Revoked ${rows.length} session${rows.length === 1 ? '' : 's'}`, revoked: rows.length };
}

// 

async function recordLoginEvent({
  user = null,
  email = '',
  req = null,
  success = false,
  reason = null,
  risk = null
} = {}) {
  try {
    await admin.from('admin_login_events').insert({
      user_id: user?.id || null,
      email: cleanText(email || user?.email, 254),
      ip: requestIp(req),
      user_agent: userAgent(req),
      success: Boolean(success),
      reason: reason ? cleanText(reason, 120) : null,
      risk_level: risk?.level || 'low',
      risk_reasons: risk?.reasons || []
    });
  } catch (error) {
    console.warn('[admin-security] login event write failed:', error.message);
  }
}

async function assessRisk({ user = null, email = '', req = null }) {
  const reasons = [];
  let level = 'low';
  const ip = requestIp(req);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [emailFailures, ipFailures, knownIps] = await Promise.all([
    email
      ? count(
          admin
            .from('admin_login_events')
            .select('id', { count: 'exact', head: true })
            .eq('email', String(email).toLowerCase())
            .eq('success', false)
            .gte('created_at', since)
        ).catch(() => 0)
      : Promise.resolve(0),
    ip
      ? count(
          admin
            .from('admin_login_events')
            .select('id', { count: 'exact', head: true })
            .eq('ip', ip)
            .eq('success', false)
            .gte('created_at', since)
        ).catch(() => 0)
      : Promise.resolve(0),
    user
      ? many(
          admin
            .from('admin_login_events')
            .select('ip')
            .eq('user_id', user.id)
            .eq('success', true)
            .not('ip', 'is', null)
            .order('created_at', { ascending: false })
            .limit(50)
        ).catch(() => [])
      : Promise.resolve([])
  ]);

  if (emailFailures >= 5 || ipFailures >= 8) {
    level = 'high';
    reasons.push('Repeated failed sign-in attempts in the last 24 hours');
  } else if (emailFailures >= 2 || ipFailures >= 3) {
    level = 'medium';
    reasons.push('Recent failed sign-in attempts');
  }

  if (user && knownIps.length) {
    const seen = new Set(knownIps.map((row) => normalizeIp(row.ip)));
    if (ip && !seen.has(ip)) {
      if (level === 'low') level = 'medium';
      reasons.push('Successful sign-in from a new network');
    }
  }

  return { level, reasons };
}

function publicAdminUser(user, access, security = null) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatar_url: user.avatar_url,
    avatar_emoji: user.avatar_emoji,
    role: access.role,
    role_label: access.role_label,
    is_owner: access.is_owner,
    permissions: access.permissions,
    legacy_permissions: permissions.legacyPermissions(access.permissions),
    security: surfaceSecurity(security || { ...access.security, is_active: true })
  };
}

function challengeToken(user) {
  return sign(
    {
      sub: String(user.id),
      purpose: 'admin_2fa',
      nonce: crypto.randomBytes(12).toString('hex')
    },
    '10m'
  );
}

async function assertIpAllowed(user, req) {
  const row = await securityRow(user.id);
  const allowlist = Array.isArray(row?.ip_allowlist) ? row.ip_allowlist : [];
  if (allowlist.length && !ipMatchesAllowlist(requestIp(req), allowlist)) {
    await recordLoginEvent({
      user,
      req,
      success: false,
      reason: 'IP_RESTRICTED',
      risk: { level: 'high', reasons: ['Sign-in blocked by IP allowlist'] }
    });
    throw ApiError.forbidden(
      'ADMIN_IP_RESTRICTED',
      'This administrator account is restricted to approved networks'
    );
  }
  return row;
}

async function issueLogin(user, req, access, security, { twoFactorVerified = true } = {}) {
  const token = signSession(user);
  await recordSession(user, token, req, {
    twoFactorVerified: twoFactorVerified || !security?.totp_enabled
  });
  invalidateAccess(user.id);
  const risk = await assessRisk({ user, email: user.email, req });
  await recordLoginEvent({
    user,
    req,
    success: true,
    reason: security?.totp_enabled ? 'PASSWORD_AND_2FA' : 'PASSWORD_ONLY',
    risk
  });
  return {
    verified: true,
    requires2fa: false,
    user: publicAdminUser(user, access, security),
    sessionToken: token,
    risk
  };
}

async function login({ email, password, req }) {
  let result;
  try {
    result = await authService.login({ email, password });
  } catch (error) {
    await recordLoginEvent({
      email,
      req,
      success: false,
      reason: error.code || 'INVALID_CREDENTIALS',
      risk: await assessRisk({ email, req })
    });
    throw error;
  }

  if (!result?.verified) {
    await recordLoginEvent({
      email,
      req,
      success: false,
      reason: 'EMAIL_UNVERIFIED'
    });
    return result;
  }

  const user = await loadUserById(result.user.id);
  if (user.is_banned) throw ApiError.forbidden('ACCOUNT_BANNED', 'This account has been banned');
  const access = await getAccess(user, { refresh: true });
  if (!access) {
    await recordLoginEvent({
      user,
      req,
      success: false,
      reason: 'ADMIN_ACCESS_REQUIRED',
      risk: await assessRisk({ user, email: user.email, req })
    });
    throw ApiError.forbidden(
      'ADMIN_ACCESS_REQUIRED',
      'This account does not have administrator access'
    );
  }

  const security = await assertIpAllowed(user, req);
  if (security?.totp_enabled) {
    return {
      verified: true,
      requires2fa: true,
      challengeToken: challengeToken(user),
      user: {
        username: user.username,
        email: user.email,
        avatar_emoji: user.avatar_emoji
      }
    };
  }

  return issueLogin(user, req, access, security);
}

async function verifySecondFactor(security, code) {
  const clean = String(code || '').trim();
  if (!clean) return { ok: false };
  const secret = decrypt(security?.totp_secret);
  if (secret && totp.verify(secret, clean)) return { ok: true, method: 'totp' };

  const recoveryInput = clean.toUpperCase().replace(/\s+/g, '');
  const hashes = Array.isArray(security?.recovery_codes) ? security.recovery_codes : [];
  const match = hashes.find((hash) => safeEqual(hash, sha256(recoveryInput)));
  if (match) return { ok: true, method: 'recovery', recoveryHash: match };
  return { ok: false };
}

async function complete2fa({ challengeToken, code, req }) {
  let payload;
  try {
    payload = verify(challengeToken);
  } catch {
    throw ApiError.unauthorized('INVALID_CHALLENGE', 'This verification request has expired');
  }
  if (payload.purpose !== 'admin_2fa') {
    throw ApiError.unauthorized('INVALID_CHALLENGE', 'This verification request is invalid');
  }

  const user = await loadUserById(Number(payload.sub));
  if (user.is_banned) throw ApiError.forbidden('ACCOUNT_BANNED', 'This account has been banned');
  const access = await getAccess(user, { refresh: true });
  if (!access) throw ApiError.forbidden('ADMIN_ACCESS_REQUIRED', 'Administrator access is required');
  const security = await assertIpAllowed(user, req);
  if (!security?.totp_enabled) {
    return issueLogin(user, req, access, security);
  }

  const check = await verifySecondFactor(security, code);
  if (!check.ok) {
    const risk = await assessRisk({ user, email: user.email, req });
    await recordLoginEvent({
      user,
      req,
      success: false,
      reason: 'INVALID_2FA',
      risk: { level: 'high', reasons: [...risk.reasons, 'Invalid two-factor code'] }
    });
    throw ApiError.unauthorized('INVALID_2FA', 'That authentication code is not valid');
  }

  const updates = { last_2fa_at: new Date().toISOString() };
  if (check.method === 'recovery') {
    updates.recovery_codes = security.recovery_codes.filter((hash) => hash !== check.recoveryHash);
  }
  await admin.from('admin_security').update(updates).eq('user_id', user.id);
  invalidateAccess(user.id);
  const nextSecurity = { ...security, ...updates };
  return issueLogin(user, req, access, nextSecurity, { twoFactorVerified: true });
}

// 

async function ensureSecurityRow(user, access) {
  let row = await securityRow(user.id);
  if (row) return row;
  row = await one(
    admin
      .from('admin_security')
      .insert({
        user_id: user.id,
        role: access?.role && access.role !== 'player' ? access.role : 'admin',
        permissions: {},
        is_active: true
      })
      .select(`${SECURITY_COLUMNS}, recovery_codes, totp_secret, totp_pending_secret`)
      .single(),
    'Could not prepare administrator security'
  );
  invalidateAccess(user.id);
  return row;
}

async function start2fa(user, access) {
  const row = await ensureSecurityRow(user, access);
  if (row.totp_enabled) {
    throw ApiError.conflict('2FA_ALREADY_ENABLED', 'Two-factor authentication is already enabled');
  }
  const secret = totp.generateSecret();
  await admin
    .from('admin_security')
    .update({ totp_pending_secret: encrypt(secret) })
    .eq('user_id', user.id);
  return {
    secret,
    otpauthUrl: totp.otpauthUrl({ secret, email: user.email }),
    issuer: 'TicTacArena Admin'
  };
}

async function enable2fa(user, access, code, req) {
  const row = await ensureSecurityRow(user, access);
  if (row.totp_enabled) {
    throw ApiError.conflict('2FA_ALREADY_ENABLED', 'Two-factor authentication is already enabled');
  }
  const pending = decrypt(row.totp_pending_secret);
  if (!pending) {
    throw ApiError.badRequest('2FA_SETUP_REQUIRED', 'Start two-factor setup first');
  }
  if (!totp.verify(pending, code)) {
    throw ApiError.unauthorized('INVALID_2FA', 'That authentication code is not valid');
  }
  const recoveryCodes = totp.generateRecoveryCodes();
  const hashes = recoveryCodes.map((entry) => sha256(entry.replace(/-/g, '')));
  await admin
    .from('admin_security')
    .update({
      totp_secret: encrypt(pending),
      totp_pending_secret: null,
      totp_enabled: true,
      require_2fa: true,
      recovery_codes: hashes,
      last_2fa_at: new Date().toISOString()
    })
    .eq('user_id', user.id);
  invalidateAccess(user.id);
  await markCurrentSessionVerified(req, user.id, { revokeOthers: true });
  await audit.record(user, 'security.2fa.enable', {
    targetType: 'user',
    targetId: user.id,
    req
  });
  return {
    enabled: true,
    recoveryCodes,
    message: 'Two-factor authentication is enabled. Store the recovery codes somewhere safe.'
  };
}

async function disable2fa(user, access, code, req) {
  const row = await securityRow(user.id);
  if (!row?.totp_enabled) {
    throw ApiError.badRequest('2FA_NOT_ENABLED', 'Two-factor authentication is not enabled');
  }
  const check = await verifySecondFactor(row, code);
  if (!check.ok) throw ApiError.unauthorized('INVALID_2FA', 'That authentication code is not valid');
  await admin
    .from('admin_security')
    .update({
      totp_enabled: false,
      require_2fa: false,
      totp_secret: null,
      totp_pending_secret: null,
      recovery_codes: []
    })
    .eq('user_id', user.id);
  invalidateAccess(user.id);
  await markCurrentSessionVerified(req, user.id);
  await audit.record(user, 'security.2fa.disable', {
    targetType: 'user',
    targetId: user.id,
    req
  });
  return { enabled: false, message: 'Two-factor authentication is disabled' };
}

async function regenerateRecoveryCodes(user, access, code, req) {
  const row = await securityRow(user.id);
  if (!row?.totp_enabled) throw ApiError.badRequest('2FA_NOT_ENABLED', 'Two-factor authentication is not enabled');
  if (!totp.verify(decrypt(row.totp_secret), code)) {
    throw ApiError.unauthorized('INVALID_2FA', 'That authentication code is not valid');
  }
  const recoveryCodes = totp.generateRecoveryCodes();
  await admin
    .from('admin_security')
    .update({ recovery_codes: recoveryCodes.map((entry) => sha256(entry.replace(/-/g, ''))) })
    .eq('user_id', user.id);
  await audit.record(user, 'security.2fa.recovery_codes', {
    targetType: 'user',
    targetId: user.id,
    req
  });
  return { recoveryCodes, message: 'New recovery codes generated' };
}

// 

function sanitizeOverrides(input) {
  const result = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  for (const [permission, value] of Object.entries(input)) {
    if (!permissions.isKnownPermission(permission)) continue;
    if (typeof value === 'boolean') result[permission] = value;
  }
  return result;
}

async function setRole(actor, targetId, role, overrides = {}, req) {
  if (!hasPermission(actor, 'users.roles')) {
    throw ApiError.forbidden('ADMIN_PERMISSION_REQUIRED', 'You cannot manage administrator roles');
  }
  const target = await loadUserById(Number(targetId));
  if (String(target.id) === String(actor.user_id)) {
    throw ApiError.badRequest('CANNOT_CHANGE_OWN_ROLE', 'You cannot change your own administrator role');
  }
  if (target.is_bot) throw ApiError.badRequest('BOT_ACCOUNT', 'Bot accounts cannot be administrators');
  if (isOwnerEmail(target)) {
    throw ApiError.forbidden('OWNER_PROTECTED', 'The site owner account cannot be changed here');
  }

  const targetAccess = await getAccess(target, { refresh: true });
  if (!permissions.canManageRole(actor.role, role === 'player' ? 'admin' : role, { isOwner: actor.is_owner })) {
    throw ApiError.forbidden('ROLE_ESCALATION_BLOCKED', 'You cannot grant that role');
  }
  if (targetAccess?.role === 'super_admin' && !actor.is_owner) {
    throw ApiError.forbidden('ROLE_ESCALATION_BLOCKED', 'Only the owner can change a super admin');
  }

  if (role === 'player') {
    await admin
      .from('admin_security')
      .update({ is_active: false })
      .eq('user_id', target.id);
    await admin
      .from('users')
      .update({ is_admin: false, last_admin_action_at: new Date().toISOString() })
      .eq('id', target.id);
    invalidateAccess(target.id);
    require('../middleware/auth').invalidateUserCache(target.id);
    await audit.record(actor.user || { id: actor.user_id, username: actor.username }, 'security.role.revoke', {
      targetType: 'user',
      targetId: target.id,
      details: { previous_role: targetAccess?.role || null },
      req
    });
    return { message: `${target.username} no longer has administrator access`, role: 'player' };
  }

  if (!permissions.isKnownRole(role)) {
    throw ApiError.badRequest('INVALID_ROLE', 'Choose a valid administrator role');
  }

  const cleanOverrides = sanitizeOverrides(overrides);
  const { error } = await admin
    .from('admin_security')
    .upsert(
      {
        user_id: target.id,
        role,
        permissions: cleanOverrides,
        is_active: true
      },
      { onConflict: 'user_id' }
    );
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not update the administrator role');

  await admin
    .from('users')
    .update({ is_admin: true, last_admin_action_at: new Date().toISOString() })
    .eq('id', target.id);
  invalidateAccess(target.id);
  require('../middleware/auth').invalidateUserCache(target.id);
  await audit.record(actor.user || { id: actor.user_id, username: actor.username }, 'security.role.assign', {
    targetType: 'user',
    targetId: target.id,
    details: {
      previous_role: targetAccess?.role || 'player',
      role,
      overrides: cleanOverrides
    },
    req
  });
  return {
    message: `${target.username} is now ${permissions.ROLES[role].label}`,
    role,
    permissions: permissions.effectivePermissions(role, cleanOverrides)
  };
}

async function updateSecurity(actor, targetId, patch = {}, req) {
  if (!hasPermission(actor, 'security.manage')) {
    throw ApiError.forbidden('ADMIN_PERMISSION_REQUIRED', 'You cannot manage administrator security');
  }
  const target = await loadUserById(Number(targetId));
  if (isOwnerEmail(target) && !actor.is_owner) {
    throw ApiError.forbidden('OWNER_PROTECTED', 'Only the owner can change owner security');
  }
  const row = await securityRow(target.id);
  if (!row) throw ApiError.notFound('ADMIN_NOT_FOUND', 'That account is not an administrator');

  const update = {};
  if (typeof patch.require_2fa === 'boolean') update.require_2fa = patch.require_2fa;
  if (patch.ip_allowlist !== undefined) {
    if (!Array.isArray(patch.ip_allowlist)) {
      throw ApiError.badRequest('INVALID_ALLOWLIST', 'IP allowlist must be a list');
    }
    const allowlist = [...new Set(patch.ip_allowlist.map((entry) => String(entry).trim()).filter(Boolean))];
    if (allowlist.length > 50) throw ApiError.badRequest('ALLOWLIST_TOO_LONG', 'Use 50 IP rules or fewer');
    const invalid = allowlist.find((entry) => !validateAllowlistEntry(entry));
    if (invalid) throw ApiError.badRequest('INVALID_IP_RULE', `"${invalid}" is not a valid IP or CIDR range`);
    update.ip_allowlist = allowlist;
  }
  if (!Object.keys(update).length) {
    throw ApiError.badRequest('NO_CHANGES', 'No security settings were supplied');
  }

  const updated = await one(
    admin
      .from('admin_security')
      .update(update)
      .eq('user_id', target.id)
      .select(SECURITY_COLUMNS)
      .single(),
    'Could not update administrator security'
  );
  invalidateAccess(target.id);
  await audit.record(actor.user || { id: actor.user_id, username: actor.username }, 'security.policy.update', {
    targetType: 'user',
    targetId: target.id,
    details: update,
    req
  });
  return { message: 'Security policy updated', security: surfaceSecurity(updated) };
}

async function listAdmins() {
  const rows = await many(
    admin
      .from('admin_security')
      .select(SECURITY_COLUMNS)
      .order('created_at', { ascending: true }),
    'Could not load administrators'
  );
  const ids = rows.map((row) => row.user_id);
  let users = [];
  if (ids.length) {
    users = await many(
      admin.from('users').select(PUBLIC_ADMIN_USER_COLUMNS).in('id', ids),
      'Could not load administrator accounts'
    );
  }

  if (env.adminEmails.length) {
    const owners = await many(
      admin.from('users').select(PUBLIC_ADMIN_USER_COLUMNS).in('email', env.adminEmails),
      'Could not load owner accounts'
    ).catch(() => []);
    const known = new Set(users.map((user) => user.id));
    owners.forEach((owner) => {
      if (!known.has(owner.id)) users.push(owner);
    });
  }

  const userMap = new Map(users.map((user) => [String(user.id), user]));
  const byUser = new Map(rows.map((row) => [String(row.user_id), row]));
  return users.map((user) => {
    const row = byUser.get(String(user.id));
    const owner = isOwnerEmail(user);
    const role = owner ? 'super_admin' : row?.role || 'super_admin';
    const effective = permissions.effectivePermissions(role, row?.permissions || {});
    return {
      ...user,
      is_owner: owner,
      role,
      role_label: permissions.ROLES[role]?.label || role,
      is_active: owner || Boolean(row?.is_active),
      permissions: effective,
      overrides: row?.permissions || {},
      security: surfaceSecurity(row)
    };
  });
}

async function securityOverview(targetUserId, req) {
  const user = await loadUserById(targetUserId);
  const row = await securityRow(user.id);
  const [sessions, loginEvents, failureCount, admins] = await Promise.all([
    listSessions(user.id),
    many(
      admin
        .from('admin_login_events')
        .select(LOGIN_COLUMNS)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(25),
      'Could not load login history'
    ).catch(() => []),
    count(
      admin
        .from('admin_login_events')
        .select('id', { count: 'exact', head: true })
        .eq('success', false)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    ).catch(() => 0),
    listAdmins()
  ]);
  return {
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      is_owner: isOwnerEmail(user)
    },
    security: surfaceSecurity(row),
    sessions,
    loginEvents,
    failedAttempts24h: failureCount,
    admins
  };
}

function mePayload(req) {
  const access = req.adminAccess;
  const legacy = permissions.legacyPermissions(access.permissions);
  return {
    user: {
      ...publicAdminUser(req.user, access, access.security),
      // Legacy console compatibility: it reads `user.role` and
      // `permissions.manageX` booleans. The granular model is additive.
      role: access.is_owner ? 'owner' : 'admin',
      admin_role: access.role,
      role_label: access.role_label
    },
    role: access.role,
    role_label: access.role_label,
    is_owner: access.is_owner,
    permissions: legacy,
    legacy_permissions: legacy,
    effective_permissions: access.permissions,
    security: access.security,
    session: req.adminSession
      ? {
          id: req.adminSession.id,
          ip: req.adminSession.ip,
          user_agent: req.adminSession.user_agent,
          created_at: req.adminSession.created_at,
          last_seen_at: req.adminSession.last_seen_at,
          two_factor_verified: req.adminSession.two_factor_verified
        }
      : null,
    catalog: {
      roles: permissions.ROLES,
      permissions: permissions.PERMISSIONS
    }
  };
}

module.exports = {
  ACCESS_TTL_MS,
  isOwnerEmail,
  getAccess,
  invalidateAccess,
  requireAdminAccess,
  requirePermission,
  requireAdminSession,
  ensureAdminSession,
  recordSession,
  listSessions,
  revokeSession,
  revokeAllSessions,
  revokeCurrentSession,
  recordLoginEvent,
  login,
  complete2fa,
  start2fa,
  enable2fa,
  disable2fa,
  regenerateRecoveryCodes,
  setRole,
  updateSecurity,
  listAdmins,
  securityOverview,
  securityRow,
  mePayload,
  hasPermission,
  requestIp,
  userAgent
};
