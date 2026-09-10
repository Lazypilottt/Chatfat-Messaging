// src/config.js — every tunable in the system. This is the ONLY module that
// reads process.env; everything else imports what it needs from here, so the
// set of things that can change behaviour is one file long.
'use strict';

require('./env').load();

const path = require('node:path');

const str = (k, dflt) => (process.env[k] === undefined || process.env[k] === '' ? dflt : String(process.env[k]));
const int = (k, dflt, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number.parseInt(process.env[k], 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};
const bool = (k, dflt) => {
  const v = process.env[k];
  if (v === undefined || v === '') return dflt;
  return !(v === '0' || v.toLowerCase() === 'false' || v.toLowerCase() === 'off');
};

// DATABASE_URL has four states, and the difference between two of them is the
// whole point of Lab 4 requirement 1:
//
//   postgres://…  durable storage. The deployed configuration.
//   memory        everything works, held in this process, lost on restart.
//   none          deliberately no persistence. The protocol suite uses this.
//   (unset)       you have not configured it yet — the server refuses to start.
//
// `unset` used to mean "silently store nothing", which is exactly the failure
// the lab forbids: a server that looks like it is working while every message
// disappears. Making the omission loud costs one env var and removes a class
// of demo-day surprise. `none` exists so that "no persistence" stays
// expressible — as a decision, rather than as an oversight.
const RAW_DATABASE_URL = str('DATABASE_URL', '');
const DATABASE_URL = RAW_DATABASE_URL === 'none' ? '' : RAW_DATABASE_URL;
const DATABASE_URL_SET = RAW_DATABASE_URL !== '';
const PERSISTENCE_ENABLED = !!DATABASE_URL;
const USE_POSTGRES = PERSISTENCE_ENABLED && DATABASE_URL !== 'memory';

// At-rest encryption keys — versioned so a rotated MASTER_KEY does not strand
// history sealed under the old one. `MASTER_KEYS=v1:<b64>,v2:<b64>` wins when
// set; a bare `MASTER_KEY` is shorthand for a single key at version 1. The
// CURRENT version (the highest number present) is what new writes encrypt
// under; every version present can still decrypt what it sealed.
//
// Validity (32 decoded bytes, for AES-256) is checked here so a malformed key
// is a parse error rather than a mysterious decrypt failure at message time.
// Presence is enforced by app.js at boot, not here — config.js only parses,
// it does not decide whether persistence requires a key.
function parseMasterKeys() {
  const map = new Map();
  const add = (version, b64) => {
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`MASTER_KEYS: "${version}" is not a valid key version — use v1, v2, …`);
    }
    let buf;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      buf = Buffer.alloc(0);
    }
    if (buf.length !== 32) {
      throw new Error(`MASTER_KEYS: key version ${version} decodes to ${buf.length} bytes, not the 32 AES-256 needs`);
    }
    map.set(version, buf);
  };

  const multi = str('MASTER_KEYS', '');
  if (multi) {
    for (const part of multi.split(',').map((s) => s.trim()).filter(Boolean)) {
      const at = part.indexOf(':');
      if (at < 1) throw new Error(`MASTER_KEYS: "${part}" is not "v<n>:<base64>"`);
      add(Number(part.slice(1, at).replace(/^v/i, '')), part.slice(at + 1));
    }
  } else {
    const single = str('MASTER_KEY', '');
    if (single) add(1, single);
  }
  return map;
}

const MASTER_KEYS = parseMasterKeys();
const MASTER_KEY_VERSION = MASTER_KEYS.size ? Math.max(...MASTER_KEYS.keys()) : 0;

