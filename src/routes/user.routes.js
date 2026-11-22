'use strict';

const express = require('express');
const multer = require('multer');
const env = require('../config/env');
const asyncHandler = require('../utils/asyncHandler');
const user = require('../controllers/user.controller');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { updateProfileSchema, usernameAvailabilitySchema } = require('../validation/schemas');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.maxUploadBytes, files: 1 } });
const router = express.Router();

router.use(requireAuth);

router.get('/me', asyncHandler(user.me));
router.get('/dashboard', asyncHandler(user.dashboard));
router.put('/me', validate(updateProfileSchema), asyncHandler(user.updateMe));
router.get(
  '/username-available',
  validate(usernameAvailabilitySchema, 'query'),
  asyncHandler(user.usernameAvailable)
);
router.post('/me/avatar', upload.single('image'), asyncHandler(user.uploadAvatar));
router.get('/me/transactions', asyncHandler(user.transactions));
router.get('/unread', asyncHandler(user.unread));
router.get('/search', asyncHandler(user.search));
router.get('/:id/achievements', asyncHandler(user.achievements));
router.get('/:id', asyncHandler(user.profile));

module.exports = router;
