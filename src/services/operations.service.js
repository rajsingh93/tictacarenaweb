'use strict';

const { admin, one, many, rpc, count } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { cleanText, cleanMultiline } = require('../utils/sanitize');
const notificationService = require('./notification.service');
const leaderboardService = require('./leaderboard.service');
const chatService = require('./chat.service');

const ANNOUNCEMENT_KEY = 'announcements';
const ANNOUNCEMENT_LIMIT = 50;
const TOURNAMENT_STATUSES = ['draft', 'open', 'live', 'completed', 'cancelled'];
const TOURNAMENT_FORMATS = ['single_elimination', 'round_robin', 'swiss'];

function isMissingTable(error) {
  const message = String(error?.message || '');
  return (
    error?.code === '42P01' ||
    /does not exist|schema cache|relation .* not found/i.test(message)
  );
}

function toId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest('INVALID_ID', 'Invalid identifier');
  }
  return id;
}

/* ------------------------------------------------------------
   Audit log
   ------------------------------------------------------------ */
async function logActivity(adminUser, action, { targetType = null, targetId = null, details = null } = {}) {
  try {
    const { error } = await admin.from('admin_activity').insert({
      admin_id: adminUser?.id || null,
      admin_username: adminUser?.username || 'system',
      action: cleanText(action, 80) || 'unknown',
      target_type: targetType ? cleanText(targetType, 40) : null,
      target_id: targetId !== null && targetId !== undefined ? String(targetId).slice(0, 64) : null,
      details: details || null
    });
    if (error) console.warn('[admin] audit log unavailable:', error.message);
  } catch (error) {
    // The audit trail must never break the action it records.
    console.warn('[admin] audit log failed:', error.message);
  }
}

const ACTIVITY_FALLBACK_ACTIONS = [
  { source: 'auth', label: 'Account verification' },
  { source: 'match', label: 'Match settled' }
];

async function activity({ limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const { data, error } = await admin
    .from('admin_activity')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error) {
    if (isMissingTable(error)) {
      return { activities: [], setupRequired: true, fallback: ACTIVITY_FALLBACK_ACTIONS };
    }
    throw new ApiError(502, 'DATABASE_ERROR', 'Could not load the activity log');
  }
  return { activities: data || [], setupRequired: false };
}

/* ------------------------------------------------------------
   Reports and analytics
   ------------------------------------------------------------ */
async function reports({ days = 30 } = {}) {
  const range = Math.min(Math.max(Number(days) || 30, 7), 90);
  const since = new Date(Date.now() - range * 24 * 60 * 60 * 1000).toISOString();

  const [charts, stats, newUsers, newMatches, openTickets, bans, modeRows, orders, top] =
    await Promise.all([
      rpc('get_admin_charts', {}, 'Could not load analytics').catch(() => ({})),
      rpc('get_admin_stats', {}, 'Could not load analytics').catch(() => ({})),
      count(
        admin.from('users').select('*', { count: 'exact', head: true }).gte('created_at', since).eq('is_bot', false)
      ).catch(() => 0),
      count(
        admin.from('matches').select('*', { count: 'exact', head: true }).gte('created_at', since)
      ).catch(() => 0),
      count(
        admin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'open')
      ).catch(() => 0),
      count(
        admin.from('users').select('*', { count: 'exact', head: true }).eq('is_banned', true)
      ).catch(() => 0),
      many(
        admin.from('matches').select('mode').gte('created_at', since).limit(5000),
        'Could not load matches'
      ).catch(() => []),
      many(
        admin
          .from('topup_orders')
          .select('price_cents, status')
          .eq('status', 'completed')
          .gte('created_at', since)
          .limit(5000),
        'Could not load top-ups'
      ).catch(() => []),
      leaderboardService.get({ id: 0 }, 'global').catch(() => ({ players: [] }))
    ]);

  const modes = { ranked: 0, friendly: 0, training: 0 };
  modeRows.forEach((row) => {
    if (modes[row.mode] !== undefined) modes[row.mode] += 1;
  });

  const revenueCents = orders.reduce((sum, row) => sum + (Number(row.price_cents) || 0), 0);

  return {
    range: { days: range, since },
    summary: {
      totalUsers: stats?.totalUsers ?? 0,
      newUsers,
      matches: newMatches,
      totalMatches: stats?.totalMatches ?? 0,
      openTickets,
      bannedUsers: bans,
      revenueCents,
      completedTopups: orders.length,
      messages: stats?.totalMessages ?? 0,
      friendships: stats?.totalFriendships ?? 0
    },
    modes,
    revenue: { cents: revenueCents, currency: orders[0] ? 'USD' : 'USD', orders: orders.length },
    daily: {
      users: charts?.dailyUsers || [],
      matches: charts?.dailyMatches || [],
      messages: charts?.dailyMessages || []
    },
    topPlayers: (top.players || []).slice(0, 10)
  };
}

