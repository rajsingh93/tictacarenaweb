'use strict';

const express = require('express');
const multer = require('multer');
const env = require('../config/env');
const asyncHandler = require('../utils/asyncHandler');
const user = require('../controllers/user.controller');
const { optionalAuth, requireAuth } = require('../middleware/auth');
const { validate, numericParam } = require('../middleware/validate');
const { updateProfileSchema, usernameAvailabilitySchema } = require('../validation/schemas');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.maxUploadBytes, files: 1 } });
const router = express.Router();

/* Private authenticated user routes */
router.get('/me', requireAuth, asyncHandler(user.me));
router.put('/me', requireAuth, validate(updateProfileSchema), asyncHandler(user.updateMe));
router.get('/dashboard', requireAuth, asyncHandler(user.dashboard));
router.get(
  '/username-available',
  requireAuth,
  validate(usernameAvailabilitySchema, 'query'),
  asyncHandler(user.usernameAvailable)
);
router.post('/me/avatar', requireAuth, upload.single('image'), asyncHandler(user.uploadAvatar));
router.get('/me/transactions', requireAuth, asyncHandler(user.transactions));
router.get('/unread', requireAuth, asyncHandler(user.unread));
router.get('/search', requireAuth, asyncHandler(user.search));

/* Public player profiles (support unauthenticated visitors & search engines) */
router.get('/by-username/:username', optionalAuth, asyncHandler(user.profileByUsername));
router.get('/:id/achievements', numericParam('id'), optionalAuth, asyncHandler(user.achievements));
router.get('/:id', numericParam('id'), optionalAuth, asyncHandler(user.profile));

module.exports = router;
