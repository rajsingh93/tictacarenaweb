'use strict';

/**
 * Admin Control Center API.
 *
 * Every route below is protected by three server-side gates:
 *   1. a valid session cookie,
 *   2. an active administrator identity (admin_security),
 *   3. the exact granular permission for the action.
 * A hidden button in the browser is never the security boundary.
 */

const express = require('express');
const multer = require('multer');
const env = require('../config/env');
const asyncHandler = require('../utils/asyncHandler');
const controller = require('../controllers/adminPlatform.controller');
const adminSecurity = require('../services/adminSecurity.service');
const { requireAuth } = require('../middleware/auth');
const { validate, numericParam } = require('../middleware/validate');
const {
  adminRoleSchema,
  adminPolicySchema,
  bulkUserSchema,
  userUpdateSchema,
  banSchema,
  verificationSchema,
  voidMatchSchema,
  disputeUpdateSchema,
  tournamentSchema,
  bracketAdvanceSchema,
  tournamentPayoutSchema,
  tournamentCancelSchema,
  adjustCoinsSchema,
  leaderboardResetSchema,
  restrictionSchema,
  reportUpdateSchema,
  moderationSettingsSchema,
  campaignSchema,
  testNotificationSchema,
  templateSchema,
  pageSchema,
  seoSchema,
  redirectSchema,
  supportReplySchema,
  supportUpdateSchema,
  flagSchema,
  jobSchema,
  achievementSchema,
  retentionSchema,
  maintenanceSchema
} = require('../validation/adminSchemas');

const router = express.Router();
const can = adminSecurity.requirePermission;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.maxUploadBytes, files: 1 } });

router.use(requireAuth, adminSecurity.requireAdminAccess, adminSecurity.requireAdminSession);

/* Dashboard */
router.get('/overview', can('dashboard.view'), asyncHandler(controller.overview));
router.get('/analytics', can('analytics.view'), asyncHandler(controller.analytics));
router.get('/live', can('realtime.view'), asyncHandler(controller.live));
router.get('/search', can('search.use'), asyncHandler(controller.search));
router.get('/export', can('exports.run'), asyncHandler(controller.exportData));

/* Users */
router.get('/users', can('users.view'), asyncHandler(controller.users));
router.get('/users/counts', can('users.view'), asyncHandler(controller.userCounts));
router.post('/users/bulk', can('bulk.run'), validate(bulkUserSchema), asyncHandler(controller.bulkUsers));
router.get('/users/:id', numericParam('id'), can('users.view'), asyncHandler(controller.userDetail));
router.patch('/users/:id', numericParam('id'), can('users.manage'), validate(userUpdateSchema), asyncHandler(controller.updateUser));
router.post('/users/:id/ban', numericParam('id'), can('users.ban'), validate(banSchema), asyncHandler(controller.banUser));
router.post('/users/:id/verification', numericParam('id'), can('users.manage'), validate(verificationSchema), asyncHandler(controller.verifyUser));
router.post('/users/:id/role', numericParam('id'), can('users.roles'), validate(adminRoleSchema), asyncHandler(controller.userRole));
router.get('/users/:id/sessions', numericParam('id'), can('users.sessions'), asyncHandler(controller.userSessions));
router.post('/users/:id/sessions/revoke', numericParam('id'), can('users.sessions'), asyncHandler(controller.revokeUserSessions));

/* Matches and disputes */
router.get('/matches', can('matches.view'), asyncHandler(controller.matches));
router.get('/matches/suspicious', can('matches.view'), asyncHandler(controller.suspiciousMatches));
router.get('/matches/:id', numericParam('id'), can('matches.view'), asyncHandler(controller.matchDetail));
router.post('/matches/:id/void', numericParam('id'), can('matches.manage'), validate(voidMatchSchema), asyncHandler(controller.voidMatch));
router.post('/live/:gameId/cancel', can('matches.live'), asyncHandler(controller.cancelLive));
router.get('/disputes', can('matches.view'), asyncHandler(controller.disputes));
router.patch('/disputes/:id', numericParam('id'), can('matches.manage'), validate(disputeUpdateSchema), asyncHandler(controller.resolveDispute));

/* Tournaments */
router.get('/tournaments', can('tournaments.view'), asyncHandler(controller.tournaments));
router.post('/tournaments', can('tournaments.manage'), validate(tournamentSchema), asyncHandler(controller.saveTournament));
router.get('/tournaments/:id', numericParam('id'), can('tournaments.view'), asyncHandler(controller.tournamentDetail));
router.delete('/tournaments/:id', numericParam('id'), can('tournaments.manage'), asyncHandler(controller.deleteTournament));
router.post('/tournaments/:id/bracket', numericParam('id'), can('tournaments.manage'), asyncHandler(controller.generateBracket));
router.post('/tournaments/:id/bracket/advance', numericParam('id'), can('tournaments.manage'), validate(bracketAdvanceSchema), asyncHandler(controller.advanceBracket));
router.delete('/tournaments/:id/entries/:userId', numericParam('id'), numericParam('userId'), can('tournaments.manage'), asyncHandler(controller.removeEntrant));
router.post('/tournaments/:id/rewards', numericParam('id'), can('tournaments.manage'), validate(tournamentPayoutSchema), asyncHandler(controller.rewardTournament));
router.post('/tournaments/:id/cancel', numericParam('id'), can('tournaments.manage'), validate(tournamentCancelSchema), asyncHandler(controller.cancelTournament));

