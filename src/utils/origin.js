'use strict';

const env = require('../config/env');

// Only the project's own deployments are trusted implicitly. A wildcard such
// as "*.netlify.app" would let any attacker-controlled Netlify site make
// credentialed cross-site requests, which is especially dangerous because
// production sessions use SameSite=None.
const TRUSTED_HOSTS = new Set([
  'tictacarena.in',
  'www.tictacarena.in',
  'tictacarena.netlify.app',
  'tictacarenaweb.onrender.com'
]);

function normalize(origin) {
  return String(origin || '').trim().replace(/\/$/, '');
}

function trustedHost(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return false;
    return TRUSTED_HOSTS.has(url.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

/**
 * Returns true when the browser origin may talk to the API/socket server.
 * Requests without an Origin header (native clients, curl, server-to-server)
 * are allowed; browsers always send one for cross-origin calls.
 */
function originAllowed(origin) {
  if (!origin) return true;
  const value = normalize(origin);
  if (value === normalize(env.siteUrl)) return true;
  if (env.corsOrigins.includes(value)) return true;
  if (trustedHost(value)) return true;
  return false;
}

module.exports = { originAllowed, trustedHost, TRUSTED_HOSTS };
