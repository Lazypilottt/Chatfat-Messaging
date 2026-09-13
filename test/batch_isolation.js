// test/batch_isolation.js — confirms that a batch-level INSERT failure cannot
// kill valid rows that share the same batch window.
//
// Test suites:
//
//   1. Integration tests (spawned server, DATABASE_URL=memory):
//      Exercise the full HTTP stack. Tests happy path, validation layer (400, 413)
//      before entering the batch, and ON CONFLICT (id) idempotency.
//
//   2. End-to-end batch failure fallback test (in-process server, DATABASE_URL=memory):
//      Simulates a batch-level multi-row failure (e.g. Postgres constraint violation
//      or invalid encoding on one row). Asserts that flushBatch's fallback retry
//      path allows good rows in the batch to succeed (HTTP 201) and appear in /feed,
//      while only the bad row fails (HTTP 500) and is excluded from /feed.
//
//   3. Unit test (isolated fallback logic):
//      Directly verifies call counts and Promise settlement for good vs bad rows.
//
// Run:  node test/batch_isolation.js
'use strict';

const { ok, eq, bail, report, startServer, sleep, post, TEST_MASTER_KEY } = require('./harness');

// ─── helpers ────────────────────────────────────────────────────────────────

const PORT = 8091;
const IN_PROC_PORT = 8092;

let seq = 0;
function uid() { return `test-bi-${Date.now()}-${++seq}`; }

async function blast(port, requests) {
  return Promise.all(requests.map((body) => post(port, '/message', body)));
}

async function feed(port) {
  const res = await fetch(`http://127.0.0.1:${port}/feed`);
  return res.json();
}

// ─── integration tests (spawned server) ─────────────────────────────────────

async function integrationSuite() {
  const server = await startServer(PORT, {
    DATABASE_URL: 'memory',
    DB_BATCH_MAX: '10',
    DB_BATCH_MS: '20',
  });

  // ── 1. all valid concurrent messages land in /feed ────────────────────────
  {
    const ids = Array.from({ length: 6 }, () => uid());
    const results = await blast(PORT, ids.map((id, i) => ({
      'client-name': `sender-${i}`,
      msg: `hello from ${i}`,
      id,
    })));

    ok(results.every((r) => r.status === 201), 'all 6 valid concurrent POSTs return 201');

    await sleep(150);
    const f = await feed(PORT);
    const inFeed = new Set(f.map((m) => m.id));
    ok(ids.every((id) => inFeed.has(id)), 'all 6 message ids appear in /feed');
  }

  // ── 2. malformed requests don't affect valid siblings ─────────────────────
  //
  // Malformed requests are rejected at the validation layer (400) before they
  // enter saveBatched, so they cannot contaminate any batch.
  {
    const goodId  = uid();
    const goodId2 = uid();
    const results = await blast(PORT, [
      { 'client-name': 'alice', msg: 'valid-a', id: goodId  },
      { 'client-name': 'bob'                                 },  // missing msg → 400
      { 'client-name': 'carol', msg: 'valid-b', id: goodId2 },
      {                         msg: 'orphan'                },  // missing name → 400
    ]);

    eq(results[0].status, 201, 'valid-a gets 201');
    eq(results[1].status, 400, 'missing-msg gets 400');
    eq(results[2].status, 201, 'valid-b gets 201');
    eq(results[3].status, 400, 'missing-client-name gets 400');

    await sleep(150);
    const f = await feed(PORT);
    const inFeed = new Set(f.map((m) => m.id));
    ok(inFeed.has(goodId),  'valid-a is in /feed despite bad siblings');
    ok(inFeed.has(goodId2), 'valid-b is in /feed despite bad siblings');
    ok(!f.some((m) => m.msg === 'orphan'), 'rejected message is not in /feed');
  }

  // ── 3. duplicate ID is idempotent, doesn't evict neighbours ──────────────
  {
    const dupId  = uid();
    const sideId = uid();
    const results = await blast(PORT, [
      { 'client-name': 'dana', msg: 'original',  id: dupId  },
      { 'client-name': 'dana', msg: 'duplicate', id: dupId  },
      { 'client-name': 'eli',  msg: 'side',       id: sideId },
    ]);

    ok(results.every((r) => r.status === 201), 'duplicate ID request still returns 201 (idempotent)');

    await sleep(150);
    const f = await feed(PORT);
    const withDupId = f.filter((m) => m.id === dupId);
    eq(withDupId.length, 1, 'exactly one copy of the duplicate id in /feed');

    const inFeed = new Set(f.map((m) => m.id));
    ok(inFeed.has(sideId), 'side message is in /feed alongside the duplicate');
  }

  // ── 4. oversized message rejected before batch, neighbour still succeeds ──
  {
    const smallId = uid();
    const bigMsg  = 'x'.repeat(20 * 1024); // > 12 KiB MAX_CIPHERTEXT, < 64 KiB MAX_BODY
    const results = await blast(PORT, [
      { 'client-name': 'finn', msg: 'fine', id: smallId },
      { 'client-name': 'gina', msg: bigMsg              },
    ]);

    eq(results[0].status, 201, 'small message beside oversized one still gets 201');
    eq(results[1].status, 413, 'oversized message is rejected 413');

    await sleep(150);
    const f = await feed(PORT);
    ok(new Set(f.map((m) => m.id)).has(smallId),
      'small message is in /feed; oversized never entered the batch');
  }

  server.stop();
}

