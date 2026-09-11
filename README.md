# ChatFat

A group chat server built on **plain WebSockets** — nothing from Socket.IO, no bundler, no build
step. One Node process handles both jobs: it serves the browser client over HTTP and relays
every message over a WebSocket on that same port. Rooms can be **locked**, which turns on
end-to-end encryption in the browser and demotes the server to a dumb relay — it stores and
forwards ciphertext it has no way to read.

```bash
npm install
npm start                              # port 3000, no accounts, nothing persisted
```

Open the **lan** URL that gets printed, on each machine you want in the room. Connection
refused? Check the firewall first: `sudo ufw allow 3000/tcp`.

---

## One environment variable decides everything

`DATABASE_URL` is the single knob that determines what kind of server this is.

| `DATABASE_URL` | Accounts | Messages |
| --- | --- | --- |
| *(unset)* | — | **server won't boot** |
| `none` | disabled — usernames are claims, not identities | never written, never replayed |
| `memory` | enabled, in-process | lives in the heap, gone on restart |
| `postgres://…` | enabled, durable | lives in Postgres |

Leaving `DATABASE_URL` **unset** used to mean "quietly persist nothing." That's now a startup
error listing the three legitimate choices — a chat server that appears to work while every
message vanishes is exactly the failure mode that shouldn't fail silently. `none` still gets you
that same no-storage behavior, but now it's something you typed on purpose.

```bash
PORT=9000 npm start
DATABASE_URL=memory npm start
DATABASE_URL='postgresql://…?sslmode=require' npm start
npm run dev                            # node --watch
```

**Storing a message and replaying it to a new joiner are two different decisions.** Once a
database is wired up, messages get written regardless — `HISTORY_REPLAY` only controls how many
of them a client sees on join. Default is `50`. Set it to `0` and storage keeps happening, the
new arrival just gets handed nothing.

### Running against Neon

Production points at [Neon](https://neon.tech). Grab the **pooled** connection string (look for
`-pooler` in the hostname) and don't drop `?sslmode=require` — Neon won't accept a plaintext
connection.

Two gotchas before you demo this live:

- **Free-tier Neon scales to zero** after sitting idle a few minutes, so the first query after a
  lull eats about half a second of cold-start latency. Fine in practice, looks broken on a
  screen recording. Ping `/healthz` once before you go live.
- **`pg` logs an SSL deprecation warning** for `sslmode=require` at boot. That's cosmetic — the
  driver is already doing `verify-full` under the hood, ignore it.

**Any `*.neon.tech` hostname swaps the driver to `@neondatabase/serverless` automatically** —
`src/db/pool.js` decides based on hostname, not config. That driver tunnels real Postgres wire
protocol over a WebSocket on port 443 instead of raw TCP on 5432, and that swap matters:
networks that only permit outbound traffic on standard web ports (a campus, a locked-down
office) will block 5432 **silently** — no rejection, just a hang, and it's easy to blame Neon or
your credentials when it's neither. Diagnose it directly with `nc -zv <pooler-host> 5432`; if
that hangs, it's the network's fault, and the automatic 443 fallback is exactly the fix.
`docker-compose.yml`'s local Postgres has no such proxy sitting in front of it, so it stays on
plain `pg` as expected.

Schema changes live as numbered migrations under `src/db/migrations/`, tracked via a
`schema_version` table, each one wrapped in a transaction and gated by an advisory lock so two
servers racing to boot can't both apply the same migration. Touching a migration that's already
run is a hard refusal — its checksum was recorded at apply time, and a mismatch means this
database's history and a fresh checkout's have quietly forked.

---

## Commands

```
/help                       list every command
/rooms                      list the rooms on this server
/join <room>                switch to another room
/leave                      leave this room, back to the lobby
/users                      who is in the room right now
/w <user> <message>         private message (aliases: /whisper, /msg)
/me <action>                emote
/poll Question? a | b | c   open a live poll
/burn <seconds> <message>   self-destructing message
/nick <name>                change your display name
/ping                       show round-trip time
/clear                      clear your own view of the log
/theme                      switch light / dark / system
/quit                       leave

/lock <passphrase>          turn this room into an encrypted room
/unlock <passphrase>        supply the key for an encrypted room you are in
/key                        show the key fingerprint for this room
/forget                     drop the stored key for this room from this browser
/seal                       toggle sealed (E2E encrypted) whispers
```

Start a message with `//` to skip command parsing entirely — it goes out as literal text
beginning with a single `/`.

---

## Encrypted rooms

Plain `ws://` on a LAN is readable by anyone sniffing that network, and by the operator, and by
anyone with query access to the Postgres table. A locked room closes that hole: the key is
derived client-side from a passphrase that never touches the wire, and there's no server code
path capable of decrypting it.

