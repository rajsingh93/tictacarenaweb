'use strict';

const { admin } = require('../config/supabase');
const { ApiError, fromRpcError } = require('./ApiError');
const metrics = require('./metrics');

/**
 * Small wrapper around the Supabase service-role client so that every query
 * surfaces a clean 502 instead of leaking PostgREST internals to clients.
 */
function unwrap(result, message = 'Could not complete the request') {
  if (result.error) {
    throw new ApiError(502, 'DATABASE_ERROR', message);
  }
  return result.data;
}

async function one(query, message) {
  const started = process.hrtime.bigint();
  try {
    return unwrap(await query, message);
  } finally {
    metrics.recordDb(message || 'one', Number(process.hrtime.bigint() - started) / 1e6);
  }
}

async function many(query, message) {
  const started = process.hrtime.bigint();
  try {
    return unwrap(await query, message) || [];
  } finally {
    metrics.recordDb(message || 'many', Number(process.hrtime.bigint() - started) / 1e6);
  }
}

async function rpc(name, params, message) {
  const started = process.hrtime.bigint();
  try {
    const { data, error } = await admin.rpc(name, params);
    if (error) {
      const mapped = fromRpcError(error);
      if (mapped) throw mapped;
      throw new ApiError(502, 'DATABASE_ERROR', message || 'Could not complete the request');
    }
    return data;
  } finally {
    metrics.recordDb(name || 'rpc', Number(process.hrtime.bigint() - started) / 1e6);
  }
}

async function count(query, message) {
  const started = process.hrtime.bigint();
  try {
    const result = await query;
    if (result.error) throw new ApiError(502, 'DATABASE_ERROR', message || 'Could not count records');
    return result.count || 0;
  } finally {
    metrics.recordDb(message || 'count', Number(process.hrtime.bigint() - started) / 1e6);
  }
}

module.exports = { admin, unwrap, one, many, rpc, count };
