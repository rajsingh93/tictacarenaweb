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
  if (env.cookieSecure) return true;
  if (req.secure) return true;
  const forwarded = String(req.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return forwarded === 'https';
}

function cookieOptions(maxAgeMs, req) {
  return {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: env.cookieSameSite,
    path: '/',
    maxAge: maxAgeMs
  };
}

function setSessionCookie(res, token, req) {
  res.cookie(env.sessionCookie, token, cookieOptions(env.sessionDays * 24 * 60 * 60 * 1000, req));
}

function clearSessionCookie(res, req) {
  res.clearCookie(env.sessionCookie, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: env.cookieSameSite,
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
