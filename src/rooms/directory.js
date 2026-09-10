// src/rooms/directory.js — room-directory persistence: Postgres or a debounced
// JSON file, chosen by the same DATABASE_URL as everything else.
//
// `createRoom` arrives as an injected argument rather than a require, to avoid
// a cycle with rooms/index.js.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const log = require('../logger');
const pool = require('../db/pool');
const { hub } = require('../state/hub');

const FILE = () => path.join(config.DATA_DIR, 'rooms.json');

let saveTimer = null;
let dirty = false;

function snapshot() {
  return [...hub.rooms.values()].map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    permanent: r.permanent,
    locked: r.locked,
    kdf: r.kdf,
    verifier: r.verifier,
    keyEpoch: r.keyEpoch,
    lockedBy: r.lockedBy,
    lockedAt: r.lockedAt,
  }));
}

function writeFileSyncSafe() {
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify({ rooms: snapshot() }, null, 2));
    dirty = false;
  } catch (err) {
    log.warn('could not write the room directory:', err.message);
  }
}

// — Postgres: per-room, immediate, and detached. The room already exists in
//   memory and is usable, so a slow database must not delay the user who
//   created it. Keeping room existence next to the messages is also what stops
//   the two diverging — losing a JSON file would orphan message rows.
function upsertPg(room) {
  pool
    .query(
      `insert into rooms (id, name, created_at, created_by, permanent, locked, kdf, verifier, key_epoch, locked_by, locked_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (id) do update set
         name = excluded.name, permanent = excluded.permanent, locked = excluded.locked,
         kdf = excluded.kdf, verifier = excluded.verifier, key_epoch = excluded.key_epoch,
         locked_by = excluded.locked_by, locked_at = excluded.locked_at`,
      [
        room.id,
        room.name,
        room.createdAt,
        room.createdBy,
        room.permanent,
        room.locked,
        room.kdf ? JSON.stringify(room.kdf) : null,
        room.verifier,
        room.keyEpoch,
        room.lockedBy,
        room.lockedAt,
      ],
    )
    .catch((err) => log.error('persisting the room directory failed:', err.message));
}

function save(room) {
  if (config.USE_POSTGRES) {
    if (room) upsertPg(room);
    else for (const r of hub.rooms.values()) upsertPg(r);
    return;
  }
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (dirty) writeFileSyncSafe();
  }, config.SAVE_DEBOUNCE_MS);
  if (saveTimer.unref) saveTimer.unref();
}

function flushSync() {
  if (config.USE_POSTGRES) return; // already committed
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirty) writeFileSyncSafe();
}

function applyRecord(room, rec) {
  room.locked = !!rec.locked;
  room.kdf = rec.kdf || null;
  room.verifier = rec.verifier || null;
  room.keyEpoch = Number(rec.keyEpoch || rec.key_epoch || 0);
  room.lockedBy = rec.lockedBy ?? rec.locked_by ?? null;
  room.lockedAt = rec.lockedAt ?? (rec.locked_at !== undefined && rec.locked_at !== null ? Number(rec.locked_at) : null);
  room.permanent = !!rec.permanent || room.permanent;
  if (rec.createdAt || rec.created_at) room.createdAt = Number(rec.createdAt || rec.created_at);
  if (rec.createdBy !== undefined) room.createdBy = rec.createdBy;
  if (rec.created_by !== undefined) room.createdBy = rec.created_by;
  return room;
}

async function load(createRoom) {
  let records = [];

  if (config.USE_POSTGRES) {
    const res = await pool.query('select * from rooms order by created_at asc nulls first');
    records = res.rows;
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (Array.isArray(parsed && parsed.rooms)) records = parsed.rooms;
    } catch (err) {
      // A corrupt or unreadable cache file is logged and ignored. A chat server
      // that refuses to boot over it would be worse than one that starts fresh.
      if (err.code !== 'ENOENT') log.warn('ignoring an unreadable room directory:', err.message);
    }
  }

  for (const rec of records) {
    const name = rec.name || rec.id;
    if (!name || typeof name !== 'string') continue;
    if (hub.rooms.size >= config.MAX_ROOMS) break;
    const room = createRoom(name, rec.createdBy || rec.created_by || null, !!rec.permanent);
    if (room) applyRecord(room, rec);
  }

  // Guarantee the defaults exist and are permanent, whatever the file said.
  for (const name of config.DEFAULT_ROOMS) {
    const existing = hub.rooms.get(name.toLowerCase());
    if (existing) existing.permanent = true;
    else createRoom(name, null, true);
  }

  save();
  return hub.rooms.size;
}

module.exports = { load, save, flushSync, snapshot };
