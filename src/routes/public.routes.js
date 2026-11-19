'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const publicController = require('../controllers/public.controller');
const { optionalAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { supportSchema, notifySchema } = require('../validation/schemas');

const router = express.Router();

router.get('/config', asyncHandler(publicController.config));
router.get('/banners', asyncHandler(publicController.banners));
router.get('/stats', asyncHandler(publicController.stats));
router.post('/support', optionalAuth, validate(supportSchema), asyncHandler(publicController.contact));
router.post('/support/notify', optionalAuth, validate(notifySchema), asyncHandler(publicController.notify));

module.exports = router;
