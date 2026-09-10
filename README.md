# ChatFat

Real-time group chat on **raw WebSockets** — no Socket.IO, no framework, no build step.
One Node process serves the browser client over HTTP and relays every message over a
WebSocket on the same port. Rooms can be **locked**: end-to-end encrypted in the browser,
with the server reduced to a blind relay that stores and forwards ciphertext it cannot read.

```bash
npm install
npm start                              # port 3000, no accounts, nothing stored
```

Open the printed **lan** link on each machine. If one cannot connect, the firewall is the
first suspect: `sudo ufw allow 3000/tcp`.

---

## One switch

`DATABASE_URL` is the only thing that changes what this server is.

| `DATABASE_URL` | Accounts | Messages |
| --- | --- | --- |
| *(unset)* | — | **the server refuses to start** |
| `none` | off — a username is a claim, not an identity | nothing stored, nothing replayed |
| `memory` | on, in-process | stored in the heap, lost on restart |
| `postgres://…` | on, durable | stored in Postgres |

An **unset** `DATABASE_URL` used to mean "silently store nothing". It now exits with an
error naming the three real options, because a chat server that looks like it is working
while every message disappears is the one failure mode worth being loud about. Saying
`none` keeps that behaviour available — as a decision rather than an oversight.

```bash
PORT=9000 npm start
DATABASE_URL=memory npm start
DATABASE_URL='postgresql://…?sslmode=require' npm start
npm run dev                            # node --watch
```

**Recording and replaying are separate questions.** With a database configured, messages
*are* written — but `HISTORY_REPLAY` governs how many a joining client is handed. It is
`50` by default; set it to `0` and messages are still stored, you are simply handed none
of them on the way in.

### Neon

