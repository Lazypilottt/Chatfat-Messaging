// src/transport/handlers.js — one function per client frame type.
//
// Two rules run through the whole file:
//   1. Author checks are on `fromId`, never on `from`, or /nick becomes an
//      impersonation vector.
//   2. After EVERY await, re-check that the socket is still open and re-check
//      any uniqueness invariant — the socket may have closed and a second frame
//      may have raced past.
'use strict';

const config = require('../config');
const log = require('../logger');
const { hub, newId, colourFor, byName, occupants } = require('../state/hub');
const { send, broadcast, fail } = require('../protocol/frames');
const rooms = require('../rooms');
const history = require('../messages/history');
const polls = require('../messages/polls');
const { repository, detach } = require('../messages/repository');
const auth = require('../auth');
const envelope = require('../crypto/envelope');
const signature = require('../crypto/signature');
const {
  cleanText,
  cleanName,
  cleanRoomName,
  takeToken,
  resolveMentions,
  validPollShape,
} = require('../protocol/validation');

const OPEN = 1;
const alive = (session) => session.ws.readyState === OPEN;

// An ECDSA P-256 signature (raw r||s, see src/crypto/signature.js) is 64
// bytes — 88 base64 characters with padding. 150 leaves headroom without
// accepting something absurd.
const isValidSig = (s) => envelope.isB64(s) && s.length <= 150;

function claimName(session, name) {
  const key = name.toLowerCase();
  const holder = hub.names.get(key);
  if (holder && holder !== session.id) return false;
  if (session.name) hub.names.delete(session.name.toLowerCase());
  hub.names.set(key, session.id);
  session.name = name;
  session.colour = colourFor(name);
  return true;
}

function welcome(session) {
  send(session.ws, 'welcome', {
    you: { id: session.id, name: session.name, colour: session.colour },
    rooms: rooms.roomList(),
    serverTime: Date.now(),
    config: {
      maxText: config.MAX_TEXT,
      maxCiphertext: config.MAX_CIPHERTEXT,
      emoji: config.EMOJI,
      minBurn: config.MIN_BURN_S,
      maxBurn: config.MAX_BURN_S,
      editWindow: config.EDIT_WINDOW_MS,
      historyReplay: config.HISTORY_REPLAY,
      historyPage: config.HISTORY_PAGE,
      maxRooms: config.MAX_ROOMS,
      encryption: config.ENCRYPTION_ENABLED,
      kdfIterations: 250000,
    },
  });
  rooms.pushRooms();
}

// — join —

async function onJoin(session, d) {
  if (session.named) return fail(session.ws, 'FORBIDDEN', 'You have already joined.');

  if (config.AUTH_ENABLED) {
    // The identity was settled at the upgrade, from the session cookie. A
    // username in the payload is ignored entirely.
    const user = session.user;
    if (!user) return fail(session.ws, 'UNAUTHORIZED', 'Sign in again.');

    const holder = hub.names.get(user.name.toLowerCase());
    if (holder && holder !== session.id) {
      return fail(session.ws, 'NAME_TAKEN', 'That account is already connected here.');
    }
    // The immutable account id. `sender_id` everywhere downstream binds to
    // this, never to the display name, which /nick can change.
    session.userId = user.id;
    claimName(session, user.name);
  } else {
    const name = cleanName(d && d.username);
    if (!config.NAME_RE.test(name)) {
      return fail(session.ws, 'NAME_INVALID', 'Names are 2–16 letters, numbers, spaces, _ . or -');
    }
    if (!claimName(session, name)) return fail(session.ws, 'NAME_TAKEN', 'Somebody is already using that name.');
  }

  session.named = true;
  welcome(session);
}

// — identity —

