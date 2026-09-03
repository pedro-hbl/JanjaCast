// Package protocol defines the wire format spoken between the janjacast client
// and the relay server over a single WebSocket connection.
//
// Every WebSocket message is either:
//
//   - a text message: a JSON control envelope (join, stage requests, codec
//     config, stats), or
//
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
	// CtrlClip asks the relay to cut an instant clip from the rolling buffer.
	// No payload.
	CtrlClip ControlType = "clip_request"
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

  // Captions (legenda) — collaborative live text under the video band.
  // Client -> server submits and toggles; server -> clients broadcasts.
  CtrlCaptionSubmit ControlType = "caption_submit"
  CtrlCaptionToggle ControlType = "caption_toggle"

  // --- the stage queue ("pedir a vez") -----------------------------
	// Identity always comes from the authenticated connection, never the
	// payload — exactly like CtrlStingerPlay.

	// CtrlStageRequest joins the line. No payload.
	CtrlStageRequest ControlType = "stage_request"
	// CtrlStageWithdraw leaves the line again. No payload.
	CtrlStageWithdraw ControlType = "stage_withdraw"
	// CtrlStagePass is the publisher handing the stage on: the relay pops
	// the queue head (or, in rodízio mode with an empty line, spins for a
	// random member), announces the turn, and frees the stage. No payload.
	CtrlStagePass ControlType = "stage_pass"
	// CtrlStageMode switches the room between "livre" and "rodízio" — see
	// StageModeData. Any member may flip it; it is room-wide.
	CtrlStageMode ControlType = "stage_mode"
	// CtrlStageExtend spends the publisher's one +5 minutes. No payload.
	CtrlStageExtend ControlType = "stage_extend"

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

	// CtrlClipReady is a unicast reply to the requester with a relay-origin
	// URL to download and the absolute expiry timestamp (Unix ms).
	CtrlClipReady ControlType = "clip_ready"

	// Server -> every room client: the stage queue plus the rodízio clock,
	// in ONE message. One state broadcast rather than three keeps every
	// client's answer to "who is next" consistent by construction.
	CtrlStageQueue ControlType = "stage_queue"
	// CtrlStageTurn is the "é tua!" moment: one person has a short window
	// to claim the stage, and the whole room hears about it.
	CtrlStageTurn ControlType = "stage_turn"
	// CtrlStageCancel ends a pending turn, saying why.
	CtrlStageCancel ControlType = "stage_cancel"
	// placar (scoreboard)
	CtrlPlacarCreate ControlType = "placar_create"
	CtrlPlacarVote   ControlType = "placar_vote"
	CtrlPlacarClose  ControlType = "placar_close"
  CtrlPlacarState  ControlType = "placar_state"

  // Captions server -> clients.
  CtrlCaptionBroadcast ControlType = "caption_broadcast"
  CtrlCaptionState     ControlType = "caption_state"
  CtrlCaptionClear     ControlType = "caption_clear"
)

// --- reactions -------------------------------------------------------------
// Client -> server: a single reaction tap from a member.
// Relay -> clients: an aggregated burst sampled over a short window.
const (
	CtrlReaction      ControlType = "reaction"
	CtrlReactionBurst ControlType = "reaction_burst"
	// CtrlRoomPhase announces a lobby<->live transition to every client.
	CtrlRoomPhase ControlType = "room_phase"
	// Server -> every room client: an end-of-session awards page is ready.
	// Carries a session-scoped id the server serves under /awards/{id}.
	CtrlAwardsReady ControlType = "awards_ready"
)

