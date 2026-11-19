'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const matches = require('../controllers/match.controller');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { trainingSchema } = require('../validation/schemas');

const router = express.Router();
router.use(requireAuth);

router.get('/history', asyncHandler(matches.history));
router.get('/stats', asyncHandler(matches.stats));
router.post('/training', validate(trainingSchema), asyncHandler(matches.training));
router.get('/:id', asyncHandler(matches.detail));

module.exports = router;
