'use strict';

const { createClient } = require('@supabase/supabase-js');
const env = require('../config/env');
const { admin, authClient } = require('../config/supabase');
const { ApiError } = require('../utils/ApiError');
const { sign, verify, signSession, signSignupToken, verifySignupToken } = require('../utils/jwt');
const { cookieOptions, clearOAuthVerifierCookie } = require('../utils/cookies');
const { getAuthUserById, findAuthUserByEmail, providersForAuthUser } = require('../utils/authUsers');
const { cleanText } = require('../utils/sanitize');
const { sessionUser } = require('../utils/mappers');
const { originAllowed } = require('../utils/origin');

const OAUTH_COOKIE = 'tta_oauth_verifier';
const OAUTH_ORIGIN_COOKIE = 'tta_oauth_origin';
const OAUTH_ORIGIN_MAX_AGE = 10 * 60 * 1000;
const USER_AUTH_COLUMNS =
  'id, auth_user_id, username, email, is_admin, is_verified, email_verified, is_banned, ban_reason, banned_until, level, xp, xp_to_next, score, rank_title, wins, losses, draws, coins, bio, avatar_url, avatar_emoji, is_online, last_seen, last_login_date, login_streak, session_invalid_before, created_at';
const INTENT_COLUMNS =
  'id, auth_user_id, email, username, expires_at, created_at, last_verification_sent_at, verification_used_at';
const RESEND_COOLDOWN_MS = 60 * 1000;
// PKCE verifier cookie storage
const PKCE_STORAGE_KEY = /code-verifier/;

function verificationRedirect() {
  return `${env.siteUrl.replace(/\/$/, '')}/pages/login.html?verified=1`;
}

