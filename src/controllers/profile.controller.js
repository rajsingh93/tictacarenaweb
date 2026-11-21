'use strict';

const leaderboardService = require('../services/leaderboard.service');
const achievementService = require('../services/achievement.service');
const settingsService = require('../services/settings.service');

async function leaderboard(req, res) {
  res.json(await leaderboardService.get(req.user, req.query.type));
}

async function achievements(req, res) {
  res.json(await achievementService.list(req.user));
}

async function claimAchievement(req, res) {
  res.json(await achievementService.claim(req.user, req.params.id));
}

async function settings(req, res) {
  res.json(await settingsService.get(req.user));
}

async function updateSettings(req, res) {
  res.json(await settingsService.update(req.user, req.body));
}

module.exports = { leaderboard, achievements, claimAchievement, settings, updateSettings };