async function onNick(session, d) {
  const name = cleanName(d && d.username);
  if (!config.NAME_RE.test(name)) {
    return fail(session.ws, 'NAME_INVALID', 'Names are 2–16 letters, numbers, spaces, _ . or -');
  }
  if (name.toLowerCase() === session.name.toLowerCase() && name === session.name) return;

  const holder = hub.names.get(name.toLowerCase());
  if (holder && holder !== session.id) return fail(session.ws, 'NAME_TAKEN', 'Somebody is already using that name.');

  const was = session.name;

  if (config.AUTH_ENABLED && session.userId) {
    // With accounts on this renames the ACCOUNT, so it survives sign-out.
    let ok;
    try {
      ok = await auth.renameUser(session.userId, name);
    } catch (err) {
      log.error('rename failed:', err.message);
      return fail(session.ws, 'UNAVAILABLE', 'The account store could not be reached.');
    }
    if (!alive(session)) return;
    // Re-check uniqueness AFTER the async write: another socket may have taken it.
    const holderNow = hub.names.get(name.toLowerCase());
    if (!ok || (holderNow && holderNow !== session.id)) {
      return fail(session.ws, 'NAME_TAKEN', 'Somebody is already using that name.');
    }
  }

  claimName(session, name);
  send(session.ws, 'you', { id: session.id, name: session.name, colour: session.colour });
  if (session.room) {
    broadcast(session.room, 'system', { event: 'rename', user: session.name, colour: session.colour, was });
    rooms.pushRoster(session.room);
  }
  rooms.pushRooms();
}

// — rooms —

async function onRoomCreate(session, d) {
  const name = cleanRoomName(d && d.room);
  if (!config.ROOM_RE.test(name)) {
    return fail(session.ws, 'NAME_INVALID', 'Room names are 2–24 letters, numbers, spaces, _ or -');
  }
  if (hub.rooms.has(name.toLowerCase())) return fail(session.ws, 'NAME_TAKEN', 'That room already exists.');
  if (hub.rooms.size >= config.MAX_ROOMS) {
    return fail(session.ws, 'FORBIDDEN', `This server hosts at most ${config.MAX_ROOMS} rooms.`);
  }

  let lock = null;
  if (d && d.lock) {
    if (!config.ENCRYPTION_ENABLED) {
      return fail(session.ws, 'ENCRYPTION_DISABLED', 'This server does not allow encrypted rooms.');
    }
    const bad = envelope.validateLock(d.lock);
    if (bad) return fail(session.ws, bad.code, bad.message);
    lock = d.lock;
  }

  const room = rooms.createRoom(name, session.name, false);
  if (!room) return fail(session.ws, 'FORBIDDEN', 'This server cannot host another room.');

  if (lock) {
    room.locked = true;
    room.kdf = envelope.sanitiseKdf(lock.kdf);
    room.verifier = lock.verifier;
    room.keyEpoch = 1;
    room.lockedBy = session.name;
    room.lockedAt = Date.now();
  }

  rooms.directory.save(room);
  if (session.room) rooms.exitRoom(session, 'left');
  await rooms.enterRoom(session, room); // creating a room auto-joins the creator
}

async function onRoomJoin(session, d) {
  const room = rooms.getRoom(cleanRoomName(d && d.room));
  if (!room) return fail(session.ws, 'NOT_FOUND', 'There is no room by that name.');
  if (session.room === room.id) return; // already there
  if (session.room) rooms.exitRoom(session, 'left');
  if (!alive(session)) return;
  await rooms.enterRoom(session, room);
}

function onRoomLeave(session) {
  if (session.room) rooms.exitRoom(session, 'left');
  send(session.ws, 'room:left', { room: null, rooms: rooms.roomList() });
  rooms.pushRooms();
}

// Only the creator may lock — or anyone in the room once the creator has gone.
// A locked room can never be unlocked back to plaintext: that would be a
// downgrade attack where members keep typing into the clear.
function onRoomLock(session, d) {
  if (!config.ENCRYPTION_ENABLED) {
    return fail(session.ws, 'ENCRYPTION_DISABLED', 'This server does not allow encrypted rooms.');
  }
  const room = hub.rooms.get(session.room);
  if (!room) return fail(session.ws, 'NOT_FOUND', 'You are not in a room.');

  const creatorPresent = room.createdBy && [...occupants(room.id)].some((s) => s.name === room.createdBy);
  const isCreator = room.createdBy === session.name;
  const isLocker = room.lockedBy === session.name;
  if (room.locked ? !isLocker && !isCreator : creatorPresent && !isCreator) {
    return fail(session.ws, 'FORBIDDEN', 'Only the person who created this room can lock it.');
  }

  const bad = envelope.validateLock(d);
  if (bad) return fail(session.ws, bad.code, bad.message);

  room.locked = true;
  room.kdf = envelope.sanitiseKdf(d.kdf);
  room.verifier = d.verifier;
  room.keyEpoch = (room.keyEpoch || 0) + 1; // rotation: old messages keep their kid
  room.lockedBy = session.name;
  room.lockedAt = Date.now();
  rooms.directory.save(room);

  broadcast(room.id, 'room:locked', {
    room: room.id,
    kdf: room.kdf,
    verifier: room.verifier,
    keyEpoch: room.keyEpoch,
    by: session.name,
  });
  broadcast(room.id, 'system', {
    event: 'lock',
    user: session.name,
    colour: session.colour,
    keyEpoch: room.keyEpoch,
  });
  rooms.pushRooms();
}

