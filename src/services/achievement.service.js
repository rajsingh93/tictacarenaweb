'use strict';

const { admin, one, many, rpc } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { achievementView } = require('../utils/mappers');

let cachedAchievements = null;
let achievementsExpireAt = 0;
const ACHIEVEMENTS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getCachedAchievements() {
  if (cachedAchievements && Date.now() < achievementsExpireAt) {
    return cachedAchievements;
  }
  const rows = await many(
    admin
      .from('achievements')
      .select('id, code, emoji, name, description, category, tier, metric, target, comparison, reward_coins, sort_order')
      .order('sort_order', { ascending: true }),
    'Could not load achievements'
  );
  cachedAchievements = rows;
  achievementsExpireAt = Date.now() + ACHIEVEMENTS_CACHE_TTL;
  return rows;
}

function metricValue(metrics, achievement) {
  const raw = Number(metrics?.[achievement.metric] ?? 0);
  if (achievement.comparison === 'lte') {
    // "lte" style achievements measure "finish under X"; progress is binary.
    return raw > 0 && raw <= achievement.target ? achievement.target : 0;
  }
  return Math.max(0, Math.min(raw, achievement.target));
}

function isUnlocked(metrics, achievement) {
  const raw = Number(metrics?.[achievement.metric] ?? 0);
  if (achievement.comparison === 'lte') return raw > 0 && raw <= achievement.target;
  return raw >= achievement.target;
}

async function list(user) {
  const [achievements, claimed, metrics] = await Promise.all([
    getCachedAchievements(),
    many(
      admin.from('user_achievements').select('achievement_id').eq('user_id', user.id),
      'Could not load your achievements'
    ),
    rpc('get_achievement_metrics', { p_user_id: user.id }, 'Could not calculate achievement progress')
  ]);

  const claimedIds = new Set(claimed.map((row) => String(row.achievement_id)));
  const items = achievements.map((achievement) => {
    const progress = metricValue(metrics, achievement);
    const unlocked = isUnlocked(metrics, achievement);
    return achievementView(achievement, {
      progress,
      percent: Math.round((progress / achievement.target) * 100),
      unlocked,
      claimed: claimedIds.has(String(achievement.id))
    });
  });

  return {
    achievements: items,
    claimed: items.filter((item) => item.claimed).length,
    unlocked: items.filter((item) => item.unlocked).length
  };
}

async function claim(user, achievementId) {
  const id = Number(achievementId);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest('INVALID_ACHIEVEMENT', 'Invalid achievement');
  }

  const catalog = await getCachedAchievements();
  const achievement = catalog.find((a) => a.id === id);

  const [metrics, existing] = await Promise.all([
    rpc('get_achievement_metrics', { p_user_id: user.id }, 'Could not verify achievement progress'),
    one(
      admin
        .from('user_achievements')
        .select('achievement_id')
        .eq('user_id', user.id)
        .eq('achievement_id', id)
        .maybeSingle(),
      'Could not check your achievements'
    )
  ]);

  if (!achievement) throw ApiError.notFound('ACHIEVEMENT_NOT_FOUND', 'Achievement not found');
  if (existing) throw ApiError.conflict('ALREADY_CLAIMED', 'You have already claimed this achievement');
  if (!isUnlocked(metrics, achievement)) {
    throw ApiError.badRequest('NOT_UNLOCKED', 'Keep playing to unlock this achievement');
  }

  const result = await rpc(
    'claim_achievement',
    { p_user_id: user.id, p_achievement_id: id },
    'Could not claim the achievement'
  );

  const refreshed = await one(
    admin.from('users').select('coins').eq('id', user.id).single(),
    'Could not refresh your account'
  );

  return {
    message: result?.message || 'Achievement claimed',
    coins: result?.coins ?? refreshed.coins,
    reward: result?.reward ?? achievement.reward_coins,
    achievement_id: id
  };
}

module.exports = { list, claim };
