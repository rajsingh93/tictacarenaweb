'use strict';

const { admin, one } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { getSettings } = require('./user.service');

async function get(user) {
  const settings = await getSettings(user.id);
  return { settings };
}

async function update(user, patch) {
  const allowed = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) allowed[key] = value;
  }
  if (!Object.keys(allowed).length) {
    throw ApiError.badRequest('NO_CHANGES', 'No settings were supplied');
  }
  // Ensure a row exists first.
  await getSettings(user.id);
  const updated = await one(
    admin
      .from('user_settings')
      .update(allowed)
      .eq('user_id', user.id)
      .select('*')
      .single(),
    'Could not save your settings'
  );
  return { message: 'Settings saved', settings: updated };
}

module.exports = { get, update };
