package relay

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/pedro-hbl/janjacast/internal/protocol"
)

func discard() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}

// collect drains everything queued for a client after its Leave.
func collect(seq func(yield func(OutMsg) bool)) []OutMsg {
	var out []OutMsg
	seq(func(m OutMsg) bool {
		out = append(out, m)
		return len(out) < 10_000
	})
	return out
}

func mediaMsg(keyframe bool) []byte {
	msg := make([]byte, protocol.HeaderSize+4)
	msg[0] = protocol.KindVideo
	if keyframe {
		msg[1] = protocol.FlagKeyframe
	}
	return msg
}

func stageOf(r *Room) protocol.StageStateData {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stageStateLocked()
}

func TestFanoutSkipsPublisher(t *testing.T) {
	hub := NewHub(discard())
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, bobOut := hub.Join("r1", "b", "bob")

	room.TakeStage(alice)
	room.ForwardMedia(alice, mediaMsg(true))
	hub.Leave(room, bob)

	var media int
	for _, m := range collect(bobOut) {
		if m.Binary() {
			media++
		}
	}
	if media != 1 {
		t.Fatalf("bob got %d media messages, want 1", media)
	}
}

func TestNonPublisherMediaIgnored(t *testing.T) {
	hub := NewHub(discard())
	room, _, _ := hub.Join("r1", "a", "alice")
	_, bob, bobOut := hub.Join("r1", "b", "bob")

	room.ForwardMedia(bob, mediaMsg(true)) // bob never took the stage
	hub.Leave(room, bob)

	for _, m := range collect(bobOut) {
		if m.Binary() {
			t.Fatal("media forwarded from a non-publisher")
		}
	}
}

func TestPublisherLeavingFreesStage(t *testing.T) {
	hub := NewHub(discard())
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, bobOut := hub.Join("r1", "b", "bob")

	room.TakeStage(alice)
	hub.Leave(room, alice)
	hub.Leave(room, bob)

	var last protocol.StageStateData
	for _, m := range collect(bobOut) {
		if m.Binary() {
			continue
		}
		var ctrl protocol.Control
		if err := json.Unmarshal(m.Payload(), &ctrl); err != nil {
			t.Fatal(err)
		}
		if ctrl.Type == protocol.CtrlStageState {
			last = protocol.StageStateData{} // Unmarshal merges; reset first
			if err := json.Unmarshal(ctrl.Data, &last); err != nil {
				t.Fatal(err)
			}
		}
	}
	if last.PublisherID != "" {
		t.Fatalf("stage still held by %q after publisher left", last.PublisherID)
	}
}

func TestOwnerCanStopCompanionStage(t *testing.T) {
	hub := NewHub(discard())
	room, activity, _ := hub.Join("r1", "u1", "pedro")
	_, companion, _ := hub.Join("r1", "u1:tab", "pedro (sharing)")
	_, stranger, _ := hub.Join("r1", "u2", "mallory")

	room.TakeStage(companion)

	room.LeaveStage(stranger)
	if got := stageOf(room).PublisherID; got != "u1:tab" {
		t.Fatalf("stranger cleared the stage (publisher %q)", got)
	}

	room.LeaveStage(activity)
	if got := stageOf(room).PublisherID; got != "" {
		t.Fatalf("owner could not stop own companion stream (publisher %q)", got)
	}
}

// TestNewJoinerRequiresKeyframe: with no GOP cached, a fresh viewer must not
// receive delta frames until a keyframe arrives.
func TestNewJoinerRequiresKeyframe(t *testing.T) {
	hub := NewHub(discard())
	room, alice, _ := hub.Join("r1", "a", "alice")
	room.TakeStage(alice) // clears GOP

	_, bob, bobOut := hub.Join("r1", "b", "bob")

	room.ForwardMedia(alice, mediaMsg(false)) // delta first: must be dropped
	room.ForwardMedia(alice, mediaMsg(true))  // then a keyframe: delivered
	room.ForwardMedia(alice, mediaMsg(false)) // and the next delta: delivered
	hub.Leave(room, bob)

	var media int
	for _, m := range collect(bobOut) {
		if m.Binary() {
			media++
		}
	}
	if media != 2 {
		t.Fatalf("joiner got %d media messages, want 2 (keyframe + following delta)", media)
	}
}

