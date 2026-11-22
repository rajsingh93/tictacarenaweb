'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const tournaments = require('../controllers/tournament.controller');
const { requireAuth } = require('../middleware/auth');
const { numericParam } = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth);

router.get('/', asyncHandler(tournaments.list));
router.post('/:id/join', numericParam('id'), asyncHandler(tournaments.join));
router.delete('/:id/join', numericParam('id'), asyncHandler(tournaments.leave));

module.exports = router;