The deployed configuration points at [Neon](https://neon.tech). Copy the **pooled**
connection string — the host contains `-pooler` — and keep `?sslmode=require`; Neon
refuses plaintext connections.

Two things worth knowing before a demo:

- **The free tier scales to zero** after a few minutes idle, so the first query after a
  quiet spell pays roughly half a second of cold start. Harmless in use, alarming on a
  recording. Hit `/healthz` once before you start.
- **`pg` prints an SSL deprecation warning** for `sslmode=require` on startup. It is
  noise, not a misconfiguration; `verify-full` is what the driver already does.

**A `*.neon.tech` host automatically uses `@neondatabase/serverless` instead of `pg`** —
`src/db/pool.js` picks the driver by hostname, not by config. This tunnels the real Postgres
protocol over a WebSocket on port 443 rather than raw TCP on 5432. It matters because 5432 is
not always reachable: a campus or office network that only allows standard web ports out blocks
it *silently* — a timeout, not a rejection, and easy to mistake for a Neon or credentials
problem when it is neither. Test for this specifically with `nc -zv <pooler-host> 5432`; if that
hangs, it's the network, and the automatic switch to port 443 is what fixes it. `docker-compose.yml`'s
local Postgres has no such WebSocket proxy and correctly keeps using plain `pg`.

The schema is applied by numbered migrations in `src/db/migrations/`, tracked in a
`schema_version` table, each inside a transaction and behind an advisory lock so two
servers booting at once cannot both apply the same one. Editing a migration that has
already been applied is refused — its checksum is recorded, and a changed one means this
database and a fresh one have silently diverged.

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

A message beginning with `//` escapes the parser and is sent as literal text starting
with a single `/`.

---

## Encrypted rooms

The server relays over plain `ws://` on a LAN. Anyone on that network — and the operator,
and anyone who reads the Postgres table — can read every message. A locked room fixes that:
the key is derived in the browser from a passphrase that is never transmitted, and the
server has no code path that could decrypt.

```
salt  = SHA-256("ChatFat-room-v1|" + roomId)          deterministic, so a member who
K     = PBKDF2-HMAC-SHA-256(passphrase, salt,         joins later derives the key from
                            250 000 iterations, 256)  the passphrase alone
```

Messages are **AES-256-GCM** with a fresh 96-bit IV, and the AAD binds each ciphertext to
its room and key epoch so it cannot be replayed elsewhere. Whispers get their own scheme —
ephemeral **ECDH P-256** + HKDF, encrypted twice so your own log stays readable.

### What it protects, and what it does not

| Protected | **Not** protected |
| --- | --- |
| A passive listener on the LAN reading message text | Traffic analysis: who is in which room, when, how often |
| The operator reading stored message text | Metadata: sender names, timestamps, sizes, reactions, poll tallies, typing, presence |
| A database dump leaking conversation content | A member of the room — anyone with the passphrase reads everything |
| Someone joining later reading the backlog | An offline dictionary attack on a **weak** passphrase (hence the ≥ 10 character rule) |
| | A compromised browser, a keylogger, or a screenshot |
| | The server tampering with *delivery* — it can drop or reorder frames, it just cannot read them |

A locked room can never be unlocked back to plaintext. That would be a downgrade attack:
someone silently turns encryption off and everybody keeps typing.

Rotating the passphrase (`/lock` again) protects **new** messages. Anyone who already had
the old one can still read older ones — rotation does not re-encrypt history.

---

## At-rest encryption

Every stored message's `text` is encrypted with AES-256-GCM under a server-held
`MASTER_KEY` before it reaches the database — regardless of whether the room is locked.
This is a **different** guarantee from an encrypted room above, not a replacement for it:

| | Locked room (opt-in, per room) | At-rest encryption (always, every room) |
| --- | --- | --- |
| Key held by | Room members, derived from a passphrase | The server, via `MASTER_KEY` |
| Server can read it | No | Yes — that's the difference |
| Protects against | The operator, the network, a DB dump | A DB dump, a stolen backup, raw SQL access |

Losing `MASTER_KEY` makes all stored history unreadable — intended, not a bug. Back it up
somewhere that is not this repo. `MASTER_KEYS=v1:<old>,v2:<new>` lets you rotate without
stranding what the old key sealed.

**Tamper detection falls out of the same mechanism.** GCM's authentication tag is bound to
the message's own id, so a row altered directly in the database — a bit flipped, or one
row's ciphertext pasted into another's columns — fails to decrypt instead of decrypting to
garbage or to someone else's message. This is checked on every read (room join, scrollback),
not on a schedule: the server logs it, and the message renders with a visible integrity
warning instead of its (missing) content. Demonstrate it yourself:

```bash
ALLOW_TAMPER=1 node tools/tamper.js --room lab-room
```

then rejoin that room (or page back to it) in a running server.

---

## Message signing

Every sender has an ECDSA P-256 signing keypair, generated in the browser and kept in
IndexedDB — one per browser, reused across reconnects, never sent anywhere. Every `chat`
and `edit` is signed over `{room, sender, content}` before it leaves the browser, and
**verified twice**:

- **Server-side, before acceptance.** `onChat`/`onEdit` (`src/transport/handlers.js`) verify
  against the signing key that connection published; an unsigned, malformed, or wrongly-signed
  frame is refused outright — `SIGNATURE_REQUIRED` or `FORBIDDEN` — and never reaches the room
  or the database.
- **Client-side, independently, by every reader.** Each browser re-verifies a message's
  signature against the sender's own public key, itself — not taking the server's word for it.
  This is what catches a *live* broadcast altered in transit, a gap the server's own send-time
  check cannot close for its own traffic.

The signature travels with the stored row and is **re-verified on every future read** —
history replay, scrollback — independently of the at-rest cipher above. A row altered directly
in the database has to defeat both checks, not one, to pass as legitimate; either one failing
flags the message the same way tampered at-rest content does.

**Scope, stated plainly:** one signing keypair per *browser*, not per account. Two people
signed in as different names in the same browser profile would sign with the same key — real
identity binding would need the key pinned server-side against an account, which this does not
do.

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Bind interface. `127.0.0.1` keeps it local |
| `ALLOWED_ORIGINS` | *(empty)* | Comma-separated origins allowed to open a socket. Empty ⇒ the browser's `Origin` host must equal the `Host` it dialled |
| `DATABASE_URL` | *(unset ⇒ refuses to start)* | The one switch — see above |
| `DATA_DIR` | `./data` | Where `rooms.json` is written, when there is no database |
| `HISTORY_REPLAY` | `50` | How many stored messages a joining client receives. `0` replays nothing |
| `HISTORY_CAP` | `200` | Per-room in-memory buffer. Bounds how far back an edit/react/reply can reach; **not** a browsable window |
| `MAX_ROOMS` | `24` | Ceiling on rooms |
| `HEARTBEAT_MS` | `15000` | Heartbeat sweep interval |
| `AUTH_MAX_ATTEMPTS` | `10` | Failed sign-ins per minute per IP before HTTP 429 |
| `ENCRYPTION_ENABLED` | `1` | Set to `0` to forbid locking rooms on this server |
| `MAX_CIPHERTEXT` | `12288` | Byte cap on one ciphertext envelope |
| `MASTER_KEY` | *(unset ⇒ refuses to start once persistence is on)* | 32 random bytes, base64. Encrypts every stored message's `text` at rest (AES-256-GCM) — separate from, and in addition to, a locked room's client-side key. See "At-rest encryption" below |
| `MASTER_KEYS` | *(empty)* | `v1:<b64>,v2:<b64>` — a versioned list for key rotation. Overrides `MASTER_KEY` when set; the highest version is what new writes use, every version present can still read what it sealed |
| `ALLOW_TAMPER` | `0` | Lets `tools/tamper.js` corrupt a stored row on purpose, to demonstrate detection. Never set this on a deployed server |
| `ChatFat_ENV_FILE` | *(unset)* | Set to `off` to skip reading `.env` entirely. The test suites set this |

A `.env` in the repo root is read at startup. **The real environment always wins.**

---

## Layout

```
server.js                  entry point: loads src/app, installs signal handlers, starts
src/
  env.js                   minimal .env loader (Node 18 compatible, real env always wins)
  config.js                every tunable; the ONLY file that reads process.env
  logger.js                one prefixed logger, one seam
  app.js                   composition root: boot order, banner, shutdown
  state/hub.js             all mutable server state + id/colour/session factories
  db/pool.js               the single Postgres pool + schema migration (lazy `pg` require)
  auth/
    index.js               scrypt hashing, credential validation, register/login
    stores.js              MemoryStore | PgStore behind one interface
  rooms/
    index.js               creation, occupancy, roster, typing, lobby/room transitions
    directory.js           room directory persistence: Postgres or debounced JSON file
  messages/
    history.js             per-room in-memory ring buffer + burn timers
    repository.js          durable storage: Null | Memory | Pg behind one interface
    polls.js               poll serialisation (tally computed, never stored)
  protocol/
    frames.js              the wire envelope; send / broadcast / broadcastGlobal / fail
    validation.js          text cleaning, token bucket, server-side mention resolution
  transport/
    http.js                static serving, /healthz, /auth/* routes, login throttle
    websocket.js           upgrade policy, dispatch, lifecycle, heartbeat reaper
    handlers.js            one function per client frame type
  crypto/
    envelope.js            ciphertext envelope validation and size accounting
    atRest.js              server-keyed AES-256-GCM for stored text — the at-rest layer
    signature.js           ECDSA verification — canonical payload + verify(), never signs
public/
  index.html               join screen + lobby + chat shell (three screens, one document)
  style.css                design tokens, layout, components, light/dark
  client.js                socket lifecycle, reconnect, state machine, all rendering
  crypto.js                WebCrypto key derivation, encrypt/decrypt, key store
test/
  harness.js               spawned servers and real WebSocket clients
  protocol.js              the main suite — no database
  auth.js                  registration through impersonation
  persistence.js           storage + replay
  crypto.js                encrypted rooms and sealed whispers
  atrest.js                at-rest encryption + tamper detection, against MemoryRepo directly
  signing.js               signing keypairs + verification — happy path and every refusal
tools/
  loadtest.js              broadcast fan-out latency as room size grows
  tamper.js                corrupts one stored row on purpose, to demonstrate detection
  keygen.js                prints a random MASTER_KEY
docs/
  ROADMAP.md               the twelve-phase Lab 4 plan + compliance matrix
  progress.md              per-phase status; the tracker that says how far
  CONTRIBUTIONS.md         per-member contribution report
  DESIGN-SYSTEM.md         colour, type, space, motion tokens + contrast audit
```

Two rules hold the module graph together: `config.js` is the only module that reads
`process.env`, and transport depends on everything while nothing depends on transport.
`pg` is required **lazily**, so a checkout without it installed still runs in no-database
and `memory` modes.

---

## Tests

```bash
npm test                   # protocol   — no database
npm run test:auth          # accounts
npm run test:persistence   # storage + replay
npm run test:crypto        # encrypted rooms + sealed whispers
npm run test:atrest        # at-rest encryption + tamper detection
npm run test:signing       # signing keypairs + verification
npm run test:pg            # durability, keyset pagination, at-rest + tamper — real Postgres
npm run test:all
```

`test:pg` needs `TEST_DATABASE_URL` pointed at a real Postgres — it is skipped, loudly,
without it:

```bash
TEST_DATABASE_URL=postgresql://… npm run test:pg
```

Every suite spawns a real server and drives it with real WebSocket clients — except
`test:atrest`, which reaches into the repository module directly, because what's actually
sitting in a stored row versus what the wire protocol hands back is exactly the thing a
WebSocket client can never observe from outside; that opacity is the point of requirement 3.
`test:pg` proves the same thing again against a real database, over raw SQL. There is no
mocked clock anywhere: the heartbeat reaper and the burn fuse are real timers and the
suites wait them out. Each gets `ChatFat_ENV_FILE=off` and an isolated `DATA_DIR`, so a
developer's `.env` cannot reach a suite and fail it for the wrong reason.

The crypto suite reimplements the browser's key derivation independently, so it checks
`public/crypto.js` rather than calling into it — and it captures the server's stdout and
asserts that no message text ever appears there.

```bash
npm run loadtest                                   # 4, 16, 32, 64 clients
node tools/loadtest.js --encrypted                 # the same rungs in a locked room
node tools/loadtest.js --clients 8,64 --duration 12 --out results.json
```

All load clients share one process and one machine, so the figures exclude the network.
They measure the server, not the LAN.

---

## Disconnect handling

"Graceful handling of client disconnections" hides three failure modes, and **only two of
them fire a close event**.

| Failure | What the server sees | How it is caught | Reason |
| --- | --- | --- | --- |
| Tab closed, `/quit` | Close frame, code 1000 | `close` handler, instantly | *left* |
| Browser killed | TCP FIN/RST, code 1006 | Same handler | *lost connection* |
| **Cable pulled, Wi-Fi off** | **Nothing at all** — the socket stays `OPEN` forever | Heartbeat sweep only | *timed out* |

The third row is why the heartbeat is not optional. Worst-case detection is two intervals,
30 s at the default. All three paths converge on one idempotent `removeSession`.

---

## Docker

```bash
docker build -t chatfat .
docker run -p 3000:3000 -v chatfat-data:/data chatfat
```

`node` is PID 1 via the exec-form `CMD`, so it receives `SIGTERM` directly and the shutdown
handler closes every socket with **1001 "server going away"** before exiting. The banner
inside a container lists container-internal addresses — for a LAN demo, hand out the host's IP.

Behind a proxy, set `ALLOWED_ORIGINS` explicitly when the public name differs from the bound
host, and make sure `Upgrade` and `Connection` are forwarded. Under TLS the client dials
`wss://` automatically — it derives the scheme from `location.protocol`.

---

## Known limits

- **Authentication is optional and off by default.** Without `DATABASE_URL` a username is a
  claim, not an identity. With it, identity is real — but rooms are still open: any signed-in
  user can join any room they can see. Encryption is what makes a room actually private.
- **Plaintext `ws://`.** Encrypted rooms protect message content over a plaintext transport,
  but credentials on `/auth/*` are still in the clear without TLS. Use a throwaway password
  on a lab LAN.
- **Single process.** Every room lives in one heap, capped at 24 rooms.
- **One room at a time.** No unread badges for rooms you are not in, because you are not
  receiving them at all.
- **Ephemeral messages are not secure deletion.** They leave every client's DOM and the
  database, but a recipient who screenshots still keeps it.
- **Encryption protects content, not metadata.** See the table above — and the product says
  this in the key modal and the room banner, not only here.
- **At-rest encryption trusts the running server.** `MASTER_KEY` protects a database dump or a
  stolen backup, not a compromised or malicious server process — that guarantee is what a
  locked room's client-side key is for, and it's a different one.
- **Tamper detection is reactive, not continuous.** A corrupted row is caught the next time it
  is actually read — room join, scrollback — not on a schedule. Nothing notices tampering in a
  row nobody happens to load.
- **A signing keypair is per browser, not per account.** Two names signed in from the same
  browser profile share one key. Real per-identity binding would need the key pinned
  server-side against an account.
