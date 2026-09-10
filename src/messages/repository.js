// src/messages/repository.js — durable storage: Null | Memory | Pg behind one
// interface.
//
// Recording and replaying are separate questions. This module records; whether
// a joining client is handed anything is HISTORY_REPLAY's business, and it is 0
// by default. In a locked room what lands here is ciphertext, `text` is '', and
// nothing in a row is readable by the operator.
'use strict';

const config = require('../config');
const log = require('../logger');
const pool = require('../db/pool');
const atRest = require('../crypto/atRest');
const signature = require('../crypto/signature');

// Ordering is (ts, id), never ts alone. Two messages can share a millisecond —
// a burst of three from the same client routinely does — and a cursor that
// cannot break that tie will either skip a row or hand it back twice on the
// next page. `id` is monotonic within a millisecond because newId appends a
// counter, so it is a valid tie-break.
function byTsThenId(a, b) {
  return a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function olderThan(m, cursor) {
  return m.ts < cursor.ts || (m.ts === cursor.ts && m.id < cursor.id);
}

function encColumns(m) {
  const e = m.enc;
  return e
    ? [e.alg, e.kid, e.n, e.iv, e.ct, e.aadv]
    : [null, null, null, null, null, null];
}

// — at-rest text encryption (requirement 3), shared by both durable backends
//   so MemoryRepo exercises the exact same path PgRepo does. —
//
// `text` is the only field this protects: it's the one place user-authored
// plaintext lands in a column. A locked room's messages already have
// text === '' — their content lives in enc_ct instead, under a key the
// server never holds — so there is nothing to encrypt there, and `textKv`
// stays null. That null is the signal decryptTextField uses to tell "nothing
// was encrypted here" apart from "encryption of an empty string".
function encryptTextField(m) {
  if (!m.text) return { text: m.text || '', textIv: null, textKv: null };
  const enc = atRest.encryptText(m.text, m.id);
  return { text: enc.ct, textIv: enc.iv, textKv: enc.kv };
}

// Returns { text, tampered }. `tampered` is requirement 4: the AEAD tag
// covers the ciphertext AND the message id (as AAD), so a row altered
// directly in the database — a bit flipped, or one row's ciphertext pasted
// into another's columns — fails here instead of decrypting to garbage or to
// someone else's message. Never throws; see src/crypto/atRest.js.
function decryptTextField(ct, iv, kv, id) {
  if (kv === null || kv === undefined) return { text: ct || '', tampered: false };
  const out = atRest.decryptText(ct, iv, kv, id);
  if (out.ok) return { text: out.text, tampered: false };
  log.warn(`at-rest decryption failed for message ${id} — flagging as tampered`);
  return { text: '', tampered: true };
}

// — requirement 4, second layer: re-verify the sender's own signature
//   (requirements 5+6) against the stored content, independent of the at-rest
//   cipher above. The two checks share no secret, so a row that defeats one
//   still has to defeat the other to pass as legitimate. Skipped when the
//   at-rest check already flagged the row — no point verifying a signature
//   against text that is already known to be '' because decryption failed. —
function signatureTampered(m, roomId) {
  if (!m.sig || !m.sigPub) return false; // predates signing, or was never signed — nothing to check
  const ok = signature.verify(m.sigPub, m.sig, { room: roomId, from: m.from, text: m.text, enc: m.enc });
  if (!ok) log.warn(`signature verification failed for message ${m.id} — flagging as tampered`);
  return !ok;
}

function rowToMessage(row) {
  const enc = row.enc_alg
    ? { alg: row.enc_alg, kid: row.enc_kid, n: row.enc_n, iv: row.enc_iv, ct: row.enc_ct, aadv: row.enc_aadv }
    : null;
  const { text, tampered: decryptTampered } = decryptTextField(row.text, row.text_iv, row.text_kv, row.id);
  const message = {
    kind: 'chat',
    id: row.id,
    ts: Number(row.ts),
    from: row.from_name,
    fromId: row.from_id,
    colour: row.colour,
    text,
    action: !!row.action,
    replyTo: row.reply_to || null,
    mentions: row.mentions || [],
    reactions: row.reactions || {},
    editedAt: row.edited_at === null || row.edited_at === undefined ? null : Number(row.edited_at),
    unsent: !!row.unsent,
    ...(row.expires_at ? { expiresAt: Number(row.expires_at) } : {}),
    enc,
    sig: row.sig || null,
    sigPub: row.sig_pub || null,
  };
  const tampered = decryptTampered || signatureTampered(message, row.room_id);
  if (tampered) message.tampered = true;
  return message;
}

// — null: nothing is stored, nothing is replayed —

class NullRepo {
  constructor() {
    this.kind = 'nothing';
  }
  async init() {}
  async save() {}
  async update() {}
  async remove() {}
  async recent() {
    return [];
  }
  async before() {
    return [];
  }
  async close() {}
}

// — memory —

class MemoryRepo {
  constructor() {
    this.kind = 'memory';
    this.rows = new Map(); // messageId -> { roomId, m: stored copy, text AT REST }
  }
  async init() {}

  async save(roomId, m) {
    const copy = JSON.parse(JSON.stringify(m));
    const { text, textIv, textKv } = encryptTextField(copy);
    copy.text = text;
    copy.textIv = textIv;
    copy.textKv = textKv;
    this.rows.set(m.id, { roomId, m: copy });
  }

  async update(id, patch) {
    const hit = this.rows.get(id);
    if (!hit) return;
    const p = JSON.parse(JSON.stringify(patch));
    if ('text' in p) {
      const { text, textIv, textKv } = encryptTextField({ id, text: p.text });
      p.text = text;
      p.textIv = textIv;
      p.textKv = textKv;
    }
    Object.assign(hit.m, p);
  }

  async remove(id) {
    this.rows.delete(id);
  }

  async recent(roomId, limit) {
    if (limit <= 0) return [];
    const out = [];
    for (const { roomId: rid, m } of this.rows.values()) {
      if (rid === roomId && !m.unsent) out.push(m); // unsent rows are excluded from replay
    }
    out.sort(byTsThenId);
    return out.slice(-limit).map((m) => decorateStored(m, roomId));
  }

  // The page strictly older than the cursor. Same ordering rule as recent(),
  // and the same tie-break on id — see the comment on byTsThenId.
  async before(roomId, cursor, limit) {
    if (limit <= 0) return [];
    const out = [];
    for (const { roomId: rid, m } of this.rows.values()) {
      if (rid !== roomId || m.unsent) continue;
      if (cursor && !olderThan(m, cursor)) continue;
      out.push(m);
    }
    out.sort(byTsThenId);
    return out.slice(-limit).map((m) => decorateStored(m, roomId));
  }

  async close() {
    this.rows.clear();
  }
}

// Decrypts a stored row FOR A READER, without mutating the stored copy — the
// ciphertext is what's durable; one read must not decrypt it for good. Also
// re-verifies the signature (requirement 4's second layer — see
// signatureTampered above).
function decorateStored(m, roomId) {
  const copy = JSON.parse(JSON.stringify(m));
  const { text, tampered: decryptTampered } = decryptTextField(copy.text, copy.textIv, copy.textKv, copy.id);
  copy.text = text;
  delete copy.textIv;
  delete copy.textKv;
  const tampered = decryptTampered || signatureTampered(copy, roomId);
  if (tampered) copy.tampered = true;
  return copy;
}

// — postgres —

class PgRepo {
  constructor() {
    this.kind = 'postgres';
  }
  async init() {}

  async save(roomId, m) {
    const { text, textIv, textKv } = encryptTextField(m);
    await pool.query(
      `insert into messages
         (id, room_id, ts, from_name, from_id, colour, text, text_iv, text_kv, action, reply_to, mentions,
          reactions, edited_at, unsent, expires_at, enc_alg, enc_kid, enc_n, enc_iv, enc_ct, enc_aadv, sig, sig_pub)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       on conflict (id) do nothing`,
      [
        m.id,
        roomId,
        m.ts,
        m.from,
        m.fromId,
        m.colour,
        text,
        textIv,
        textKv,
        !!m.action,
        m.replyTo ? JSON.stringify(m.replyTo) : null,
        JSON.stringify(m.mentions || []),
        JSON.stringify(m.reactions || {}),
        m.editedAt ?? null,
        !!m.unsent,
        m.expiresAt ?? null,
        ...encColumns(m),
        m.sig || null,
        m.sigPub || null,
      ],
    );
  }

  async update(id, patch) {
    const sets = [];
    const vals = [];
    const put = (col, v) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if ('text' in patch) {
      const { text, textIv, textKv } = encryptTextField({ id, text: patch.text });
      put('text', text);
      put('text_iv', textIv);
      put('text_kv', textKv);
    }
    if ('editedAt' in patch) put('edited_at', patch.editedAt);
    if ('mentions' in patch) put('mentions', JSON.stringify(patch.mentions || []));
    if ('reactions' in patch) put('reactions', JSON.stringify(patch.reactions || {}));
    if ('unsent' in patch) put('unsent', !!patch.unsent);
    if ('enc' in patch) {
      const e = patch.enc;
      put('enc_alg', e ? e.alg : null);
      put('enc_kid', e ? e.kid : null);
      put('enc_n', e ? e.n : null);
      put('enc_iv', e ? e.iv : null);
      put('enc_ct', e ? e.ct : null);
      put('enc_aadv', e ? e.aadv : null);
    }
    if ('sig' in patch) put('sig', patch.sig || null);
    if ('sigPub' in patch) put('sig_pub', patch.sigPub || null);
    if (!sets.length) return;
    vals.push(id);
    await pool.query(`update messages set ${sets.join(', ')} where id = $${vals.length}`, vals);
  }

  async remove(id) {
    await pool.query('delete from messages where id = $1', [id]);
  }

  async recent(roomId, limit) {
    if (limit <= 0) return [];
    const res = await pool.query(
      `select * from (
         select * from messages where room_id = $1 and unsent = false
         order by ts desc, id desc limit $2
       ) t order by ts asc, id asc`,
      [roomId, limit],
    );
    return res.rows.map(rowToMessage);
  }

  // Keyset pagination, never OFFSET. On Neon every page is a network round
  // trip, and OFFSET makes the database walk and discard every row it skips —
  // so page 20 costs twenty times page 1, for identical output. The row
  // comparison `(ts, id) < ($2, $3)` matches the messages_room_ts index
  // exactly, so each page is one index seek regardless of depth.
  async before(roomId, cursor, limit) {
    if (limit <= 0) return [];
    if (!cursor) return this.recent(roomId, limit);
    const res = await pool.query(
      `select * from (
         select * from messages
         where room_id = $1 and unsent = false and (ts, id) < ($2, $3)
         order by ts desc, id desc limit $4
       ) t order by ts asc, id asc`,
      [roomId, cursor.ts, cursor.id, limit],
    );
    return res.rows.map(rowToMessage);
  }

  async close() {}
}

function createRepository() {
  if (!config.PERSISTENCE_ENABLED) return new NullRepo();
  return config.USE_POSTGRES ? new PgRepo() : new MemoryRepo();
}

const repository = createRepository();

// Writes are fire-and-forget: logged and dropped, never awaited on the hot
// path. A slow database must not delay the room.
function detach(promise, what) {
  if (promise && typeof promise.catch === 'function') {
    promise.catch((err) => log.error(`persisting ${what} failed:`, err.message));
  }
}

module.exports = { repository, detach, createRepository, NullRepo, MemoryRepo, PgRepo };
