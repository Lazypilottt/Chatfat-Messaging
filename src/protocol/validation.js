// src/protocol/validation.js — text cleaning, the token bucket, and server-side
// mention resolution. Mentions are resolved HERE and not in the browser: a
// client that decided for itself who it had mentioned could highlight and
// notify anybody.
'use strict';

const config = require('../config');
const { occupants } = require('../state/hub');

// Strip control characters (except tab/newline) and collapse runaway blank
// lines. Not an XSS defence — that is the renderer's job, and it uses text
// nodes only — this is just so one message cannot be 400 screens tall.
function cleanText(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanName(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/\s+/g, ' ').trim();
}

function cleanRoomName(input) {
  return cleanName(input);
}

// Burst of BUCKET_SIZE, then one per BUCKET_REFILL_MS. Exceeding it drops the
// message and returns an error frame — it never drops the socket.
function takeToken(session) {
  const now = Date.now();
  const bucket = session.bucket;
  const gained = Math.floor((now - bucket.lastRefill) / config.BUCKET_REFILL_MS);
  if (gained > 0) {
    bucket.tokens = Math.min(config.BUCKET_SIZE, bucket.tokens + gained);
    bucket.lastRefill += gained * config.BUCKET_REFILL_MS;
  }
  if (bucket.tokens <= 0) return false;
  bucket.tokens--;
  return true;
}

const MENTION_RE = /@([A-Za-z0-9_.-]{2,16})/g;

// Resolved against the live roster of THIS room, so you cannot mention someone
// who is not here to be mentioned.
function resolveMentions(text, roomId, exceptSessionId) {
  if (typeof text !== 'string' || !text.includes('@')) return [];
  const present = new Map();
  for (const session of occupants(roomId)) {
    if (session.id === exceptSessionId) continue;
    present.set(session.name.toLowerCase(), session.name);
  }
  const out = new Set();
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text))) {
    const hit = present.get(m[1].toLowerCase());
    if (hit) out.add(hit);
  }
  return [...out];
}

function validPollShape(q, options) {
  if (typeof q !== 'string') return 'Ask a question.';
  const question = cleanText(q);
  if (question.length < 1 || question.length > 200) return 'A poll question is 1–200 characters.';
  if (!Array.isArray(options)) return 'A poll needs 2–5 options.';
  const opts = options.map((o) => cleanText(o)).filter(Boolean);
  if (opts.length < 2 || opts.length > 5) return 'A poll needs 2–5 options.';
  if (opts.some((o) => o.length > 60)) return 'Poll options are 60 characters or fewer.';
  return null;
}

module.exports = { cleanText, cleanName, cleanRoomName, takeToken, resolveMentions, validPollShape };
