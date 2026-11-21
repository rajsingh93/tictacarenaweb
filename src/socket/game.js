'use strict';

const crypto = require('crypto');
const { admin, one, rpc } = require('../utils/db');
const { GAME_REWARDS } = require('../config/constants');
const presence = require('./presence');
const notificationService = require('../services/notification.service');
const chatService = require('../services/chat.service');
const friendService = require('../services/friend.service');
const userService = require('../services/user.service');
const { createRateLimiter, limited } = require('./rateLimit');

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

const PLAYER_FIELDS = 'id, username, avatar_url, avatar_emoji, level, rank_title, is_online';

const TURN_MS = 30_000;
const DISCONNECT_FORFEIT_MS = 10_000;
const QUEUE_MAX_MS = 5 * 60_000;
const FINISHED_RETENTION_MS = 2 * 60_000;
const ABANDONED_GAME_MS = 30 * 60_000;

const games = new Map();
/** @type {Array<{socketId:string,userId:string,joinedAt:number}>} */
const matchmakingQueue = [];
const rooms = new Map();
/**
 * Pending friend invites keyed by `${roomCode}:${friendId}`. The key makes an
 * invite idempotent: tapping "Invite" twice never creates a duplicate invite
 * or a duplicate notification for the same friend and room.
 */
const pendingInvites = new Map();
const INVITE_TTL_MS = 5 * 60_000;
/** Authoritative index: one unfinished game per user. */
const activeGameByUser = new Map();
/** Users temporarily reserved while an async game start is in flight. */
const reservedUsers = new Set();

let io = null;

function generateId() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = crypto.randomBytes(6).toString('hex');
    if (!games.has(id)) return id;
  }
  throw new Error('Could not allocate a game id');
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = '';
    for (let i = 0; i < 6; i += 1) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error('Could not allocate a room code');
}

function playerView(user) {
  return {
    id: user.id,
    username: user.username,
    avatar_url: user.avatar_url,
    avatar_emoji: user.avatar_emoji,
    level: user.level,
    rank_title: user.rank_title
  };
}

async function loadPlayer(userId) {
  const row = await one(
    admin.from('users').select(PLAYER_FIELDS).eq('id', userId).maybeSingle(),
    'Could not load a player'
  );
  return row ? playerView(row) : null;
}

function winnerMark(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}

function normalizedBoard(board) {
  return board.map((cell) => cell || '-').join('');
}

function activeGameForUser(userId) {
  const gameId = activeGameByUser.get(String(userId));
  if (!gameId) return null;
  const game = games.get(gameId);
  if (!game || game.finished) {
    activeGameByUser.delete(String(userId));
    return null;
  }
  return game;
}

function hasActiveGame(userId) {
  return Boolean(activeGameForUser(userId));
}

function inviteKey(roomCode, friendId) {
  return `${roomCode}:${String(friendId)}`;
}

function clearRoomInvites(roomCode) {
  for (const [key, invite] of pendingInvites) {
    if (invite.roomCode === roomCode) pendingInvites.delete(key);
  }
}

function socketIsLive(socketId) {
  return Boolean(socketId && io.sockets.sockets.get(socketId));
}

function reserveUser(userId) {
  const key = String(userId);
  if (reservedUsers.has(key)) return false;
  if (hasActiveGame(key)) return false;
  reservedUsers.add(key);
  return true;
}

function releaseUser(userId) {
  reservedUsers.delete(String(userId));
}

function reservePair(firstId, secondId) {
  if (String(firstId) === String(secondId)) return false;
  if (!reserveUser(firstId)) return false;
  if (!reserveUser(secondId)) {
    releaseUser(firstId);
    return false;
  }
  return true;
}

function releasePair(firstId, secondId) {
  releaseUser(firstId);
  releaseUser(secondId);
}

function scheduleCleanup(gameId) {
  setTimeout(() => {
    const game = games.get(gameId);
    if (!game) return;
    if (game.disconnectTimers) {
      Object.values(game.disconnectTimers).forEach((timer) => clearTimeout(timer));
    }
    if (game.turnTimer) clearTimeout(game.turnTimer);
    games.delete(gameId);
  }, FINISHED_RETENTION_MS).unref?.();
}

