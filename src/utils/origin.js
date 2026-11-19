'use strict';

const env = require('../config/env');

// Development-only hosts: loopback plus private LAN ranges, so a phone on the
// same Wi-Fi can hit the API. Production never matches this list.
const DEV_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d{1,5})?$/i;

// Production-allowed origins: custom domain, www, Netlify preview deployments, Render host
const PROD_DOMAIN_RE =
  /^https:\/\/(?:[a-z0-9-]+\.)*(?:tictacarena\.in|netlify\.app|onrender\.com)$/i;

function normalize(origin) {
  return String(origin || '').trim().replace(/\/$/, '');
}

/**
 * Returns true when the browser origin may talk to the API/socket server.
 * Requests without an Origin header (native clients, curl, server-to-server)
 * are allowed; browsers always send one for cross-origin calls.
 */
function originAllowed(origin) {
  if (!origin) return true;
  const value = normalize(origin);
  if (value === env.siteUrl) return true;
  if (env.corsOrigins.includes(value)) return true;
  if (PROD_DOMAIN_RE.test(value)) return true;
  return !env.isProduction && DEV_ORIGIN_RE.test(value);
}

module.exports = { originAllowed, DEV_ORIGIN_RE, PROD_DOMAIN_RE };
