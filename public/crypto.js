/* public/crypto.js — WebCrypto key derivation, encrypt/decrypt, and the key
   store. Everything secret in ChatFat happens in this file and never leaves
   the browser: no passphrase, no derived key and no plaintext is ever put on
   the wire, in a log line, in a toast or in the URL.

   Exposed as window.CFCrypto. */
(function () {
  'use strict';

  var subtle = window.crypto && window.crypto.subtle;
  var enc = new TextEncoder();
  var dec = new TextDecoder();

  var KDF_ITERATIONS = 250000;
  var STORE_KEY = 'ChatFat-keys';

  // — encodings —

  function b64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function unb64(str) {
    var s = atob(str), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function hex(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
  }
  function rand(n) {
    return window.crypto.getRandomValues(new Uint8Array(n));
  }

  // ══ Room keys — a room-wide symmetric key from a shared passphrase ══════

  // The salt is DETERMINISTIC, not random, so a member who joins later can
  // derive the key from the passphrase alone without the server handing them
  // anything secret. The room id is inside it, so the same passphrase in two
  // rooms yields two different keys.
  async function roomSalt(roomId) {
    return subtle.digest('SHA-256', enc.encode('ChatFat-room-v1|' + roomId));
  }

  async function deriveRoomKey(passphrase, roomId, iterations) {
    var salt = await roomSalt(roomId);
    var base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    var bits = await subtle.deriveBits(
      { name: 'PBKDF2', salt: salt, iterations: iterations || KDF_ITERATIONS, hash: 'SHA-256' },
      base,
      256,
    );
    return bits; // raw bytes; callers import them for the uses they need
  }

  // A one-way function of K. It lets a client tell a wrong passphrase from an
  // empty room — and it is also the one thing a server operator could mount an
  // offline dictionary attack against, which is why the UI demands ≥10 chars.
  async function verifierFor(rawKey, roomId, keyEpoch) {
    var hmacKey = await subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    var sig = await subtle.sign('HMAC', hmacKey, enc.encode('ChatFat-room-verify|' + roomId + '|' + keyEpoch));
    return b64(sig);
  }

  // Shown in the UI so two members can compare out of band and confirm they
  // are on the same key.
  async function fingerprintFor(rawKey) {
    var digest = await subtle.digest('SHA-256', rawKey);
    return hex(digest).slice(0, 8);
  }

  async function importAesKey(rawKey) {
    return subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  // Everything a member needs for one room at one epoch.
  async function makeRoomKey(passphrase, roomId, keyEpoch, iterations) {
    var raw = await deriveRoomKey(passphrase, roomId, iterations);
    return {
      raw: raw,
      key: await importAesKey(raw),
      epoch: keyEpoch,
      verifier: await verifierFor(raw, roomId, keyEpoch),
      fingerprint: await fingerprintFor(raw),
    };
  }

  async function fromRawKey(rawB64, roomId, keyEpoch) {
    var raw = unb64(rawB64).buffer;
    return {
      raw: raw,
      key: await importAesKey(raw),
      epoch: keyEpoch,
      verifier: await verifierFor(raw, roomId, keyEpoch),
      fingerprint: await fingerprintFor(raw),
    };
  }

  // The AAD binds a ciphertext to its room and key epoch, so it cannot be
  // replayed into another room. It uses a client-side nonce rather than the
  // server's ts/fromId: those are stamped after the frame is sent, which would
  // make the sender unable to build its own AAD.
  function aadFor(roomId, nonceB64, kid) {
    return enc.encode(roomId + '|' + nonceB64 + '|' + kid);
  }

  // The encrypted blob is a JSON object, not a bare string, so everything the
  // server used to read — mentions, the /me flag, the quoted text — is
  // protected too.
  async function encryptRoom(entry, roomId, payload) {
    var iv = rand(12);
    var nonce = rand(16);
    var n = b64(nonce);
    var ct = await subtle.encrypt(
      { name: 'AES-GCM', iv: iv, additionalData: aadFor(roomId, n, entry.epoch) },
      entry.key,
      enc.encode(JSON.stringify(payload)),
    );
    return { alg: 'A256GCM', kid: entry.epoch, n: n, iv: b64(iv), ct: b64(ct), aadv: 1 };
  }

  // Returns { ok:true, payload } | { ok:false, reason:'no-key'|'integrity' }.
  // Never throws at the caller: a tampered ciphertext has to render as a
  // visibly wrong state, not as a crash and not as ordinary text.
  async function decryptRoom(entry, roomId, envelope) {
    if (!entry || entry.epoch !== envelope.kid) return { ok: false, reason: 'no-key' };
    try {
      var plain = await subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: aadFor(roomId, envelope.n, envelope.kid) },
        entry.key,
        unb64(envelope.ct),
      );
      return { ok: true, payload: JSON.parse(dec.decode(plain)) };
    } catch (e) {
      return { ok: false, reason: 'integrity' };
    }
  }

  // ══ Sealed whispers — 1:1, ECDH P-256 ══════════════════════════════════
  // P-256 because it is universally supported; X25519 is not. The private key
  // never leaves the browser and is never persisted — a fresh pair per
  // connection is fine, because DMs are never stored anywhere.

  async function newKeyPair() {
    var pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    var spki = await subtle.exportKey('spki', pair.publicKey);
    return { priv: pair.privateKey, pub: pair.publicKey, pubB64: b64(spki) };
  }

  function importPub(pubB64) {
    return subtle.importKey('spki', unb64(pubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  }

  async function sealHalf(myPriv, theirPubB64, salt, info, plaintext) {
    var theirPub = await importPub(theirPubB64);
    var ephemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    var shared = await subtle.deriveBits({ name: 'ECDH', public: theirPub }, ephemeral.privateKey, 256);
    var hkdfBase = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    var bits = await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt, info: enc.encode(info) },
      hkdfBase,
      256,
    );
    var key = await subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt']);
    var iv = rand(12);
    var ct = await subtle.encrypt(
      { name: 'AES-GCM', iv: iv, additionalData: enc.encode('ChatFat-dm-v1') },
      key,
      enc.encode(JSON.stringify(plaintext)),
    );
    var epk = await subtle.exportKey('spki', ephemeral.publicKey);
    return { epk: b64(epk), salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  }

  // Two halves: one to the recipient, one to your own public key — because the
  // server echoes the whisper back and your own log has to stay readable.
  async function sealWhisper(myPair, theirPubB64, fromName, toName, text) {
    var info = 'ChatFat-dm-v1|' + fromName + '|' + toName;
    var saltTo = rand(32);
    var saltSelf = rand(32);
    return {
      alg: 'A256GCM',
      aadv: 1,
      to: await sealHalf(myPair.priv, theirPubB64, saltTo, info, { text: text }),
      self: await sealHalf(myPair.priv, myPair.pubB64, saltSelf, info, { text: text }),
    };
  }

  async function openHalf(myPriv, half) {
    var epk = await importPub(half.epk);
    var shared = await subtle.deriveBits({ name: 'ECDH', public: epk }, myPriv, 256);
    return shared;
  }

  async function unsealWhisper(myPair, envelope, fromName, toName, whichHalf) {
    var half = envelope[whichHalf];
    if (!half) return { ok: false, reason: 'no-key' };
    try {
      var shared = await openHalf(myPair.priv, half);
      var hkdfBase = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
      var bits = await subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: unb64(half.salt),
          info: enc.encode('ChatFat-dm-v1|' + fromName + '|' + toName),
        },
        hkdfBase,
        256,
      );
      var key = await subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['decrypt']);
      var plain = await subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(half.iv), additionalData: enc.encode('ChatFat-dm-v1') },
        key,
        unb64(half.ct),
      );
      return { ok: true, payload: JSON.parse(dec.decode(plain)) };
    } catch (e) {
      return { ok: false, reason: 'integrity' };
    }
  }

  // ══ Signing — ECDSA P-256, one keypair per browser, persisted ══════════
  // Requirements 5 + 6: each sender signs every message they send, and it is
  // verified — server-side before it is even accepted (src/transport/
  // handlers.js), and again independently by every reader, client-side,
  // right here. P-256 again, matching the whisper key above, for the same
  // "universally supported" reasoning.
  //
  // The keypair is generated ONCE per browser and kept in IndexedDB — not
  // localStorage. IndexedDB can hold a CryptoKey object directly via
  // structured clone, including a NON-EXTRACTABLE one, so the private key
  // material never exists as bytes any script — this one included — can
  // read, export, or log. Reusing the same pair across reconnects is what
  // makes "signing key pair" mean something as an identity claim, rather
  // than resetting every session the way the whisper ECDH pair does.
  //
  // Scope, stated plainly: this is one keypair per BROWSER, not per
  // username. Two people signed in as different names in the same browser
  // profile would sign with the same key. That is a real limitation, not an
  // oversight — scoping identity to an account would need the key pinned
  // server-side against that account, which is out of scope here.

  var SIG_DB = 'ChatFat-identity';
  var SIG_STORE = 'keys';
  var SIG_KEY_NAME = 'signing-keypair';

  function openSigDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('no indexedDB'));
      var req = indexedDB.open(SIG_DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(SIG_STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbGet(db, key) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(SIG_STORE, 'readonly');
      var req = tx.objectStore(SIG_STORE).get(key);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbPut(db, key, value) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(SIG_STORE, 'readwrite');
      tx.objectStore(SIG_STORE).put(value, key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  // Resolves to { priv: CryptoKey (non-extractable), pub: CryptoKey, pubB64 }.
  // Cached after the first call in this page — every caller in this tab gets
  // the identical pair, generated or loaded at most once.
  var sigPairPromise = null;
  function signingKeyPair() {
    if (sigPairPromise) return sigPairPromise;
    sigPairPromise = (async function () {
      var db = null;
      try { db = await openSigDb(); } catch (e) { /* private browsing, or unsupported — fall through */ }

      if (db) {
        try {
          var stored = await idbGet(db, SIG_KEY_NAME);
          if (stored && stored.priv && stored.pub) {
            var existing = await subtle.exportKey('spki', stored.pub);
            return { priv: stored.priv, pub: stored.pub, pubB64: b64(existing) };
          }
        } catch (e) { /* corrupt or unreadable — generate a fresh pair below */ }
      }

      var pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      var exported = await subtle.exportKey('spki', pair.publicKey);
      var pubB64 = b64(exported);

      if (db) {
        try { await idbPut(db, SIG_KEY_NAME, { priv: pair.privateKey, pub: pair.publicKey }); } catch (e) {}
      }
      return { priv: pair.privateKey, pub: pair.publicKey, pubB64: pubB64 };
    })();
    return sigPairPromise;
  }

  // The exact same fixed, delimited, manually-ordered string
  // src/crypto/signature.js's canonicalPayload builds server-side. `id` and
  // `ts` are deliberately absent — the server assigns those AFTER this frame
  // is sent, so the sender cannot sign what it does not yet know, the same
  // constraint aadFor() above already works around with a client nonce. If
  // one of these two functions changes, so must the other.
  function canonicalPayload(fields) {
    var encPart = fields.enc
      ? [fields.enc.alg, fields.enc.kid, fields.enc.n, fields.enc.iv, fields.enc.ct, fields.enc.aadv].join(':')
      : '';
    return enc.encode(fields.room + '|' + fields.from + '|' + (fields.text || '') + '|' + encPart);
  }

  async function signMessage(fields) {
    var pair = await signingKeyPair();
    var sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.priv, canonicalPayload(fields));
    return { sig: b64(sig), sigPub: pair.pubB64 };
  }

  // Never throws: a malformed key or signature is just "does not verify" —
  // the caller does not need to tell that apart from a genuine forgery.
  async function verifySignature(sigPubB64, sigB64, fields) {
    try {
      var pubKey = await subtle.importKey('spki', unb64(sigPubB64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, unb64(sigB64), canonicalPayload(fields));
    } catch (e) {
      return false;
    }
  }

  // ══ Key store — opt-in, per room, warned about ═════════════════════════
  // Off by default. When the box IS ticked the raw key bytes go to
  // localStorage, and the modal says plainly what that means.

  function readStore() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }
  function writeStore(obj) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(obj));
    } catch (e) {}
  }
  function remember(roomId, epoch, rawKey) {
    var all = readStore();
    all[roomId] = { epoch: epoch, k: b64(rawKey) };
    writeStore(all);
  }
  function recall(roomId, epoch) {
    var rec = readStore()[roomId];
    if (!rec || rec.epoch !== epoch) return null;
    return rec.k;
  }
  function forget(roomId) {
    var all = readStore();
    delete all[roomId];
    writeStore(all);
  }

  // A meter, not a policy: the minimum length is enforced separately.
  function passphraseStrength(p) {
    if (!p) return 0;
    var score = 0;
    if (p.length >= 10) score++;
    if (p.length >= 16) score++;
    if (p.length >= 24) score++;
    if (/[^A-Za-z0-9]/.test(p) || (/[A-Za-z]/.test(p) && /[0-9]/.test(p))) score++;
    return Math.min(4, score);
  }

  window.CFCrypto = {
    available: !!subtle,
    KDF_ITERATIONS: KDF_ITERATIONS,
    b64: b64,
    unb64: unb64,
    roomSalt: roomSalt,
    makeRoomKey: makeRoomKey,
    fromRawKey: fromRawKey,
    encryptRoom: encryptRoom,
    decryptRoom: decryptRoom,
    newKeyPair: newKeyPair,
    sealWhisper: sealWhisper,
    unsealWhisper: unsealWhisper,
    signingKeyPair: signingKeyPair,
    signMessage: signMessage,
    verifySignature: verifySignature,
    remember: remember,
    recall: recall,
    forget: forget,
    passphraseStrength: passphraseStrength,
  };
})();
