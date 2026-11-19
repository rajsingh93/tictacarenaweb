'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name, fallback = '') {
  return process.env[name] || fallback;
}

function parseBool(value, fallback = false) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true' || value === '1';
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

const nodeEnv = optional('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';
const siteUrl = optional('SITE_URL', 'http://localhost:3000').replace(/\/$/, '');

// Some process managers export PORT=0 ("pick any free port"), which would
// start the API somewhere other than the port the frontend expects. Only an
// explicit, valid TCP port is honoured; anything else falls back to 3000.
const parsedPort = Number(optional('PORT', '3000'));
const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 3000;

const env = {
  nodeEnv,
  isProduction,
  port,
  siteUrl,

  // Extra browser origins allowed to call the API (comma separated). The
  // Netlify site and local development origins belong here.
  corsOrigins: parseList(optional('CORS_ORIGINS')),

  jwtSecret: required('JWT_SECRET'),
  sessionCookie: optional('SESSION_COOKIE_NAME', 'tta_session'),
  sessionDays: Number(optional('SESSION_DAYS', '7')),

  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  supabaseAnonKey: optional('SUPABASE_ANON_PUBLIC_KEY') || required('SUPABASE_ANON_KEY'),

  cloudinary: {
    cloudName: optional('CLOUDINARY_CLOUD_NAME'),
    apiKey: optional('CLOUDINARY_API_KEY'),
    apiSecret: optional('CLOUDINARY_API_SECRET'),
    folder: optional('CLOUDINARY_FOLDER', 'tictacarena')
  },

  // Owners are configured only through the environment. Owners can grant and
  // revoke the admin role; regular admins cannot escalate privileges.
  adminEmails: parseList(optional('ADMIN_EMAILS')).map((email) => email.toLowerCase()),

  // Sandbox top-ups credit coins without a payment provider. They are a local
  // development convenience only and can never be enabled in production.
  topupSandbox: !isProduction && parseBool(optional('TOPUP_SANDBOX', 'true'), true),
  topupWebhookSecret: optional('TOPUP_WEBHOOK_SECRET'),
  maxUploadBytes: Number(optional('MAX_UPLOAD_BYTES', String(5 * 1024 * 1024))),

  // Serving the static frontend from Express is a development convenience.
  // In production the frontend is deployed to Netlify, so it stays off unless
  // explicitly requested.
  serveFrontend: parseBool(optional('SERVE_FRONTEND', isProduction ? 'false' : 'true'), !isProduction),

  cookieSecure: parseBool(optional('COOKIE_SECURE', isProduction ? 'true' : 'false'), isProduction),
  cookieSameSite: optional('COOKIE_SAME_SITE', 'lax').toLowerCase()
};

// A guessable signing secret means anyone can mint an admin session.
const WEAK_JWT_RE = /^(secret|changeme|change_me|password|jwt|tictac|super[_-]?secret|test)/i;
if (isProduction && (env.jwtSecret.length < 48 || WEAK_JWT_RE.test(env.jwtSecret))) {
  throw new Error(
    '[config] JWT_SECRET is too weak for production. Use at least 48 random characters (for example: `openssl rand -base64 48`).'
  );
}
if (env.jwtSecret.length < 32) {
  console.warn('[config] JWT_SECRET is shorter than 32 characters. Use a strong random value in production.');
}

if (isProduction && !env.corsOrigins.length) {
  console.warn('[config] CORS_ORIGINS is empty. Set it to the deployed frontend origin(s).');
}

if (env.cookieSameSite === 'none' && !env.cookieSecure) {
  console.warn('[config] COOKIE_SAME_SITE=none requires COOKIE_SECURE=true. Enabling secure cookies.');
  env.cookieSecure = true;
}

module.exports = env;