// — messages —

function buildReplyTo(room, replyToId, locked) {
  if (!replyToId) return null;
  const parent = history.find(room, replyToId);
  if (!parent || parent.unsent) return null; // a reply to an unsent message is dropped, not an error
  return {
    id: parent.id,
    from: parent.from,
    colour: parent.colour,
    // In a locked room the quote text is NOT sent by the server — it has none.
    // The client renders the quote from its own decrypted copy of the parent.
    text: locked ? '' : parent.text.slice(0, 140),
  };
}

async function onChat(session, d) {
  const room = hub.rooms.get(session.room);
  if (!room) return fail(session.ws, 'NOT_FOUND', 'You are not in a room.');
  if (!takeToken(session)) return fail(session.ws, 'RATE_LIMIT', 'Slow down a moment.');

  const hasEnc = d && d.enc !== undefined && d.enc !== null;

  if (room.locked) {
    if (!hasEnc) return fail(session.ws, 'ENCRYPTION_REQUIRED', 'This room is encrypted — unlock it to send.');
    if (typeof d.text === 'string' && d.text.length) {
      return fail(session.ws, 'ENCRYPTION_REQUIRED', 'This room is encrypted — plaintext is refused.');
    }
  } else if (hasEnc) {
    return fail(session.ws, 'FORBIDDEN', 'This room is not encrypted.');
  }

  let text = '';
  let enc = null;
  if (hasEnc) {
    const bad = envelope.validateRoomEnvelope(d.enc);
    if (bad) return fail(session.ws, bad.code, bad.message);
    enc = envelope.sanitiseRoomEnvelope(d.enc);
  } else {
    text = cleanText(d && d.text);
    if (!text) return; // empty is silently dropped
    if (text.length > config.MAX_TEXT) {
      return fail(session.ws, 'TOO_LONG', `Messages are ${config.MAX_TEXT} characters or fewer.`);
    }
  }

  // Requirements 5 + 6: every sender signs, and the signature is verified
  // before the message goes anywhere — not decoration after the fact. The
  // signed payload is exactly {room, from, text, enc} as just computed above,
  // built identically on both sides — see src/crypto/signature.js.
  if (!session.sigPub) {
    return fail(session.ws, 'SIGNATURE_REQUIRED', 'No signing key on file yet for this connection — try again in a moment.');
  }
  const sig = d && d.sig;
  if (!isValidSig(sig)) {
    return fail(session.ws, 'SIGNATURE_REQUIRED', 'This message is missing a valid signature.');
  }
  if (!signature.verify(session.sigPub, sig, { room: room.id, from: session.name, text, enc })) {
    return fail(session.ws, 'FORBIDDEN', 'Signature does not verify.');
  }

  const message = {
    kind: 'chat',
    id: newId('m'),
    ts: Date.now(),
    from: session.name,
    fromId: session.id,
    colour: session.colour,
    text,
    action: !!(d && d.action),
    replyTo: buildReplyTo(room, d && d.replyTo, room.locked),
    // Mentions cannot be resolved server-side for an encrypted message: the
    // client parses them from its own plaintext and puts them inside the
    // ciphertext. In a locked room this stays [].
    mentions: room.locked ? [] : resolveMentions(text, room.id, session.id),
    reactions: {},
    editedAt: null,
    unsent: false,
    enc,
    sig,
    sigPub: session.sigPub,
  };

  const ttl = Number(d && d.ttl);
  if (Number.isFinite(ttl) && ttl > 0) {
    history.arm(room, message, Math.round(ttl), (id) => {
      broadcast(room.id, 'expired', { id });
      detach(repository.remove(id), 'a burn removal');
    });
  }

  history.push(room, message);
  if (session.state !== 'active') {
    session.state = 'active';
    rooms.pushRoster(room.id);
  }
  broadcast(room.id, 'chat', message);
  detach(repository.save(room.id, message), 'a message');
}

// — history —

