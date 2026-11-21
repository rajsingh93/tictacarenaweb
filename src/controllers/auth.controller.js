'use strict';

const authService = require('../services/auth.service');
const userService = require('../services/user.service');
const { setSessionCookie, clearSessionCookie } = require('../utils/cookies');
const { signSession } = require('../utils/jwt');
const { invalidateUserCache } = require('../middleware/auth');
const loginGuard = require('../utils/loginGuard');
const env = require('../config/env');

function publicResult(result) {
  if (!result || !result.sessionToken) return result;
  // The website never needs the raw JWT in JavaScript: the httpOnly session
  // cookie is enough, so the token is stripped from every API response.
  const { sessionToken, ...rest } = result;
  return rest;
}

async function signup(req, res) {
  const result = await authService.signup(req.body);
  if (result.verified) setSessionCookie(res, result.sessionToken, req);
  res.status(201).json(publicResult(result));
}

async function verificationStatus(req, res) {
  const result = await authService.verificationStatus(req.body);
  if (result.verified) setSessionCookie(res, result.sessionToken, req);
  res.json(publicResult(result));
}

async function resendVerification(req, res) {
  res.json(await authService.resendVerification(req.body));
}

async function login(req, res) {
  const guardKey = loginGuard.keyOf(req.body?.email, req.ip);
  loginGuard.assertAllowed(guardKey);

  let result;
  try {
    result = await authService.login(req.body);
  } catch (error) {
    if (error.code === 'INVALID_CREDENTIALS') loginGuard.recordFailure(guardKey);
    throw error;
  }

  loginGuard.clear(guardKey);
  if (result.verified) setSessionCookie(res, result.sessionToken, req);
  res.json(publicResult(result));
}

async function logout(req, res) {
  clearSessionCookie(res, req);
  if (req.user) {
    invalidateUserCache(req.user.id);
    await userService.setOnline(req.user.id, false);
  }
  res.json({ message: 'Signed out' });
}

async function forgotPassword(req, res) {
  res.json(await authService.forgotPassword(req.body));
}

async function resetPassword(req, res) {
  res.json(await authService.resetPassword(req.body));
}

async function googleStart(req, res) {
  const url = await authService.googleStart(req, res);
  res.redirect(url);
}

async function googleCallback(req, res) {
  const result = await authService.googleCallback(req, res);
  // A failed exchange must land on the login page with an error, never on the
  // dashboard: an empty session there is what made the guard bounce the user
  // straight back to login.
  if (!result || !result.ok || !result.sessionToken) {
    return res.redirect(result?.redirectTo || `${env.siteUrl}/login.html?error=google_failed`);
  }
  setSessionCookie(res, result.sessionToken, req);
  res.redirect(result.redirectTo || `${env.siteUrl}/index.html?welcome=1`);
}

async function me(req, res) {
  const [data, extras] = await Promise.all([
    authService.me(req.user),
    userService.me(req.user)
  ]);
  res.json({ ...data, user: extras.user, equipped: extras.equipped });
}

async function changePassword(req, res) {
  const result = await authService.changePassword(req.user, req.body);
  // Changing the password revokes older sessions; the caller keeps a fresh one.
  if (result?.user) setSessionCookie(res, signSession(result.user), req);
  res.json({ changed: true });
}

async function deleteAccount(req, res) {
  const result = await authService.deleteAccount(req.user, req.body);
  clearSessionCookie(res, req);
  res.json(result);
}

module.exports = {
  signup,
  verificationStatus,
  resendVerification,
  login,
  logout,
  forgotPassword,
  resetPassword,
  googleStart,
  googleCallback,
  me,
  changePassword,
  deleteAccount
};
