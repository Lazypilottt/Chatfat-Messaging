// test/postgres.js — the suite that needs a real database.
//
// Everything else runs offline against `memory`, deliberately: a suite that
// needs network is a suite that stops being run. This one is the exception,
// because two things cannot be proved without durable storage —
//
//   1. that messages survive a server restart, which is Lab 4 requirement 1
//      and the direct answer to slide 2's "what happens if the server
//      restarts?"
//   2. that the migration runner is idempotent across boots.
//
// Set TEST_DATABASE_URL to run it. Skipped, loudly, when it is absent.
//
//   docker compose up -d db
//   TEST_DATABASE_URL=postgresql://chatfat:chatfat@localhost:5432/chatfat npm run test:pg
//
// In CI, point it at a Neon branch created for the run.
'use strict';

const { ok, eq, bail, report, startServer, client, sleep, post } = require('./harness');

const PORT = 8087;
const PORT2 = 8088;
const PORT3 = 8089;
const URL = process.env.TEST_DATABASE_URL;

// Registers through Better Auth, keeps the session cookie, and dials the
// socket with it — the upgrade is what authenticates now, not the join frame.
async function signedIn(port, name, password) {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ email: `${name}@example.test`, password, name }),
  });
  if (!res.ok) throw new Error(`sign-up for ${name} failed: ${res.status} ${await res.text()}`);
  const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')])
    .filter(Boolean).map((c) => c.split(';')[0]).join('; ');

  const c = await client(port, { headers: { cookie } });
  await c.next('hello');
  c.send('join', {});
  await c.next('welcome');
  return c;
}

// A one-shot raw query against the real database, bypassing the app entirely
// — used both to inspect what actually landed in a column (requirement 3) and
// to corrupt a row on purpose (requirement 4), the same way tools/tamper.js
// does for a real demo.
async function pgQuery(sql, params) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: URL });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end().catch(() => {});
  }
}

// Poll until `want` rows are visible in the room, or give up. Writes are
// detached from the request path, so the only honest way to know a message is
// stored is to look.
async function waitForRows(roomId, want, timeoutMs) {
  const { Client } = require('pg');
  const deadline = Date.now() + timeoutMs;
  let n = -1;
  for (;;) {
    const c = new Client({ connectionString: URL });
    await c.connect();
    try {
      const r = await c.query('select count(*)::int n from messages where room_id = $1', [roomId]);
      n = r.rows[0].n;
    } finally {
      await c.end().catch(() => {});
    }
    if (n >= want || Date.now() > deadline) return n;
    await sleep(300);
  }
}

// Every run starts from an empty schema, so a previous run's rows cannot make
// this one pass or fail for the wrong reason.
async function reset() {
  const { Client } = require('pg');
  const c = new Client({ connectionString: URL });
  await c.connect();
  await c.query(`
    drop table if exists messages cascade;
    drop table if exists rooms cascade;
    drop table if exists sessions cascade;
    drop table if exists users cascade;
    drop table if exists schema_version cascade;
  `);
  await c.end();
}

