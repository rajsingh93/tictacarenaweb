'use strict';

const userService = require('../services/user.service');
const uploadService = require('../services/upload.service');
const { invalidateUserCache } = require('../middleware/auth');
const { invalidateEquippedCache, invalidateSettingsCache } = require('../services/user.service');
const { ApiError } = require('../utils/ApiError');

async function me(req, res) {
  res.json(await userService.me(req.user));
}

async function dashboard(req, res) {
  res.json(await userService.dashboard(req.user));
}

async function profile(req, res) {
  res.json(await userService.profile(req.user, req.params.id));
}

async function achievements(req, res) {
  res.json(await userService.publicAchievements(req.user, req.params.id));
}

async function updateMe(req, res) {
  invalidateUserCache(req.user.id);
  invalidateEquippedCache(req.user.id);
  invalidateSettingsCache(req.user.id);
  res.json(await userService.updateMe(req.user, req.body));
}

async function search(req, res) {
  res.json(await userService.search(req.user, req.query.q || ''));
}

async function uploadAvatar(req, res) {
  if (!req.file) throw ApiError.badRequest('IMAGE_REQUIRED', 'Choose an image to upload');
  invalidateUserCache(req.user.id);
  invalidateEquippedCache(req.user.id);
  const uploaded = await uploadService.uploadImage(req.file, { folder: `tictacarena/users/${req.user.id}` });
  res.status(201).json(await userService.setAvatar(req.user, uploaded.url));
}

async function unread(req, res) {
  res.json(await userService.unreadSummary(req.user.id));
}

async function transactions(req, res) {
  res.json(await userService.transactions(req.user.id, req.query.limit));
}

module.exports = {
  me,
  dashboard,
  profile,
  achievements,
  updateMe,
  search,
  uploadAvatar,
  unread,
  transactions
};
