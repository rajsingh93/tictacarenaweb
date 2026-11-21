'use strict';

const adminService = require('../services/admin.service');
const bannerService = require('../services/banner.service');
const operations = require('../services/operations.service');
const leaderboardService = require('../services/leaderboard.service');

async function stats(req, res) {
  res.json(await adminService.stats());
}

async function charts(req, res) {
  res.json(await adminService.charts());
}

async function traffic(req, res) {
  res.json(await adminService.traffic());
}

async function serverHealth(req, res) {
  res.json(await adminService.serverHealth());
}

async function me(req, res) {
  res.json(await adminService.me(req.user));
}

async function users(req, res) {
  res.json(await adminService.users(req.query));
}

async function userDetail(req, res) {
  res.json(await adminService.userDetail(req.params.id));
}

async function setRole(req, res) {
  res.json(await adminService.setRole(req.user, req.params.id, req.body.is_admin));
}

async function notifyUser(req, res) {
  res.json(await adminService.notifyUser(req.user, req.params.id, req.body.message));
}

async function giveCoins(req, res) {
  res.json(await adminService.giveCoinsById(req.user, req.params.id, req.body.amount));
}

async function giveCoinsByName(req, res) {
  res.json(await adminService.giveCoinsByUsername(req.user, req.body));
}

async function resetStats(req, res) {
  res.json(await adminService.resetStats(req.user, req.params.id));
}

async function ban(req, res) {
  const result = await adminService.setBan(req.user, req.params.id, req.body.ban);
  if (req.body.ban) {
    const io = req.app.get('io');
    if (io) io.in(`user:${req.params.id}`).disconnectSockets(true);
  }
  res.json(result);
}

async function avatars(req, res) {
  res.json(await adminService.avatars());
}

async function createAvatar(req, res) {
  res.status(201).json(await adminService.createAvatar(req.body, req.file));
}

async function deleteAvatar(req, res) {
  res.json(await adminService.deleteAvatar(req.params.id));
}

async function matches(req, res) {
  res.json(await adminService.matches(req.query));
}

async function dbInfo(req, res) {
  res.json(await adminService.dbInfo());
}

async function banners(req, res) {
  res.json(await bannerService.allBanners());
}

async function saveBanner(req, res) {
  res.status(req.body.id ? 200 : 201).json(await bannerService.save(req.body));
}

async function deleteBanner(req, res) {
  res.json(await bannerService.remove(req.params.id));
}

async function mail(req, res) {
  res.json(await adminService.sendMail(req.body));
}

async function maintenance(req, res) {
  res.json(await adminService.setMaintenance(req.body));
}

async function supportTickets(req, res) {
  res.json(await adminService.supportTickets(req.query));
}

async function updateSupportTicket(req, res) {
  res.json(await adminService.updateSupportTicket(req.params.id, req.body.status));
}

/* ------------------------------------------------------------
   Operations: leaderboard rewards, reports, activity, notifications
   ------------------------------------------------------------ */
async function leaderboard(req, res) {
  res.json(await leaderboardService.get(req.user, req.query.type));
}

async function rewardTop(req, res) {
  res.json(await operations.rewardTopPlayers(req.user, req.body));
}

async function reports(req, res) {
  res.json(await operations.reports(req.query));
}

async function activity(req, res) {
  res.json(await operations.activity(req.query));
}

async function notifications(req, res) {
  res.json(await operations.announcementHistory());
}

async function announce(req, res) {
  const result = await operations.announce(req.user, req.body);
  const io = req.app.get('io');
  if (io) {
    io.emit('server:announcement', { message: result.announcement.message, timestamp: Date.now() });
  }
  res.json(result);
}

async function deleteNotification(req, res) {
  res.json(await operations.deleteAnnouncement(req.user, req.params.id));
}

/* ------------------------------------------------------------
   Moderation and tournaments
   ------------------------------------------------------------ */
async function worldChat(req, res) {
  res.json(await operations.worldChat(req.query));
}

async function deleteWorldMessage(req, res) {
  res.json(await operations.deleteWorldMessage(req.user, req.params.id));
}

async function tournaments(req, res) {
  res.json(await operations.listTournaments());
}

async function saveTournament(req, res) {
  res.json(await operations.saveTournament(req.user, req.body));
}

async function deleteTournament(req, res) {
  res.json(await operations.deleteTournament(req.user, req.params.id));
}

module.exports = {
  stats,
  charts,
  traffic,
  serverHealth,
  me,
  users,
  userDetail,
  setRole,
  notifyUser,
  giveCoins,
  giveCoinsByName,
  resetStats,
  ban,
  avatars,
  createAvatar,
  deleteAvatar,
  matches,
  dbInfo,
  banners,
  saveBanner,
  deleteBanner,
  mail,
  maintenance,
  supportTickets,
  updateSupportTicket,
  leaderboard,
  rewardTop,
  reports,
  activity,
  notifications,
  announce,
  deleteNotification,
  worldChat,
  deleteWorldMessage,
  tournaments,
  saveTournament,
  deleteTournament
};
