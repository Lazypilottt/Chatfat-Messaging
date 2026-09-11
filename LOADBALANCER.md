# Load Balancer Lab

A round-robin reverse-proxy load balancer in Go, in front of three copies of this
repository's messaging backend.

```
  Laptop                                   10.1.75.51
  ┌──────────────────┐            ┌────────────────────────────────────┐
  │ loadgen          │─── HTTP ──▶  │ Sys1 :3201  Load Balancer (Go)    │
  └──────────────────┘            │        │  round-robin + health      │
                                  │        ├──▶ Sys2 :4202  backend-1   │
                                  │        ├──▶ Sys3 :4203  backend-2   │
                                  │        └──▶ Sys4 :3204  backend-3   │
                                  └────────────────────────────────────┘
```

Every port below is an argument. Nothing about the addressing is compiled in —
substitute your own allocation throughout.

| System | SSH | App port | Additional forwarded ports | Runs |
|--------|-----|----------|-----------------------------|------|
| stu1_sys1 | `ssh -p 2201 student@10.1.75.51` | 3201 | 4201, 5201, 6201| load balancer |
| stu1_sys2 | `ssh -p 2202 student@10.1.75.51` | 4202 | 5202, 6202 | backend-1 |
| stu1_sys3 | `ssh -p 2203 student@10.1.75.51` | 4203 | 5203, 6203 | backend-2 |
| stu1_sys4 | `ssh -p 2204 student@10.1.75.51` | 3204 | 4204, 5204, 6204, 7204 | backend-3 |

The **App port** is the port used by the service inside each system's container.
The backend containers are not necessarily reachable through
`10.1.75.51:<App port>` from your laptop. The load balancer should use each
backend container's own address; only test the load balancer from the laptop
when its port is actually forwarded.

---

## Terminals 2, 3, 4 — the backends

Start these first, so the load balancer has something to health-check.

```bash
ssh -p 2202 student@10.1.75.51          # stu1_sys2
git clone <your-repo-url> Chatfat-Messaging
cd Chatfat-Messaging
npm install
```

Then, on each of the three, with its own port and name:

```bash
# stu1_sys2
PORT=4202 BACKEND_NAME=backend-1 DATABASE_URL=none BENCH_ENABLED=1 node server.js

# stu1_sys3
PORT=4203 BACKEND_NAME=backend-2 DATABASE_URL=none BENCH_ENABLED=1 node server.js

# stu1_sys4
PORT=3204 BACKEND_NAME=backend-3 DATABASE_URL=none BENCH_ENABLED=1 node server.js
```

| Variable | Why |
|----------|-----|
| `PORT` | the port to listen on |
| `BACKEND_NAME` | reported in the response body and the `X-Backend` header — this is how the report proves requests reached three machines and not one |
| `DATABASE_URL=none` | no persistence. Deliberate: the experiment measures HTTP request handling, and a database round-trip per request would make the shared store the bottleneck instead of the backends, flattening the comparison. The server refuses to start with this unset rather than silently storing nothing. |
| `BENCH_ENABLED=1` | exposes `/bench`. Without it the endpoint does not exist. |

Leave each running in its terminal. Check each backend from **Sys1**, first obtain the container address for each backend:

```bash
# Run on stu1_sys2, stu1_sys3, and stu1_sys4:
hostname -I

# Then run on stu1_sys1, replacing the addresses with the values returned above:
curl -s http://<sys2-container-ip>:4202/healthz
curl -s http://<sys3-container-ip>:4203/healthz
curl -s http://<sys4-container-ip>:3204/healthz
curl -si "http://<sys2-container-ip>:4202/bench?work=100" | grep -i x-backend
```

---

## Terminal 1 — the load balancer

Needs Go. If it is not installed:

```bash
sudo apt update && sudo apt install -y golang-go     # or:
curl -sSL https://go.dev/dl/go1.23.4.linux-amd64.tar.gz | tar -C ~/.local -xz \
  && export PATH=$HOME/.local/go/bin:$PATH
```

Then:

```bash
ssh -p 2201 student@10.1.75.51          # stu1_sys1
git clone <your-repo-url> chatfat-enc
cd chatfat-enc
go build -C lb -o ../bin/lb ./cmd/lb
```

Build into `bin/` at the repository root and run from the root throughout, so
`results/` lands where `tools/report.py` looks for it.

**Experiment 1 — Sys2 only:**

```bash
./bin/lb -listen 0.0.0.0:3201 \
  -backends http://<sys2-container-ip>:4202
```

**Experiment 2 — all three backends:**

