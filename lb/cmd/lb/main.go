// Command lb is the round-robin reverse-proxy load balancer that runs on Sys1.
//
// Topology for the assignment:
//
//	Load Generator (laptop) --> LB (Sys1) --> ChatFat backends on Sys2/Sys3/Sys4
//
// The backends are the messaging project itself, so the health path defaults to
// /healthz (what ChatFat exposes) rather than the /health of a toy backend, and
// the proxy is left able to carry WebSocket upgrades: net/http/httputil has
// handled 101 responses natively since Go 1.20, and the chat app is useless
// through a proxy that cannot.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Backend is one upstream server. Every mutable field is atomic because a
// request goroutine, the health loop and the metrics handler all touch them
// concurrently.
type Backend struct {
	URL      *url.URL
	Alive    atomic.Bool
	InFlight atomic.Int64

	Requests atomic.Uint64 // requests dispatched here
	Chosen   atomic.Uint64 // times the load-based picker selected this backend

	// Unix nanos of the last request this backend completed successfully.
	// Health probes are advisory while this is recent: a saturated
	// single-threaded backend cannot always answer /healthz inside the probe
	// timeout, and evicting it then removed backends that were demonstrably
	// working — 1,627 requests were refused with "no healthy backend" in one
	// run while all three backends were serving.
	lastGoodNanos atomic.Int64
	Errors        atomic.Uint64 // proxy failures charged to this backend

	// Consecutive probe outcomes, for the eviction/restoration hysteresis
	// below. Only the health loop writes these, and only from one goroutine
	// per backend, so plain ints under the health loop's ownership would do —
	// atomics keep /lb/status able to report them.
	failStreak atomic.Int64
	okStreak   atomic.Int64

	// — load signals, for performance-based selection —
	//
	// Two independent sources, because each is blind in a way the other is not.
	// latencyEWMA is what this load balancer actually observed, so it needs no
	// cooperation and cannot be misreported; but it only rises once requests
	// have already been sent somewhere slow. reportedLag is the backend's own
	// event-loop delay, which is the delay a request will meet on arrival — a
	// leading indicator, at the cost of trusting the backend to publish it.
	//
	// Microseconds throughout: atomic.Int64 has no float form, and a
	// millisecond integer is too coarse for a backend answering in under 1 ms.
	latencyEWMAMicros atomic.Int64
	reportedLagMicros atomic.Int64
	reportedCPUMilli  atomic.Int64 // CPU percent × 1000
	reportedInFlight  atomic.Int64

	proxy *httputil.ReverseProxy
}

func (b *Backend) Name() string { return b.URL.Host }

// observeLatency folds one proxied request's duration into the backend's EWMA.
//
// alpha is deliberately quick (0.2): the point of routing on load is to notice
// a backend degrading, and a slow filter would keep sending traffic to it for
// seconds after the fact. The cost of being quick is sensitivity to single slow
// requests, which the in-flight term in score() offsets — a backend that is
// merely unlucky has no queue, so it scores well again immediately.
func (b *Backend) observeLatency(d time.Duration) {
	const alphaNum, alphaDen = 1, 5
	us := d.Microseconds()
	for {
		old := b.latencyEWMAMicros.Load()
		var next int64
		if old == 0 {
			next = us
		} else {
			next = old + (us-old)*alphaNum/alphaDen
		}
		if b.latencyEWMAMicros.CompareAndSwap(old, next) {
			return
		}
	}
}

