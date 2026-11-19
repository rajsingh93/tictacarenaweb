'use strict';

const express = require('express');
const multer = require('multer');
const env = require('../config/env');
const asyncHandler = require('../utils/asyncHandler');
const admin = require('../controllers/admin.controller');
const { requireAuth, requireAdmin, requireOwner } = require('../middleware/auth');
const { validate, numericParam } = require('../middleware/validate');
const {
  adminMailSchema,
  giveCoinsSchema,
  adminGiveCoinsSchema,
  banSchema,
  maintenanceSchema,
  bannerSchema,
  adminSupportSchema,
  adminRoleSchema,
  adminNotifyUserSchema,
  adminRewardTopSchema,
  adminAnnounceSchema,
  tournamentSchema
} = require('../validation/schemas');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.maxUploadBytes, files: 1 } });
const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get('/me', asyncHandler(admin.me));
router.get('/stats', asyncHandler(admin.stats));
router.get('/charts', asyncHandler(admin.charts));
router.get('/traffic', asyncHandler(admin.traffic));
router.get('/server-health', asyncHandler(admin.serverHealth));
router.get('/reports', asyncHandler(admin.reports));
router.get('/activity', asyncHandler(admin.activity));
router.get('/leaderboard', asyncHandler(admin.leaderboard));

router.get('/users', asyncHandler(admin.users));
router.get('/users/:id', numericParam('id'), asyncHandler(admin.userDetail));
router.post(
  '/users/:id/role',
  requireOwner,
  numericParam('id'),
  validate(adminRoleSchema),
  asyncHandler(admin.setRole)
);
router.post(
  '/users/:id/notify',
  numericParam('id'),
  validate(adminNotifyUserSchema),
  asyncHandler(admin.notifyUser)
);
router.post(
  '/users/:id/give-coins',
  numericParam('id'),
  validate(adminGiveCoinsSchema),
  asyncHandler(admin.giveCoins)
);
router.post('/users/:id/reset-stats', numericParam('id'), asyncHandler(admin.resetStats));
router.post('/users/:id/ban', numericParam('id'), validate(banSchema), asyncHandler(admin.ban));

router.get('/avatars', asyncHandler(admin.avatars));
router.post('/avatars', upload.single('image'), asyncHandler(admin.createAvatar));
router.delete('/avatars/:id', numericParam('id'), asyncHandler(admin.deleteAvatar));

router.get('/matches', asyncHandler(admin.matches));
router.get('/db-info', asyncHandler(admin.dbInfo));

router.get('/banners', asyncHandler(admin.banners));
router.post('/banners', validate(bannerSchema), asyncHandler(admin.saveBanner));
router.delete('/banners/:id', numericParam('id'), asyncHandler(admin.deleteBanner));

router.post('/mail', validate(adminMailSchema), asyncHandler(admin.mail));
router.post('/give-coins', validate(giveCoinsSchema), asyncHandler(admin.giveCoinsByName));
router.post('/maintenance', validate(maintenanceSchema), asyncHandler(admin.maintenance));

router.get('/support-tickets', asyncHandler(admin.supportTickets));
router.put(
  '/support-tickets/:id',
  numericParam('id'),
  validate(adminSupportSchema),
  asyncHandler(admin.updateSupportTicket)
);

/* Notifications */
router.get('/notifications', asyncHandler(admin.notifications));
router.post('/announce', validate(adminAnnounceSchema), asyncHandler(admin.announce));
router.delete('/notifications/:id', asyncHandler(admin.deleteNotification));

/* Rewards */
router.post('/rewards/top', validate(adminRewardTopSchema), asyncHandler(admin.rewardTop));

/* Moderation */
router.get('/moderation/world-chat', asyncHandler(admin.worldChat));
router.delete('/moderation/world-chat/:id', numericParam('id'), asyncHandler(admin.deleteWorldMessage));

/* Tournaments */
router.get('/tournaments', asyncHandler(admin.tournaments));
router.post('/tournaments', validate(tournamentSchema), asyncHandler(admin.saveTournament));
router.delete('/tournaments/:id', numericParam('id'), asyncHandler(admin.deleteTournament));

module.exports = router;