/* ------------------------------------------------------------
   Leaderboard rewards
   ------------------------------------------------------------ */
async function rewardTopPlayers(adminUser, { count: playerCount = 3, amount = 100, reason = '' } = {}) {
  const size = Math.min(Math.max(Number(playerCount) || 3, 1), 10);
  const coins = Math.min(Math.max(Number(amount) || 100, 1), 100000);
  const note = cleanText(reason, 160) || `Top ${size} ladder reward`;

  const ladder = await leaderboardService.get(adminUser, 'global');
  const targets = (ladder.players || []).slice(0, size);
  if (!targets.length) throw ApiError.badRequest('NO_PLAYERS', 'There are no ranked players to reward');

  const awarded = [];
  for (const player of targets) {
    try {
      await rpc(
        'credit_coins',
        {
          p_user_id: player.id,
          p_amount: coins,
          p_type: 'admin_gift',
          p_description: note,
          p_reference_type: 'admin',
          p_reference_id: String(adminUser.id)
        },
        'Could not reward a player'
      );
      await notificationService.create({
        userId: player.id,
        type: 'reward',
        title: '🏆 Leaderboard reward',
        description: `${note}: ${coins.toLocaleString()} coins added to your wallet.`,
        actionData: { coins }
      });
      awarded.push({ id: player.id, username: player.username, coins });
    } catch (error) {
      console.warn('[admin] reward failed for', player.username, error.message);
    }
  }

  await logActivity(adminUser, 'leaderboard.reward', {
    targetType: 'leaderboard',
    targetId: 'global',
    details: { count: awarded.length, coins, note }
  });

  return {
    message: `Rewarded ${awarded.length} player${awarded.length === 1 ? '' : 's'} with ${coins} coins`,
    awarded
  };
}

/* ------------------------------------------------------------
   Announcements / notification management
   ------------------------------------------------------------ */
async function announcementHistory() {
  const row = await one(
    admin.from('app_settings').select('value').eq('key', ANNOUNCEMENT_KEY).maybeSingle(),
    'Could not load announcements'
  ).catch(() => null);
  const items = Array.isArray(row?.value?.items) ? row.value.items : [];
  return { announcements: items.slice(0, ANNOUNCEMENT_LIMIT) };
}

async function announce(adminUser, { message }) {
  const text = cleanText(message, 300);
  if (!text) throw ApiError.badRequest('EMPTY_ANNOUNCEMENT', 'Write an announcement first');

  const recipients = await notificationService.broadcast({
    type: 'system',
    title: 'Arena announcement',
    description: text
  });

  const history = await announcementHistory();
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    message: text,
    sentBy: adminUser.username,
    createdAt: new Date().toISOString(),
    recipients
  };
  const items = [entry, ...history.announcements].slice(0, ANNOUNCEMENT_LIMIT);
  await one(
    admin
      .from('app_settings')
      .upsert({ key: ANNOUNCEMENT_KEY, value: { items } }, { onConflict: 'key' })
      .select('key')
      .single(),
    'Could not save the announcement'
  );

  await logActivity(adminUser, 'notification.announce', {
    targetType: 'broadcast',
    targetId: entry.id,
    details: { recipients, message: text.slice(0, 120) }
  });

  return { message: `Announcement sent to ${recipients} players`, announcement: entry, recipients };
}