// absorbLoad pulls the load figures out of a /healthz body.
//
// Parsed leniently and on a best-effort basis: a backend that does not publish
// a load block is not a broken backend, it just leaves this balancer relying on
// its own latency measurements. So a decode failure is silent and the previous
// values stand rather than being zeroed, which would read as "idle" and attract
// traffic to a backend nobody can see into.
func (b *Backend) absorbLoad(body []byte) {
	var payload struct {
		Load struct {
			LagMs      float64 `json:"lag_ms"`
			CPUPercent float64 `json:"cpu_percent"`
			InFlight   int64   `json:"in_flight"`
		} `json:"load"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return
	}
	b.reportedLagMicros.Store(int64(payload.Load.LagMs * 1000))
	b.reportedCPUMilli.Store(int64(payload.Load.CPUPercent * 1000))
	b.reportedInFlight.Store(payload.Load.InFlight)
}

// score estimates, in milliseconds, how long a request sent to this backend
// would take to come back. Lower is better, and the units matter: an estimate
// in real time is comparable between backends of different speeds, which a bare
// connection count is not.
//
//	(in-flight + 1) × observed service time     the queue this request joins
//	+ event-loop delay the backend reports      the wait before its turn starts
//
// The +1 is the request being scheduled. Without it an idle backend scores 0
// regardless of how slow it is, and the balancer would send it everything.
func (b *Backend) score() float64 {
	svcMs := float64(b.latencyEWMAMicros.Load()) / 1000
	if svcMs == 0 {
		// Nothing measured yet. A neutral, deliberately small estimate: a new
		// or just-restored backend should be tried, not starved by an
		// optimistic 0 or excluded by a pessimistic large value.
		svcMs = 1
	}

	// A measurement decays with age, because the service time of a backend that
	// has served nothing for the last few seconds is not evidence about what it
	// would do now.
	//
	// Without this the threshold is a one-way door. The estimate only updates
	// when the backend serves a request, so a backend pushed above the
	// threshold by one slow spell is excluded, and being excluded it serves
	// nothing, so the estimate never improves and the exclusion is permanent.
	// Observed live: one backend sat at 2623 ms and took no traffic at all
	// while its two peers carried everything, and nothing could ever bring it
	// back. Halving the estimate for every scoreHalfLife of silence makes
	// exclusion self-correcting — a quiet backend becomes eligible again on its
	// own, and if it really is slow the next request it serves says so.
	if last := b.lastGoodNanos.Load(); last > 0 && scoreHalfLife > 0 {
		if idle := time.Since(time.Unix(0, last)); idle > 0 {
			svcMs /= math.Exp2(float64(idle) / float64(scoreHalfLife))
		}
	}

	queue := float64(b.InFlight.Load() + 1)
	lagMs := float64(b.reportedLagMicros.Load()) / 1000
	return queue*svcMs + lagMs
}

// Metrics are the load balancer's own counters, reported by /lb/metrics.
type Metrics struct {
	Total            atomic.Uint64
	Success          atomic.Uint64
	Failed           atomic.Uint64
	BackendErrors    atomic.Uint64
	NoBackend        atomic.Uint64 // rejected because every backend was down
	ClientCanceled   atomic.Uint64 // client gave up before the backend answered
	AllOverThreshold atomic.Uint64 // every healthy backend was above -load-threshold
	TLSHandshakes    atomic.Uint64 // inbound connections that died before the TLS handshake finished

	// Fixed-size histogram: no allocation, no lock, no growth.
	hist     [histBuckets]atomic.Uint64
	latSumUs atomic.Int64
	latCount atomic.Uint64
}

// Latency is recorded into a fixed histogram of atomic counters, not a slice
// under a mutex.
//
// The slice version was wrong in two ways that only appeared under real load.
// It grew with traffic, and at 250 concurrent users the process was OOM-killed
// inside a 512 MB cgroup — taking the database down with it. And every request
// took the same mutex, serialising the one part of a reverse proxy that has no
// reason to be serial: measured, that cost 1.4 ms of CPU per request.
//
// Buckets are exponential: fine where it matters (sub-millisecond to tens of
// ms), coarse in the tail, which is the right resolution trade for percentiles.
// A reported percentile is accurate to about one bucket width rather than
// exactly, in exchange for a recording path that is one atomic add and
// allocates nothing.
// 120 buckets at 12.5% growth span 0.05 ms to ~66 s, which covers a 30 s
// client timeout without the tail piling into the last bucket. 120 counters is
// under a kilobyte, so the resolution is nearly free.
//
// Note that the metric the leaderboard ranks on — mean response time — is
// computed exactly from a running sum, not from these buckets. The histogram
// only serves the percentiles, where a 12.5% bound is fine.
const (
	histBuckets = 120
	histBase    = 1.125
	histFirstMs = 0.05
)

func bucketFor(d time.Duration) int {
	ms := float64(d.Microseconds()) / 1000
	if ms <= histFirstMs {
		return 0
	}
	i := int(math.Log(ms/histFirstMs)/math.Log(histBase)) + 1
	if i >= histBuckets {
		return histBuckets - 1
	}
	return i
}

// bucketUpperMs is the inclusive upper edge of a bucket, in milliseconds.
func bucketUpperMs(i int) float64 {
	if i <= 0 {
		return histFirstMs
	}
	return histFirstMs * math.Pow(histBase, float64(i))
}

func (m *Metrics) observe(d time.Duration) {
	m.hist[bucketFor(d)].Add(1)
	m.latSumUs.Add(d.Microseconds())
	m.latCount.Add(1)
}

// percentileMs reads a percentile out of the histogram.
func (m *Metrics) percentileMs(p float64) float64 {
	total := m.latCount.Load()
	if total == 0 {
		return 0
	}
	want := uint64(p / 100 * float64(total))
	var seen uint64
	for i := 0; i < histBuckets; i++ {
		seen += m.hist[i].Load()
		if seen >= want {
			// Geometric midpoint rather than the upper edge: the upper edge
			// systematically overstates by up to one bucket width, and the
			// midpoint halves that error in both directions.
			if i == 0 {
				return round2(histFirstMs)
			}
			return round2(math.Sqrt(bucketUpperMs(i-1) * bucketUpperMs(i)))
		}
	}
	return round2(bucketUpperMs(histBuckets - 1))
}

func (m *Metrics) meanMs() float64 {
	n := m.latCount.Load()
	if n == 0 {
		return 0
	}
	return round2(float64(m.latSumUs.Load()) / float64(n) / 1000)
}

func (m *Metrics) samples() uint64 { return m.latCount.Load() }

func (m *Metrics) reset() {
	m.Total.Store(0)
	m.Success.Store(0)
	m.Failed.Store(0)
	m.BackendErrors.Store(0)
	m.NoBackend.Store(0)
	m.ClientCanceled.Store(0)
	m.TLSHandshakes.Store(0)
	for i := range m.hist {
		m.hist[i].Store(0)
	}
	m.latSumUs.Store(0)
	m.latCount.Store(0)
}

type LoadBalancer struct {
	backends []*Backend
	next     atomic.Uint64
	metrics  Metrics
	// Unix nanoseconds rather than a time.Time, because /lb/reset restarts the
	// measurement window while the metrics handlers are reading it. A time.Time
	// is a multi-word struct, so that is a genuine torn-read race (the detector
	// flags it); an atomic int64 makes the reset publish a single value.
	startedNanos atomic.Int64
}

// backendTLS is the TLS configuration used for every outbound connection to a
// backend — the proxy's and the health probe's alike. They must agree: a health
// loop that trusts the certificate while the proxy does not (or the reverse)
// reports a backend as healthy and then fails every request to it.
func backendTLS() *tls.Config {
	if !insecureBackends {
		return nil // system trust store
	}
	return &tls.Config{InsecureSkipVerify: true} // #nosec G402 — see insecureBackends
}

func (lb *LoadBalancer) markStart() { lb.startedNanos.Store(time.Now().UnixNano()) }

// uptime is the length of the current measurement window: since process start,
// or since the last /lb/reset.
func (lb *LoadBalancer) uptime() time.Duration {
	return time.Since(time.Unix(0, lb.startedNanos.Load()))
}

// healthy returns the backends currently eligible to receive traffic.
func (lb *LoadBalancer) healthy() []*Backend {
	out := make([]*Backend, 0, len(lb.backends))
	for _, b := range lb.backends {
		if b.Alive.Load() {
			out = append(out, b)
		}
	}
	return out
}

// roundRobin is the original fixed rotation, kept only so the report can
// measure what performance-based selection is worth. Not the default.
func (lb *LoadBalancer) roundRobin() *Backend {
	n := uint64(len(lb.backends))
	if n == 0 {
		return nil
	}
	for i := uint64(0); i < n; i++ {
		idx := lb.next.Add(1) % n
		if b := lb.backends[idx]; b.Alive.Load() {
			return b
		}
	}
	return nil
}

// nextBackend chooses where to send one request.
//
// The threshold is what makes this switch rather than merely balance: a backend
// whose estimated response time exceeds -load-threshold is treated as
// overloaded and skipped entirely while any backend is below it. Below the
// threshold every healthy backend is a candidate and the cheapest is preferred;
// above it — when all of them are loaded — the least-bad is still used, because
// refusing a request that some backend could have served helps nobody.
//
// Among candidates the default is power-of-two-choices: sample two at random
// and take the better. Always taking the single best backend sounds stronger
// and behaves worse under concurrency, because every goroutine deciding at once
// reads the same scores and sends the whole burst to the same machine, which is
// then the slowest by the time the next batch decides. That oscillation is a
// well-known failure of least-loaded routing. Two random choices removes almost
// all of the imbalance while making herding impossible, since no two concurrent
// decisions see the same pair.
func (lb *LoadBalancer) nextBackend() *Backend {
	if strategy == "round-robin" {
		return lb.roundRobin()
	}

	alive := lb.healthy()
	switch len(alive) {
	case 0:
		return nil
	case 1:
		return alive[0]
	}

	// Below-threshold backends only, while there are any.
	candidates := alive
	if loadThreshold > 0 {
		under := make([]*Backend, 0, len(alive))
		for _, b := range alive {
			if b.score() <= loadThreshold {
				under = append(under, b)
			}
		}
		if len(under) > 0 {
			candidates = under
		} else {
			lb.metrics.AllOverThreshold.Add(1)
		}
	}
	if len(candidates) == 1 {
		return candidates[0]
	}

	if strategy == "least-load" {
		best := candidates[0]
		bestScore := best.score()
		for _, b := range candidates[1:] {
			if sc := b.score(); sc < bestScore {
				best, bestScore = b, sc
			}
		}
		best.Chosen.Add(1)
		return best
	}

	// power-of-two-choices (default)
	i := int(lb.next.Add(1) % uint64(len(candidates)))
	j := int(rand.Int32N(int32(len(candidates) - 1)))
	if j >= i {
		j++ // a distinct second sample, without rejection-looping
	}
	a, b := candidates[i], candidates[j]
	if b.score() < a.score() {
		a = b
	}
	a.Chosen.Add(1)
	return a
}

func (lb *LoadBalancer) healthLoop(ctx context.Context, path string, interval, timeout time.Duration) {
	// Its own client, and deliberately not the proxy transport: probes must not
	// queue behind the request traffic they are trying to measure. Its TLS
	// settings still have to match the proxy's — see backendTLS.
	client := &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			TLSClientConfig:     backendTLS(),
			TLSHandshakeTimeout: 5 * time.Second,
			DisableKeepAlives:   false,
		},
	}

	// record applies hysteresis. A single missed probe does not evict, because
	// the backends here are single-threaded Node processes: at saturation the
	// probe queues behind the request backlog and times out while the server is
	// perfectly alive. Evicting on that one sample removes the last healthy
	// backend, every request is then refused instantly, the offered load
	// vanishes, the next probe succeeds, and the backend is restored — a
	// flap loop that reports the load balancer's own oscillation as backend
	// failure. Requiring -unhealthy-threshold consecutive failures distinguishes
	// "busy" from "gone"; restoration is faster than eviction on purpose, so
	// recovery is not delayed by the same margin that prevents flapping.
	record := func(b *Backend, ok bool, detail string) {
		if ok {
			b.failStreak.Store(0)
			if n := b.okStreak.Add(1); n >= int64(healthyThreshold) && !b.Alive.Load() {
				b.Alive.Store(true)
				log.Printf("health: %s UP after %d good probes (%s)", b.Name(), n, detail)
			}
			return
		}
		b.okStreak.Store(0)
		n := b.failStreak.Add(1)
		if n < int64(unhealthyThreshold) || !b.Alive.Load() {
			return
		}
		// Evidence beats inference. If this backend answered a real request
		// within servingGrace, the probe timing out says the backend is busy,
		// not gone — and taking a working backend out of rotation under load is
		// the worst possible moment to be wrong. Connection-level failures are
		// unaffected: a refused dial cannot coexist with recent successes.
		if last := b.lastGoodNanos.Load(); last > 0 &&
			time.Since(time.Unix(0, last)) < servingGrace {
			if n == int64(unhealthyThreshold) {
				log.Printf("health: %s probe failing (%s) but served a request %.1fs ago — kept in rotation",
					b.Name(), detail, time.Since(time.Unix(0, last)).Seconds())
			}
			return
		}
		b.Alive.Store(false)
		log.Printf("health: %s DOWN after %d failed probes (%s)", b.Name(), n, detail)
	}

	check := func(b *Backend) {
		target := strings.TrimRight(b.URL.String(), "/") + path
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			record(b, false, err.Error())
			return
		}
		resp, err := client.Do(req)
		if err != nil {
			record(b, false, err.Error())
			return
		}
		// Read rather than discarded: the backend publishes its own load in
		// this body, so the probe that establishes liveness also carries the
		// signal routing needs. One request per second per backend, total.
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
		resp.Body.Close()
		ok := resp.StatusCode >= 200 && resp.StatusCode < 400
		if ok {
			b.absorbLoad(body)
		}
		record(b, ok, fmt.Sprintf("status %d", resp.StatusCode))
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		var wg sync.WaitGroup
		for _, b := range lb.backends {
			wg.Add(1)
			// Probed in parallel: serial probing makes the effective interval
			// scale with the number of dead backends, so one hung machine
			// would delay the health news about all the others.
			go func(b *Backend) { defer wg.Done(); check(b) }(b)
		}
		wg.Wait()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// ServeHTTP is the data path: pick a backend, proxy, record.
func (lb *LoadBalancer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	lb.metrics.Total.Add(1)
	start := time.Now()

	b := lb.nextBackend()
	if b == nil {
		lb.metrics.Failed.Add(1)
		lb.metrics.NoBackend.Add(1)
		lb.metrics.observe(time.Since(start))
		http.Error(w, "no healthy backend", http.StatusServiceUnavailable)
		return
	}

	b.Requests.Add(1)
	b.InFlight.Add(1)
	defer b.InFlight.Add(-1)

	// The proxy's own ErrorHandler counts the failures, so anything that
	// reaches here without having been counted succeeded.
	rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	r.Header.Set("X-Forwarded-Host", r.Host)
	r.Header.Set("X-LB-Backend", b.Name())
	b.proxy.ServeHTTP(rec, r)

	d := time.Since(start)
	lb.metrics.observe(d)
	// Only successful requests train the latency estimate. A request that
	// failed says nothing useful about service time — a fast connection
	// refusal would otherwise look like a fast backend and attract traffic to
	// a machine that is refusing everything.
	if !rec.failed && rec.status < 500 {
		b.observeLatency(d)
	}
	if rec.failed {
		return // already charged to Failed by ErrorHandler
	}
	if rec.status >= 500 {
		lb.metrics.Failed.Add(1)
		return
	}
	lb.metrics.Success.Add(1)
	b.lastGoodNanos.Store(time.Now().UnixNano())
}

// statusRecorder remembers the status line so the LB can tell a 200 from a 502
// without buffering the body.
type statusRecorder struct {
	http.ResponseWriter
	status int
	wrote  bool
	failed bool
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.wrote {
		return
	}
	s.status = code
	s.wrote = true
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(p []byte) (int, error) {
	if !s.wrote {
		s.wrote = true
	}
	return s.ResponseWriter.Write(p)
}

// Hijack keeps WebSocket upgrades working through the recorder — without it
// the proxy cannot take over the connection and every /ws handshake fails.
func (s *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := s.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("lb: ResponseWriter is not a Hijacker")
	}
	return h.Hijack()
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (lb *LoadBalancer) handleStatus(w http.ResponseWriter, _ *http.Request) {
	type row struct {
		URL          string  `json:"url"`
		Alive        bool    `json:"alive"`
		InFlight     int64   `json:"in_flight"`
		Requests     uint64  `json:"requests"`
		Errors       uint64  `json:"errors"`
		FailedProbes int64   `json:"consecutive_failed_probes"`
		ScoreMs      float64 `json:"score_ms"`
		ServiceMs    float64 `json:"service_ms_ewma"`
		LagMs        float64 `json:"backend_lag_ms"`
		CPUPercent   float64 `json:"backend_cpu_percent"`
		Overloaded   bool    `json:"over_threshold"`
	}
	out := struct {
		Strategy      string  `json:"strategy"`
		LoadThreshold float64 `json:"load_threshold_ms"`
		Backends      []row   `json:"backends"`
		Healthy       int     `json:"healthy"`
		UptimeS       float64 `json:"uptime_s"`
	}{Strategy: strategy, LoadThreshold: loadThreshold, UptimeS: lb.uptime().Seconds()}
	for _, b := range lb.backends {
		alive := b.Alive.Load()
		if alive {
			out.Healthy++
		}
		sc := b.score()
		out.Backends = append(out.Backends, row{
			b.URL.String(), alive, b.InFlight.Load(), b.Requests.Load(), b.Errors.Load(),
			b.failStreak.Load(),
			round2(sc),
			round2(float64(b.latencyEWMAMicros.Load()) / 1000),
			round2(float64(b.reportedLagMicros.Load()) / 1000),
			round2(float64(b.reportedCPUMilli.Load()) / 1000),
			loadThreshold > 0 && sc > loadThreshold,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (lb *LoadBalancer) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	total := lb.metrics.Total.Load()
	failed := lb.metrics.Failed.Load()
	elapsed := lb.uptime().Seconds()

	dropout := 0.0
	if total > 0 {
		dropout = float64(failed) / float64(total) * 100
	}
	rps := 0.0
	if elapsed > 0 {
		rps = float64(lb.metrics.Success.Load()) / elapsed
	}

	per := map[string]uint64{}
	scores := map[string]float64{}
	for _, b := range lb.backends {
		per[b.Name()] = b.Requests.Load()
		scores[b.Name()] = round2(b.score())
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"total":                  total,
		"success":                lb.metrics.Success.Load(),
		"failed":                 failed,
		"backend_errors":         lb.metrics.BackendErrors.Load(),
		"no_backend":             lb.metrics.NoBackend.Load(),
		"client_canceled":        lb.metrics.ClientCanceled.Load(),
		"all_over_threshold":     lb.metrics.AllOverThreshold.Load(),
		"strategy":               strategy,
		"load_threshold_ms":      loadThreshold,
		"tls_handshake_failures": lb.metrics.TLSHandshakes.Load(),
		"dropout_percent":        round2(dropout),
		"uptime_s":               round2(elapsed),
		"throughput_rps":         round2(rps),
		"p50_ms":                 lb.metrics.percentileMs(50),
		"p95_ms":                 lb.metrics.percentileMs(95),
		"p99_ms":                 lb.metrics.percentileMs(99),
		"mean_ms":                lb.metrics.meanMs(),
		"samples":                lb.metrics.samples(),
		"per_backend_reqs":       per,
		"per_backend_scores":     scores,
		"self":                   selfStats(),
	})
}

// serverErrorLog filters net/http's connection-level error log.
//
// "TLS handshake error ... EOF" means a client opened a TCP connection and went
// away before completing the handshake. That is a client-side event, and under
// load it arrives once per abandoned connection — hundreds of lines that bury
// every message that matters, which is exactly when the operator most needs to
// read the log. Counted instead, and surfaced in /lb/metrics as
// tls_handshake_failures; everything else passes through unchanged.
type serverErrorLog struct {
	out   io.Writer
	count *atomic.Uint64
}

func (s serverErrorLog) Write(p []byte) (int, error) {
	if bytes.Contains(p, []byte("TLS handshake error")) {
		s.count.Add(1)
		return len(p), nil
	}
	return s.out.Write(p)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func round2(f float64) float64 { return float64(int64(f*100+0.5)) / 100 }

// proxyBuffers backs every reverse proxy's body copy. 32 KB matches the size
// ReverseProxy would otherwise allocate per request.
type bufferPool struct{ p sync.Pool }

func (b *bufferPool) Get() []byte  { return *b.p.Get().(*[]byte) }
func (b *bufferPool) Put(x []byte) { b.p.Put(&x) }

var proxyBuffers = &bufferPool{p: sync.Pool{New: func() any {
	b := make([]byte, 32*1024)
	return &b
}}}

// strategy selects how a backend is chosen: "p2c" (default),
// "least-load", or "round-robin". See nextBackend.
var strategy = "p2c"

// loadThreshold is the estimated-response-time ceiling, in milliseconds, above
// which a backend is considered overloaded and skipped while a better one
// exists. 0 disables the threshold and leaves plain load-based preference.
var loadThreshold float64

// insecureBackends turns off certificate verification for backend connections.
//
// It exists because the backends here present a self-signed certificate, which
// nothing trusts by default. Worth being clear about what this costs: skipping
// verification keeps the encryption and gives up the authentication, so the
// connection is protected against passive eavesdropping but not against a
// man-in-the-middle that can answer at the backend's address. On a lab bridge
// that is an acceptable trade; on a real network it is not, and the fix there
// is a certificate the load balancer actually trusts, not this flag.
var insecureBackends bool

// unhealthyThreshold / healthyThreshold are the health-check hysteresis; see
// the comment on record() in healthLoop.
var (
	unhealthyThreshold = 3
	healthyThreshold   = 1
)

// scoreHalfLife is how quickly an unrefreshed load estimate loses authority.
// See Backend.score: it is what stops threshold exclusion from being permanent.
var scoreHalfLife = time.Second

// servingGrace is how recently a backend must have completed a real request for
// a failing health probe to be treated as advisory rather than fatal.
var servingGrace = 10 * time.Second

// strictEviction reproduces the literal evict-on-any-proxy-error rule from the
// assignment slides. Off by default — see the ErrorHandler comment.
var strictEviction bool

// isTimeout reports whether err is a deadline/timeout rather than a refused or
// broken connection. net.Error.Timeout covers the transport's own
// ResponseHeaderTimeout and dial deadlines; context.DeadlineExceeded covers a
// cancelled request context.
func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) {
		return true
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return ne.Timeout()
	}
	return false
}

func parseBackends(raw string, timeout time.Duration, lb *LoadBalancer) ([]*Backend, error) {
	var out []*Backend
	// Split on commas AND whitespace, so a -backends value pasted across
	// several shell lines (as the slides show it) still parses.
	for _, part := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n'
	}) {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.Contains(part, "://") {
			part = "http://" + part
		}
		u, err := url.Parse(part)
		if err != nil {
			return nil, fmt.Errorf("bad backend %q: %w", part, err)
		}
		if u.Host == "" {
			return nil, fmt.Errorf("bad backend %q: no host", part)
		}
		b := &Backend{URL: u}
		// Optimistic start: the first health tick corrects it within a second,
		// and starting pessimistic means the very first requests 503 even
		// when every backend is fine.
		b.Alive.Store(true)

		p := httputil.NewSingleHostReverseProxy(u)
		// Keep content negotiation the client's. Go's transport adds
		// "Accept-Encoding: gzip" to any request that does not already carry
		// one and then transparently decompresses the reply. Through a proxy
		// that is pure waste in both directions: the backend spends CPU
		// compressing a feed nobody asked to have compressed, and this process
		// spends more CPU throwing that work away. Asking for identity when the
		// client stayed silent leaves a client that did ask for gzip to be
		// answered with gzip, end to end.
		director := p.Director
		p.Director = func(r *http.Request) {
			director(r)
			if r.Header.Get("Accept-Encoding") == "" {
				r.Header.Set("Accept-Encoding", "identity")
			}
		}
		// Without a BufferPool, ReverseProxy allocates a fresh 32 KB buffer for
		// every response body it copies. At a few hundred requests a second
		// that is megabytes per second of garbage, and the collector's share of
		// a single CPU is CPU the proxy is not using to proxy. Sys1 has exactly
		// one core and shares it with nothing else now, so this is the cheapest
		// throughput available.
		p.BufferPool = proxyBuffers
		p.Transport = &http.Transport{
			DialContext:           (&net.Dialer{Timeout: 2 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			ResponseHeaderTimeout: timeout,
			// Generous, and per-host: the default of 2 idle connections per
			// host turns a 40-way concurrent test into connection churn and
			// measures the TCP handshake instead of the backend.
			// Sized for the graded ladder: 1000 concurrent clients over three
			// backends is ~333 per backend, and an idle cap below that turns
			// every burst into connection churn — the balancer would spend its
			// CPU on TCP handshakes instead of proxying.
			MaxIdleConns:        4096,
			MaxIdleConnsPerHost: 2048,
			// Deliberately shorter than the backend's keepAliveTimeout (65 s).
			// The two must not be inverted: Node's default is 5 s, so with the
			// old 90 s here the backend closed idle sockets the balancer still
			// believed were usable, and the next request onto one produced
			// "http: server closed idle connection" — the most common error in
			// the first load runs. Whoever closes first must be the side that
			// is not about to send.
			IdleConnTimeout:     30 * time.Second,
			ForceAttemptHTTP2:   false,
			TLSClientConfig:     backendTLS(),
			TLSHandshakeTimeout: 5 * time.Second,
		}
		p.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, err error) {
			// The client hung up: its deadline expired, it was interrupted, or
			// the connection dropped. The backend is not at fault and must not
			// be evicted for it. Getting this wrong is self-reinforcing under
			// load — a client-side deadline abandons requests exactly when the
			// backend is slowest, so every abandoned request would evict the
			// one backend still doing the work, and the load balancer would
			// refuse traffic it could have served.
			//
			// Counted as failed, because the request was not served, but kept
			// separate from BackendErrors so the report can tell "the client
			// gave up" apart from "the backend broke". Not logged either: under
			// a short client deadline these arrive in the thousands, and a log
			// that scrolls is a log nobody reads.
			if req.Context().Err() != nil || errors.Is(err, context.Canceled) {
				lb.metrics.ClientCanceled.Add(1)
				lb.metrics.Failed.Add(1)
				if rec, ok := rw.(*statusRecorder); ok {
					rec.failed = true
				}
				return // the connection is gone; there is nobody to write to
			}

			b.Errors.Add(1)
			lb.metrics.BackendErrors.Add(1)
			lb.metrics.Failed.Add(1)
			if rec, ok := rw.(*statusRecorder); ok {
				rec.failed = true
			}

			// A slow backend and a dead backend are different faults, and
			// treating them alike is a self-inflicted outage: the moment an
			// overloaded backend misses the response-header deadline, evicting
			// it leaves nothing in rotation, so every subsequent request is
			// refused instantly. With one backend configured that turns a
			// throughput measurement into a 100%-dropout cliff — the load
			// balancer, not the backend, becomes the thing that failed.
			//
			// So only connection-level faults evict. A timeout is reported as
			// 504 and the backend stays in rotation; if it is genuinely gone,
			// the health loop notices within one interval and evicts it there.
			// -strict-eviction restores the evict-on-any-error behaviour.
			timeout := isTimeout(err)
			if strictEviction || !timeout {
				// okStreak too: it is the "consecutive good probes" counter the
				// health loop restores on, and leaving it running across an
				// eviction produced the nonsensical "UP after 32 good probes"
				// immediately after a backend was marked down.
				b.okStreak.Store(0)
				b.Alive.Store(false)
			}
			status := http.StatusBadGateway
			if timeout {
				status = http.StatusGatewayTimeout
			}
			log.Printf("proxy error via %s (%s): %v", b.Name(), http.StatusText(status), err)
			http.Error(rw, http.StatusText(status), status)
		}
		b.proxy = p
		out = append(out, b)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no backends given")
	}
	return out, nil
}

func main() {
	// Required, with no default. The assigned port differs per student and per
	// system, and a default that silently binds the wrong one produces a load
	// balancer that is running and unreachable — the most expensive kind of
	// wrong. Stating it is cheaper than diagnosing it.
	listen := flag.String("listen", "", "address to listen on, e.g. 0.0.0.0:3273 (required)")
	backends := flag.String("backends", "", "comma-separated backend URLs, e.g. http://10.1.75.53:3274,http://10.1.75.53:3275")
	healthPath := flag.String("health-path", "/healthz", "path probed on each backend (ChatFat exposes /healthz)")
	healthInterval := flag.Duration("health-interval", 250*time.Millisecond, "how often to probe backends")
	healthTimeout := flag.Duration("health-timeout", 600*time.Millisecond, "per-probe timeout")
	// Generous, because GET /feed returns every stored message and the backend
	// writes no headers until it has built the whole response. A tight value
	// here turns a slow-but-working feed into a 504, which is what the grading
	// run reported. Writes are unaffected: they answer in milliseconds, so this
	// only ever applies to a request that genuinely needs the time.
	backendTimeout := flag.Duration("backend-timeout", 45*time.Second, "backend response-header timeout")
	tlsCert := flag.String("tls-cert", "", "PEM certificate; with -tls-key, the load balancer itself serves HTTPS")
	tlsKey := flag.String("tls-key", "", "PEM private key for -tls-cert")
	flag.BoolVar(&insecureBackends, "insecure-backends", false,
		"skip certificate verification when connecting to https:// backends (needed for self-signed certs)")
	flag.StringVar(&strategy, "strategy", "p2c",
		"backend selection: p2c (power-of-two-choices, default), least-load, or round-robin")
	flag.Float64Var(&loadThreshold, "load-threshold", 150,
		"estimated response time in ms above which a backend is skipped while a better one exists (0 disables)")
	flag.IntVar(&unhealthyThreshold, "unhealthy-threshold", 3, "consecutive failed probes before a backend is evicted")
	flag.IntVar(&healthyThreshold, "healthy-threshold", 1, "consecutive good probes before an evicted backend returns")
	flag.DurationVar(&scoreHalfLife, "score-half-life", time.Second,
		"how fast a backend's load estimate decays while it serves nothing, so that "+
			"exceeding the threshold cannot exclude it permanently (0 disables)")
	flag.DurationVar(&servingGrace, "serving-grace", 10*time.Second,
		"a failing health probe does not evict a backend that completed a request within this window")
	flag.BoolVar(&strictEviction, "strict-eviction", false,
		"evict a backend on ANY proxy error, timeouts included (the slides' literal rule; collapses under overload)")
	flag.Parse()

	switch strategy {
	case "p2c", "least-load", "round-robin":
	default:
		fmt.Fprintf(os.Stderr, "lb: unknown -strategy %q (want p2c, least-load or round-robin)\n", strategy)
		os.Exit(2)
	}

	if *listen == "" || *backends == "" {
		if *listen == "" {
			fmt.Fprintln(os.Stderr, "lb: -listen is required, e.g. -listen 0.0.0.0:3273")
		}
		if *backends == "" {
			fmt.Fprintln(os.Stderr, "lb: -backends is required, e.g. -backends http://10.1.75.53:3274")
		}
		flag.Usage()
		os.Exit(2)
	}

	if (*tlsCert == "") != (*tlsKey == "") {
		fmt.Fprintln(os.Stderr, "lb: -tls-cert and -tls-key must be given together")
		os.Exit(2)
	}
	// The single most likely way to get this wrong is to point https:// backends
	// at a self-signed certificate and leave verification on, which fails every
	// probe with an unhelpful x509 error. Say so up front rather than let it
	// look like the backends are down.
	if strings.Contains(*backends, "https://") && !insecureBackends {
		log.Printf("lb: note — https:// backends with certificate verification ON; " +
			"add -insecure-backends if they use a self-signed certificate")
	}

	lb := &LoadBalancer{}
	lb.markStart()
	bs, err := parseBackends(*backends, *backendTimeout, lb)
	if err != nil {
		log.Fatalf("lb: %v", err)
	}
	lb.backends = bs

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go lb.healthLoop(ctx, *healthPath, *healthInterval, *healthTimeout)

	mux := http.NewServeMux()
	mux.HandleFunc("/lb/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "uptime_s": round2(lb.uptime().Seconds())})
	})
	mux.HandleFunc("/lb/status", lb.handleStatus)
	mux.HandleFunc("/lb/metrics", lb.handleMetrics)
	// Zeroing between experiments is what makes the LB-side numbers in the
	// report per-experiment rather than cumulative.
	mux.HandleFunc("/lb/reset", func(w http.ResponseWriter, r *http.Request) {
		lb.metrics.reset()
		for _, b := range lb.backends {
			b.Requests.Store(0)
			b.Errors.Store(0)
		}
		lb.markStart()
		writeJSON(w, http.StatusOK, map[string]any{"reset": true})
	})
	mux.Handle("/", lb)

	srv := &http.Server{
		Addr:    *listen,
		Handler: mux,
		// No WriteTimeout and no ReadTimeout: a WebSocket connection is a
		// long-lived read and a long-lived write, and either timeout would
		// sever every chat session on a fixed schedule.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          log.New(serverErrorLog{out: os.Stderr, count: &lb.metrics.TLSHandshakes}, "", log.LstdFlags),
	}

	scheme := "http"
	if *tlsCert != "" {
		scheme = "https"
	}
	log.Printf("lb: listening on %s (%s)", *listen, scheme)
	log.Printf("lb: selection=%s load-threshold=%.0fms", strategy, loadThreshold)
	for _, b := range lb.backends {
		log.Printf("lb: backend %s (health %s%s)", b.URL, strings.TrimRight(b.URL.String(), "/"), *healthPath)
	}

	go func() {
		<-ctx.Done()
		log.Printf("lb: shutting down")
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()

	var serveErr error
	if *tlsCert != "" {
		// Go negotiates HTTP/2 over TLS by default. Left on, the load balancer
		// would speak h2 to the load generator and HTTP/1.1 to the backends,
		// so the two experiments would not be comparable with the plain-HTTP
		// runs. Pinning h1 keeps every configuration measuring the same thing.
		srv.TLSNextProto = map[string]func(*http.Server, *tls.Conn, http.Handler){}
		serveErr = srv.ListenAndServeTLS(*tlsCert, *tlsKey)
	} else {
		serveErr = srv.ListenAndServe()
	}
	if serveErr != nil && serveErr != http.ErrServerClosed {
		log.Fatalf("lb: %v", serveErr)
	}
}