function clearGameTimers(game) {
  if (game.turnTimer) {
    clearTimeout(game.turnTimer);
    game.turnTimer = null;
  }
  if (game.disconnectTimers) {
    for (const mark of ['X', 'O']) {
      if (game.disconnectTimers[mark]) {
        clearTimeout(game.disconnectTimers[mark]);
        game.disconnectTimers[mark] = null;
      }
    }
  }
}

function armTurnTimer(game) {
  if (game.finished) return;
  if (game.turnTimer) clearTimeout(game.turnTimer);

  const mark = game.currentTurn;
  game.turnDeadline = Date.now() + TURN_MS;
  game.turnTimer = setTimeout(() => {
    if (game.finished || game.currentTurn !== mark) return;
    const result = mark === 'X' ? 'player2' : 'player1';
    finishGame(game, result, { forfeit: true, reason: 'TURN_TIMEOUT' }).catch((error) => {
      console.error('[socket] turn timeout settlement failed:', error.message);
    });
  }, TURN_MS);
  game.turnTimer.unref?.();
}

async function startGame({ mode, first, second }) {
  if (String(first.userId) === String(second.userId)) {
    return null;
  }
  if (hasActiveGame(first.userId) || hasActiveGame(second.userId)) {
    for (const entry of [first, second]) {
      entry.socket.emit('matchmaking:error', {
        error: 'One of the players is already in a match.'
      });
    }
    return null;
  }

  const gameId = generateId();
  const [p1, p2] = await Promise.all([loadPlayer(first.userId), loadPlayer(second.userId)]);
  if (!p1 || !p2) {
    first.socket.emit('matchmaking:cancelled', { reason: 'PLAYER_LEFT' });
    second.socket.emit('matchmaking:cancelled', { reason: 'PLAYER_LEFT' });
    return null;
  }

  // Re-check after the async load: a room or queue match may have completed.
  if (hasActiveGame(first.userId) || hasActiveGame(second.userId)) {
    return null;
  }

  const game = {
    id: gameId,
    mode,
    board: Array(9).fill(null),
    currentTurn: 'X',
    moveCount: 0,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    turnDeadline: null,
    turnTimer: null,
    finished: false,
    result: null,
    players: {
      X: { userId: first.userId, socketId: first.socket.id, user: p1 },
      O: { userId: second.userId, socketId: second.socket.id, user: p2 }
    },
    rematchRequests: new Set(),
    rematchStarting: false,
    disconnectTimers: { X: null, O: null }
  };

  games.set(gameId, game);
  activeGameByUser.set(String(first.userId), gameId);
  activeGameByUser.set(String(second.userId), gameId);

  const s1 = io.sockets.sockets.get(first.socket.id);
  const s2 = io.sockets.sockets.get(second.socket.id);
  if (s1) s1.join(`game:${gameId}`);
  if (s2) s2.join(`game:${gameId}`);

  const payload = {
    gameId,
    mode,
    player1: p1,
    player2: p2,
    board: game.board,
    currentTurn: 'X',
    moveCount: 0,
    startTime: game.startedAt
  };

  armTurnTimer(game);
  const deadline = game.turnDeadline;

  if (s1) s1.emit('game:start', { ...payload, yourMark: 'X', turnDeadline: deadline });
  if (s2) s2.emit('game:start', { ...payload, yourMark: 'O', turnDeadline: deadline });

  return game;
}

function rewardFor(mode, outcome) {
  const table = GAME_REWARDS[mode] || GAME_REWARDS.ranked;
  return table[outcome];
}

async function settleWithRetry(params, attempts = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await rpc('settle_match', params, 'Could not save the match result');
    } catch (error) {
      lastError = error;
      if (error?.code && !['DATABASE_ERROR'].includes(error.code)) break;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
  }
  throw lastError || new Error('Could not save the match result');
}

