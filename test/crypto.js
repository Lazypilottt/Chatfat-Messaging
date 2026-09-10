// test/crypto.js — encrypted rooms and sealed whispers.
//
// The point of every assertion here is the same: the server must relay what it
// cannot read, refuse what is malformed, and never — in a stored row or in a
// log line — hold a single character of anybody's plaintext.
'use strict';

const { webcrypto } = require('node:crypto');
const { ok, eq, bail, report, startServer, client, sleep, post } = require('./harness');

const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const PORT = 8094;
const OFF_PORT = 8093;
const ITERATIONS = 250000;

// — the same derivation the browser does, reimplemented here so the suite is an
//   independent check on public/crypto.js rather than a call into it.

const b64 = (buf) => Buffer.from(new Uint8Array(buf)).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function roomSalt(roomId) {
  return subtle.digest('SHA-256', enc.encode('ChatFat-room-v1|' + roomId));
}

async function makeKey(passphrase, roomId, epoch) {
  const salt = await roomSalt(roomId);
  const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const raw = await subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, base, 256);
  const hmac = await subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const verifier = b64(await subtle.sign('HMAC', hmac, enc.encode('ChatFat-room-verify|' + roomId + '|' + epoch)));
  const digest = Buffer.from(new Uint8Array(await subtle.digest('SHA-256', raw))).toString('hex');
  return {
    raw,
    epoch,
    verifier,
    fingerprint: digest.slice(0, 8),
    key: await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
  };
}

const aad = (roomId, n, kid) => enc.encode(roomId + '|' + n + '|' + kid);

async function seal(entry, roomId, payload) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const n = b64(webcrypto.getRandomValues(new Uint8Array(16)));
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(roomId, n, entry.epoch) },
    entry.key,
    enc.encode(JSON.stringify(payload)),
  );
  return { alg: 'A256GCM', kid: entry.epoch, n, iv: b64(iv), ct: b64(ct), aadv: 1 };
}

async function open(entry, roomId, envelope) {
  try {
    const plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: aad(roomId, envelope.n, envelope.kid) },
      entry.key,
      unb64(envelope.ct),
    );
    return { ok: true, payload: JSON.parse(dec.decode(plain)) };
  } catch {
    return { ok: false };
  }
}

const lockBody = async (entry, roomId) => ({
  kdf: { alg: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: b64(await roomSalt(roomId)) },
  verifier: entry.verifier,
});

// `memory` mode stores messages but keeps accounts off — Better Auth needs
// real tables — so a client here just claims a free name.
async function signedIn(port, name) {
  const c = await client(port);
  await c.next('hello');
  await c.join(name);
  return c;
}

