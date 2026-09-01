// Package protocol defines the wire format spoken between the golive client
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
//     offset 2  uint8   reserved
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
	Kind      uint8
	Flags     uint8
	Sequence  uint16
	Timestamp uint64 // microseconds
}

// Keyframe reports whether the chunk is decodable without prior chunks.
func (h MediaHeader) Keyframe() bool { return h.Flags&FlagKeyframe != 0 }

// ParseMediaHeader reads the fixed header from a binary media message.
func ParseMediaHeader(msg []byte) (MediaHeader, error) {
	if len(msg) < HeaderSize {
		return MediaHeader{}, fmt.Errorf("media message too short: %d bytes", len(msg))
	}
	return MediaHeader{
		Kind:      msg[0],
		Flags:     msg[1],
		Sequence:  binary.BigEndian.Uint16(msg[3:5]),
		Timestamp: binary.BigEndian.Uint64(msg[5:13]),
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

	// Server -> client.
	CtrlWelcome    ControlType = "welcome"     // join accepted, current room state
	CtrlStageState ControlType = "stage_state" // publisher changed / config changed
	CtrlRoomState  ControlType = "room_state"  // participant list changed
	CtrlError      ControlType = "error"
)

// Control is the JSON envelope for text messages.
type Control struct {
	Type ControlType     `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

// JoinData is the payload of CtrlJoin.
type JoinData struct {
	Room     string `json:"room"`     // Discord activity instance id
	UserID   string `json:"userId"`   // Discord user id
	Username string `json:"username"` // display name
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

// MarshalControl encodes a control envelope with its payload.
func MarshalControl(t ControlType, data any) ([]byte, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Control{Type: t, Data: raw})
}
