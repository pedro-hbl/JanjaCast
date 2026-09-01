package relay

import (
	"sync"
	"testing"
	"time"

	"github.com/pedro-hbl/janjacast/internal/protocol"
)

func TestLateJoinerGetsGOPReplay(t *testing.T) {
	hub := NewHub(discard())
	room, alice, _ := hub.Join("r1", "a", "alice")
	room.TakeStage(alice)
	room.ForwardMedia(alice, mediaMsg(true))  // keyframe
	room.ForwardMedia(alice, mediaMsg(false)) // delta
	room.ForwardMedia(alice, mediaMsg(false)) // delta

	_, bob, bobOut := hub.Join("r1", "b", "bob")
	hub.Leave(room, bob)

	var media int
	for _, m := range collect(bobOut) {
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
	room, alice, _ := hub.Join("r1", "a", "alice")
	room.TakeStage(alice)
	room.ForwardMedia(alice, mediaMsg(true))
	room.ForwardMedia(alice, mediaMsg(false))
	room.ForwardMedia(alice, mediaMsg(true)) // new GOP starts here

	_, bob, bobOut := hub.Join("r1", "b", "bob")
	hub.Leave(room, bob)

	var media int
	for _, m := range collect(bobOut) {
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
	room, alice, _ := hub.Join("r1", "a", "alice")
	room.TakeStage(alice)

	audio := make([]byte, protocol.HeaderSize)
	audio[0] = protocol.KindAudio
	room.ForwardMedia(alice, audio)

	_, bob, bobOut := hub.Join("r1", "b", "bob")
	hub.Leave(room, bob)

	for _, m := range collect(bobOut) {
		if m.Binary() {
			t.Fatal("audio chunk was replayed to late joiner")
		}
	}
}

// TestTruncatedGOPReplayKeepsNeedKeyframe: a GOP longer than the send buffer
// must leave the joiner waiting for the next keyframe rather than feeding a
// keyframe with a delta gap into its decoder.
func TestTruncatedGOPReplayKeepsNeedKeyframe(t *testing.T) {
	hub := NewHub(discard())
	room, alice, _ := hub.Join("r1", "a", "alice")
	room.TakeStage(alice)
	room.ForwardMedia(alice, mediaMsg(true))
	for i := 0; i < sendBuffer+50; i++ { // overflow any fresh queue
		room.ForwardMedia(alice, mediaMsg(false))
	}

	_, bob, bobOut := hub.Join("r1", "b", "bob")

	// Drain live, as the real write loop does — the truncated replay has
	// filled the queue and the follow-up keyframe needs room.
	var mu sync.Mutex
	var got []OutMsg
	drained := make(chan struct{})
	go func() {
		bobOut(func(m OutMsg) bool {
			mu.Lock()
			got = append(got, m)
			mu.Unlock()
			return true
		})
		close(drained)
	}()

	// A live delta after the truncated replay must NOT be delivered...
	delta := mediaMsg(false)
	delta[protocol.HeaderSize] = 0xAB // marker byte in payload
	room.ForwardMedia(alice, delta)
	// ...but a keyframe resumes delivery. Retry while the queue drains.
	key := mediaMsg(true)
	key[protocol.HeaderSize] = 0xCD
	for range 100 {
		room.ForwardMedia(alice, key)
		time.Sleep(time.Millisecond)
	}
	hub.Leave(room, bob)
	<-drained

	sawMarkedDelta, sawMarkedKey := false, false
	mu.Lock()
	defer mu.Unlock()
	for _, m := range got {
		if !m.Binary() || len(m.Payload()) <= protocol.HeaderSize {
			continue
		}
		switch m.Payload()[protocol.HeaderSize] {
		case 0xAB:
			sawMarkedDelta = true
		case 0xCD:
			sawMarkedKey = true
		}
	}
	if sawMarkedDelta {
		t.Fatal("delta delivered after truncated GOP replay (decoder gap)")
	}
	if !sawMarkedKey {
		t.Fatal("keyframe after truncated replay was not delivered")
	}
}
