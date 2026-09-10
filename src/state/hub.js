// src/state/hub.js — all mutable server state, in one object, plus the
// factories for ids, colours and sessions. This module depends on nothing but
// config and node:crypto, so everything that holds state can point at the one
// hub without creating a require cycle.
'use strict';

const crypto = require('node:crypto');
const config = require('../config');

const hub = {
  clients: new Map(), // sessionId -> Session (every socket, named or not)
  names: new Map(), // lowercased name -> sessionId (server-global uniqueness)
  rooms: new Map(), // roomId -> Room
  startedAt: Date.now(),
};

let seq = 0;
function newId(prefix) {
  return `${prefix}_${(seq++ % 0xffffff).toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

// A name always gets the same hue, on every machine, with no coordination.
function colourFor(name) {
  const digest = crypto.createHash('sha1').update(String(name).toLowerCase()).digest();
  return ((digest[0] << 8) | digest[1]) % 360;
}

function createSession(ws, ip) {
  const now = Date.now();
  const session = {
    id: newId('s'),
    ws,
    name: null,
    colour: 0,
    state: 'active',
    alive: true,
    rtt: null,
    named: false,
    userId: null,
    room: null,
    connectedAt: now,
    joinedAt: null,
    bucket: { tokens: config.BUCKET_SIZE, lastRefill: now },
    ip: ip || 'unknown',
    pub: null, // base64 SPKI of this session's ECDH key, for sealed whispers
    sigPub: null, // base64 SPKI of this session's ECDSA signing key (requirement 5)
  };
  hub.clients.set(session.id, session);
  return session;
}

function createRoomRecord(name, createdBy, permanent = false) {
  return {
    id: String(name).toLowerCase(),
    name,
    history: [],
    polls: new Map(),
    typing: new Map(),
    burns: new Map(),
    createdAt: Date.now(),
    createdBy: createdBy || null,
    permanent: !!permanent,
    locked: false,
    kdf: null,
    verifier: null,
    keyEpoch: 0,
    lockedBy: null,
    lockedAt: null,
  };
}

// Every socket in a room. Deliberately a scan of hub.clients rather than a
// second index on the room: one index cannot drift out of step with itself.
function* occupants(roomId) {
  for (const session of hub.clients.values()) {
    if (session.room === roomId && session.named) yield session;
  }
}

function countIn(roomId) {
  let n = 0;
  for (const _ of occupants(roomId)) n++;
  return n;
}

function byName(name) {
  const id = hub.names.get(String(name).toLowerCase());
  return id ? hub.clients.get(id) : undefined;
}

module.exports = { hub, newId, colourFor, createSession, createRoomRecord, occupants, countIn, byName };
