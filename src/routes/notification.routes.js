'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const notifications = require('../controllers/notification.controller');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', asyncHandler(notifications.list));
router.get('/unread', asyncHandler(notifications.unread));
router.put('/read-all', asyncHandler(notifications.readAll));
router.put('/:id/read', asyncHandler(notifications.read));
router.post('/:id/claim', asyncHandler(notifications.claim));
router.delete('/:id', asyncHandler(notifications.remove));

module.exports = router;
