'use strict';

const { admin, one, many, rpc } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { SESSION_USER_COLUMNS, matchSummary, matchDetail, sessionUser } = require('../utils/mappers');
const settingsService = require('./settings.service');

const BOT_USERNAME = 'TicBot';
// Training pays real coins, so cap the rewarded games per UTC day. Practice
// after the cap still records a match, it simply pays nothing.
const TRAINING_DAILY_REWARD_LIMIT = 30;
const MATCH_COLUMNS =
  'id, mode, result, winner_id, player1_id, player2_id, duration_seconds, xp_p1, xp_p2, coins_p1, coins_p2, created_at';
// The board is only read for the single-match detail view.
const MATCH_DETAIL_COLUMNS = `${MATCH_COLUMNS}, board_state`;
const MATCH_PLAYER_JOIN =
  'player1:users!matches_player1_id_fkey(id, username, avatar_url, avatar_emoji), player2:users!matches_player2_id_fkey(id, username, avatar_url, avatar_emoji)';

// The active history is a compact 10-row-per-player projection maintained by
// the database. Reading it needs no count query, no union over two player
// columns and no pagination, and the permanent `matches` ledger is untouched.
const HISTORY_LIMIT = 10;

async function history(user, { limit = HISTORY_LIMIT } = {}) {
  const size = Math.min(Math.max(Number(limit) || HISTORY_LIMIT, 1), HISTORY_LIMIT);
  const rows = await many(
    admin
      .from('match_history')
      .select(`match:matches!match_history_match_id_fkey(${MATCH_COLUMNS}, ${MATCH_PLAYER_JOIN})`)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(size),
    'Could not load your match history'
  );

  return {
    matches: rows.map((row) => row.match).filter(Boolean).map((row) => matchSummary(row, user.id)),
    limit: size
  };
}

async function getMatch(user, matchId) {
  const id = Number(matchId);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('INVALID_MATCH', 'Invalid match id');

  const row = await one(
    admin
      .from('matches')
      .select(`${MATCH_DETAIL_COLUMNS}, ${MATCH_PLAYER_JOIN}`)
      .eq('id', id)
      .maybeSingle(),
    'Could not load the match'
  );

  if (!row) throw ApiError.notFound('MATCH_NOT_FOUND', 'Match not found');
  if (String(row.player1_id) !== String(user.id) && String(row.player2_id) !== String(user.id)) {
    throw ApiError.forbidden('MATCH_FORBIDDEN', 'You were not part of this match');
  }
  return { match: matchDetail(row, user.id) };
}

const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6]
];

function winningMark(cells) {
  for (const [a, b, c] of WIN_LINES) {
    if (cells[a] !== '-' && cells[a] === cells[b] && cells[a] === cells[c]) return cells[a];
  }
  return null;
}

function hasWinningLine(cells, mark) {
  return WIN_LINES.some(([a, b, c]) => cells[a] === mark && cells[b] === mark && cells[c] === mark);
}

function validateBoard(boardState, claimedResult) {
  const cells = String(boardState).split('');
  if (cells.length !== 9 || cells.some((cell) => !['X', 'O', '-'].includes(cell))) {
    throw ApiError.badRequest('INVALID_BOARD', 'That board state is not a valid game');
  }
  const x = cells.filter((cell) => cell === 'X').length;
  const o = cells.filter((cell) => cell === 'O').length;
  if (x !== o && x !== o + 1) {
    throw ApiError.badRequest('INVALID_BOARD', 'That board state is not a valid game');
  }
  const winnerX = hasWinningLine(cells, 'X');
  const winnerO = hasWinningLine(cells, 'O');
  if (winnerX && winnerO) {
    throw ApiError.badRequest('INVALID_BOARD', 'That board state is not a valid game');
  }
  if (winnerX && x !== o + 1) {
    throw ApiError.badRequest('INVALID_BOARD', 'That board state is not a valid game');
  }
  const winner = winnerX ? 'X' : winnerO ? 'O' : null;
  if (claimedResult === 'win' && winner !== 'X') {
    throw ApiError.badRequest('INVALID_BOARD', 'That board does not show a win');
  }
  if (claimedResult === 'loss' && winner !== 'O') {
    throw ApiError.badRequest('INVALID_BOARD', 'That board does not show a loss');
  }
  if (claimedResult === 'draw' && (winner || cells.includes('-'))) {
    throw ApiError.badRequest('INVALID_BOARD', 'That board is not a completed draw');
  }
}

