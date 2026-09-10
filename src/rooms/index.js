// src/rooms/index.js — room creation, occupancy, roster, typing, and the
// lobby/room transitions.
//
// Identity is global, content is not: a username is unique across the whole
// server, which is what lets /w reach somebody in another room. Everything
// else — messages, polls, typing, reactions — belongs to exactly one room.
'use strict';

const config = require('../config');
const log = require('../logger');
const { hub, createRoomRecord, occupants, countIn } = require('../state/hub');
const { send, broadcast, broadcastGlobal } = require('../protocol/frames');
const { repository } = require('../messages/repository');
const directory = require('./directory');

function createRoom(name, createdBy = null, permanent = false) {
  const id = String(name).toLowerCase();
  if (hub.rooms.has(id)) return hub.rooms.get(id);
  if (hub.rooms.size >= config.MAX_ROOMS) return null;
  const room = createRoomRecord(name, createdBy, permanent);
  hub.rooms.set(id, room);
  return room;
}

function getRoom(name) {
  if (typeof name !== 'string') return null;
  return hub.rooms.get(name.toLowerCase()) || null;
}

async function loadRooms() {
  return directory.load(createRoom);
}

// Busiest first, then alphabetically. This is the order the lobby renders.
function roomList() {
  return [...hub.rooms.values()]
    .map((r) => ({
      id: r.id,
      name: r.name,
      count: countIn(r.id),
      createdBy: r.createdBy,
      permanent: r.permanent,
      locked: r.locked,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function rosterOf(roomId) {
  return [...occupants(roomId)]
    .map((s) => ({
      id: s.id,
      name: s.name,
      colour: s.colour,
      state: s.state,
      rtt: s.rtt,
      typing: hub.rooms.get(roomId)?.typing.has(s.id) || false,
      pub: s.pub,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function typingNames(room) {
  const out = [];
  for (const id of room.typing.keys()) {
    const s = hub.clients.get(id);
    if (s && s.room === room.id && s.state === 'active') out.push(s.name);
  }
  return out.sort();
}

function pushRoster(roomId) {
  broadcast(roomId, 'roster', { users: rosterOf(roomId) });
}

function pushTyping(room) {
  broadcast(room.id, 'typing', { users: typingNames(room) });
}

function pushRooms() {
  broadcastGlobal('rooms', { rooms: roomList() });
}

// Public keys of everybody in the room, so sealed whispers have somewhere to go.
function pushKeys(roomId) {
  const users = [...occupants(roomId)]
    .filter((s) => s.pub)
    .map((s) => ({ id: s.id, name: s.name, pub: s.pub }));
  broadcast(roomId, 'keys', { users });
}

function clearTyping(session) {
  const room = session.room ? hub.rooms.get(session.room) : null;
  if (!room) return false;
  const timer = room.typing.get(session.id);
  if (!timer) return false;
  clearTimeout(timer);
  room.typing.delete(session.id);
  return true;
}

function armTyping(session, room) {
  const existing = room.typing.get(session.id);
  if (existing) clearTimeout(existing);
  // Expired server-side, so a client that vanished mid-keystroke leaves no
  // phantom "…is typing" behind it.
  const timer = setTimeout(() => {
    room.typing.delete(session.id);
    pushTyping(room);
  }, config.TYPING_TTL_MS);
  if (timer.unref) timer.unref();
  room.typing.set(session.id, timer);
}

// Order matters here. Typing is cleared while session.room is still set; then
// session.room is cleared BEFORE the leave notice goes out, so the leaver does
// not receive its own departure.
function exitRoom(session, reason = 'left') {
  const roomId = session.room;
  if (!roomId) return null;
  const room = hub.rooms.get(roomId);

  const wasTyping = clearTyping(session);
  session.room = null;
  session.joinedAt = null;

  if (room) {
    broadcast(roomId, 'system', { event: 'leave', user: session.name, colour: session.colour, reason });
    pushRoster(roomId);
    if (wasTyping) pushTyping(room);
    pushKeys(roomId);
  }
  return roomId;
}

async function enterRoom(session, room) {
  session.room = room.id;
  session.joinedAt = Date.now();

  let history;
  if (config.HISTORY_REPLAY > 0) {
    try {
      history = await repository.recent(room.id, config.HISTORY_REPLAY);
    } catch (err) {
      // A failed history read still lets the client in — it just arrives
      // without a backlog, which is the default experience anyway.
      log.warn('history replay failed:', err.message);
      history = [];
    }
    // The socket may have closed while we were away at the database.
    if (session.ws.readyState !== 1 || session.room !== room.id) return;
  }

  const payload = {
    room: {
      id: room.id,
      name: room.name,
      createdBy: room.createdBy,
      permanent: room.permanent,
      locked: room.locked,
      kdf: room.kdf,
      verifier: room.verifier,
      keyEpoch: room.keyEpoch,
      lockedBy: room.lockedBy,
    },
    roster: rosterOf(room.id),
    typing: typingNames(room),
    serverTime: Date.now(),
  };
  // `history` absent means this server does not replay. An empty array means
  // the room is quiet. Those are different states and the client tells them apart.
  if (history !== undefined) payload.history = history;

  send(session.ws, 'room:joined', payload, room.id);
  broadcast(room.id, 'system', { event: 'join', user: session.name, colour: session.colour }, session.id);
  pushRoster(room.id);
  pushKeys(room.id);
  pushRooms();
}

module.exports = {
  createRoom,
  getRoom,
  loadRooms,
  roomList,
  rosterOf,
  typingNames,
  pushRoster,
  pushTyping,
  pushRooms,
  pushKeys,
  clearTyping,
  armTyping,
  exitRoom,
  enterRoom,
  directory,
};
