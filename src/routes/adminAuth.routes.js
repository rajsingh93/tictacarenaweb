'use strict';

/**
 * Administrator sign-in and session endpoints.
 * These are mounted before the legacy /admin router so the granular access
 * checks below (and not the legacy is_admin flag alone) govern the console.
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const adminAuth = require('../controllers/adminAuth.controller');
const adminSecurity = require('../services/adminSecurity.service');
const { requireAuth } = require('../middleware/auth');
const { adminAuthLimiter } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');
const {
  adminLoginSchema,
  admin2faSchema,
  admin2faCodeSchema
} = require('../validation/adminSchemas');

const router = express.Router();
const adminGuard = [requireAuth, adminSecurity.requireAdminAccess, adminSecurity.requireAdminSession];

router.post('/login', adminAuthLimiter, validate(adminLoginSchema), asyncHandler(adminAuth.login));
router.post('/2fa', adminAuthLimiter, validate(admin2faSchema), asyncHandler(adminAuth.complete2fa));
router.post('/logout', requireAuth, asyncHandler(adminAuth.logout));

router.get('/me', ...adminGuard, asyncHandler(adminAuth.me));

router.post('/2fa/setup', ...adminGuard, asyncHandler(adminAuth.start2fa));
router.post('/2fa/enable', ...adminGuard, validate(admin2faCodeSchema), asyncHandler(adminAuth.enable2fa));
router.post('/2fa/disable', ...adminGuard, validate(admin2faCodeSchema), asyncHandler(adminAuth.disable2fa));
router.post('/2fa/recovery', ...adminGuard, validate(admin2faCodeSchema), asyncHandler(adminAuth.recoveryCodes));

router.get('/sessions', ...adminGuard, asyncHandler(adminAuth.sessions));
router.delete('/sessions/:id', ...adminGuard, asyncHandler(adminAuth.revokeSession));
router.post('/sessions/revoke-others', ...adminGuard, asyncHandler(adminAuth.revokeOtherSessions));

module.exports = router;
