'use strict';

const { Server } = require('socket.io');
const env = require('../config/env');
const { loadUserFromToken } = require('../middleware/auth');
const { originAllowed } = require('../utils/origin');
const presence = require('./presence');
const { setupGameHandlers, activeState, liveGames, cancelLiveGame } = require('./game');
const { setupChatHandlers } = require('./chat');

function parseCookies(header = '') {
  return header.split(';').reduce((acc, part) => {
    const index = part.indexOf('=');
    if (index === -1) return acc;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!key) return acc;
    try {
      acc[key] = decodeURIComponent(raw);
    } catch (_) {
      acc[key] = raw;
    }
    return acc;
  }, {});
}

function socketToken(socket) {
  const authToken = socket.handshake.auth?.token;
  if (typeof authToken === 'string' && authToken.trim()) return authToken.trim();

  const header = String(socket.handshake.headers?.authorization || '');
  if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();

  const cookies = parseCookies(socket.handshake.headers.cookie || '');
  return cookies[env.sessionCookie] || null;
}

async function authenticateSocket(socket) {
  const token = socketToken(socket);
  if (!token) throw new Error('Please sign in to continue');

  // Reuse the HTTP auth path so the 15s user cache and centralized session
  // revocation checks apply to socket connections too.
  let user;
  try {
    user = await loadUserFromToken(token);
  } catch (error) {
    throw new Error(error?.message || 'Unauthorized');
  }
  if (user.is_bot) throw new Error('Bot accounts cannot connect');
  if (user.email_verified !== true) {
    throw new Error('Please verify your email address before connecting');
  }
  return user;
}

function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin(origin, callback) {
        return callback(null, originAllowed(origin));
      },
      credentials: true,
      methods: ['GET', 'POST']
    },
    maxHttpBufferSize: 100 * 1024
  });

  io.use(async (socket, next) => {
    try {
      if (!originAllowed(socket.handshake.headers.origin)) {
        throw new Error('Origin not allowed');
      }
      socket.user = await authenticateSocket(socket);
      next();
    } catch (error) {
      next(new Error(error.message || 'Unauthorized'));
    }
  });

  presence.attach(io);

  io.on('connection', (socket) => {
    presence.attachSocket(socket);
    socket.join(`user:${socket.user.id}`);
    socket.emit('session:ready', {
      user: {
        id: socket.user.id,
        username: socket.user.username,
        is_admin: Boolean(socket.user.is_admin)
      }
    });
    socket.emit('onlineCount', presence.count());
    socket.emit('stats:online', { count: presence.count() });

    socket.on('disconnect', () => {
      presence.detachSocket(socket);
    });
  });

  setupGameHandlers(io);
  setupChatHandlers(io);

  return io;
}

module.exports = { createSocketServer, activeState, liveGames, cancelLiveGame };
