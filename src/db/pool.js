// src/db/pool.js — the single Postgres pool, plus schema migration.
//
// Two drivers, chosen by hostname, both required LAZILY: a checkout without
// either installed must still run in no-database and memory modes, because
// nothing on those paths ever reaches this line.
//
//   *.neon.tech  → @neondatabase/serverless, over a WebSocket on port 443.
//   anything else → plain `pg`, over raw TCP on port 5432 (docker-compose's
//                    local Postgres, or any other provider).
//
// The WebSocket path exists because 5432 is not always reachable — a campus
// or office network that only allows standard web ports out blocks it
// outright, silently (a timeout, not a rejection: see the README's note on
// diagnosing this). Neon's driver tunnels the real Postgres wire protocol —
// same transactions, same advisory locks, everything migrate.js needs —
// over 443 instead, which such a network almost always does allow. It only
// works against Neon itself: a vanilla Postgres has no WebSocket proxy to
// tunnel to, hence the hostname check rather than making this the only path.
'use strict';

const config = require('../config');
const log = require('../logger');

let pool = null;

function isNeonHost(url) {
  try {
    return /\.neon\.tech$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function getPool() {
  if (pool) return pool;
  if (!config.USE_POSTGRES) throw new Error('Postgres is not configured.');

  const opts = {
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
  };

  if (isNeonHost(config.DATABASE_URL)) {
    let neon;
    try {
      neon = require('@neondatabase/serverless');
    } catch {
      throw new Error(
        "DATABASE_URL points at Neon but '@neondatabase/serverless' is not installed. Run: npm install @neondatabase/serverless",
      );
    }
    // Node has no WebSocket global before v22 (and even on 22+, the driver's
    // own docs recommend setting this explicitly for session/transaction
    // support) — `ws` is already a hard dependency for the chat socket, so
    // no new install is needed to provide it here.
    neon.neonConfig.webSocketConstructor = require('ws');
    pool = new neon.Pool(opts);
  } else {
    let pg;
    try {
      pg = require('pg');
    } catch {
      throw new Error("DATABASE_URL points at Postgres but the 'pg' package is not installed. Run: npm install pg");
    }
    pool = new pg.Pool(opts);
  }

  // Mandatory. An unhandled error on an idle client is fatal to the process.
  pool.on('error', (err) => log.error('postgres idle client error', err.message));

  return pool;
}

// The schema lives in src/db/migrations/*.sql, applied by src/db/migrate.js.
// `migrate` is required lazily for the same reason `pg` is: nothing on the
// no-database or memory path may reach it.
async function migrate() {
  getPool(); // fail fast with the friendly message if pg is missing
  return require('./migrate').run();
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function close() {
  if (!pool) return;
  const p = pool;
  pool = null;
  try {
    await p.end();
  } catch (err) {
    log.warn('closing the pool:', err.message);
  }
}

module.exports = { getPool, migrate, query, close };
