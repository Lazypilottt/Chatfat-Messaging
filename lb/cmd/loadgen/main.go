// Command loadgen is the load generator that runs on the local machine.
//
// It drives a fixed number of requests through a fixed-size worker pool at the
// load balancer, then reports the four metric families the slides ask for:
// throughput, dropout, latency percentiles, and the raw success/fail counts.
// One JSON file per experiment, plus one cumulative CSV so the comparison table
// in the report is a file rather than a transcription.
package main

import (
	"context"
	"crypto/tls"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Result struct {
	Experiment     string  `json:"experiment"`
	Target         string  `json:"target"`
	Requests       int     `json:"requests"`
	Concurrency    int     `json:"concurrency"`
	Successful     int     `json:"successful"`
	Failed         int     `json:"failed"`
	ElapsedS       float64 `json:"elapsed_s"`
	ThroughputRPS  float64 `json:"throughput_rps"`
	DropoutPercent float64 `json:"dropout_percent"`
	P50Ms          float64 `json:"p50_ms"`
	P95Ms          float64 `json:"p95_ms"`
	P99Ms          float64 `json:"p99_ms"`
	MinMs          float64 `json:"min_ms"`
	MaxMs          float64 `json:"max_ms"`
	MeanMs         float64 `json:"mean_ms"`
	// Which backend answered, counted from the X-Backend header the ChatFat
	// bench endpoint sets. This is the evidence that round-robin actually
	// spread the load, as opposed to the LB merely being up.
	PerBackend map[string]int `json:"per_backend"`
	StatusMix  map[string]int `json:"status_mix"`
	StartedAt  string         `json:"started_at"`
}

type sample struct {
	d       time.Duration
	ok      bool
	status  int
	backend string
	errKind string
}

func percentile(sorted []time.Duration, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(p / 100 * float64(len(sorted)))
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	if idx < 0 {
		idx = 0
	}
	return ms(sorted[idx])
}

func ms(d time.Duration) float64 { return round2(float64(d.Microseconds()) / 1000) }

func round2(f float64) float64 { return float64(int64(f*100+0.5)) / 100 }

func main() {
	target := flag.String("url", "", "URL to hammer, e.g. http://10.1.75.53:3273/bench?work=1200")
	requests := flag.Int("requests", 5000, "total requests to send")
	concurrency := flag.Int("concurrency", 40, "number of concurrent workers")
	timeout := flag.Duration("timeout", 5*time.Second, "per-request timeout")
	experiment := flag.String("experiment", "baseline", "experiment label, used in the JSON/CSV rows")
	out := flag.String("out", "results", "directory for the per-experiment JSON file")
	csvPath := flag.String("csv", "results/comparison.csv", "cumulative CSV appended to after each run")
	warmup := flag.Int("warmup", 200, "unmeasured requests sent first, to fill connection pools and JIT")
	insecure := flag.Bool("insecure", false, "skip TLS certificate verification (needed for a self-signed https:// target)")
	lbBase := flag.String("lb", "", "load balancer base URL, e.g. http://10.1.75.53:3273. When given, its\n\tcounters are reset after the warmup and its /lb/metrics and /lb/status are\n\tsaved alongside this run's result.")
	flag.Parse()

	if *target == "" {
		fmt.Fprintln(os.Stderr, "loadgen: -url is required")
		flag.Usage()
		os.Exit(2)
	}
	if *requests <= 0 || *concurrency <= 0 {
		fmt.Fprintln(os.Stderr, "loadgen: -requests and -concurrency must be positive")
		os.Exit(2)
	}

	// One shared client, so the pool is reused across all workers. A per-request
	// client would open a fresh TCP connection every time and the experiment
	// would measure the local dial cost, not the backends.
	// One TLS config, shared by the load client and the /lb/* helpers below, so
	// an https:// target does not work for the measurement and then fail on the
	// metrics scrape.
	var tlsConf *tls.Config
	if *insecure {
		tlsConf = &tls.Config{InsecureSkipVerify: true} // #nosec G402 — self-signed lab certificate
	}

	client := &http.Client{
		Timeout: *timeout,
		Transport: &http.Transport{
			DialContext:         (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			MaxIdleConns:        *concurrency * 2,
			MaxIdleConnsPerHost: *concurrency * 2,
			MaxConnsPerHost:     0,
			IdleConnTimeout:     60 * time.Second,
			DisableCompression:  true,
			// HTTP/1.1 on purpose, TLS or not: h2 multiplexes many requests
			// over one connection, so "concurrency" would stop meaning
			// "concurrent connections" and the TLS and plain-HTTP runs would
			// not be comparable.
			ForceAttemptHTTP2:   false,
			TLSClientConfig:     tlsConf,
			TLSHandshakeTimeout: 5 * time.Second,
		},
	}
	// Short-lived client for the control-plane calls: /lb/reset and the two
	// scrapes must not borrow connections from the measured pool.
	admin := &http.Client{
		Timeout:   10 * time.Second,
		Transport: &http.Transport{TLSClientConfig: tlsConf, TLSHandshakeTimeout: 5 * time.Second},
	}

	fire := func(ctx context.Context) sample {
		start := time.Now()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, *target, nil)
		if err != nil {
			return sample{d: time.Since(start), errKind: "build"}
		}
		req.Header.Set("connection", "keep-alive")
		resp, err := client.Do(req)
		if err != nil {
			return sample{d: time.Since(start), errKind: "transport"}
		}
		// Drained fully: an undrained body cannot be returned to the idle pool,
		// which silently turns keep-alive off partway through a run.
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return sample{
			d:       time.Since(start),
			ok:      resp.StatusCode >= 200 && resp.StatusCode < 400,
			status:  resp.StatusCode,
			backend: resp.Header.Get("X-Backend"),
		}
	}

	ctx := context.Background()

	if *warmup > 0 {
		fmt.Printf("warmup: %d requests…\n", *warmup)
		var wg sync.WaitGroup
		var left atomic.Int64
		left.Store(int64(*warmup))
		for i := 0; i < *concurrency; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for left.Add(-1) >= 0 {
					fire(ctx)
				}
			}()
		}
		wg.Wait()
	}

	// Reset AFTER warmup, so the load balancer's own window covers exactly the
	// measured requests. Resetting before the warmup charges the warmup traffic
	// and the idle gap that follows it to the run, which is why the LB-side
	// throughput otherwise reads materially below the client-side figure.
	base := strings.TrimRight(*lbBase, "/")
	if base != "" {
		if err := postTo(admin, base+"/lb/reset"); err != nil {
			fmt.Fprintf(os.Stderr, "loadgen: could not reset load-balancer counters (%v) — its numbers will include the warmup\n", err)
		} else {
			fmt.Printf("reset load-balancer counters at %s\n", base)
		}
	}

	fmt.Printf("experiment %q: %d requests, concurrency %d -> %s\n", *experiment, *requests, *concurrency, *target)

	samples := make([]sample, *requests)
	var idx atomic.Int64
	idx.Store(int64(*requests))

	startedAt := time.Now()
	var wg sync.WaitGroup
	// Exactly -concurrency workers pulling from one shared counter: the
	// in-flight count is bounded by the pool size, which is what "concurrency"
	// has to mean for the 1-backend and 3-backend runs to be comparable.
	for w := 0; w < *concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				n := idx.Add(-1)
				if n < 0 {
					return
				}
				samples[n] = fire(ctx)
			}
		}()
	}
	wg.Wait()
	elapsed := time.Since(startedAt)

	lat := make([]time.Duration, 0, len(samples))
	perBackend := map[string]int{}
	statusMix := map[string]int{}
	success, failed := 0, 0
	var sum time.Duration
	for _, s := range samples {
		lat = append(lat, s.d)
		sum += s.d
		if s.ok {
			success++
		} else {
			failed++
		}
		key := s.backend
		if key == "" {
			key = "unknown"
		}
		perBackend[key]++
		if s.status == 0 {
			statusMix["err:"+s.errKind]++
		} else {
			statusMix[strconv.Itoa(s.status)]++
		}
	}
	sort.Slice(lat, func(i, j int) bool { return lat[i] < lat[j] })

	res := Result{
		Experiment:     *experiment,
		Target:         *target,
		Requests:       *requests,
		Concurrency:    *concurrency,
		Successful:     success,
		Failed:         failed,
		ElapsedS:       round2(elapsed.Seconds()),
		ThroughputRPS:  round2(float64(success) / elapsed.Seconds()),
		DropoutPercent: round2(float64(failed) / float64(*requests) * 100),
		P50Ms:          percentile(lat, 50),
		P95Ms:          percentile(lat, 95),
		P99Ms:          percentile(lat, 99),
		MinMs:          ms(lat[0]),
		MaxMs:          ms(lat[len(lat)-1]),
		MeanMs:         ms(sum / time.Duration(len(lat))),
		PerBackend:     perBackend,
		StatusMix:      statusMix,
		StartedAt:      startedAt.Format(time.RFC3339),
	}

	printReport(res)
	if err := writeJSON(*out, res); err != nil {
		fmt.Fprintf(os.Stderr, "loadgen: writing JSON: %v\n", err)
	}
	// Scraped here rather than by a wrapper script, so one command per
	// experiment produces every file the report needs for that run.
	if base != "" {
		for path, suffix := range map[string]string{"/lb/metrics": ".lb-metrics.json", "/lb/status": ".lb-status.json"} {
			if err := saveGET(admin, base+path, filepath.Join(*out, *experiment+suffix)); err != nil {
				fmt.Fprintf(os.Stderr, "loadgen: saving %s: %v\n", path, err)
			}
		}
	}
	if err := appendCSV(*csvPath, res); err != nil {
		fmt.Fprintf(os.Stderr, "loadgen: writing CSV: %v\n", err)
	}
}

