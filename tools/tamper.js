// tools/tamper.js — deliberately corrupts one stored message row, to make
// requirement 4 ("the system detects modification of a stored message")
// something you can point at rather than something you have to take on faith.
//
// Gated behind ALLOW_TAMPER=1 on purpose: this reaches past the application
// entirely and writes garbage into a production table if you let it. Never
// set that switch on a deployed server.
//
//   ALLOW_TAMPER=1 node tools/tamper.js --room lab-room
//   ALLOW_TAMPER=1 node tools/tamper.js --room lab-room --id m_abc123
//
// After running this, the NEXT time any client (re)loads that room's history
// — rejoin, or scroll back to it — the corrupted row decrypts to a tampered
// flag instead of its original text. That is the detection: it happens on
// read, inside src/messages/repository.js, exactly where every other history
// read already goes through the at-rest cipher.
'use strict';

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

async function main() {
  if (process.env.ALLOW_TAMPER !== '1') {
    console.error('Refusing: set ALLOW_TAMPER=1 to run this. It corrupts a real row on purpose.');
    process.exit(1);
  }

  const opts = args();
  const room = opts.room;
  if (!room) {
    console.error('Usage: ALLOW_TAMPER=1 node tools/tamper.js --room <roomId> [--id <messageId>]');
    process.exit(1);
  }

  // Requires a real Postgres DATABASE_URL — 'memory' lives inside a single
  // server process and there is nothing outside it to reach into.
  const url = process.env.DATABASE_URL;
  if (!url || url === 'memory' || url === 'none') {
    console.error('DATABASE_URL must point at Postgres for this tool — memory/none have no external row to corrupt.');
    process.exit(1);
  }

  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    let target;
    if (opts.id) {
      const res = await client.query('select id, text, text_kv from messages where id = $1 and room_id = $2', [opts.id, room]);
      target = res.rows[0];
    } else {
      const res = await client.query(
        'select id, text, text_kv from messages where room_id = $1 and unsent = false order by ts desc, id desc limit 1',
        [room],
      );
      target = res.rows[0];
    }

    if (!target) {
      console.error(`No message found in room "${room}"${opts.id ? ` with id ${opts.id}` : ''}.`);
      process.exit(1);
    }
    if (target.text_kv === null) {
      console.error(
        `Message ${target.id} has no at-rest ciphertext (text_kv is null) — it's either from a locked room ` +
          '(content lives in enc_ct instead) or predates requirement 3. Pick another message.',
      );
      process.exit(1);
    }

    // Flip the last few characters of the stored ciphertext blob. This lands
    // inside the GCM authentication tag appended to the ciphertext (see
    // src/crypto/atRest.js), which is exactly what should make decryption —
    // and therefore the read — fail.
    const corrupted = target.text.slice(0, -4) + (target.text.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    await client.query('update messages set text = $1 where id = $2', [corrupted, target.id]);

    console.log(`Corrupted message ${target.id} in room "${room}".`);
    console.log('Rejoin the room (or page back to it) in a running server to see it flagged as tampered.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
