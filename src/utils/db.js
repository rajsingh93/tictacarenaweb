'use strict';

const { admin } = require('../config/supabase');
const { ApiError, fromRpcError } = require('./ApiError');

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
  return unwrap(await query, message);
}

async function many(query, message) {
  return unwrap(await query, message) || [];
}

async function rpc(name, params, message) {
  const { data, error } = await admin.rpc(name, params);
  if (error) {
    const mapped = fromRpcError(error);
    if (mapped) throw mapped;
    throw new ApiError(502, 'DATABASE_ERROR', message || 'Could not complete the request');
  }
  return data;
}

async function count(query, message) {
  const result = await query;
  if (result.error) throw new ApiError(502, 'DATABASE_ERROR', message || 'Could not count records');
  return result.count || 0;
}

module.exports = { admin, unwrap, one, many, rpc, count };