// TestConcurrentJoinLeave hammers the exact interleavings that previously
// caused send-on-closed-channel panics and hub/room split-brain. Run with
// -race.
func TestConcurrentJoinLeave(t *testing.T) {
	hub := stingerHub(time.Millisecond) // stinger timers race the churn too

	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				id := fmt.Sprintf("u%d-%d", g, i)
				room, c, seq := hub.Join("contested", id, id)
				if g%2 == 0 {
					room.TakeStage(c)
					room.ForwardMedia(c, mediaMsg(true))
				}
				done := make(chan struct{})
				go func() {
					seq(func(OutMsg) bool { return true })
					close(done)
				}()
				hub.Leave(room, c)
				<-done
			}
		}(g)
	}
	wg.Wait()

	if n := hub.Rooms(); n != 0 {
		t.Fatalf("%d rooms leaked after all clients left (split-brain)", n)
	}
}

func mediaMsgTL(keyframe bool, tid uint8) []byte {
	msg := mediaMsg(keyframe)
	msg[2] = tid
	return msg
}

// TestTemporalSheddingBeforeFreeze: an overflow on a higher temporal layer
// sheds that layer (safe: non-reference frames), keeping the viewer
// continuously decodable at a lower framerate; an overflow on the base layer
// is the freeze point (a T0 gap would corrupt decode).
func TestTemporalSheddingBeforeFreeze(t *testing.T) {
	hub := NewHub(discard())
	room, alice, _ := hub.Join("r1", "a", "alice")
	room.TakeStage(alice)
	_, bob, _ := hub.Join("r1", "b", "bob")

	// Prime bob past needKeyframe, then fill his queue to exactly capacity
	// with base-layer traffic (no overflow yet). His queue already holds two
	// control messages from joining: welcome + room_state.
	room.ForwardMedia(alice, mediaMsgTL(true, 0))
	for i := 0; i < sendBuffer-3; i++ {
		room.ForwardMedia(alice, mediaMsgTL(false, 0))
	}

	tl := func() uint8 {
		room.mu.Lock()
		defer room.mu.Unlock()
		return bob.maxTL
	}
	frozen := func() bool {
		room.mu.Lock()
		defer room.mu.Unlock()
		return bob.needKeyframe
	}

	// Overflow with a T2 chunk: shed to maxTL 1, no freeze.
	room.ForwardMedia(alice, mediaMsgTL(false, 2))
	if got := tl(); got != 1 {
		t.Fatalf("maxTL = %d after T2 overflow, want 1", got)
	}
	if frozen() {
		t.Fatal("viewer froze on a sheddable layer overflow")
	}

	// A further T2 chunk is now above the viewer's layer: skipped silently.
	room.ForwardMedia(alice, mediaMsgTL(false, 2))
	if got := tl(); got != 1 {
		t.Fatalf("maxTL = %d after skipping high layer, want unchanged 1", got)
	}

	// Overflow with T1: shed to 0.
	room.ForwardMedia(alice, mediaMsgTL(false, 1))
	if got := tl(); got != 0 {
		t.Fatalf("maxTL = %d after T1 overflow, want 0", got)
	}
	if frozen() {
		t.Fatal("viewer froze before a base-layer overflow")
	}

	// Overflow with T0: the freeze point.
	room.ForwardMedia(alice, mediaMsgTL(false, 0))
	if !frozen() {
		t.Fatal("viewer not frozen after base-layer overflow")
	}
}

// TestSessionTakeoverNewestWins: the same identity joining again replaces
// the old connection — no ghost roster entries — and the old connection is
// told it was superseded (terminally) rather than just dropped.
func TestSessionTakeoverNewestWins(t *testing.T) {
	hub := NewHub(discard())
	room, first, firstOut := hub.Join("r1", "u1:tab", "pedro (sharing)")
	room.TakeStage(first)

	room2, second, _ := hub.Join("r1", "u1:tab", "pedro (sharing)")
	if room2 != room {
		t.Fatal("takeover produced a different room")
	}

	// The old connection's sequence must terminate (done closed) after
	// delivering the superseded control.
	sawSuperseded := false
	for _, m := range collect(firstOut) {
		if m.Binary() {
			continue
		}
		var ctrl protocol.Control
		if err := json.Unmarshal(m.Payload(), &ctrl); err == nil &&
			ctrl.Type == protocol.CtrlSuperseded {
			sawSuperseded = true
		}
	}
	if !sawSuperseded {
		t.Fatal("old connection was not told it was superseded")
	}

	// Roster holds exactly one entry for the identity, and the stage was
	// freed (the old publisher is gone; the new session re-takes it).
	room.mu.Lock()
	count := len(room.clients)
	pub := room.publisher
	room.mu.Unlock()
	if count != 1 {
		t.Fatalf("roster has %d clients after takeover, want 1", count)
	}
	if pub != nil {
		t.Fatalf("stage still held after its holder was superseded")
	}

	// And the new session works normally.
	room.TakeStage(second)
	if got := stageOf(room).PublisherID; got != "u1:tab" {
		t.Fatalf("new session cannot take the stage (publisher %q)", got)
	}
}