// Scrollback. The client sends the (ts, id) of the oldest message it holds and
// gets the page strictly before it. Both `done` and an empty array are needed:
// an empty page means "nothing more", but the client must also be able to tell
// a server that does not replay from a room that is simply quiet.
async function onHistoryMore(session, d) {
  const room = hub.rooms.get(session.room);
  if (!room) return fail(session.ws, 'NOT_FOUND', 'You are not in a room.');
  if (!config.HISTORY_REPLAY) return fail(session.ws, 'FORBIDDEN', 'This server does not replay history.');
  // Same bucket as chat: a scroll loop must not become a way to hammer the
  // database from a single socket.
  if (!takeToken(session)) return fail(session.ws, 'RATE_LIMIT', 'Slow down a moment.');

  const limit = Math.min(Math.max(Number(d && d.limit) || config.HISTORY_PAGE, 1), config.HISTORY_PAGE);

  let cursor = null;
  if (d && d.before && typeof d.before === 'object') {
    const ts = Number(d.before.ts);
    const id = d.before.id;
    // A malformed cursor is refused rather than silently treated as "from the
    // top" — that would hand back the newest page and look like a duplicate.
    if (!Number.isFinite(ts) || typeof id !== 'string' || !id) {
      return fail(session.ws, 'NAME_INVALID', 'Malformed history cursor.');
    }
    cursor = { ts, id };
  }

  let page;
  try {
    page = await repository.before(room.id, cursor, limit);
  } catch (err) {
    log.warn('history page failed:', err.message);
    return fail(session.ws, 'UNAVAILABLE', 'Could not load earlier messages.');
  }
  // The socket may have closed, or the user may have changed rooms, while we
  // were away at the database.
  if (!alive(session) || session.room !== room.id) return;

  send(session.ws, 'history:page', {
    room: room.id,
    messages: page,
    done: page.length < limit,
  });
}

async function onDm(session, d) {
  if (!takeToken(session)) return fail(session.ws, 'RATE_LIMIT', 'Slow down a moment.');

  const target = byName(cleanName(d && d.to));
  if (!target || !target.named) return fail(session.ws, 'NOT_FOUND', 'Nobody here goes by that name.');
  if (target.id === session.id) return fail(session.ws, 'FORBIDDEN', 'You cannot whisper to yourself.');

  const hasEnc = d && d.enc !== undefined && d.enc !== null;
  let text = '';
  let enc = null;

  if (hasEnc) {
    const bad = envelope.validateSealedEnvelope(d.enc);
    if (bad) return fail(session.ws, bad.code, bad.message);
    enc = envelope.sanitiseSealedEnvelope(d.enc);
  } else {
    text = cleanText(d && d.text);
    if (!text) return;
    if (text.length > config.MAX_TEXT) {
      return fail(session.ws, 'TOO_LONG', `Messages are ${config.MAX_TEXT} characters or fewer.`);
    }
  }

  // Never written to history or the database. Echoed back to the sender so
  // both parties see it.
  const payload = {
    id: newId('p'),
    ts: Date.now(),
    from: session.name,
    colour: session.colour,
    to: target.name,
    toColour: target.colour,
    text,
    enc,
  };
  send(target.ws, 'dm', payload);
  send(session.ws, 'dm', payload);
}

function onTyping(session, d) {
  const room = hub.rooms.get(session.room);
  if (!room) return;
  const on = !!(d && d.on);
  if (on) {
    rooms.armTyping(session, room);
  } else if (!rooms.clearTyping(session)) {
    return;
  }
  rooms.pushTyping(room);
}

function onReact(session, d) {
  const room = hub.rooms.get(session.room);
  if (!room) return fail(session.ws, 'NOT_FOUND', 'You are not in a room.');
  const emoji = d && d.emoji;
  if (!config.EMOJI.includes(emoji)) return fail(session.ws, 'FORBIDDEN', 'That is not one of the reactions.');

  const message = history.find(room, d && d.id);
  if (!message || message.unsent) return fail(session.ws, 'NOT_FOUND', 'That message is gone.');

  const list = message.reactions[emoji] || [];
  const at = list.indexOf(session.name);
  if (at >= 0) list.splice(at, 1);
  else list.push(session.name);

  if (list.length) message.reactions[emoji] = list;
  else delete message.reactions[emoji];

  broadcast(room.id, 'react', { id: message.id, emoji, users: list });
  detach(repository.update(message.id, { reactions: message.reactions }), 'a reaction');
}

