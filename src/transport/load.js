// src/transport/load.js — this process's own load, sampled cheaply.
//
// The load balancer needs to know how loaded each backend is in order to route
// on performance rather than in turn. It could guess from response latency
// alone, but latency only rises once a backend is already struggling, and by
// then requests have been sent there. A backend that reports its own pressure
// lets the balancer react before the queue becomes visible from outside.
//
// Three signals, none of which requires cooperation from the request handlers:
//
//   lagMs     event-loop delay. The single most honest number a Node process
//             can publish about itself: it is exactly the time a newly arrived
//             request will wait before its handler runs.
//   cpu       process CPU across all cores since the last sample.
//   inFlight  requests currently being served.
//
// Everything here is O(1) per sample and the sampler is unref'd, so it never
// holds the process open.
'use strict';

const os = require('node:os');

const CPUS = Math.max(1, os.cpus().length);
const SAMPLE_MS = 250;

// EWMA rather than the instantaneous value: routing decisions taken on a raw
// sample chase noise, and a balancer that reacts to a single slow tick will
// oscillate between backends instead of settling.
const ALPHA = 0.3;

let lagEwma = 0;
let cpuPercent = 0;
let inFlight = 0;
let peakInFlight = 0;
let served = 0;

let lastCpu = process.cpuUsage();
let lastSample = Date.now();
let timer = null;

function start() {
  if (timer) return;
  let expected = Date.now() + SAMPLE_MS;
  timer = setInterval(() => {
    const now = Date.now();

    // How late this timer fired is how blocked the loop was. setInterval
    // cannot fire early, so the excess is delay and never scheduling jitter
    // in the other direction.
    const lag = Math.max(0, now - expected);
    lagEwma = lagEwma === 0 ? lag : ALPHA * lag + (1 - ALPHA) * lagEwma;
    expected = now + SAMPLE_MS;

    const cpu = process.cpuUsage();
    const elapsedUs = (now - lastSample) * 1000;
    if (elapsedUs > 0) {
      const usedUs = cpu.user - lastCpu.user + (cpu.system - lastCpu.system);
      // Normalised by core count, so 100 means "saturating every core" rather
      // than "saturating one" — comparable across machines with different
      // core counts, which the four lab systems may well have.
      const pct = (usedUs / elapsedUs) * 100 / CPUS;
      cpuPercent = ALPHA * pct + (1 - ALPHA) * cpuPercent;
    }
    lastCpu = cpu;
    lastSample = now;
  }, SAMPLE_MS);
  // Unref'd: a metrics sampler must never be the reason a process refuses to
  // exit on SIGTERM.
  if (timer.unref) timer.unref();
}

function enter() {
  inFlight++;
  if (inFlight > peakInFlight) peakInFlight = inFlight;
}

function leave() {
  if (inFlight > 0) inFlight--;
  served++;
}

// A single number for the load balancer to sort on. Event-loop delay dominates
// because it is the one signal that translates directly into added latency for
// the next request; in-flight count is a leading indicator of where that delay
// is heading, and CPU distinguishes "busy doing work" from "blocked".
function score() {
  return round2(lagEwma + inFlight * 2 + cpuPercent / 10);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function snapshot() {
  const mem = process.memoryUsage();
  return {
    ok: true,
    pid: process.pid,
    lag_ms: round2(lagEwma),
    // Two normalisations, because on a 120-core host they answer different
    // questions. cpu_percent is this process's share of the whole machine —
    // the honest "system utilisation" figure, and necessarily tiny. Node is
    // single-threaded, so cpu_core_percent (share of ONE core) is the one that
    // says whether this backend is saturated: it cannot exceed ~100 no matter
    // how many cores the host has.
    cpu_percent: round2(cpuPercent),
    cpu_core_percent: round2(cpuPercent * CPUS),
    in_flight: inFlight,
    peak_in_flight: peakInFlight,
    served,
    load_score: score(),
    cpus: CPUS,
    load_avg_1m: round2(os.loadavg()[0]),
    rss_mb: Math.round(mem.rss / 1048576),
    heap_used_mb: Math.round(mem.heapUsed / 1048576),
    uptime_s: Math.round(process.uptime()),
  };
}

module.exports = { start, enter, leave, snapshot, score };
