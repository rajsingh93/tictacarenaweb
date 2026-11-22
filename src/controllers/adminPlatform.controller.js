'use strict';

/**
 * Thin HTTP controllers for the Admin Control Center.
 * Permission decisions happen in the route middleware; these handlers only
 * translate validated input into service calls and shape the response.
 */

const platform = require('../services/adminPlatform.service');
const economy = require('../services/adminEconomy.service');
const content = require('../services/adminContent.service');
const system = require('../services/adminSystem.service');
const adminSecurity = require('../services/adminSecurity.service');
const metrics = require('../utils/metrics');
const { ApiError } = require('../utils/ApiError');

/* Dashboard */

async function overview(req, res) {
  res.json(await platform.dashboard(req.query));
}

async function analytics(req, res) {
  res.json(await platform.analytics(req.query));
}

async function live(req, res) {
  res.json(await platform.liveState());
}

async function search(req, res) {
  res.json(await platform.globalSearch(req.adminAccess, req.query));
}

async function exportData(req, res) {
  const result = await platform.exportData(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.setHeader('X-Export-Rows', String(result.rows));
  res.send(result.content);
}

/* Users */

async function users(req, res) {
  res.json(await platform.listUsers(req.query));
}

async function userCounts(req, res) {
  res.json({ counts: await platform.userCounts() });
}

async function userDetail(req, res) {
  res.json(await platform.userDetail(req.params.id));
}

async function updateUser(req, res) {
  res.json(await platform.updateUser(req.user, req, req.params.id, req.body));
}

async function banUser(req, res) {
  const result = await platform.setBan(req.user, req, req.params.id, req.body);
  if (req.body.ban) {
    try {
      req.app.get('io')?.in(`user:${req.params.id}`).disconnectSockets(true);
    } catch (_) {
      /* the socket layer may be disabled */
    }
  }
  res.json(result);
}

async function verifyUser(req, res) {
  res.json(await platform.setVerification(req.user, req, req.params.id, req.body));
}

async function bulkUsers(req, res) {
  const required =
    req.body.action === 'ban' || req.body.action === 'unban'
      ? 'users.ban'
      : req.body.action === 'notify'
        ? 'users.notify'
        : 'users.manage';
  if (!req.adminAccess.permissions.includes(required)) {
    throw ApiError.forbidden('ADMIN_PERMISSION_REQUIRED', 'You do not have permission for this bulk action', {
      permission: required
    });
  }
  res.json(await platform.bulkUsers(req.user, req, req.body));
}

async function userRole(req, res) {
  res.json(await platform.setUserRole(req.user, req, req.params.id, req.body));
}

async function userSessions(req, res) {
  res.json({ sessions: await adminSecurity.listSessions(req.params.id, { limit: 50 }) });
}

async function revokeUserSessions(req, res) {
  const userId = req.params.id;
  const now = new Date().toISOString();
  const { admin } = require('../utils/db');
  const row = await admin
    .from('users')
    .update({ session_invalid_before: now, is_online: false })
    .eq('id', userId)
    .select('id, username')
    .maybeSingle();
  if (row.error || !row.data) throw ApiError.notFound('USER_NOT_FOUND', 'Player not found');
  await adminSecurity.revokeAllSessions(req.adminAccess, userId, req, { includeCurrent: true }).catch(() => null);
  await require('../services/audit.service').record(req.user, 'user.sessions.revoke', {
    targetType: 'user',
    targetId: userId,
    details: { username: row.data.username },
    req
  });
  try {
    req.app.get('io')?.in(`user:${userId}`).disconnectSockets(true);
  } catch (_) {
    /* socket layer optional */
  }
  res.json({ message: 'All sessions revoked' });
}

/* Matches */

async function matches(req, res) {
  res.json(await platform.listMatches(req.query));
}

async function matchDetail(req, res) {
  res.json(await platform.matchDetail(req.params.id));
}

async function voidMatch(req, res) {
  res.json(await platform.voidMatch(req.user, req, req.params.id, req.body));
}

async function cancelLive(req, res) {
  res.json(await platform.cancelLive(req.user, req, req.params.gameId));
}

async function disputes(req, res) {
  res.json(await platform.listDisputes(req.query));
}

async function resolveDispute(req, res) {
  res.json(await platform.resolveDispute(req.user, req, req.params.id, req.body));
}

async function suspiciousMatches(req, res) {
  res.json(await platform.suspiciousMatches(req.query));
}

/* Tournaments */

async function tournaments(req, res) {
  res.json(await platform.listTournaments(req.query));
}

async function tournamentDetail(req, res) {
  res.json(await platform.tournamentDetail(req.params.id));
}

async function saveTournament(req, res) {
  res.json(await platform.saveTournament(req.user, req, req.body));
}

async function deleteTournament(req, res) {
  res.json(await platform.deleteTournament(req.user, req, req.params.id));
}

async function generateBracket(req, res) {
  res.json(await platform.generateBracket(req.user, req, req.params.id));
}

async function advanceBracket(req, res) {
  res.json(await platform.advanceBracket(req.user, req, req.params.id, req.body));
}

async function removeEntrant(req, res) {
  res.json(await platform.removeEntrant(req.user, req, req.params.id, req.params.userId));
}

async function rewardTournament(req, res) {
  res.json(await platform.rewardTournament(req.user, req, req.params.id, req.body));
}

async function cancelTournament(req, res) {
  res.json(await platform.cancelTournament(req.user, req, req.params.id, req.body));
}

/* Economy */

async function economySummary(req, res) {
  res.json(await economy.economySummary(req.query));
}

async function transactions(req, res) {
  res.json(await economy.listTransactions(req.query));
}

async function adjustCoins(req, res) {
  res.json(await economy.adjustCoins(req.user, req, req.body));
}

async function suspiciousTransactions(req, res) {
  res.json(await economy.suspiciousTransactions(req.query));
}

async function shopItems(req, res) {
  res.json(await economy.shopItems());
}

async function createShopItem(req, res) {
  res.status(201).json(await economy.createShopItem(req.user, req, req.body, req.file));
}

async function deleteShopItem(req, res) {
  res.json(await economy.deleteShopItem(req.user, req, req.params.id));
}

/* Leaderboard */

async function ladder(req, res) {
  res.json(await economy.ladder(req.query));
}

async function leaderboardSnapshots(req, res) {
  res.json(await economy.listSnapshots(req.query));
}

async function createLeaderboardSnapshot(req, res) {
  res.json(await economy.createSnapshot(req.user, req, req.body));
}

async function resetLeaderboard(req, res) {
  res.json(await economy.resetLeaderboard(req.user, req, req.body));
}

/* Moderation */

async function worldChat(req, res) {
  res.json(await economy.worldChat(req.query));
}

async function deleteWorldMessage(req, res) {
  res.json(await economy.deleteWorldMessage(req.user, req, req.params.id));
}

async function reports(req, res) {
  res.json(await economy.listReports(req.query));
}

async function updateReport(req, res) {
  res.json(await economy.updateReport(req.user, req, req.params.id, req.body));
}

async function restrictions(req, res) {
  res.json(await economy.listRestrictions(req.query));
}

async function createRestriction(req, res) {
  res.json(await economy.createRestriction(req.user, req, req.body));
}

async function revokeRestriction(req, res) {
  res.json(await economy.revokeRestriction(req.user, req, req.params.id));
}

async function moderationSettings(req, res) {
  res.json(await economy.moderationSettings());
}

async function saveModerationSettings(req, res) {
  res.json(await economy.saveModerationSettings(req.user, req, req.body));
}

/* Notifications */

async function notificationOverview(req, res) {
  res.json(await content.notificationOverview());
}

async function campaigns(req, res) {
  res.json(await content.listCampaigns(req.query));
}

async function audience(req, res) {
  const ids = String(req.query.ids || '')
    .split(',')
    .map(Number)
    .filter(Boolean);
  res.json({
    audience: req.query.audience || 'all',
    count: await content.audienceCount(req.query.audience, ids)
  });
}

async function saveCampaign(req, res) {
  res.json(await content.saveCampaign(req.user, req, req.body));
}

async function sendCampaign(req, res) {
  res.json(await content.sendCampaign(req.user, req, req.params.id));
}

async function cancelCampaign(req, res) {
  res.json(await content.cancelCampaign(req.user, req, req.params.id));
}

async function deleteCampaign(req, res) {
  res.json(await content.deleteCampaign(req.user, req, req.params.id));
}

async function testNotification(req, res) {
  res.json(await content.testNotification(req.user, req, req.body));
}

async function notificationHistory(req, res) {
  res.json(await content.listNotificationHistory(req.query));
}

async function templates(req, res) {
  res.json(await content.listTemplates());
}

async function saveTemplate(req, res) {
  res.json(await content.saveTemplate(req.user, req, req.body));
}

async function deleteTemplate(req, res) {
  res.json(await content.deleteTemplate(req.user, req, req.params.id));
}

/* CMS */

async function pages(req, res) {
  res.json(await content.listPages(req.query));
}

async function pageDetail(req, res) {
  res.json(await content.pageDetail(req.params.id));
}

async function savePage(req, res) {
  res.json(await content.savePage(req.user, req, req.body));
}

async function deletePage(req, res) {
  res.json(await content.deletePage(req.user, req, req.params.id));
}

async function seoSettings(req, res) {
  res.json(await content.getSeo());
}

async function saveSeoSettings(req, res) {
  res.json(await content.saveSeo(req.user, req, req.body));
}

async function redirects(req, res) {
  res.json(await content.listRedirects(req.query));
}

async function saveRedirect(req, res) {
  res.json(await content.saveRedirect(req.user, req, req.body));
}

async function deleteRedirect(req, res) {
  res.json(await content.deleteRedirect(req.user, req, req.params.id));
}

async function sitemapStats(req, res) {
  res.json(await content.sitemapStats());
}

async function seoAudit(req, res) {
  res.json(await content.seoAudit());
}

async function sitemapPreview(req, res) {
  res.type('application/xml').send(await content.sitemap());
}

async function robotsPreview(req, res) {
  res.type('text/plain').send(await content.robots());
}

/* Support */

async function tickets(req, res) {
  res.json(await content.listTickets({ ...req.query, adminId: req.user.id }));
}

async function ticketDetail(req, res) {
  res.json(await content.ticketDetail(req.params.id));
}

async function replyTicket(req, res) {
  res.json(await content.replyTicket(req.user, req, req.params.id, req.body));
}

async function updateTicket(req, res) {
  res.json(await content.updateTicket(req.user, req, req.params.id, req.body));
}

async function supportAnalytics(req, res) {
  res.json(await content.supportAnalytics(req.query));
}

/* Security */

async function securityOverview(req, res) {
  res.json(await system.securityOverview(req));
}

async function assignRole(req, res) {
  res.json(await system.assignRole(req.user, req, req.params.id, req.body));
}

async function updateAdminPolicy(req, res) {
  res.json(await system.updateAdminSecurity(req.user, req, req.params.id, req.body));
}

async function adminSessions(req, res) {
  res.json(await system.listAdminSessions(req.query));
}

async function revokeAdminSession(req, res) {
  res.json(await system.revokeAdminSession(req.user, req, req.params.id));
}

async function loginEvents(req, res) {
  res.json(await system.listLoginEvents(req.query));
}

async function auditTrail(req, res) {
  res.json(await system.listAudit(req.query));
}

async function auditActions(req, res) {
  res.json(await system.auditActions());
}

async function verifyAudit(req, res) {
  res.json(await system.verifyAudit());
}

/* System */

async function health(req, res) {
  res.json(await system.systemHealth(req));
}

async function metricsSnapshot(req, res) {
  res.json(metrics.snapshot());
}

async function errors(req, res) {
  res.json(await system.listErrors(req.query));
}

async function resolveError(req, res) {
  res.json(await system.resolveError(req.user, req, req.params.id, req.body));
}

async function performance(req, res) {
  res.json(await system.performanceHistory(req.query));
}

async function flags(req, res) {
  res.json(await system.listFlags());
}

async function saveFlag(req, res) {
  res.json(await system.saveFlag(req.user, req, req.body));
}

async function deleteFlag(req, res) {
  res.json(await system.deleteFlag(req.user, req, req.params.id));
}

async function jobs(req, res) {
  res.json(await system.listJobs(req.query));
}

async function saveJob(req, res) {
  res.json(await system.saveJob(req.user, req, req.body));
}

async function deleteJob(req, res) {
  res.json(await system.deleteJob(req.user, req, req.params.id));
}

async function runJob(req, res) {
  res.json(await system.runJob(req.user, req, req.params.id));
}

async function retention(req, res) {
  res.json(await system.retentionOverview());
}

async function saveRetention(req, res) {
  res.json(await system.saveRetention(req.user, req, req.body));
}

async function snapshots(req, res) {
  res.json(await system.listSnapshots(req.query));
}

async function createSnapshot(req, res) {
  res.json(await system.systemSnapshot(req.user, req));
}

async function tables(req, res) {
  res.json(await system.tableStats());
}

/* Game configuration */

async function gameSettings(req, res) {
  res.json(await system.gameSettings());
}

async function saveGameSettings(req, res) {
  res.json(await system.saveGameSettings(req.user, req, req.body));
}

async function saveVersion(req, res) {
  res.json(await system.saveVersion(req.user, req, req.body));
}

async function saveMaintenance(req, res) {
  res.json(await system.saveMaintenance(req.user, req, req.body));
}

async function achievements(req, res) {
  res.json(await system.listAchievements());
}

async function saveAchievement(req, res) {
  res.json(await system.saveAchievement(req.user, req, req.body));
}

async function deleteAchievement(req, res) {
  res.json(await system.deleteAchievement(req.user, req, req.params.id));
}

module.exports = {
  overview,
  analytics,
  live,
  search,
  exportData,
  users,
  userCounts,
  userDetail,
  updateUser,
  banUser,
  verifyUser,
  bulkUsers,
  userRole,
  userSessions,
  revokeUserSessions,
  matches,
  matchDetail,
  voidMatch,
  cancelLive,
  disputes,
  resolveDispute,
  suspiciousMatches,
  tournaments,
  tournamentDetail,
  saveTournament,
  deleteTournament,
  generateBracket,
  advanceBracket,
  removeEntrant,
  rewardTournament,
  cancelTournament,
  economySummary,
  transactions,
  adjustCoins,
  suspiciousTransactions,
  shopItems,
  createShopItem,
  deleteShopItem,
  ladder,
  leaderboardSnapshots,
  createLeaderboardSnapshot,
  resetLeaderboard,
  worldChat,
  deleteWorldMessage,
  reports,
  updateReport,
  restrictions,
  createRestriction,
  revokeRestriction,
  moderationSettings,
  saveModerationSettings,
  notificationOverview,
  campaigns,
  audience,
  saveCampaign,
  sendCampaign,
  cancelCampaign,
  deleteCampaign,
  testNotification,
  notificationHistory,
  templates,
  saveTemplate,
  deleteTemplate,
  pages,
  pageDetail,
  savePage,
  deletePage,
  seoSettings,
  saveSeoSettings,
  redirects,
  saveRedirect,
  deleteRedirect,
  sitemapStats,
  seoAudit,
  sitemapPreview,
  robotsPreview,
  tickets,
  ticketDetail,
  replyTicket,
  updateTicket,
  supportAnalytics,
  securityOverview,
  assignRole,
  updateAdminPolicy,
  adminSessions,
  revokeAdminSession,
  loginEvents,
  auditTrail,
  auditActions,
  verifyAudit,
  health,
  metricsSnapshot,
  errors,
  resolveError,
  performance,
  flags,
  saveFlag,
  deleteFlag,
  jobs,
  saveJob,
  deleteJob,
  runJob,
  retention,
  saveRetention,
  snapshots,
  createSnapshot,
  tables,
  gameSettings,
  saveGameSettings,
  saveVersion,
  saveMaintenance,
  achievements,
  saveAchievement,
  deleteAchievement
};
