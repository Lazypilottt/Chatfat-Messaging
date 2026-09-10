// src/crypto/envelope.js — ciphertext envelope validation and size accounting.
//
// The server never decrypts and has no code path that could. But it must not
// accept garbage either, or a malformed envelope becomes a way to store junk in
// somebody else's room. Everything here is shape and size only: no field is
// ever interpreted, and nothing here is ever logged.
'use strict';

const config = require('../config');

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const KNOWN_AADV = new Set([1]);

function b64len(s) {
  // Decoded byte length of a base64 string, without allocating the buffer.
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

function isB64(v, exactBytes) {
  if (typeof v !== 'string' || v.length === 0 || v.length % 4 !== 0) return false;
  if (!B64_RE.test(v)) return false;
  if (exactBytes !== undefined && b64len(v) !== exactBytes) return false;
  return true;
}

// A room envelope: { alg, kid, n, iv, ct, aadv }.
// Returns null when it is acceptable, or an { code, message } to fail with.
function validateRoomEnvelope(enc) {
  if (!enc || typeof enc !== 'object' || Array.isArray(enc)) {
    return { code: 'FORBIDDEN', message: 'Malformed ciphertext.' };
  }
  if (enc.alg !== 'A256GCM') return { code: 'FORBIDDEN', message: 'Malformed ciphertext.' };
  if (!KNOWN_AADV.has(enc.aadv)) return { code: 'FORBIDDEN', message: 'Malformed ciphertext.' };
  if (!Number.isInteger(enc.kid) || enc.kid < 1) return { code: 'FORBIDDEN', message: 'Malformed ciphertext.' };
  if (!isB64(enc.iv, 12)) return { code: 'FORBIDDEN', message: 'Malformed ciphertext.' };
  if (!isB64(enc.n, 16)) return { code: 'FORBIDDEN', message: 'Malformed ciphertext.' };
  if (!isB64(enc.ct)) return { code: 'FORBIDDEN', message: 'Malformed ciphertext.' };
  if (b64len(enc.ct) > config.MAX_CIPHERTEXT) {
    return { code: 'TOO_LONG', message: 'That ciphertext is too large.' };
  }
  return null;
}

// Copied field by field rather than spread, so nothing a client invents rides
// along into storage or out to the room.
function sanitiseRoomEnvelope(enc) {
  return { alg: 'A256GCM', kid: enc.kid, n: enc.n, iv: enc.iv, ct: enc.ct, aadv: enc.aadv };
}

// One half of a sealed whisper: { epk, salt, iv, ct }.
function validateSealedHalf(half) {
  if (!half || typeof half !== 'object' || Array.isArray(half)) return false;
  if (!isB64(half.epk)) return false;
  if (!isB64(half.salt, 32)) return false;
  if (!isB64(half.iv, 12)) return false;
  if (!isB64(half.ct)) return false;
  if (b64len(half.ct) > config.MAX_CIPHERTEXT) return false;
  return true;
}

// A sealed whisper carries two halves: one to the recipient, one to yourself,
// because the server echoes the whisper back and your own log has to be readable.
function validateSealedEnvelope(enc) {
  if (!enc || typeof enc !== 'object' || Array.isArray(enc)) {
    return { code: 'FORBIDDEN', message: 'Malformed ciphertext.' };
  }
  if (enc.alg !== 'A256GCM') return { code: 'FORBIDDEN', message: 'Malformed ciphertext.' };
  if (!KNOWN_AADV.has(enc.aadv)) return { code: 'FORBIDDEN', message: 'Malformed ciphertext.' };
  if (!validateSealedHalf(enc.to) || !validateSealedHalf(enc.self)) {
    return { code: 'FORBIDDEN', message: 'Malformed ciphertext.' };
  }
  return null;
}

function sanitiseSealedHalf(h) {
  return { epk: h.epk, salt: h.salt, iv: h.iv, ct: h.ct };
}

function sanitiseSealedEnvelope(enc) {
  return { alg: 'A256GCM', aadv: enc.aadv, to: sanitiseSealedHalf(enc.to), self: sanitiseSealedHalf(enc.self) };
}

// The lock request itself: { kdf: {alg, iterations, salt}, verifier }.
function validateLock(lock) {
  if (!lock || typeof lock !== 'object') return { code: 'NAME_INVALID', message: 'Malformed lock request.' };
  const kdf = lock.kdf;
  if (!kdf || typeof kdf !== 'object') return { code: 'NAME_INVALID', message: 'Malformed lock request.' };
  if (kdf.alg !== 'PBKDF2-SHA256') return { code: 'NAME_INVALID', message: 'Unsupported key derivation.' };
  if (!Number.isInteger(kdf.iterations) || kdf.iterations < 100000 || kdf.iterations > 5000000) {
    return { code: 'NAME_INVALID', message: 'Unsupported iteration count.' };
  }
  if (!isB64(kdf.salt, 32)) return { code: 'NAME_INVALID', message: 'Malformed lock request.' };
  if (!isB64(lock.verifier, 32)) return { code: 'NAME_INVALID', message: 'Malformed lock request.' };
  return null;
}

function sanitiseKdf(kdf) {
  return { alg: 'PBKDF2-SHA256', iterations: kdf.iterations, salt: kdf.salt };
}

module.exports = {
  isB64,
  b64len,
  validateRoomEnvelope,
  sanitiseRoomEnvelope,
  validateSealedEnvelope,
  sanitiseSealedEnvelope,
  validateLock,
  sanitiseKdf,
};
