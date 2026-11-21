'use strict';

const { admin, count, many } = require('../utils/db');

let statsCache = null;
let statsCacheExpiry = 0;
let statsPromise = null;
const STATS_TTL_MS = 60000; // 60 seconds cache

/**
 * Public, non-sensitive arena stats used by the About page.
 * Bot accounts are excluded so player numbers reflect real accounts.
 */
async function publicStats() {
  const now = Date.now();
  if (statsCache && now < statsCacheExpiry) {
    return statsCache;
  }
  if (statsPromise) return statsPromise;
  statsPromise = (async () => {
    try {
      const [players, matches, online, topPlayers] = await Promise.all([
        count(
          admin.from('users').select('id', { count: 'exact', head: true }).eq('is_bot', false),
          'Could not load player count'
        ),
        count(
          admin.from('matches').select('id', { count: 'exact', head: true }),
          'Could not load match count'
        ),
        count(
          admin
            .from('users')
            .select('id', { count: 'exact', head: true })
            .eq('is_bot', false)
            .eq('is_online', true),
          'Could not load online count'
        ),
        many(
          admin
            .from('users')
            .select('id, username, avatar_url, avatar_emoji, rank_title, level, score, wins')
            .eq('is_bot', false)
            .order('score', { ascending: false })
            .order('id', { ascending: true })
            .limit(4),
          'Could not load top players'
        )
      ]);

      statsCache = { players, matches, online, topPlayers };
      statsCacheExpiry = Date.now() + STATS_TTL_MS;
      return statsCache;
    } finally {
      statsPromise = null;
    }
  })();
  return statsPromise;
}

module.exports = { publicStats };