// ------------------------- stingers ----------------------------------------

// stingerHub returns a hub with stingers enabled and a short stop window so
// tests need not sleep real seconds.
func stingerHub(stopDelay time.Duration) *Hub {
	hub := NewHub(discard())
	hub.StingerStopDelay = stopDelay
	hub.Stinger = func(kind string) *protocol.StingerData {
		return &protocol.StingerData{
			Kind:  kind,
			Image: "/stingers/img.webp",
			Audio: "/stingers/snd.mp3",
		}
	}
	return hub
}

// stingersOf counts stingers by kind in a drained outbox.
func stingersOf(t *testing.T, msgs []OutMsg) map[string]int {
	t.Helper()
	got := map[string]int{}
	for _, m := range msgs {
		if m.Binary() {
			continue
		}
		var ctrl protocol.Control
		if err := json.Unmarshal(m.Payload(), &ctrl); err != nil {
			t.Fatal(err)
		}
		if ctrl.Type != protocol.CtrlStinger {
			continue
		}
		var d protocol.StingerData
		if err := json.Unmarshal(ctrl.Data, &d); err != nil {
			t.Fatal(err)
		}
		if d.Image == "" || d.Audio == "" {
			t.Fatalf("stinger %q missing asset URLs: %+v", d.Kind, d)
		}
		got[d.Kind]++
	}
	return got
}

// waitStingerIdle polls until the room's pending stop stinger (if any) has
// fired, bounding the wait so a broken timer fails fast instead of hanging.
func waitStingerIdle(t *testing.T, r *Room) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		live := r.stingerLive
		r.mu.Unlock()
		if !live {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("stop stinger never fired")
}

// TestStingerStartOnFreshTake: a fresh nil→publisher transition plays the
// start stinger for every room client — the publisher included (their own
// Activity view is in the room).
func TestStingerStartOnFreshTake(t *testing.T) {
	hub := stingerHub(5 * time.Millisecond)
	room, alice, aliceOut := hub.Join("r1", "a", "alice")
	_, bob, bobOut := hub.Join("r1", "b", "bob")

	room.TakeStage(alice)
	hub.Leave(room, bob)
	hub.Leave(room, alice)

	for name, out := range map[string][]OutMsg{"bob": collect(bobOut), "alice": collect(aliceOut)} {
		got := stingersOf(t, out)
		if got["start"] != 1 || got["stop"] != 0 {
			t.Fatalf("%s got stingers %v, want exactly one start", name, got)
		}
	}
}

// TestStingerStopAfterWindow: the stage staying empty past the debounce
// window plays the stop stinger.
func TestStingerStopAfterWindow(t *testing.T) {
	hub := stingerHub(5 * time.Millisecond)
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, bobOut := hub.Join("r1", "b", "bob")

	room.TakeStage(alice)
	room.LeaveStage(alice)
	waitStingerIdle(t, room)
	hub.Leave(room, bob)

	got := stingersOf(t, collect(bobOut))
	if got["start"] != 1 || got["stop"] != 1 {
		t.Fatalf("bob got stingers %v, want one start and one stop", got)
	}
}

// TestStingerReconnectFiresNothing: a publisher dropping (Leave) and
// re-joining + re-taking within the stop window is the same stream
// continuing — the pending stop is cancelled and no duplicate start fires.
func TestStingerReconnectFiresNothing(t *testing.T) {
	hub := stingerHub(50 * time.Millisecond)
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, bobOut := hub.Join("r1", "b", "bob")

	room.TakeStage(alice)
	hub.Leave(room, alice) // connection blip: stop is now pending

	room2, alice2, _ := hub.Join("r1", "a", "alice")
	if room2 != room {
		t.Fatal("rejoin produced a different room")
	}
	room.TakeStage(alice2) // re-take within the window cancels the stop

	time.Sleep(150 * time.Millisecond) // well past the window: nothing may fire
	hub.Leave(room, bob)

	got := stingersOf(t, collect(bobOut))
	if got["start"] != 1 || got["stop"] != 0 {
		t.Fatalf("bob got stingers %v, want exactly the original start", got)
	}
}

