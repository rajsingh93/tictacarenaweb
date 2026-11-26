'use strict';

const supportService = require('../services/support.service');
const bannerService = require('../services/banner.service');
const statsService = require('../services/stats.service');
const adminContent = require('../services/adminContent.service');
const reportService = require('../services/report.service');
const env = require('../config/env');
const metrics = require('../utils/metrics');

async function contact(req, res) {
  res.status(201).json(await supportService.create(req.user, req.body));
}

async function notify(req, res) {
  res.status(201).json(await supportService.notify(req.user, req.body));
}

async function myTickets(req, res) {
  res.json(await supportService.listMine(req.user, req.query));
}

async function myTicket(req, res) {
  res.json(await supportService.detailMine(req.user, req.params.id));
}

async function replyMyTicket(req, res) {
  res.status(201).json(await supportService.replyMine(req.user, req.params.id, req.body));
}

async function config(req, res) {
  res.set('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
  res.set('Vary', 'Accept-Encoding');
  const [site, publicConfig] = await Promise.all([adminContent.publicSite(), bannerService.publicConfig()]);
  res.json({
    ...publicConfig,
    flags: site.flags,
    branding: site.branding,
    version: site.version,
    topup: { live: Boolean(env.topupSandbox) }
  });
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

async function report(req, res) {
  res.status(201).json(await reportService.create(req.user, req.body));
}

async function cmsSite(req, res) {
  res.set('Cache-Control', 'public, max-age=60, s-maxage=120, stale-while-revalidate=300');
  res.json(await adminContent.publicSite());
}

async function cmsPage(req, res) {
  res.set('Cache-Control', 'public, max-age=60, s-maxage=120, stale-while-revalidate=300');
  res.json(await adminContent.publicPage(req.params.slug));
}

async function cmsRedirects(req, res) {
  res.set('Cache-Control', 'public, max-age=120, s-maxage=300, stale-while-revalidate=600');
  res.json(await adminContent.publicRedirects());
}

async function sitemap(req, res) {
  res.set('Cache-Control', 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600');
  res.type('application/xml').send(await adminContent.sitemap());
}

async function robots(req, res) {
  res.set('Cache-Control', 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600');
  res.type('text/plain').send(await adminContent.robots());
}

module.exports = {
  contact,
  notify,
  myTickets,
  myTicket,
  replyMyTicket,
  config,
  banners,
  stats,
  clientMetrics,
  report,
  cmsSite,
  cmsPage,
  cmsRedirects,
  sitemap,
  robots
};
