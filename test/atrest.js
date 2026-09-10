// test/atrest.js — requirement 3 ("messages are not stored as plaintext")
// and requirement 4 ("the system detects modification of a stored message").
//
// This suite deliberately departs from the "spawn a real server, drive it
// over a socket" pattern the rest of the suites use: what is actually sitting
// in a row, versus what the wire protocol hands back, is exactly the thing a
// WebSocket client can never observe from outside — that opacity is the
// entire point of requirement 3. test/crypto.js already breaks the same
// pattern for the same reason, capturing the server's stdout directly rather
// than going through a client. Here the equivalent is reaching into the
// repository module in-process, against MemoryRepo — which runs the exact
// same encrypt/decrypt path PgRepo does (see src/messages/repository.js),
// so this proves the mechanism without needing a database. test/postgres.js
// separately proves the same thing against real Postgres, for the case where
// "reaching into the repository" isn't available because the point is that
// nothing but SQL can see the row.
'use strict';

process.env.ChatFat_ENV_FILE = 'off';
if (!process.env.MASTER_KEY) process.env.MASTER_KEY = require('./harness').TEST_MASTER_KEY;
process.env.DATABASE_URL = 'memory';

const { ok, eq, bail, report } = require('./harness');
const { MemoryRepo } = require('../src/messages/repository');

let seq = 0;
function message(overrides) {
  return Object.assign(
    {
      id: 'm_' + seq++,
      ts: Date.now(),
      from: 'kavya',
      fromId: 's1',
      colour: 100,
      text: 'a message nobody should be able to read off disk',
      action: false,
      replyTo: null,
      mentions: [],
      reactions: {},
      editedAt: null,
      unsent: false,
      enc: null,
    },
    overrides,
  );
}

async function main() {
  const repo = new MemoryRepo();

  // ── requirement 3: not stored as plaintext ────────────────────────────────

  const original = message();
  await repo.save('room-plain', original);
  const stored = repo.rows.get(original.id).m;

  ok(stored.text !== original.text, 'the stored text differs from the plaintext that was sent');
  ok(!stored.text.includes('nobody'), 'no substring of the plaintext survives into storage');
  ok(typeof stored.textKv === 'number' && stored.textKv >= 1, 'a key version is recorded for a message that was actually encrypted');

  const [readBack] = await repo.recent('room-plain', 10);
  eq(readBack.text, original.text, 'reading it back through the repository returns the original plaintext');
  ok(!readBack.tampered, 'and it is not flagged as tampered');

  // A locked room's server-side row always has empty text — the real content
  // lives in enc_ct, under a key the server never holds. That empty string
  // must be left alone, not run through the at-rest cipher: text_kv null
  // means "nothing to protect here", not "protection failed".
  const lockedRoomStyle = message({ text: '', enc: { alg: 'A256GCM', kid: 1, n: 'x', iv: 'y', ct: 'z', aadv: 1 } });
  await repo.save('room-locked', lockedRoomStyle);
  const storedLocked = repo.rows.get(lockedRoomStyle.id).m;
  eq(storedLocked.textKv, null, "a locked room's empty text column is not encrypted — there is nothing in it");

  // Edits go through the same cipher too, not a bypass.
  const edited = message({ text: 'before the edit' });
  await repo.save('room-edit', edited);
  await repo.update(edited.id, { text: 'after the edit', editedAt: Date.now() });
  const rawEdited = repo.rows.get(edited.id).m;
  ok(!rawEdited.text.includes('after'), 'an edit is also encrypted at rest, not left as plaintext');
  const [readEdited] = await repo.recent('room-edit', 10);
  eq(readEdited.text, 'after the edit', 'and an edited message still reads back correctly');

  // ── requirement 4: detects modification of a stored message ──────────────

  const target = message({ text: 'this row is about to be corrupted' });
  await repo.save('room-tamper', target);
  const raw = repo.rows.get(target.id).m;
  raw.text = raw.text.slice(0, -4) + (raw.text.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'); // flip the auth tag

  const [corrupted] = await repo.recent('room-tamper', 10);
  ok(corrupted.tampered, 'a row corrupted directly in storage is flagged as tampered on the next read');
  eq(corrupted.text, '', 'and its text is not served as if it were legitimate content');

  // Swapping one row's ciphertext into another's is also caught — the
  // authentication tag is bound to the message id (as AAD), not just to the
  // bytes, so a copy-paste between rows fails just as loudly as a bit flip.
  const a = message({ id: 'm_swap_a', text: 'message A' });
  const b = message({ id: 'm_swap_b', text: 'message B' });
  await repo.save('room-swap', a);
  await repo.save('room-swap', b);
  const rawA = repo.rows.get('m_swap_a').m;
  const rawB = repo.rows.get('m_swap_b').m;
  rawB.text = rawA.text; // A's ciphertext, pasted into B's row
  rawB.textIv = rawA.textIv;
  const swapped = (await repo.recent('room-swap', 10)).find((m) => m.id === 'm_swap_b');
  ok(swapped.tampered, "one row's ciphertext pasted into another row's columns is still caught");
  const untouched = (await repo.recent('room-swap', 10)).find((m) => m.id === 'm_swap_a');
  ok(!untouched.tampered, 'and the row that was not touched is unaffected');

  // A wrong/missing key version fails the same way as a tampered tag — no
  // stack trace, no crash, just a flagged row. Simulates reading old history
  // after MASTER_KEYS lost a version it should have kept.
  const orphan = message({ text: 'sealed under a key version nobody configured' });
  await repo.save('room-orphan', orphan);
  repo.rows.get(orphan.id).m.textKv = 99;
  const [orphaned] = await repo.recent('room-orphan', 10);
  ok(orphaned.tampered, 'a row naming a key version the server does not hold is flagged rather than crashing the read');

  report('at-rest encryption + tamper detection');
}

main().catch(bail);