```
salt  = SHA-256("ChatFat-room-v1|" + roomId)          deterministic — a member joining
K     = PBKDF2-HMAC-SHA-256(passphrase, salt,         later derives the same key from
                            250 000 iterations, 256)  the passphrase alone
```

Every message goes out **AES-256-GCM** with a fresh 96-bit IV, and the AAD ties each ciphertext
to its room and key epoch so it can't be lifted and replayed somewhere else. Whispers run a
separate scheme entirely — ephemeral **ECDH P-256** plus HKDF, encrypted to both recipient and
sender so your own sent history stays legible.

### The threat model, spelled out

| Covered | **Not covered** |
| --- | --- |
| Someone sniffing the LAN and reading message bodies | Traffic analysis — who's in which room, and when, and how often |
| The operator reading stored message text | Metadata: sender names, timestamps, message sizes, reactions, poll tallies, typing indicators, presence |
| A leaked database dump exposing conversation content | Anyone who *is* in the room — knowing the passphrase means reading everything |
| Someone joining later reading old messages | Offline brute-forcing of a **weak** passphrase (this is why there's a 10-character floor) |
| | A compromised browser, a keylogger, a screenshot |
| | The server messing with delivery — it can still drop or reorder frames, it just can't read the contents |

There's no path back from locked to plaintext. Allowing that would be a silent downgrade
attack — someone flips encryption off unnoticed and everyone keeps typing as before.

Re-running `/lock` with a new passphrase protects messages sent **after** the rotation. It does
not re-encrypt the backlog — anyone holding the old passphrase can still read everything that
predates the change.

---

## Encryption at rest

Independent of whether a room is locked, every stored message's `text` gets AES-256-GCM'd under
a server-held `MASTER_KEY` before it ever touches the database. This is a **separate**
guarantee from a locked room, not a substitute for one:

| | Locked room (opt-in, per-room) | At-rest encryption (always on, every room) |
| --- | --- | --- |
| Who holds the key | Room members — derived from a shared passphrase | The server, via `MASTER_KEY` |
| Can the server read it | No | Yes — that's the whole distinction |
| Defends against | The operator, the network, a DB dump | A DB dump, a stolen backup, raw SQL access |

Lose `MASTER_KEY` and every stored message becomes unreadable — that's by design, not a defect,
so back it up somewhere outside this repo. `MASTER_KEYS=v1:<old>,v2:<new>` supports rotation
without orphaning whatever the old key already sealed.

**Tamper detection is a side effect of the same mechanism.** GCM's auth tag is bound to the
message's own id, so directly editing a row in the database — flipping a bit, or splicing one
row's ciphertext into another's columns — fails decryption outright rather than producing
garbage or someone else's message. That check runs on every read (joining a room, scrolling
back), not on any schedule: it gets logged, and the affected message renders with a visible
integrity warning instead of content. See it happen yourself:

```bash
ALLOW_TAMPER=1 node tools/tamper.js --room lab-room
```

...then rejoin (or scroll back to) that room on a live server.

---

## Message signing

Each sender generates an ECDSA P-256 keypair in-browser, stored in IndexedDB — one per browser,
carried across reconnects, never transmitted. Every `chat` and `edit` frame is signed over
`{room, sender, content}` client-side before it's sent, and checked **twice**:

- **On the server, before it's accepted.** `onChat`/`onEdit` in `src/transport/handlers.js`
  verify the signature against the signing key that connection registered; a frame that's
  unsigned, malformed, or wrongly signed gets rejected outright — `SIGNATURE_REQUIRED` or
  `FORBIDDEN` — and never reaches the room or the database.
- **On every client, independently.** Each browser re-verifies a message's signature against
  the sender's public key on its own, rather than trusting the server's judgment. This is what
  catches a broadcast tampered with *in flight* — something the server's own accept-time check
  can't cover for traffic it's already forwarding.

The signature rides along with the stored row and gets **re-checked on every subsequent read** —
history replay, scrollback — independently of the at-rest encryption layer above. Directly
editing a row in the database now has to beat both checks, not just one, and either check
failing flags the message the same way tampered at-rest content does.

