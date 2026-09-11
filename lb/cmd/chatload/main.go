// Command chatload is the load generator for the dynamic load-balancing lab.
//
// It models chat clients rather than a benchmark loop: a configurable number of
// users, each posting messages of random length at random intervals, with a
// share of reads mixed in. That shape matters, because a fixed-rate flood of
// identical requests exercises none of the behaviour the load balancer exists
// for — real load arrives unevenly, and it is the unevenness that makes
// performance-based routing worth more than taking turns.
//
//	chatload -url https://10.1.75.53:3273 -insecure -users 50 -duration 60s
//
// Two outputs, both for the report:
//
//	<experiment>.samples.csv      one row per request: when, which route, how long
//	<experiment>.utilization.csv  periodic scrape of all four systems
//
// Utilisation is sampled from the services themselves — each backend's /statz
// and the balancer's /lb/metrics — so no agent or SSH access is needed on the
// machines while the run is in progress.
package main

import (
	"crypto/tls"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Words for message bodies. Real chat text compresses and tokenises unlike
// random bytes, and message length is one of the variables the assignment asks
// to be varied, so bodies are assembled from words to a target length rather
// than filled with a repeated character.
var words = strings.Fields(`the quick brown fox jumps over a lazy dog while
	everyone waits patiently for the load balancer to decide which backend
	should answer this particular message today tomorrow later soon never
	always maybe perhaps certainly probably possibly hopefully finally`)

type sample struct {
	atMs    int64
	route   string
	status  int
	latency time.Duration
	backend string
	errKind string
	ok      bool
}

type utilRow struct {
	atMs    int64
	system  string
	role    string
	cpu     float64
	cpuCore float64
	lag     float64
	inFl    int64
	rss     int64
	extra   string
}

func main() {
	target := flag.String("url", "", "load balancer base URL, e.g. https://10.1.75.53:3273 (required)")
	users := flag.Int("users", 40, "number of concurrent simulated chat clients")
	duration := flag.Duration("duration", 60*time.Second, "how long to generate load (0 = use -messages)")
	messages := flag.Int("messages", 0, "total messages to send instead of running for -duration")
	minLen := flag.Int("min-len", 8, "minimum message length in characters")
	maxLen := flag.Int("max-len", 280, "maximum message length in characters")
	minGap := flag.Duration("min-gap", 20*time.Millisecond, "minimum think time between a client's messages")
	maxGap := flag.Duration("max-gap", 400*time.Millisecond, "maximum think time between a client's messages")
	feedEvery := flag.Int("feed-every", 25, "one GET /feed per this many posts (0 disables reads)")
	feedLimit := flag.Int("feed-limit", 200, "?limit= sent with GET /feed, so a growing table does not dominate the run")
	timeout := flag.Duration("timeout", 10*time.Second, "per-request timeout")
	insecure := flag.Bool("insecure", false, "skip TLS verification (self-signed lab certificate)")
	experiment := flag.String("experiment", "run", "label for the output files")
	out := flag.String("out", "results/lab6", "output directory")
	backends := flag.String("backends", "", "comma-separated backend base URLs to scrape for utilisation")
	sampleEvery := flag.Duration("sample-every", time.Second, "utilisation sampling interval")
	idempotentPct := flag.Int("retry-percent", 5, "percentage of messages deliberately sent twice with the same id, to exercise deduplication")
	seed := flag.Uint64("seed", 0, "PRNG seed; 0 picks one and prints it, so a run can be repeated")
	flag.Parse()

	if *target == "" {
		fmt.Fprintln(os.Stderr, "chatload: -url is required")
		flag.Usage()
		os.Exit(2)
	}
	if *users <= 0 || *minLen <= 0 || *maxLen < *minLen || *maxGap < *minGap {
		fmt.Fprintln(os.Stderr, "chatload: check -users, -min-len/-max-len and -min-gap/-max-gap")
		os.Exit(2)
	}
	base := strings.TrimRight(*target, "/")

	if *seed == 0 {
		*seed = rand.Uint64()
	}
	fmt.Printf("seed %d (pass -seed %d to repeat this run)\n", *seed, *seed)

	var tlsConf *tls.Config
	if *insecure {
		tlsConf = &tls.Config{InsecureSkipVerify: true} // #nosec G402 — self-signed lab certificate
	}
	// One transport, sized for the client count. A per-user client would open a
	// fresh connection per message and the run would measure TCP and TLS
	// setup rather than the application.
	tr := &http.Transport{
		DialContext:         (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:        *users * 2,
		MaxIdleConnsPerHost: *users * 2,
		IdleConnTimeout:     60 * time.Second,
		DisableCompression:  true,
		// HTTP/1.1: h2 would multiplex every user onto one connection, so
		// "users" would stop corresponding to concurrent connections.
		ForceAttemptHTTP2:   false,
		TLSClientConfig:     tlsConf,
		TLSHandshakeTimeout: 10 * time.Second,
	}
	client := &http.Client{Timeout: *timeout, Transport: tr}

	var (
		mu       sync.Mutex
		samples  []sample
		utilRows []utilRow
	)
	record := func(s sample) {
		mu.Lock()
		samples = append(samples, s)
		mu.Unlock()
	}

	started := time.Now()
	stop := make(chan struct{})
	var remaining atomic.Int64
	byMessages := *messages > 0
	if byMessages {
		remaining.Store(int64(*messages))
	}

	// ---- utilisation sampler ----
	var utilWG sync.WaitGroup
	scrapes := buildScrapeTargets(base, *backends)
	if len(scrapes) > 0 {
		utilWG.Add(1)
		go func() {
			defer utilWG.Done()
			t := time.NewTicker(*sampleEvery)
			defer t.Stop()
			for {
				select {
				case <-stop:
					return
				case <-t.C:
					now := time.Now().UnixMilli()
					for _, sc := range scrapes {
						if row, ok := scrape(client, sc, now); ok {
							mu.Lock()
							utilRows = append(utilRows, row...)
							mu.Unlock()
						}
					}
				}
			}
		}()
	}

	// ---- simulated clients ----
	fmt.Printf("generating load: %d users -> %s\n", *users, base)
	if byMessages {
		fmt.Printf("  %d messages, lengths %d-%d chars, think time %v-%v\n", *messages, *minLen, *maxLen, *minGap, *maxGap)
	} else {
		fmt.Printf("  for %v, lengths %d-%d chars, think time %v-%v\n", *duration, *minLen, *maxLen, *minGap, *maxGap)
	}

	var wg sync.WaitGroup
	for u := 0; u < *users; u++ {
		wg.Add(1)
		go func(uid int) {
			defer wg.Done()
			// Per-user PRNG derived from the run seed: no shared mutable state
			// between goroutines, and the whole run is reproducible.
			rng := rand.New(rand.NewPCG(*seed, uint64(uid)))
			name := fmt.Sprintf("user-%03d", uid)
			posts := 0

			for {
				if byMessages && remaining.Add(-1) < 0 {
					return
				}
				select {
				case <-stop:
					return
				default:
				}

				body, id := makeMessage(rng, name, *minLen, *maxLen)
				record(post(client, base, body, *timeout))
				posts++

				// A deliberate duplicate now and then: the assignment requires
				// that a retried message not be inserted twice, and a test
				// that never retries never checks it.
				if *idempotentPct > 0 && rng.IntN(100) < *idempotentPct {
					record(post(client, base, body, *timeout))
					_ = id
				}

				if *feedEvery > 0 && posts%*feedEvery == 0 {
					record(feed(client, base, *feedLimit))
				}

				gap := *minGap
				if d := *maxGap - *minGap; d > 0 {
					gap += time.Duration(rng.Int64N(int64(d)))
				}
				select {
				case <-stop:
					return
				case <-time.After(gap):
				}
			}
		}(u)
	}

	if !byMessages {
		time.AfterFunc(*duration, func() { close(stop) })
	}
	wg.Wait()
	// Only close once: with -messages the timer above never ran.
	select {
	case <-stop:
	default:
		close(stop)
	}
	utilWG.Wait()
	elapsed := time.Since(started)

	res := summarise(*experiment, base, *users, elapsed, samples, *seed)
	printSummary(res)
	if err := writeAll(*out, *experiment, res, samples, utilRows); err != nil {
		fmt.Fprintf(os.Stderr, "chatload: writing output: %v\n", err)
		os.Exit(1)
	}
}

func makeMessage(rng *rand.Rand, name string, minLen, maxLen int) (url.Values, string) {
	target := minLen
	if d := maxLen - minLen; d > 0 {
		target += rng.IntN(d + 1)
	}
	var sb strings.Builder
	for sb.Len() < target {
		if sb.Len() > 0 {
			sb.WriteByte(' ')
		}
		sb.WriteString(words[rng.IntN(len(words))])
	}
	text := sb.String()
	if len(text) > maxLen {
		text = text[:maxLen]
	}
	// Client-supplied id, which is what makes a retry idempotent rather than
	// duplicative.
	id := fmt.Sprintf("cl_%s_%d_%d", name, time.Now().UnixNano(), rng.Uint32())
	return url.Values{"client-name": {name}, "msg": {text}, "id": {id}}, id
}

func post(c *http.Client, base string, form url.Values, _ time.Duration) sample {
	start := time.Now()
	req, err := http.NewRequest(http.MethodPost, base+"/message", strings.NewReader(form.Encode()))
	if err != nil {
		return sample{atMs: start.UnixMilli(), route: "message", latency: time.Since(start), errKind: "build"}
	}
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	return finish(c, req, start, "message")
}

func feed(c *http.Client, base string, limit int) sample {
	start := time.Now()
	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/feed?limit=%d", base, limit), nil)
	if err != nil {
		return sample{atMs: start.UnixMilli(), route: "feed", latency: time.Since(start), errKind: "build"}
	}
	return finish(c, req, start, "feed")
}

func finish(c *http.Client, req *http.Request, start time.Time, route string) sample {
	resp, err := c.Do(req)
	if err != nil {
		return sample{atMs: start.UnixMilli(), route: route, latency: time.Since(start), errKind: "transport"}
	}
	// Drained fully: an undrained body cannot return to the idle pool, which
	// silently turns keep-alive off partway through a run.
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return sample{
		atMs:    start.UnixMilli(),
		route:   route,
		status:  resp.StatusCode,
		latency: time.Since(start),
		ok:      resp.StatusCode >= 200 && resp.StatusCode < 400,
		backend: resp.Header.Get("X-Backend"),
	}
}

type scrapeTarget struct {
	name string
	role string
	url  string
}

func buildScrapeTargets(base, backends string) []scrapeTarget {
	out := []scrapeTarget{{name: "sys1", role: "load-balancer", url: base + "/lb/metrics"}}
	i := 2
	for _, b := range strings.FieldsFunc(backends, func(r rune) bool { return r == ',' || r == ' ' }) {
		b = strings.TrimRight(strings.TrimSpace(b), "/")
		if b == "" {
			continue
		}
		out = append(out, scrapeTarget{name: fmt.Sprintf("sys%d", i), role: "backend", url: b + "/statz"})
		i++
	}
	return out
}

// scrape reads one endpoint. The balancer's /lb/metrics yields a row for Sys1
// and, from its per-backend view, the scores it is routing on; each backend's
// /statz yields that machine's own CPU and event-loop delay.
func scrape(c *http.Client, t scrapeTarget, atMs int64) ([]utilRow, bool) {
	resp, err := c.Get(t.url)
	if err != nil {
		return nil, false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	if err != nil || resp.StatusCode >= 300 {
		return nil, false
	}

	if t.role == "load-balancer" {
		var m struct {
			Self struct {
				CPUPercent float64 `json:"cpu_percent"`
				CPUCore    float64 `json:"cpu_core_percent"`
				RSSMB      int64   `json:"rss_mb"`
				Goroutines int64   `json:"goroutines"`
			} `json:"self"`
			Scores   map[string]float64 `json:"per_backend_scores"`
			Strategy string             `json:"strategy"`
		}
		if json.Unmarshal(body, &m) != nil {
			return nil, false
		}
		extra := make([]string, 0, len(m.Scores))
		for k, v := range m.Scores {
			extra = append(extra, fmt.Sprintf("%s=%.2f", k, v))
		}
		sort.Strings(extra)
		return []utilRow{{
			atMs: atMs, system: t.name, role: t.role,
			cpu: m.Self.CPUPercent, cpuCore: m.Self.CPUCore, rss: m.Self.RSSMB, inFl: m.Self.Goroutines,
			extra: strings.Join(extra, " "),
		}}, true
	}

	var s struct {
		Backend    string  `json:"backend"`
		LagMs      float64 `json:"lag_ms"`
		CPUPercent float64 `json:"cpu_percent"`
		CPUCore    float64 `json:"cpu_core_percent"`
		InFlight   int64   `json:"in_flight"`
		RSSMB      int64   `json:"rss_mb"`
	}
	if json.Unmarshal(body, &s) != nil {
		return nil, false
	}
	return []utilRow{{
		atMs: atMs, system: t.name, role: t.role,
		cpu: s.CPUPercent, cpuCore: s.CPUCore, lag: s.LagMs, inFl: s.InFlight, rss: s.RSSMB,
		extra: s.Backend,
	}}, true
}

type Result struct {
	Experiment string         `json:"experiment"`
	Target     string         `json:"target"`
	Users      int            `json:"users"`
	Seed       uint64         `json:"seed"`
	ElapsedS   float64        `json:"elapsed_s"`
	Total      int            `json:"total_requests"`
	Posts      int            `json:"posts"`
	Feeds      int            `json:"feeds"`
	Successful int            `json:"successful"`
	Failed     int            `json:"failed"`
	Throughput float64        `json:"throughput_rps"`
	PostRPS    float64        `json:"messages_per_s"`
	DropoutPct float64        `json:"dropout_percent"`
	P50Ms      float64        `json:"p50_ms"`
	P95Ms      float64        `json:"p95_ms"`
	P99Ms      float64        `json:"p99_ms"`
	MeanMs     float64        `json:"mean_ms"`
	MaxMs      float64        `json:"max_ms"`
	PostP50Ms  float64        `json:"post_p50_ms"`
	PostP95Ms  float64        `json:"post_p95_ms"`
	FeedP50Ms  float64        `json:"feed_p50_ms"`
	FeedP95Ms  float64        `json:"feed_p95_ms"`
	PerBackend map[string]int `json:"per_backend"`
	StatusMix  map[string]int `json:"status_mix"`
	StartedAt  string         `json:"started_at"`
}

func summarise(name, target string, users int, elapsed time.Duration, ss []sample, seed uint64) Result {
	r := Result{
		Experiment: name, Target: target, Users: users, Seed: seed,
		ElapsedS: round2(elapsed.Seconds()), Total: len(ss),
		PerBackend: map[string]int{}, StatusMix: map[string]int{},
		StartedAt: time.Now().Add(-elapsed).Format(time.RFC3339),
	}
	var all, posts, feeds []time.Duration
	var sum time.Duration
	for _, s := range ss {
		all = append(all, s.latency)
		sum += s.latency
		if s.ok {
			r.Successful++
		} else {
			r.Failed++
		}
		switch s.route {
		case "message":
			r.Posts++
			posts = append(posts, s.latency)
		case "feed":
			r.Feeds++
			feeds = append(feeds, s.latency)
		}
		key := s.backend
		if key == "" {
			key = "unknown"
		}
		r.PerBackend[key]++
		if s.status == 0 {
			r.StatusMix["err:"+s.errKind]++
		} else {
			r.StatusMix[strconv.Itoa(s.status)]++
		}
	}
	if len(all) == 0 {
		return r
	}
	sortDur(all)
	sortDur(posts)
	sortDur(feeds)
	secs := elapsed.Seconds()
	r.Throughput = round2(float64(r.Successful) / secs)
	r.PostRPS = round2(float64(r.Posts) / secs)
	r.DropoutPct = round2(float64(r.Failed) / float64(len(ss)) * 100)
	r.P50Ms, r.P95Ms, r.P99Ms = pct(all, 50), pct(all, 95), pct(all, 99)
	r.MeanMs = ms(sum / time.Duration(len(all)))
	r.MaxMs = ms(all[len(all)-1])
	r.PostP50Ms, r.PostP95Ms = pct(posts, 50), pct(posts, 95)
	r.FeedP50Ms, r.FeedP95Ms = pct(feeds, 50), pct(feeds, 95)
	return r
}

func sortDur(d []time.Duration) { sort.Slice(d, func(i, j int) bool { return d[i] < d[j] }) }

func pct(sorted []time.Duration, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	i := int(p / 100 * float64(len(sorted)))
	if i >= len(sorted) {
		i = len(sorted) - 1
	}
	if i < 0 {
		i = 0
	}
	return ms(sorted[i])
}

func ms(d time.Duration) float64 { return round2(float64(d.Microseconds()) / 1000) }
func round2(f float64) float64   { return float64(int64(f*100+0.5)) / 100 }

func printSummary(r Result) {
	fmt.Printf("\n  experiment      %s\n", r.Experiment)
	fmt.Printf("  users           %d over %.2fs (seed %d)\n", r.Users, r.ElapsedS, r.Seed)
	fmt.Printf("  requests        %d  (%d posts, %d feeds)\n", r.Total, r.Posts, r.Feeds)
	fmt.Printf("  successful      %d\n  failed          %d\n", r.Successful, r.Failed)
	fmt.Printf("  throughput      %.2f req/s  (%.2f messages/s)\n", r.Throughput, r.PostRPS)
	fmt.Printf("  dropout         %.2f%%\n", r.DropoutPct)
	fmt.Printf("  latency all     p50 %.2fms  p95 %.2fms  p99 %.2fms  (mean %.2f max %.2f)\n",
		r.P50Ms, r.P95Ms, r.P99Ms, r.MeanMs, r.MaxMs)
	fmt.Printf("  POST /message   p50 %.2fms  p95 %.2fms\n", r.PostP50Ms, r.PostP95Ms)
	fmt.Printf("  GET  /feed      p50 %.2fms  p95 %.2fms\n", r.FeedP50Ms, r.FeedP95Ms)
	fmt.Printf("  per backend     %v\n", r.PerBackend)
	fmt.Printf("  status mix      %v\n\n", r.StatusMix)
}

func writeAll(dir, name string, r Result, ss []sample, us []utilRow) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	blob, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	sumPath := filepath.Join(dir, name+".summary.json")
	if err := os.WriteFile(sumPath, append(blob, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Printf("wrote %s\n", sumPath)

	// Per-request rows, for the response-time plots. `t_s` is seconds since the
	// run began rather than an absolute clock, so a plot's x-axis needs no
	// conversion and two runs can be overlaid.
	sPath := filepath.Join(dir, name+".samples.csv")
	f, err := os.Create(sPath)
	if err != nil {
		return err
	}
	w := csv.NewWriter(f)
	_ = w.Write([]string{"t_s", "route", "status", "latency_ms", "backend", "ok"})
	var t0 int64 = 1 << 62
	for _, s := range ss {
		if s.atMs < t0 {
			t0 = s.atMs
		}
	}
	for _, s := range ss {
		_ = w.Write([]string{
			fmt.Sprintf("%.3f", float64(s.atMs-t0)/1000),
			s.route, strconv.Itoa(s.status), fmt.Sprintf("%.3f", ms(s.latency)),
			s.backend, strconv.FormatBool(s.ok),
		})
	}
	w.Flush()
	f.Close()
	if err := w.Error(); err != nil {
		return err
	}
	fmt.Printf("wrote %s (%d rows)\n", sPath, len(ss))

	uPath := filepath.Join(dir, name+".utilization.csv")
	f2, err := os.Create(uPath)
	if err != nil {
		return err
	}
	w2 := csv.NewWriter(f2)
	_ = w2.Write([]string{"t_s", "system", "role", "cpu_percent", "cpu_core_percent", "lag_ms", "in_flight_or_goroutines", "rss_mb", "note"})
	for _, u := range us {
		_ = w2.Write([]string{
			fmt.Sprintf("%.3f", float64(u.atMs-t0)/1000),
			u.system, u.role, fmt.Sprintf("%.2f", u.cpu), fmt.Sprintf("%.2f", u.cpuCore), fmt.Sprintf("%.2f", u.lag),
			strconv.FormatInt(u.inFl, 10), strconv.FormatInt(u.rss, 10), u.extra,
		})
	}
	w2.Flush()
	f2.Close()
	if err := w2.Error(); err != nil {
		return err
	}
	fmt.Printf("wrote %s (%d rows)\n", uPath, len(us))
	return nil
}
