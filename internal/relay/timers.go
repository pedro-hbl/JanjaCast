package relay

// One scheduler per room instead of one time.AfterFunc goroutine per pending
// deadline. Two problems die here (tpm1+tpm2, merged):
//
//   - a reaped room used to be held alive by every pending AfterFunc closure
//     (an unanswered aposta pins the *Room for 30s; an untouched rodízio slot
//     for the whole slot length), each firing later as a pointless no-op;
//   - the timer population was invisible — nothing could say how much
//     background work a long Friday session had accumulated.
//
// The scheduler keeps ONE runtime timer per room, armed for the earliest
// deadline only. Callbacks keep their existing contract: they lock Room.mu
// themselves and carry their own generation guards, exactly as before.
// stopTimers (called at reap) drops every entry and the runtime timer, so a
// dead room releases immediately and can never fire again.

import (
	"sort"
	"sync"
	"time"
)

type timerEntry struct {
	at time.Time
	fn func()
}

type roomTimers struct {
	mu      sync.Mutex
	entries []timerEntry // sorted by at, earliest first
	t       *time.Timer
	stopped bool
}

// schedule runs fn after d. fn must be safe to call on a reaped room (all
// current callers guard with generations and empty-clients checks) — but
// after stopTimers it is guaranteed not to run at all.
func (rt *roomTimers) schedule(d time.Duration, fn func()) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.stopped {
		return
	}
	e := timerEntry{at: time.Now().Add(d), fn: fn}
	i := sort.Search(len(rt.entries), func(i int) bool { return rt.entries[i].at.After(e.at) })
	rt.entries = append(rt.entries, timerEntry{})
	copy(rt.entries[i+1:], rt.entries[i:])
	rt.entries[i] = e
	rt.armLocked()
}

// armLocked (re)arms the single runtime timer for the earliest entry.
func (rt *roomTimers) armLocked() {
	if len(rt.entries) == 0 || rt.stopped {
		return
	}
	d := time.Until(rt.entries[0].at)
	if d < 0 {
		d = 0
	}
	if rt.t == nil {
		rt.t = time.AfterFunc(d, rt.fire)
		return
	}
	rt.t.Reset(d)
}

// fire runs every entry that is due, then re-arms. Callbacks run outside
// rt.mu (they take Room.mu themselves; holding rt.mu across them would
// build a lock-order edge nothing else has).
func (rt *roomTimers) fire() {
	rt.mu.Lock()
	now := time.Now()
	var due []func()
	for len(rt.entries) > 0 && !rt.entries[0].at.After(now) {
		due = append(due, rt.entries[0].fn)
		rt.entries = rt.entries[1:]
	}
	stopped := rt.stopped
	rt.armLocked()
	rt.mu.Unlock()
	if stopped {
		return
	}
	for _, fn := range due {
		fn()
	}
}

// stopTimers ends the room's background life: pending work is dropped, the
// runtime timer released, and no callback will ever run again.
func (rt *roomTimers) stopTimers() {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.stopped = true
	rt.entries = nil
	if rt.t != nil {
		rt.t.Stop()
		rt.t = nil
	}
}

// pending is the census hook: how many deadlines this room still holds.
func (rt *roomTimers) pending() int {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return len(rt.entries)
}

// TimerCensus sums pending deadlines across every live room — the number a
// long session can be judged by. Hub.mu then each room's timer mutex; never
// Room.mu, so it is safe from any caller.
func (h *Hub) TimerCensus() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	total := 0
	for _, r := range h.rooms {
		total += r.timers.pending()
	}
	return total
}
