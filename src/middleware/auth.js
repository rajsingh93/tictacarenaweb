'use strict';

const env = require('../config/env');
const { admin } = require('../config/supabase');
const { verify } = require('../utils/jwt');
const { ApiError } = require('../utils/ApiError');

async function loadUserFromToken(token) {
  const payload = verify(token);
  if (payload.purpose !== 'session') {
    throw ApiError.unauthorized('INVALID_SESSION', 'Invalid session');
  }

  const { data, error } = await admin
    .from('users')
    .select('*')
    .eq('id', payload.sub)
    .maybeSingle();

  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load your account');
  if (!data) throw ApiError.unauthorized('SESSION_USER_MISSING', 'Account no longer exists');
  if (data.is_banned) throw ApiError.forbidden('ACCOUNT_BANNED', 'This account has been banned');
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
  assertSessionNotRevoked
};