func postTo(c *http.Client, u string) error {
	req, err := http.NewRequest(http.MethodPost, u, nil)
	if err != nil {
		return err
	}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return nil
}

// saveGET fetches u and writes the body to path.
func saveGET(c *http.Client, u, path string) error {
	resp, err := c.Get(u)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		return err
	}
	fmt.Printf("wrote %s\n", path)
	return nil
}

func printReport(r Result) {
	fmt.Printf("\n  experiment      %s\n", r.Experiment)
	fmt.Printf("  requests        %d (concurrency %d)\n", r.Requests, r.Concurrency)
	fmt.Printf("  successful      %d\n", r.Successful)
	fmt.Printf("  failed          %d\n", r.Failed)
	fmt.Printf("  elapsed         %.2fs\n", r.ElapsedS)
	fmt.Printf("  throughput      %.2f rps\n", r.ThroughputRPS)
	fmt.Printf("  dropout         %.2f%%\n", r.DropoutPercent)
	fmt.Printf("  latency         p50 %.2fms  p95 %.2fms  p99 %.2fms  (min %.2f / mean %.2f / max %.2f)\n",
		r.P50Ms, r.P95Ms, r.P99Ms, r.MinMs, r.MeanMs, r.MaxMs)
	fmt.Printf("  per backend     %v\n", r.PerBackend)
	fmt.Printf("  status mix      %v\n\n", r.StatusMix)
}

