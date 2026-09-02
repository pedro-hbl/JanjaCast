// Package protocol defines the wire format spoken between the janjacast client
// and the relay server over a single WebSocket connection.
//
// Every WebSocket message is either:
//
//   - a text message: a JSON control envelope (join, stage requests, codec
//     config, stats), or
//   - a binary message: one encoded media chunk with a fixed 13-byte header:
//
//     offset 0  uint8   kind      (1 = video, 2 = audio)
//     offset 1  uint8   flags     (bit 0: keyframe)
//     offset 2  uint8   temporal layer id (0 = base; SVC L1T2/L1T3)
//     offset 3  uint16  sequence  (big endian, wraps)
//     offset 5  uint64  timestamp (big endian, microseconds)
//     offset 13 ...     encoded chunk payload (H.264/VP8/Opus bitstream)
//
// The relay never parses payloads; it forwards them. Only the header is read
// (to let the relay drop non-keyframe video when a slow viewer falls behind).
package protocol

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
)

// Media kinds carried in binary messages.
const (
	KindVideo uint8 = 1
	KindAudio uint8 = 2
)

// Header flags.
const (
	FlagKeyframe uint8 = 1 << 0
)

// HeaderSize is the fixed size of the binary media header in bytes.
const HeaderSize = 13

// MediaHeader is the parsed fixed header of a binary media message.
type MediaHeader struct {
	Kind       uint8
	Flags      uint8
	TemporalID uint8 // SVC temporal layer; 0 = base layer (always kept)
	Sequence   uint16
	Timestamp  uint64 // microseconds
}

// Keyframe reports whether the chunk is decodable without prior chunks.
func (h MediaHeader) Keyframe() bool { return h.Flags&FlagKeyframe != 0 }

// ParseMediaHeader reads the fixed header from a binary media message.
// Unknown media kinds are rejected so the relay never amplifies arbitrary
// payloads.
func ParseMediaHeader(msg []byte) (MediaHeader, error) {
	if len(msg) < HeaderSize {
		return MediaHeader{}, fmt.Errorf("media message too short: %d bytes", len(msg))
	}
	if msg[0] != KindVideo && msg[0] != KindAudio {
		return MediaHeader{}, fmt.Errorf("unknown media kind %d", msg[0])
	}
	return MediaHeader{
		Kind:       msg[0],
		Flags:      msg[1],
		TemporalID: msg[2],
		Sequence:   binary.BigEndian.Uint16(msg[3:5]),
		Timestamp:  binary.BigEndian.Uint64(msg[5:13]),
	}, nil
}

// ControlType enumerates JSON control message types.
type ControlType string

const (
	// Client -> server.
	CtrlJoin       ControlType = "join"        // enter a room as viewer
	CtrlTakeStage  ControlType = "take_stage"  // become the publisher
	CtrlLeaveStage ControlType = "leave_stage" // stop publishing
	CtrlConfig     ControlType = "config"      // publisher announces codec config
	CtrlPing       ControlType = "ping"        // clock sync probe
	// CtrlKeyframeRequest asks the publisher for an immediate keyframe —
	// sent by viewers stuck waiting (late join with no cache, drop-to-live)
	// and by the relay itself when it starts dropping a viewer's video.
	// Debounced per room server-side.
	CtrlKeyframeRequest ControlType = "keyframe_request"
	// CtrlStingerPlay asks the server to play a stinger at the whole room
	// right now — any authenticated member may fire one. The server
	// validates the names against the asset store, applies a per-client
	// cooldown, and broadcasts an ordinary CtrlStinger, so the client's
	// existing overlay needs no new machinery.
	CtrlStingerPlay ControlType = "stinger_play"
	// CtrlBlank is the privacy panic button: the publisher telling the relay
	// to hide the stream right now. Honored from the current publisher only.
	// The publisher has already stopped encoding by the time this arrives —
	// this engages the relay's own independent gates (fan-out drop + GOP
	// eviction), so a leaked frame would have to defeat both sides.
	CtrlBlank ControlType = "blank"

	// Server -> client.
	CtrlWelcome      ControlType = "welcome"       // join accepted, current room state
	CtrlStageState   ControlType = "stage_state"   // publisher changed / config changed
	CtrlRoomState    ControlType = "room_state"    // participant list changed
	CtrlPong         ControlType = "pong"          // ping reply with server time
	CtrlTokenRefresh ControlType = "token_refresh" // fresh share token for reconnects
	CtrlError        ControlType = "error"
	// CtrlBlankState is the room-wide blank signal: viewers render the
	// "back in a sec" card instead of video. Late joiners learn the same
	// thing from StageStateData.Blanked inside CtrlWelcome, so this is the
	// *live* edge only — never the only source of truth.
	CtrlBlankState ControlType = "blank_state"

	// Publisher -> server -> viewers (forwarded verbatim).
	CtrlSync ControlType = "sync" // maps capture timestamps to wall clock

	// Server -> displaced publisher.
	CtrlStageTaken ControlType = "stage_taken" // someone took your stage

	// Server -> replaced connection: the same identity joined again
	// (newest wins). Terminal — the receiver must NOT reconnect, or the
	// two sessions would kick each other forever.
	CtrlSuperseded ControlType = "superseded"

	// Server -> publisher: congestion feedback from the fan-out side. The
	// publisher's uplink signal (bufferedAmount) cannot see relay->viewer
	// pressure; this closes that loop.
	CtrlRateHint ControlType = "rate_hint"

	// Server -> every room client: play a stinger (a short image animation
	// plus a sound) marking a stream starting or stopping. The server picks
	// the random pair so every participant sees and hears the same one.
	CtrlStinger ControlType = "stinger"
)

