# Changelog

Lab 4 turns the Lab 2 chat into a persistent and secure messaging system.
`v2.0.0-lab2` is the tag to diff against — everything below it is Lab 2.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **`@neondatabase/serverless` as a second database driver, chosen automatically
  by hostname.** `src/db/pool.js` now tunnels the Postgres protocol over a
  WebSocket on port 443 for any `*.neon.tech` `DATABASE_URL`, instead of raw
  TCP on port 5432 — a campus/office network that only allows standard web
  ports out blocks 5432 silently (a timeout, not a rejection), which is
  otherwise indistinguishable from a Neon or credentials problem. Local
  Postgres (`docker-compose.yml`) keeps using plain `pg`, since a vanilla
  Postgres has no WebSocket proxy to tunnel to.
- **At-rest encryption (requirement 3).** Every stored message's `text` is
  AES-256-GCM'd under a server-held `MASTER_KEY` before it reaches the
  database — every room, not only a locked one. `src/crypto/atRest.js`,
  migration `003_at_rest.sql`. A different, additional guarantee from a
  locked room's client-side key: this protects a database dump; that
  protects the message from the server itself.
- **Tamper detection (requirement 4).** The AEAD tag from the at-rest cipher
  is bound to the message's own id, so a row altered directly in the
  database — a bit flip, or one row's ciphertext pasted into another's
  columns — fails to decrypt instead of decrypting to garbage. Checked on
  every read (room join, scrollback), not on a schedule; flagged rather than
  served as legitimate content, both server-side (logged) and client-side (a
  visible integrity warning, reusing the existing E2E-failure treatment).
  `tools/tamper.js` demonstrates it against a real row on purpose.
- **Signing keypairs (requirement 5).** Each sender gets an ECDSA P-256
  keypair, generated client-side and kept in IndexedDB — one per browser,
  reused across reconnects rather than reset every session.
  `public/crypto.js`.
- **Signature verification (requirement 6).** Every `chat`/`edit` is signed
  over `{room, sender, content}` and verified twice: server-side before
  acceptance (`src/transport/handlers.js` — unsigned or wrongly-signed frames
  are refused, never broadcast or stored), and independently, client-side, by
  every reader against the sender's own published key — which additionally
  catches a live broadcast altered in transit, a gap the server's own
  send-time check cannot close for its own traffic. The signature is stored
  and **re-verified on every future read**, as a second, independent tamper
  signal alongside the at-rest AEAD tag (requirement 4) — migration
  `004_signing.sql`.
- `tools/keygen.js` — prints a random `MASTER_KEY`, as `.env.example` already
  promised before this existed.
- `test/atrest.js`, `test/signing.js` — new suites; `test/postgres.js`
  extended with real-Postgres assertions for both.
- `docs/ROADMAP.md` — the twelve-phase plan, with a compliance matrix mapping
  each of the six mandatory requirements to a phase, an implementing file and
  a proving test.
- `docs/progress.md` — per-phase checklists and the working protocol.
- `.env.example` — every variable the system reads, with placeholder values
  and the reasoning behind each default.
- `docker-compose.yml` — app plus a local Postgres, so the database path is
  testable with no network.
- `.github/workflows/ci.yml` — test matrix on Node 22 and 24, a dependency
  audit, and a grep that fails the build if a Neon or Google credential is
  ever committed.

### Fixed
- The browser published its whisper (ECDH) public key in `ws.onopen`, before
  `join` — the server refuses any frame but join/pong from an unnamed
  session, so this was silently rejected on every fresh connection and
  sealed whispers never actually had a key to work with. Key publishing now
  happens on `welcome`, after the session is named — necessary groundwork
  once a *signing* key publish became load-bearing for chat itself, not only
  for the optional sealed-whisper feature.
- A burst of signed sends fired without awaiting each one could have their
  async signatures resolve, and therefore reach the server, out of call
  order — silently reordering a sender's own messages. Fixed with a FIFO
  signing chain, in both the real client and the test harness.

### Changed
- `README.md` — the layout tree now lists the files that actually exist. It
  previously referenced `docs/SPEC.md`, which never did.

---

## [2.0.0-lab2] — 14 Aug 2026

The Lab 2 submission. Real-time group chat on raw WebSockets: rooms,
whispers, polls, reactions, edits, self-destructing messages, presence and
typing, optional accounts on Postgres, and end-to-end encrypted rooms with
the server reduced to a blind relay.
