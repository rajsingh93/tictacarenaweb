'use strict';

const { z } = require('zod');

const adminLoginSchema = z.object({
  email: z.string().trim().email('Enter a valid email address').max(254),
  password: z.string().min(1, 'Password is required').max(128)
});

const admin2faSchema = z.object({
  challengeToken: z.string().min(10, 'A verification challenge is required').max(4096),
  code: z.string().trim().min(4, 'Enter your authentication code').max(64)
});

const admin2faCodeSchema = z.object({
  code: z.string().trim().min(4, 'Enter your authentication code').max(64)
});

const adminRoleSchema = z.object({
  role: z.enum(['super_admin', 'admin', 'moderator', 'support', 'analyst', 'player']),
  overrides: z.record(z.boolean()).optional()
});

const adminPolicySchema = z
  .object({
    require_2fa: z.boolean().optional(),
    ip_allowlist: z.array(z.string().trim().max(64)).max(50).optional()
  })
  .refine((value) => Object.keys(value).length > 0, 'No security settings were supplied');

const bulkUserSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1, 'Select at least one player').max(100),
  action: z.enum(['ban', 'unban', 'verify', 'unverify', 'notify']),
  message: z.string().trim().max(500).optional()
});

const userUpdateSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(20)
      .regex(/^[a-zA-Z0-9_ ]+$/, 'Use letters, numbers, spaces or underscores')
      .optional(),
    bio: z.string().max(280).optional(),
    avatar_emoji: z.string().trim().max(8).optional(),
    is_verified: z.boolean().optional(),
    verification_note: z.string().max(300).optional()
  })
  .refine((value) => Object.keys(value).length > 0, 'No permitted fields were supplied');

const banSchema = z.object({
  ban: z.boolean(),
  reason: z.string().trim().max(300).optional(),
  durationHours: z.coerce.number().int().min(0).max(8760).optional()
});

const verificationSchema = z.object({
  verified: z.boolean(),
  note: z.string().trim().max(300).optional()
});

const voidMatchSchema = z.object({
  reason: z.string().trim().min(5, 'Explain why the match is being voided').max(300)
});

const disputeUpdateSchema = z.object({
  status: z.enum(['reviewing', 'resolved', 'rejected']),
  resolution: z.string().trim().max(1000).optional(),
  voidMatch: z.boolean().optional()
});

const tournamentSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  name: z.string().trim().min(3, 'Name must be at least 3 characters').max(80),
  description: z.string().trim().max(2000).optional(),
  rules: z.string().trim().max(5000).optional(),
  format: z.enum(['single_elimination', 'round_robin', 'swiss']).optional(),
  mode: z.enum(['ranked', 'friendly']).optional(),
  max_players: z.coerce.number().int().min(2).max(256).optional(),
  entry_fee: z.coerce.number().int().min(0).max(1000000).optional(),
  prize_pool: z.coerce.number().int().min(0).max(10000000).optional(),
  status: z.enum(['draft', 'open', 'live', 'completed', 'cancelled']).optional(),
  starts_at: z.string().trim().max(64).nullable().optional(),
  cancelled_reason: z.string().trim().max(300).optional(),
  reward_structure: z
    .array(
      z.object({
        place: z.coerce.number().int().min(1).max(64),
        coins: z.coerce.number().int().min(0).max(10000000)
      })
    )
    .max(16)
    .optional()
});

const bracketAdvanceSchema = z.object({
  round: z.coerce.number().int().min(1),
  matchIndex: z.coerce.number().int().min(0),
  winnerId: z.coerce.number().int().positive()
});

const tournamentPayoutSchema = z.object({
  payouts: z
    .array(
      z.object({
        userId: z.coerce.number().int().positive(),
        coins: z.coerce.number().int().min(1).max(10000000),
        place: z.coerce.number().int().min(1).max(64).optional()
      })
    )
    .max(64)
    .optional()
});

const tournamentCancelSchema = z.object({
  reason: z.string().trim().max(300).optional(),
  refund: z.boolean().optional()
});

