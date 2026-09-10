// test/signing.js — requirement 5 (each sender has a signing keypair) and
// requirement 6 (a message carries a sender signature, and it is verified).
//
// The happy path is already exercised by every OTHER suite: the harness
// signs every chat/edit frame it sends (see test/harness.js), and if that
// were broken, nothing anywhere would work — protocol.js alone is over a
// hundred assertions resting on it. This suite is about what the happy path
// does not reach: a frame with no signature, a signature from the wrong key,
// a signature over content that does not match what is actually being sent,
// and each sender genuinely holding a DIFFERENT key.
'use strict';

const { ok, eq, bail, report, startServer, client, sleep, PROTOCOL_VERSION } = require('./harness');
const { webcrypto } = require('node:crypto');
const { canonicalPayload } = require('../src/crypto/signature');

const PORT = 8098;

async function freshKeypair() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = await webcrypto.subtle.exportKey('spki', pair.publicKey);
  return { priv: pair.privateKey, pubB64: Buffer.from(spki).toString('base64') };
}

async function signWith(priv, fields) {
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, canonicalPayload(fields));
  return Buffer.from(sig).toString('base64');
}

// A hand-built frame, bypassing the harness's own c.send() entirely — every
// negative case here needs to construct a deliberately wrong pairing of
// signature and content, which the harness's own (correct) signing can't do.
function rawFrame(t, d) {
  return JSON.stringify({ v: PROTOCOL_VERSION, t, d });
}

async function main() {
  // DATABASE_URL: 'memory', not the harness default of 'none' — the
  // requirement-4 tie-in near the end needs a message to actually survive a
  // rejoin, which a NullRepo (nothing stored) can never do.
  const server = await startServer(PORT, { HISTORY_REPLAY: '50', DATABASE_URL: 'memory' });

  const a = await client(PORT);
  await a.join('kavya');
  await a.enter('lab-room');

  const b = await client(PORT);
  await b.join('meera');
  await b.enter('lab-room');

  // ── requirement 5: each sender has its own keypair ────────────────────────
  ok(typeof a.sigPub === 'string' && a.sigPub.length > 0, "kavya's signing key was generated and published");
  ok(typeof b.sigPub === 'string' && b.sigPub.length > 0, "meera's signing key was generated and published");
  ok(a.sigPub !== b.sigPub, 'two different senders hold two different signing keys');

  // ── requirement 6: a normally-sent message carries sig + sigPub, matching
  //    the sender's own published key ─────────────────────────────────────
  a.drain().send('chat', { text: 'hello from kavya' });
  const normal = (await a.next('chat')).d;
  ok(typeof normal.sig === 'string' && normal.sig.length > 0, 'a sent message carries a signature');
  eq(normal.sigPub, a.sigPub, "and it's signed under the sender's own published key");

  // ── missing signature is refused, not silently accepted ───────────────────
  a.drain();
  a.ws.send(rawFrame('chat', { text: 'no signature at all' }));
  const noSig = await a.next('error');
  eq(noSig.d.code, 'SIGNATURE_REQUIRED', 'a chat frame with no signature is refused');

  // ── malformed signature is refused ─────────────────────────────────────────
  a.drain();
  a.ws.send(rawFrame('chat', { text: 'bad sig', sig: 'not-base64!!!' }));
  eq((await a.next('error')).d.code, 'SIGNATURE_REQUIRED', 'a malformed signature is refused the same way');

  // ── a signature from the WRONG key is refused, even though it is a
  //    perfectly well-formed signature of SOMETHING ─────────────────────────
  const impostor = await freshKeypair();
  const wrongKeySig = await signWith(impostor.priv, { room: 'lab-room', from: 'kavya', text: 'forged', enc: null });
  a.drain();
  a.ws.send(rawFrame('chat', { text: 'forged', sig: wrongKeySig }));
  eq((await a.next('error')).d.code, 'FORBIDDEN', "a signature from a key other than the sender's own published one is refused");

  // ── a VALID signature — kavya's own real key, correctly used — over the
  //    WRONG content is still refused. Proves the server checks what the
  //    frame actually carries, not merely that some signature from the
  //    right key is attached somewhere. ─────────────────────────────────────
  const wrongContentSig = await a.signRaw({ room: 'lab-room', from: 'kavya', text: 'this is what was signed', enc: null });
  a.drain();
  a.ws.send(rawFrame('chat', { text: 'this is what was actually sent', sig: wrongContentSig }));
  eq(
    (await a.next('error')).d.code,
    'FORBIDDEN',
    "kavya's own valid signature over DIFFERENT text than the frame carries is refused",
  );

  // The four negative sends above each still cost a rate-limit token before
  // failing on their signature — takeToken() runs ahead of signature
  // verification in onChat (src/transport/handlers.js). Five attempts against
  // a burst-5 bucket exhausts it, so wait for a refill before sending
  // legitimately again — the same thing c.refill() exists for elsewhere.
  await a.refill();

  // ── an edit is re-signed, and re-verified against the NEW content ─────────
  a.drain().send('chat', { text: 'original text' });
  const sent = (await a.next('chat')).d;
  a.drain();
  a.send('edit', { id: sent.id, text: 'edited text' });
  const edited = (await a.next('edited')).d;
  eq(edited.text, 'edited text', 'a properly signed edit is accepted');
  ok(typeof edited.sig === 'string' && edited.sig.length > 0, 'and carries its own (new) signature');
  ok(edited.sig !== normal.sig, 'which is different from the original message’s signature — it covers different content');

  // An edit signed with the wrong key is refused, same as a fresh chat.
  const forgedEditSig = await signWith(impostor.priv, { room: 'lab-room', from: 'kavya', text: 'hijacked', enc: null });
  a.drain();
  a.ws.send(rawFrame('edit', { id: sent.id, text: 'hijacked', sig: forgedEditSig }));
  eq((await a.next('error')).d.code, 'FORBIDDEN', 'an edit signed by a key other than the author’s is refused');

  // ── requirement 4 tie-in: signing survives persistence and replay, and a
  //    row whose signature no longer matches its content is flagged ────────
  const c = await client(PORT);
  await c.join('divya');
  const rejoined = await c.enter('lab-room');
  const survivor = rejoined.d.history.find((m) => m.id === sent.id);
  ok(survivor, 'the edited message survives into a fresh replay');
  eq(survivor.text, 'edited text', 'with its edited content');
  ok(!survivor.tampered, 'and it is not flagged — the stored signature still matches the stored content');

  a.close();
  b.close();
  c.close();
  await sleep(200);
  server.stop();

  report('signing');
}

main().catch(bail);
