// src/crypto/signature.js — requirements 5 + 6. Each sender signs a message
// with an ECDSA P-256 keypair generated and held in their own browser
// (public/crypto.js); this module only ever handles the PUBLIC half, and only
// ever verifies — the server has no code path that could sign as a user.
//
// P-256 to match the curve already used for whisper ECDH elsewhere in this
// codebase — "universally supported" was the reasoning there and applies
// here too, and it means one curve, not two, for anyone auditing this.
//
// What gets signed is deliberately NOT what the server stamps. `id` and `ts`
// are assigned by the server after the frame arrives (see src/protocol/
// frames.js), so the sender cannot include them in what they sign — the same
// constraint the room-encryption AAD already works around with a client-side
// nonce (see aadFor in public/crypto.js). The canonical payload here is built
// the same way that comment describes: a fixed, delimited, manually-ordered
// string, not a general JSON canonicalisation — so a byte-for-byte identical
// string is trivial to reproduce on both sides. It must be built IDENTICALLY
// in public/crypto.js's `canonicalPayload` — if one changes, so does the other.
'use strict';

const crypto = require('node:crypto');

// enc is the room-encryption envelope { alg, kid, n, iv, ct, aadv } when the
// message is encrypted, or absent for a plaintext one — never both.
function canonicalPayload({ room, from, text, enc }) {
  const encPart = enc ? [enc.alg, enc.kid, enc.n, enc.iv, enc.ct, enc.aadv].join(':') : '';
  return Buffer.from(`${room}|${from}|${text || ''}|${encPart}`, 'utf8');
}

// Never throws: a malformed key or signature is just "does not verify", the
// same as a wrong one — the caller does not need to tell the two apart.
function verify(pubB64, sigB64, fields) {
  try {
    const pubKey = crypto.createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' });
    const sig = Buffer.from(sigB64, 'base64');
    const payload = canonicalPayload(fields);
    // WebCrypto's ECDSA signatures are raw (r || s), not the DER encoding
    // Node's crypto defaults to — 'ieee-p1363' reads the browser's format
    // directly, no conversion needed on either side.
    return crypto.verify('sha256', payload, { key: pubKey, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

module.exports = { canonicalPayload, verify };
