'use strict';

const MAX_ROUTES = 200;
const MAX_CLIENT_REPORTS = 50;

const routes = new Map(); // normalized route -> { count, errors, totalMs, maxMs, slow }
const db = { count: 0, totalMs: 0, maxMs: 0, slow: 0 };
const clientReports = [];

function normalizePath(path) {
  return String(path || '/')
    .split('?')[0]
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .slice(0, 120);
}

function recordRequest(method, path, status, durationMs) {
  const key = `${method} ${normalizePath(path)}`;
  let entry = routes.get(key);
  if (!entry) {
    if (routes.size >= MAX_ROUTES) {
      // Evict the oldest tracked route (Map preserves insertion order).
      const oldest = routes.keys().next().value;
      if (oldest !== undefined) routes.delete(oldest);
    }
    entry = { count: 0, errors: 0, totalMs: 0, maxMs: 0, slow: 0 };
    routes.set(key, entry);
  }
  entry.count += 1;
  entry.totalMs += durationMs;
  if (durationMs > entry.maxMs) entry.maxMs = durationMs;
  if (status >= 400) entry.errors += 1;
  if (durationMs >= 1000) entry.slow += 1;
}

function recordDb(label, durationMs) {
  db.count += 1;
  db.totalMs += durationMs;
  if (durationMs > db.maxMs) db.maxMs = durationMs;
  if (durationMs >= 250) db.slow += 1;
  // Keep label only for slow queries to avoid retaining high-cardinality data.
  if (durationMs >= 250) {
    // bounded: store last 20 slow query labels
    if (!db.slowQueries) db.slowQueries = [];
    if (db.slowQueries.length >= 20) db.slowQueries.shift();
    db.slowQueries.push({ label: String(label || '').slice(0, 80), ms: Math.round(durationMs), at: new Date().toISOString() });
  }
}

function recordClientReport(report) {
  if (!report || typeof report !== 'object') return;
  if (clientReports.length >= MAX_CLIENT_REPORTS) clientReports.shift();
  clientReports.push({
    at: new Date().toISOString(),
    url: String(report.url || '').slice(0, 200),
    metrics: report.metrics || {},
    errors: Array.isArray(report.errors) ? report.errors.slice(0, 10) : [],
    failedRequests: Array.isArray(report.failedRequests) ? report.failedRequests.slice(0, 10) : []
  });
}

function topRoutes(limit = 15) {
  return [...routes.entries()]
    .map(([route, v]) => ({
      route,
      count: v.count,
      errors: v.errors,
      avgMs: v.count ? Math.round(v.totalMs / v.count) : 0,
      maxMs: Math.round(v.maxMs),
      slow: v.slow
    }))
    .sort((a, b) => b.avgMs * b.count - a.avgMs * a.count)
    .slice(0, limit);
}

function snapshot() {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      rssMB: +(mem.rss / 1048576).toFixed(1),
      heapUsedMB: +(mem.heapUsed / 1048576).toFixed(1),
      heapTotalMB: +(mem.heapTotal / 1048576).toFixed(1),
      externalMB: +(mem.external / 1048576).toFixed(1)
    },
    cpu: {
      userMs: Math.round(cpu.user / 1000),
      systemMs: Math.round(cpu.system / 1000)
    },
    db: {
      count: db.count,
      avgMs: db.count ? Math.round(db.totalMs / db.count) : 0,
      maxMs: Math.round(db.maxMs),
      slow: db.slow,
      slowQueries: db.slowQueries || []
    },
    routes: topRoutes(),
    clientReports
  };
}

module.exports = { recordRequest, recordDb, recordClientReport, snapshot };