func writeJSON(dir string, r Result) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(dir, r.Experiment+".json")
	blob, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, append(blob, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Printf("wrote %s\n", path)
	return nil
}

var csvHeader = []string{
	"experiment", "target", "requests", "concurrency", "successful", "failed",
	"elapsed_s", "throughput_rps", "dropout_percent", "p50_ms", "p95_ms", "p99_ms",
	"mean_ms", "max_ms", "started_at",
}

func appendCSV(path string, r Result) error {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	// Header written only when the file is new, so repeated runs append rows to
	// one table instead of interleaving headers through it.
	_, statErr := os.Stat(path)
	fresh := os.IsNotExist(statErr)

	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()

	w := csv.NewWriter(f)
	if fresh {
		if err := w.Write(csvHeader); err != nil {
			return err
		}
	}
	row := []string{
		r.Experiment, r.Target, strconv.Itoa(r.Requests), strconv.Itoa(r.Concurrency),
		strconv.Itoa(r.Successful), strconv.Itoa(r.Failed),
		fmt.Sprintf("%.2f", r.ElapsedS), fmt.Sprintf("%.2f", r.ThroughputRPS),
		fmt.Sprintf("%.2f", r.DropoutPercent), fmt.Sprintf("%.2f", r.P50Ms),
		fmt.Sprintf("%.2f", r.P95Ms), fmt.Sprintf("%.2f", r.P99Ms),
		fmt.Sprintf("%.2f", r.MeanMs), fmt.Sprintf("%.2f", r.MaxMs), r.StartedAt,
	}
	if err := w.Write(row); err != nil {
		return err
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return err
	}
	fmt.Printf("appended %s\n", path)
	return nil
}
