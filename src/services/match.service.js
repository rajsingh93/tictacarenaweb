'use strict';

const { admin, one, many, rpc, count } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { matchForUser, publicUser } = require('../utils/mappers');
const { GAME_REWARDS } = require('../config/constants');

const BOT_USERNAME = 'TicBot';

async function history(user, { page = 1, limit = 20 } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const from = (safePage - 1) * safeLimit;
  const to = from + safeLimit - 1;

  const [rows, total] = await Promise.all([
    many(
      admin
        .from('matches')
        .select(
          '*, player1:users!matches_player1_id_fkey(id, username, avatar_url, avatar_emoji, level, rank_title), player2:users!matches_player2_id_fkey(id, username, avatar_url, avatar_emoji, level, rank_title)'
        )
        .or(`player1_id.eq.${user.id},player2_id.eq.${user.id}`)
        .order('created_at', { ascending: false })
        .range(from, to),
      'Could not load your match history'
    ),
    count(
      admin
        .from('matches')
        .select('*', { count: 'exact', head: true })
        .or(`player1_id.eq.${user.id},player2_id.eq.${user.id}`),
      'Could not count your matches'
    )
  ]);

  return {
    matches: rows.map((row) => matchForUser(row, user.id)),
    total,
    page: safePage,
    pages: Math.ceil(total / safeLimit) || 1
  };
}

async function getMatch(user, matchId) {
  const id = Number(matchId);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('INVALID_MATCH', 'Invalid match id');

  const row = await one(
    admin
      .from('matches')
      .select(
        '*, player1:users!matches_player1_id_fkey(id, username, avatar_url, avatar_emoji, level, rank_title), player2:users!matches_player2_id_fkey(id, username, avatar_url, avatar_emoji, level, rank_title)'
      )
      .eq('id', id)
      .maybeSingle(),
    'Could not load the match'
  );

  if (!row) throw ApiError.notFound('MATCH_NOT_FOUND', 'Match not found');
  if (String(row.player1_id) !== String(user.id) && String(row.player2_id) !== String(user.id)) {
    throw ApiError.forbidden('MATCH_FORBIDDEN', 'You were not part of this match');
  }
  return { match: matchForUser(row, user.id) };
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
    admin.from('users').select('*').eq('username', BOT_USERNAME).maybeSingle(),
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

  const recent = await one(
    admin
      .from('matches')
      .select('id, created_at')
      .eq('player1_id', user.id)
      .eq('mode', 'training')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    'Could not check your recent training games'
  );
  if (recent && Date.now() - new Date(recent.created_at).getTime() < 5000) {
    throw ApiError.tooMany('TRAINING_COOLDOWN', 'Please wait a moment before starting another training game');
  }

  const bot = await botUser();
  const rewards = GAME_REWARDS.training[input.result];
  if (!rewards) throw ApiError.badRequest('INVALID_RESULT', 'Invalid training result');

  const result = input.result === 'win' ? 'player1' : input.result === 'loss' ? 'player2' : 'draw';
  const winnerId = input.result === 'win' ? user.id : input.result === 'loss' ? bot.id : null;
  const gameKey = `training:${user.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  const settled = await rpc(
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
    admin.from('users').select('*').eq('id', user.id).single(),
    'Could not refresh your account'
  );

  const match = settled?.match || null;
  return {
    message: 'Training result saved',
    result: input.result,
    rewards: { xp: rewards.xp, coins: rewards.coins, score: rewards.score },
    match: match
      ? matchForUser({ ...match, player1: publicUser(user), player2: publicUser(bot) }, user.id)
      : null,
    user: publicUser(refreshed, { includePrivate: true })
  };
}

async function stats(user) {
  const rows = await many(
    admin
      .from('matches')
      .select('mode, result, winner_id, player1_id, player2_id, score_p1, score_p2, duration_seconds, created_at')
      .or(`player1_id.eq.${user.id},player2_id.eq.${user.id}`),
    'Could not calculate your stats'
  );

  const summary = {
    total: rows.length,
    wins: 0,
    losses: 0,
    draws: 0,
    ranked: 0,
    friendly: 0,
    training: 0,
    score: 0,
    longest_win_streak: 0
  };

  let streak = 0;
  for (const row of [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))) {
    summary[row.mode] = (summary[row.mode] || 0) + 1;
    const isP1 = String(row.player1_id) === String(user.id);
    summary.score += isP1 ? row.score_p1 : row.score_p2;
    if (row.result === 'draw') {
      summary.draws += 1;
      streak = 0;
    } else if (String(row.winner_id) === String(user.id)) {
      summary.wins += 1;
      streak += 1;
      summary.longest_win_streak = Math.max(summary.longest_win_streak, streak);
    } else {
      summary.losses += 1;
      streak = 0;
    }
  }

  return { stats: summary };
}

module.exports = { history, getMatch, trainingResult, stats, BOT_USERNAME };
