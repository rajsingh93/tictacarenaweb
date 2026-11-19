'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const auth = require('../controllers/auth.controller');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { authLimiter } = require('../middleware/rateLimit');
const {
  signupSchema,
  loginSchema,
  verificationSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  deleteAccountSchema
} = require('../validation/schemas');

const router = express.Router();

router.post('/signup', authLimiter, validate(signupSchema), asyncHandler(auth.signup));
router.post('/verification-status', authLimiter, validate(verificationSchema), asyncHandler(auth.verificationStatus));
router.post('/resend-verification', authLimiter, validate(verificationSchema), asyncHandler(auth.resendVerification));
router.post('/login', authLimiter, validate(loginSchema), asyncHandler(auth.login));
router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), asyncHandler(auth.forgotPassword));
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), asyncHandler(auth.resetPassword));

router.get('/google', authLimiter, asyncHandler(auth.googleStart));
router.get('/google/callback', asyncHandler(auth.googleCallback));

router.post('/logout', optionalAuth, asyncHandler(auth.logout));
router.get('/me', requireAuth, asyncHandler(auth.me));
router.post(
  '/change-password',
  requireAuth,
  authLimiter,
  validate(changePasswordSchema),
  asyncHandler(auth.changePassword)
);
router.delete(
  '/account',
  requireAuth,
  authLimiter,
  validate(deleteAccountSchema),
  asyncHandler(auth.deleteAccount)
);

module.exports = router;
