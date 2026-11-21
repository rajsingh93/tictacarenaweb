'use strict';

const { admin } = require('../config/supabase');
const { ApiError } = require('./ApiError');

async function getAuthUserById(authUserId) {
  if (!authUserId) return null;
  const { data, error } = await admin.auth.admin.getUserById(authUserId);
  if (error) {
    if (/not found/i.test(error.message)) return null;
    throw new ApiError(502, 'AUTH_SERVICE_ERROR', 'Could not reach the authentication service');
  }
  return data?.user || null;
}

async function findAuthUserByEmail(email) {
  const needle = String(email || '').trim().toLowerCase();
  if (!needle) return null;

  const perPage = 1000;
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new ApiError(502, 'AUTH_SERVICE_ERROR', 'Could not reach the authentication service');
    }
    const users = data?.users || [];
    const found = users.find((user) => String(user.email || '').toLowerCase() === needle);
    if (found) return found;
    if (users.length < perPage) break;
  }
  return null;
}

function providersForAuthUser(authUser) {
  const identities = authUser?.identities || [];
  const providers = identities.map((identity) => identity.provider).filter(Boolean);
  if (providers.length === 0 && authUser?.app_metadata?.provider) {
    providers.push(authUser.app_metadata.provider);
  }
  return [...new Set(providers)];
}

module.exports = { getAuthUserById, findAuthUserByEmail, providersForAuthUser };
