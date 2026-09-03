package relay

import (
	"bytes"
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

// TestClipBufferKeyframeBoundary: the cached GOP starts at a keyframe and the
// span between first and last cached chunks stays bounded after many seconds
// of stream time (since only the latest GOP survives).
func TestClipBufferKeyframeBoundary(t *testing.T) {
	hub := NewHub(discard())
	room, alice, _ := hub.Join("r1", "a", "alice")
	room.TakeStage(alice)
	start := time.Now()
	// 40 seconds, keyframe every 5s, small payloads.
	for s := 0; s < 40; s++ {
		isKF := s%5 == 0
		msg := make([]byte, protocol.HeaderSize+64)
		msg[0] = protocol.KindVideo
		if isKF {
			msg[1] = protocol.FlagKeyframe
		}
		// temporal id 0
		ts := start.Add(time.Duration(s) * time.Second).UnixMicro()
		// header v2: timestamp lives at [6:14]
		msg[6] = byte(ts >> 56)
		msg[7] = byte(ts >> 48)
		msg[8] = byte(ts >> 40)
		msg[9] = byte(ts >> 32)
		msg[10] = byte(ts >> 24)
		msg[11] = byte(ts >> 16)
		msg[12] = byte(ts >> 8)
		msg[13] = byte(ts)
		room.ForwardMedia(alice, msg)
	}
	if len(room.slots[0].gop) == 0 {
		t.Fatal("empty GOP cache")
	}
	first, err := protocol.ParseMediaHeader(room.slots[0].gop[0])
	if err != nil {
		t.Fatalf("bad header: %v", err)
	}
	if !first.Keyframe() {
		t.Fatalf("first cached chunk not keyframe")
	}
	last, _ := protocol.ParseMediaHeader(room.slots[0].gop[len(room.slots[0].gop)-1])
	span := time.Duration(int64(last.Timestamp-first.Timestamp)) * time.Microsecond
	if span > 12*time.Second {
		t.Fatalf("span too large: %v", span)
	}
	// Bytes bound: single GOP should be well under cap.
	if room.slots[0].gopBytes <= 0 || room.slots[0].gopBytes > maxGOPBytes {
		t.Fatalf("gopBytes out of bounds: %d", room.slots[0].gopBytes)
	}
	// Chunks are contiguous in time and all video.
	for i, b := range room.slots[0].gop {
		h, err := protocol.ParseMediaHeader(b)
		if err != nil {
			t.Fatalf("parse %d: %v", i, err)
		}
		if h.Kind != protocol.KindVideo {
			t.Fatalf("non-video in GOP at %d", i)
		}
	}
	_ = bytes.MinRead // silence unused import on old Go
}