**Where this stops:** one keypair per *browser*, not per account. Two people logged in under
different names in the same browser profile sign with the identical key. True per-identity
binding would mean pinning the key server-side to an account, which this doesn't attempt.

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Bind interface. `127.0.0.1` restricts to local only |
| `ALLOWED_ORIGINS` | *(empty)* | Comma-separated list of origins allowed to open a socket. Empty means the browser's `Origin` host must match the `Host` it dialled |
| `DATABASE_URL` | *(unset ⇒ refuses to start)* | The one switch — see above |
| `DATA_DIR` | `./data` | Where `rooms.json` gets written when there's no database |
| `HISTORY_REPLAY` | `50` | How many stored messages a joining client is handed. `0` disables replay |
| `HISTORY_CAP` | `200` | Per-room in-memory ring buffer size. Limits how far back an edit/react/reply can reach; **not** a scrollback window |
| `MAX_ROOMS` | `24` | Room count ceiling |
| `HEARTBEAT_MS` | `15000` | Interval between heartbeat sweeps |
| `AUTH_MAX_ATTEMPTS` | `10` | Failed logins per IP per minute before HTTP 429 kicks in |
| `ENCRYPTION_ENABLED` | `1` | `0` disables room locking on this server entirely |
| `MAX_CIPHERTEXT` | `12288` | Byte ceiling on a single ciphertext envelope |
| `MASTER_KEY` | *(unset ⇒ refuses to start once persistence is on)* | 32 random bytes, base64-encoded. Encrypts stored message `text` at rest (AES-256-GCM) — separate from and additional to a locked room's client-side key. See "Encryption at rest" above |
| `MASTER_KEYS` | *(empty)* | `v1:<b64>,v2:<b64>` — versioned key list for rotation. Takes precedence over `MASTER_KEY` when set; new writes use the highest version, and every listed version can still decrypt what it originally sealed |
| `ALLOW_TAMPER` | `0` | Enables `tools/tamper.js` to intentionally corrupt a stored row, for demoing tamper detection. Never turn this on in production |
| `ChatFat_ENV_FILE` | *(unset)* | `off` skips loading `.env` entirely. Test suites set this |

`.env` in the repo root loads at startup, but **real environment variables always take
priority.**

---

## Project layout

```
server.js                  entry point: loads src/app, wires signal handlers, starts listening
src/
  env.js                   minimal .env loader (Node 18-compatible; real env always wins)
  config.js                every tunable lives here; the ONLY module that reads process.env
  logger.js                one prefixed logger, one seam
  app.js                   composition root — boot sequence, banner, shutdown
  state/hub.js             all mutable server state + id/colour/session factories
  db/pool.js               the single Postgres pool + schema migrations (lazy `pg` require)
  auth/
    index.js               scrypt hashing, credential checks, register/login flow
    stores.js              MemoryStore | PgStore behind one shared interface
  rooms/
    index.js               room creation, occupancy, roster, typing state, lobby/room transitions
    directory.js           room directory persistence — Postgres or a debounced JSON file
  messages/
    history.js             per-room in-memory ring buffer + burn-message timers
    repository.js          durable storage: Null | Memory | Pg behind one shared interface
    polls.js               poll serialisation (tallies computed on the fly, never stored)
  protocol/
    frames.js              wire envelope format; send / broadcast / broadcastGlobal / fail
    validation.js          text sanitising, token bucket rate limiting, server-side mention resolution
  transport/
    http.js                static file serving, /healthz, /auth/* routes, login throttling
    websocket.js           upgrade handling, dispatch, connection lifecycle, heartbeat reaper
    handlers.js            one handler function per client frame type
  crypto/
    envelope.js            ciphertext envelope validation and size accounting
    atRest.js              server-keyed AES-256-GCM for stored text — the at-rest layer
    signature.js           ECDSA verification only — canonical payload + verify(), never signs
public/
  index.html               join screen + lobby + chat shell — three screens, one document
  style.css                design tokens, layout rules, components, light/dark themes
  client.js                socket lifecycle, reconnect logic, state machine, rendering
  crypto.js                WebCrypto key derivation, encrypt/decrypt, local key store
test/
  harness.js               spawns real servers, drives them with real WebSocket clients
  protocol.js              the core suite — runs with no database
  auth.js                  registration through impersonation attempts
  persistence.js           storage behavior + replay behavior
  crypto.js                encrypted rooms + sealed whispers
  atrest.js                at-rest encryption + tamper detection, driven straight against MemoryRepo
  signing.js               signing keypairs + verification — happy path and every rejection case
tools/
  loadtest.js              measures broadcast fan-out latency as room size grows
  tamper.js                deliberately corrupts one stored row, to demo detection
  keygen.js                prints a random MASTER_KEY
docs/
  ROADMAP.md               the twelve-phase Lab 4 plan + compliance matrix
  progress.md              per-phase status tracker
  CONTRIBUTIONS.md         per-member contribution breakdown
  DESIGN-SYSTEM.md         colour, type, spacing, motion tokens + contrast audit
```

Two rules keep this module graph sane: `config.js` is the only place that touches
`process.env`, and transport depends on everything else while nothing depends back on transport.
`pg` is a **lazy** require, so a checkout that never installed it still runs fine in no-database
or `memory` mode.

---

## Tests