function onEdit(session, d) {
  const room = hub.rooms.get(session.room);
  if (!room) return fail(session.ws, 'NOT_FOUND', 'You are not in a room.');

  const message = history.find(room, d && d.id);
  if (!message || message.unsent) return fail(session.ws, 'NOT_FOUND', 'That message is gone.');
  // fromId, not from: /nick must not become a way to claim somebody's message.
  if (message.fromId !== session.id) return fail(session.ws, 'FORBIDDEN', 'You can only edit your own messages.');
  if (Date.now() - message.ts > config.EDIT_WINDOW_MS) {
    return fail(session.ws, 'FORBIDDEN', 'That message is too old to edit.');
  }

  const hasEnc = d && d.enc !== undefined && d.enc !== null;
  if (room.locked !== hasEnc) {
    return room.locked
      ? fail(session.ws, 'ENCRYPTION_REQUIRED', 'This room is encrypted — unlock it to edit.')
      : fail(session.ws, 'FORBIDDEN', 'This room is not encrypted.');
  }

  let newText;
  let newEnc;
  let newMentions;
  if (hasEnc) {
    const bad = envelope.validateRoomEnvelope(d.enc);
    if (bad) return fail(session.ws, bad.code, bad.message);
    newEnc = envelope.sanitiseRoomEnvelope(d.enc);
    newText = '';
    newMentions = [];
  } else {
    newText = cleanText(d.text);
    if (!newText) return;
    if (newText.length > config.MAX_TEXT) {
      return fail(session.ws, 'TOO_LONG', `Messages are ${config.MAX_TEXT} characters or fewer.`);
    }
    newEnc = null;
    newMentions = resolveMentions(newText, room.id, session.id);
  }

  // Requirements 5 + 6, same gate as onChat: the edit is re-signed over its
  // NEW content and re-verified before it is applied. The signed `from` is
  // the message's original author name, not necessarily session.name — a
  // rename between the original send and this edit must not change what the
  // edit's signature is checked against.
  if (!session.sigPub) {
    return fail(session.ws, 'SIGNATURE_REQUIRED', 'No signing key on file yet for this connection — try again in a moment.');
  }
  const sig = d && d.sig;
  if (!isValidSig(sig)) {
    return fail(session.ws, 'SIGNATURE_REQUIRED', 'This edit is missing a valid signature.');
  }
  if (!signature.verify(session.sigPub, sig, { room: room.id, from: message.from, text: newText, enc: newEnc })) {
    return fail(session.ws, 'FORBIDDEN', 'Signature does not verify.');
  }

  message.text = newText;
  message.enc = newEnc;
  message.mentions = newMentions;
  message.sig = sig;
  message.sigPub = session.sigPub;
  message.editedAt = Date.now();

  broadcast(room.id, 'edited', {
    id: message.id,
    text: message.text,
    editedAt: message.editedAt,
    mentions: message.mentions,
    enc: message.enc,
    sig: message.sig,
    sigPub: message.sigPub,
  });
  detach(
    repository.update(message.id, {
      text: message.text,
      editedAt: message.editedAt,
      mentions: message.mentions,
      enc: message.enc,
      sig: message.sig,
      sigPub: message.sigPub,
    }),
    'an edit',
  );
}

function onUnsend(session, d) {
  const room = hub.rooms.get(session.room);
  if (!room) return fail(session.ws, 'NOT_FOUND', 'You are not in a room.');

  const message = history.find(room, d && d.id);
  if (!message) return fail(session.ws, 'NOT_FOUND', 'That message is gone.');
  if (message.fromId !== session.id) return fail(session.ws, 'FORBIDDEN', 'You can only unsend your own messages.');

  message.unsent = true;
  message.text = '';
  message.enc = null;
  message.reactions = {};
  message.mentions = [];
  history.cancelBurn(room, message.id);
  delete message.expiresAt;

  // Kept as a tombstone: an unsend has to differ from a message that never existed.
  broadcast(room.id, 'unsent', { id: message.id });
  detach(repository.update(message.id, { unsent: true, text: '', reactions: {}, mentions: [], enc: null }), 'an unsend');
}

// — polls —

