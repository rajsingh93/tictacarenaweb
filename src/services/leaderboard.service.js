'use strict';

const { rpc } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { ladderEntry, ladderSelf } = require('../utils/mappers');

const TYPES = ['global', 'weekly', 'monthly', 'friends'];
const MAX_PLAYERS = 50;

const LADDER_CACHE = new Map();
const LADDER_CACHE_TTL = 15 * 1000; // 15 seconds

async function topPlayers(type = 'global', limit = 5) {
  const selected = TYPES.includes(type) ? type : 'global';
  const cached = LADDER_CACHE.get(selected);
  if (cached && Date.now() - cached.at < LADDER_CACHE_TTL) {
    return cached.players.slice(0, limit);
  }
  const data = await rpc(
    'get_leaderboard',
    { p_type: selected, p_user_id: 1 },
    'Could not load the leaderboard'
  ).catch(() => null);
  if (data?.players) {
    const players = (data.players || []).slice(0, MAX_PLAYERS).map(ladderEntry);
    LADDER_CACHE.set(selected, { players, at: Date.now() });
    return players.slice(0, limit);
  }
  return cached?.players ? cached.players.slice(0, limit) : [];
}

async function get(user, type) {
  const selected = TYPES.includes(type) ? type : 'global';
  const data = await rpc(
    'get_leaderboard',
    { p_type: selected, p_user_id: user.id },
    'Could not load the leaderboard'
  );
  if (!data) throw ApiError.internal('Leaderboard is unavailable');
  const players = (data.players || []).slice(0, MAX_PLAYERS).map(ladderEntry);
  if (selected !== 'friends') {
    LADDER_CACHE.set(selected, { players, at: Date.now() });
  }
  return {
    type: selected,
    players,
    myRank: data.myRank ?? null,
    myUser: ladderSelf(data.myUser)
  };
}

module.exports = { get, topPlayers, MAX_PLAYERS };
