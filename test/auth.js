// test/auth.js — identity, via Better Auth (email + password).
//
// Needs a real database: Better Auth persists users, sessions and credentials
// in tables, so `memory` cannot serve accounts and this suite skips without
// TEST_DATABASE_URL. Everything it used to prove about the hand-rolled scrypt
// path is either Better Auth's problem now or is re-proved here at the seam we
// still own — the WebSocket upgrade.
'use strict';

const { ok, eq, bail, report, startServer, client, sleep } = require('./harness');

const PORT = 8086;
const URL = process.env.TEST_DATABASE_URL;

function rawSetCookie(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return raw.filter(Boolean).join(' ;; ');
}

function rawSetCookie(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return raw.filter(Boolean).join(' ;; ');
}

function cookiesOf(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return raw.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
}

async function signUp(port, email, password, name) {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ email, password, name }),
  });
  return { status: res.status, cookie: cookiesOf(res), setCookie: rawSetCookie(res), body: await res.json().catch(() => ({})) };
}

async function signIn(port, email, password) {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, cookie: cookiesOf(res), body: await res.json().catch(() => ({})) };
}

// Opens a socket with whatever cookie is given and reports what happened.
// A rejected upgrade surfaces as a connection error, not as a frame.
function tryConnect(port, cookie) {
  const attempt = client(port, cookie ? { headers: { cookie } } : {})
    .then((c) => ({ ok: true, c }))
    .catch((err) => ({ ok: false, err: String(err.message || err) }));
  // A refused upgrade may close the socket without ws ever emitting, so this
  // cannot be left to resolve on its own.
  const timeout = new Promise((r) => setTimeout(() => r({ ok: false, err: 'timed out' }), 5000));
  return Promise.race([attempt, timeout]);
}

async function reset() {
  const { Client } = require('pg');
  const c = new Client({ connectionString: URL });
  await c.connect();
  await c.query(`
    drop table if exists messages cascade;
    drop table if exists rooms cascade;
    drop table if exists "session" cascade;
    drop table if exists "account" cascade;
    drop table if exists "verification" cascade;
    drop table if exists "user" cascade;
    drop table if exists sessions cascade;
    drop table if exists users cascade;
    drop table if exists schema_version cascade;
  `);
  await c.end();
}

async function main() {
  if (!URL) {
    console.log('auth: SKIPPED — set TEST_DATABASE_URL to run this suite');
    return;
  }
  await reset();

  const server = await startServer(PORT, {
    DATABASE_URL: URL,
    HISTORY_REPLAY: '20',
    AUTH_MAX_ATTEMPTS: '500',
    BETTER_AUTH_SECRET: 'test-secret-'.padEnd(40, 'x'),
  });

  const health = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
  eq(health.auth, 'postgres', '/healthz reports accounts are on');

  // ── registration ─────────────────────────────────────────────────────────
  const kavya = await signUp(PORT, 'kavya@example.test', 'correct-horse-battery', 'kavya');
  eq(kavya.status, 200, 'a valid registration succeeds');
  ok(kavya.cookie.length > 0, 'and sets a session cookie');
  ok(/httponly/i.test(kavya.setCookie), 'the session cookie is HttpOnly — an XSS cannot read it');
  ok(/samesite=strict/i.test(kavya.setCookie), 'and SameSite=Strict');

  const dup = await signUp(PORT, 'kavya@example.test', 'another-password-xyz', 'kavya2');
  ok(dup.status >= 400, 'the same email cannot register twice');

  const weak = await signUp(PORT, 'weak@example.test', 'short', 'weak');
  ok(weak.status >= 400, 'a password under the minimum is refused');

  // ── sign-in ──────────────────────────────────────────────────────────────
  const good = await signIn(PORT, 'kavya@example.test', 'correct-horse-battery');
  eq(good.status, 200, 'the right password signs in');
  ok(good.cookie.length > 0, 'and returns a session');

  const bad = await signIn(PORT, 'kavya@example.test', 'wrong-password-here');
  ok(bad.status >= 400, 'the wrong password does not');

  const ghost = await signIn(PORT, 'nobody@example.test', 'correct-horse-battery');
  ok(ghost.status >= 400, 'nor does an account that does not exist');

  // ── the upgrade is the gate ──────────────────────────────────────────────
  // This is the seam we own, and the reason identity moved out of the join
  // frame: an unauthenticated socket is never allowed to exist.
  const anon = await tryConnect(PORT, null);
  eq(anon.ok, false, 'a socket with no session cookie is refused at the upgrade');

  const forged = await tryConnect(PORT, 'better-auth.session_token=not-a-real-token');
  eq(forged.ok, false, 'and so is one with a made-up token');

  const real = await tryConnect(PORT, good.cookie);
  eq(real.ok, true, 'a socket with a valid session connects');

  const c = real.c;
  await c.next('hello');
  // The join frame carries nothing: identity was settled at the upgrade.
  c.send('join', {});
  const welcome = await c.next('welcome');
  eq(welcome.d.you.name, 'kavya', 'the display name comes off the account');

  // ── a username in the payload is ignored ─────────────────────────────────
  const imposter = await tryConnect(PORT, good.cookie);
  ok(imposter.ok, 'a second socket for the same account connects');
  await imposter.c.next('hello');
  imposter.c.send('join', { username: 'administrator' });
  const second = await imposter.c.nextAny(['welcome', 'error']);
  if (second.t === 'welcome') {
    eq(second.d.you.name, 'kavya', 'a username in the join payload is ignored entirely');
  } else {
    eq(second.d.code, 'NAME_TAKEN', 'or the second connection for one account is refused');
  }
  imposter.c.close();

  // ── /nick renames the account, never the identity ────────────────────────
  await sleep(150);
  c.drain().send('nick', { username: 'kavya-r' });
  const you = await c.next('you');
  eq(you.d.name, 'kavya-r', '/nick changes the display name');
  eq(you.d.id, welcome.d.you.id, 'but not the session identity');

  c.close();
  await sleep(200);

  // The rename must have reached the account, not just the socket.
  const { Client } = require('pg');
  const pg = new Client({ connectionString: URL });
  await pg.connect();
  const row = await pg.query('select "name" from "user" where "email" = $1', ['kavya@example.test']);
  eq(row.rows[0] && row.rows[0].name, 'kavya-r', 'and the new name is persisted on the account');

  // The password is hashed, never stored in the clear.
  const cred = await pg.query(`select "password" from "account" where "providerId" = 'credential' limit 1`);
  const stored = cred.rows[0] && cred.rows[0].password;
  ok(stored && !stored.includes('correct-horse-battery'), 'the password is not stored in plaintext');
  await pg.end();

  server.stop();
  report('auth');
}

main().catch(bail);
