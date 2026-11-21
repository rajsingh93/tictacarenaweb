'use strict';

const { ApiError } = require('./ApiError');

/**
 * Bounded in-process guard against password guessing, keyed by email + IP.
 * It complements the shared HTTP rate limiter and Supabase's own auth
 * throttling; it is not a replacement for a shared store in a multi-instance
 * deployment. Failed attempts expire instead of growing without limit.
 */
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

const attempts = new Map();

function keyOf(email, ip) {
  return `${String(email || '').trim().toLowerCase()}|${ip || 'unknown'}`;
}

function prune(now) {
  for (const [key, entry] of attempts) {
    if (now - entry.last > FAILURE_WINDOW_MS && (!entry.lockedUntil || entry.lockedUntil <= now)) {
      attempts.delete(key);
    }
  }
}

function assertAllowed(key) {
  const now = Date.now();
  prune(now);
  const entry = attempts.get(key);
  if (!entry || !entry.lockedUntil || entry.lockedUntil <= now) return;
  const seconds = Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000));
  throw ApiError.tooMany(
    'LOGIN_LOCKED',
    `Too many failed sign-in attempts for this account. Try again in ${seconds} seconds.`
  );
}

function recordFailure(key) {
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, last: now, lockedUntil: 0 };
  entry.count += 1;
  entry.last = now;
  if (entry.count >= MAX_FAILURES) entry.lockedUntil = now + LOCKOUT_MS;
  attempts.set(key, entry);
}

function clear(key) {
  attempts.delete(key);
}

module.exports = { keyOf, assertAllowed, recordFailure, clear, MAX_FAILURES };
