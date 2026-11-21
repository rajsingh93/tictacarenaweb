'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const publicController = require('../controllers/public.controller');
const { optionalAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { authLimiter } = require('../middleware/rateLimit');
const { supportSchema, notifySchema } = require('../validation/schemas');

const router = express.Router();

router.get('/config', asyncHandler(publicController.config));
router.get('/banners', asyncHandler(publicController.banners));
router.get('/stats', asyncHandler(publicController.stats));
router.post('/support', authLimiter, optionalAuth, validate(supportSchema), asyncHandler(publicController.contact));
router.post('/support/notify', authLimiter, optionalAuth, validate(notifySchema), asyncHandler(publicController.notify));
router.post('/metrics/client', authLimiter, optionalAuth, asyncHandler(publicController.clientMetrics));

module.exports = router;
