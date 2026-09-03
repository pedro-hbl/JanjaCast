package relay

import (
	"encoding/json"
	"testing"

	"github.com/pedro-hbl/janjacast/internal/protocol"
)

// welcomeOf finds the CtrlWelcome envelope in a drained client queue.
func welcomeOf(t *testing.T, msgs []OutMsg) protocol.WelcomeData {
	t.Helper()
	for _, m := range msgs {
		if m.Binary() {
			continue
		}
		var ctrl protocol.Control
		if err := json.Unmarshal(m.Payload(), &ctrl); err != nil {
			continue
		}
		if ctrl.Type != protocol.CtrlWelcome {
			continue
		}
		var w protocol.WelcomeData
		if err := json.Unmarshal(ctrl.Data, &w); err != nil {
			t.Fatalf("welcome payload: %v", err)
		}
		return w
	}
	t.Fatal("no welcome in queue")
	return protocol.WelcomeData{}
}

// lastBlankState returns the final CtrlBlankState seen in a drained queue.
func lastBlankState(t *testing.T, msgs []OutMsg) (on bool, seen bool) {
	t.Helper()
	for _, m := range msgs {
		if m.Binary() {
			continue
		}
		var ctrl protocol.Control
		if err := json.Unmarshal(m.Payload(), &ctrl); err != nil {
			continue
		}
		if ctrl.Type != protocol.CtrlBlankState {
			continue
		}
		var d protocol.BlankData
		if err := json.Unmarshal(ctrl.Data, &d); err != nil {
			t.Fatalf("blank_state payload: %v", err)
		}
		on, seen = d.On, true
	}
	return on, seen
}

func gopLen(r *Room) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.slots[0].gop)
}

// The relay's half of the panic button, all four guarantees in one place:
// the late-join cache is evicted, a mid-blank joiner is told the room is
// hidden and handed no media, stray chunks are not fanned, and a viewer
// cannot blank a room they do not own.
func TestBlankEvictsGOP(t *testing.T) {
	hub := NewHub(discard())
	room, alice, _ := hub.Join("r1", "a", "alice")
	room.TakeStage(alice)
	room.ForwardMedia(alice, mediaMsg(true))
	room.ForwardMedia(alice, mediaMsg(false))
	if gopLen(room) != 2 {
		t.Fatalf("precondition: GOP holds %d chunks, want 2", gopLen(room))
	}

	room.SetBlank(alice, true)
	if gopLen(room) != 0 {
		t.Fatalf("GOP holds %d chunks after blank, want 0", gopLen(room))
	}

	// A client joining mid-blank must learn the state and receive no media.
	_, bob, bobOut := hub.Join("r1", "b", "bob")
	// Stray media from the publisher while blanked must not be fanned.
	room.ForwardMedia(alice, mediaMsg(true))
	room.ForwardMedia(alice, mediaMsg(false))
	if gopLen(room) != 0 {
		t.Fatalf("blanked room re-cached %d chunks", gopLen(room))
	}

	// A viewer must not be able to hide (or un-hide) somebody else's room.
	room.SetBlank(bob, false)
	room.mu.Lock()
	stillBlanked := room.blanked
	room.mu.Unlock()
	if !stillBlanked {
		t.Fatal("a viewer's CtrlBlank was honored")
	}

	hub.Leave(room, bob)
	msgs := collect(bobOut)
	if w := welcomeOf(t, msgs); !w.Blanked {
		t.Fatal("mid-blank joiner's welcome did not carry Blanked")
	}
	for _, m := range msgs {
		if m.Binary() {
			t.Fatal("media reached a client while the room was blanked")
		}
	}
}

// Un-blanking lifts the gate and tells everyone.
func TestUnblankResumesFanout(t *testing.T) {
	hub := NewHub(discard())
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, bobOut := hub.Join("r1", "b", "bob")
	room.TakeStage(alice)

	room.SetBlank(alice, true)
	room.ForwardMedia(alice, mediaMsg(true)) // dropped
	room.SetBlank(alice, false)
	room.ForwardMedia(alice, mediaMsg(true)) // delivered

	hub.Leave(room, bob)
	msgs := collect(bobOut)

	var media int
	for _, m := range msgs {
		if m.Binary() {
			media++
		}
	}
	if media != 1 {
		t.Fatalf("bob got %d media chunks, want 1 (only the post-unblank keyframe)", media)
	}
	on, seen := lastBlankState(t, msgs)
	if !seen {
		t.Fatal("bob never received a blank_state")
	}
	if on {
		t.Fatal("last blank_state still says on")
	}
}

// A stuck blank would outlive its owner and hide the next person's stream.
// Every path that frees the stage has to clear it.
func TestBlankClearedWhenStageChanges(t *testing.T) {
	t.Run("publisher disconnects", func(t *testing.T) {
		hub := NewHub(discard())
		room, alice, _ := hub.Join("r1", "a", "alice")
		_, bob, _ := hub.Join("r1", "b", "bob")
		room.TakeStage(alice)
		room.SetBlank(alice, true)
		hub.Leave(room, alice)

		room.TakeStage(bob)
		room.mu.Lock()
		blanked := room.blanked
		room.mu.Unlock()
		if blanked {
			t.Fatal("bob's fresh stream inherited alice's blank")
		}
		if stageOf(room).Blanked {
			t.Fatal("stage state still reports blanked")
		}
	})

	t.Run("publisher leaves the stage", func(t *testing.T) {
		hub := NewHub(discard())
		room, alice, _ := hub.Join("r1", "a", "alice")
		room.TakeStage(alice)
		room.SetBlank(alice, true)
		room.LeaveStage(alice)
		if stageOf(room).Blanked {
			t.Fatal("blank survived leave_stage")
		}
	})

	t.Run("someone else takes the stage", func(t *testing.T) {
		hub := NewHub(discard())
		room, alice, _ := hub.Join("r1", "a", "alice")
		_, bob, _ := hub.Join("r1", "b", "bob")
		room.TakeStage(alice)
		room.SetBlank(alice, true)
		room.TakeStage(bob)
		if stageOf(room).Blanked {
			t.Fatal("blank survived a takeover")
		}
	})

	t.Run("publisher is superseded", func(t *testing.T) {
		hub := NewHub(discard())
		room, alice, _ := hub.Join("r1", "a", "alice")
		room.TakeStage(alice)
		room.SetBlank(alice, true)
		// The same identity joining again replaces the old connection.
		hub.Join("r1", "a", "alice")
		if stageOf(room).Blanked {
			t.Fatal("blank survived a supersede")
		}
	})
}
