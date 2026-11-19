'use strict';

const TABLES = [
  'users',
  'signup_intents',
  'friends',
  'avatars',
  'purchased_avatars',
  'matches',
  'chat_messages',
  'world_chat_messages',
  'notifications',
  'coin_transactions',
  'banners',
  'topup_packages',
  'topup_orders',
  'achievements',
  'user_achievements',
  'user_settings',
  'support_tickets',
  'app_settings'
];

const NOTIFICATION_ICONS = {
  friend: '👥',
  match: '🎮',
  reward: '🎁',
  system: '📢'
};

const ACHIEVEMENT_METRIC_FALLBACK = 0;

const GAME_REWARDS = {
  ranked: {
    win: { xp: 120, coins: 50, score: 25 },
    loss: { xp: 40, coins: 10, score: 0 },
    draw: { xp: 60, coins: 20, score: 10 }
  },
  friendly: {
    win: { xp: 30, coins: 10, score: 0 },
    loss: { xp: 15, coins: 5, score: 0 },
    draw: { xp: 20, coins: 5, score: 0 }
  },
  training: {
    win: { xp: 20, coins: 5, score: 0 },
    loss: { xp: 10, coins: 2, score: 0 },
    draw: { xp: 15, coins: 3, score: 0 }
  }
};

module.exports = {
  TABLES,
  NOTIFICATION_ICONS,
  ACHIEVEMENT_METRIC_FALLBACK,
  GAME_REWARDS
};