// TestStingerLeaveStageReconnect: same as above but via LeaveStage + re-take
// (a restarted share racing the window).
func TestStingerLeaveStageReconnect(t *testing.T) {
	hub := stingerHub(50 * time.Millisecond)
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, bobOut := hub.Join("r1", "b", "bob")

	room.TakeStage(alice)
	room.LeaveStage(alice)
	room.TakeStage(alice)

	time.Sleep(150 * time.Millisecond)
	hub.Leave(room, bob)

	got := stingersOf(t, collect(bobOut))
	if got["start"] != 1 || got["stop"] != 0 {
		t.Fatalf("bob got stingers %v, want exactly the original start", got)
	}
}

// TestStingerSupersedeFiresNothing: a publisher's connection being superseded
// (same identity re-joins) and re-taking the stage fires neither a stop nor a
// duplicate start — it is the same stream on a fresh connection.
func TestStingerSupersedeFiresNothing(t *testing.T) {
	hub := stingerHub(5 * time.Millisecond)
	room, sharer, _ := hub.Join("r1", "u1:tab", "pedro (sharing)")
	_, bob, bobOut := hub.Join("r1", "b", "bob")

	room.TakeStage(sharer)
	_, sharer2, _ := hub.Join("r1", "u1:tab", "pedro (sharing)") // supersedes
	room.TakeStage(sharer2)

	time.Sleep(50 * time.Millisecond)
	hub.Leave(room, bob)

	got := stingersOf(t, collect(bobOut))
	if got["start"] != 1 || got["stop"] != 0 {
		t.Fatalf("bob got stingers %v, want exactly the original start", got)
	}
}

// TestStingerTakeoverFiresNothing: another user taking an occupied stage
// replaces the publisher directly (never nil→publisher), so no stinger fires
// for the takeover itself.
func TestStingerTakeoverFiresNothing(t *testing.T) {
	hub := stingerHub(5 * time.Millisecond)
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, _ := hub.Join("r1", "b", "bob")
	_, carol, carolOut := hub.Join("r1", "c", "carol")

	room.TakeStage(alice)
	room.TakeStage(bob) // takes the stage from alice directly

	time.Sleep(50 * time.Millisecond)
	hub.Leave(room, carol)

	got := stingersOf(t, collect(carolOut))
	if got["start"] != 1 || got["stop"] != 0 {
		t.Fatalf("carol got stingers %v, want exactly the original start", got)
	}
}

// TestStingerStopTimerOnReapedRoom: the last viewer leaving reaps the room
// while a stop timer is pending; the callback must neither panic nor
// resurrect anything.
func TestStingerStopTimerOnReapedRoom(t *testing.T) {
	hub := stingerHub(5 * time.Millisecond)
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, _ := hub.Join("r1", "b", "bob")

	room.TakeStage(alice)
	hub.Leave(room, alice) // stop pending
	hub.Leave(room, bob)   // room emptied and reaped

	if n := hub.Rooms(); n != 0 {
		t.Fatalf("%d rooms alive after everyone left", n)
	}
	time.Sleep(50 * time.Millisecond) // let the timer fire on the reaped room
	if n := hub.Rooms(); n != 0 {
		t.Fatalf("stop timer resurrected a room (%d alive)", n)
	}
}

// TestStingerDisabled: a nil Hub.Stinger (feature off) must fire nothing and
// arm no timers.
func TestStingerDisabled(t *testing.T) {
	hub := NewHub(discard())
	hub.StingerStopDelay = time.Millisecond
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, bobOut := hub.Join("r1", "b", "bob")

	room.TakeStage(alice)
	room.LeaveStage(alice)
	time.Sleep(20 * time.Millisecond)
	hub.Leave(room, bob)

	if got := stingersOf(t, collect(bobOut)); len(got) != 0 {
		t.Fatalf("disabled stingers still fired: %v", got)
	}
}
