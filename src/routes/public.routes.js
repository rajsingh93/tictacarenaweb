'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const publicController = require('../controllers/public.controller');
const { optionalAuth, requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { authLimiter } = require('../middleware/rateLimit');
const { supportSchema, supportTicketReplySchema, notifySchema, reportSchema } = require('../validation/schemas');

const router = express.Router();

router.get('/config', asyncHandler(publicController.config));
router.get('/banners', asyncHandler(publicController.banners));
router.get('/stats', asyncHandler(publicController.stats));
router.post('/support', authLimiter, optionalAuth, validate(supportSchema), asyncHandler(publicController.contact));
router.post('/support/notify', authLimiter, optionalAuth, validate(notifySchema), asyncHandler(publicController.notify));
router.get('/support/tickets', requireAuth, asyncHandler(publicController.myTickets));
router.get('/support/tickets/:id', requireAuth, asyncHandler(publicController.myTicket));
router.post('/support/tickets/:id/reply', authLimiter, requireAuth, validate(supportTicketReplySchema), asyncHandler(publicController.replyMyTicket));
router.post('/metrics/client', authLimiter, optionalAuth, asyncHandler(publicController.clientMetrics));

/* Public content rendered from the CMS */
router.get('/cms/site', asyncHandler(publicController.cmsSite));
router.get('/cms/page/:slug', asyncHandler(publicController.cmsPage));
router.get('/cms/redirects', asyncHandler(publicController.cmsRedirects));
router.get('/sitemap.xml', asyncHandler(publicController.sitemap));
router.get('/robots.txt', asyncHandler(publicController.robots));

/* Community reports from signed-in players */
router.post('/reports', authLimiter, requireAuth, validate(reportSchema), asyncHandler(publicController.report));

module.exports = router;