function requestOrigin(req) {
  const proto = String(req.headers?.['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const host = req.get ? req.get('host') : req.headers?.host;
  if (!host) return env.siteUrl;
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

// OAuth callback origin
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
  if (/sending (?:the )?confirmation email|smtp/i.test(message)) {
    return new ApiError(
      503,
      'EMAIL_DELIVERY_FAILED',
      'We could not send the verification email. Please try again in a few minutes.'
    );
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
  const needle = String(username || '').trim().toLowerCase();
  const { data: users, error } = await admin
    .from('users')
    .select('id, auth_user_id, username')
    .ilike('username', username);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not check username availability');
  // Exact match check
  if (
    (users || []).some(
      (row) =>
        (!ignoreAuthUserId || row.auth_user_id !== ignoreAuthUserId) &&
        String(row.username || '').trim().toLowerCase() === needle
    )
  ) {
    return true;
  }

  const now = new Date().toISOString();
  const { data: intents, error: intentError } = await admin
    .from('signup_intents')
    .select('id, auth_user_id, username')
    .ilike('username', username)
    .gte('expires_at', now);
  if (intentError) throw new ApiError(502, 'DATABASE_ERROR', 'Could not check username availability');
  return (intents || []).some(
    (row) =>
      (!ignoreAuthUserId || row.auth_user_id !== ignoreAuthUserId) &&
      String(row.username || '').trim().toLowerCase() === needle
  );
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
      .select(INTENT_COLUMNS)
      .eq('auth_user_id', authUserId)
      .maybeSingle();
    if (data) return data;
  }
  if (email) {
    const { data } = await admin
      .from('signup_intents')
      .select(INTENT_COLUMNS)
      .eq('email', normalizeEmail(email))
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

async function ensurePublicUser(authUser, preferredUsername) {
  const authUserId = authUser.id;
  const isConfirmed = Boolean(authUser.email_confirmed_at || authUser.confirmed_at);
  if (!isConfirmed) {
    throw new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email address before continuing.');
  }

  const { data: existing, error: existingError } = await admin
    .from('users')
    .select(USER_AUTH_COLUMNS)
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (existingError) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load your profile');
  if (existing) {
    if (existing.email_verified) return existing;
    // Upgrade unverified accounts on login
    const { data: upgraded, error } = await admin
      .from('users')
      .update({ email_verified: true })
      .eq('id', existing.id)
      .select(USER_AUTH_COLUMNS)
      .maybeSingle();
    if (error || !upgraded) {
      throw new ApiError(502, 'DATABASE_ERROR', 'Could not update your verification status');
    }
    require('../middleware/auth').invalidateUserCache(existing.id);
    return upgraded;
  }

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

  const { data: created, error: createError } = await admin
    .from('users')
    .insert({
      auth_user_id: authUserId,
      username,
      email,
      avatar_emoji: '👤',
      is_admin: isAdmin,
      email_verified: isConfirmed,
      login_streak: 1,
      last_login_date: new Date().toISOString().slice(0, 10)
    })
    .select(USER_AUTH_COLUMNS)
    .single();

  if (createError) {
    if (createError.code === '23505') {
      const { data: retry } = await admin
        .from('users')
        .select(USER_AUTH_COLUMNS)
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

/**
 * A ban must stop the login itself, not just the next authenticated request.
 * Expired temporary bans are cleared lazily, matching the auth middleware.
 */
async function assertAccountActive(user) {
  if (!user?.is_banned) return user;
  const until = user.banned_until ? new Date(user.banned_until).getTime() : null;
  if (until && until <= Date.now()) {
    const { data } = await admin
      .from('users')
      .update({ is_banned: false, banned_until: null, ban_reason: null })
      .eq('id', user.id)
      .select(USER_AUTH_COLUMNS)
      .maybeSingle();
    return data || { ...user, is_banned: false, banned_until: null, ban_reason: null };
  }
  throw ApiError.forbidden(
    'ACCOUNT_BANNED',
    user.ban_reason ? `This account has been banned: ${user.ban_reason}` : 'This account has been banned'
  );
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

  const streaksEnabled = await require('./featureFlag.service').enabled('daily_streaks');
  const { data, error } = await admin
    .from('users')
    .update({
      is_online: true,
      last_seen: new Date().toISOString(),
      last_login_date: today,
      login_streak: streaksEnabled ? streak : Number(user.login_streak || 0)
    })
    .eq('id', user.id)
    .select(USER_AUTH_COLUMNS)
    .single();
  if (error) return user;
  return data;
}

function sessionPayload(user) {
  return {
    user: sessionUser(user),
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

  // Check pending signup intents
  const pendingSince = new Date().toISOString();
  const { data: pendingEmail } = await admin
    .from('signup_intents')
    .select('id')
    .eq('email', normalizedEmail)
    .gte('expires_at', pendingSince)
    .limit(1);
  const { data: pendingNames } = await admin
    .from('signup_intents')
    .select('id, username')
    .ilike('username', cleanUsername)
    .gte('expires_at', pendingSince);
  const pendingUsername = (pendingNames || []).some(
    (row) => String(row.username || '').trim().toLowerCase() === cleanUsername.toLowerCase()
  );
  if (pendingEmail?.length || pendingUsername) {
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
      emailRedirectTo: verificationRedirect()
    }
  });

  if (error) throw authErrorToApi(error);

  const authUser = data.user;
  if (!authUser) {
    throw new ApiError(502, 'AUTH_SERVICE_ERROR', 'Could not create your account');
  }

  // Supabase returns an obfuscated user with no identities when the email exists
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
    } catch (_) {}
    if (intentError.code === '23505') {
      throw ApiError.conflict('USERNAME_TAKEN', 'That username is already reserved');
    }
    throw new ApiError(502, 'DATABASE_ERROR', 'Could not reserve your signup');
  }

  // Enforce required email confirmation
  if (authUser.email_confirmed_at || data.session) {
    console.error(
      '[auth] Supabase auto-confirmed a new signup. Enable Authentication > Providers > Email > Confirm email.'
    );
    try {
      await admin.auth.admin.deleteUser(authUser.id);
    } catch (_) {}
    await admin.from('signup_intents').delete().eq('auth_user_id', authUser.id);
    throw new ApiError(
      503,
      'EMAIL_VERIFICATION_UNAVAILABLE',
      'Email verification is temporarily unavailable. Please try again later.'
    );
  }

  return {
    verified: false,
    email: normalizedEmail,
    username: cleanUsername,
    message: 'Check your inbox to verify your email before signing in.',
    retryAfter: Math.ceil(RESEND_COOLDOWN_MS / 1000),
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

  const email = normalizeEmail(authUser.email || payload.email);
  const { data: existing } = await admin
    .from('users')
    .select('id, username, email_verified')
    .eq('auth_user_id', authUser.id)
    .maybeSingle();
  if (existing?.email_verified) {
    return {
      verified: true,
      already_verified: true,
      email,
      username: existing.username || payload.username,
      message: 'This email is already verified. Please sign in.'
    };
  }

  const intent = await findIntent({ authUserId: authUser.id, email });
  let intentId = null;
  if (intent) {
    // Atomically claim the one-time token before provisioning the account.
    const { data: claimed } = await admin
      .from('signup_intents')
      .update({ verification_used_at: new Date().toISOString() })
      .eq('id', intent.id)
      .is('verification_used_at', null)
      .select('id');
    if (!claimed?.length) {
      return {
        verified: true,
        already_verified: true,
        email,
        username: payload.username,
        message: 'This verification link has already been used. Please sign in.'
      };
    }
    intentId = intent.id;
  }

  try {
    const user = await ensurePublicUser(authUser, payload.username);
    await assertAccountActive(user);
    const loggedIn = await touchLogin(user);
    return {
      verified: true,
      message: 'Email verified successfully.',
      ...sessionPayload(loggedIn)
    };
  } catch (error) {
    if (intentId) {
      try {
        await admin
          .from('signup_intents')
          .update({ verification_used_at: null })
          .eq('id', intentId);
      } catch (_) {}
    }
    throw error;
  }
}

function unverifiedLoginError({ authUser, email, username, message }) {
  return new ApiError(
    403,
    'EMAIL_NOT_VERIFIED',
    message || 'Please verify your email before signing in.',
    {
      email,
      username: username || '',
      verificationToken: signSignupToken({
        authUserId: authUser.id,
        email,
        username: username || ''
      }),
      retryAfter: Math.ceil(RESEND_COOLDOWN_MS / 1000)
    }
  );
}

function resendCooldownError(seconds) {
  return new ApiError(
    429,
    'RESEND_COOLDOWN',
    `Please wait ${seconds} second${seconds === 1 ? '' : 's'} before requesting another email.`,
    { retryAfter: seconds }
  );
}

async function resendVerification({ verificationToken }) {
  const payload = verifySignupToken(verificationToken);
  const authUser = await getAuthUserById(payload.authUserId);
  if (!authUser) {
    throw ApiError.notFound('SIGNUP_NOT_FOUND', 'This signup no longer exists. Please sign up again.');
  }
  const email = normalizeEmail(authUser.email || payload.email);
  if (authUser.email_confirmed_at) {
    return {
      sent: false,
      verified: true,
      email,
      message: 'This email is already verified. You can sign in now.'
    };
  }

  const intent = await findIntent({ authUserId: authUser.id, email });
  const now = Date.now();
  const lastSent = Math.max(
    intent?.last_verification_sent_at ? new Date(intent.last_verification_sent_at).getTime() : 0,
    authUser.confirmation_sent_at ? new Date(authUser.confirmation_sent_at).getTime() : 0
  );
  if (lastSent && now - lastSent < RESEND_COOLDOWN_MS) {
    throw resendCooldownError(Math.max(1, Math.ceil((RESEND_COOLDOWN_MS - (now - lastSent)) / 1000)));
  }

  // Atomic resend claim
  if (intent) {
    const cutoff = new Date(now - RESEND_COOLDOWN_MS).toISOString();
    const { data: claimed, error: claimError } = await admin
      .from('signup_intents')
      .update({ last_verification_sent_at: new Date(now).toISOString() })
      .eq('id', intent.id)
      .lt('last_verification_sent_at', cutoff)
      .select('id');
    if (claimError) throw new ApiError(502, 'DATABASE_ERROR', 'Could not prepare a new verification email');
    if (!claimed?.length) throw resendCooldownError(Math.ceil(RESEND_COOLDOWN_MS / 1000));
  }

  const { error } = await authClient.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: verificationRedirect() }
  });
  if (error) {
    if (intent) {
      await admin
        .from('signup_intents')
        .update({ last_verification_sent_at: intent.last_verification_sent_at })
        .eq('id', intent.id);
    }
    throw authErrorToApi(error);
  }
  return { sent: true, email, retryAfter: Math.ceil(RESEND_COOLDOWN_MS / 1000) };
}

async function login({ email, password }) {
  const normalizedEmail = normalizeEmail(email);
  const { data, error } = await authClient.auth.signInWithPassword({
    email: normalizedEmail,
    password
  });

  if (error) {
    if (/email not confirmed/i.test(String(error.message))) {
      const intent = await findIntent({ email: normalizedEmail });
      let authUser = intent?.auth_user_id
        ? await getAuthUserById(intent.auth_user_id)
        : null;
      if (!authUser) authUser = await findAuthUserByEmail(normalizedEmail);
      if (!authUser) throw authErrorToApi(error);
      const username = intent?.username || authUser.user_metadata?.username || '';
      throw unverifiedLoginError({ authUser, email: normalizedEmail, username });
    }
    throw authErrorToApi(error);
  }

  const authUser = data.user;
  if (!authUser) throw ApiError.unauthorized('INVALID_CREDENTIALS', 'Incorrect email or password');
  if (!authUser.email_confirmed_at) {
    const username = authUser.user_metadata?.username || '';
    throw unverifiedLoginError({ authUser, email: normalizedEmail, username });
  }

  const user = await ensurePublicUser(authUser, authUser.user_metadata?.username);
  if (user.email_verified !== true) {
    throw unverifiedLoginError({
      authUser,
      email: normalizedEmail,
      username: user.username || authUser.user_metadata?.username || ''
    });
  }
  await assertAccountActive(user);
  await require('./restriction.service').assertAllowed(user.id, 'login');
  const loggedIn = await touchLogin(user);
  return {
    verified: true,
    ...sessionPayload(loggedIn)
  };
}

async function forgotPassword({ email }) {
  const normalizedEmail = normalizeEmail(email);
  const { error } = await authClient.auth.resetPasswordForEmail(normalizedEmail, {
    // Link straight at the real page: /reset.html would add a 301 hop that
    // can drop the recovery fragment in some clients.
    redirectTo: `${env.siteUrl}/pages/reset.html`
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
  // Invalidate previous sessions
  const { data: updated } = await admin
    .from('users')
    .update({ session_invalid_before: sessionEpoch() })
    .eq('auth_user_id', data.user.id)
    .select('id');
  for (const row of updated || []) {
    require('../middleware/auth').invalidateUserCache(row.id);
  }
  return { reset: true };
}

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
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

async function googleStart(req, res) {
  const backendBase = oauthBase(req);

  let frontendOrigin = env.siteUrl;
  const returnParam = req.query?.return_url || req.query?.redirect_to || req.query?.origin;
  if (returnParam) {
    try {
      const parsed = new URL(returnParam);
      if (originAllowed(parsed.origin)) frontendOrigin = parsed.origin;
    } catch (_) {}
  } else {
    const referer = req.headers?.referer;
    if (referer) {
      try {
        const parsed = new URL(referer);
        if (originAllowed(parsed.origin)) frontendOrigin = parsed.origin;
      } catch (_) {}
    }
  }

  if (frontendOrigin === backendBase) {
    frontendOrigin = env.siteUrl;
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
    return `${frontendOrigin}/pages/login.html?error=google_unavailable`;
  }
  return data.url;
}

async function googleCallback(req, res) {
  const backendBase = oauthBase(req);
  let startedFrom = readOriginCookie(req) || env.siteUrl;
  if (!originAllowed(startedFrom)) startedFrom = env.siteUrl;
  if (startedFrom === backendBase) {
    startedFrom = env.siteUrl;
  }

  const code = String(req.query.code || '');
  const fail = (reason) => {
    console.warn('[auth] google sign-in failed:', reason);
    clearOAuthVerifierCookie(res, req);
    clearOriginCookie(res, req);
    return { ok: false, redirectTo: `${startedFrom}/pages/login.html?error=google_failed` };
  };

  if (!code) return fail('callback reached without an authorization code');

  const client = createPkceClient(req, res);
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  if (error || !data?.user) return fail(error?.message || 'code exchange returned no user');

  let loggedIn;
  try {
    const user = await ensurePublicUser(data.user, data.user.user_metadata?.full_name);
    await assertAccountActive(user);
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
    redirectTo: `${startedFrom}/pages/dashboard.html?welcome=1`
  };
}

async function me(user) {
  const authUser = await getAuthUserById(user.auth_user_id);
  return {
    // The account email already lives on the user DTO; it is not repeated at
    // the top level.
    user: { ...sessionUser(user), email: authUser?.email || user.email },
    linkedProviders: authUser ? providersForAuthUser(authUser) : []
  };
}

async function changePassword(user, { currentPassword, newPassword }) {
  const { data, error } = await authClient.auth.signInWithPassword({
    email: user.email,
    password: currentPassword
  });
  if (error || !data?.user) {
    throw ApiError.badRequest('INVALID_PASSWORD', 'Your current password is incorrect');
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
    .select(USER_AUTH_COLUMNS)
    .maybeSingle();

  return { changed: true, user: refreshed || user };
}

async function deleteAccount(user, { password, confirm } = {}) {
  if (user.auth_user_id) {
    const authUser = await getAuthUserById(user.auth_user_id);
    const providers = providersForAuthUser(authUser);
    const hasPassword = providers.includes('email');

    if (hasPassword) {
      if (!password) {
        throw ApiError.badRequest('PASSWORD_REQUIRED', 'Enter your password to delete your account');
      }
      const { error } = await authClient.auth.signInWithPassword({
        email: user.email,
        password
      });
      if (error) throw ApiError.unauthorized('INVALID_PASSWORD', 'Your password is incorrect');
    } else if (String(confirm || '').trim().toLowerCase() !== String(user.username || '').toLowerCase()) {
      throw ApiError.badRequest('CONFIRMATION_REQUIRED', 'Type your username to confirm deletion');
    }

    const { error: deleteError } = await admin.auth.admin.deleteUser(user.auth_user_id);
    if (deleteError) throw new ApiError(502, 'AUTH_SERVICE_ERROR', 'Could not delete your account');
  } else {
    await admin.from('users').delete().eq('id', user.id);
  }
  require('../middleware/auth').invalidateUserCache(user.id);
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