// Control is the JSON envelope for text messages.
type Control struct {
	Type ControlType     `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

// ClipReadyData is the payload of CtrlClipReady.
type ClipReadyData struct {
	URL       string `json:"url"`
	ExpiresMs int64  `json:"expiresMs"`
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
	VideoCodec  string `json:"videoCodec"` // e.g. "avc1.42E01F" or "vp8"
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	Framerate   int    `json:"framerate"`            // 30 or 60
	AudioCodec  string `json:"audioCodec,omitempty"` // e.g. "opus"
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
	// Phase is the overall room phase: "lobby" when nobody is publishing,
	// "live" when there is an active publisher. It rides CtrlWelcome so a
	// late joiner never guesses.
	Phase string `json:"phase,omitempty"`
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

// AwardsReadyData is the payload of CtrlAwardsReady: a short id (UUID or
// similar) under which the server serves a screenshot-friendly HTML page with
// auto-assigned session superlatives. The page itself is server-rendered and
// language-switched from ?lang=; the Activity only needs the id.
type AwardsReadyData struct {
	SessionID string `json:"sessionId"`
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

// ErrorData is the payload of CtrlError. Message is developer-facing English
// (docs/i18n.md § "What is deliberately not localized"); Code, when set, is a
// stable identifier the client maps onto its own translated string.
type ErrorData struct {
  Message string `json:"message,omitempty"`
  Code    string `json:"code,omitempty"`
}

// Error codes carried by ErrorData.Code. Each has a matching `err.<code>`
// key in web/src/i18n.ts, in both dictionaries.
const (
  ErrNoNextUser  = "stage.noNext"   // nobody in line and nobody to spin for
  ErrAlreadyExt  = "stage.extended" // the one +5 minutes is already spent
  ErrPassTooSoon = "stage.cooldown" // passing again inside the cooldown
  // Captions
  ErrCaptionRate   = "caption.rateLimit"
  ErrCaptionOff    = "caption.off"
)

// Captions wire shapes.
type CaptionSubmitData struct {
  Text string `json:"text"`
}
type CaptionToggleData struct {
  Enabled bool `json:"enabled"`
}
type CaptionBroadcastData struct {
  Text      string `json:"text"`
  Author    string `json:"author"`
  UserID    string `json:"user_id"`
  Timestamp int64  `json:"timestamp"`
}
type CaptionStateData struct {
  Enabled bool `json:"enabled"`
}

// --- cinema mode (pause + shared doodles) -----------------------------------

// Client -> server controls.
const (
	CtrlCinemaPause  ControlType = "cinema_pause"
	CtrlCinemaResume ControlType = "cinema_resume"
	CtrlCinemaStroke ControlType = "cinema_stroke"
)

// Server -> client controls.
const (
	CtrlCinemaState     ControlType = "cinema_state"
	CtrlCinemaStrokeAdd ControlType = "cinema_stroke_add"
)

// Point is one 0..1 normalized point.
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// CinemaStrokeData is the client->server payload to add a stroke.
type CinemaStrokeData struct {
	Color  string  `json:"color"`
	Points []Point `json:"points"`
}

// StrokeData is broadcast to all clients when a stroke is accepted.
type StrokeData struct {
	UserID   string  `json:"userId"`
	Color    string  `json:"color"`
	Points   []Point `json:"points"`
	StrokeID string  `json:"strokeId"`
}

// CinemaStateData is the room-wide cinema state snapshot.
type CinemaStateData struct {
	Paused  bool         `json:"paused"`
	Strokes []StrokeData `json:"strokes"`
}

// Cinema error codes mapped to translated strings client-side.
const (
	ErrCinemaNotPublisher = "cinema.notPublisher"
	ErrCinemaRateLimited  = "cinema.rateLimited"
	ErrCinemaBadStroke    = "cinema.badStroke"
)

// Placar wire shapes.
type PlacarCreateData struct {
	Prompt string `json:"prompt"`
}
type PlacarVoteData struct {
	TargetUserID string `json:"targetUserId"`
	Delta        int    `json:"delta"`
}
type PlacarStateData struct {
	Active bool           `json:"active"`
	Prompt string         `json:"prompt"`
	Scores map[string]int `json:"scores"`
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

// --- reactions -----------------------------------------------------------------
// (definitions appear earlier in this file)

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

// --- the stage queue -------------------------------------------------------

// Stage queue modes, the value of StageModeData.Mode and StageQueueData.Mode.
//
// Livre is the default and the zero value: the line exists, the sharer hands
// it on whenever they feel like it. Rodizio adds a clock — the sharer is
// prompted when their twenty minutes are up, and passing with an empty line
// spins for a random member instead of refusing.
const (
	ModeLivre   = "livre"
	ModeRodizio = "rodizio"
)

// Reasons carried by StageCancelData.Reason.
const (
	CancelTimeout      = "timeout"       // the turn's window elapsed
	CancelLeft         = "left"          // the chosen person disconnected
	CancelAccepted     = "accepted"      // they took the stage — the happy path
	CancelStageChanged = "stage_changed" // somebody else grabbed the stage
)

// How the next person was chosen, carried by StageTurnData.Method.
const (
	MethodQueue = "queue" // popped off the visible line
	MethodWheel = "wheel" // rodízio spin: nobody had asked
)

// QueueEntry is one person waiting for the stage. InitialsEmoji is computed
// once at enqueue so every client draws the same chip.
type QueueEntry struct {
	UserID        string `json:"userId"`
	Username      string `json:"username"`
	InitialsEmoji string `json:"initialsEmoji"`
}

// StageQueueData is the payload of CtrlStageQueue: everything about "who is
// next", in one message.
//
// TimerStartMs / TurnLenMs are the rodízio clock as SERVER wall time (Unix
// ms), so a client with a skewed clock renders a wrong countdown rather than
// getting a different answer than the room. TurnLenMs already includes the
// +5 minutes once Extended is true — the client never repeats that maths.
type StageQueueData struct {
	Queue []QueueEntry `json:"queue"`
	Mode  string       `json:"mode"` // ModeLivre | ModeRodizio

	TimerStartMs int64 `json:"timerStartMs,omitempty"` // 0 = stage is free
	TurnLenMs    int   `json:"turnLenMs"`
	Extended     bool  `json:"extended,omitempty"`

	// The pending turn, so a late joiner renders it without hearing the
	// cue that CtrlStageTurn carries.
	TurnUserID string `json:"turnUserId,omitempty"`
	TurnEndsMs int64  `json:"turnEndsMs,omitempty"`
}

// StageModeData is the payload of CtrlStageMode.
type StageModeData struct {
	Mode string `json:"mode"` // ModeLivre | ModeRodizio
}

// StageTurnData is the payload of CtrlStageTurn: it is UserID's turn, they
// have TTLMs to claim the stage, and Method says how they were picked (a
// wheel pick is the one the client animates).
type StageTurnData struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
	TTLMs    int    `json:"ttlMs"`
	Method   string `json:"method"`
}

// StageCancelData is the payload of CtrlStageCancel.
type StageCancelData struct {
	UserID string `json:"userId"`
	Reason string `json:"reason"`
}

// MarshalControl encodes a control envelope with its payload.
func MarshalControl(t ControlType, data any) ([]byte, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Control{Type: t, Data: raw})
}

// --- reactions -----------------------------------------------------------------

// ReactionEmojis is the curated fixed set of allowed reaction identifiers.
var ReactionEmojis = []string{"fire", "laugh", "heart", "skull", "clap", "shock"}

// ValidReactionEmoji reports whether s is one of ReactionEmojis.
func ValidReactionEmoji(s string) bool {
	for _, e := range ReactionEmojis {
		if s == e {
			return true
		}
	}
	return false
}

// ReactionData is the payload of CtrlReaction (client -> relay).
type ReactionData struct {
	Emoji string `json:"emoji"`
}

// ReactionBurstData is the payload of CtrlReactionBurst (relay -> clients).
// Counts carries per-emoji totals within the server's sliding window.
// Density is the total reactions observed in-window; WindowMs states the
// server's window size so a client can scale its UI consistently.
type ReactionBurstData struct {
	Counts   map[string]int `json:"counts"`
	Density  int            `json:"density"`
	WindowMs int            `json:"windowMs"`
}
