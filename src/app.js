'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const env = require('./config/env');
const routes = require('./routes');
const { apiLimiter, writeLimiter } = require('./middleware/rateLimit');
const { notFound, errorHandler } = require('./middleware/error');
const { admin } = require('./config/supabase');
const { originAllowed } = require('./utils/origin');
const { ApiError } = require('./utils/ApiError');
const metrics = require('./utils/metrics');

const FRONTEND_BASE = path.join(__dirname, '..', '..', 'frontend');
const FRONTEND_DIST = path.join(__dirname, '..', '..', 'dist');
const FRONTEND_DIR = fs.existsSync(FRONTEND_DIST) ? FRONTEND_DIST : FRONTEND_BASE;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Cache duration for health and maintenance probes
const HEALTH_CACHE_MS = 3000;
const MAINTENANCE_CACHE_MS = 5000;
let healthCache = null;
let maintenanceCache = null;

function websocketOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
  } catch (_) {
    return null;
  }
}

// Content Security Policy
function contentSecurityPolicy() {
  const connectSrc = new Set(["'self'", 'https://www.google-analytics.com', 'https://region1.google-analytics.com']);
  const scriptSrc = new Set([
    "'self'",
    "'unsafe-inline'",
    'https://cdn.jsdelivr.net',
    'https://www.googletagmanager.com',
    'https://www.google-analytics.com',
  ]);
  if (env.isProduction) {
    [env.siteUrl, ...env.corsOrigins].forEach((origin) => {
      if (!origin) return;
      connectSrc.add(origin);
      scriptSrc.add(origin);
      const ws = websocketOrigin(origin);
      if (ws) connectSrc.add(ws);
    });
  } else {
    connectSrc.add('http:');
    connectSrc.add('https:');
    connectSrc.add('ws:');
    connectSrc.add('wss:');
    scriptSrc.add('http:');
    scriptSrc.add('https:');
  }

  return {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      scriptSrc: [...scriptSrc],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      mediaSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:'],
      connectSrc: [...connectSrc],
      ...(env.isProduction ? { upgradeInsecureRequests: [] } : {})
    }
  };
}

function requestOrigin(req) {
  const origin = req.get('origin');
  if (origin) return origin;
  const referer = req.get('referer');
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch (_) {
    return null;
  }
}

// CSRF check for mutations
function guardStateChangingRequests(req, res, next) {
  if (!WRITE_METHODS.has(req.method)) return next();
  const origin = requestOrigin(req);
  if (!origin) return next();
  if (originAllowed(origin)) return next();
  return next(ApiError.forbidden('ORIGIN_NOT_ALLOWED', 'This request came from an untrusted origin'));
}

function createApp() {
  const app = express();

  // Trust proxy for TLS termination
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // Weak ETags let unchanged responses return 304 without re-sending the body.
  app.set('etag', 'weak');
  app.set('json spaces', 0);
  app.use(compression());

  app.use(
    helmet({
      contentSecurityPolicy: contentSecurityPolicy(),
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' }
    })
  );

  app.use((req, res, next) => {
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    next();
  });
  app.use((req, res, next) => {
    req.id = req.get('x-request-id') || crypto.randomBytes(6).toString('hex');
    res.set('X-Request-Id', req.id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      metrics.recordRequest(req.method, req.originalUrl, res.statusCode, ms);
      if (ms >= 1000 || res.statusCode >= 500) {
        console.error(`[${req.method} ${req.originalUrl}] ${res.statusCode} ${ms.toFixed(0)}ms`);
      }
    });
    next();
  });

  app.use(
    cors({
      origin(origin, callback) {
        if (originAllowed(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 86400
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', async (req, res) => {
    if (healthCache && Date.now() - healthCache.at < HEALTH_CACHE_MS) {
      return res.status(healthCache.status).json(healthCache.payload);
    }
    const payload = {
      ok: true,
      service: 'tictacarena',
      environment: env.nodeEnv,
      time: new Date().toISOString()
    };
    try {
      const { error } = await admin.from('app_settings').select('key').limit(1);
      payload.database = error ? 'unreachable' : 'ok';
      payload.ok = !error;
      if (error) payload.database_error = 'DATABASE_UNAVAILABLE';
    } catch (error) {
      payload.database = 'unreachable';
      payload.ok = false;
    }
    const status = payload.ok ? 200 : 503;
    healthCache = { at: Date.now(), status, payload };
    res.status(status).json(payload);
  });

  app.get('/api/maintenance', async (req, res, next) => {
    if (maintenanceCache && Date.now() - maintenanceCache.at < MAINTENANCE_CACHE_MS) {
      return res.json(maintenanceCache.payload);
    }
    try {
      const { data } = await admin
        .from('app_settings')
        .select('value')
        .eq('key', 'maintenance')
        .maybeSingle();
      const payload = {
        maintenance: Boolean(data?.value?.enabled),
        message: data?.value?.message || '',
        ends_at: data?.value?.ends_at || null
      };
      maintenanceCache = { at: Date.now(), payload };
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', apiLimiter);
  app.use('/api', guardStateChangingRequests);
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    if (WRITE_METHODS.has(req.method)) return writeLimiter(req, res, next);
    next();
  });
  app.use('/api', routes);
  app.use('/api', notFound);

  if (env.serveFrontend) {
    // Static frontend serving fallback
    app.use(
      express.static(FRONTEND_DIR, {
        extensions: ['html'],
        index: 'index.html',
        maxAge: 0,
        immutable: false,
        setHeaders(res, filePath) {
          if (/\.html?$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (env.isProduction && /\.(?:js|mjs|css)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else if (/\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf)$/i.test(filePath)) {
            res.setHeader('Cache-Control', env.isProduction ? 'public, max-age=604800, immutable' : 'no-cache');
          } else {
            res.setHeader('Cache-Control', 'no-cache');
          }
        }
      })
    );

    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      if (path.extname(req.path) && !req.path.endsWith('.html')) {
        return res.status(404).send('Not found');
      }
      const requested = req.path === '/' ? 'index.html' : req.path.replace(/^\//, '');
      const file = path.join(FRONTEND_DIR, requested);
      // Prevent directory traversal
      const relative = path.relative(FRONTEND_DIR, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return res.status(400).send('Bad request');
      }
      res.setHeader('Cache-Control', 'no-cache');
      return res.sendFile(file, (error) => {
        if (error) {
          if (error.code === 'ENOENT') return res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
          return next(error);
        }
      });
    });
  } else {
    app.get('/', (req, res) => {
      res.json({ service: 'tictacarena', status: 'ok', docs: '/api/health' });
    });
  }

  app.use(errorHandler);

  return app;
}

module.exports = { createApp, FRONTEND_DIR };
