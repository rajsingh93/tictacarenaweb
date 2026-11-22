'use strict';

const { createClient } = require('@supabase/supabase-js');
const env = require('./env');

/**
 * Service-role client. It is only ever created inside the backend process.
 * It bypasses RLS, so every query must be scoped by the authenticated user id.
 */
const admin = createClient(env.supabaseUrl, env.supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false
  },
  global: {
    headers: { 'X-Client-Info': 'tictacarena-backend' }
  }
});

/**
 * Public/anon client used only for GoTrue operations that require the anon key
 * (sign up, password sign in, resend confirmation).
 */
const authClient = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false
  },
  global: {
    headers: { 'X-Client-Info': 'tictacarena-backend-auth' }
  }
});

module.exports = { admin, authClient };
