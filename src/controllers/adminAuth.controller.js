'use strict';

const adminSecurity = require('../services/adminSecurity.service');
const userService = require('../services/user.service');
const { setSessionCookie, clearSessionCookie } = require('../utils/cookies');
const { invalidateUserCache } = require('../middleware/auth');
const loginGuard = require('../utils/loginGuard');

function publicResult(result) {
  if (!result?.sessionToken) return result;
  // The admin SPA uses the httpOnly cookie; a raw token is never returned.
  const { sessionToken, ...rest } = result;
  return rest;
}

async function login(req, res) {
  const guardKey = loginGuard.keyOf(req.body?.email, req.ip);
  loginGuard.assertAllowed(guardKey);

  let result;
  try {
    result = await adminSecurity.login({ ...req.body, req });
  } catch (error) {
    if (['INVALID_CREDENTIALS', 'INVALID_PASSWORD'].includes(error.code)) {
      loginGuard.recordFailure(guardKey);
    }
    throw error;
  }

  loginGuard.clear(guardKey);
  if (result?.sessionToken) setSessionCookie(res, result.sessionToken, req);
  res.json(publicResult(result));
}

async function complete2fa(req, res) {
  const guardKey = loginGuard.keyOf(req.body?.challengeToken, req.ip);
  loginGuard.assertAllowed(guardKey);
  let result;
  try {
    result = await adminSecurity.complete2fa({ ...req.body, req });
  } catch (error) {
    if (error.code === 'INVALID_2FA') loginGuard.recordFailure(guardKey);
    throw error;
  }
  loginGuard.clear(guardKey);
  setSessionCookie(res, result.sessionToken, req);
  res.json(publicResult(result));
}

async function logout(req, res) {
  clearSessionCookie(res, req);
  if (req.user) {
    invalidateUserCache(req.user.id);
    await userService.setOnline(req.user.id, false).catch(() => {});
  }
  if (req.adminAccess) {
    await adminSecurity.revokeCurrentSession(req.adminAccess, req).catch(() => {});
  }
  res.json({ message: 'Signed out of the admin console' });
}

async function me(req, res) {
  res.json(adminSecurity.mePayload(req));
}

async function start2fa(req, res) {
  res.json(await adminSecurity.start2fa(req.user, req.adminAccess));
}

async function enable2fa(req, res) {
  res.json(await adminSecurity.enable2fa(req.user, req.adminAccess, req.body.code, req));
}

async function disable2fa(req, res) {
  res.json(await adminSecurity.disable2fa(req.user, req.adminAccess, req.body.code, req));
}

async function recoveryCodes(req, res) {
  res.json(await adminSecurity.regenerateRecoveryCodes(req.user, req.adminAccess, req.body.code, req));
}

async function sessions(req, res) {
  res.json({
    sessions: await adminSecurity.listSessions(req.adminAccess.user_id, { limit: req.query.limit })
  });
}

async function revokeSession(req, res) {
  res.json(await adminSecurity.revokeSession(req.adminAccess, req.params.id, req));
}

async function revokeOtherSessions(req, res) {
  res.json(
    await adminSecurity.revokeAllSessions(req.adminAccess, req.adminAccess.user_id, req, {
      includeCurrent: Boolean(req.body?.includeCurrent)
    })
  );
}

module.exports = {
  login,
  complete2fa,
  logout,
  me,
  start2fa,
  enable2fa,
  disable2fa,
  recoveryCodes,
  sessions,
  revokeSession,
  revokeOtherSessions
};
