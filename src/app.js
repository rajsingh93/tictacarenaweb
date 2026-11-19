'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
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

const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function websocketOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
  } catch (_) {
    return null;
  }
}

/**
 * Content Security Policy. The existing UI still relies on inline <script>
 * blocks and inline event handlers, so 'unsafe-inline' cannot be removed yet;
 * the policy still blocks injected external scripts, plugins, base-tag
 * rewriting and framing, which is the defence-in-depth layer for the XSS
 * escaping done in the client.
 */
function contentSecurityPolicy() {
  const connectSrc = new Set(["'self'"]);
  const scriptSrc = new Set(["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net']);
  if (env.isProduction) {
    // The UI may be hosted separately from the API (for example Netlify +
    // Render), so the configured API origin must remain loadable.
    [env.siteUrl, ...env.corsOrigins].forEach((origin) => {
      if (!origin) return;
      connectSrc.add(origin);
      scriptSrc.add(origin);
      const ws = websocketOrigin(origin);
      if (ws) connectSrc.add(ws);
    });
  } else {
    // Local development: the UI may be served from a separate static port and
    // the socket client connects to a loopback API, so allow both schemes.
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
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      fontSrc: ["'self'", 'data:'],
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

/**
 * CSRF defence for cookie-authenticated mutations: a browser always attaches
 * an Origin (or Referer) header, so a write from an origin this API does not
 * trust is rejected even when the session cookie was sent along. Requests
 * without either header are native/server-to-server clients, which do not
 * carry the victim's cookies and authenticate with their own credentials.
 */
function guardStateChangingRequests(req, res, next) {
  if (!WRITE_METHODS.has(req.method)) return next();
  const origin = requestOrigin(req);
  if (!origin) return next();
  if (originAllowed(origin)) return next();
  return next(ApiError.forbidden('ORIGIN_NOT_ALLOWED', 'This request came from an untrusted origin'));
}

function createApp() {
  const app = express();

  // Render (and any reverse proxy) terminates TLS before the app sees it.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: contentSecurityPolicy(),
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' }
    })
  );

  app.use((req, res, next) => {
    req.id = req.get('x-request-id') || crypto.randomBytes(6).toString('hex');
    res.set('X-Request-Id', req.id);
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
    res.status(payload.ok ? 200 : 503).json(payload);
  });

  // Public maintenance status (kept for the existing client contract).
  app.get('/api/maintenance', async (req, res, next) => {
    try {
      const { data } = await admin
        .from('app_settings')
        .select('value')
        .eq('key', 'maintenance')
        .maybeSingle();
      res.json({
        maintenance: Boolean(data?.value?.enabled),
        message: data?.value?.message || '',
        ends_at: data?.value?.ends_at || null
      });
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
    // Same-origin development fallback. The production frontend is served by
    // Netlify and must not be reachable through the API host.
    app.use(
      express.static(FRONTEND_DIR, {
        extensions: ['html'],
        index: 'index.html',
        maxAge: env.isProduction ? '1h' : 0,
        setHeaders(res, filePath) {
          // During local development always revalidate HTML and scripts so a
          // fixed client (invite redirect, UI) is picked up on the next load.
          if (!env.isProduction && /\.(?:html|js)$/i.test(filePath)) {
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
      if (!file.startsWith(FRONTEND_DIR)) return res.status(400).send('Bad request');
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