async function botUser() {
  const existing = await one(
    admin.from('users').select('id, username').eq('username', BOT_USERNAME).maybeSingle(),
    'Could not load the training bot'
  );
  if (existing) return existing;
  throw new ApiError(503, 'TRAINING_UNAVAILABLE', 'Training mode is not available right now');
}

/**
 * Persists a completed single-player training game against the seeded bot.
 * Rewards are fixed server-side; the client cannot choose its payout.
 */
async function trainingResult(user, input) {
  validateBoard(input.boardState, input.result);

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const todayTraining = await many(
    admin
      .from('matches')
      .select('id, created_at')
      .eq('player1_id', user.id)
      .eq('mode', 'training')
      .gte('created_at', startOfDay.toISOString())
      .order('created_at', { ascending: false })
      .limit(TRAINING_DAILY_REWARD_LIMIT + 1),
    'Could not check your recent training games'
  );
  const recent = todayTraining[0];
  if (recent && Date.now() - new Date(recent.created_at).getTime() < 5000) {
    throw ApiError.tooMany('TRAINING_COOLDOWN', 'Please wait a moment before starting another training game');
  }

  const bot = await botUser();
  const rewardCapped = todayTraining.length > TRAINING_DAILY_REWARD_LIMIT;
  // Use the administrator-configured reward table instead of the hard-coded
  // defaults, so training pays the same rates the Settings screen shows.
  const rewards = rewardCapped
    ? { xp: 0, coins: 0, score: 0 }
    : await settingsService.rewards('training', input.result);
  if (!rewards) throw ApiError.badRequest('INVALID_RESULT', 'Invalid training result');

  const result = input.result === 'win' ? 'player1' : input.result === 'loss' ? 'player2' : 'draw';
  const winnerId = input.result === 'win' ? user.id : input.result === 'loss' ? bot.id : null;
  const gameKey = `training:${user.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  await rpc(
    'settle_match',
    {
      p_game_key: gameKey,
      p_player1_id: user.id,
      p_player2_id: bot.id,
      p_winner_id: winnerId,
      p_mode: 'training',
      p_result: result,
      p_board_state: input.boardState,
      p_duration_seconds: Math.max(0, Number(input.durationSeconds) || 0),
      p_xp_p1: rewards.xp,
      p_xp_p2: 0,
      p_coins_p1: rewards.coins,
      p_coins_p2: 0,
      p_score_p1: rewards.score,
      p_score_p2: 0,
      p_comeback_win: false
    },
    'Could not save your training result'
  );

  const refreshed = await one(
    admin.from('users').select(SESSION_USER_COLUMNS).eq('id', user.id).single(),
    'Could not refresh your account'
  );

  return {
    message: rewardCapped
      ? 'Training result saved. Daily reward limit reached; practice games no longer pay until tomorrow.'
      : 'Training result saved',
    result: input.result,
    rewards: { xp: rewards.xp, coins: rewards.coins, score: rewards.score },
    capped: rewardCapped,
    user: sessionUser(refreshed)
  };
}

async function stats(user) {
  // Aggregated in PostgreSQL. Loading every match into Node was O(history)
  // and PostgREST row caps made the totals wrong for long-lived accounts.
  const summary = await rpc(
    'get_player_match_stats',
    { p_user_id: user.id },
    'Could not calculate your stats'
  );

  return {
    stats: {
      total: Number(summary?.total || 0),
      wins: Number(summary?.wins || 0),
      losses: Number(summary?.losses || 0),
      draws: Number(summary?.draws || 0),
      ranked: Number(summary?.ranked || 0),
      longest_win_streak: Number(summary?.longest_win_streak || 0)
    }
  };
}

module.exports = { history, getMatch, trainingResult, stats, BOT_USERNAME };