async function finishGame(game, result, { forfeit = false, reason = null } = {}) {
  if (game.finished) return;
  game.finished = true;
  game.result = result;
  game.lastActivity = Date.now();
  clearGameTimers(game);

  if (activeGameByUser.get(String(game.players.X.userId)) === game.id) {
    activeGameByUser.delete(String(game.players.X.userId));
  }
  if (activeGameByUser.get(String(game.players.O.userId)) === game.id) {
    activeGameByUser.delete(String(game.players.O.userId));
  }

  const mode = game.mode;
  const outcomes = {
    player1: { player1: 'win', player2: 'loss' },
    player2: { player1: 'loss', player2: 'win' },
    draw: { player1: 'draw', player2: 'draw' }
  }[result];
  const p1Reward = { ...rewardFor(mode, outcomes.player1), result: outcomes.player1 };
  const p2Reward = { ...rewardFor(mode, outcomes.player2), result: outcomes.player2 };
  const duration = Math.max(0, Math.floor((Date.now() - game.startedAt) / 1000));
  const winnerId =
    result === 'draw'
      ? null
      : result === 'player1'
        ? game.players.X.userId
        : game.players.O.userId;

  let persisted = true;
  try {
    await settleWithRetry({
      p_game_key: `game:${game.id}`,
      p_player1_id: game.players.X.userId,
      p_player2_id: game.players.O.userId,
      p_winner_id: winnerId,
      p_mode: mode,
      p_result: result,
      p_board_state: normalizedBoard(game.board),
      p_duration_seconds: duration,
      p_xp_p1: p1Reward.xp,
      p_xp_p2: p2Reward.xp,
      p_coins_p1: p1Reward.coins,
      p_coins_p2: p2Reward.coins,
      p_score_p1: p1Reward.score,
      p_score_p2: p2Reward.score,
      p_comeback_win: false
    });
  } catch (error) {
    persisted = false;
    console.error('[socket] match settlement failed:', error.message);
  }

  io.to(`game:${game.id}`).emit('game:end', {
    gameId: game.id,
    result,
    winner: result === 'draw' ? null : result === 'player1' ? 'X' : 'O',
    board: game.board,
    forfeit,
    reason,
    persisted,
    duration,
    rewards: {
      player1: p1Reward,
      player2: p2Reward
    }
  });

  for (const mark of ['X', 'O']) {
    const player = game.players[mark];
    const socket = io.sockets.sockets.get(player.socketId);
    if (!socket) continue;
    socket.emit('game:finished', {
      gameId: game.id,
      result:
        mark === 'X'
          ? result
          : result === 'draw'
            ? 'draw'
            : result === 'player1'
              ? 'player2'
              : 'player1'
    });
  }

  scheduleCleanup(game.id);
}

function removeQueueBySocket(socketId) {
  for (let index = matchmakingQueue.length - 1; index >= 0; index -= 1) {
    if (matchmakingQueue[index].socketId === socketId) matchmakingQueue.splice(index, 1);
  }
}

function removeQueueByUser(userId) {
  const key = String(userId);
  for (let index = matchmakingQueue.length - 1; index >= 0; index -= 1) {
    if (matchmakingQueue[index].userId === key) matchmakingQueue.splice(index, 1);
  }
}

function pumpMatchmakingQueue() {
  let paired = false;

  for (let i = 0; i < matchmakingQueue.length; i += 1) {
    const first = matchmakingQueue[i];
    if (!socketIsLive(first.socketId) || hasActiveGame(first.userId)) {
      matchmakingQueue.splice(i, 1);
      i -= 1;
      continue;
    }

    let secondIndex = -1;
    for (let j = i + 1; j < matchmakingQueue.length; j += 1) {
      const candidate = matchmakingQueue[j];
      if (candidate.userId === first.userId) continue;
      if (!socketIsLive(candidate.socketId)) continue;
      if (hasActiveGame(candidate.userId)) continue;
      secondIndex = j;
      break;
    }

    if (secondIndex === -1) continue;

    const second = matchmakingQueue[secondIndex];
    if (!reservePair(first.userId, second.userId)) continue;

    // Remove both entries only after the reservation succeeds.
    for (let index = matchmakingQueue.length - 1; index >= 0; index -= 1) {
      if (matchmakingQueue[index] === first || matchmakingQueue[index] === second) {
        matchmakingQueue.splice(index, 1);
      }
    }

    const firstSocket = io.sockets.sockets.get(first.socketId);
    const secondSocket = io.sockets.sockets.get(second.socketId);
    if (!firstSocket || !secondSocket) {
      releasePair(first.userId, second.userId);
      continue;
    }

    paired = true;
    startGame({
      mode: 'ranked',
      first: { socket: firstSocket, userId: first.userId },
      second: { socket: secondSocket, userId: second.userId }
    })
      .catch((error) => {
        console.error('[socket] startGame failed:', error.message);
        firstSocket.emit('matchmaking:error', { error: 'Could not start the match. Please try again.' });
        secondSocket.emit('matchmaking:error', { error: 'Could not start the match. Please try again.' });
      })
      .finally(() => {
        releasePair(first.userId, second.userId);
      });

    i = -1;
  }

  return paired;
}