async function deleteAnnouncement(adminUser, id) {
  const history = await announcementHistory();
  const items = history.announcements.filter((item) => String(item.id) !== String(id));
  if (items.length === history.announcements.length) {
    throw ApiError.notFound('ANNOUNCEMENT_NOT_FOUND', 'That announcement no longer exists');
  }
  await one(
    admin
      .from('app_settings')
      .upsert({ key: ANNOUNCEMENT_KEY, value: { items } }, { onConflict: 'key' })
      .select('key')
      .single(),
    'Could not update announcements'
  );
  await logActivity(adminUser, 'notification.delete', { targetType: 'broadcast', targetId: id });
  return { message: 'Announcement removed from history' };
}

/* ------------------------------------------------------------
   World chat moderation
   ------------------------------------------------------------ */
async function worldChat({ limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 50);
  const rows = await many(
    admin
      .from('world_chat_messages')
      .select(
        'id, message, created_at, player:users!world_chat_messages_sender_id_fkey(id, username, avatar_url, avatar_emoji, level, rank_title)'
      )
      .order('id', { ascending: false })
      .limit(safeLimit),
    'Could not load world chat'
  );
  return { messages: rows.map(chatService.worldRow) };
}

async function deleteWorldMessage(adminUser, id) {
  const messageId = toId(id);
  const row = await one(
    admin.from('world_chat_messages').select('id, sender_id, message').eq('id', messageId).maybeSingle(),
    'Could not load that message'
  );
  if (!row) throw ApiError.notFound('MESSAGE_NOT_FOUND', 'That message no longer exists');
  await one(
    admin.from('world_chat_messages').delete().eq('id', messageId).select('id'),
    'Could not delete the message'
  );
  await notificationService.create({
    userId: row.sender_id,
    type: 'system',
    title: 'Message removed',
    description: 'A moderator removed one of your world chat messages for breaking the arena rules.'
  });
  await logActivity(adminUser, 'moderation.world_chat.delete', {
    targetType: 'world_message',
    targetId: messageId,
    details: { message: String(row.message).slice(0, 120) }
  });
  return { message: 'Message deleted and the author notified' };
}

/* ------------------------------------------------------------
   Tournaments
   ------------------------------------------------------------ */
function normalizeTournament(input = {}) {
  const name = cleanText(input.name, 80);
  if (!name || name.length < 3) {
    throw ApiError.badRequest('INVALID_NAME', 'Tournament name must be at least 3 characters');
  }
  const format = TOURNAMENT_FORMATS.includes(input.format) ? input.format : 'single_elimination';
  const mode = ['ranked', 'friendly'].includes(input.mode) ? input.mode : 'ranked';
  const status = TOURNAMENT_STATUSES.includes(input.status) ? input.status : 'draft';
  const maxPlayers = Math.min(Math.max(Number(input.max_players) || 16, 2), 256);
  const entryFee = Math.min(Math.max(Number(input.entry_fee) || 0, 0), 1000000);
  const prizePool = Math.min(Math.max(Number(input.prize_pool) || 0, 0), 10000000);
  const startsAt = input.starts_at ? new Date(input.starts_at) : null;
  if (startsAt && Number.isNaN(startsAt.getTime())) {
    throw ApiError.badRequest('INVALID_DATE', 'Enter a valid start date');
  }
  return {
    name,
    description: cleanMultiline(input.description, 1000),
    format,
    mode,
    max_players: maxPlayers,
    entry_fee: entryFee,
    prize_pool: prizePool,
    status,
    starts_at: startsAt ? startsAt.toISOString() : null
  };
}

