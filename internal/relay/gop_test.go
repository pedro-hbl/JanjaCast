package relay

import (
	"testing"

	"github.com/pedro-hbl/janjacast/internal/protocol"
)

func TestLateJoinerGetsGOPReplay(t *testing.T) {
	hub := NewHub(discard())
	room := hub.Room("r1")

	alice, _ := room.Join("a", "alice")
	room.TakeStage(alice)
	room.ForwardMedia(alice, mediaMsg(true))  // keyframe
	room.ForwardMedia(alice, mediaMsg(false)) // delta
	room.ForwardMedia(alice, mediaMsg(false)) // delta

	bob, bobOut := room.Join("b", "bob")
	room.Leave(bob)

	var media int
	for m := range bobOut {
		if m.Binary() {
			media++
		}
	}
	if media != 3 {
		t.Fatalf("late joiner got %d cached chunks, want 3 (keyframe + 2 deltas)", media)
	}
}

func TestGOPResetsOnKeyframe(t *testing.T) {
	hub := NewHub(discard())
	room := hub.Room("r1")

	alice, _ := room.Join("a", "alice")
	room.TakeStage(alice)
	room.ForwardMedia(alice, mediaMsg(true))
	room.ForwardMedia(alice, mediaMsg(false))
	room.ForwardMedia(alice, mediaMsg(true)) // new GOP starts here

	bob, bobOut := room.Join("b", "bob")
	room.Leave(bob)

	var media int
	for m := range bobOut {
		if m.Binary() {
			media++
		}
	}
	if media != 1 {
		t.Fatalf("late joiner got %d cached chunks, want 1 (just the new keyframe)", media)
	}
}

func TestAudioNotCached(t *testing.T) {
	hub := NewHub(discard())
	room := hub.Room("r1")

	alice, _ := room.Join("a", "alice")
	room.TakeStage(alice)

	audio := make([]byte, protocol.HeaderSize)
	audio[0] = protocol.KindAudio
	room.ForwardMedia(alice, audio)

	bob, bobOut := room.Join("b", "bob")
	room.Leave(bob)

	for m := range bobOut {
		if m.Binary() {
			t.Fatal("audio chunk was replayed to late joiner")
		}
	}
}