const adjustCoinsSchema = z
  .object({
    requestId: z.string().trim().min(8).max(80),
    userId: z.coerce.number().int().positive().optional(),
    username: z.string().trim().max(24).optional(),
    amount: z.coerce.number().int().refine((value) => value !== 0, 'Amount cannot be zero'),
    reason: z.string().trim().min(3, 'Give a reason').max(300)
  })
  .refine((value) => value.userId || value.username, 'Choose a player');

const leaderboardResetSchema = z.object({
  confirmation: z.string().trim().min(1, 'Type the confirmation phrase'),
  includeRecord: z.boolean().optional()
});

const restrictionSchema = z
  .object({
    userId: z.coerce.number().int().positive().optional(),
    username: z.string().trim().max(24).optional(),
    type: z.enum(['chat', 'world_chat', 'matchmaking', 'login']),
    reason: z.string().trim().max(300).optional(),
    hours: z.coerce.number().int().min(0).max(8760).optional()
  })
  .refine((value) => value.userId || value.username, 'Choose a player');

const reportUpdateSchema = z.object({
  status: z.enum(['open', 'reviewing', 'resolved', 'dismissed']),
  resolution: z.string().trim().max(1000).optional(),
  removeContent: z.boolean().optional(),
  restrict: z
    .object({
      type: z.enum(['chat', 'world_chat', 'matchmaking', 'login']).optional(),
      hours: z.coerce.number().int().min(0).max(8760).optional()
    })
    .optional()
});

const moderationSettingsSchema = z
  .object({
    moderation: z
      .object({
        bannedWords: z.array(z.string().trim().max(40)).max(500).optional(),
        autoMuteEnabled: z.boolean().optional(),
        linkBlocking: z.boolean().optional()
      })
      .optional(),
    chat: z
      .object({
        worldChatEnabled: z.boolean().optional(),
        maxWords: z.coerce.number().int().min(1).max(200).optional(),
        slowModeSeconds: z.coerce.number().int().min(0).max(3600).optional()
      })
      .optional()
  })
  .refine((value) => value.moderation || value.chat, 'No moderation settings were supplied');

const campaignSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  name: z.string().trim().min(3).max(100),
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(5).max(2000),
  type: z.enum(['system', 'reward', 'match', 'friend']).optional(),
  reward_coins: z.coerce.number().int().min(0).max(1000000).optional(),
  audience: z.enum(['all', 'active_7d', 'active_30d', 'new_30d', 'inactive_30d', 'top_players', 'custom']).optional(),
  audience_ids: z.array(z.coerce.number().int().positive()).max(20000).optional(),
  scheduled_at: z.string().trim().max(64).nullable().optional()
});

const testNotificationSchema = z.object({
  title: z.string().trim().max(120).optional(),
  body: z.string().trim().max(1000).optional(),
  type: z.enum(['system', 'reward', 'match', 'friend']).optional(),
  reward_coins: z.coerce.number().int().min(0).max(1000000).optional()
});

const templateSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  name: z.string().trim().min(2).max(80),
  title: z.string().trim().min(2).max(120),
  body: z.string().trim().min(3).max(2000),
  type: z.enum(['system', 'reward', 'match', 'friend']).optional(),
  reward_coins: z.coerce.number().int().min(0).max(1000000).optional(),
  action_data: z.record(z.any()).nullable().optional()
});

const pageSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  slug: z.string().trim().min(1).max(80),
  title: z.string().trim().min(2).max(140),
  excerpt: z.string().trim().max(400).optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  blocks: z.array(z.any()).max(120).optional(),
  content: z.object({ blocks: z.array(z.any()).max(120) }).optional(),
  seo_title: z.string().trim().max(80).optional(),
  seo_description: z.string().trim().max(320).optional(),
  og_image: z.string().trim().max(1000).optional(),
  canonical_url: z.string().trim().max(1000).optional(),
  no_index: z.boolean().optional()
});

const seoSchema = z
  .object({
    seo: z.record(z.any()).optional(),
    branding: z.record(z.any()).optional(),
    structuredData: z.record(z.any()).optional()
  })
  .refine((value) => value.seo || value.branding || value.structuredData, 'No SEO settings were supplied');

const redirectSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  from_path: z.string().trim().min(1).max(500),
  to_path: z.string().trim().min(1).max(1000),
  status_code: z.coerce.number().int().refine((value) => [301, 302, 307, 308].includes(value), 'Choose a valid status'),
  is_active: z.boolean().optional()
});

const supportReplySchema = z.object({
  message: z.string().trim().min(2, 'Write a reply').max(5000),
  internal: z.boolean().optional()
});

const supportUpdateSchema = z
  .object({
    status: z.enum(['open', 'in_progress', 'closed']).optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    category: z.enum(['general', 'technical', 'payment', 'account', 'fair_play', 'other']).optional(),
    assigned_to: z.union([z.coerce.number().int().positive(), z.null(), z.literal('')]).optional(),
    resolution_note: z.string().trim().max(2000).optional()
  })
  .refine((value) => Object.keys(value).length > 0, 'No ticket fields were supplied');

const flagSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  key: z.string().trim().min(2).max(60),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(),
  enabled: z.boolean().optional(),
  rollout_percent: z.coerce.number().int().min(0).max(100).optional(),
  audience: z.record(z.any()).optional()
});

const jobSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  name: z.string().trim().min(2).max(100),
  type: z.enum(['retention_cleanup', 'leaderboard_snapshot', 'notification_campaign', 'system_snapshot']),
  recurrence: z.enum(['once', 'hourly', 'daily', 'weekly', 'monthly']).optional(),
  payload: z.record(z.any()).optional(),
  is_active: z.boolean().optional(),
  next_run_at: z.string().trim().max(64).optional()
});

const achievementSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  code: z.string().trim().min(3).max(60),
  emoji: z.string().trim().max(8).optional(),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().min(3).max(300),
  category: z.enum(['combat', 'social', 'special']),
  tier: z.enum(['bronze', 'silver', 'gold']),
  metric: z
    .string()
    .trim()
    .min(3)
    .max(60)
    .regex(/^[a-z][a-z0-9_]{2,60}$/, 'Choose a valid metric key'),
  target: z.coerce.number().int().min(1).max(100000000),
  comparison: z.enum(['gte', 'lte']).optional(),
  reward_coins: z.coerce.number().int().min(0).max(10000000).optional(),
  sort_order: z.coerce.number().int().min(0).max(100000).optional()
});

const maintenanceSchema = z.object({
  enabled: z.boolean(),
  message: z.string().trim().max(500).optional(),
  ends_at: z.string().trim().max(64).nullable().optional()
});

const retentionSchema = z
  .object({
    adminLoginDays: z.coerce.number().int().min(7).max(3650).optional(),
    auditDays: z.coerce.number().int().min(30).max(3650).optional(),
    errorDays: z.coerce.number().int().min(7).max(3650).optional(),
    notificationDays: z.coerce.number().int().min(7).max(3650).optional(),
    chatDays: z.coerce.number().int().min(7).max(3650).optional()
  })
  .refine((value) => Object.keys(value).length > 0, 'No retention values were supplied');

module.exports = {
  adminLoginSchema,
  admin2faSchema,
  admin2faCodeSchema,
  adminRoleSchema,
  adminPolicySchema,
  bulkUserSchema,
  userUpdateSchema,
  banSchema,
  verificationSchema,
  voidMatchSchema,
  disputeUpdateSchema,
  tournamentSchema,
  bracketAdvanceSchema,
  tournamentPayoutSchema,
  tournamentCancelSchema,
  adjustCoinsSchema,
  leaderboardResetSchema,
  restrictionSchema,
  reportUpdateSchema,
  moderationSettingsSchema,
  campaignSchema,
  testNotificationSchema,
  templateSchema,
  pageSchema,
  seoSchema,
  redirectSchema,
  supportReplySchema,
  supportUpdateSchema,
  flagSchema,
  jobSchema,
  achievementSchema,
  retentionSchema,
  maintenanceSchema
};
