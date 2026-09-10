// src/app.js — the composition root: boot order, the banner, and shutdown.
'use strict';

const os = require('node:os');
const config = require('./config');
const log = require('./logger');
const pool = require('./db/pool');
const rooms = require('./rooms');
const history = require('./messages/history');
const { repository } = require('./messages/repository');
const http = require('./transport/http');
const websocket = require('./transport/websocket');

let server = null;
let throttleSweep = null;
let shuttingDown = false;

function addresses() {
  const scheme = config.TLS_CERT_FILE && config.TLS_KEY_FILE ? 'https' : 'http';
  const out = [['local', `${scheme}://localhost:${config.PORT}`]];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(['lan', `${scheme}://${iface.address}:${config.PORT}`]);
    }
  }
  return out;
}

function banner() {
  log.raw('');
  log.raw('  ChatFat');
  for (const [label, url] of addresses()) log.raw(`    ${label.padEnd(6)} ${url}`);
  log.raw('');

  const accounts = config.AUTH_ENABLED
    ? `required — ${config.USE_POSTGRES ? 'postgres' : 'memory'}`
    : 'disabled — set DATABASE_URL to turn accounts on';
  const messages = config.PERSISTENCE_ENABLED
    ? `stored in ${repository.kind} · joining a room ${
        config.HISTORY_REPLAY > 0 ? `replays ${config.HISTORY_REPLAY}` : 'replays nothing'
      }`
    : 'in memory only — nothing is stored or replayed';
  const encryption = config.ENCRYPTION_ENABLED
    ? 'rooms may be locked — keys never reach the server'
    : 'disabled — rooms cannot be locked on this server';

  log.raw(`    accounts    ${accounts}`);
  log.raw(`    messages    ${messages}`);
  log.raw(`    encryption  ${encryption}`);
  log.raw('');
}

// Requirement 1 is "messages are stored in a database". A server that starts
// with no store configured and silently discards every message is the exact
// failure the lab is about, so an unset DATABASE_URL is a startup error rather
// than a default. `none` remains available for the cases that genuinely want
// no persistence — it just has to be said out loud.
function requireStorageDecision() {
  if (config.DATABASE_URL_SET) return;
  log.error('DATABASE_URL is not set, so there is nowhere to store messages.');
  log.error('');
  log.error('  Durable  DATABASE_URL=postgresql://…   (Neon: copy the POOLED string)');
  log.error('  Ephemeral  DATABASE_URL=memory         works fully, lost on restart');
  log.error('  Deliberately off  DATABASE_URL=none    nothing is stored at all');
  log.error('');
  log.error('See .env.example. Refusing to start rather than drop every message silently.');
  process.exit(1);
}

// Requirement 3 is "messages are not stored as plaintext". Persistence with
// no key configured would be the exact same silent-failure shape as an unset
// DATABASE_URL used to be: a server that looks like it satisfies the
// requirement while writing plaintext the whole time. So this fails the boot
// the same way requireStorageDecision does, not a warning that scrolls past.
function requireMasterKey() {
  if (!config.PERSISTENCE_ENABLED) return; // nothing will be written, nothing to key
  if (config.MASTER_KEYS.size) return;
  log.error('DATABASE_URL is set, but no MASTER_KEY is configured — messages would be stored as plaintext.');
  log.error('');
  log.error('  Generate one:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  log.error('  Then set:      MASTER_KEY=<that value>');
  log.error('');
  log.error('See .env.example. Refusing to start rather than write unencrypted history.');
  process.exit(1);
}

// err.message alone is often unhelpful or even absent: node:net and pg throw
// an AggregateError when every resolved address (IPv4 and IPv6 both) fails,
// and its own .message is blank — the reason is in .errors[]. The Neon
// WebSocket driver can reject with something that isn't a plain Error at all
// (a raw ws error/close event), whose .message is an object, not a string —
// string-concatenating that prints the useless "[object Object]" rather than
// throwing, which is exactly the kind of silent dead end this function
// exists to avoid. util.inspect on the whole thing is the fallback of last
// resort: whatever shape the error has, SOMETHING legible comes out.
function describeError(err) {
  if (!err) return 'unknown error';
  const bits = [];
  if (typeof err.message === 'string' && err.message) bits.push(err.message);
  else if (typeof err.name === 'string' && err.name) bits.push(err.name);
  if (err.code) bits.push(`code=${err.code}`);
  if (Array.isArray(err.errors) && err.errors.length) {
    bits.push('— ' + err.errors.map((e) => `${(e && e.code) || ''} ${(e && e.message) || e}`.trim()).join('; '));
  }
  if (!bits.length) bits.push(require('node:util').inspect(err, { depth: 4, breakLength: 200 }));
  return bits.join(' ');
}

async function start() {
  requireStorageDecision();
  requireMasterKey();

  if (config.PERSISTENCE_ENABLED) {
    // All-or-nothing. A configured database that cannot be reached must never
    // degrade silently into an unauthenticated server.
    try {
      if (config.USE_POSTGRES) await pool.migrate();
      await repository.init();
    } catch (err) {
      log.error('DATABASE_URL is set but the store could not be prepared:', describeError(err));
      log.error('Refusing to start unauthenticated. Fix the database or unset DATABASE_URL.');
      process.exit(1);
    }
  }

  const count = await rooms.loadRooms();
  log.info(`room directory ready — ${count} room${count === 1 ? '' : 's'}`);

  server = http.createServer();
  websocket.attach(server);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`port ${config.PORT} is already in use. Try: PORT=${config.PORT + 1} npm start`);
      process.exit(1);
    }
    log.error('http server error', err);
  });

  await new Promise((resolve) => server.listen(config.PORT, config.HOST, resolve));

  websocket.startHeartbeat();
  throttleSweep = setInterval(http.sweepThrottle, config.AUTH_WINDOW_MS);
  if (throttleSweep.unref) throttleSweep.unref();

  banner();
  return server;
}

// Idempotent: two signals in quick succession must not run this twice.
function shutdown(signal = 'shutdown') {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} — closing down`);

  websocket.stopHeartbeat();
  if (throttleSweep) clearInterval(throttleSweep);
  history.clearAllTimers();
  rooms.directory.flushSync();

  // 1001 "server going away", so clients reconnect deliberately rather than
  // treating it as a crash.
  websocket.closeAll(1001, 'server going away');

  const finish = async () => {
    try {
      await repository.close();
      await pool.close();
    } catch (err) {
      log.warn('closing stores:', err.message);
    }
    if (server) server.close(() => process.exit(0));
    else process.exit(0);
  };
  finish();

  // A socket that refuses to close cannot hang the process.
  const backstop = setTimeout(() => process.exit(0), 1500);
  if (backstop.unref) backstop.unref();
}

module.exports = { start, shutdown, get server() { return server; } };
