'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { ApiError } = require('./ApiError');

function sign(payload, expiresIn) {
  return jwt.sign(payload, env.jwtSecret, { expiresIn });
}

function verify(token) {
  try {
    return jwt.verify(token, env.jwtSecret);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new ApiError(401, 'TOKEN_EXPIRED', 'Your session has expired');
    }
    throw new ApiError(401, 'INVALID_TOKEN', 'Invalid session');
  }
}

function signSession(user) {
  return sign(
    {
      sub: String(user.id),
      auth: user.auth_user_id,
      username: user.username,
      admin: Boolean(user.is_admin),
      purpose: 'session'
    },
    `${env.sessionDays}d`
  );
}

function signSignupToken({ authUserId, email, username }) {
  return sign({ authUserId, email, username, purpose: 'signup' }, '24h');
}

function verifySignupToken(token) {
  const payload = verify(token);
  if (payload.purpose !== 'signup') throw new ApiError(401, 'INVALID_TOKEN', 'Invalid verification token');
  return payload;
}

module.exports = { sign, verify, signSession, signSignupToken, verifySignupToken };
