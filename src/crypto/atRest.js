// src/crypto/atRest.js — server-side, server-keyed encryption of stored
// message text (requirement 3), with tamper detection (requirement 4) as a
// direct consequence of using an AEAD rather than a plain cipher.
//
// This is a DIFFERENT guarantee from a locked room's client-side envelope
// (src/crypto/envelope.js): that protects a message from the SERVER too, and
// is opt-in per room. This protects every message from anyone who reads the
// database directly — a dump, a stolen backup, a leaked credential — without
// the running application. The server can still read it; that is the
// deliberate difference, not an oversight.
//
// AES-256-GCM's authentication tag is bound to the message's own id as
// additional data, so a ciphertext copied verbatim from one row into another
// fails to decrypt in its new home, not just a bit-flipped one failing in
// place. Decryption never throws to the caller: a wrong key, a missing key
// version, or a tampered tag all come back as `{ ok: false }`, because the
// caller's job is to flag a row, not crash a history load over one of them.
'use strict';

const crypto = require('node:crypto');
const config = require('../config');

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

// Encrypts `plaintext` under the CURRENT key version. `aad` binds the
// ciphertext to the row it belongs to — pass the message id.
function encryptText(plaintext, aad) {
  const version = config.MASTER_KEY_VERSION;
  const key = config.MASTER_KEYS.get(version);
  if (!key) throw new Error('no MASTER_KEY configured — this should have been caught at boot');

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    kv: version,
    iv: iv.toString('base64'),
    // Ciphertext and tag travel together as one blob, so no extra column is
    // needed beyond what already held the plaintext.
    ct: Buffer.concat([ct, tag]).toString('base64'),
  };
}

// Returns { ok: true, text } or { ok: false } — see the file comment on why
// this never throws.
function decryptText(ctB64, ivB64, version, aad) {
  const key = config.MASTER_KEYS.get(version);
  if (!key || typeof ctB64 !== 'string' || typeof ivB64 !== 'string') return { ok: false };

  try {
    const raw = Buffer.from(ctB64, 'base64');
    if (raw.length < TAG_BYTES) return { ok: false };
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const ct = raw.subarray(0, raw.length - TAG_BYTES);

    const decipher = crypto.createDecipheriv(ALG, key, Buffer.from(ivB64, 'base64'));
    decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return { ok: true, text: plain.toString('utf8') };
  } catch {
    return { ok: false };
  }
}

module.exports = { encryptText, decryptText };
