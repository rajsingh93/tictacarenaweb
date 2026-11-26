'use strict';

const express = require('express');
const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const friendRoutes = require('./friend.routes');
const shopRoutes = require('./shop.routes');
const matchRoutes = require('./match.routes');
const notificationRoutes = require('./notification.routes');
const chatRoutes = require('./chat.routes');
const profileRoutes = require('./profile.routes');
const topupRoutes = require('./topup.routes');
const publicRoutes = require('./public.routes');
const adminAuthRoutes = require('./adminAuth.routes');
const adminPlatformRoutes = require('./adminPlatform.routes');
const tournamentRoutes = require('./tournament.routes');
const disputeRoutes = require('./dispute.routes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/friends', friendRoutes);
router.use('/shop', shopRoutes);
router.use('/matches', matchRoutes);
router.use('/notifications', notificationRoutes);
router.use('/chat', chatRoutes);
router.use('/topup', topupRoutes);
router.use('/tournaments', tournamentRoutes);
router.use('/disputes', disputeRoutes);
router.use('/admin/auth', adminAuthRoutes);
router.use('/admin/control', adminPlatformRoutes);
router.use('/', profileRoutes);
router.use('/', publicRoutes);

module.exports = router;