async function listTournaments() {
  const { data, error } = await admin
    .from('tournaments')
    .select('*, tournament_entries(count)')
    .order('starts_at', { ascending: false, nullsFirst: false })
    .limit(100);
  if (error) {
    if (isMissingTable(error)) return { tournaments: [], setupRequired: true };
    throw new ApiError(502, 'DATABASE_ERROR', 'Could not load tournaments');
  }
  return {
    tournaments: (data || []).map((row) => ({
      ...row,
      entry_count: Number(row.tournament_entries?.[0]?.count || 0)
    })),
    setupRequired: false
  };
}

async function saveTournament(adminUser, input = {}) {
  const payload = normalizeTournament(input);
  const id = input.id ? toId(input.id) : null;

  if (id) {
    const existing = await one(
      admin.from('tournaments').select('id').eq('id', id).maybeSingle(),
      'Could not load that tournament'
    );
    if (!existing) throw ApiError.notFound('TOURNAMENT_NOT_FOUND', 'Tournament not found');
    const row = await one(
      admin.from('tournaments').update(payload).eq('id', id).select('*').single(),
      'Could not update the tournament'
    );
    await logActivity(adminUser, 'tournament.update', { targetType: 'tournament', targetId: id });
    return { message: 'Tournament updated', tournament: row };
  }

  const row = await one(
    admin
      .from('tournaments')
      .insert({ ...payload, created_by: adminUser.id })
      .select('*')
      .single(),
    'Could not create the tournament'
  );
  await logActivity(adminUser, 'tournament.create', { targetType: 'tournament', targetId: row.id });
  return { message: 'Tournament created', tournament: row };
}

async function deleteTournament(adminUser, id) {
  const tournamentId = toId(id);
  const row = await one(
    admin.from('tournaments').select('id, name').eq('id', tournamentId).maybeSingle(),
    'Could not load that tournament'
  );
  if (!row) throw ApiError.notFound('TOURNAMENT_NOT_FOUND', 'Tournament not found');
  await one(
    admin.from('tournaments').delete().eq('id', tournamentId).select('id'),
    'Could not delete the tournament'
  );
  await logActivity(adminUser, 'tournament.delete', {
    targetType: 'tournament',
    targetId: tournamentId,
    details: { name: row.name }
  });
  return { message: 'Tournament deleted' };
}

async function listTournamentsForPlayer(user) {
  const { data, error } = await admin
    .from('tournaments')
    .select('id, name, description, format, mode, max_players, entry_fee, prize_pool, status, starts_at, tournament_entries(count)')
    .in('status', ['open', 'live', 'completed'])
    .order('starts_at', { ascending: true, nullsFirst: false })
    .limit(50);
  if (error) {
    if (isMissingTable(error)) return { tournaments: [], setupRequired: true };
    throw new ApiError(502, 'DATABASE_ERROR', 'Could not load tournaments');
  }

  let joined = new Set();
  try {
    const rows = await many(
      admin.from('tournament_entries').select('tournament_id').eq('user_id', user.id),
      'Could not load your tournaments'
    );
    joined = new Set(rows.map((row) => String(row.tournament_id)));
  } catch (_) {
    joined = new Set();
  }

  return {
    tournaments: (data || []).map((row) => ({
      ...row,
      entry_count: Number(row.tournament_entries?.[0]?.count || 0),
      joined: joined.has(String(row.id))
    })),
    setupRequired: false
  };
}

