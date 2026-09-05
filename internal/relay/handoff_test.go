package relay

import (
	"encoding/json"
	"testing"

	"github.com/pedro-hbl/janjacast/internal/protocol"
)

// ctrlType reads the "type" field off a queued control frame.
func ctrlType(t *testing.T, m OutMsg) protocol.ControlType {
	t.Helper()
	var env struct {
		Type protocol.ControlType `json:"type"`
	}
	if err := json.Unmarshal(m.Payload(), &env); err != nil {
		return ""
	}
	return env.Type
}

// A handoff gates every viewer on a keyframe (gateViewersLocked), so until one
// arrives they render nothing. Waiting for the new publisher's NATURAL
// keyframe means up to KEYFRAME_INTERVAL_US — four seconds of black for the
// whole room every time the stage changes hands. Announcing a config is the
// moment the new encoder exists, so that is where we ask it for an IDR.
func TestConfigAnnounceAsksPublisherForKeyframe(t *testing.T) {
	hub := NewHub(discard())
	room, alice, _ := hub.Join("r1", "a", "alice")
	room.TakeStage(alice)
	room.ForwardMedia(alice, mediaMsg(true))

	// Bob takes over and announces his encoder's config.
	_, bob, bobOut := hub.Join("r1", "b", "bob")
	room.TakeStage(bob)
	room.SetConfig(bob, &protocol.ConfigData{VideoCodec: "avc1.42e034", Width: 1280, Height: 720})
	hub.Leave(room, bob)

	var asks int
	for _, m := range collect(bobOut) {
		if m.Binary() {
			continue
		}
		if ctrlType(t, m) == protocol.CtrlKeyframeRequest {
			asks++
		}
	}
	if asks == 0 {
		t.Fatal("new publisher was never asked for a keyframe: the room stays black until its natural one")
	}
}

// The same ask must NOT fire while the room is blanked — the publisher is
// deliberately silent there and capture.ts forces its own IDR on unblank.
func TestConfigAnnounceSkipsKeyframeWhileBlanked(t *testing.T) {
	hub := NewHub(discard())
	room, alice, aliceOut := hub.Join("r1", "a", "alice")
	room.TakeStage(alice)
	room.SetBlank(alice, true)
	room.SetConfig(alice, &protocol.ConfigData{VideoCodec: "avc1.42e034", Width: 640, Height: 360})
	hub.Leave(room, alice)

	for _, m := range collect(aliceOut) {
		if m.Binary() {
			continue
		}
		if ctrlType(t, m) == protocol.CtrlKeyframeRequest {
			t.Fatal("asked a blanked publisher for a keyframe")
		}
	}
}