/* Coin economy and shop */
router.get('/economy', can('economy.view'), asyncHandler(controller.economySummary));
router.get('/economy/transactions', can('economy.view'), asyncHandler(controller.transactions));
router.get('/economy/suspicious', can('economy.view'), asyncHandler(controller.suspiciousTransactions));
router.post('/economy/adjust', can('economy.manage'), validate(adjustCoinsSchema), asyncHandler(controller.adjustCoins));
router.get('/shop', can('economy.view'), asyncHandler(controller.shopItems));
router.post('/shop', can('economy.manage'), upload.single('image'), asyncHandler(controller.createShopItem));
router.delete('/shop/:id', numericParam('id'), can('economy.manage'), asyncHandler(controller.deleteShopItem));

/* Leaderboard */
router.get('/leaderboard', can('leaderboard.view'), asyncHandler(controller.ladder));
router.get('/leaderboard/snapshots', can('leaderboard.view'), asyncHandler(controller.leaderboardSnapshots));
router.post('/leaderboard/snapshot', can('leaderboard.manage'), asyncHandler(controller.createLeaderboardSnapshot));
router.post('/leaderboard/reset', can('leaderboard.manage'), validate(leaderboardResetSchema), asyncHandler(controller.resetLeaderboard));

/* Community moderation */
router.get('/moderation/chat', can('moderation.view'), asyncHandler(controller.worldChat));
router.delete('/moderation/chat/:id', numericParam('id'), can('moderation.manage'), asyncHandler(controller.deleteWorldMessage));
router.get('/moderation/reports', can('moderation.view'), asyncHandler(controller.reports));
router.patch('/moderation/reports/:id', numericParam('id'), can('moderation.manage'), validate(reportUpdateSchema), asyncHandler(controller.updateReport));
router.get('/moderation/restrictions', can('moderation.view'), asyncHandler(controller.restrictions));
router.post('/moderation/restrictions', can('moderation.manage'), validate(restrictionSchema), asyncHandler(controller.createRestriction));
router.delete('/moderation/restrictions/:id', numericParam('id'), can('moderation.manage'), asyncHandler(controller.revokeRestriction));
router.get('/moderation/settings', can('moderation.view'), asyncHandler(controller.moderationSettings));
router.put('/moderation/settings', can('moderation.manage'), validate(moderationSettingsSchema), asyncHandler(controller.saveModerationSettings));

/* Notifications */
router.get('/notifications', can('notifications.view'), asyncHandler(controller.notificationOverview));
router.get('/notifications/campaigns', can('notifications.view'), asyncHandler(controller.campaigns));
router.get('/notifications/audience', can('notifications.view'), asyncHandler(controller.audience));
router.get('/notifications/history', can('notifications.view'), asyncHandler(controller.notificationHistory));
router.post('/notifications/campaigns', can('notifications.manage'), validate(campaignSchema), asyncHandler(controller.saveCampaign));
router.post('/notifications/campaigns/:id/send', numericParam('id'), can('notifications.manage'), asyncHandler(controller.sendCampaign));
router.post('/notifications/campaigns/:id/cancel', numericParam('id'), can('notifications.manage'), asyncHandler(controller.cancelCampaign));
router.delete('/notifications/campaigns/:id', numericParam('id'), can('notifications.manage'), asyncHandler(controller.deleteCampaign));
router.post('/notifications/test', can('notifications.manage'), validate(testNotificationSchema), asyncHandler(controller.testNotification));
router.get('/notifications/templates', can('notifications.view'), asyncHandler(controller.templates));
router.post('/notifications/templates', can('notifications.manage'), validate(templateSchema), asyncHandler(controller.saveTemplate));
router.delete('/notifications/templates/:id', numericParam('id'), can('notifications.manage'), asyncHandler(controller.deleteTemplate));