```bash
npm test                   # protocol   — no database
npm run test:auth          # accounts
npm run test:persistence   # storage + replay
npm run test:crypto        # encrypted rooms + sealed whispers
npm run test:atrest        # at-rest encryption + tamper detection
npm run test:signing       # signing keypairs + verification
npm run test:pg            # durability, keyset pagination, at-rest + tamper — against real Postgres
npm run test:all
```

`test:pg` needs `TEST_DATABASE_URL` pointed at an actual Postgres instance, and skips loudly
without one:

```bash
TEST_DATABASE_URL=postgresql://… npm run test:pg
```

Every suite spins up a real server and pokes it with real WebSocket clients — with one
exception: `test:atrest` reaches directly into the repository module, because what's actually
sitting in a database row versus what the wire protocol returns is precisely the thing a
WebSocket client can never observe from the outside, and that opacity gap is what requirement 3
is testing for. `test:pg` re-proves the same guarantee against a real database over raw SQL.
Nothing is mocked on the clock front — the heartbeat reaper and burn-message fuse are real
timers, and the suites just wait them out. Every suite runs with `ChatFat_ENV_FILE=off` and its
own isolated `DATA_DIR`, so a developer's local `.env` can't leak into a suite and break it for
unrelated reasons.

The crypto suite reimplements the browser's key derivation from scratch rather than importing
`public/crypto.js`, so it's actually validating that file rather than trusting it — and it
captures the server's stdout to assert that message text never shows up there.

```bash
npm run loadtest                                   # 4, 16, 32, 64 clients
node tools/loadtest.js --encrypted                 # same client counts, but in a locked room
node tools/loadtest.js --clients 8,64 --duration 12 --out results.json
```

All load-test clients run in one process on one machine, so these numbers measure the server in
isolation — the network isn't part of the figure.

---

## Handling disconnects

"Handle disconnections gracefully" is really three distinct failure cases, and **only two of
them ever generate a close event.**

| Failure | What the server actually observes | Detection path | Logged as |
| --- | --- | --- | --- |
| Tab closed, `/quit` used | Close frame, code 1000 | `close` handler, immediately | *left* |
| Browser process killed | TCP FIN/RST, code 1006 | Same `close` handler | *lost connection* |
| **Cable yanked, Wi-Fi killed** | **Nothing — the socket looks `OPEN` indefinitely** | Only caught by the heartbeat sweep | *timed out* |

That third row is the whole reason the heartbeat exists. Worst case, detection takes two sweep
intervals — 30 seconds at the default. Whichever path triggers, they all funnel into one
idempotent `removeSession` call.

---

## Docker

```bash
docker build -t chatfat .
docker run -p 3000:3000 -v chatfat-data:/data chatfat
```

The exec-form `CMD` makes `node` PID 1, so it gets `SIGTERM` directly and the shutdown handler
closes every open socket with **1001 "server going away"** before the process exits. The startup
banner inside a container lists container-internal addresses — for a real LAN demo, hand out the
host machine's IP instead.

Running behind a reverse proxy: set `ALLOWED_ORIGINS` explicitly whenever the public-facing name
differs from the bound host, and make sure `Upgrade` and `Connection` headers actually get
forwarded. Under TLS the client dials `wss://` on its own — it takes the scheme straight from
`location.protocol`.

---

## Known limitations

- **Auth is opt-in and off by default.** No `DATABASE_URL` means a username is a claim, not a
  verified identity. With a database configured, identity becomes real — but rooms stay open
  regardless: any signed-in user can join any visible room. Actual privacy comes from
  encryption, not from accounts.
- **The transport is plaintext `ws://`.** Locked rooms protect message content over that
  plaintext channel, but `/auth/*` credentials still travel in the clear without TLS in front of
  it. Use a disposable password on a lab LAN.
- **One process, one heap.** Every room lives in the same process, capped at 24 rooms total.
- **You're only ever in one room.** No unread badges for rooms you've left, because you simply
  aren't receiving anything from them.
- **Self-destructing messages aren't secure deletion.** They disappear from every connected
  client's DOM and from the database, but if someone already screenshotted it, that copy
  survives.
- **Encryption covers content, not metadata.** Same table as above applies — and the product
  says as much in the key modal and the room banner, not just in this doc.
- **At-rest encryption assumes a trustworthy running server.** `MASTER_KEY` defends against a
  stolen backup or a database dump, not against a compromised or malicious server process —
  that's precisely the gap a locked room's client-side key is meant to fill, and it's a distinct
  guarantee.
- **Tamper detection is reactive, not continuous.** A corrupted row only gets caught the next
  time something actually reads it — on join, on scrollback. A row nobody ever loads again stays
  silently corrupted.
- **Signing keys are scoped to the browser, not the account.** Two identities logged in from the
  same browser profile share a single signing key. Real per-identity binding would require
  pinning the key server-side to an account, which isn't implemented here.