'use strict';

const http = require('http');
const os = require('os');
const env = require('./config/env');
const { createApp } = require('./app');
const { createSocketServer } = require('./socket');
const { start: startEventLoopMonitor, stop: stopEventLoopMonitor } = require('./utils/eventLoop');
const adminSystem = require('./services/adminSystem.service');

let jobTimer = null;

const app = createApp();
const server = http.createServer(app);
const io = createSocketServer(server);

app.set('io', io);

// Listen on every interface so the site is reachable from a phone on the same
// Wi-Fi. Host firewalls still decide what the LAN can reach; the app itself
// does not restrict addresses.
const HOST = process.env.HOST || '0.0.0.0';

function lanAddresses() {
  const found = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

// Keep reverse-proxy keep-alive sockets alive long enough to be reused, but
// never longer than the proxy's idle timeout.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(env.port, HOST, () => {
  startEventLoopMonitor();

  // Scheduled jobs (retention, snapshots, campaign delivery) run in-process.
  // The claim in runDueJobs is atomic per row, so a retry never double-sends.
  jobTimer = setInterval(() => {
    adminSystem.runDueJobs().catch((error) => {
      console.warn('[jobs]', error.message);
    });
  }, 60_000);
  jobTimer.unref?.();
  setTimeout(() => {
    adminSystem.runDueJobs().catch(() => {});
  }, 8_000).unref?.();
  console.log(`TicTacArena running at ${env.siteUrl} (port ${env.port})`);
  console.log(`Listening on ${HOST}:${env.port}`);
  if (HOST === '0.0.0.0') {
    for (const address of lanAddresses()) {
      console.log(`  LAN: http://${address}:${env.port}`);
    }
  }
  console.log(`Environment: ${env.nodeEnv}`);
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} received, shutting down...`);

  const force = setTimeout(() => {
    console.error('[server] Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
  force.unref();

  stopEventLoopMonitor();
  if (jobTimer) clearInterval(jobTimer);
  io.close(() => {
    // Terminate keep-alive sockets so server.close() resolves promptly.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => {
      console.log('[server] Shutdown complete');
      process.exit(0);
    });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason?.stack || reason);
});

process.on('uncaughtException', (error) => {
  console.error('[server] Uncaught exception:', error);
  shutdown('uncaughtException');
});

module.exports = { app, server, io };