async function main() {
  const server = await startServer(PORT, {
    DATABASE_URL: 'memory',
    HISTORY_REPLAY: '10',
    AUTH_MAX_ATTEMPTS: '500',
    HEARTBEAT_MS: '2000',
  });

  const health = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
  eq(health.encryption, true, '/healthz reports that encryption is available');
  eq(health.lockedRooms, 0, 'and counts locked rooms — none yet');

  const a = await signedIn(PORT, 'kavya', 'correct-horse');
  const b = await signedIn(PORT, 'meera', 'correct-horse-2');

  // ── the same passphrase reaches the same key on two machines ─────────────
  const ROOM = 'design-crit';
  const PASS = 'four flat white horses';
  const keyA = await makeKey(PASS, ROOM, 1);
  const keyB = await makeKey(PASS, ROOM, 1);
  const keyWrong = await makeKey('a completely different one', ROOM, 1);

  eq(keyA.verifier, keyB.verifier, 'two members with the same passphrase derive the same verifier');
  eq(keyA.fingerprint, keyB.fingerprint, 'and the same fingerprint, which is what they compare out loud');
  ok(keyA.verifier !== keyWrong.verifier, 'a different passphrase derives a different verifier');
  ok(keyA.fingerprint !== keyWrong.fingerprint, 'and a different fingerprint');
  eq(keyA.fingerprint.length, 8, 'the fingerprint is 8 hex characters');

  // The room id is inside the salt, so the same passphrase elsewhere is a different key.
  const keyOtherRoom = await makeKey(PASS, 'ops', 1);
  ok(keyA.fingerprint !== keyOtherRoom.fingerprint, 'the same passphrase in another room is a different key');

  // ── creating a locked room ───────────────────────────────────────────────
  const created = await a.create(ROOM, await lockBody(keyA, ROOM));
  eq(created.d.room.locked, true, 'a room can be created locked');
  eq(created.d.room.keyEpoch, 1, 'starting at key epoch 1');
  eq(created.d.room.verifier, keyA.verifier, 'the verifier is handed to whoever joins');
  eq(created.d.room.kdf.alg, 'PBKDF2-SHA256', 'along with the derivation parameters');
  eq(created.d.room.kdf.iterations, ITERATIONS, 'including the iteration count');

  const lockedHealth = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
  eq(lockedHealth.lockedRooms, 1, '/healthz now counts one locked room');

  // Joining a locked room is ALLOWED — the server holds no key and could verify
  // nothing, so gating entry there would be theatre.
  const bJoined = await b.enter(ROOM);
  eq(bJoined.d.room.locked, true, 'a second member is let in, key or no key');
  eq(bJoined.d.room.verifier, keyA.verifier, 'and is handed the verifier to check its own passphrase against');

  // ── plaintext into a locked room is refused ──────────────────────────────
  a.drain().send('chat', { text: 'this should never be accepted' });
  const refused = await a.next('error');
  eq(refused.d.code, 'ENCRYPTION_REQUIRED', 'plaintext in a locked room is refused');
  ok(refused.d.message.indexOf('this should never') < 0, 'and the refusal does not echo the text back');

  // ── the envelope is relayed byte for byte ────────────────────────────────
  const secret = 'Client rebuild lands Thursday. Do not put the port list in the open room.';
  const envelope = await seal(keyA, ROOM, { text: secret, mentions: ['meera'], action: false });
  a.drain(); b.drain();
  a.send('chat', { enc: envelope });

  const relayed = (await b.next('chat')).d;
  eq(relayed.enc.ct, envelope.ct, 'the ciphertext is relayed byte for byte');
  eq(relayed.enc.iv, envelope.iv, 'the IV is unchanged');
  eq(relayed.enc.n, envelope.n, 'the nonce is copied through verbatim');
  eq(relayed.enc.kid, envelope.kid, 'and the key epoch');
  eq(relayed.enc.alg, 'A256GCM', 'with the algorithm intact');
  eq(relayed.text, '', 'the server stores no text for an encrypted message');
  eq(relayed.mentions.length, 0, 'and resolves no mentions — it cannot read them');
  eq(relayed.from, 'kavya', 'while the metadata it always saw is still there');

  const opened = await open(keyB, ROOM, relayed.enc);
  eq(opened.ok, true, 'a member with the passphrase can read it');
  eq(opened.payload.text, secret, 'and gets the exact plaintext back');
  eq(opened.payload.mentions.join(','), 'meera', 'including the mentions, which travelled inside the ciphertext');

  const wrongPass = await open(keyWrong, ROOM, relayed.enc);
  eq(wrongPass.ok, false, 'a member with the wrong passphrase gets nothing — not garbage, not an error page');

  // ── tampering is caught by the authentication tag ────────────────────────
  const tampered = JSON.parse(JSON.stringify(relayed.enc));
  const bytes = Buffer.from(tampered.ct, 'base64');
  bytes[3] ^= 0x01; // flip exactly one bit
  tampered.ct = bytes.toString('base64');
  const tamperResult = await open(keyA, ROOM, tampered);
  eq(tamperResult.ok, false, 'one flipped bit fails the integrity check rather than decrypting to junk');

  // The AAD binds the ciphertext to its room: replaying it elsewhere fails.
  const otherRoomKey = await makeKey(PASS, ROOM, 1);
  const replayed = await open(otherRoomKey, 'somewhere-else', relayed.enc);
  eq(replayed.ok, false, 'and a ciphertext replayed into another room fails too');

  // ── malformed envelopes are refused ──────────────────────────────────────
  const malformed = [
    ['a wrong algorithm', { ...envelope, alg: 'A128GCM' }],
    ['a non-base64 ciphertext', { ...envelope, ct: 'not base64 at all!!' }],
    ['an 11-byte IV', { ...envelope, iv: b64(new Uint8Array(11)) }],
    ['a 15-byte nonce', { ...envelope, n: b64(new Uint8Array(15)) }],
    ['a zero key epoch', { ...envelope, kid: 0 }],
    ['an unknown AAD version', { ...envelope, aadv: 99 }],
    ['a missing envelope', null],
  ];
  await a.refill();
  for (const [label, bad] of malformed) {
    a.drain().send('chat', { enc: bad });
    const err = await a.next('error');
    ok(err.d.code === 'FORBIDDEN' || err.d.code === 'ENCRYPTION_REQUIRED', `${label} is refused`);
    await sleep(1100); // one token back per second, so the bucket never colours the result
  }

  const oversize = { ...envelope, ct: 'A'.repeat(20000) };
  a.drain().send('chat', { enc: oversize });
  eq((await a.next('error')).d.code, 'TOO_LONG', 'an oversize ciphertext is TOO_LONG, not accepted');
  ok(a.ws.readyState === 1, 'and none of those closed the socket');

  // ── nothing plaintext is stored ──────────────────────────────────────────
  await sleep(300);
  const c = await signedIn(PORT, 'aravind', 'correct-horse-3');
  const replay = await c.enter(ROOM);
  const stored = replay.d.history.find((m) => m.enc);
  ok(stored, 'the encrypted message was recorded');
  eq(stored.text, '', 'with an EMPTY text column');
  eq(JSON.stringify(stored).indexOf('Client rebuild'), -1, 'and the plaintext appears nowhere in the stored row');
  eq(stored.enc.ct, envelope.ct, 'replayed history hands back the envelope intact');
  eq(stored.enc.iv, envelope.iv, 'IV and all');
  const replayOpened = await open(keyA, ROOM, stored.enc);
  eq(replayOpened.payload.text, secret, 'so a client that joins later with the passphrase can read the backlog');

  // ── editing inside a locked room ─────────────────────────────────────────
  await a.refill();
  const editEnvelope = await seal(keyA, ROOM, { text: 'Correction: it lands Friday.', mentions: [], action: false });
  a.drain().send('edit', { id: relayed.id, enc: editEnvelope });
  const edited = (await a.next('edited')).d;
  eq(edited.enc.ct, editEnvelope.ct, 'an edit replaces the envelope');
  ok(edited.enc.iv !== envelope.iv, 'with a fresh IV');
  eq(edited.text, '', 'and still stores no text');
  const editOpened = await open(keyB, ROOM, edited.enc);
  eq(editOpened.payload.text, 'Correction: it lands Friday.', 'which every member can read');

  // The author check is on fromId, so encryption changes nothing about it.
  await b.refill();
  b.drain().send('edit', { id: relayed.id, enc: await seal(keyB, ROOM, { text: 'not mine', mentions: [], action: false }) });
  eq((await b.next('error')).d.code, 'FORBIDDEN', 'a non-author still cannot edit an encrypted message');

  a.drain().send('edit', { id: relayed.id, text: 'downgrade to plaintext' });
  eq((await a.next('error')).d.code, 'ENCRYPTION_REQUIRED', 'and an edit cannot downgrade a locked room to plaintext');

  // ── key rotation ─────────────────────────────────────────────────────────
  const rotated = await makeKey('an entirely new passphrase', ROOM, 2);
  a.drain(); b.drain();
  await a.refill();
  a.send('room:lock', await lockBody(rotated, ROOM));
  const lockedFrame = (await b.next('room:locked')).d;
  eq(lockedFrame.keyEpoch, 2, 'rotating moves the room to key epoch 2');
  eq(lockedFrame.verifier, rotated.verifier, 'with the new verifier');
  eq(lockedFrame.by, 'kavya', 'attributed to whoever rotated it');
  const lockSystem = b.typed('system').filter((f) => f.d.event === 'lock').pop();
  ok(lockSystem, 'and a system line says so in the room');

  const afterRotation = await seal(rotated, ROOM, { text: 'only epoch two members read this', mentions: [], action: false });
  a.drain(); b.drain();
  await a.refill();
  a.send('chat', { enc: afterRotation });
  const newEra = (await b.next('chat')).d;
  eq(newEra.enc.kid, 2, 'new messages carry the new key epoch');
  eq((await open(rotated, ROOM, newEra.enc)).ok, true, 'and are readable with the new key');
  eq((await open(keyA, ROOM, newEra.enc)).ok, false, 'but not with the old one');

  // Rotation does not re-encrypt history: an epoch-1 message stays readable to
  // anyone who still holds the epoch-1 key.
  eq((await open(keyA, ROOM, edited.enc)).ok, true, 'a message sent under epoch 1 stays readable with the epoch-1 key');
  eq(edited.enc.kid, 1, 'because every envelope carries the epoch it was sealed under');

  // ── a locked room can never be unlocked back to plaintext ────────────────
  const stillLocked = await c.enter('lab-room').then(() => c.enter(ROOM));
  eq(stillLocked.d.room.locked, true, 'the room is still locked after everything above');

  // ── an unlocked room refuses an envelope ─────────────────────────────────
  const openRoom = await a.create('open-room');
  eq(openRoom.d.room.locked, false, 'a plain room is not locked');
  a.drain().send('chat', { enc: envelope });
  eq((await a.next('error')).d.code, 'FORBIDDEN', 'an unlocked room refuses an encrypted payload');
  await sleep(1100);
  a.drain().send('chat', { text: 'ordinary words' });
  eq((await a.next('chat')).d.text, 'ordinary words', 'and still takes plain ones');

  // ── sealed whispers ──────────────────────────────────────────────────────
  const pairA = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pubA = b64(await subtle.exportKey('spki', pairA.publicKey));
  a.drain().send('key:publish', { pub: pubA });
  await sleep(200);

  const sealedHalf = {
    epk: pubA,
    salt: b64(webcrypto.getRandomValues(new Uint8Array(32))),
    iv: b64(webcrypto.getRandomValues(new Uint8Array(12))),
    ct: b64(webcrypto.getRandomValues(new Uint8Array(64))),
  };
  const sealedSelf = {
    epk: pubA,
    salt: b64(webcrypto.getRandomValues(new Uint8Array(32))),
    iv: b64(webcrypto.getRandomValues(new Uint8Array(12))),
    ct: b64(webcrypto.getRandomValues(new Uint8Array(72))),
  };
  b.drain(); a.drain();
  await a.refill();
  b.send('dm', { to: 'kavya', enc: { alg: 'A256GCM', aadv: 1, to: sealedHalf, self: sealedSelf } });

  const sealedIn = (await a.next('dm')).d;
  eq(sealedIn.enc.to.ct, sealedHalf.ct, 'the recipient half of a sealed whisper is relayed unchanged');
  eq(sealedIn.enc.to.epk, sealedHalf.epk, 'ephemeral public key and all');
  eq(sealedIn.enc.self.ct, sealedSelf.ct, 'and so is the sender half');
  eq(sealedIn.enc.self.salt, sealedSelf.salt, 'salt and all');
  eq(sealedIn.text, '', 'a sealed whisper carries no plaintext');
  const sealedEcho = (await b.next('dm')).d;
  eq(sealedEcho.enc.self.ct, sealedSelf.ct, 'and the sender gets its own copy back so its log stays readable');

  await b.refill();
  b.drain().send('dm', { to: 'kavya', enc: { alg: 'A256GCM', aadv: 1, to: sealedHalf } });
  eq((await b.next('error')).d.code, 'FORBIDDEN', 'a sealed whisper missing a half is refused');

  // ── the server log holds no plaintext ────────────────────────────────────
  await sleep(400);
  const log = server.out();
  eq(log.indexOf(secret), -1, 'the server log contains no message text');
  eq(log.indexOf('Client rebuild'), -1, 'not even a fragment of it');
  eq(log.indexOf(envelope.ct), -1, 'and no ciphertext either');
  eq(log.indexOf(PASS), -1, 'and certainly no passphrase');
  eq(log.indexOf('ordinary words'), -1, 'plaintext rooms are not logged either');

  a.close(); b.close(); c.close();
  await sleep(200);
  server.stop();

  // ── a server with encryption switched off ────────────────────────────────
  const off = await startServer(OFF_PORT, { ENCRYPTION_ENABLED: '0', AUTH_MAX_ATTEMPTS: '500' });
  const offHealth = await (await fetch(`http://127.0.0.1:${OFF_PORT}/healthz`)).json();
  eq(offHealth.encryption, false, '/healthz says encryption is off');

  const x = await client(OFF_PORT);
  const offHello = await x.next('hello');
  eq(offHello.d.encryption, false, 'and so does hello, before anything is attempted');
  await x.join('kavya');
  const offKey = await makeKey(PASS, 'vault', 1);
  x.drain().send('room:create', { room: 'vault', lock: await lockBody(offKey, 'vault') });
  eq((await x.next('error')).d.code, 'ENCRYPTION_DISABLED', 'and locking is refused with ENCRYPTION_DISABLED');
  x.close();
  await sleep(150);
  off.stop();

  report('crypto');
}

main().catch(bail);
