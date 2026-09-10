// src/messages/history.js — the per-room in-memory ring buffer, and the burn
// timers armed against it.
//
// The buffer is NOT a browsable window and no client can read it back. It
// exists only so a reaction, edit, reply or unsend can resolve a message that
// is still on somebody's screen. What a joining client receives comes from the
// repository and is governed by HISTORY_REPLAY.
'use strict';

const config = require('../config');
const { hub } = require('../state/hub');

function push(room, message) {
  room.history.push(message);
  if (room.history.length > config.HISTORY_CAP) {
    room.history.splice(0, room.history.length - config.HISTORY_CAP);
  }
  return message;
}

function find(room, id) {
  if (!room || !id) return null;
  for (let i = room.history.length - 1; i >= 0; i--) {
    if (room.history[i].id === id) return room.history[i];
  }
  return null;
}

function drop(room, id) {
  const i = room.history.findIndex((m) => m.id === id);
  if (i >= 0) room.history.splice(i, 1);
}

// Server-armed, so the fuse burns whether or not the sender is still connected.
function arm(room, message, seconds, onExpire) {
  const ttl = Math.min(config.MAX_BURN_S, Math.max(config.MIN_BURN_S, seconds));
  message.expiresAt = Date.now() + ttl * 1000;
  const timer = setTimeout(() => {
    room.burns.delete(message.id);
    drop(room, message.id);
    onExpire(message.id);
  }, ttl * 1000);
  if (timer.unref) timer.unref();
  room.burns.set(message.id, timer);
  return ttl;
}

function cancelBurn(room, id) {
  const timer = room.burns.get(id);
  if (timer) {
    clearTimeout(timer);
    room.burns.delete(id);
  }
}

function clearAllTimers() {
  for (const room of hub.rooms.values()) {
    for (const t of room.burns.values()) clearTimeout(t);
    room.burns.clear();
    for (const t of room.typing.values()) clearTimeout(t);
    room.typing.clear();
  }
}

module.exports = { push, find, drop, arm, cancelBurn, clearAllTimers };
