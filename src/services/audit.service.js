'use strict';

const crypto = require('crypto');
const { admin, one, many } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { cleanText, cleanMultiline } = require('../utils/sanitize');
const { normalizeIp } = require('../utils/ip');

/**
 * Append-only operational audit trail.
 *
 * The database trigger seals every row into a SHA-256 hash chain. This service
 * only writes through a single insert path, so privileged API handlers cannot
 * accidentally bypass the chain.
 */
async function record(adminUser, action, options = {}) {
  const {
    targetType = null,
    targetId = null,
    details = null,
    req = null
  } = options;

  try {
    const { error } = await admin.from('admin_activity').insert({
      admin_id: adminUser?.id || null,
      admin_username: cleanText(adminUser?.username, 40) || 'system',
      action: cleanText(action, 80) || 'unknown',
      target_type: targetType ? cleanText(targetType, 40) : null,
      target_id: targetId !== null && targetId !== undefined ? String(targetId).slice(0, 80) : null,
      details: details || null,
      ip: req ? normalizeIp(req.ip || req.headers?.['x-forwarded-for']) || null : null,
      user_agent: req ? String(req.get?.('user-agent') || '').slice(0, 500) || null : null,
      request_id: req?.id ? String(req.id).slice(0, 80) : null
    });
    if (error) {
      console.warn('[audit] write failed:', error.message);
      return null;
    }
    return true;
  } catch (error) {
    // Audit failures must never hide the outcome of the action itself, but
    // they are surfaced in server logs for operators.
    console.warn('[audit] write failed:', error.message);
    return null;
  }
}

const AUDIT_COLUMNS =
  'id, admin_id, admin_username, action, target_type, target_id, details, sequence, prev_hash, entry_hash, ip, request_id, created_at';

async function list({
  page = 1,
  limit = 50,
  q = '',
  action = '',
  adminId = null,
  start = null,
  end = null,
  sealed = 'all'
} = {}) {
  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const current = Math.min(Math.max(Number(page) || 1, 1), 10000);
  const search = cleanText(q, 80).replace(/[(),%*]/g, '').trim();

  let query = admin.from('admin_activity').select(AUDIT_COLUMNS, { count: 'exact' });
  if (action) query = query.eq('action', cleanText(action, 80));
  if (adminId) query = query.eq('admin_id', Number(adminId));
  if (start) query = query.gte('created_at', start);
  if (end) query = query.lte('created_at', end);
  if (sealed === 'sealed') query = query.not('entry_hash', 'is', null);
  if (sealed === 'legacy') query = query.is('entry_hash', null);
  if (search) {
    query = query.or(
      `admin_username.ilike.%${search}%,action.ilike.%${search}%,target_type.ilike.%${search}%,target_id.ilike.%${search}%,request_id.ilike.%${search}%`
    );
  }

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range((current - 1) * size, current * size - 1);

  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load the audit trail');

  return {
    activities: data || [],
    total: count || 0,
    page: current,
    limit: size,
    hasMore: current * size < (count || 0)
  };
}

async function verify() {
  try {
    const result = await admin.rpc('verify_admin_audit_chain');
    if (result.error) throw result.error;
    return {
      ...(result.data || { valid: false, checked: 0 }),
      verifiedAt: new Date().toISOString()
    };
  } catch (error) {
    throw new ApiError(502, 'AUDIT_VERIFY_FAILED', 'Could not verify the audit chain');
  }
}

async function recent(limit = 8) {
  return many(
    admin
      .from('admin_activity')
      .select(AUDIT_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(Number(limit) || 8, 1), 50)),
    'Could not load recent activity'
  );
}

async function actions() {
  const rows = await many(
    admin
      .from('admin_activity')
      .select('action')
      .order('created_at', { ascending: false })
      .limit(1000),
    'Could not load audit actions'
  );
  return [...new Set(rows.map((row) => row.action))].filter(Boolean).slice(0, 100);
}

module.exports = { record, list, verify, recent, actions };
