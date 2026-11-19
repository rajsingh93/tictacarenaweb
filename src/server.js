'use strict';

const http = require('http');
const os = require('os');
const env = require('./config/env');
const { createApp } = require('./app');
const { createSocketServer } = require('./socket');

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

server.listen(env.port, HOST, () => {
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

  io.close(() => {
    server.close(() => {
      console.log('[server] Shutdown complete');
      process.exit(0);
    });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[server] Uncaught exception:', error);
  shutdown('uncaughtException');
});

module.exports = { app, server, io };
