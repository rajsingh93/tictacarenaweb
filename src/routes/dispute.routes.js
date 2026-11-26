'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const controller = require('../controllers/dispute.controller');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const { disputeSchema } = require('../validation/schemas');

const router = express.Router();

router.use(requireAuth);
router.get('/', asyncHandler(controller.list));
router.post('/match/:matchId', writeLimiter, validate(disputeSchema), asyncHandler(controller.create));

module.exports = router;
