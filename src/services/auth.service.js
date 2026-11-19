'use strict';

const { createClient } = require('@supabase/supabase-js');
const env = require('../config/env');
const { admin, authClient } = require('../config/supabase');
const { ApiError } = require('../utils/ApiError');
const { sign, verify, signSession, signSignupToken, verifySignupToken } = require('../utils/jwt');
const { cookieOptions, clearOAuthVerifierCookie } = require('../utils/cookies');
const { getAuthUserById, findAuthUserByEmail, providersForAuthUser } = require('../utils/authUsers');
const { cleanText } = require('../utils/sanitize');
const { publicUser } = require('../utils/mappers');

const OAUTH_COOKIE = 'tta_oauth_verifier';
const OAUTH_ORIGIN_COOKIE = 'tta_oauth_origin';
const OAUTH_ORIGIN_MAX_AGE = 10 * 60 * 1000;
// Only state that belongs to the PKCE flow is persisted through the cookie
// storage adapter; session payloads are ignored (we issue our own cookie).
const PKCE_STORAGE_KEY = /code-verifier/;
const DEV_HOST_RE =
  /^(localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

function requestOrigin(req) {
  const proto = String(req.headers?.['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const host = req.get ? req.get('host') : req.headers?.host;
  if (!host) return env.siteUrl;
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

/**
 * The backend host the OAuth provider returns to for code exchange.
 * Always targets the backend server handling the session cookie.
 */
function oauthBase(req) {
  return requestOrigin(req);
}

function setOriginCookie(res, origin, req) {
  res.cookie(OAUTH_ORIGIN_COOKIE, sign({ value: origin }, '10m'), cookieOptions(OAUTH_ORIGIN_MAX_AGE, req));
}

function readOriginCookie(req) {
  const signed = req.cookies?.[OAUTH_ORIGIN_COOKIE];
  if (!signed) return null;
  try {
    const payload = verify(signed);
    const origin = String(payload.value || '');
    if (!/^https?:\/\/[^/]+$/.test(origin)) return null;
    return origin;
  } catch (_) {
    return null;
  }
}

function clearOriginCookie(res, req) {
  res.clearCookie(OAUTH_ORIGIN_COOKIE, {
    httpOnly: true,
    secure: Boolean(env.cookieSecure || req?.secure),
    sameSite: env.cookieSameSite,
    path: '/'
  });
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function authErrorToApi(error) {
  const message = String(error?.message || 'Authentication failed');
  if (/already registered|already exists/i.test(message)) {
    return ApiError.conflict('EMAIL_IN_USE', 'An account with this email already exists');
  }
  if (/invalid login credentials/i.test(message)) {
    return ApiError.unauthorized('INVALID_CREDENTIALS', 'Incorrect email or password');
  }
  if (/email not confirmed/i.test(message)) {
    return new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email before signing in');
  }
  if (/password should be at least/i.test(message)) {
    return ApiError.badRequest('WEAK_PASSWORD', 'Password must be at least 8 characters');
  }
  if (/rate limit|too many/i.test(message)) {
    return ApiError.tooMany('RATE_LIMITED', 'Too many attempts. Please wait a moment.');
  }
  if (/provider is not enabled|unsupported provider/i.test(message)) {
    return new ApiError(503, 'PROVIDER_UNAVAILABLE', 'Google sign-in is not enabled yet');
  }
  return new ApiError(400, 'AUTH_ERROR', message);
}

function normalizeUsername(value) {
  return cleanText(value, 24)
    .replace(/[^a-zA-Z0-9_ ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function usernameExists(username, { ignoreAuthUserId = null } = {}) {
  const { data: users, error } = await admin
    .from('users')
    .select('id, auth_user_id')
    .ilike('username', username);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not check username availability');
  if ((users || []).some((row) => !ignoreAuthUserId || row.auth_user_id !== ignoreAuthUserId)) {
    return true;
  }

  const now = new Date().toISOString();
  let query = admin
    .from('signup_intents')
    .select('id, auth_user_id')
    .ilike('username', username)
    .gte('expires_at', now);
  const { data: intents, error: intentError } = await query;
  if (intentError) throw new ApiError(502, 'DATABASE_ERROR', 'Could not check username availability');
  return (intents || []).some((row) => !ignoreAuthUserId || row.auth_user_id !== ignoreAuthUserId);
}

async function uniqueUsername(base) {
  const clean = normalizeUsername(base) || 'Player';
  let candidate = clean.length < 3 ? `${clean}Player`.slice(0, 20) : clean.slice(0, 20);
  if (!(await usernameExists(candidate))) return candidate;
  for (let i = 0; i < 50; i += 1) {
    const suffix = String(Math.floor(1000 + Math.random() * 9000));
    candidate = `${clean.slice(0, 15)}${suffix}`;
    if (!(await usernameExists(candidate))) return candidate;
  }
  throw ApiError.conflict('USERNAME_TAKEN', 'Could not find an available username');
}

async function cleanupExpiredIntents() {
  await admin.from('signup_intents').delete().lt('expires_at', new Date().toISOString());
}

async function findIntent({ authUserId, email }) {
  if (authUserId) {
    const { data } = await admin
      .from('signup_intents')
      .select('*')
      .eq('auth_user_id', authUserId)
      .maybeSingle();
    if (data) return data;
  }
  if (email) {
    const { data } = await admin
      .from('signup_intents')
      .select('*')
      .eq('email', normalizeEmail(email))
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

async function ensurePublicUser(authUser, preferredUsername) {
  const authUserId = authUser.id;

  const { data: existing, error: existingError } = await admin
    .from('users')
    .select('*')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (existingError) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load your profile');
  if (existing) return existing;

  const intent = await findIntent({ authUserId, email: authUser.email });
  const metadata = authUser.user_metadata || {};
  const rawUsername =
    intent?.username ||
    preferredUsername ||
    metadata.username ||
    metadata.full_name ||
    metadata.name ||
    String(authUser.email || '').split('@')[0];

  const username = await uniqueUsername(rawUsername);
  const email = normalizeEmail(authUser.email);
  const isAdmin = env.adminEmails.includes(email);
  const isConfirmed = Boolean(authUser.email_confirmed_at || authUser.confirmed_at);

  const { data: created, error: createError } = await admin
    .from('users')
    .insert({
      auth_user_id: authUserId,
      username,
      email,
      avatar_emoji: '👤',
      is_admin: isAdmin,
      login_streak: isConfirmed ? 1 : 0,
      last_login_date: new Date().toISOString().slice(0, 10)
    })
    .select('*')
    .single();

  if (createError) {
    if (createError.code === '23505') {
      const { data: retry } = await admin
        .from('users')
        .select('*')
        .eq('auth_user_id', authUserId)
        .maybeSingle();
      if (retry) return retry;
      throw ApiError.conflict('SIGNUP_CONFLICT', 'That username or email is already in use');
    }
    throw new ApiError(502, 'DATABASE_ERROR', 'Could not create your profile');
  }

  await admin.from('user_settings').upsert({ user_id: created.id }, { onConflict: 'user_id' });

  await admin.from('notifications').insert({
    user_id: created.id,
    type: 'reward',
    title: 'Welcome to TicTacArena!',
    description: 'Your account is ready. Here is a welcome gift to get you started.',
    action_data: { coins: 100 },
    reward_coins: 100
  });

  await admin.from('coin_transactions').insert({
    user_id: created.id,
    amount: 500,
    type: 'initial',
    description: 'Welcome bonus'
  });

  if (intent) {
    await admin.from('signup_intents').delete().eq('id', intent.id);
  }

  return created;
}

async function touchLogin(user) {
  const today = new Date().toISOString().slice(0, 10);
  const last = user.last_login_date ? String(user.last_login_date) : null;
  let streak = Number(user.login_streak || 0);
  if (last === today) {
    streak = Math.max(1, streak);
  } else {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    streak = last === yesterday ? streak + 1 : 1;
  }

  const { data, error } = await admin
    .from('users')
    .update({
      is_online: true,
      last_seen: new Date().toISOString(),
      last_login_date: today,
      login_streak: streak
    })
    .eq('id', user.id)
    .select('*')
    .single();
  if (error) return user;
  return data;
}

function sessionPayload(user) {
  return {
    user: publicUser(user, { includePrivate: true }),
    sessionToken: signSession(user)
  };
}

async function signup({ username, email, password }) {
  await cleanupExpiredIntents();
  const cleanUsername = normalizeUsername(username);
  const normalizedEmail = normalizeEmail(email);

  if (cleanUsername.length < 3) {
    throw ApiError.badRequest('INVALID_USERNAME', 'Username must be at least 3 characters');
  }

  const { data: existingEmail } = await admin
    .from('users')
    .select('id')
    .eq('email', normalizedEmail)
    .maybeSingle();
  if (existingEmail) throw ApiError.conflict('EMAIL_IN_USE', 'An account with this email already exists');

  if (await usernameExists(cleanUsername)) {
    throw ApiError.conflict('USERNAME_TAKEN', 'That username is already taken');
  }

  const { data: pending } = await admin
    .from('signup_intents')
    .select('id, expires_at')
    .or(`email.eq.${normalizedEmail},username.ilike.${cleanUsername}`)
    .gte('expires_at', new Date().toISOString())
    .maybeSingle();
  if (pending) {
    throw ApiError.conflict(
      'SIGNUP_PENDING',
      'A signup for this email or username is already awaiting verification. Check your inbox or resend the email.'
    );
  }

  const { data, error } = await authClient.auth.signUp({
    email: normalizedEmail,
    password,
    options: {
      data: { username: cleanUsername },
      emailRedirectTo: `${env.siteUrl}/login.html?verified=1`
    }
  });

  if (error) throw authErrorToApi(error);

  const authUser = data.user;
  if (!authUser) {
    throw new ApiError(502, 'AUTH_SERVICE_ERROR', 'Could not create your account');
  }

  // Supabase returns an obfuscated user with no identities when the email exists.
  if (Array.isArray(authUser.identities) && authUser.identities.length === 0) {
    throw ApiError.conflict('EMAIL_IN_USE', 'An account with this email already exists');
  }

  const { error: intentError } = await admin.from('signup_intents').insert({
    auth_user_id: authUser.id,
    username: cleanUsername,
    email: normalizedEmail
  });

  if (intentError) {
    try {
      await admin.auth.admin.deleteUser(authUser.id);
    } catch (_) {
      // Best effort cleanup; expired intents are removed automatically.
    }
    if (intentError.code === '23505') {
      throw ApiError.conflict('USERNAME_TAKEN', 'That username is already reserved');
    }
    throw new ApiError(502, 'DATABASE_ERROR', 'Could not reserve your signup');
  }

  if (authUser.email_confirmed_at || data.session) {
    const user = await ensurePublicUser(authUser, cleanUsername);
    const loggedIn = await touchLogin(user);
    return {
      verified: true,
      ...sessionPayload(loggedIn)
    };
  }

  return {
    verified: false,
    email: normalizedEmail,
    username: cleanUsername,
    verificationToken: signSignupToken({
      authUserId: authUser.id,
      email: normalizedEmail,
      username: cleanUsername
    })
  };
}

async function verificationStatus({ verificationToken }) {
  const payload = verifySignupToken(verificationToken);
  const authUser = await getAuthUserById(payload.authUserId);
  if (!authUser) {
    throw ApiError.notFound('SIGNUP_NOT_FOUND', 'This signup no longer exists. Please sign up again.');
  }

  if (!authUser.email_confirmed_at) {
    return {
      verified: false,
      email: payload.email,
      username: payload.username,
      message: 'Waiting for email verification'
    };
  }

  const user = await ensurePublicUser(authUser, payload.username);
  const loggedIn = await touchLogin(user);
  return {
    verified: true,
    ...sessionPayload(loggedIn)
  };
}

async function resendVerification({ verificationToken }) {
  const payload = verifySignupToken(verificationToken);
  const { error } = await authClient.auth.resend({
    type: 'signup',
    email: payload.email,
    options: { emailRedirectTo: `${env.siteUrl}/login.html?verified=1` }
  });
  if (error) throw authErrorToApi(error);
  return { sent: true, email: payload.email };
}

async function login({ email, password }) {
  const normalizedEmail = normalizeEmail(email);
  const { data, error } = await authClient.auth.signInWithPassword({
    email: normalizedEmail,
    password
  });

  if (error) {
    if (/email not confirmed/i.test(String(error.message))) {
      const authUser = await findAuthUserByEmail(normalizedEmail);
      const intent = authUser ? await findIntent({ authUserId: authUser.id, email: normalizedEmail }) : null;
      if (!authUser) throw authErrorToApi(error);
      return {
        verified: false,
        email: normalizedEmail,
        username: intent?.username || authUser.user_metadata?.username || '',
        verificationToken: signSignupToken({
          authUserId: authUser.id,
          email: normalizedEmail,
          username: intent?.username || authUser.user_metadata?.username || ''
        }),
        message: 'Please verify your email before signing in'
      };
    }
    throw authErrorToApi(error);
  }

  const authUser = data.user;
  if (!authUser) throw ApiError.unauthorized('INVALID_CREDENTIALS', 'Incorrect email or password');
  if (!authUser.email_confirmed_at) {
    return {
      verified: false,
      email: normalizedEmail,
      username: authUser.user_metadata?.username || '',
      verificationToken: signSignupToken({
        authUserId: authUser.id,
        email: normalizedEmail,
        username: authUser.user_metadata?.username || ''
      }),
      message: 'Please verify your email before signing in'
    };
  }

  const user = await ensurePublicUser(authUser, authUser.user_metadata?.username);
  const loggedIn = await touchLogin(user);
  return {
    verified: true,
    ...sessionPayload(loggedIn)
  };
}

async function forgotPassword({ email }) {
  const normalizedEmail = normalizeEmail(email);
  const { error } = await authClient.auth.resetPasswordForEmail(normalizedEmail, {
    redirectTo: `${env.siteUrl}/reset.html`
  });
  if (error && !/rate limit/i.test(String(error.message))) {
    console.warn('[auth] resetPasswordForEmail:', error.message);
  }
  return { sent: true };
}

async function resetPassword({ accessToken, password }) {
  const { data, error } = await authClient.auth.getUser(accessToken);
  if (error || !data?.user) {
    throw ApiError.unauthorized('INVALID_RESET_TOKEN', 'This reset link is invalid or has expired');
  }
  const { error: updateError } = await admin.auth.admin.updateUserById(data.user.id, { password });
  if (updateError) throw authErrorToApi(updateError);
  // Revoke every session issued before this reset.
  await admin
    .from('users')
    .update({ session_invalid_before: sessionEpoch() })
    .eq('auth_user_id', data.user.id);
  return { reset: true };
}

/** Whole-second timestamp so a token issued in the same second stays valid. */
function sessionEpoch() {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
}

function createPkceClient(req, res) {
  let store = {};
  const signed = req.cookies?.[OAUTH_COOKIE];
  if (signed) {
    try {
      const payload = verify(signed);
      if (payload.store && typeof payload.store === 'object') {
        store = payload.store;
      } else if (payload.value) {
        store['default'] = payload.value;
      }
    } catch (_) {}
  }

  const storage = {
    getItem(key) {
      if (!PKCE_STORAGE_KEY.test(String(key))) return null;
      if (store[key] !== undefined) return store[key];
      if (key.endsWith('-code-verifier')) {
        return store[key] || store['default'] || Object.values(store)[0] || null;
      }
      return null;
    },
    setItem(key, value) {
      if (!PKCE_STORAGE_KEY.test(String(key))) return;
      store[key] = value;
      store['default'] = value;
      const signedValue = sign({ store, value }, '10m');
      res.cookie(OAUTH_COOKIE, signedValue, cookieOptions(10 * 60 * 1000, req));
    },
    removeItem(key) {
      if (!PKCE_STORAGE_KEY.test(String(key))) return;
      delete store[key];
      if (!Object.keys(store).length) {
        clearOAuthVerifierCookie(res, req);
      } else {
        const signedValue = sign({ store }, '10m');
        res.cookie(OAUTH_COOKIE, signedValue, cookieOptions(10 * 60 * 1000, req));
      }
    }
  };

  return createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: {
      flowType: 'pkce',
      storage,
      // Must stay true: with persistSession disabled supabase-js ignores the
      // custom storage entirely and keeps the PKCE verifier in per-request
      // memory, so the callback could never exchange the code.
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

async function googleStart(req, res) {
  const backendBase = oauthBase(req);

  // Preserve whichever frontend page the user started from (tictacarena.in or localhost)
  let frontendOrigin = env.siteUrl;
  const referer = req.headers?.referer;
  if (referer) {
    try {
      const parsed = new URL(referer);
      frontendOrigin = parsed.origin;
    } catch (_) {}
  } else if (!env.isProduction) {
    frontendOrigin = backendBase;
  }
  setOriginCookie(res, frontendOrigin, req);

  const client = createPkceClient(req, res);
  const { data, error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${backendBase}/api/auth/google/callback`,
      skipBrowserRedirect: true,
      queryParams: { prompt: 'select_account' }
    }
  });
  if (error || !data?.url) {
    console.warn('[auth] google start failed:', error?.message);
    clearOriginCookie(res, req);
    return `${frontendOrigin}/login.html?error=google_unavailable`;
  }
  return data.url;
}

async function googleCallback(req, res) {
  const startedFrom = readOriginCookie(req) || env.siteUrl;
  const code = String(req.query.code || '');
  const fail = (reason) => {
    console.warn('[auth] google sign-in failed:', reason);
    clearOAuthVerifierCookie(res, req);
    clearOriginCookie(res, req);
    return { ok: false, redirectTo: `${startedFrom}/login.html?error=google_failed` };
  };

  if (!code) return fail('callback reached without an authorization code');

  const client = createPkceClient(req, res);
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  if (error || !data?.user) return fail(error?.message || 'code exchange returned no user');

  let loggedIn;
  try {
    const user = await ensurePublicUser(data.user, data.user.user_metadata?.full_name);
    loggedIn = await touchLogin(user);
  } catch (exchangeError) {
    return fail(`profile provisioning failed: ${exchangeError?.message || exchangeError}`);
  }

  clearOAuthVerifierCookie(res, req);
  clearOriginCookie(res, req);
  return {
    ok: true,
    user: loggedIn,
    sessionToken: signSession(loggedIn),
    redirectTo: `${startedFrom}/index.html?welcome=1`
  };
}

async function me(user) {
  const authUser = await getAuthUserById(user.auth_user_id);
  return {
    user: publicUser(user, { includePrivate: true }),
    linkedProviders: authUser ? providersForAuthUser(authUser) : [],
    email: authUser?.email || user.email
  };
}

async function changePassword(user, { currentPassword, newPassword }) {
  const { data, error } = await authClient.auth.signInWithPassword({
    email: user.email,
    password: currentPassword
  });
  if (error || !data?.user) {
    throw ApiError.unauthorized('INVALID_PASSWORD', 'Your current password is incorrect');
  }
  const { error: updateError } = await admin.auth.admin.updateUserById(user.auth_user_id, {
    password: newPassword
  });
  if (updateError) throw authErrorToApi(updateError);

  // Revoke every session issued before this change. The caller is handed a
  // fresh cookie so they are not signed out by their own password change.
  const { data: refreshed } = await admin
    .from('users')
    .update({ session_invalid_before: sessionEpoch() })
    .eq('id', user.id)
    .select('*')
    .maybeSingle();

  return { changed: true, user: refreshed || user };
}

async function deleteAccount(user, { password }) {
  if (user.auth_user_id) {
    const { error } = await authClient.auth.signInWithPassword({
      email: user.email,
      password
    });
    if (error) throw ApiError.unauthorized('INVALID_PASSWORD', 'Your password is incorrect');
    const { error: deleteError } = await admin.auth.admin.deleteUser(user.auth_user_id);
    if (deleteError) throw new ApiError(502, 'AUTH_SERVICE_ERROR', 'Could not delete your account');
  } else {
    await admin.from('users').delete().eq('id', user.id);
  }
  return { deleted: true };
}

module.exports = {
  signup,
  verificationStatus,
  resendVerification,
  login,
  forgotPassword,
  resetPassword,
  googleStart,
  googleCallback,
  me,
  changePassword,
  deleteAccount,
  normalizeUsername,
  uniqueUsername,
  ensurePublicUser,
  touchLogin,
  sessionPayload,
  authErrorToApi
};