module.exports = {
  // — environment —
  PORT: int('PORT', 3000, 1, 65535),
  HOST: str('HOST', '0.0.0.0'),
  ALLOWED_ORIGINS: str('ALLOWED_ORIGINS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Both set ⇒ the server terminates TLS itself (node:https instead of
  // node:http). Meant for a host with no reverse proxy and no real domain —
  // a self-signed pair still makes the origin "https://", which is what
  // WebCrypto and Better Auth's Secure cookies actually check for.
  TLS_CERT_FILE: str('TLS_CERT_FILE', ''),
  TLS_KEY_FILE: str('TLS_KEY_FILE', ''),
  DATABASE_URL,
  DATABASE_URL_SET,
  DATA_DIR: path.resolve(str('DATA_DIR', path.join(process.cwd(), 'data'))),
  // The minimum here is 0, not 1 — otherwise the off switch fails quietly.
  // Recording and replaying stay separate questions: a server can store every
  // message and still hand a joining client nothing. 50 is the default because
  // requirement 2 is "a user receives previous chat history", and a default of
  // 0 meant the shipped configuration did not satisfy it.
  HISTORY_REPLAY: int('HISTORY_REPLAY', 50, 0, 200),
  HISTORY_CAP: int('HISTORY_CAP', 200, 10, 5000),
  // One scrollback page. Also the ceiling: a client asking for more gets this.
  HISTORY_PAGE: int('HISTORY_PAGE', 50, 1, 200),
  MAX_ROOMS: int('MAX_ROOMS', 24, 1, 500),
  HEARTBEAT_MS: int('HEARTBEAT_MS', 15000, 1000),
  AUTH_MAX_ATTEMPTS: int('AUTH_MAX_ATTEMPTS', 10, 1),
  ENCRYPTION_ENABLED: bool('ENCRYPTION_ENABLED', true),
  // Better Auth. The secret signs session cookies; a fixed dev default would
  // mean every deployment that forgot to set one shared it, so app.js refuses
  // to start with the placeholder when a database is configured.
  BETTER_AUTH_SECRET: str('BETTER_AUTH_SECRET', ''),
  BETTER_AUTH_URL: str('BETTER_AUTH_URL', `http://localhost:${int('PORT', 3000, 1, 65535)}`),
  MAX_CIPHERTEXT: int('MAX_CIPHERTEXT', 12288, 1024, 1024 * 1024),
  // At-rest encryption of stored message text (requirement 3) and its keys
  // (requirement 4 rides on the same AEAD tag — see src/crypto/atRest.js).
  MASTER_KEYS,
  MASTER_KEY_VERSION,

  // — derived —
  PERSISTENCE_ENABLED,
  USE_POSTGRES,
  // Accounts need Postgres specifically, not merely "some storage": Better
  // Auth persists users, sessions and credentials in real tables. So `memory`
  // means messages are stored but a username is still only a claim, and
  // Postgres is the only mode where identity is real.
  AUTH_ENABLED: USE_POSTGRES,

  // — compile-time constants —
  PROTOCOL_VERSION: 2, // bumped from 1 by the encryption work (SPEC §14.10)
  // 32 KB, not 8: a 12 KB ciphertext base64-expands to ~16 KB and still has to
  // fit inside a frame. Leave this at 8 KB and every encrypted message closes
  // the socket (SPEC §17.3.14).
  MAX_PAYLOAD: 32 * 1024,
  MAX_TEXT: 2000,
  NAME_RE: /^[A-Za-z0-9 _.-]{2,16}$/,
  ROOM_RE: /^[A-Za-z0-9 _-]{2,24}$/,
  EMOJI: ['👍', '❤️', '😂', '🎉', '👀', '🔥'],
  DEFAULT_ROOMS: ['lab-room'],
  SAVE_DEBOUNCE_MS: 1000,
  EDIT_WINDOW_MS: 300000,
  MIN_BURN_S: 5,
  MAX_BURN_S: 300,
  TYPING_TTL_MS: 4000,
  UNNAMED_GRACE_MS: 30000,
  // Configurable rather than constant: the same bucket now governs scrollback
  // pages as well as chat, and both the pagination suite and the load tool
  // need to exercise volumes a human never produces. The defaults are
  // unchanged — burst 5, then one per second.
  BUCKET_SIZE: int('BUCKET_SIZE', 5, 1, 10000),
  BUCKET_REFILL_MS: int('BUCKET_REFILL_MS', 1000, 1, 60000),
  AUTH_WINDOW_MS: 60000,
  SESSION_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  MIN_PASSWORD: 8,
  MAX_PASSWORD: 200,
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),
  WS_PATH: '/ws',
};
