'use strict';

const userService = require('../services/user.service');

/**
 * Tracks every authenticated socket per user so that multiple tabs/devices
 * share one presence state. `io` is stored once by the bootstrap module.
 */
class Presence {
  constructor() {
    this.io = null;
    this.userSockets = new Map();
  }

  attach(io) {
    this.io = io;
  }

  attachSocket(socket) {
    const key = String(socket.user.id);
    let set = this.userSockets.get(key);
    if (!set) {
      set = new Set();
      this.userSockets.set(key, set);
    }
    const first = set.size === 0;
    set.add(socket.id);
    if (first) {
      userService.setOnline(socket.user.id, true).catch(() => {});
    }
    this.broadcast();
  }

  detachSocket(socket) {
    const key = String(socket.user.id);
    const set = this.userSockets.get(key);
    if (!set) return;
    set.delete(socket.id);
    if (set.size === 0) {
      this.userSockets.delete(key);
      userService.setOnline(socket.user.id, false).catch(() => {});
    }
    this.broadcast();
  }

  isOnline(userId) {
    const set = this.userSockets.get(String(userId));
    return Boolean(set && set.size);
  }

  count() {
    return this.userSockets.size;
  }

  socketsFor(userId) {
    return [...(this.userSockets.get(String(userId)) || [])];
  }

  broadcast() {
    if (!this.io) return;
    const count = this.count();
    this.io.emit('onlineCount', count);
    this.io.emit('stats:online', { count });
  }
}

module.exports = new Presence();