function handleDisconnect(socket) {
  removeQueueBySocket(socket.id);

  for (const [code, room] of rooms) {
    if (room.hostSocketId === socket.id) {
      // Keep the room (and its pending invites) alive briefly so a socket
      // reconnect does not cancel a challenge the friend is about to accept.
      room.hostSocketId = null;
      room.hostDisconnectedAt = Date.now();
    }
  }

  const game = activeGameForUser(socket.user.id);
  if (!game) return;

  for (const mark of ['X', 'O']) {
    const player = game.players[mark];
    if (player.socketId !== socket.id) continue;
    if (game.disconnectTimers[mark]) clearTimeout(game.disconnectTimers[mark]);

    game.disconnectTimers[mark] = setTimeout(() => {
      if (game.finished) return;
      if (game.players[mark].socketId !== socket.id) return;
      const opponent = mark === 'X' ? 'O' : 'X';
      finishGame(game, opponent === 'X' ? 'player1' : 'player2', {
        forfeit: true,
        reason: 'DISCONNECT'
      }).catch((error) => {
        console.error('[socket] forfeit failed:', error.message);
      });
    }, DISCONNECT_FORFEIT_MS);
    game.disconnectTimers[mark].unref?.();
  }
}

function gameForUser(gameId, userId, { allowFinished = false } = {}) {
  const id = String(gameId || '');
  let game = id ? games.get(id) : null;
  let mark = null;

  if (game) {
    for (const candidate of ['X', 'O']) {
      if (String(game.players[candidate].userId) === String(userId)) {
        mark = candidate;
        break;
      }
    }
    if (mark && (allowFinished || !game.finished)) return { game, mark };
  }

  if (!allowFinished) {
    game = activeGameForUser(userId);
    if (!game) return null;
    for (const candidate of ['X', 'O']) {
      if (String(game.players[candidate].userId) === String(userId)) {
        return { game, mark: candidate };
      }
    }
  }

  return null;
}

