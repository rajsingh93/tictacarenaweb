'use strict';

const { rpc } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');

const TYPES = ['global', 'weekly', 'monthly', 'friends'];
// The ladder never renders more than 50 rows; enforce the same bound on the
// server so no client can request an unbounded list.
const MAX_PLAYERS = 50;

async function get(user, type) {
  const selected = TYPES.includes(type) ? type : 'global';
  const data = await rpc(
    'get_leaderboard',
    { p_type: selected, p_user_id: user.id },
    'Could not load the leaderboard'
  );
  if (!data) throw ApiError.internal('Leaderboard is unavailable');
  return {
    type: selected,
    players: (data.players || []).slice(0, MAX_PLAYERS),
    limit: MAX_PLAYERS,
    myRank: data.myRank ?? null,
    myUser: data.myUser || null
  };
}

module.exports = { get, MAX_PLAYERS };
