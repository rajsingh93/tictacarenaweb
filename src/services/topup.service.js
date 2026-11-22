'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const { admin, one, many, rpc } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { SESSION_USER_COLUMNS, sessionUser } = require('../utils/mappers');

const PAYMENT_METHODS = ['card', 'paypal', 'apple_pay', 'google_pay'];
// `currency` is kept in the row for the order insert but is not serialized.
const PACK_COLUMNS = 'id, tag, coins, bonus_coins, price_cents, currency';
const ORDER_COLUMNS =
  'id, coins, price_cents, payment_method, status, created_at, completed_at';

let cachedPackages = null;
let packagesExpireAt = 0;
const PACKAGES_CACHE_TTL = 5 * 60 * 1000;

function priceLabel(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

async function packages() {
  if (cachedPackages && Date.now() < packagesExpireAt) {
    return cachedPackages;
  }
  const rows = await many(
    admin
      .from('topup_packages')
      .select(PACK_COLUMNS)
      .eq('is_active', true)
      .order('sort_order', { ascending: true }),
    'Could not load top-up packs'
  );
  cachedPackages = {
    packages: rows.map((row) => ({
      id: row.id,
      tag: row.tag,
      coins: row.coins,
      bonus_coins: row.bonus_coins,
      total_coins: row.coins + row.bonus_coins,
      price: priceLabel(row.price_cents)
    }))
  };
  packagesExpireAt = Date.now() + PACKAGES_CACHE_TTL;
  return cachedPackages;
}

async function createOrder(user, { packageId, paymentMethod }) {
  if (!(await require('./featureFlag.service').enabled('topups'))) {
    throw ApiError.forbidden('TOPUPS_DISABLED', 'Coin top-ups are temporarily disabled');
  }
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    throw ApiError.badRequest('INVALID_PAYMENT_METHOD', 'Choose a supported payment method');
  }

  const { packages: packs } = await packages();
  const pack = packs.find((p) => p.id === Number(packageId)) || await one(
    admin
      .from('topup_packages')
      .select(PACK_COLUMNS)
      .eq('id', packageId)
      .eq('is_active', true)
      .maybeSingle(),
    'Could not load that top-up pack'
  );
  if (!pack) throw ApiError.notFound('PACK_NOT_FOUND', 'That top-up pack is not available');

  if (!env.topupSandbox) {
    throw new ApiError(
      503,
      'PAYMENT_NOT_CONFIGURED',
      'Payments are not live yet. Please contact support to top up your coins.'
    );
  }

  const providerRef = `sandbox_${crypto.randomBytes(12).toString('hex')}`;
  const order = await one(
    admin
      .from('topup_orders')
      .insert({
        user_id: user.id,
        package_id: pack.id,
        coins: pack.coins + pack.bonus_coins,
        price_cents: pack.price_cents,
        currency: pack.currency,
        payment_method: paymentMethod,
        provider: 'sandbox',
        provider_ref: providerRef,
        status: 'pending'
      })
      .select(ORDER_COLUMNS)
      .single(),
    'Could not create your order'
  );

  const completed = await rpc(
    'complete_topup_order',
    { p_order_id: order.id },
    'Could not complete your order'
  );

  const refreshed = await one(
    admin.from('users').select(SESSION_USER_COLUMNS).eq('id', user.id).single(),
    'Could not refresh your account'
  );

  return {
    message: `+${order.coins.toLocaleString()} coins added!`,
    order: {
      id: order.id,
      coins: order.coins,
      total_coins: order.coins,
      price: priceLabel(order.price_cents),
      payment_method: order.payment_method,
      status: 'completed',
      created_at: order.created_at,
      completed_at: new Date().toISOString()
    },
    coins: completed?.coins ?? refreshed.coins,
    sandbox: true,
    user: sessionUser(refreshed)
  };
}

async function orders(user, limit = 20) {
  const rows = await many(
    admin
      .from('topup_orders')
      .select('id, coins, price_cents, payment_method, status, created_at, completed_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(Number(limit) || 20, 1), 50)),
    'Could not load your orders'
  );
  return {
    orders: rows.map((row) => ({
      id: row.id,
      coins: row.coins,
      price: priceLabel(row.price_cents),
      payment_method: row.payment_method,
      status: row.status,
      created_at: row.created_at,
      completed_at: row.completed_at
    }))
  };
}

function secretsMatch(provided, expected) {
  const left = Buffer.from(String(provided || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function webhook(payload, secret) {
  if (!env.topupWebhookSecret) {
    throw new ApiError(503, 'WEBHOOK_NOT_CONFIGURED', 'Payment webhooks are not configured');
  }
  if (!secretsMatch(secret, env.topupWebhookSecret)) {
    throw ApiError.unauthorized('INVALID_WEBHOOK_SECRET', 'Invalid webhook signature');
  }

  const orderId = Number(payload?.orderId);
  const reference = payload?.providerRef ? String(payload.providerRef) : null;
  if (!orderId && !reference) {
    throw ApiError.badRequest('INVALID_WEBHOOK', 'orderId or providerRef is required');
  }

  let query = admin.from('topup_orders').select('id, user_id, package_id, coins, price_cents, currency, status');
  query = orderId ? query.eq('id', orderId) : query.eq('provider_ref', reference);
  const order = await one(query.maybeSingle(), 'Could not load the order');
  if (!order) throw ApiError.notFound('ORDER_NOT_FOUND', 'Order not found');

  const status = String(payload.status || 'paid').toLowerCase();
  if (['failed', 'cancelled', 'canceled', 'refunded'].includes(status)) {
    await admin.from('topup_orders').update({ status: 'failed' }).eq('id', order.id).eq('status', 'pending');
    return { received: true, status: 'failed' };
  }

  const result = await rpc('complete_topup_order', { p_order_id: order.id }, 'Could not complete the order');
  return { received: true, status: 'completed', coins: result?.coins, amount: result?.amount };
}

module.exports = { packages, createOrder, orders, webhook, priceLabel };