function onPollNew(session, d) {
  const room = hub.rooms.get(session.room);
  if (!room) return fail(session.ws, 'NOT_FOUND', 'You are not in a room.');
  if (!takeToken(session)) return fail(session.ws, 'RATE_LIMIT', 'Slow down a moment.');

  let poll;
  if (room.locked) {
    // In a locked room the question and the labels are one envelope. Votes are
    // by index, so the server tallies without reading anything.
    const bad = envelope.validateRoomEnvelope(d && d.enc);
    if (bad) return fail(session.ws, bad.code, bad.message);
    const n = Number(d && d.count);
    if (!Number.isInteger(n) || n < 2 || n > 5) return fail(session.ws, 'NAME_INVALID', 'A poll needs 2–5 options.');
    poll = polls.create({
      q: '',
      options: new Array(n).fill(''),
      by: session.name,
      colour: session.colour,
      enc: envelope.sanitiseRoomEnvelope(d.enc),
    });
  } else {
    const bad = validPollShape(d && d.q, d && d.options);
    if (bad) return fail(session.ws, 'NAME_INVALID', bad);
    poll = polls.create({
      q: cleanText(d.q),
      options: d.options.map((o) => cleanText(o)).filter(Boolean),
      by: session.name,
      colour: session.colour,
    });
  }

  room.polls.set(poll.id, poll);
  broadcast(room.id, 'poll:state', polls.serialize(poll));
}

function onPollVote(session, d) {
  const room = hub.rooms.get(session.room);
  if (!room) return fail(session.ws, 'NOT_FOUND', 'You are not in a room.');
  const poll = room.polls.get(d && d.id);
  if (!poll) return fail(session.ws, 'NOT_FOUND', 'That poll is gone.');
  if (poll.closed) return fail(session.ws, 'FORBIDDEN', 'That poll is closed.');
  if (!polls.vote(poll, session.name, d && d.choice)) {
    return fail(session.ws, 'FORBIDDEN', 'That is not one of the options.');
  }
  // Broadcast whole, never as a delta, so the tally can never drift apart.
  broadcast(room.id, 'poll:state', polls.serialize(poll));
}

function onPollClose(session, d) {
  const room = hub.rooms.get(session.room);
  if (!room) return fail(session.ws, 'NOT_FOUND', 'You are not in a room.');
  const poll = room.polls.get(d && d.id);
  if (!poll) return fail(session.ws, 'NOT_FOUND', 'That poll is gone.');
  if (poll.by !== session.name) return fail(session.ws, 'FORBIDDEN', 'Only the author can close a poll.');
  poll.closed = true;
  broadcast(room.id, 'poll:state', polls.serialize(poll));
}

// — presence, heartbeat, keys —

function onPresence(session, d) {
  const state = d && d.state === 'away' ? 'away' : 'active';
  if (state === session.state) return;
  session.state = state;
  if (state === 'away' && session.room) {
    const room = hub.rooms.get(session.room);
    if (rooms.clearTyping(session) && room) rooms.pushTyping(room);
  }
  if (session.room) rooms.pushRoster(session.room);
}

function onPong(session, d) {
  const sent = Number(d && d.t);
  if (Number.isFinite(sent)) session.rtt = Math.max(0, Date.now() - sent);
  send(session.ws, 'rtt', { rtt: session.rtt });
}

// Publishes one or both of a session's public keys: `pub` (ECDH, for sealed
// whispers) and `sigPub` (ECDSA, for signing chat/edits — requirement 5).
// Either may arrive alone or together; the client currently always sends
// both at once, generated together on connect.
function onKeyPublish(session, d) {
  const pub = d && d.pub;
  const sigPub = d && d.sigPub;
  if (pub !== undefined && (!envelope.isB64(pub) || pub.length > 400)) {
    return fail(session.ws, 'FORBIDDEN', 'Malformed public key.');
  }
  if (sigPub !== undefined && (!envelope.isB64(sigPub) || sigPub.length > 400)) {
    return fail(session.ws, 'FORBIDDEN', 'Malformed signing key.');
  }
  if (pub !== undefined) session.pub = pub;
  if (sigPub !== undefined) session.sigPub = sigPub;
  if (session.room) {
    rooms.pushKeys(session.room);
    rooms.pushRoster(session.room);
  }
}

module.exports = {
  join: onJoin,
  nick: onNick,
  'room:create': onRoomCreate,
  'room:join': onRoomJoin,
  'room:leave': onRoomLeave,
  'room:lock': onRoomLock,
  chat: onChat,
  'history:more': onHistoryMore,
  dm: onDm,
  typing: onTyping,
  react: onReact,
  edit: onEdit,
  unsend: onUnsend,
  'poll:new': onPollNew,
  'poll:vote': onPollVote,
  'poll:close': onPollClose,
  presence: onPresence,
  pong: onPong,
  'key:publish': onKeyPublish,
};
