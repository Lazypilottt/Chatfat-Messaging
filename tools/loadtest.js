// tools/loadtest.js — broadcast fan-out latency as room size grows.
//
// All clients share one process and one machine, so the figures below exclude
// the network entirely. They measure what the server does with a frame, not
// what a LAN does with it.
//
//   node tools/loadtest.js --clients 4,16,32,64 --duration 8 --rate 1
//   node tools/loadtest.js --encrypted          # the same rungs in a locked room
'use strict';

const { webcrypto } = require('node:crypto');
const WebSocket = require('ws');

const PROTOCOL_VERSION = 2;
const ITERATIONS = 250000;

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const opts = args();
const RUNGS = String(opts.clients || '4,16,32,64').split(',').map(Number);
const DURATION = Number(opts.duration || 8) * 1000;
const RATE = Number(opts.rate || 1);
// A locked rung needs its own room names: a room can never be unlocked, so
// reusing a plaintext room's name would just rejoin the plaintext one.
const ROOM = String(opts.room || (opts.encrypted ? 'loadtest-enc' : 'loadtest'));
const TARGET = String(opts.target || 'ws://127.0.0.1:3000/ws');
const SETTLE = Number(opts.settle || 1.5) * 1000;
const ENCRYPTED = !!opts.encrypted;
const HTTP = TARGET.replace(/^ws/, 'http').replace(/\/ws$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (b) => Buffer.from(new Uint8Array(b)).toString('base64');

async function roomKey(roomId, passphrase) {
  const subtle = webcrypto.subtle;
  const encoder = new TextEncoder();
  const salt = await subtle.digest('SHA-256', encoder.encode('ChatFat-room-v1|' + roomId));
  const base = await subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const raw = await subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, base, 256);
  const hmac = await subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return {
    salt: b64(salt),
    verifier: b64(await subtle.sign('HMAC', hmac, encoder.encode('ChatFat-room-verify|' + roomId + '|1'))),
    key: await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']),
  };
}

async function envelopeFor(entry, roomId, text) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const n = b64(webcrypto.getRandomValues(new Uint8Array(16)));
  const ct = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(roomId + '|' + n + '|1') },
    entry.key,
    new TextEncoder().encode(JSON.stringify({ text, mentions: [], action: false })),
  );
  return { alg: 'A256GCM', kid: 1, n, iv: b64(iv), ct: b64(ct), aadv: 1 };
}

function connect(name, room, onChat) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(TARGET);
    const c = {
      ws,
      send: (t, d) => ws.readyState === 1 && ws.send(JSON.stringify({ v: PROTOCOL_VERSION, t, d: d || {} })),
      close: () => ws.close(1000),
    };
    ws.on('message', (raw) => {
      let f;
      try { f = JSON.parse(raw.toString()); } catch { return; }
      if (f.t === 'ping') c.send('pong', { t: f.d.t });
      if (f.t === 'hello') c.send('join', { username: name });
      if (f.t === 'welcome') c.send('room:join', { room });
      if (f.t === 'room:joined') resolve(c);
      if (f.t === 'chat') onChat(f.d);
      // Anything the server refuses is fatal here: a silent 0-delivered run
      // that looks like a latency result would be worse than a crash.
      if (f.t === 'error' && f.d.code !== 'RATE_LIMIT') reject(new Error(`${f.d.code}: ${f.d.message}`));
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error(`${name} never joined ${room}`)), 15000);
  });
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const at = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[at];
}

async function health() {
  try {
    return await (await fetch(`${HTTP}/healthz`)).json();
  } catch {
    return null;
  }
}

async function rung(count, keyEntry) {
  const room = ROOM + '-' + count;
  const latencies = [];
  const seen = new Map(); // marker -> send time

  const onChat = (d) => {
    // The marker rides in the plaintext, or — in a locked room — in the nonce,
    // which the server copies through verbatim and never interprets.
    const marker = d.enc ? d.enc.n : d.text;
    const sentAt = seen.get(marker);
    if (sentAt !== undefined) latencies.push(Date.now() - sentAt);
  };

  const first = await connect(`lt-${count}-0`, 'lab-room', () => {});
  first.send('room:create', keyEntry
    ? { room, lock: { kdf: { alg: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: keyEntry.salt }, verifier: keyEntry.verifier } }
    : { room });
  await sleep(400);
  first.close();
  await sleep(200);

  const clients = [];
  for (let i = 0; i < count; i++) {
    clients.push(await connect(`lt-${count}-c${i}`, room, onChat));
    await sleep(15); // stagger, so the join storm is not what we are measuring
  }

  const stop = Date.now() + DURATION;
  let sent = 0;
  const senders = clients.map((c, i) =>
    (async () => {
      await sleep((i / clients.length) * (1000 / RATE));
      while (Date.now() < stop) {
        const marker = `${count}-${i}-${sent++}`;
        if (keyEntry) {
          const env = await envelopeFor(keyEntry, room, marker);
          seen.set(env.n, Date.now());
          c.send('chat', { enc: env });
        } else {
          seen.set(marker, Date.now());
          c.send('chat', { text: marker });
        }
        await sleep(1000 / RATE);
      }
    })(),
  );
  await Promise.all(senders);
  await sleep(SETTLE);

  const health1 = await health();
  for (const c of clients) c.close();
  await sleep(SETTLE);

  latencies.sort((x, y) => x - y);
  return {
    count,
    delivered: latencies.length,
    p50: quantile(latencies, 0.5),
    p95: quantile(latencies, 0.95),
    p99: quantile(latencies, 0.99),
    rss: health1 ? Math.round(health1.memory.rss / 1048576) : 0,
    heap: health1 ? Math.round(health1.memory.heapUsed / 1048576) : 0,
  };
}

async function main() {
  const h = await health();
  if (!h) {
    console.error(`No server at ${HTTP}. Start one with: npm start`);
    process.exit(1);
  }

  console.log('');
  console.log(`  ChatFat load test — ${TARGET}${ENCRYPTED ? ' · encrypted rung' : ''}`);
  console.log(`  ${DURATION / 1000}s per rung at ${RATE} msg/s/client, ${SETTLE / 1000}s settle`);
  console.log('');
  console.log('  clients   delivered      p50      p95      p99     rss    heap');
  console.log('  ' + '-'.repeat(62));

  const rows = [];
  for (const count of RUNGS) {
    // A locked room needs its own key per room id: the salt is deterministic
    // from the id, so each rung derives afresh.
    const entry = ENCRYPTED ? await roomKey(ROOM + '-' + count, 'loadtest passphrase') : null;
    const row = await rung(count, entry);
    rows.push(row);
    console.log(
      `  ${String(row.count).padStart(7)}  ${String(row.delivered).padStart(10)}` +
        `  ${(row.p50 + 'ms').padStart(7)}  ${(row.p95 + 'ms').padStart(7)}  ${(row.p99 + 'ms').padStart(7)}` +
        `  ${(row.rss + 'M').padStart(6)}  ${(row.heap + 'M').padStart(6)}`,
    );
  }

  console.log('');
  console.log('  All clients share one process and one machine, so these figures');
  console.log('  exclude the network. They measure the server, not the LAN.');
  console.log('');

  if (opts.out) {
    require('node:fs').writeFileSync(String(opts.out), JSON.stringify({ target: TARGET, encrypted: ENCRYPTED, rows }, null, 2));
    console.log(`  written to ${opts.out}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
