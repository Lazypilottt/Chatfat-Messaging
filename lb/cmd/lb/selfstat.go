// selfstat.go — the load balancer's own resource use.
//
// The report has to cover the utilisation of all four systems, and Sys1 runs
// only this process. Rather than require an agent on the box or an SSH poll per
// sample, the balancer publishes its own figures alongside the backends' on
// /lb/metrics, so one scrape of one endpoint describes the whole topology.
//
// Read from /proc rather than runtime.MemStats: MemStats describes the Go heap,
// which is not what "system utilisation" means — a process can hold a large RSS
// with a small heap, and it is the RSS that competes with everything else on
// the machine.
package main

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const clockTicks = 100.0 // _SC_CLK_TCK on every Linux this runs on

var (
	statMu       sync.Mutex
	lastCPUTicks float64
	lastCPUAt    time.Time
	cpuPercent   float64
)

// procCPUTicks returns utime+stime from /proc/self/stat, in clock ticks.
func procCPUTicks() (float64, bool) {
	b, err := os.ReadFile("/proc/self/stat")
	if err != nil {
		return 0, false
	}
	// The comm field can contain spaces and parentheses, so fields are counted
	// from after the closing parenthesis rather than by splitting the whole
	// line — otherwise a process named "l b" shifts every later index.
	line := string(b)
	i := strings.LastIndexByte(line, ')')
	if i < 0 {
		return 0, false
	}
	f := strings.Fields(line[i+1:])
	// After ')' the fields are: state(0) ppid(1) … utime(11) stime(12)
	if len(f) < 13 {
		return 0, false
	}
	ut, err1 := strconv.ParseFloat(f[11], 64)
	st, err2 := strconv.ParseFloat(f[12], 64)
	if err1 != nil || err2 != nil {
		return 0, false
	}
	return ut + st, true
}

// procRSSMB returns resident set size in MiB.
func procRSSMB() int {
	b, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0
	}
	f := strings.Fields(string(b))
	if len(f) < 2 {
		return 0
	}
	pages, err := strconv.ParseFloat(f[1], 64)
	if err != nil {
		return 0
	}
	return int(pages * float64(os.Getpagesize()) / 1048576)
}

// selfStats samples CPU since the previous call. The metrics handler may be
// scraped concurrently, so the running state is mutex-guarded: two scrapes
// racing would otherwise both see a tiny interval and report a nonsense
// percentage. A sample closer together than 50 ms reuses the last value rather
// than dividing by near-zero.
func selfStats() map[string]any {
	statMu.Lock()
	now := time.Now()
	if ticks, ok := procCPUTicks(); ok {
		switch {
		case lastCPUAt.IsZero():
			lastCPUTicks, lastCPUAt = ticks, now
		default:
			if elapsed := now.Sub(lastCPUAt).Seconds(); elapsed > 0.05 {
				used := (ticks - lastCPUTicks) / clockTicks
				// Normalised by core count, so 100 means "every core busy" and
				// the number is comparable with the backends' own figure.
				cpuPercent = used / elapsed * 100 / float64(runtime.NumCPU())
				lastCPUTicks, lastCPUAt = ticks, now
			}
		}
	}
	pct := cpuPercent
	statMu.Unlock()

	return map[string]any{
		"cpu_percent": round2(pct),
		// Share of a single core. The balancer is not single-threaded, so this
		// can exceed 100 — it is reported for comparability with the backends,
		// whose per-core figure is the meaningful saturation measure.
		"cpu_core_percent": round2(pct * float64(runtime.NumCPU())),
		"rss_mb":           procRSSMB(),
		"goroutines":       runtime.NumGoroutine(),
		"cpus":             runtime.NumCPU(),
	}
}
