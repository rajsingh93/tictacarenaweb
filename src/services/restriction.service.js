'use strict';

const { admin, many } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');

/**
 * Active player restrictions (chat, world chat, matchmaking, sign-in).
 * The cache is deliberately short: a moderator's mute takes effect within a
 * minute everywhere, while hot chat paths avoid a database round trip.
 */
const TTL_MS = 30_000;
const CACHE = new Map();

const LABELS = {
  chat: 'private chat',
  world_chat: 'world chat',
  matchmaking: 'matchmaking',
  login: 'signing in'
};

function invalidate(userId) {
  if (userId) CACHE.delete(String(userId));
  else CACHE.clear();
}

async function load(userId) {
  const key = String(userId);
  const cached = CACHE.get(key);
  if (cached && cached.expires > Date.now()) return cached.items;

  const rows = await many(
    admin
      .from('user_restrictions')
      .select('id, type, reason, expires_at, created_at')
      .eq('user_id', userId)
      .is('revoked_at', null)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order('created_at', { ascending: false })
      .limit(20),
    'Could not check account restrictions'
  ).catch(() => []);

  CACHE.set(key, { items: rows, expires: Date.now() + TTL_MS });
  while (CACHE.size > 5000) CACHE.delete(CACHE.keys().next().value);
  return rows;
}

async function active(userId) {
  return load(userId);
}

async function assertAllowed(userId, type, message) {
  if (!userId) return;
  const rows = await load(userId);
  const match = rows.find((row) => row.type === type);
  if (!match) return;
  const expiry = match.expires_at ? new Date(match.expires_at).toLocaleString('en-US', { timeZone: 'UTC' }) : null;
  throw ApiError.forbidden(
    'ACCOUNT_RESTRICTED',
    message ||
      `You are restricted from ${LABELS[type] || type}${expiry ? ` until ${expiry} UTC` : ''}.${
        match.reason ? ` Reason: ${match.reason}` : ''
      }`
  );
}

module.exports = { invalidate, active, assertAllowed, TTL_MS };
