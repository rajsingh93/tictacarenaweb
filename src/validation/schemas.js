'use strict';

const { z } = require('zod');
const { countWords } = require('../utils/sanitize');

const username = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(20, 'Username must be 20 characters or fewer')
  .regex(/^[a-zA-Z0-9_ ]+$/, 'Username can only contain letters, numbers, spaces and underscores');

const email = z.string().trim().email('Enter a valid email address').max(254);
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be 128 characters or fewer')
  .refine((value) => /[A-Za-z]/.test(value) && /\d/.test(value), {
    message: 'Password must include at least one letter and one number'
  });
const token = z.string().min(10, 'A valid token is required').max(4096);

const signupSchema = z.object({ username, email, password });

const loginSchema = z.object({ email, password: z.string().min(1, 'Password is required') });

const verificationSchema = z.object({ verificationToken: token });

const forgotPasswordSchema = z.object({ email });

const resetPasswordSchema = z.object({ accessToken: token, password });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: password
});

// Email accounts confirm with their password; Google-only accounts have no
// password and confirm by typing their username instead.
const deleteAccountSchema = z.object({
  password: z.string().optional(),
  confirm: z.string().optional()
});

const usernameAvailabilitySchema = z.object({ username });

const updateProfileSchema = z
  .object({
    username: username.optional(),
    bio: z.string().max(280, 'Bio must be 280 characters or fewer').optional(),
    avatar_emoji: z.string().trim().max(8, 'Choose a shorter emoji').optional()
  })
  .refine((value) => Object.keys(value).length > 0, 'No profile fields were supplied');

const friendRequestSchema = z.object({ username });

const messageBody = z
  .string()
  .trim()
  .min(1, 'Message cannot be empty')
  .max(500, 'Message is too long')
  .refine((value) => countWords(value) <= 20, 'Message cannot exceed 20 words');

const sendMessageSchema = z.object({ message: messageBody });

const settingsSchema = z
  .object({
    sound: z.boolean().optional(),
    music: z.boolean().optional(),
    haptics: z.boolean().optional(),
    auto_rematch: z.boolean().optional(),
    profile_visibility: z.enum(['Everyone', 'Friends Only', 'Private']).optional(),
    who_can_message: z.enum(['Everyone', 'Friends Only', 'No One']).optional(),
    block_invites: z.boolean().optional(),
    push_notifications: z.boolean().optional(),
    match_invites: z.boolean().optional(),
    rewards: z.boolean().optional(),
    friend_activity: z.boolean().optional(),
    theme: z.enum(['Light', 'Dark']).optional(),
    language: z.enum(['English', 'Spanish', 'French', 'German', 'Japanese']).optional()
  })
  .refine((value) => Object.keys(value).length > 0, 'No settings were supplied');

const userMailSchema = z.object({
  recipient: z.string().trim().min(1).max(80),
  subject: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(1000)
});

const topupOrderSchema = z.object({
  packageId: z.coerce.number().int().positive(),
  paymentMethod: z.enum(['card', 'paypal', 'apple_pay', 'google_pay'])
});

const bumpSchema = z.object({ amount: z.coerce.number().int().min(1).max(1000000) });

const trainingSchema = z.object({
  result: z.enum(['win', 'loss', 'draw']),
  boardState: z
    .string()
    .trim()
    .regex(/^[XO-]{9}$/, 'Board state must contain exactly nine cells'),
  durationSeconds: z.coerce.number().int().min(0).max(7200).default(0)
});

const supportSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email,
  subject: z.string().trim().max(160).optional(),
  category: z.enum(['general', 'technical', 'payment', 'account', 'fair_play', 'other']).optional(),
  message: z.string().trim().min(5).max(5000)
});

const supportTicketReplySchema = z.object({
  message: z.string().trim().min(2, 'Write a reply').max(5000)
});

const disputeSchema = z.object({
  reason: z.string().trim().min(3, 'Tell us what happened').max(160),
  details: z.string().trim().max(2000).optional(),
  evidenceUrl: z
    .string()
    .trim()
    .max(500)
    .refine((value) => !value || /^https?:\/\//i.test(value), 'Evidence link must start with http:// or https://')
    .optional()
});

const notifySchema = z.object({
  email: email.optional(),
  name: z.string().trim().max(80).optional()
});

const reportSchema = z.object({
  targetType: z.enum(['user', 'chat_message', 'world_message', 'match']),
  targetId: z.union([z.string().trim().min(1).max(80), z.coerce.number().int().positive()]),
  reason: z.string().trim().min(3, 'Tell us what happened').max(160),
  details: z.string().trim().max(2000).optional()
});

const bannerSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  tag: z.string().trim().min(1).max(50).optional(),
  title: z.string().trim().min(1).max(100).optional(),
  sub: z.string().trim().max(255).optional(),
  decor_emoji: z.string().trim().max(8).optional(),
  is_active: z.boolean().optional()
});

const adminMailSchema = z.object({
  subject: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2000),
  reward_coins: z.coerce.number().int().min(0).max(1000000).default(0)
});

const giveCoinsSchema = z.object({
  username: username,
  amount: z.coerce.number().int().min(1).max(1000000),
  reason: z.string().trim().max(200).optional()
});

const adminGiveCoinsSchema = z.object({ amount: z.coerce.number().int().min(1).max(1000000) });

const banSchema = z.object({ ban: z.boolean() });

const maintenanceSchema = z.object({
  enabled: z.boolean(),
  message: z.string().trim().max(500).optional()
});

const adminSupportSchema = z.object({
  status: z.enum(['open', 'in_progress', 'closed'])
});

const adminRoleSchema = z.object({ is_admin: z.boolean() });

const adminNotifyUserSchema = z.object({
  message: z.string().trim().min(1, 'Write a message').max(500)
});

const adminRewardTopSchema = z.object({
  count: z.coerce.number().int().min(1).max(10).default(3),
  amount: z.coerce.number().int().min(1).max(100000).default(100),
  reason: z.string().trim().max(160).optional()
});

const adminAnnounceSchema = z.object({
  message: z.string().trim().min(1, 'Write an announcement').max(300)
});

const tournamentSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  name: z.string().trim().min(3, 'Name must be at least 3 characters').max(80),
  description: z.string().trim().max(1000).optional(),
  format: z.enum(['single_elimination', 'round_robin', 'swiss']).optional(),
  mode: z.enum(['ranked', 'friendly']).optional(),
  max_players: z.coerce.number().int().min(2).max(256).optional(),
  entry_fee: z.coerce.number().int().min(0).max(1000000).optional(),
  prize_pool: z.coerce.number().int().min(0).max(10000000).optional(),
  status: z.enum(['draft', 'open', 'live', 'completed', 'cancelled']).optional(),
  starts_at: z.string().trim().max(64).nullable().optional()
});

module.exports = {
  signupSchema,
  loginSchema,
  verificationSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  deleteAccountSchema,
  updateProfileSchema,
  usernameAvailabilitySchema,
  friendRequestSchema,
  sendMessageSchema,
  messageBody,
  userMailSchema,
  settingsSchema,
  topupOrderSchema,
  bumpSchema,
  trainingSchema,
  supportSchema,
  supportTicketReplySchema,
  disputeSchema,
  notifySchema,
  reportSchema,
  bannerSchema,
  adminMailSchema,
  giveCoinsSchema,
  adminGiveCoinsSchema,
  banSchema,
  maintenanceSchema,
  adminSupportSchema,
  adminRoleSchema,
  adminNotifyUserSchema,
  adminRewardTopSchema,
  adminAnnounceSchema,
  tournamentSchema
};
