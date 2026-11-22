'use strict';

const rateLimit = require('express-rate-limit');
const env = require('../config/env');

function jsonLimiter(limit, windowMs) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.nodeEnv === 'test',
    handler: (req, res) => {
      res.status(429).json({
        error: 'Too many requests. Please wait a moment and try again.',
        code: 'RATE_LIMITED'
      });
    }
  });
}

const authLimiter = jsonLimiter(40, 15 * 60 * 1000);
const adminAuthLimiter = jsonLimiter(20, 15 * 60 * 1000);
const writeLimiter = jsonLimiter(240, 60 * 1000);
const apiLimiter = jsonLimiter(900, 60 * 1000);

module.exports = { authLimiter, adminAuthLimiter, writeLimiter, apiLimiter };
