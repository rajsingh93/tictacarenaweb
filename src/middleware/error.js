'use strict';

const { ApiError } = require('../utils/ApiError');
const env = require('../config/env');

function notFound(req, res, next) {
  // This handler is mounted under /api, so Express has already removed the
  // mount prefix from req.path. Check the original URL (and baseUrl) instead
  // of falling through to the static-site 404 page.
  const url = req.originalUrl || req.url || '';
  if (req.baseUrl?.startsWith('/api') || url.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' });
  }
  return next();
}

// eslint-disable-next-line no-unused-vars
function recordError(error, req, status, code) {
  // Fire-and-forget: logging must never delay or replace the API response.
  try {
    const { admin } = require('../config/supabase');
    admin
      .from('error_logs')
      .insert({
        level: status >= 500 ? 'error' : 'warn',
        message: String(error?.message || 'Unhandled error').slice(0, 1000),
        stack: error?.stack ? String(error.stack).slice(0, 6000) : null,
        code: String(code || '').slice(0, 80) || null,
        method: String(req.method || '').slice(0, 10),
        route: String(req.originalUrl || req.url || '').split('?')[0].slice(0, 300),
        status,
        request_id: req.id ? String(req.id).slice(0, 80) : null,
        user_id: req.user?.id || null,
        ip: String(req.ip || '').slice(0, 60) || null,
        context: error?.details && typeof error.details === 'object' ? error.details : null
      })
      .then(() => {})
      .catch(() => {});
  } catch (_) {
    /* the log table may not exist during initial setup */
  }
}

// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, next) {
  if (res.headersSent) return;

  let status = error.status || error.statusCode || 500;
  let code = error.code || 'INTERNAL_ERROR';
  let message = error.message || 'Something went wrong';
  let details = error.details;

  // Common PostgREST / PostgreSQL errors.
  if (error.code === '23505' || /duplicate key/i.test(message)) {
    status = 409;
    code = 'ALREADY_EXISTS';
    message = 'That information is already in use';
  } else if (error.code === '23503' || /foreign key/i.test(message)) {
    status = 400;
    code = 'INVALID_REFERENCE';
    message = 'That item is no longer available';
  } else if (error.code === 'PGRST116') {
    status = 404;
    code = 'NOT_FOUND';
    message = 'Resource not found';
  } else if (error.name === 'MulterError') {
    status = 400;
    code = 'UPLOAD_ERROR';
    message = error.code === 'LIMIT_FILE_SIZE' ? 'Image is too large (max 5 MB)' : 'Upload failed';
  } else if (error.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request is too large';
  } else if (error instanceof SyntaxError && 'body' in error) {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Invalid JSON body';
  }

  if (status >= 500) {
    console.error(`[${req.method} ${req.originalUrl}]`, error);
    recordError(error, req, status, code);
    if (env.isProduction && !(error instanceof ApiError)) {
      message = 'Something went wrong on our side';
      details = undefined;
    }
  }

  res.status(status).json({ error: message, code, ...(details ? { details } : {}) });
}

module.exports = { notFound, errorHandler };