async function main() {
  if (!URL) {
    console.log('postgres: SKIPPED — set TEST_DATABASE_URL to run this suite');
    console.log('  docker compose up -d db');
    console.log('  TEST_DATABASE_URL=postgresql://chatfat:chatfat@localhost:5432/chatfat npm run test:pg');
    return;
  }

  await reset();

  // ── first boot: migrations apply from empty ──────────────────────────────
  const first = await startServer(PORT, {
    DATABASE_URL: URL,
    HISTORY_REPLAY: '50',
    AUTH_MAX_ATTEMPTS: '500',
  });

  ok(first.out().includes('migration applied — 001_init'), 'migrations apply on an empty database');

  const health = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
  eq(health.persistence, 'postgres', '/healthz reports postgres');

  const a = await signedIn(PORT, 'kavya', 'correct-horse');
  await a.create('durable');

  a.drain().send('chat', { text: 'written before the restart' });
  const before = (await a.next('chat')).d;
  await sleep(400); // the write is detached from the hot path

  a.close();
  await sleep(200);
  first.stop();
  await sleep(1200);

  // ── second boot: the messages are still there ────────────────────────────
  // This is the assertion the whole phase exists for.
  //
  // A DIFFERENT port on purpose. The harness kills with SIGKILL, and a socket
  // in TIME_WAIT then makes the rebind racy — which would show up as an
  // intermittent failure of the persistence claim, the one assertion that must
  // never be doubted. Durability is a property of the database, not of the
  // port, so nothing is weakened by moving it.
  const second = await startServer(PORT2, {
    DATABASE_URL: URL,
    HISTORY_REPLAY: '50',
    AUTH_MAX_ATTEMPTS: '500',
  });

  ok(!second.out().includes('migration applied'), 'a second boot applies no migrations');
  ok(second.out().includes('schema already at version'), 'and says the schema is already current');

  const b = await signedIn(PORT2, 'meera', 'correct-horse-2');
  const joined = await b.enter('durable');

  ok(Array.isArray(joined.d.history), 'history is replayed after a restart');
  const survivor = joined.d.history.find((m) => m.id === before.id);
  ok(survivor, 'the message written before the restart is still there');
  eq(survivor && survivor.text, 'written before the restart', 'with its text intact');
  eq(survivor && survivor.from, 'kavya', 'and its sender');

  // ── the room survived too ────────────────────────────────────────────────
  // Losing the directory while keeping the messages would orphan every row.
  eq(joined.d.room.id, 'durable', 'the room created before the restart still exists');

  // ── requirement 3: not stored as plaintext, against REAL postgres ────────
  const rawRow = await pgQuery('select text, text_kv from messages where id = $1', [before.id]);
  const { text: rawText, text_kv: rawKv } = rawRow.rows[0];
  ok(rawText !== 'written before the restart', 'the text column in Postgres is not the plaintext that was sent');
  ok(rawKv !== null, 'a MASTER_KEYS version is recorded for the row');

  // ── requirement 4: detects modification, against REAL postgres ───────────
  // A message of its own for this, deliberately NOT `before` — that one's
  // content is asserted on again later in this file (the pagination check at
  // the very end reaches back to "written before the restart"), and corrupting
  // it here would make THAT assertion fail for a reason having nothing to do
  // with pagination.
  b.drain().send('chat', { text: 'this row is about to be corrupted' });
  const toCorrupt = (await b.next('chat')).d;
  await sleep(400); // the write is detached from the hot path

  // Corrupt the stored ciphertext directly over SQL — no app code involved —
  // exactly what tools/tamper.js does for a manual demo.
  const victimRow = await pgQuery('select text from messages where id = $1', [toCorrupt.id]);
  const victimText = victimRow.rows[0].text;
  const corruptedText = victimText.slice(0, -4) + (victimText.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  await pgQuery('update messages set text = $1 where id = $2', [corruptedText, toCorrupt.id]);

  // Rejoining forces a fresh repository.recent() read, which is where
  // detection actually happens — see src/messages/repository.js.
  b.drain().send('room:leave', {});
  await b.next('room:left');
  const rejoined = await b.enter('durable');
  const flagged = rejoined.d.history.find((m) => m.id === toCorrupt.id);
  ok(flagged && flagged.tampered, 'rejoining after direct SQL corruption flags the row as tampered');
  eq(flagged && flagged.text, '', 'and its text is not served as if it were legitimate content');
  const stillFine = rejoined.d.history.find((m) => m.id === before.id);
  eq(stillFine && stillFine.text, 'written before the restart', "and the row that wasn't touched is unaffected");

  // ── keyset pagination against real SQL ───────────────────────────────────
  // The `(ts, id) < ($2, $3)` row comparison is Postgres-specific and the
  // memory repository proves nothing about it, so it gets its own pass here.
  b.drain();
  const TOTAL = 12;
  for (let i = 0; i < TOTAL; i++) {
    b.send('chat', { text: 'p' + i });
    await b.next('chat');
  }

  // Wait for DURABILITY, not for the echo. Writes are detached from the hot
  // path on purpose — a slow database must not delay the room — so a message
  // being broadcast says nothing about whether it has landed. A fixed sleep
  // here is a guess that fails the moment the database is further away than
  // the developer's laptop; against Neon in another region, twelve sequential
  // inserts comfortably outlast half a second, and the suite then "finds" a
  // pagination bug that does not exist.
  //
  // +2, not +1: `before` plus the `toCorrupt` message the tamper check above
  // added to this same room.
  const durable = await waitForRows('durable', TOTAL + 2, 20000);
  eq(durable, TOTAL + 2, 'every message reached the database before the read');

  b.close();
  await sleep(200);
  second.stop();
  await sleep(1200);

  // A third boot against the same database, this time replaying a short page,
  // so the paging loop is actually exercised rather than served everything at
  // once. It also demonstrates a second instance reading one Neon database.
  const third = await startServer(PORT3, {
    DATABASE_URL: URL,
    HISTORY_REPLAY: '5',
    HISTORY_PAGE: '5',
    AUTH_MAX_ATTEMPTS: '500',
  });

  const c = await signedIn(PORT3, 'aravind', 'correct-horse-3');
  const screen = await c.enter('durable');
  eq(screen.d.history.length, 5, 'the first screen is one page');

  const seen = screen.d.history.map((m) => m.text);
  let cursor = { ts: screen.d.history[0].ts, id: screen.d.history[0].id };
  let pages = 0;

  for (let guard = 0; guard < 8; guard++) {
    c.drain().send('history:more', { before: cursor, limit: 5 });
    const page = (await c.next('history:page')).d;
    pages++;
    seen.unshift(...page.messages.map((m) => m.text));
    if (page.done) break;
    cursor = { ts: page.messages[0].ts, id: page.messages[0].id };
  }

  const paged = seen.filter((t) => /^p\d+$/.test(t));
  eq(paged.length, TOTAL, 'keyset pagination returns every row exactly once on postgres');
  eq(new Set(paged).size, TOTAL, 'with no duplicate at any page boundary');
  eq(paged.join(','), Array.from({ length: TOTAL }, (_, i) => 'p' + i).join(','),
     'and the reassembled pages are in order');
  ok(pages >= 2, 'and it took more than one page to get there');
  ok(seen[0] === 'written before the restart', 'paging reaches the very first message in the room');

  c.close();
  await sleep(200);
  third.stop();

  report('postgres');
}

main().catch(bail);
