'use strict';

const supportService = require('../services/support.service');
const bannerService = require('../services/banner.service');
const statsService = require('../services/stats.service');
const metrics = require('../utils/metrics');

async function contact(req, res) {
  res.status(201).json(await supportService.create(req.user, req.body));
}

async function notify(req, res) {
  res.status(201).json(await supportService.notify(req.user, req.body));
}

async function config(req, res) {
  res.set('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
  res.set('Vary', 'Accept-Encoding');
  res.json(await bannerService.publicConfig());
}

async function banners(req, res) {
  res.set('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
  res.set('Vary', 'Accept-Encoding');
  res.json(await bannerService.activeBanners());
}

async function stats(req, res) {
  res.set('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
  res.set('Vary', 'Accept-Encoding');
  res.json(await statsService.publicStats());
}

async function clientMetrics(req, res) {
  metrics.recordClientReport(req.body);
  res.status(204).end();
}

module.exports = { contact, notify, config, banners, stats, clientMetrics };
