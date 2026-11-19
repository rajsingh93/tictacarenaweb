'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const chat = require('../controllers/chat.controller');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/world', asyncHandler(chat.worldHistory));
router.get('/', asyncHandler(chat.list));
router.get('/:friendId', asyncHandler(chat.conversation));
router.put('/:friendId/read', asyncHandler(chat.markRead));

module.exports = router;
