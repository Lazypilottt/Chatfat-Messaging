// src/transport/websocket.js — upgrade policy, frame dispatch, session
// lifecycle, and the heartbeat reaper.
//
// "Graceful handling of client disconnections" hides three failure modes, and
// only two of them fire a close event. The third — cable pulled, Wi-Fi off —
// leaves the socket OPEN forever and is caught by the sweep below. That is why
// the heartbeat is not optional.
'use strict';

const { WebSocketServer } = require('ws');
const config = require('../config');
const log = require('../logger');
const { hub, createSession } = require('../state/hub');
const { send, fail } = require('../protocol/frames');
const rooms = require('../rooms');
const handlers = require('./handlers');

// The frames a named client may send while it is still in the lobby.
const LOBBY_FRAMES = new Set(['pong', 'nick', 'presence', 'room:join', 'room:create', 'room:leave', 'key:publish']);

let wss = null;
let heartbeat = null;

function originAllowed(req) {
  const origin = req.headers.origin;
  // No Origin at all: a CLI client or the test suite. Allowed.
  if (!origin) return true;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  if (config.ALLOWED_ORIGINS.length) {
    return config.ALLOWED_ORIGINS.some((o) => o === origin || o === host);
  }
  return host === req.headers.host;
}

// Idempotent. A close frame, a socket error and the reaper all land here, often
// twice for the same session.
function removeSession(id, reason = 'left') {
  const session = hub.clients.get(id);
  if (!session) return;
  hub.clients.delete(id);

  // Release the name only if the index still points at THIS session.
  if (session.name) {
    const key = session.name.toLowerCase();
    if (hub.names.get(key) === id) hub.names.delete(key);
  }

  if (session.room) rooms.exitRoom(session, reason);
  if (session.named) rooms.pushRooms();
}

async function dispatch(session, raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return fail(session.ws, 'NOT_FOUND', 'Malformed frame.');
  }
  if (!frame || typeof frame !== 'object' || typeof frame.t !== 'string') {
    return fail(session.ws, 'NOT_FOUND', 'Frame is missing a type.');
  }
  if (frame.v !== undefined && frame.v !== config.PROTOCOL_VERSION) {
    return fail(session.ws, 'FORBIDDEN', `This server speaks protocol v${config.PROTOCOL_VERSION}.`);
  }

  const t = frame.t;
  if (!session.named && t !== 'join' && t !== 'pong') {
    return fail(session.ws, 'FORBIDDEN', 'Pick a username first.');
  }
  if (session.named && !session.room && !LOBBY_FRAMES.has(t)) {
    return fail(session.ws, 'FORBIDDEN', 'Join a room first.');
  }

  const handler = handlers[t];
  if (!handler) return fail(session.ws, 'NOT_FOUND', `Unknown frame type “${t}”.`);

  try {
    // A rejected promise is caught exactly as carefully as a throw.
    await handler(session, frame.d || {});
  } catch (err) {
    log.error(`handling ${t} failed:`, err && err.message);
    fail(session.ws, 'FORBIDDEN', 'The server could not process that.');
  }
}

function attach(server) {
  wss = new WebSocketServer({ noServer: true, maxPayload: config.MAX_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== config.WS_PATH) {
      socket.destroy();
      return;
    }
    if (!originAllowed(req)) {
      log.warn('refused a socket from origin', req.headers.origin);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    // With accounts on, the session cookie is checked HERE — before the socket
    // opens — rather than waiting for a `join` frame to carry a token. An
    // unauthenticated socket never exists.
    if (config.AUTH_ENABLED) {
      const { sessionFromHeaders } = require('../auth/betterauth');
      sessionFromHeaders(req.headers)
        .then((user) => {
          if (!user) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, user));
        })
        .catch(() => socket.destroy());
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, null));
  });

  wss.on('connection', (ws, req, user) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const session = createSession(ws, ip);
    session.user = user || null;

    // Sent before any join attempt, so the client never has to guess the
    // server's policy.
    send(ws, 'hello', {
      v: config.PROTOCOL_VERSION,
      serverTime: Date.now(),
      auth: config.AUTH_ENABLED,
      encryption: config.ENCRYPTION_ENABLED,
    });

    ws.on('message', (raw) => {
      session.alive = true; // ordinary traffic counts as proof of life
      dispatch(session, raw.toString());
    });
    ws.on('close', (code) => removeSession(session.id, code === 1000 ? 'left' : 'lost connection'));
    ws.on('error', () => removeSession(session.id, 'lost connection'));
    ws.on('pong', () => {
      session.alive = true;
    });
  });

  return wss;
}

function startHeartbeat() {
  heartbeat = setInterval(() => {
    const now = Date.now();
    for (const session of [...hub.clients.values()]) {
      // A socket that connects and never names itself cannot sit there forever.
      if (!session.named) {
        if (now - session.connectedAt > config.UNNAMED_GRACE_MS) {
          hub.clients.delete(session.id);
          session.ws.terminate();
        }
        continue;
      }
      // Still false from the previous round: nothing came back. This is the
      // pulled-cable case — no close event will ever arrive.
      if (session.alive === false) {
        removeSession(session.id, 'timed out');
        session.ws.terminate();
        continue;
      }
      session.alive = false;
      send(session.ws, 'ping', { t: now });
    }
    // Re-broadcast every occupied roster so the per-user RTT column stays live.
    for (const room of hub.rooms.values()) {
      let occupied = false;
      for (const s of hub.clients.values()) {
        if (s.room === room.id) {
          occupied = true;
          break;
        }
      }
      if (occupied) rooms.pushRoster(room.id);
    }
  }, config.HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref(); // or the process never exits
  return heartbeat;
}

function stopHeartbeat() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

function closeAll(code = 1001, reason = 'server going away') {
  for (const session of hub.clients.values()) {
    try {
      session.ws.close(code, reason);
    } catch {
      /* already gone */
    }
  }
}

module.exports = { attach, startHeartbeat, stopHeartbeat, removeSession, closeAll, originAllowed, LOBBY_FRAMES };
