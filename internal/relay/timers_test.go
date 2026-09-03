package relay

import (
	"os"
	"regexp"
	"sync/atomic"
	"testing"
	"time"
)

// The scheduler in timers.go must stay the ONLY place a runtime timer is
// created in this package: a raw AfterFunc pins reaped rooms in memory and
// escapes the census. (Mirrors TestDispatchCoverage's source-scan approach.)
func TestNoRawRuntimeTimers(t *testing.T) {
	src, err := os.ReadFile("relay.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, pat := range []string{`time\.AfterFunc\(`, `time\.NewTimer\(`, `time\.NewTicker\(`} {
		if m := regexp.MustCompile(pat).FindAll(src, -1); len(m) > 0 {
			t.Errorf("relay.go uses %s %d time(s) — schedule through Room.timers instead", pat, len(m))
		}
	}
}

func TestSchedulerFiresAndCounts(t *testing.T) {
	var rt roomTimers
	var fired atomic.Int32
	rt.schedule(10*time.Millisecond, func() { fired.Add(1) })
	rt.schedule(20*time.Millisecond, func() { fired.Add(1) })
	if got := rt.pending(); got != 2 {
		t.Fatalf("pending = %d, want 2", got)
	}
	deadline := time.Now().Add(2 * time.Second)
	for fired.Load() != 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if fired.Load() != 2 {
		t.Fatalf("fired = %d, want 2", fired.Load())
	}
	if got := rt.pending(); got != 0 {
		t.Fatalf("pending after fire = %d, want 0", got)
	}
}

// A stopped scheduler is a dead scheduler: pending work is dropped and
// nothing scheduled before OR after the stop may ever run.
func TestSchedulerStopDropsEverything(t *testing.T) {
	var rt roomTimers
	var fired atomic.Int32
	rt.schedule(30*time.Millisecond, func() { fired.Add(1) })
	rt.stopTimers()
	rt.schedule(1*time.Millisecond, func() { fired.Add(1) })
	if got := rt.pending(); got != 0 {
		t.Fatalf("pending after stop = %d, want 0", got)
	}
	time.Sleep(80 * time.Millisecond)
	if fired.Load() != 0 {
		t.Fatalf("callback ran on a stopped scheduler (fired=%d)", fired.Load())
	}
}
