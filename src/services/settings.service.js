'use strict';

const { admin, one } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { getSettings, invalidateSettingsCache } = require('./user.service');
const { settingsView } = require('../utils/mappers');

// Only the columns the settings screen edits; the row id and the unused
// theme column never leave the server.
const SETTINGS_COLUMNS =
  'sound, music, haptics, auto_rematch, profile_visibility, who_can_message, block_invites, push_notifications, match_invites, rewards, friend_activity, language';

async function get(user) {
  const settings = await getSettings(user.id);
  return { settings: settingsView(settings) };
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
  invalidateSettingsCache(user.id);
  const updated = await one(
    admin
      .from('user_settings')
      .update(allowed)
      .eq('user_id', user.id)
      .select(SETTINGS_COLUMNS)
      .single(),
    'Could not save your settings'
  );
  return { message: 'Settings saved', settings: settingsView(updated) };
}

module.exports = { get, update };