/* CMS, SEO and redirects */
router.get('/cms/pages', can('cms.view'), asyncHandler(controller.pages));
router.get('/cms/pages/:id', numericParam('id'), can('cms.view'), asyncHandler(controller.pageDetail));
router.post('/cms/pages', can('cms.manage'), validate(pageSchema), asyncHandler(controller.savePage));
router.delete('/cms/pages/:id', numericParam('id'), can('cms.manage'), asyncHandler(controller.deletePage));
router.get('/cms/seo', can('cms.view'), asyncHandler(controller.seoSettings));
router.put('/cms/seo', can('cms.manage'), validate(seoSchema), asyncHandler(controller.saveSeoSettings));
router.get('/cms/redirects', can('cms.view'), asyncHandler(controller.redirects));
router.post('/cms/redirects', can('cms.manage'), validate(redirectSchema), asyncHandler(controller.saveRedirect));
router.delete('/cms/redirects/:id', numericParam('id'), can('cms.manage'), asyncHandler(controller.deleteRedirect));
router.get('/cms/sitemap', can('cms.view'), asyncHandler(controller.sitemapStats));
router.get('/cms/sitemap/preview', can('cms.view'), asyncHandler(controller.sitemapPreview));
router.get('/cms/seo/audit', can('cms.view'), asyncHandler(controller.seoAudit));
router.get('/cms/robots', can('cms.view'), asyncHandler(controller.robotsPreview));

/* Support */
router.get('/support', can('support.view'), asyncHandler(controller.tickets));
router.get('/support/analytics', can('support.view'), asyncHandler(controller.supportAnalytics));
router.get('/support/:id', numericParam('id'), can('support.view'), asyncHandler(controller.ticketDetail));
router.post('/support/:id/reply', numericParam('id'), can('support.manage'), validate(supportReplySchema), asyncHandler(controller.replyTicket));
router.patch('/support/:id', numericParam('id'), can('support.manage'), validate(supportUpdateSchema), asyncHandler(controller.updateTicket));

/* Security, sessions and audit */
router.get('/security', can('security.view'), asyncHandler(controller.securityOverview));
router.get('/security/sessions', can('security.view'), asyncHandler(controller.adminSessions));
router.delete('/security/sessions/:id', can('security.view'), asyncHandler(controller.revokeAdminSession));
router.get('/security/login-events', can('security.view'), asyncHandler(controller.loginEvents));
router.post('/security/admins/:id/role', numericParam('id'), can('users.roles'), validate(adminRoleSchema), asyncHandler(controller.assignRole));
router.patch('/security/admins/:id', numericParam('id'), can('security.manage'), validate(adminPolicySchema), asyncHandler(controller.updateAdminPolicy));
router.get('/security/audit', can('audit.view'), asyncHandler(controller.auditTrail));
router.get('/security/audit/actions', can('audit.view'), asyncHandler(controller.auditActions));
router.post('/security/audit/verify', can('audit.view'), asyncHandler(controller.verifyAudit));

/* System operations */
router.get('/system', can('system.view'), asyncHandler(controller.health));
router.get('/system/metrics', can('system.view'), asyncHandler(controller.metricsSnapshot));
router.get('/system/errors', can('system.view'), asyncHandler(controller.errors));
router.patch('/system/errors/:id', numericParam('id'), can('system.manage'), asyncHandler(controller.resolveError));
router.get('/system/performance', can('system.view'), asyncHandler(controller.performance));
router.get('/system/flags', can('system.view'), asyncHandler(controller.flags));
router.post('/system/flags', can('system.manage'), validate(flagSchema), asyncHandler(controller.saveFlag));
router.delete('/system/flags/:id', numericParam('id'), can('system.manage'), asyncHandler(controller.deleteFlag));
router.get('/system/jobs', can('system.view'), asyncHandler(controller.jobs));
router.post('/system/jobs', can('system.manage'), validate(jobSchema), asyncHandler(controller.saveJob));
router.delete('/system/jobs/:id', numericParam('id'), can('system.manage'), asyncHandler(controller.deleteJob));
router.post('/system/jobs/:id/run', numericParam('id'), can('system.manage'), asyncHandler(controller.runJob));
router.get('/system/retention', can('system.view'), asyncHandler(controller.retention));
router.put('/system/retention', can('system.manage'), validate(retentionSchema), asyncHandler(controller.saveRetention));
router.get('/system/snapshots', can('system.view'), asyncHandler(controller.snapshots));
router.post('/system/snapshots', can('system.manage'), asyncHandler(controller.createSnapshot));
router.get('/system/tables', can('system.view'), asyncHandler(controller.tables));

/* Game configuration */
router.get('/settings', can('settings.view'), asyncHandler(controller.gameSettings));
router.put('/settings/game', can('settings.manage'), asyncHandler(controller.saveGameSettings));
router.post('/settings/version', can('settings.manage'), asyncHandler(controller.saveVersion));
router.put('/settings/maintenance', can('settings.manage'), validate(maintenanceSchema), asyncHandler(controller.saveMaintenance));
router.get('/settings/achievements', can('settings.view'), asyncHandler(controller.achievements));
router.post('/settings/achievements', can('settings.manage'), validate(achievementSchema), asyncHandler(controller.saveAchievement));
router.delete('/settings/achievements/:id', numericParam('id'), can('settings.manage'), asyncHandler(controller.deleteAchievement));

module.exports = router;
