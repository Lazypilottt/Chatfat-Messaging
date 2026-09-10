// server.js — entry point: load the app, install signal handlers, start.
// Everything interesting lives in src/app.js; this file exists so `node server.js`
// is the whole story and the process-level concerns sit in one visible place.
'use strict';

const app = require('./src/app');
const log = require('./src/logger');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => app.shutdown(sig));
}

// Logged, not fatal. A chat server that dies on one bad frame is worse than one
// that keeps relaying for everybody else.
process.on('uncaughtException', (err) => log.error('uncaught exception', err));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));

app.start().catch((err) => {
  log.error('failed to start', err);
  process.exit(1);
});
