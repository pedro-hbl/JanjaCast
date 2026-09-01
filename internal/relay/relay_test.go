package relay

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"testing"

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
	hub := NewHub(discard())

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
