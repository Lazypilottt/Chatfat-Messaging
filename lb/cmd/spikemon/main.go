// Command spikemon measures how quickly each component of score() reacts to a
// sudden concurrency spike by polling /lb/status at 200 ms intervals while two
// back-to-back loadgen phases (low then high concurrency) run against the LB.
//
// Columns emitted to stdout (TSV):
//
//	elapsed_ms  backend  in_flight  ewma_ms  lag_ms  score_ms  over_threshold
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

type lbStatus struct {
	Backends []struct {
		URL          string  `json:"url"`
		InFlight     int64   `json:"in_flight"`
		ScoreMs      float64 `json:"score_ms"`
		ServiceMs    float64 `json:"service_ms_ewma"`
		LagMs        float64 `json:"backend_lag_ms"`
		OverThreshold bool   `json:"over_threshold"`
	} `json:"backends"`
}

func main() {
	lb := flag.String("lb", "http://127.0.0.1:14200", "LB base URL")
	interval := flag.Duration("interval", 200*time.Millisecond, "polling interval")
	duration := flag.Duration("duration", 30*time.Second, "total observation window")
	flag.Parse()

	client := &http.Client{Timeout: 2 * time.Second}
	start := time.Now()
	deadline := start.Add(*duration)

	// Header
	fmt.Printf("elapsed_ms\tbackend\tin_flight\tewma_ms\tlag_ms\tscore_ms\tover_threshold\n")

	for time.Now().Before(deadline) {
		t0 := time.Now()
		elapsedMs := t0.Sub(start).Milliseconds()

		resp, err := client.Get(*lb + "/lb/status")
		if err != nil {
			fmt.Fprintf(os.Stderr, "[%dms] poll error: %v\n", elapsedMs, err)
		} else {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			var s lbStatus
			if err := json.Unmarshal(body, &s); err == nil {
				for _, b := range s.Backends {
					fmt.Printf("%d\t%s\t%d\t%.2f\t%.2f\t%.2f\t%v\n",
						elapsedMs, b.URL,
						b.InFlight, b.ServiceMs, b.LagMs, b.ScoreMs,
						b.OverThreshold)
				}
			}
		}

		// Sleep for the remainder of the interval (absorb poll RTT).
		if sleep := *interval - time.Since(t0); sleep > 0 {
			time.Sleep(sleep)
		}
	}
}