// Control is the JSON envelope for text messages.
type Control struct {
	Type ControlType     `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

// JoinData is the payload of CtrlJoin. Exactly one credential is expected
// unless the server runs with anonymous access (local dev): AccessToken is a
// Discord OAuth token (verified against Discord), ShareToken is a janjacast
// HMAC token minted for a companion capture tab.
type JoinData struct {
	Room        string `json:"room"`     // Discord activity instance id
	UserID      string `json:"userId"`   // Discord user id
	Username    string `json:"username"` // display name
	AccessToken string `json:"accessToken,omitempty"`
	ShareToken  string `json:"shareToken,omitempty"`
}

// PingData / PongData carry clock-sync probes. Times are milliseconds.
type PingData struct {
	T float64 `json:"t"` // client clock at send
}

// PongData is the server's reply to CtrlPing.
type PongData struct {
	T          float64 `json:"t"`          // echoed client time
	ServerTime float64 `json:"serverTime"` // server wall clock, Unix ms
}

// SyncData is broadcast by the publisher: "capture timestamp CaptureTs
// (microseconds) happened at server wall clock WallTs (Unix ms)". Viewers
// use it to compute glass-to-glass latency.
type SyncData struct {
	CaptureTs float64 `json:"captureTs"`
	WallTs    float64 `json:"wallTs"`
}

// ConfigData is the payload of CtrlConfig / part of CtrlStageState: the
// WebCodecs configuration viewers need to construct their decoders.
type ConfigData struct {
	VideoCodec  string `json:"videoCodec"`            // e.g. "avc1.42E01F" or "vp8"
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	Framerate   int    `json:"framerate"`             // 30 or 60
	AudioCodec  string `json:"audioCodec,omitempty"`  // e.g. "opus"
	SampleRate  int    `json:"sampleRate,omitempty"`
	Channels    int    `json:"channels,omitempty"`
	Description []byte `json:"description,omitempty"` // avcC extradata when applicable
}

// StageStateData is the payload of CtrlStageState.
type StageStateData struct {
	PublisherID   string      `json:"publisherId,omitempty"` // empty = stage free
	PublisherName string      `json:"publisherName,omitempty"`
	Config        *ConfigData `json:"config,omitempty"`
	// Blanked is the privacy panic state. It rides the ordinary stage
	// handshake so a late joiner learns it inside CtrlWelcome, before any
	// media could arrive (there is none — blanking evicts the GOP cache).
	Blanked bool `json:"blanked,omitempty"`
}

// BlankData is the payload of CtrlBlank (publisher -> relay) and
// CtrlBlankState (relay -> clients). One shape, both directions, so the
// panic toggle is a single concept on the wire.
type BlankData struct {
	On bool `json:"on"`
}

// WelcomeData is the payload of CtrlWelcome: the stage state plus the
// server-assigned identity of the joining client (authoritative after auth —
// a companion tab learns its real id here).
type WelcomeData struct {
	StageStateData
	SelfID string `json:"selfId"`
}

// RoomStateData is the payload of CtrlRoomState.
type RoomStateData struct {
	Participants []Participant `json:"participants"`
}

// Participant is one connected member of a room.
type Participant struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
}

// ErrorData is the payload of CtrlError.
type ErrorData struct {
	Message string `json:"message"`
}

// TokenRefreshData is the payload of CtrlTokenRefresh: a fresh share token
// the companion tab must use on its next reconnect, so long streams outlive
// the short token expiry.
type TokenRefreshData struct {
	ShareToken string `json:"shareToken"`
}

// StageTakenData is the payload of CtrlStageTaken, telling a displaced
// publisher who replaced them (so their UI can say so instead of silently
// reverting).
type StageTakenData struct {
	ByName string `json:"byName"`
}

// RateHintData is the payload of CtrlRateHint: how many viewers the relay is
// currently degrading (temporal-layer drops or keyframe waits) out of how
// many total. The publisher's ABR treats degraded>0 as congestion.
type RateHintData struct {
	Degraded int `json:"degraded"`
	Viewers  int `json:"viewers"`
}

// StingerData is the payload of CtrlStinger: which transition happened and
// the same-origin URLs (under /stingers/) of the image and sound every
// participant should play. Either URL may be empty if the stinger directory
// holds no file of that kind.
type StingerData struct {
	Kind  string `json:"kind"` // "start" | "stop" | "manual"
	Image string `json:"image,omitempty"`
	Audio string `json:"audio,omitempty"`
}

// StingerPlayData is the payload of CtrlStingerPlay: the asset BASE NAMES
// (not URLs) the sender wants played. Either may be empty — a picture with no
// sound, or the reverse. Random asks the server to choose from the enabled
// pool instead, which is what the panel's dice button sends.
type StingerPlayData struct {
	Image  string `json:"image,omitempty"`
	Audio  string `json:"audio,omitempty"`
	Random bool   `json:"random,omitempty"`
}

// MarshalControl encodes a control envelope with its payload.
func MarshalControl(t ControlType, data any) ([]byte, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Control{Type: t, Data: raw})
}