function setupGameHandlers(socketServer) {
  io = socketServer;

  io.on('connection', (socket) => {
    const user = socket.user;

    // A reconnecting host takes back the room they were waiting in, so the
    // invitee can still accept and the host still receives game:start.
    for (const room of rooms.values()) {
      if (room.hostUserId === String(user.id) && !room.hostSocketId) {
        room.hostSocketId = socket.id;
        room.hostDisconnectedAt = null;
        socket.join(`room:${room.code}`);
      }
    }

    const matchmakingLimiter = createRateLimiter({ minIntervalMs: 1500, windowMs: 60_000, max: 20 });
    // No minimum gap: rapid legal turns are legitimate, and duplicate or
    // out-of-turn clicks are rejected by the authoritative game state.
    const moveLimiter = createRateLimiter({ minIntervalMs: 0, windowMs: 10_000, max: 40 });
    const gameChatLimiter = createRateLimiter({ minIntervalMs: 1000, windowMs: 60_000, max: 30 });
    const inviteLimiter = createRateLimiter({ minIntervalMs: 4000, windowMs: 60_000, max: 12 });
    const rematchLimiter = createRateLimiter({ minIntervalMs: 1800, windowMs: 60_000, max: 10 });
    const roomLimiter = createRateLimiter({ minIntervalMs: 1500, windowMs: 60_000, max: 20 });
    const stateLimiter = createRateLimiter({ minIntervalMs: 300, windowMs: 60_000, max: 40 });

    // Compatibility with the old client handshake. Identity is the session.
    socket.on('register', (data, ack) => {
      if (typeof data === 'function') {
        ack = data;
      }
      if (typeof ack === 'function') ack({ ok: true, user: playerView(user) });
      socket.emit('registered', { ok: true, user: playerView(user) });
    });

    socket.on('stats:getOnline', () => {
      socket.emit('stats:online', { count: presence.count() });
    });

    // ------------------------------------------------------------
    // Ranked matchmaking
    // ------------------------------------------------------------
    socket.on('matchmaking:join', (data = {}) => {
      if (!matchmakingLimiter()) {
        limited(socket, 'matchmaking:join');
        return;
      }

      if (data.mode === 'friendly') {
        socket.emit('matchmaking:error', { error: 'Create or join a friend room instead.' });
        return;
      }

      if (hasActiveGame(user.id)) {
        socket.emit('matchmaking:error', {
          error: 'You are already in a match. Finish it before searching again.'
        });
        return;
      }

      const existing = matchmakingQueue.find((entry) => entry.userId === String(user.id));
      if (existing) {
        existing.socketId = socket.id;
        existing.joinedAt = Date.now();
        socket.emit('matchmaking:searching', { position: matchmakingQueue.length, mode: 'ranked' });
        return;
      }

      matchmakingQueue.push({
        socketId: socket.id,
        userId: String(user.id),
        joinedAt: Date.now()
      });
      socket.emit('matchmaking:searching', { position: matchmakingQueue.length, mode: 'ranked' });
      pumpMatchmakingQueue();
    });

    socket.on('matchmaking:cancel', () => {
      removeQueueByUser(user.id);
      socket.emit('matchmaking:cancelled', { reason: 'CANCELLED' });
    });

    // ------------------------------------------------------------
    // Friendly rooms
    // ------------------------------------------------------------
    socket.on('room:create', () => {
      if (!roomLimiter()) return;
      if (hasActiveGame(user.id)) {
        socket.emit('room:error', { error: 'You are already in a match.' });
        return;
      }
      for (const [code, room] of rooms) {
        if (room.hostUserId === String(user.id)) {
          rooms.delete(code);
          clearRoomInvites(code);
        }
      }
      const code = generateRoomCode();
      rooms.set(code, {
        code,
        hostSocketId: socket.id,
        hostUserId: String(user.id),
        hostUsername: user.username,
        createdAt: Date.now()
      });
      socket.join(`room:${code}`);
      socket.emit('room:created', { code });
    });

    socket.on('room:join', (data = {}) => {
      if (!roomLimiter()) return;
      const code = String(data.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return socket.emit('room:error', { error: 'Room not found' });
      if (room.hostUserId === String(user.id)) {
        return socket.emit('room:error', { error: 'You are already hosting this room' });
      }
      if (hasActiveGame(user.id) || hasActiveGame(room.hostUserId)) {
        return socket.emit('room:error', { error: 'One of the players is already in a match.' });
      }

      let hostSocket = room.hostSocketId ? io.sockets.sockets.get(room.hostSocketId) : null;
      if (!hostSocket) {
        // The host may have reconnected on a different socket (or another
        // tab). Re-bind the room to a live socket for the same account.
        const fallbackId = presence.socketsFor(room.hostUserId)[0];
        hostSocket = fallbackId ? io.sockets.sockets.get(fallbackId) : null;
        if (hostSocket) room.hostSocketId = hostSocket.id;
      }
      if (!hostSocket) {
        return socket.emit('room:error', { error: 'The host is reconnecting. Try again in a moment.' });
      }

      if (!reservePair(room.hostUserId, user.id)) {
        return socket.emit('room:error', { error: 'One of the players is already in a match.' });
      }

      // A friend accepted an invite: tell the host so the waiting panel can
      // switch to "starting…" before game:start arrives.
      const accepted = pendingInvites.get(inviteKey(code, user.id));
      if (accepted) {
        pendingInvites.delete(inviteKey(code, user.id));
        presence.socketsFor(room.hostUserId).forEach((socketId) => {
          io.to(socketId).emit('room:inviteAccepted', {
            roomCode: code,
            inviteId: accepted.inviteId,
            friendId: user.id,
            username: user.username
          });
        });
      }

      rooms.delete(code);
      clearRoomInvites(code);
      startGame({
        mode: 'friendly',
        first: { socket: hostSocket, userId: room.hostUserId },
        second: { socket, userId: String(user.id) }
      })
        .then((game) => {
          if (!game) return;
          // game:start only reaches the sockets that created/joined the room.
          // Broadcasting to each player's user room guarantees the sender is
          // redirected even after a reconnect or from another tab, and gives
          // the client a second signal if one event is delayed or dropped.
          for (const playerId of [room.hostUserId, String(user.id)]) {
            io.to(`user:${playerId}`).emit('room:matchStarted', {
              gameId: game.id,
              roomCode: code,
              mode: game.mode
            });
          }
        })
        .catch((error) => {
          console.error('[socket] room start failed:', error.message);
          socket.emit('room:error', { error: 'Could not start the friendly match.' });
          hostSocket.emit('room:error', { error: 'Could not start the friendly match.' });
        })
        .finally(() => {
          releasePair(room.hostUserId, user.id);
        });
    });

    socket.on('room:invite', async (data = {}) => {
      if (!inviteLimiter()) {
        socket.emit('room:error', { error: 'Please wait before sending another invite.' });
        return;
      }
      try {
        const friendId = Number(data.friendId);
        if (!Number.isInteger(friendId) || friendId <= 0) {
          return socket.emit('room:error', { error: 'Choose a friend to invite' });
        }
        if (friendId === Number(user.id)) {
          return socket.emit('room:error', { error: 'You cannot invite yourself' });
        }

        let room = null;
        for (const candidate of rooms.values()) {
          if (candidate.hostUserId === String(user.id)) {
            room = candidate;
            break;
          }
        }
        if (!room) return socket.emit('room:error', { error: 'Create a room first' });

        const friends = await friendService.areFriends(user.id, friendId);
        if (!friends) return socket.emit('room:error', { error: 'You can only invite friends' });
        if (await friendService.isBlocked(user.id, friendId)) {
          return socket.emit('room:error', { error: 'You cannot invite this player' });
        }
        if (await friendService.isBlocked(friendId, user.id)) {
          return socket.emit('room:error', { error: 'This player is not accepting invites' });
        }
        if (hasActiveGame(friendId)) {
          return socket.emit('room:error', { error: 'This player is already in a match' });
        }

        const targetSettings = await userService.getSettings(friendId);
        if (targetSettings.match_invites === false) {
          return socket.emit('room:error', { error: 'This player does not accept match invites' });
        }

        const key = inviteKey(room.code, friendId);
        const existing = pendingInvites.get(key);
        if (existing && Date.now() - existing.createdAt < INVITE_TTL_MS) {
          // Idempotent re-invite: confirm to the host without spamming the friend.
          socket.emit('room:invitedSent', {
            roomCode: room.code,
            inviteId: existing.inviteId,
            deduped: true
          });
          return;
        }

        const inviteId = crypto.randomBytes(6).toString('hex');
        pendingInvites.set(key, {
          inviteId,
          roomCode: room.code,
          hostId: String(user.id),
          friendId: String(friendId),
          createdAt: Date.now()
        });

        await notificationService.create({
          userId: friendId,
          type: 'match',
          title: 'Match Invite',
          description: `${user.username} invited you to a friendly match!`,
          actionData: {
            room_code: room.code,
            invite_id: inviteId,
            host_id: user.id,
            host_name: user.username
          }
        });

        const sockets = presence.socketsFor(friendId);
        sockets.forEach((socketId) => {
          io.to(socketId).emit('room:invited', {
            inviteId,
            senderName: user.username,
            senderId: user.id,
            sender: playerView(user),
            roomCode: room.code,
            expiresAt: Date.now() + INVITE_TTL_MS
          });
        });
        socket.emit('room:invitedSent', { roomCode: room.code, inviteId });
      } catch (error) {
        console.error('[socket] room:invite failed:', error.message);
        socket.emit('room:error', { error: 'Could not send the invite' });
      }
    });

    socket.on('room:invite:decline', (data = {}) => {
      if (!inviteLimiter()) return;
      const roomCode = String(data.roomCode || '').trim().toUpperCase();
      if (!roomCode) return;
      const key = inviteKey(roomCode, user.id);
      const invite = pendingInvites.get(key);
      if (!invite) return;
      pendingInvites.delete(key);
      presence.socketsFor(invite.hostId).forEach((socketId) => {
        io.to(socketId).emit('room:inviteDeclined', {
          roomCode,
          inviteId: invite.inviteId,
          friendId: user.id,
          username: user.username
        });
      });
      socket.emit('room:invite:declined', { roomCode });
    });

    // ------------------------------------------------------------
    // Game lifecycle
    // ------------------------------------------------------------
    // Lets a client that missed game:start (reconnect, background tab,
    // duplicate invite) discover the match it is already part of.
    socket.on('game:current', () => {
      if (!stateLimiter()) return;
      const game = activeGameForUser(user.id);
      socket.emit('game:current', game ? { gameId: game.id, mode: game.mode } : { gameId: null });
    });

    socket.on('game:rejoin', (data = {}) => {
      const match = gameForUser(data.gameId, user.id);
      if (!match) {
        return socket.emit('game:rejoinError', { error: 'Game not found or already ended' });
      }
      const { game, mark } = match;
      if (game.disconnectTimers[mark]) {
        clearTimeout(game.disconnectTimers[mark]);
        game.disconnectTimers[mark] = null;
      }
      game.players[mark].socketId = socket.id;
      game.lastActivity = Date.now();
      socket.join(`game:${game.id}`);
      socket.emit('game:rejoined', {
        gameId: game.id,
        mode: game.mode,
        yourMark: mark,
        player1: game.players.X.user,
        player2: game.players.O.user,
        board: game.board,
        currentTurn: game.currentTurn,
        moveCount: game.moveCount,
        isOver: game.finished,
        turnDeadline: game.turnDeadline,
        startTime: game.startedAt
      });
      // Let the opponent know their rival is back.
      socket.to(`game:${game.id}`).emit('game:opponentRejoined', { gameId: game.id, username: user.username });
    });

    socket.on('game:forfeit', (data = {}) => {
      const match = gameForUser(data.gameId, user.id);
      if (!match) return;
      const { game, mark } = match;
      if (game.finished) return;
      const result = mark === 'X' ? 'player2' : 'player1';
      finishGame(game, result, { forfeit: true, reason: 'FORFEIT' }).catch((error) => {
        console.error('[socket] forfeit failed:', error.message);
      });
    });

    socket.on('game:move', (data = {}) => {
      if (!moveLimiter()) {
        limited(socket, 'game:move');
        return;
      }
      const match = gameForUser(data.gameId, user.id);
      if (!match) {
        socket.emit('game:invalidMove', { error: 'That game is no longer active.' });
        return;
      }
      const { game, mark } = match;

      if (game.finished) {
        socket.emit('game:invalidMove', { error: 'This match has already ended.' });
        return;
      }
      if (game.currentTurn !== mark) {
        socket.emit('game:invalidMove', {
          error: 'It is not your turn.',
          board: game.board,
          currentTurn: game.currentTurn
        });
        return;
      }

      const cell = Number(data.cellIndex);
      if (!Number.isInteger(cell) || cell < 0 || cell > 8) {
        socket.emit('game:invalidMove', { error: 'Invalid cell.' });
        return;
      }
      if (game.board[cell] !== null) {
        socket.emit('game:invalidMove', { error: 'That cell is already taken.' });
        return;
      }

      game.board[cell] = mark;
      game.moveCount += 1;
      game.lastActivity = Date.now();

      const winner = winnerMark(game.board);
      if (winner) {
        finishGame(game, winner === 'X' ? 'player1' : 'player2').catch((error) => {
          console.error('[socket] finishGame failed:', error.message);
        });
        return;
      }
      if (game.moveCount >= 9) {
        finishGame(game, 'draw').catch((error) => {
          console.error('[socket] finishGame failed:', error.message);
        });
        return;
      }

      game.currentTurn = mark === 'X' ? 'O' : 'X';
      armTurnTimer(game);
      io.to(`game:${game.id}`).emit('game:state', {
        board: game.board,
        currentTurn: game.currentTurn,
        moveCount: game.moveCount,
        lastMove: cell,
        lastMoveBy: mark,
        turnDeadline: game.turnDeadline
      });
    });

    socket.on('game:chat', (data = {}) => {
      if (!gameChatLimiter()) {
        socket.emit('game:chatError', { error: 'Please wait before sending another message.' });
        return;
      }
      const match = gameForUser(data.gameId, user.id);
      if (!match) return;
      try {
        const message = chatService.validateMessage(data.message);
        io.to(`game:${match.game.id}`).emit('game:chatMessage', {
          userId: user.id,
          senderId: user.id,
          username: user.username,
          avatar_url: user.avatar_url,
          avatar_emoji: user.avatar_emoji,
          message,
          time: 'just now',
          timestamp: Date.now()
        });
      } catch (error) {
        socket.emit('game:chatError', { error: error.message });
      }
    });

    socket.on('game:rematch', (data = {}) => {
      if (!rematchLimiter()) {
        socket.emit('game:rejoinError', { error: 'Please wait before requesting another rematch.' });
        return;
      }

      const match = gameForUser(data.gameId, user.id, { allowFinished: true });
      if (!match) return;
      const { game } = match;
      if (!game.finished) return;
      if (game.rematchStarting) {
        socket.emit('game:rematchQueued', { gameId: game.id, status: 'starting' });
        return;
      }

      game.rematchRequests.add(String(user.id));
      const opponentMark = String(game.players.X.userId) === String(user.id) ? 'O' : 'X';
      const opponent = game.players[opponentMark];

      presence.socketsFor(opponent.userId).forEach((socketId) => {
        io.to(socketId).emit('game:rematchRequested', {
          gameId: game.id,
          by: user.username,
          requestedBy: user.id
        });
      });

      if (game.rematchRequests.size < 2) {
        socket.emit('game:rematchQueued', {
          gameId: game.id,
          status: 'waiting',
          requestedBy: user.id
        });
        return;
      }

      const oldX = game.players.X;
      const oldO = game.players.O;
      const firstSocket = io.sockets.sockets.get(oldO.socketId) || io.sockets.sockets.get(presence.socketsFor(oldO.userId)[0]);
      const secondSocket = io.sockets.sockets.get(oldX.socketId) || io.sockets.sockets.get(presence.socketsFor(oldX.userId)[0]);

      if (!firstSocket || !secondSocket) {
        game.rematchRequests.clear();
        socket.emit('game:rejoinError', { error: 'Your opponent disconnected. Start a new match.' });
        return;
      }

      game.rematchStarting = true;
      if (!reservePair(oldO.userId, oldX.userId)) {
        game.rematchStarting = false;
        game.rematchRequests.clear();
        socket.emit('game:rejoinError', { error: 'A rematch could not be started. Please try again.' });
        return;
      }

      startGame({
        mode: game.mode,
        first: { socket: firstSocket, userId: oldO.userId },
        second: { socket: secondSocket, userId: oldX.userId }
      })
        .catch((error) => {
          console.error('[socket] rematch failed:', error.message);
          socket.emit('game:rejoinError', { error: 'Could not start the rematch.' });
        })
        .finally(() => {
          game.rematchStarting = false;
          releasePair(oldO.userId, oldX.userId);
        });
    });

    socket.on('disconnect', () => {
      handleDisconnect(socket);
    });
  });

  const sweeper = setInterval(() => {
    const now = Date.now();

    for (let index = matchmakingQueue.length - 1; index >= 0; index -= 1) {
      const entry = matchmakingQueue[index];
      const expired = now - entry.joinedAt > QUEUE_MAX_MS;
      if (expired || !socketIsLive(entry.socketId)) {
        matchmakingQueue.splice(index, 1);
        if (expired) {
          io.to(entry.socketId).emit('matchmaking:timeout', {
            error: 'No opponent was found. Please try again.'
          });
        }
      }
    }

    for (const [code, room] of rooms) {
      const emptyTooLong =
        room.hostDisconnectedAt && now - room.hostDisconnectedAt > 60_000;
      if (emptyTooLong || now - room.createdAt > 5 * 60_000) {
        rooms.delete(code);
        clearRoomInvites(code);
      }
    }

    for (const [key, invite] of pendingInvites) {
      if (now - invite.createdAt > INVITE_TTL_MS) pendingInvites.delete(key);
    }

    for (const [id, game] of games) {
      if (game.finished) {
        if (now - game.startedAt > 10 * 60_000) games.delete(id);
        continue;
      }

      if (now - game.lastActivity > ABANDONED_GAME_MS) {
        clearGameTimers(game);
        game.finished = true;
        activeGameByUser.delete(String(game.players.X.userId));
        activeGameByUser.delete(String(game.players.O.userId));
        games.delete(id);
      }
    }
  }, 30_000);
  sweeper.unref?.();
}

function activeState() {
  return {
    onlineUsers: presence.count(),
    matchmakingQueue: matchmakingQueue.length,
    activeGames: [...games.values()].filter((game) => !game.finished).length,
    openRooms: rooms.size
  };
}

module.exports = { setupGameHandlers, activeState };