```bash
./bin/lb -listen 0.0.0.0:3201 \
  -backends http://<sys2-container-ip>:4202,http://<sys3-container-ip>:4203,http://<sys4-container-ip>:3204
```

Stop with Ctrl-C and restart with the other `-backends` value to switch between
experiments. Flags:

| Flag | Default | Meaning |
|------|---------|---------|
| `-listen` | *required* | address to bind, e.g. `0.0.0.0:3201` |
| `-backends` | *required* | comma-separated backend URLs |
| `-health-path` | `/healthz` | path probed on each backend |
| `-health-interval` | `1s` | how often to probe |
| `-health-timeout` | `800ms` | per-probe timeout |
| `-backend-timeout` | `5s` | backend response-header timeout |
| `-unhealthy-threshold` | `3` | consecutive failed probes before eviction |
| `-healthy-threshold` | `1` | consecutive good probes before restoration |
| `-strict-eviction` | `false` | evict on **any** proxy error (see *Findings*) |

Monitoring endpoints:

```bash
curl -s http://127.0.0.1:3201/lb/health     # run on Sys1
curl -s http://127.0.0.1:3201/lb/status     # per-backend alive / in-flight / counts
curl -s http://127.0.0.1:3201/lb/metrics    # totals, dropout, throughput, p50/p95/p99
curl -sX POST http://127.0.0.1:3201/lb/reset  # zero the counters
```

Anything else is proxied round-robin to a healthy backend — including WebSocket
upgrades, so the chat application itself works through it.

### Check the routing before measuring

```bash
for i in $(seq 1 9); do
  curl -s "http://127.0.0.1:3201/bench?work=10" | grep -o '"backend":"[^"]*"'
done
```

You should see `backend-1`, `backend-2`, `backend-3` cycling. If one never
appears, `curl /lb/status` — it has been evicted, and `/lb/health` on that
backend will say why.

---

## Load generator on Sys1 (or your laptop through an SSH tunnel)

```bash
cd ~/Chatfat-Messaging
go build -C lb -o ../bin/loadgen ./cmd/loadgen
```

Four runs. Restart the load balancer with the matching `-backends` before each
pair.

Run the load generator on Sys1 so it can reach the load balancer on its local
port:

```bash
LB=http://127.0.0.1:3201

# --- Experiment 1: load balancer configured with Sys2 only ---
./bin/loadgen -url "$LB/bench?work=2000" -lb "$LB" \
  -requests 5000 -concurrency 40  -experiment 1-backend-steady
./bin/loadgen -url "$LB/bench?work=2000" -lb "$LB" \
  -requests 5000 -concurrency 300 -experiment 1-backend-overload

# --- restart the load balancer with all three backends, then ---
./bin/loadgen -url "$LB/bench?work=2000" -lb "$LB" \
  -requests 5000 -concurrency 40  -experiment 3-backend-steady
./bin/loadgen -url "$LB/bench?work=2000" -lb "$LB" \
  -requests 5000 -concurrency 300 -experiment 3-backend-overload
```

Wait a few seconds between runs so one run's backlog is not charged to the next
run's latency.

| Flag | Default | Meaning |
|------|---------|---------|
| `-url` | *required* | what to hammer |
| `-lb` | — | load balancer base URL. Resets its counters after the warmup and saves its `/lb/metrics` and `/lb/status` next to the result, so one command per experiment produces every file the report needs. |
| `-requests` | `5000` | total requests |
| `-concurrency` | `40` | worker-pool size |
| `-timeout` | `5s` | per-request timeout |
| `-warmup` | `200` | unmeasured requests first, to fill connection pools |
| `-experiment` | `baseline` | label; names the output files and the CSV row |
| `-out` | `results` | directory for the per-experiment JSON |
| `-csv` | `results/comparison.csv` | cumulative CSV, appended to |

Each run writes `results/<experiment>.json`,
`results/<experiment>.lb-metrics.json`, `results/<experiment>.lb-status.json`,
and appends a row to `results/comparison.csv`.

### Why `work=2000`

2000 rounds of SHA-256 on the backend, about 2 ms of CPU. Calibrated, not
arbitrary: Node is single-threaded, so at this cost one backend saturates at
roughly 490 rps, which is the precondition for the comparison meaning anything.

| `work` | Throughput | p50 |
|--------|-----------|-----|
| 500 | 1862 rps | 20.7 ms |
| 1000 | 985 rps | 39.6 ms |
| 2000 | 489 rps | 80.2 ms |
| 4000 | 248 rps | 158.1 ms |

