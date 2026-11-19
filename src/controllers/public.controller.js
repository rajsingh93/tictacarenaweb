'use strict';

const supportService = require('../services/support.service');
const bannerService = require('../services/banner.service');
const statsService = require('../services/stats.service');

async function contact(req, res) {
  res.status(201).json(await supportService.create(req.user, req.body));
}

async function notify(req, res) {
  res.status(201).json(await supportService.notify(req.user, req.body));
}

async function config(req, res) {
  res.json(await bannerService.publicConfig());
}

async function banners(req, res) {
  res.json(await bannerService.activeBanners());
}

async function stats(req, res) {
  res.json(await statsService.publicStats());
}

module.exports = { contact, notify, config, banners, stats };
