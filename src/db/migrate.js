// src/db/migrate.js — versioned schema migrations.
//
// One numbered .sql file per change, applied in order, each inside a
// transaction, each recorded in schema_version. The alternative — one big
// `create table if not exists` blob — cannot express a change to an existing
// column, cannot be reviewed as a diff, and gives a reader no way to see how
// the schema arrived at its current shape.
//
// Two properties this guarantees and the blob did not:
//   1. A migration either applies completely or not at all.
//   2. Two servers booting at once cannot both apply migration N, because the
//      advisory lock serialises them.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const log = require('../logger');
const pool = require('./pool');

const DIR = path.join(__dirname, 'migrations');

// Any constant works as long as every instance uses the same one. This is
// "chatfat" as a 64-bit integer, chosen so it cannot collide with an advisory
// lock some other application takes on the same database.
const LOCK_ID = 4207661011355998n;

const VERSION_TABLE = `
create table if not exists schema_version (
  version     integer primary key,
  name        text not null,
  checksum    text not null,
  applied_at  timestamptz not null default now()
)`;

// 001_init.sql -> { version: 1, name: '001_init', sql, checksum }
function load() {
  let files;
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const out = files.map((file) => {
    const m = /^(\d+)[_-](.+)\.sql$/.exec(file);
    if (!m) throw new Error(`migration "${file}" must be named <number>_<name>.sql`);
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    return {
      version: Number(m[1]),
      name: path.basename(file, '.sql'),
      sql,
      checksum: crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16),
    };
  });

  out.sort((a, b) => a.version - b.version);

  // A duplicate number means two people numbered a migration the same way on
  // two branches. Applying them in filesystem order would give two databases
  // different schemas from the same commit.
  for (let i = 1; i < out.length; i++) {
    if (out[i].version === out[i - 1].version) {
      throw new Error(`two migrations share version ${out[i].version}: ${out[i - 1].name}, ${out[i].name}`);
    }
  }
  return out;
}

async function applied(client) {
  const res = await client.query('select version, name, checksum from schema_version order by version');
  return new Map(res.rows.map((r) => [r.version, r]));
}

// The whole set runs inside ONE transaction, holding ONE transaction-scoped
// advisory lock.
//
// The obvious implementation — pg_advisory_lock at the start, pg_advisory_unlock
// in a finally — is wrong here, in a way that only shows up in production. Two
// reasons, either of which is fatal:
//
//   1. A session-level advisory lock outlives a crashed client. The lock is
//      released when the SESSION ends, and a process killed with SIGKILL leaves
//      its session alive on the server until a TCP timeout notices. Every
//      subsequent boot then blocks forever on a lock nobody holds. This is not
//      hypothetical — it wedged this project's own test suite.
//   2. Neon's POOLED endpoint is PgBouncer in transaction pooling mode, where a
//      client does not keep the same backend between statements. A session lock
//      taken on one backend and unlocked on another is not a lock at all.
//
// pg_advisory_xact_lock fixes both: the server releases it at commit or
// rollback, whatever happens to the client, and it is safe under transaction
// pooling because it lives and dies inside a single transaction.
async function run() {
  const migrations = load();
  const client = await pool.getPool().connect();

  try {
    await client.query('begin');
    // A lock that cannot be acquired must fail loudly rather than hang a boot
    // for ever. Ten seconds is far longer than any honest contender needs.
    await client.query("set local lock_timeout = '10s'");
    await client.query('select pg_advisory_xact_lock($1)', [String(LOCK_ID)]);
    await client.query(VERSION_TABLE);

    const done = await applied(client);
    let ran = 0;

    for (const m of migrations) {
      const already = done.get(m.version);
      if (already) {
        // An edited migration that has already run is a silent schema drift
        // bug: this database and a fresh one now disagree. Refuse rather than
        // pretend.
        if (already.checksum !== m.checksum) {
          throw new Error(
            `migration ${m.name} was modified after it was applied ` +
              `(recorded ${already.checksum}, now ${m.checksum}). ` +
              `Write a new migration instead of editing an applied one.`,
          );
        }
        continue;
      }

      try {
        await client.query(m.sql);
        await client.query('insert into schema_version (version, name, checksum) values ($1,$2,$3)', [
          m.version,
          m.name,
          m.checksum,
        ]);
      } catch (err) {
        throw new Error(`migration ${m.name} failed: ${err.message}`);
      }

      log.info(`migration applied — ${m.name}`);
      ran++;
    }

    await client.query('commit');

    const head = migrations.length ? migrations[migrations.length - 1].version : 0;
    log.info(ran ? `schema at version ${head} (${ran} applied)` : `schema already at version ${head}`);
    return { head, ran };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    if (err.code === '55P03' || /lock_timeout|canceling statement/i.test(err.message)) {
      throw new Error(
        'could not take the migration lock within 10s — another server may be migrating, ' +
          'or a previous one died mid-migration. Retry; if it persists, check pg_locks.',
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { run, load };
