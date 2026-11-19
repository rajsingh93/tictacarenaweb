'use strict';

/**
 * Small per-socket sliding-window limiter. Socket.IO events are cheap to spam,
 * so every user-generated event gets a minimum gap and a window budget.
 */
function createRateLimiter({ minIntervalMs = 0, windowMs = 60_000, max = 60 } = {}) {
  const hits = [];
  let lastAt = 0;

  return function allow(now = Date.now()) {
    if (minIntervalMs && now - lastAt < minIntervalMs) return false;

    while (hits.length && now - hits[0] > windowMs) hits.shift();
    if (hits.length >= max) return false;

    hits.push(now);
    lastAt = now;
    return true;
  };
}

function limited(socket, event, message = 'You are sending events too quickly. Please slow down.') {
  socket.emit('rate:limited', { event, error: message });
}

module.exports = { createRateLimiter, limited };
