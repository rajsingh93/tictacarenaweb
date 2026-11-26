'use strict';

/**
 * Granular admin permissions.
 *
 * The frontend uses these strings only to hide controls. Every API route is
 * independently protected by the same permission on the server, so a forged
 * client request cannot bypass a hidden button.
 */

const ROLES = Object.freeze({
  super_admin: {
    label: 'Super Admin',
    level: 50,
    description: 'Full platform control, including administrator access and security.'
  },
  admin: {
    label: 'Admin',
    level: 40,
    description: 'Day-to-day platform operations without administrator or security control.'
  },
  moderator: {
    label: 'Moderator',
    level: 30,
    description: 'Community moderation, match integrity and player restrictions.'
  },
  support: {
    label: 'Support Agent',
    level: 20,
    description: 'Player assistance, tickets and account context.'
  },
  analyst: {
    label: 'Analyst',
    level: 10,
    description: 'Read-only access to dashboards, reports and operational data.'
  }
});

const PERMISSIONS = Object.freeze({
  'dashboard.view': 'View the command dashboard',
  'realtime.view': 'View live platform monitoring',
  'analytics.view': 'View analytics and reports',
  'analytics.export': 'Export analytics and operational data',
  'users.view': 'View player accounts',
  'users.manage': 'Edit player profile data',
  'users.ban': 'Ban and unban players',
  'users.rewards': 'Grant or adjust coins',
  'users.reset': 'Reset player stats',
  'users.notify': 'Send direct player notifications',
  'users.roles': 'Assign administrator roles and permissions',
  'users.sessions': 'View and revoke player/admin sessions',
  'matches.view': 'View matches and live games',
  'matches.manage': 'Void matches and resolve disputes',
  'matches.live': 'Cancel live in-memory games',
  'tournaments.view': 'View tournaments',
  'tournaments.manage': 'Create and manage tournaments',
  'economy.view': 'View coin economy and top-ups',
  'economy.manage': 'Adjust economy, catalogue and top-up orders',
  'leaderboard.view': 'View leaderboards and snapshots',
  'leaderboard.manage': 'Reward and reset leaderboards',
  'moderation.view': 'View chat and community reports',
  'moderation.manage': 'Mute, remove content and resolve reports',
  'notifications.view': 'View notification campaigns and history',
  'notifications.manage': 'Send and schedule notifications',
  'cms.view': 'View CMS pages, SEO and redirects',
  'cms.manage': 'Edit CMS pages, SEO and redirects',
  'support.view': 'View support tickets',
  'support.manage': 'Reply to, assign and resolve support tickets',
  'security.view': 'View administrators and login security',
  'security.manage': 'Manage administrators, 2FA policy and IP restrictions',
  'system.view': 'View system health, logs and jobs',
  'system.manage': 'Manage maintenance, feature flags and scheduled jobs',
  'settings.view': 'View game and platform configuration',
  'settings.manage': 'Edit game rules and platform configuration',
  'audit.view': 'View and verify the audit trail',
  'exports.run': 'Generate CSV and Excel exports',
  'bulk.run': 'Run bulk operations',
  'search.use': 'Use global admin search'
});

const ALL_PERMISSIONS = Object.freeze(Object.keys(PERMISSIONS));

const READ_ONLY = [
  'dashboard.view',
  'realtime.view',
  'analytics.view',
  'users.view',
  'matches.view',
  'tournaments.view',
  'economy.view',
  'leaderboard.view',
  'moderation.view',
  'notifications.view',
  'cms.view',
  'support.view',
  'security.view',
  'system.view',
  'settings.view',
  'audit.view',
  'exports.run',
  'search.use'
];

const ROLE_PERMISSIONS = Object.freeze({
  super_admin: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS.filter(
    (permission) => !['users.roles', 'security.manage'].includes(permission)
  ),
  moderator: [
    'dashboard.view',
    'realtime.view',
    'users.view',
    'users.sessions',
    'matches.view',
    'matches.manage',
    'matches.live',
    'tournaments.view',
    'economy.view',
    'leaderboard.view',
    'moderation.view',
    'moderation.manage',
    'support.view',
    'search.use'
  ],
  support: [
    'dashboard.view',
    'users.view',
    'users.sessions',
    'users.notify',
    'matches.view',
    'support.view',
    'support.manage',
    'moderation.view',
    'search.use'
  ],
  analyst: READ_ONLY
});

// Compatibility keys consumed by the legacy admin page.
const LEGACY_PERMISSION_MAP = {
  manageRoles: 'users.roles',
  manageUsers: 'users.view',
  manageMatches: 'matches.view',
  manageRewards: 'economy.manage',
  manageNotifications: 'notifications.manage',
  manageTournaments: 'tournaments.manage',
  manageSupport: 'support.manage',
  manageSecurity: 'security.manage',
  manageSystem: 'system.manage',
  viewAnalytics: 'analytics.view'
};

function isKnownRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLES, role);
}

function isKnownPermission(permission) {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, permission);
}

function rolePermissions(role) {
  return new Set(ROLE_PERMISSIONS[role] || []);
}

/**
 * Explicit overrides are stored as `{ "permission": true | false }`.
 * Unknown keys are ignored. A role's defaults stay the baseline.
 */
function effectivePermissions(role, overrides = {}) {
  const set = rolePermissions(role);
  for (const [permission, value] of Object.entries(overrides || {})) {
    if (!isKnownPermission(permission)) continue;
    if (value === true) set.add(permission);
    if (value === false) set.delete(permission);
  }
  return [...set].sort();
}

function legacyPermissions(permissions) {
  const set = new Set(permissions || []);
  return Object.fromEntries(
    Object.entries(LEGACY_PERMISSION_MAP).map(([legacy, permission]) => [legacy, set.has(permission)])
  );
}

function hasPermission(permissions, permission) {
  if (!permission) return false;
  return Array.isArray(permissions) && permissions.includes(permission);
}

function roleRank(role) {
  return ROLES[role]?.level || 0;
}

function canManageRole(actor, targetRole, { isOwner = false } = {}) {
  if (!actor || !isKnownRole(actor) || !isKnownRole(targetRole)) return false;
  if (actor === 'super_admin') {
    if (targetRole === 'super_admin') return Boolean(isOwner);
    return true;
  }
  return false;
}

module.exports = {
  ROLES,
  PERMISSIONS,
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  LEGACY_PERMISSION_MAP,
  isKnownRole,
  isKnownPermission,
  rolePermissions,
  effectivePermissions,
  legacyPermissions,
  hasPermission,
  roleRank,
  canManageRole
};