async function joinTournament(user, id) {
  const tournamentId = toId(id);
  const tournament = await one(
    admin.from('tournaments').select('*').eq('id', tournamentId).maybeSingle(),
    'Could not load that tournament'
  );
  if (!tournament) throw ApiError.notFound('TOURNAMENT_NOT_FOUND', 'Tournament not found');
  if (tournament.status !== 'open') {
    throw ApiError.badRequest('REGISTRATION_CLOSED', 'Registration is not open for this tournament');
  }
  if (tournament.starts_at && new Date(tournament.starts_at).getTime() < Date.now()) {
    throw ApiError.badRequest('TOURNAMENT_STARTED', 'This tournament has already started');
  }

  const entries = await count(
    admin
      .from('tournament_entries')
      .select('*', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId)
  );
  if (entries >= Number(tournament.max_players)) {
    throw ApiError.conflict('TOURNAMENT_FULL', 'This tournament is full');
  }

  const existing = await one(
    admin
      .from('tournament_entries')
      .select('tournament_id')
      .eq('tournament_id', tournamentId)
      .eq('user_id', user.id)
      .maybeSingle(),
    'Could not check your entry'
  );
  if (existing) return { message: 'You are already registered', joined: true };

  if (Number(tournament.entry_fee) > 0) {
    await rpc(
      'credit_coins',
      {
        p_user_id: user.id,
        p_amount: -Math.abs(Number(tournament.entry_fee)),
        p_type: 'shop_purchase',
        p_description: `Entry fee: ${tournament.name}`,
        p_reference_type: 'tournament',
        p_reference_id: String(tournamentId)
      },
      'Could not charge the entry fee'
    );
  }

  try {
    await one(
      admin
        .from('tournament_entries')
        .insert({ tournament_id: tournamentId, user_id: user.id })
        .select('tournament_id')
        .single(),
      'Could not join the tournament'
    );
  } catch (error) {
    // Refund the fee when the insert lost a race for the last seat.
    if (Number(tournament.entry_fee) > 0) {
      await rpc(
        'credit_coins',
        {
          p_user_id: user.id,
          p_amount: Math.abs(Number(tournament.entry_fee)),
          p_type: 'refund',
          p_description: `Refund: ${tournament.name}`,
          p_reference_type: 'tournament',
          p_reference_id: String(tournamentId)
        },
        'Could not refund the entry fee'
      ).catch(() => null);
    }
    throw error;
  }

  return { message: 'You are registered', joined: true };
}

async function leaveTournament(user, id) {
  const tournamentId = toId(id);
  const tournament = await one(
    admin.from('tournaments').select('*').eq('id', tournamentId).maybeSingle(),
    'Could not load that tournament'
  );
  if (!tournament) throw ApiError.notFound('TOURNAMENT_NOT_FOUND', 'Tournament not found');
  if (tournament.status === 'live') {
    throw ApiError.badRequest('TOURNAMENT_LIVE', 'You cannot leave a live tournament');
  }
  const entry = await one(
    admin
      .from('tournament_entries')
      .select('tournament_id')
      .eq('tournament_id', tournamentId)
      .eq('user_id', user.id)
      .maybeSingle(),
    'Could not check your entry'
  );
  if (!entry) throw ApiError.notFound('NOT_REGISTERED', 'You are not registered');

  await one(
    admin
      .from('tournament_entries')
      .delete()
      .eq('tournament_id', tournamentId)
      .eq('user_id', user.id)
      .select('tournament_id'),
    'Could not leave the tournament'
  );

  if (Number(tournament.entry_fee) > 0 && tournament.status === 'open') {
    await rpc(
      'credit_coins',
      {
        p_user_id: user.id,
        p_amount: Math.abs(Number(tournament.entry_fee)),
        p_type: 'refund',
        p_description: `Refund: ${tournament.name}`,
        p_reference_type: 'tournament',
        p_reference_id: String(tournamentId)
      },
      'Could not refund the entry fee'
    ).catch(() => null);
  }

  return { message: 'You left the tournament', joined: false };
}

module.exports = {
  logActivity,
  activity,
  reports,
  rewardTopPlayers,
  announcementHistory,
  announce,
  deleteAnnouncement,
  worldChat,
  deleteWorldMessage,
  listTournaments,
  saveTournament,
  deleteTournament,
  listTournamentsForPlayer,
  joinTournament,
  leaveTournament
};
