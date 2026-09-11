// src/transport/bench.js — the load-balancer experiment endpoint.
//
// The load-balancing lab needs three things from a backend that the chat
// surface cannot give it:
//
//   1. Identity. The response has to say WHICH of Sys2/Sys3/Sys4 served it,
//      otherwise a working round-robin and a load balancer that quietly pins
//      every request to one machine look identical from the client.
//   2. A bounded amount of work per request. Serving index.html is dominated by
//      the page cache, so a single backend never saturates and the 1-backend
//      and 3-backend runs come out the same — which measures the LAN, not the
//      load balancer.
//   3. The synthetic delay and failure knobs the assignment describes, so
//      health-check recovery can be demonstrated without stopping a server.
//
// Off unless BENCH_ENABLED is set, so nothing here is reachable on a normal
// deployment of the chat app.
'use strict';

const crypto = require('node:crypto');
const config = require('../config');

let served = 0;
let failed = 0;

// Node is single-threaded, so this is the whole point: `rounds` of synchronous
// hashing occupies the event loop and gives each machine a real per-request
// cost. One backend then has a throughput ceiling, three backends have three
// ceilings, and the comparison table has something to compare.
function burn(rounds) {
  let buf = Buffer.from('chatfat-bench');
  for (let i = 0; i < rounds; i++) {
    buf = crypto.createHash('sha256').update(buf).digest();
  }
  return buf.toString('hex').slice(0, 16);
}

// Accepts "250ms", "1s" or a bare number of milliseconds, so the query strings
// in the assignment slides work as written.
function parseDelayMs(raw) {
  if (!raw) return 0;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(raw).trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const mult = m[2] === 's' ? 1000 : m[2] === 'm' ? 60000 : 1;
  return Math.min(30000, Math.max(0, n * mult));
}

function json(res, status, body, extraHeaders) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(raw),
    ...extraHeaders,
  });
  res.end(raw);
}

// Returns true when it handled the request.
function handle(req, res, pathname) {
  if (!config.BENCH_ENABLED) return false;
  if (pathname !== '/bench' && pathname !== '/bench/') return false;

  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;

  // Sent on every path, failures included, so even a synthetic 503 is
  // attributable to a machine. The load generator tallies this header to prove
  // the round-robin split actually happened.
  const headers = { 'X-Backend': config.BACKEND_NAME };

  const id = ++served;

  const rate = q.has('failure_rate') ? Number(q.get('failure_rate')) : config.BENCH_FAILURE_RATE;
  if (q.get('fail') === 'true' || (rate > 0 && Math.random() < rate)) {
    failed++;
    json(res, 503, { backend: config.BACKEND_NAME, request_id: id, message: 'synthetic failure' }, headers);
    return true;
  }

  const work = q.has('work') ? Math.min(200000, Math.max(0, Number(q.get('work')) || 0)) : config.BENCH_WORK;
  const delayMs = parseDelayMs(q.get('delay'));

  const finish = () => {
    const started = process.hrtime.bigint();
    const digest = work > 0 ? burn(work) : null;
    const cpuUs = Number(process.hrtime.bigint() - started) / 1000;
    json(res, 200, {
      backend: config.BACKEND_NAME,
      request_id: id,
      pid: process.pid,
      delay_ms: delayMs,
      work,
      cpu_us: Math.round(cpuUs),
      digest,
      served,
      failed,
      message: 'ok',
    }, headers);
  };

  if (delayMs > 0) setTimeout(finish, delayMs);
  else finish();
  return true;
}

module.exports = { handle, parseDelayMs };
