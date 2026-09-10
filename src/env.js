// src/env.js — a minimal .env loader that works on Node 18.
// Node 18 has no --env-file, and a start script that depends on the runtime
// version is a deployment trap. So we read the file ourselves, and the real
// environment always wins over anything in it.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function load(file = path.join(__dirname, '..', '.env')) {
  // An explicit off switch, used by every test suite: without it a developer's
  // .env reaches the suite and assertions fail for the wrong reason.
  if (process.env.ChatFat_ENV_FILE === 'off') return 0;

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 0; // A missing .env is the normal case, not an error.
  }

  let applied = 0;
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();

    // Split on the FIRST '=' only — a Postgres URL carries '=' in its query string.
    const eq = line.indexOf('=');
    if (eq < 1) continue;

    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.length > 1 && value[value.length - 1] === q) {
      value = value.slice(1, -1);
    }

    if (key in process.env) continue; // Never overwrite the real environment.
    process.env[key] = value;
    applied++;
  }
  return applied;
}

module.exports = { load };