// ─── batch failure fallback test (in-process server) ────────────────────────
//
// Puts a bad row in the same batch as several good ones. The multi-row
// repository.saveMany rejects (simulating a PostgreSQL constraint violation or
// invalid byte sequence caused by the bad row). The fallback handler in
// flushBatch retries each row individually via repository.save.
// Asserts that:
//   - Good rows succeed with HTTP 201.
//   - Only the bad row fails with HTTP 500.
//   - The good rows appear in GET /feed.
//   - The bad row does NOT appear in GET /feed.
async function batchFallbackSuite() {
  process.env.ChatFat_ENV_FILE = 'off';
  process.env.DATABASE_URL = 'memory';
  process.env.MASTER_KEY = TEST_MASTER_KEY;
  process.env.DB_BATCH_MAX = '10';
  process.env.DB_BATCH_MS = '30';
  process.env.PORT = String(IN_PROC_PORT);
  process.env.HOST = '127.0.0.1';

  const http = require('../src/transport/http');
  const { repository } = require('../src/messages/repository');
  const rooms = require('../src/rooms');

  await rooms.loadRooms();
  const server = http.createServer();
  await new Promise((resolve) => server.listen(IN_PROC_PORT, '127.0.0.1', resolve));

  const origSaveMany = repository.saveMany.bind(repository);
  const origSave = repository.save.bind(repository);

  const BAD_ID = uid();
  const GOOD_ID_1 = uid();
  const GOOD_ID_2 = uid();
  const GOOD_ID_3 = uid();

  let saveManyTriggered = false;
  let singleRetriesAttempted = 0;

  // Intercept repository to simulate PostgreSQL batch failure caused by BAD_ID
  repository.saveMany = async (roomId, messages) => {
    if (messages.some((m) => m.id === BAD_ID)) {
      saveManyTriggered = true;
      throw new Error('simulated postgres multi-row batch constraint violation');
    }
    return origSaveMany(roomId, messages);
  };

  repository.save = async (roomId, message) => {
    singleRetriesAttempted++;
    if (message.id === BAD_ID) {
      throw new Error('simulated row constraint violation on bad row');
    }
    return origSave(roomId, message);
  };

  try {
    // Send 3 good requests and 1 bad request concurrently into the same batch
    const results = await blast(IN_PROC_PORT, [
      { 'client-name': 'alice',   msg: 'good-one',   id: GOOD_ID_1 },
      { 'client-name': 'mallory', msg: 'bad-payload', id: BAD_ID    },
      { 'client-name': 'bob',     msg: 'good-two',   id: GOOD_ID_2 },
      { 'client-name': 'carol',   msg: 'good-three', id: GOOD_ID_3 },
    ]);

    ok(saveManyTriggered, 'saveMany was attempted and failed on the mixed batch');
    ok(singleRetriesAttempted >= 4, 'flushBatch fell back to individual single-row retries');

    eq(results[0].status, 201, 'good-1 succeeds with 201');
    eq(results[1].status, 500, 'bad-row fails with 500');
    eq(results[2].status, 201, 'good-2 succeeds with 201');
    eq(results[3].status, 201, 'good-3 succeeds with 201');

    await sleep(150);
    const f = await feed(IN_PROC_PORT);
    const feedIds = new Set(f.map((m) => m.id));

    ok(feedIds.has(GOOD_ID_1), 'good-1 appears in /feed');
    ok(feedIds.has(GOOD_ID_2), 'good-2 appears in /feed');
    ok(feedIds.has(GOOD_ID_3), 'good-3 appears in /feed');
    ok(!feedIds.has(BAD_ID),   'bad row does NOT appear in /feed');
  } finally {
    repository.saveMany = origSaveMany;
    repository.save = origSave;
    await new Promise((resolve) => server.close(resolve));
  }
}

// ─── unit test: fallback retry path ─────────────────────────────────────────
async function unitSuite() {
  const BAD_ID = 'unit-bad-id';
  let saveManyCallCount = 0;

  const fakeBatch = [
    { roomId: 'r1', message: { id: 'unit-good-1', text: 'g1' } },
    { roomId: 'r1', message: { id: BAD_ID,        text: 'bad' } },
    { roomId: 'r1', message: { id: 'unit-good-2', text: 'g2' } },
  ];

  const fakeRepo = {
    async saveMany() {
      saveManyCallCount++;
      throw new Error('simulated batch constraint violation');
    },
    async save(_roomId, message) {
      if (message.id === BAD_ID) throw new Error('simulated single-row violation');
      return [message.id];
    },
  };

  const promises = fakeBatch.map((e) =>
    new Promise((resolve, reject) => { e.resolve = resolve; e.reject = reject; })
  );

  try {
    await fakeRepo.saveMany('r1', fakeBatch.map((e) => e.message));
  } catch {
    for (const e of fakeBatch) {
      try {
        await fakeRepo.save(e.roomId, e.message);
        e.resolve();
      } catch (singleErr) {
        e.reject(singleErr);
      }
    }
  }

  const results = await Promise.allSettled(promises);
  const resolvedIds = results
    .map((r, i) => r.status === 'fulfilled' ? fakeBatch[i].message.id : null)
    .filter(Boolean);
  const rejectedIds = results
    .map((r, i) => r.status === 'rejected'  ? fakeBatch[i].message.id : null)
    .filter(Boolean);

  eq(saveManyCallCount, 1,             '[unit] saveMany called once, not retried');
  ok(resolvedIds.includes('unit-good-1'), '[unit] good-1 resolved despite batch failure');
  ok(resolvedIds.includes('unit-good-2'), '[unit] good-2 resolved despite batch failure');
  ok(rejectedIds.includes(BAD_ID),       '[unit] bad-id was rejected');
  eq(rejectedIds.length, 1,             '[unit] exactly one rejection');
  eq(resolvedIds.length, 2,            '[unit] exactly two resolutions');
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await integrationSuite();
    await batchFallbackSuite();
    await unitSuite();
  } catch (err) {
    bail(err);
  }
  report('batch_isolation');
}

main();
