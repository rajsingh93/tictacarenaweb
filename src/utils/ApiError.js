'use strict';

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(code, message, details) {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(code = 'UNAUTHORIZED', message = 'Authentication required') {
    return new ApiError(401, code, message);
  }

  static forbidden(code = 'FORBIDDEN', message = 'You do not have permission to do that') {
    return new ApiError(403, code, message);
  }

  static notFound(code = 'NOT_FOUND', message = 'Resource not found') {
    return new ApiError(404, code, message);
  }

  static conflict(code, message) {
    return new ApiError(409, code, message);
  }

  static tooMany(code = 'RATE_LIMITED', message = 'Too many requests') {
    return new ApiError(429, code, message);
  }

  static internal(message = 'Something went wrong') {
    return new ApiError(500, 'INTERNAL_ERROR', message);
  }
}

const RPC_ERRORS = {
  USER_NOT_FOUND: [404, 'USER_NOT_FOUND', 'User not found'],
  ITEM_NOT_FOUND: [404, 'ITEM_NOT_FOUND', 'Shop item not found'],
  ACHIEVEMENT_NOT_FOUND: [404, 'ACHIEVEMENT_NOT_FOUND', 'Achievement not found'],
  NOTIFICATION_NOT_FOUND: [404, 'NOTIFICATION_NOT_FOUND', 'Mail not found'],
  ORDER_NOT_FOUND: [404, 'ORDER_NOT_FOUND', 'Top-up order not found'],
  ALREADY_OWNED: [409, 'ALREADY_OWNED', 'You already own this item'],
  ALREADY_CLAIMED: [409, 'ALREADY_CLAIMED', 'This reward has already been claimed'],
  NOT_ENOUGH_COINS: [400, 'NOT_ENOUGH_COINS', 'You do not have enough coins'],
  NOT_OWNED: [403, 'NOT_OWNED', 'You do not own this item'],
  NO_REWARD: [400, 'NO_REWARD', 'This mail has no reward'],
  ORDER_NOT_PENDING: [409, 'ORDER_NOT_PENDING', 'This order is not pending'],
  INVALID_AMOUNT: [400, 'INVALID_AMOUNT', 'Invalid amount'],
  INVALID_MODE: [400, 'INVALID_MODE', 'Invalid game mode'],
  INVALID_RESULT: [400, 'INVALID_RESULT', 'Invalid match result'],
  INVALID_PLAYERS: [400, 'INVALID_PLAYERS', 'Invalid players'],
  INVALID_WINNER: [400, 'INVALID_WINNER', 'The match winner does not match the result'],
  INVALID_GAME_KEY: [400, 'INVALID_GAME_KEY', 'Invalid game reference'],
  CANNOT_ADD_SELF: [400, 'CANNOT_ADD_SELF', 'You cannot add yourself'],
  CANNOT_BLOCK_SELF: [400, 'CANNOT_BLOCK_SELF', 'You cannot block yourself'],
  BLOCKED: [403, 'BLOCKED', 'You cannot interact with this player'],
  ALREADY_FRIENDS: [409, 'ALREADY_FRIENDS', 'You are already friends'],
  REQUEST_PENDING: [409, 'REQUEST_PENDING', 'Your friend request is already pending'],
  FRIEND_LIMIT: [403, 'FRIEND_LIMIT', 'You have reached the friend limit'],
  REQUEST_NOT_FOUND: [404, 'REQUEST_NOT_FOUND', 'No pending friend request was found'],
  FRIEND_NOT_FOUND: [404, 'FRIEND_NOT_FOUND', 'That player is not in your friends list'],
  BLOCK_NOT_FOUND: [404, 'BLOCK_NOT_FOUND', 'That player is not blocked'],
  INVALID_USER: [400, 'INVALID_USER', 'Invalid player'],
  TITLE_REQUIRED: [400, 'TITLE_REQUIRED', 'A title is required'],
  INVALID_NOTIFICATION_TYPE: [400, 'INVALID_NOTIFICATION_TYPE', 'Invalid notification type']
};

function fromRpcError(error) {
  const raw = String(error?.message || error || '');
  const key = Object.keys(RPC_ERRORS).find((code) => raw.includes(code));
  if (key) {
    const [status, code, message] = RPC_ERRORS[key];
    return new ApiError(status, code, message);
  }
  return null;
}

module.exports = { ApiError, fromRpcError };
