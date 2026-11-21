'use strict';

const chatService = require('../services/chat.service');
const notificationService = require('../services/notification.service');
const presence = require('./presence');
const { createRateLimiter, limited } = require('./rateLimit');

let io = null;

// Only the fields the chat bubble renders; the client computes its own
// relative timestamps.
function chatPayload(row) {
  return {
    id: row.id,
    sender_id: row.sender_id,
    receiver_id: row.receiver_id,
    message: row.message,
    created_at: row.created_at
  };
}

function sendToUser(userId, event, payload) {
  presence.socketsFor(userId).forEach((socketId) => {
    io.to(socketId).emit(event, payload);
  });
}

function setupChatHandlers(socketServer) {
  io = socketServer;

  io.on('connection', (socket) => {
    const user = socket.user;

    const chatLimiter = createRateLimiter({ minIntervalMs: 1200, windowMs: 60_000, max: 30 });
    const typingLimiter = createRateLimiter({ minIntervalMs: 900, windowMs: 60_000, max: 60 });
    const readLimiter = createRateLimiter({ minIntervalMs: 900, windowMs: 60_000, max: 60 });
    const worldHistoryLimiter = createRateLimiter({ minIntervalMs: 1500, windowMs: 60_000, max: 20 });
    const worldLimiter = createRateLimiter({ minIntervalMs: 2500, windowMs: 5 * 60_000, max: 30 });
    const announceLimiter = createRateLimiter({ minIntervalMs: 10_000, windowMs: 60_000, max: 6 });

    // ------------------------------------------------------------
    // Personal chat
    // ------------------------------------------------------------
    socket.on('chat:send', async (data = {}, ack) => {
      const respond = (payload) => {
        if (typeof ack === 'function') ack(payload);
      };

      if (!chatLimiter()) {
        limited(socket, 'chat:send', 'Please wait a moment before sending another message.');
        socket.emit('chat:error', { error: 'Please wait a moment before sending another message.' });
        respond({ ok: false, error: 'Please wait a moment before sending another message.' });
        return;
      }

      try {
        const receiverId = Number(data.receiverId || data.friendId);
        if (!Number.isInteger(receiverId) || receiverId <= 0) {
          throw new Error('Choose a player to message');
        }
        const { row, receiver } = await chatService.saveMessage(user, receiverId, data.message);

        const payload = chatPayload(row);
        // The sender may have several tabs open, so deliver to every socket.
        sendToUser(user.id, 'chat:message', payload);
        sendToUser(receiver.id, 'chat:message', payload);
        sendToUser(receiver.id, 'chat:unread', { senderId: user.id });

        respond({ ok: true, message: payload });
      } catch (error) {
        socket.emit('chat:error', { error: error.message });
        respond({ ok: false, error: error.message });
      }
    });

    socket.on('chat:typing', (data = {}) => {
      if (!typingLimiter()) return;
      const receiverId = Number(data.receiverId || data.friendId);
      if (!Number.isInteger(receiverId) || receiverId <= 0) return;
      sendToUser(receiverId, 'chat:typing', {
        senderId: user.id,
        isTyping: Boolean(data.isTyping)
      });
    });

    socket.on('chat:read', async (data = {}) => {
      if (!readLimiter()) return;
      try {
        const friendId = Number(data.friendId);
        if (!Number.isInteger(friendId) || friendId <= 0) return;
        await chatService.markRead(user, friendId);
        sendToUser(friendId, 'chat:read', { by: user.id });
      } catch (error) {
        console.warn('[socket] chat:read failed:', error.message);
      }
    });

    // ------------------------------------------------------------
    // World chat
    // ------------------------------------------------------------
    socket.on('worldchat:history', async (data = {}) => {
      if (!worldHistoryLimiter()) return;
      try {
        const page = await chatService.worldHistory(50, data?.before);
        // Legacy clients expect an array on this event.
        socket.emit('worldchat:history', page.messages);
      } catch (error) {
        socket.emit('worldchat:history', []);
      }
    });

    socket.on('worldchat:send', async (data = {}) => {
      if (!worldLimiter()) {
        socket.emit('worldchat:error', { error: 'Please wait a moment before sending another message.' });
        return;
      }
      try {
        const message = await chatService.saveWorldMessage(user, data.message);
        io.emit('worldchat:message', message);
      } catch (error) {
        socket.emit('worldchat:error', { error: error.message });
      }
    });

    // ------------------------------------------------------------
    // Admin announcements
    // ------------------------------------------------------------
    socket.on('admin:announce', async (data = {}) => {
      if (!user.is_admin) {
        socket.emit('admin:error', { error: 'Admin access required' });
        return;
      }
      if (!announceLimiter()) {
        socket.emit('admin:error', { error: 'Please wait before sending another announcement.' });
        return;
      }
      try {
        const message = chatService.validateMessage(data.message);
        io.emit('server:announcement', { message, timestamp: Date.now() });

        await notificationService.broadcast({
          type: 'system',
          title: 'Announcement',
          description: message
        });

        socket.emit('admin:announced', { ok: true });
      } catch (error) {
        socket.emit('admin:error', { error: error.message });
      }
    });
  });
}

module.exports = { setupChatHandlers };
