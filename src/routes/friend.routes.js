'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const friends = require('../controllers/friend.controller');
const { requireAuth } = require('../middleware/auth');
const { validate, numericParam } = require('../middleware/validate');
const { friendRequestSchema } = require('../validation/schemas');

const router = express.Router();
router.use(requireAuth);

router.get('/', asyncHandler(friends.list));
router.get('/requests', asyncHandler(friends.requests));
router.get('/blocked', asyncHandler(friends.blocked));
router.get('/status/:id', numericParam('id'), asyncHandler(friends.status));
router.post('/request-by-username', validate(friendRequestSchema), asyncHandler(friends.requestByUsername));
router.post('/request/:id', numericParam('id'), asyncHandler(friends.request));
router.post('/accept/:id', numericParam('id'), asyncHandler(friends.accept));
router.delete('/request/:id', numericParam('id'), asyncHandler(friends.decline));
router.post('/block/:id', numericParam('id'), asyncHandler(friends.block));
router.delete('/block/:id', numericParam('id'), asyncHandler(friends.unblock));
router.delete('/:id', numericParam('id'), asyncHandler(friends.remove));

module.exports = router;