Throughput halves as the work doubles — a fully saturated single core. Loading
`/` instead would be served from page cache, one backend would never saturate,
and all four runs would return the same numbers.

Two concurrencies because they show different things: at 40 nothing fails and you
measure throughput and latency; at 300 the single backend is past capacity and
dropout appears.

---

## The report

```bash
python3 tools/report.py --pdf
```

Writes `results/report.pdf` — one document with the student name, roll number,
assigned systems, load balancer code, comparison table and screenshots. Every
number is read from `results/`; nothing in it is transcribed by hand.

Override anything at run time:

```bash
python3 tools/report.py --pdf \
  --student "Your Name" --roll 12345678 \
  --host 10.1.75.51 --prefix stu1 \
  --app-ports 3201,4202,4203,3204 --ssh-ports 2201,2202,2203,2204
```

### Screenshots

Put them in `results/evidence/` and re-run. Images (`.png`, `.jpg`) and text
(`.txt`, `.log`, `.json`) are both embedded, in filename order, each captioned
with its filename — so name them for what they show:

```
results/evidence/01 three backends running on Sys2 Sys3 Sys4.png
results/evidence/02 lb-status with three healthy backends.png
results/evidence/03 round-robin distribution.png
results/evidence/04 loadgen output 1 backend.png
results/evidence/05 loadgen output 3 backends.png
```

Worth capturing:

```bash
curl -s http://10.1.75.51:3201/lb/status
curl -s http://10.1.75.51:3201/lb/metrics
for i in $(seq 1 12); do curl -s "http://10.1.75.51:3201/bench?work=10" | grep -o '"backend":"[^"]*"'; done
```

If the PDF needs adjusting, open `results/report.html` and print from the browser.

---

## Two findings worth reading before you submit

Both came out of the overload runs, and both are departures from the reference
design in the lecture slides.

**A timeout must not evict a backend.** The reference `ErrorHandler` calls
`b.Alive.Store(false)` on any proxy error. Measured, that collapses: the first
time an overloaded backend misses the response-header deadline it is evicted, and
with one backend configured there is then nothing in rotation, so every remaining
request is refused in microseconds — 5000 requests in 0.03 s at 100% dropout. The
load balancer, not the backend, is what failed. Here, connection-level errors
evict; timeouts return `504` and leave the backend in rotation for the health loop
to judge. `-strict-eviction` restores the original behaviour if you want to
reproduce the collapse.

**Health checks need hysteresis.** A saturated single-threaded backend cannot
answer a probe promptly, because the probe queues behind the request backlog.
Evicting on that one sample removes the last healthy backend; the offered load
then vanishes, the next probe succeeds, and it comes back — a flap loop that
reports the load balancer's own oscillation as backend failure.
`-unhealthy-threshold` (default 3) distinguishes *busy* from *gone*, and one
success restores, so recovery is not delayed by the margin that prevents flapping.

---

## Troubleshooting

**Backend exits immediately: "DATABASE_URL is not set".** By design — this server
refuses to start rather than silently discard messages. Use `DATABASE_URL=none`.

**Backend is reachable but `/bench` 404s.** `BENCH_ENABLED=1` was not set.

**Load balancer says a backend is DOWN, log shows `EOF`.** The backend came up as
HTTPS. This repository ships `tls-cert.pem` / `tls-key.pem`, and a `.env` setting
`TLS_CERT_FILE` turns TLS on — whereupon a plain-HTTP health probe gets an `EOF`
indistinguishable from a crash. Clear them for the backends:

```bash
TLS_CERT_FILE= TLS_KEY_FILE= PORT=4202 BACKEND_NAME=backend-1 \
  DATABASE_URL=none BENCH_ENABLED=1 node server.js
```

**Load balancer cannot reach a backend.** The four systems are containers behind
one host's port forwards, and a container cannot always route back through its own
host. From Sys1:

```bash
curl -v http://10.1.75.51:4202/healthz    # the forwarded port
```

If that fails, get the backend's own address (`hostname -I` on Sys2) and use it in
`-backends` instead.

**Address already in use.** A previous run is still up:

```bash
pkill -f 'node server.js'    # on a backend
pkill -f 'bin/lb'            # on Sys1
```

**Both experiments give the same throughput.** One backend was not saturated, so
there was nothing for the other two to relieve. Raise `work=` until the
single-backend run shows a p50 of a few tens of milliseconds.

**Process dies when SSH disconnects.** Expected — these run in the foreground on
purpose, so you can watch the logs. To survive a disconnect, use `tmux`:

```bash
tmux new -s backend
# start the server, then Ctrl-B D to detach; tmux attach -t backend to return
```
