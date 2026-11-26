'use strict';

const { admin, one, many } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { cleanText, cleanMultiline } = require('../utils/sanitize');
const { matchSummary } = require('../utils/mappers');

const MATCH_COLUMNS =
  'id, mode, status, result, winner_id, player1_id, player2_id, duration_seconds, xp_p1, xp_p2, coins_p1, coins_p2, created_at';

const DISPUTE_COLUMNS =
  'id, match_id, reason, details, evidence_url, status, resolution, resolved_at, created_at, updated_at';

function parseMatchId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest('INVALID_MATCH', 'Invalid match');
  }
  return id;
}

async function listMine(user) {
  const disputes = await many(
    admin
      .from('match_disputes')
      .select(DISPUTE_COLUMNS)
      .eq('reported_by', user.id)
      .order('created_at', { ascending: false })
      .limit(50),
    'Could not load your disputes'
  );

  if (!disputes.length) return { disputes: [] };

  const matchIds = [...new Set(disputes.map((dispute) => dispute.match_id))];
  const matches = await many(
    admin
      .from('matches')
      .select(
        `${MATCH_COLUMNS}, ` +
          'player1:users!matches_player1_id_fkey(id, username, avatar_url, avatar_emoji), ' +
          'player2:users!matches_player2_id_fkey(id, username, avatar_url, avatar_emoji)'
      )
      .in('id', matchIds),
    'Could not load the disputed matches'
  );
  const byId = new Map(matches.map((match) => [String(match.id), match]));

  return {
    disputes: disputes.map((dispute) => {
      const match = byId.get(String(dispute.match_id));
      return {
        ...dispute,
        match: match ? matchSummary(match, user.id) : null
      };
    })
  };
}

async function createForMatch(user, matchIdValue, input = {}) {
  const matchId = parseMatchId(matchIdValue);
  const match = await one(
    admin
      .from('matches')
      .select('id, mode, status, player1_id, player2_id')
      .eq('id', matchId)
      .maybeSingle(),
    'Could not load that match'
  );
  if (!match) throw ApiError.notFound('MATCH_NOT_FOUND', 'Match not found');

  const isParticipant =
    String(match.player1_id) === String(user.id) || String(match.player2_id) === String(user.id);
  if (!isParticipant) {
    throw ApiError.forbidden('NOT_YOUR_MATCH', 'You can only dispute your own matches');
  }
  if (match.mode === 'training') {
    throw ApiError.badRequest('TRAINING_MATCH', 'Practice matches cannot be disputed');
  }
  if (match.status === 'voided' || match.status === 'cancelled') {
    throw ApiError.badRequest('MATCH_VOIDED', 'This match has already been voided');
  }

  const existing = await one(
    admin
      .from('match_disputes')
      .select('id, status, created_at')
      .eq('match_id', matchId)
      .eq('reported_by', user.id)
      .in('status', ['open', 'reviewing'])
      .limit(1)
      .maybeSingle(),
    'Could not check your existing disputes'
  );
  if (existing) {
    return {
      message: 'You already have an open dispute for this match',
      dispute: existing
    };
  }

  const reason = cleanText(input.reason, 160);
  if (reason.length < 3) {
    throw ApiError.badRequest('INVALID_REASON', 'Tell us what happened');
  }
  const details = cleanMultiline(input.details, 2000);
  const evidenceUrl = cleanText(input.evidenceUrl, 500) || null;

  const dispute = await one(
    admin
      .from('match_disputes')
      .insert({
        match_id: matchId,
        reported_by: user.id,
        reason,
        details,
        evidence_url: evidenceUrl
      })
      .select(DISPUTE_COLUMNS)
      .single(),
    'Could not submit your dispute'
  );

  // Keep the match out of normal result flows until a moderator resolves it.
  await one(
    admin
      .from('matches')
      .update({ status: 'disputed' })
      .eq('id', matchId)
      .select('id')
      .single(),
    'Could not mark the match as disputed'
  );

  return { message: 'Dispute submitted. Our team will review it.', dispute };
}

module.exports = { listMine, createForMatch };
