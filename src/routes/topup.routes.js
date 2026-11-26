'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const topup = require('../controllers/topup.controller');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { topupOrderSchema } = require('../validation/schemas');

const router = express.Router();

// Payment-provider webhook. Authenticated with a shared secret, not a session.
router.post('/webhook', asyncHandler(topup.webhook));

router.use(requireAuth);
router.get('/packages', asyncHandler(topup.packages));
router.get('/orders', asyncHandler(topup.orders));
router.post('/orders', validate(topupOrderSchema), asyncHandler(topup.createOrder));

module.exports = router;
