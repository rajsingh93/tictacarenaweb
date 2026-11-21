'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { leaderboard, achievements, claimAchievement, settings, updateSettings } = require('../controllers/profile.controller');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { settingsSchema } = require('../validation/schemas');

const router = express.Router();

router.get('/leaderboard', requireAuth, asyncHandler(leaderboard));
router.get('/achievements', requireAuth, asyncHandler(achievements));
router.post('/achievements/:id/claim', requireAuth, asyncHandler(claimAchievement));
router.get('/settings', requireAuth, asyncHandler(settings));
router.put('/settings', requireAuth, validate(settingsSchema), asyncHandler(updateSettings));

module.exports = router;
