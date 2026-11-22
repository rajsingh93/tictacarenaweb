'use strict';

const env = require('../config/env');

/**
 * Cookies are Secure when the deployment asks for it OR when the request that
 * created them actually arrived over HTTPS. Deriving it from the request keeps
 * local/LAN testing over plain http working (a Secure cookie is silently
 * dropped by the browser on http) without weakening production, where the
 * forwarded protocol is https.
 */
function isSecureRequest(req) {
  if (!req) return env.cookieSecure;
  const host = req.get ? req.get('host') : req.headers?.host;
  const isLocal = !host || /^(localhost|127\.0\.0\.1|192\.168\.\d+|10\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+)(:\d+)?$/i.test(host);
  const forwarded = String(req.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const isHttps = req.secure || forwarded === 'https';
  if (isHttps) return true;
  if (isLocal) return false;
  return env.cookieSecure;
}

function cookieOptions(maxAgeMs, req) {
  const secure = isSecureRequest(req);
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? env.cookieSameSite : 'lax',
    path: '/',
    maxAge: maxAgeMs
  };
}

function setSessionCookie(res, token, req) {
  res.cookie(env.sessionCookie, token, cookieOptions(env.sessionDays * 24 * 60 * 60 * 1000, req));
}

function clearSessionCookie(res, req) {
  const secure = isSecureRequest(req);
  res.clearCookie(env.sessionCookie, {
    httpOnly: true,
    secure,
    sameSite: secure ? env.cookieSameSite : 'lax',
    path: '/'
  });
}

function setOAuthVerifierCookie(res, signedValue, req) {
  res.cookie('tta_oauth_verifier', signedValue, cookieOptions(10 * 60 * 1000, req));
}

function clearOAuthVerifierCookie(res, req) {
  res.clearCookie('tta_oauth_verifier', {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: env.cookieSameSite,
    path: '/'
  });
}

module.exports = {
  cookieOptions,
  setSessionCookie,
  clearSessionCookie,
  setOAuthVerifierCookie,
  clearOAuthVerifierCookie
};
