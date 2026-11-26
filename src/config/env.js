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

const nodeEnv = optional('NODE_ENV', 'production');
const isProduction = nodeEnv === 'production';
const siteUrl = optional('SITE_URL', 'https://tictacarena.in').replace(/\/$/, '');

// Valid TCP port fallback
const parsedPort = Number(optional('PORT', '3000'));
const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 3000;

const DEFAULT_CORS_ORIGINS = [
  'https://tictacarena.in',
  'https://www.tictacarena.in',
  'https://tictacarena.netlify.app',
  'https://tictacarenaweb.onrender.com'
];
const configuredCors = parseList(optional('CORS_ORIGINS'));
const corsOrigins = configuredCors.length ? configuredCors : DEFAULT_CORS_ORIGINS;

const env = {
  nodeEnv,
  isProduction,
  port,
  siteUrl,

  corsOrigins,

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

  // Admin owner emails
  adminEmails: parseList(optional('ADMIN_EMAILS')).map((email) => email.toLowerCase()),

  topupSandbox: parseBool(optional('TOPUP_SANDBOX', 'false'), false),
  topupWebhookSecret: optional('TOPUP_WEBHOOK_SECRET'),
  maxUploadBytes: Number(optional('MAX_UPLOAD_BYTES', String(5 * 1024 * 1024))),

  serveFrontend: parseBool(optional('SERVE_FRONTEND', 'false'), false),

  cookieSecure: parseBool(optional('COOKIE_SECURE', 'true'), true),
  cookieSameSite: optional('COOKIE_SAME_SITE', 'none').toLowerCase()
};

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
