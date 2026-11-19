'use strict';

const { admin, count, many } = require('../utils/db');

/**
 * Public, non-sensitive arena stats used by the About page.
 * Bot accounts are excluded so player numbers reflect real accounts.
 */
async function publicStats() {
  const [players, matches, online, topPlayers] = await Promise.all([
    count(
      admin.from('users').select('*', { count: 'exact', head: true }).eq('is_bot', false),
      'Could not load player count'
    ),
    count(
      admin.from('matches').select('*', { count: 'exact', head: true }),
      'Could not load match count'
    ),
    count(
      admin
        .from('users')
        .select('*', { count: 'exact', head: true })
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

  return { players, matches, online, topPlayers };
}

module.exports = { publicStats };
