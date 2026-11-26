'use strict';

/**
 * Feature flags read by public endpoints and gameplay services.
 * The console writes the `feature_flags` rows; this module keeps a short cache
 * so a toggle reaches every request within 30 seconds without a DB read each
 * time. A missing table (fresh install) falls back to the supplied default.
 */

const { many, admin } = require('../utils/db');

const TTL_MS = 30_000;
let cached = null;
let expiresAt = 0;
let loading = null;

async function load() {
  if (cached && Date.now() < expiresAt) return cached;
  if (loading) return loading;
  loading = (async () => {
    try {
      const rows = await many(
        admin.from('feature_flags').select('key, enabled, rollout_percent').limit(200),
        'Could not load feature flags'
      );
      cached = Object.fromEntries(
        rows.map((row) => [
          String(row.key),
          { enabled: Boolean(row.enabled), rollout: Number(row.rollout_percent) || 0 }
        ])
      );
      expiresAt = Date.now() + TTL_MS;
      return cached;
    } catch (_) {
      cached = {};
      expiresAt = Date.now() + TTL_MS;
      return cached;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

async function enabled(key, fallback = true) {
  const flags = await load();
  const row = flags[String(key)];
  if (!row) return fallback;
  return row.enabled;
}

async function all() {
  return load();
}

function invalidate() {
  cached = null;
  expiresAt = 0;
}

module.exports = { enabled, all, invalidate, TTL_MS };
