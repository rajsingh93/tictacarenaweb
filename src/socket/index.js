'use strict';

const { Server } = require('socket.io');
const env = require('../config/env');
const { admin } = require('../config/supabase');
const { verify } = require('../utils/jwt');
const { originAllowed } = require('../utils/origin');
const presence = require('./presence');
const { setupGameHandlers, activeState } = require('./game');
const { setupChatHandlers } = require('./chat');

const SOCKET_USER_FIELDS =
  'id, username, avatar_url, avatar_emoji, level, rank_title, is_admin, is_banned, is_bot, session_invalid_before';

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

  const payload = verify(token);
  if (payload.purpose !== 'session') throw new Error('Invalid session');

  const { data, error } = await admin
    .from('users')
    .select(SOCKET_USER_FIELDS)
    .eq('id', payload.sub)
    .maybeSingle();
  if (error) throw new Error('Could not load your account');
  if (!data) throw new Error('Account no longer exists');
  if (data.is_banned) throw new Error('This account has been banned');
  if (data.is_bot) throw new Error('Bot accounts cannot connect');
  if (data.session_invalid_before) {
    const issuedAt = Number(payload.iat) * 1000;
    const invalidBefore = new Date(data.session_invalid_before).getTime();
    if (!issuedAt || issuedAt < invalidBefore) {
      throw new Error('Your session has ended. Please sign in again.');
    }
  }
  return data;
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

module.exports = { createSocketServer, activeState };
