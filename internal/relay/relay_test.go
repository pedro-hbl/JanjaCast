package relay

import (
	"encoding/json"
	"log/slog"
	"testing"

	"github.com/pedro-hbl/golive/internal/protocol"
)

func discard() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}

// drain collects everything currently queued for a client.
func drain(seq func(yield func(OutMsg) bool)) []OutMsg {
	var out []OutMsg
	seq(func(m OutMsg) bool {
		if len(m.Payload()) == 0 {
			return false
		}
		out = append(out, m)
		return len(out) < 100
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

func TestFanoutSkipsPublisher(t *testing.T) {
	hub := NewHub(discard())
	room := hub.Room("r1")

	alice, _ := room.Join("a", "alice")
	bob, bobOut := room.Join("b", "bob")

	room.TakeStage(alice)
	room.ForwardMedia(alice, mediaMsg(true))
	room.Leave(bob) // closes bob's channel so drain terminates

	var gotMedia int
	for m := range bobOut {
		if m.Binary() {
			gotMedia++
		}
	}
	if gotMedia != 1 {
		t.Fatalf("bob got %d media messages, want 1", gotMedia)
	}
}

func TestNonPublisherMediaIgnored(t *testing.T) {
	hub := NewHub(discard())
	room := hub.Room("r1")

	alice, _ := room.Join("a", "alice")
	bob, bobOut := room.Join("b", "bob")

	// bob never took the stage; his media must not be forwarded.
	room.ForwardMedia(bob, mediaMsg(true))
	room.Leave(alice)
	_ = alice

	room.Leave(bob)
	for m := range bobOut {
		if m.Binary() {
			t.Fatal("media forwarded from a non-publisher")
		}
	}
}

func TestPublisherLeavingFreesStage(t *testing.T) {
	hub := NewHub(discard())
	room := hub.Room("r1")

	alice, _ := room.Join("a", "alice")
	bob, bobOut := room.Join("b", "bob")

	room.TakeStage(alice)
	room.Leave(alice)
	room.Leave(bob)

	var last protocol.StageStateData
	for m := range bobOut {
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
