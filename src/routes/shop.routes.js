'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const shop = require('../controllers/shop.controller');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/avatars', asyncHandler(shop.items));
router.get('/owned', asyncHandler(shop.owned));
router.post('/buy/:id', asyncHandler(shop.buy));
router.post('/equip/:id', asyncHandler(shop.equip));

module.exports = router;
