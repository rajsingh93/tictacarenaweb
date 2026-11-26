'use strict';

const env = require('../config/env');

/**
 * Cookies are Secure when the deployment asks for it OR when the request that
 * created them arrived over HTTPS.
 */
function isSecureRequest(req) {
  if (!req) return env.cookieSecure;
  const forwarded = String(req.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const isHttps = req.secure || forwarded === 'https';
  if (isHttps) return true;
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
