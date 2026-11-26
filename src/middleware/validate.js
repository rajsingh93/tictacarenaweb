'use strict';

const { ApiError } = require('../utils/ApiError');

function validate(schema, source = 'body') {
  return function validationMiddleware(req, res, next) {
    const result = schema.safeParse(req[source] ?? {});
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || source,
        message: issue.message
      }));
      return next(ApiError.badRequest('VALIDATION_ERROR', 'Please check the submitted information', details));
    }
    req[source] = result.data;
    next();
  };
}

/**
 * Rejects non-numeric identifiers before they reach a service, so a route like
 * /admin/users/abc can never be used to probe the database layer.
 */
function numericParam(name = 'id') {
  return function numericParamMiddleware(req, res, next) {
    const value = Number(req.params[name]);
    if (!Number.isInteger(value) || value <= 0) {
      return next(ApiError.badRequest('INVALID_ID', 'Invalid identifier'));
    }
    req.params[name] = value;
    next();
  };
}

module.exports = { validate, numericParam };
