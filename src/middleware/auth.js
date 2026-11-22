'use strict';

const env = require('../config/env');
const { admin } = require('../config/supabase');
const { verify } = require('../utils/jwt');
const { ApiError } = require('../utils/ApiError');

const USER_CACHE = new Map();
const USER_CACHE_TTL = 15 * 1000; // 15 seconds
const USER_PROMISES = new Map();

function getCachedUser(id) {
  const entry = USER_CACHE.get(Number(id));
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    USER_CACHE.delete(Number(id));
    return null;
  }
  return entry.data;
}

function setCachedUser(id, data) {
  if (USER_CACHE.size > 2000) {
    const oldestKey = USER_CACHE.keys().next().value;
    USER_CACHE.delete(oldestKey);
  }
  USER_CACHE.set(Number(id), {
    data,
    expires: Date.now() + USER_CACHE_TTL
  });
}

function invalidateUserCache(id) {
  if (id) {
    USER_CACHE.delete(Number(id));
    USER_PROMISES.delete(Number(id));
  } else {
    USER_CACHE.clear();
    USER_PROMISES.clear();
  }
}

function clearExpiredSuspension(user) {
  if (!user?.is_banned || !user.banned_until) return user;
  if (new Date(user.banned_until).getTime() > Date.now()) return user;
  user.is_banned = false;
  user.banned_until = null;
  user.ban_reason = null;
  admin
    .from('users')
    .update({ is_banned: false, banned_until: null, ban_reason: null })
    .eq('id', user.id)
    .then(() => {})
    .catch(() => {});
  return user;
}

async function loadUserFromToken(token) {
  const payload = verify(token);
  if (payload.purpose !== 'session') {
    throw ApiError.unauthorized('INVALID_SESSION', 'Invalid session');
  }

  const userId = Number(payload.sub);
  let data = getCachedUser(userId);

  if (!data) {
    // Coalesce concurrent loads for the same user to prevent a cache-stampede
    // on the auth hot path.
    let promise = USER_PROMISES.get(userId);
    if (!promise) {
      promise = (async () => {
        const { data: dbUser, error } = await admin
          .from('users')
          .select('id, auth_user_id, username, email, is_admin, is_banned, ban_reason, banned_until, is_bot, bio, level, xp, xp_to_next, coins, score, wins, losses, draws, rank_title, is_online, avatar_url, avatar_emoji, last_seen, last_login_date, created_at, session_invalid_before')
          .eq('id', userId)
          .maybeSingle();

        if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load your account');
        if (!dbUser) throw ApiError.unauthorized('SESSION_USER_MISSING', 'Account no longer exists');
        clearExpiredSuspension(dbUser);
        if (dbUser.is_banned) throw ApiError.forbidden('ACCOUNT_BANNED', 'This account has been banned');
        setCachedUser(userId, dbUser);
        return dbUser;
      })().finally(() => USER_PROMISES.delete(userId));
      USER_PROMISES.set(userId, promise);
    }
    data = await promise;
  } else {
    clearExpiredSuspension(data);
    if (data.is_banned) {
      USER_CACHE.delete(userId);
      throw ApiError.forbidden('ACCOUNT_BANNED', 'This account has been banned');
    }
  }

  assertSessionNotRevoked(payload, data);
  return data;
}

/**
 * Tokens issued before the last password change/reset are refused, so a
 * password change invalidates every session that was already in the wild.
 */
function assertSessionNotRevoked(payload, user) {
  if (!user?.session_invalid_before) return;
  const issuedAt = Number(payload?.iat) * 1000;
  const invalidBefore = new Date(user.session_invalid_before).getTime();
  if (!issuedAt || issuedAt < invalidBefore) {
    throw ApiError.unauthorized('SESSION_REVOKED', 'Your session has ended. Please sign in again.');
  }
}

/**
 * Browsers authenticate with the httpOnly session cookie. A signed Bearer
 * token is also accepted for server-to-server calls; both use one session
 * format and one verification path.
 */
function sessionTokenFromRequest(req) {
  const header = String(req.headers?.authorization || '');
  if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
  return req.cookies?.[env.sessionCookie] || null;
}

async function requireAuth(req, res, next) {
  try {
    const token = sessionTokenFromRequest(req);
    if (!token) throw ApiError.unauthorized('NO_SESSION', 'Please sign in to continue');
    req.user = await loadUserFromToken(token);
    req.user.role = roleFor(req.user);
    next();
  } catch (error) {
    next(error);
  }
}

async function optionalAuth(req, res, next) {
  const token = sessionTokenFromRequest(req);
  if (!token) return next();
  try {
    req.user = await loadUserFromToken(token);
    req.user.role = roleFor(req.user);
  } catch (error) {
    req.user = null;
  }
  next();
}

function isOwner(user) {
  if (!user) return false;
  const email = String(user.email || '').trim().toLowerCase();
  return Boolean(email) && env.adminEmails.includes(email);
}

function roleFor(user) {
  if (!user) return 'guest';
  if (isOwner(user)) return 'owner';
  return user.is_admin ? 'admin' : 'player';
}

function requireAdmin(req, res, next) {
  if (!req.user) return next(ApiError.unauthorized('NO_SESSION', 'Please sign in to continue'));
  if (!req.user.is_admin) return next(ApiError.forbidden('ADMIN_ONLY', 'Admin access required'));
  req.user.role = roleFor(req.user);
  next();
}

/** Privilege escalation (granting/revoking admin) is owner-only. */
function requireOwner(req, res, next) {
  if (!req.user) return next(ApiError.unauthorized('NO_SESSION', 'Please sign in to continue'));
  if (!isOwner(req.user)) {
    return next(ApiError.forbidden('OWNER_ONLY', 'Only the site owner can change admin roles'));
  }
  next();
}

module.exports = {
  requireAuth,
  optionalAuth,
  requireAdmin,
  requireOwner,
  isOwner,
  roleFor,
  loadUserFromToken,
  sessionTokenFromRequest,
  assertSessionNotRevoked,
  invalidateUserCache
};
