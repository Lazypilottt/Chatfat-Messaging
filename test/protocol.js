// test/protocol.js — the main suite. Runs with NO database: no accounts,
// nothing stored, nothing replayed.
//
// Covers room isolation, leaving and rejoining, the no-replay rule, broadcast
// ordering, duplicate usernames, XSS payloads, the token bucket, cross-room
// DMs, reactions, edit and unsend authorship including the /nick claim attempt,
// poll tallies including withdraw-by-revote, burn expiry, and all three
// disconnect paths — including the pulled cable, which fires no close event.
'use strict';

const { ok, eq, bail, report, startServer, client, sleep } = require('./harness');

const PORT = 8099;

async function main() {
  // HISTORY_REPLAY is pinned rather than inherited. This suite exercises the
  // no-storage, no-replay configuration deliberately, and since P1 the default
  // is 50 — a suite whose meaning changes when a default changes was never
  // asserting what it claimed to.
  const server = await startServer(PORT, { HEARTBEAT_MS: '700', MAX_ROOMS: '24', HISTORY_REPLAY: '0' });

  // ── hello, and the unnamed gate ──────────────────────────────────────────
  const a = await client(PORT);
  const hello = await a.next('hello');
  eq(hello.d.v, 2, 'hello announces protocol v2');
  eq(hello.d.auth, false, 'hello says accounts are off');
  eq(hello.d.encryption, true, 'hello says encryption is available');
  ok(typeof hello.d.serverTime === 'number', 'hello carries the server clock');

  // Raw, not a.send(): a.send('chat', ...) now waits for this client's own
  // signing key to be published, which never happens for a session that
  // never joins — this line is deliberately testing what the SERVER does
  // with a premature frame, the same reason the two lines below it bypass
  // the wrapper too.
  a.ws.send(JSON.stringify({ v: 2, t: 'chat', d: { text: 'too early' } }));
  const early = await a.next('error');
  eq(early.d.code, 'FORBIDDEN', 'an unnamed socket cannot chat');
  eq(early.d.message, 'Pick a username first.', 'and is told to pick a name');

  a.ws.send('{not json');
  eq((await a.next('error')).d.message, 'Malformed frame.', 'malformed JSON is answered, not fatal');

  a.ws.send(JSON.stringify({ v: 99, t: 'join', d: { username: 'x' } }));
  eq((await a.next('error')).d.code, 'FORBIDDEN', 'a protocol mismatch is refused');
  ok(a.ws.readyState === 1, 'and the socket stays open after every error');

  // ── names ────────────────────────────────────────────────────────────────
  a.send('join', { username: 'x' });
  eq((await a.next('error')).d.code, 'NAME_INVALID', 'a one-character name is refused');

  const welcomeA = await a.join('kavya');
  eq(welcomeA.d.you.name, 'kavya', 'join returns your identity');
  ok(typeof welcomeA.d.you.colour === 'number', 'and a deterministic colour');
  ok(Array.isArray(welcomeA.d.rooms), 'and the room list');
  ok(welcomeA.d.rooms.some((r) => r.id === 'lab-room'), 'the default room is seeded');


  const b = await client(PORT);
  await b.next('hello');
  b.send('join', { username: 'KAVYA' });
  eq((await b.next('error')).d.code, 'NAME_TAKEN', 'names are case-insensitively unique');
  await b.join('meera');

  const c = await client(PORT);
  await c.next('hello');
  await c.join('aravind');

  // Colour is derived from the name, so two sockets with the same name agree.
  const solo = await client(PORT);
  await solo.next('hello');
  const soloWelcome = await solo.join('kavya-2');
  ok(soloWelcome.d.you.colour >= 0 && soloWelcome.d.you.colour < 360, 'the colour is a hue in 0–360');
  solo.close();

  // ── the lobby gate ───────────────────────────────────────────────────────
  a.send('chat', { text: 'in the lobby' });
  eq((await a.next('error')).d.message, 'Join a room first.', 'a lobby client cannot chat');

  // ── rooms ────────────────────────────────────────────────────────────────
  a.send('room:join', { room: 'nowhere' });
  eq((await a.next('error')).d.code, 'NOT_FOUND', 'joining a missing room is NOT_FOUND');

  a.send('room:create', { room: '!' });
  eq((await a.next('error')).d.code, 'NAME_INVALID', 'a bad room name is refused');

  const joinedA = await a.create('Bench 2');
  eq(joinedA.d.room.name, 'Bench 2', 'the display casing is kept');
  eq(joinedA.d.room.id, 'bench 2', 'the id is the lower-cased name');
  eq(joinedA.d.roster.length, 1, 'the creator is auto-joined');
  eq(joinedA.d.history, undefined, 'no history key at all when the server does not replay');

  // Gate order: not-named, then no-room, and only then unknown-type — so this
  // reports NOT_FOUND only from inside a room.
  a.drain().send('nonsense-type');
  eq((await a.next('error')).d.code, 'NOT_FOUND', 'an unknown frame type is NOT_FOUND');

  b.send('room:create', { room: 'bench 2' });
  eq((await b.next('error')).d.code, 'NAME_TAKEN', 'duplicate room names are refused');

  await b.enter('Bench 2');
  const sysJoin = await a.next('system');
  eq(sysJoin.d.event, 'join', 'the room is told about an arrival');
  eq(sysJoin.d.user, 'meera', 'by name');

  const rosterA = a.typed('roster').pop();
  eq(rosterA.d.users.length, 2, 'the roster carries both members');

  await c.enter('lab-room');

  // ── room isolation ───────────────────────────────────────────────────────
  b.send('chat', { text: 'only bench 2 hears this' });
  const heard = await a.next('chat');
  eq(heard.d.text, 'only bench 2 hears this', 'a message reaches the room');
  eq(heard.d.from, 'meera', 'attributed to its author');
  eq(heard.room, 'bench 2', 'and is stamped with the room');
  ok(typeof heard.d.id === 'string' && heard.d.id.startsWith('m_'), 'the server stamps the message id');
  ok(heard.d.ts > 0, 'and the timestamp');

  await sleep(150);
  eq(c.typed('chat').length, 0, 'another room hears nothing');

  // ── ordering — on a fresh socket, whose bucket is exactly one burst ───────
  const burst = await client(PORT);
  await burst.next('hello');
  await burst.join('burst');
  await burst.enter('Bench 2');
  await a.next('system');
  for (let i = 0; i < 5; i++) burst.send('chat', { text: 'ordered-' + i });
  await sleep(500);
  eq(burst.typed('error').length, 0, 'a burst of exactly five is not rate-limited');
  const ordered = a.typed('chat').filter((f) => f.d.text.startsWith('ordered-'));
  eq(ordered.length, 5, 'every broadcast arrives');
  eq(ordered.map((f) => f.d.text).join(','), 'ordered-0,ordered-1,ordered-2,ordered-3,ordered-4', 'in send order');

  // ── XSS: markup is data, never markup ────────────────────────────────────
  const payload = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  burst.close();
  await b.refill();
  b.drain();
  b.send('chat', { text: payload });
  await sleep(250);
  const xss = a.typed('chat').pop();
  eq(xss.d.text, payload, 'a script payload survives verbatim as text and is never interpreted');

  // ── mentions, resolved server-side ───────────────────────────────────────
  b.send('chat', { text: 'ping @kavya and @nobody-here' });
  await sleep(200);
  const mentioned = a.typed('chat').pop();
  eq(mentioned.d.mentions.length, 1, 'only people in the room are mentioned');
  eq(mentioned.d.mentions[0], 'kavya', 'and resolved to their real display name');

  // ── replies ──────────────────────────────────────────────────────────────
  const parentId = mentioned.d.id;
  a.send('chat', { text: 'answering that', replyTo: parentId });
  await sleep(200);
  const reply = a.typed('chat').pop();
  ok(reply.d.replyTo !== null, 'a reply carries its parent');
  eq(reply.d.replyTo.id, parentId, 'by id');
  eq(reply.d.replyTo.from, 'meera', 'with the parent author');

  a.send('chat', { text: 'orphan', replyTo: 'm_doesnotexist' });
  await sleep(200);
  eq(a.typed('chat').pop().d.replyTo, null, 'a reply to a missing message drops the quote, not the message');

  // ── reactions ────────────────────────────────────────────────────────────
  a.send('react', { id: parentId, emoji: '🔥' });
  const react1 = await a.next('react');
  eq(react1.d.users.join(','), 'kavya', 'a reaction records who reacted');
  b.send('react', { id: parentId, emoji: '🔥' });
  await sleep(150);
  eq(a.typed('react').pop().d.users.length, 2, 'a second reactor is added');
  a.send('react', { id: parentId, emoji: '🔥' });
  await sleep(150);
  eq(a.typed('react').pop().d.users.join(','), 'meera', 'reacting again toggles you out');
  a.drain().send('react', { id: parentId, emoji: '🦄' });
  eq((await a.next('error')).d.code, 'FORBIDDEN', 'only the server’s emoji set is allowed');

  // ── edit / unsend authorship ─────────────────────────────────────────────
  await a.refill();
  a.send('chat', { text: 'mine to edit' });
  await sleep(200);
  const mine = a.typed('chat').pop().d;
  a.send('edit', { id: mine.id, text: 'edited by me' });
  const edited = await a.next('edited');
  eq(edited.d.text, 'edited by me', 'an author can edit');
  ok(edited.d.editedAt > 0, 'and the edit is stamped');

  b.drain().send('edit', { id: mine.id, text: 'stolen' });
  eq((await b.next('error')).d.code, 'FORBIDDEN', 'a non-author cannot edit');

  // The claim attempt: rename to the author's name and try again. The check is
  // on fromId, so it must still fail.
  b.drain().send('nick', { username: 'kavya' });
  eq((await b.next('error')).d.code, 'NAME_TAKEN', 'you cannot take a live name');
  a.send('nick', { username: 'kavya-old' });
  await a.next('you');
  b.send('nick', { username: 'kavya' });
  await b.next('you');
  b.drain().send('edit', { id: mine.id, text: 'claimed by rename' });
  eq((await b.next('error')).d.code, 'FORBIDDEN', 'renaming to the author’s name does NOT grant edit rights');
  b.drain().send('unsend', { id: mine.id });
  eq((await b.next('error')).d.code, 'FORBIDDEN', 'nor unsend rights');
  b.send('nick', { username: 'meera' });
  await b.next('you');

  a.send('unsend', { id: mine.id });
  const unsent = await a.next('unsent');
  eq(unsent.d.id, mine.id, 'an author can unsend');
  a.drain().send('react', { id: mine.id, emoji: '👍' });
  eq((await a.next('error')).d.code, 'NOT_FOUND', 'an unsent message cannot be reacted to');

  // ── private messages, across rooms ───────────────────────────────────────
  await a.refill();
  a.send('dm', { to: 'aravind', text: 'reaching another room' });
  const dmIn = await c.next('dm');
  eq(dmIn.d.text, 'reaching another room', 'a whisper crosses rooms');
  eq(dmIn.d.from, 'kavya-old', 'from the right person');
  const dmEcho = await a.next('dm');
  eq(dmEcho.d.to, 'aravind', 'and is echoed to the sender so both see it');

  a.drain().send('dm', { to: 'kavya-old', text: 'talking to myself' });
  eq((await a.next('error')).d.code, 'FORBIDDEN', 'you cannot whisper yourself');
  a.drain().send('dm', { to: 'ghost', text: 'hello?' });
  eq((await a.next('error')).d.code, 'NOT_FOUND', 'nor a name nobody holds');

  await sleep(150);
  eq(b.typed('dm').length, 0, 'a whisper reaches nobody else');

  // ── typing ───────────────────────────────────────────────────────────────
  b.send('typing', { on: true });
  const typing = await a.next('typing');
  eq(typing.d.users.join(','), 'meera', 'typing is broadcast');
  b.send('typing', { on: false });
  await sleep(150);
  eq(a.typed('typing').pop().d.users.length, 0, 'and cleared on demand');

  // ── polls ────────────────────────────────────────────────────────────────
  await b.refill();
  b.send('poll:new', { q: 'Lunch?', options: ['Idli', 'Dosa', 'Skip'] });
  const poll = (await a.next('poll:state')).d;
  eq(poll.options.length, 3, 'a poll carries its options');
  eq(poll.total, 0, 'and starts empty');

  b.drain().send('poll:new', { q: 'Only one?', options: ['a'] });
  eq((await b.next('error')).d.code, 'NAME_INVALID', 'a poll needs at least two options');

  a.send('poll:vote', { id: poll.id, choice: 0 });
  await sleep(150);
  let tallied = a.typed('poll:state').pop().d;
  eq(tallied.tally[0], 1, 'a vote lands');
  b.send('poll:vote', { id: poll.id, choice: 1 });
  await sleep(150);
  tallied = a.typed('poll:state').pop().d;
  eq(tallied.total, 2, 'two voters');
  a.send('poll:vote', { id: poll.id, choice: 1 });
  await sleep(150);
  tallied = a.typed('poll:state').pop().d;
  eq(tallied.tally[0], 0, 'a different option moves the vote');
  eq(tallied.tally[1], 2, 'to the new option');
  a.send('poll:vote', { id: poll.id, choice: 1 });
  await sleep(150);
  tallied = a.typed('poll:state').pop().d;
  eq(tallied.total, 1, 'voting the same option twice withdraws it');

  a.drain().send('poll:close', { id: poll.id });
  eq((await a.next('error')).d.code, 'FORBIDDEN', 'only the author closes a poll');
  b.send('poll:close', { id: poll.id });
  await sleep(150);
  eq(a.typed('poll:state').pop().d.closed, true, 'the author closes it');

  // ── burn ─────────────────────────────────────────────────────────────────
  await b.refill();
  b.send('chat', { text: 'door code 4417', ttl: 5 });
  await sleep(200);
  const burn = a.typed('chat').pop().d;
  ok(burn.expiresAt > Date.now(), 'a burn message carries its fuse');
  const expired = await a.next('expired', 9000);
  eq(expired.d.id, burn.id, 'and vanishes from every client when it fires');

  // ── the token bucket ─────────────────────────────────────────────────────
  const flooder = await client(PORT);
  await flooder.next('hello');
  await flooder.join('flooder');
  await flooder.enter('lab-room');
  for (let i = 0; i < 12; i++) flooder.send('chat', { text: 'flood ' + i });
  await sleep(400);
  const limited = flooder.typed('error').filter((f) => f.d.code === 'RATE_LIMIT');
  ok(limited.length > 0, 'the bucket empties under a flood');
  ok(flooder.ws.readyState === 1, 'and drops the message, never the socket');
  flooder.close();

  // ── over-long text ───────────────────────────────────────────────────────
  await b.refill();
  b.drain().send('chat', { text: 'z'.repeat(2001) });
  eq((await b.next('error')).d.code, 'TOO_LONG', 'over-long messages are refused');

  // ── leaving, rejoining, and the no-replay rule ───────────────────────────
  b.send('room:leave', {});
  const left = await b.next('room:left');
  ok(Array.isArray(left.d.rooms), 'leaving hands back a fresh room list');
  const leaveNotice = a.typed('system').pop();
  eq(leaveNotice.d.event, 'leave', 'the room is told about a departure');
  eq(leaveNotice.d.reason, 'left', 'with the reason');
  eq(b.typed('system').filter((f) => f.d.event === 'leave' && f.d.user === 'meera').length, 0,
     'the leaver does not receive its own departure notice');

  await a.refill();
  a.send('chat', { text: 'said while meera was away' });
  await sleep(200);
  const rejoined = await b.enter('Bench 2');
  eq(rejoined.d.history, undefined, 'rejoining replays nothing at all');
  await sleep(200);
  eq(b.typed('chat').filter((f) => f.d.text === 'said while meera was away').length, 0,
     'and nothing said while away is delivered');

  // ── /healthz ─────────────────────────────────────────────────────────────
  const health = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
  eq(health.ok, true, '/healthz answers');
  eq(health.auth, 'disabled', 'and reports accounts off');
  eq(health.persistence, 'nothing', 'and that nothing is stored');
  eq(health.historyReplay, 0, 'and that nothing is replayed');
  ok(health.rooms >= 2, 'and counts the rooms');
  ok(health.memory.rss > 0, 'and reports memory');

  // ── static serving cannot be walked out of ───────────────────────────────
  const escape = await fetch(`http://127.0.0.1:${PORT}/../package.json`);
  ok(escape.status === 403 || escape.status === 404, 'a path traversal attempt is refused');
  const index = await fetch(`http://127.0.0.1:${PORT}/`);
  eq(index.status, 200, 'the client is served at /');

  // ── disconnect path 1: a clean close ─────────────────────────────────────
  const quitter = await client(PORT);
  await quitter.next('hello');
  await quitter.join('quitter');
  a.drain();
  await quitter.enter('Bench 2');
  await a.next('system'); // the arrival
  quitter.close(1000);
  const cleanLeave = await a.next('system');
  eq(cleanLeave.d.reason, 'left', 'a clean close reports “left”');

  // ── disconnect path 2: the process is killed (TCP reset, code 1006) ──────
  const killed = await client(PORT);
  await killed.next('hello');
  await killed.join('killed');
  a.drain();
  await killed.enter('Bench 2');
  await a.next('system'); // the arrival
  killed.kill();
  const hardLeave = await a.next('system');
  eq(hardLeave.d.reason, 'lost connection', 'a killed browser reports “lost connection”');

  // ── disconnect path 3: the cable is pulled — NO close event ever fires ───
  const ghost = await client(PORT, { silent: true });
  await ghost.next('hello');
  await ghost.join('ghost');
  a.drain();
  await ghost.enter('Bench 2');
  await a.next('system'); // the arrival
  const ghostLeave = await a.next('system', 8000);
  eq(ghostLeave.d.reason, 'timed out', 'a silent client is reaped by the heartbeat as “timed out”');
  eq(ghostLeave.d.user, 'ghost', 'and named');
  ok(ghost.ws.readyState === 1 || ghost.ws.readyState === 2 || ghost.ws.readyState === 3,
     'even though its socket never reported anything');

  // ── the unnamed grace period ─────────────────────────────────────────────
  const healthAfter = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
  ok(healthAfter.users >= 3, 'named users are counted');

  // ── /auth is off on this server ──────────────────────────────────────────
  const authOff = await fetch(`http://127.0.0.1:${PORT}/api/auth/sign-in/email`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  eq(authOff.status, 404, 'the auth routes are 404 when accounts are off');
  eq((await authOff.json()).code, 'DISABLED', 'with a DISABLED code');

  a.close(); b.close(); c.close(); ghost.kill();
  await sleep(200);
  server.stop();
  report('protocol');
}

main().catch(bail);
