// src/protocol/frames.js — the wire envelope, and the four ways a frame leaves
// this process. Every outbound frame is stamped here: the server owns `id` and
// `ts`, so client clocks are never trusted and every client renders the same order.
'use strict';

const config = require('../config');
const { hub, newId, occupants } = require('../state/hub');

const OPEN = 1; // ws.OPEN, without importing ws into the protocol layer

function frame(t, d, room) {
  const f = { v: config.PROTOCOL_VERSION, t, id: newId('f'), ts: Date.now() };
  if (room) f.room = room;
  f.d = d === undefined ? {} : d;
  return f;
}

function send(ws, t, d, room) {
  if (!ws || ws.readyState !== OPEN) return false;
  try {
    ws.send(JSON.stringify(frame(t, d, room)));
    return true;
  } catch {
    return false;
  }
}

// Serialise once, write the same bytes to every open socket in the room.
function broadcast(roomId, t, d, exceptSessionId) {
  const raw = JSON.stringify(frame(t, d, roomId));
  let n = 0;
  for (const session of occupants(roomId)) {
    if (session.id === exceptSessionId) continue;
    if (session.ws.readyState !== OPEN) continue;
    try {
      session.ws.send(raw);
      n++;
    } catch {
      /* the close handler will clean this session up */
    }
  }
  return n;
}

// Room-independent fan-out: the lobby's room list, which everybody sees.
function broadcastGlobal(t, d) {
  const raw = JSON.stringify(frame(t, d));
  let n = 0;
  for (const session of hub.clients.values()) {
    if (!session.named || session.ws.readyState !== OPEN) continue;
    try {
      session.ws.send(raw);
      n++;
    } catch {
      /* ditto */
    }
  }
  return n;
}

// An error frame NEVER closes the socket. The client stays usable and shows a toast.
function fail(ws, code, message) {
  return send(ws, 'error', { code, message });
}

module.exports = { frame, send, broadcast, broadcastGlobal, fail, OPEN };
