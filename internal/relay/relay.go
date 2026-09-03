// Package relay implements the fan-out core of JanjaCast: rooms keyed by
// Discord activity instance, each with at most one publisher whose media
// chunks are forwarded to every other participant.
//
// Lock discipline: Hub.mu is always acquired before Room.mu, never the
// reverse. Client.out is never closed — senders use non-blocking sends and
// the write loop exits via Client.done, so a racing broadcast can never hit
// a closed channel.
package relay

import (
	"encoding/json"
	"fmt"
	"iter"
	"log/slog"
	"math/rand/v2"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pedro-hbl/janjacast/internal/protocol"
)

// sendBuffer is the per-viewer outgoing queue length. When a viewer's queue
// overflows the relay drops video until the next keyframe rather than
// letting one slow consumer stall the room.
const sendBuffer = 256

// clientQueueBytes bounds the per-viewer queue by BYTES as well as slots. A
// realtime stream should never queue seconds of media: 256 slots of ~12KB
// chunks is >3MB (2-4s at 6Mbps) of invisible latency before backpressure
// fires. ~1.5MB ≈ 2s worst case, so temporal shedding reacts while the
// network is merely strained instead of after it has drowned.
const clientQueueBytes = 1_500_000

// maxGOPBytes bounds the late-join cache; past this the cache is dropped and
// joiners wait for the next keyframe like before.
const maxGOPBytes = 16 << 20

// stingerStopDelay is how long the stage must stay empty before the stop
// stinger fires. Reconnects and takeovers re-take the stage well within this
// window, so a network blip plays nothing instead of a stop/start pair.
const stingerStopDelay = 2 * time.Second

// --- the stage queue -------------------------------------------------------

// maxQueue caps the visible line. Five emoji chips fit beside the roster and
// five is already more waiting than any call sustains; a sixth request is
// silently ignored rather than answered with an error nobody can act on.
const maxQueue = 5

// turnTTL is how long the chosen person has to actually take the stage before
// the line moves on without them. Short on purpose: the whole room just heard
// "é tua!", and a stage nobody claims is worse than a stage that keeps moving.
const turnTTL = 20 * time.Second

// rodizioTurn is one sharer's slot in rodízio mode, and rodizioExtension is
// the single "+5 min" they may spend. Both are fixed — the only choice this
// feature exposes is livre vs rodízio (docs/design.md § 8, "settings creep").
const (
	rodizioTurn      = 20 * time.Minute
	rodizioExtension = 5 * time.Minute
)

// passCooldown keeps a jittery double-tap on "Passar a vez" from burning two
// people's turns. Per room, because passing is a room-wide event.
const passCooldown = 2 * time.Second

// fallbackEmoji stands in when a name does not start with a Latin letter, so
// every chip is exactly one glyph wide whoever is in the room.
const fallbackEmoji = "🟣"

// Hub owns all rooms.
type Hub struct {
	mu    sync.Mutex
	rooms map[string]*Room
	log   *slog.Logger

	// Stinger, when non-nil, picks the start/stop stinger every room client
	// should play (nil = feature disabled). Set once by the server layer
	// before the hub serves traffic. It is called while holding Room.mu, so
	// implementations MUST NOT touch relay state — a pure pick (directory
	// scan + random choice) only.
	Stinger func(kind string) *protocol.StingerData

	// StingerStopDelay overrides stingerStopDelay; tests shorten it so they
	// need not sleep multiple real seconds.
	StingerStopDelay time.Duration

	// TurnTTL overrides turnTTL for the same reason — a test for the
	// "nobody claimed it, move on" path must not sleep twenty seconds.
	TurnTTL time.Duration
}

// NewHub returns an empty hub.
func NewHub(log *slog.Logger) *Hub {
	return &Hub{
		rooms:            make(map[string]*Room),
		log:              log,
		StingerStopDelay: stingerStopDelay,
		TurnTTL:          turnTTL,
	}
}

// Join atomically finds-or-creates the room and adds a participant to it,
// replaying the cached GOP before the client becomes visible to the live
// fan-out (so cached chunks always precede live ones). It returns the room,
// the client handle, and the message sequence for the write loop.
func (h *Hub) Join(roomID, userID, username string) (*Room, *Client, iter.Seq[OutMsg]) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[roomID]
	if !ok {
		ttl := h.TurnTTL
		if ttl <= 0 {
			ttl = turnTTL
		}
		r = &Room{
			id:              roomID,
			clients:         make(map[*Client]struct{}),
			log:             h.log.With("room", roomID),
			stinger:         h.Stinger,
			stingerStopWait: h.StingerStopDelay,
			turnWait:        ttl,
			placarScores:    make(map[string]int),
			placarLastVote:  make(map[*Client]time.Time),
			clips:           make(map[string]clipItem),
			lastClipAsk:     make(map[*Client]time.Time),
			jukeboxLast:     make(map[string]time.Time),
		}
		h.rooms[roomID] = r
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	// Stats: create or update participant entry.
	if r.sessionStats == nil {
		r.sessionStats = make(map[string]*ParticipantStats)
	}
	if ps, ok := r.sessionStats[userID]; ok {
		ps.Disconnects++
		ps.Username = username
		ps.lastJoin = time.Now()
	} else {
		r.sessionStats[userID] = &ParticipantStats{UserID: userID, Username: username, FirstJoin: time.Now(), lastJoin: time.Now()}
	}

	// Session takeover, newest wins: the same identity joining again (a
	// restarted share, a reconnect racing its own half-open predecessor)
	// replaces the old connection instead of accumulating ghost roster
	// entries. The superseded control is terminal client-side, so an old
	// tab left open does not reconnect-fight the new one.
	for old := range r.clients {
		if old.UserID != userID {
			continue
		}
		old.enqueueControl(protocol.CtrlSuperseded, struct{}{})
		old.superseded = true
		delete(r.clients, old)
		old.closeOnce.Do(func() { close(old.done) })
		if r.publisher == old {
			r.publisher = nil
			r.config = nil
			r.clearGOPLocked()
			r.clearBlankLocked()
			r.gateViewersLocked()
			// The rodízio clock stops with the stage. The expected
			// immediate re-take starts a fresh twenty minutes, which is
			// the kind thing to do after a connection blip.
			r.stopRodizioClockLocked()
			r.broadcastStageQueueLocked()
			r.broadcastStageStateLocked()
			// Arm the delayed stop here too: the expected immediate re-take
			// cancels it silently, but an ABANDONED supersede (new session
			// never takes the stage) still gets its stop stinger — without
			// this, stingerLive would stay latched and mute future starts.
			r.scheduleStingerStopLocked()
		}
		r.log.Info("superseded", "user", username, "id", userID)
	}

	c := &Client{
		UserID:       userID,
		Username:     username,
		out:          make(chan outMsg, sendBuffer),
		done:         make(chan struct{}),
		needKeyframe: true, // must not decode deltas before a keyframe
		maxTL:        maxTemporalLayer,
	}

	c.enqueueControl(protocol.CtrlWelcome, protocol.WelcomeData{
		StageStateData: r.stageStateLocked(),
		SelfID:         c.UserID,
	})
	// Right behind the welcome, so a late joiner renders the mode, the
	// rodízio clock and the line immediately — including a turn already in
	// flight, which rides in this state message rather than as a second
	// CtrlStageTurn (that one carries the cue, and a joiner must not hear
	// a cue for a call that went out before they arrived).
	c.enqueueControl(protocol.CtrlStageQueue, r.stageQueueLocked())
	// Cinema welcome right after queue state.
	c.enqueueControl(protocol.CtrlCinemaState, protocol.CinemaStateData{Paused: r.cinemaPaused, Strokes: slices.Clone(r.cinemaStrokes)})
	// Jukebox initial empty state for probe.
	c.enqueueControl(protocol.CtrlJukeboxQueue, protocol.JukeboxQueueState{Queue: append([]protocol.JukeboxItem(nil), r.jukeboxQueue...)})

	// Replay the cached GOP so the newcomer has a picture immediately. If
	// the replay overflows the queue, the client stays in needKeyframe so a
	// truncated GOP is never fed to its decoder.
	replayed := true
	for _, msg := range r.gop {
		if !c.trySend(outMsg{binary: true, payload: msg}) {
			replayed = false
		}
	}
	if len(r.gop) > 0 && replayed {
		c.needKeyframe = false
	} else if r.publisher != nil {
		// No usable cache: get this joiner a picture as fast as possible.
		r.requestKeyframeLocked()
	}

	// Welcome placar state right after welcome + queue.
	c.enqueueControl(protocol.CtrlPlacarState, r.placarStateLocked())

	r.clients[c] = struct{}{}
	r.broadcastRoomStateLocked()
	r.log.Info("joined", "user", username, "id", userID)
	// The replay timeline: a join is a real room event. Bounded like the
	// probe path; caller already holds r.mu.
	if len(r.probeEvents) >= 200 {
		r.probeEvents = r.probeEvents[1:]
	}
	r.probeEvents = append(r.probeEvents, map[string]any{
		"type": "join", "user": username, "at": time.Now().UnixMilli(),
	})

	// The sequence drains queued messages before honoring done, so nothing
	// already accepted is dropped on the floor at disconnect.
	take := func(m OutMsg, yield func(OutMsg) bool) bool {
		c.queuedBytes.Add(-int64(len(m.payload)))
		return yield(m)
	}
	seq := func(yield func(OutMsg) bool) {
		for {
			select {
			case m := <-c.out:
				if !take(m, yield) {
					return
				}
			default:
				select {
				case m := <-c.out:
					if !take(m, yield) {
						return
					}
				case <-c.done:
					return
				}
			}
		}
	}
	return r, c, seq
}

// Leave atomically removes the participant, freeing the stage if it held it,
// and reaps the room when it empties.
func (h *Hub) Leave(r *Room, c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, ok := r.clients[c]; !ok {
		return
	}
	delete(r.clients, c)
	c.closeOnce.Do(func() { close(c.done) })

	var assembled []AwardData
	if r.publisher == c {
		r.publisher = nil
		r.config = nil
		r.clearGOPLocked()
		r.clearBlankLocked()
		r.stopRodizioClockLocked()
		// Assemble awards if the session qualifies (stats snapshot under lock).
		assembled = r.assembleAwardsLocked()
		r.broadcastStageStateLocked()
		r.scheduleStingerStopLocked()
	}
	// Fold watch time on disconnect.
	if ps, ok := r.sessionStats[c.UserID]; ok {
		if !ps.lastJoin.IsZero() {
			ps.TotalWatch += time.Since(ps.lastJoin)
		}
	}
	// A departing person never lingers in the line, and a turn called on
	// somebody who just closed their tab advances immediately instead of
	// burning its whole window on a ghost.
	r.removeFromQueueLocked(c.UserID)
	if r.turn != nil && r.turn.UserID == c.UserID {
		r.cancelTurnLocked(protocol.CancelLeft)
		r.advanceTurnLocked()
	}
	r.broadcastStageQueueLocked()
	r.broadcastRoomStateLocked()

	// Publish awards after leaving modifications if any.
	if assembled != nil {
		// fire callback if wired by server layer
		if rcb := rAwardsCallback; rcb != nil {
			// allocate id in server layer; here pass empty to be filled there
			rcb(r.id, assembled)
		}
		// also notify clients that awards are ready; session id supplied by server later
		for cl := range r.clients {
			cl.enqueueControl(protocol.CtrlAwardsReady, protocol.AwardsReadyData{SessionID: r.id})
		}
	}

	// Identity check: only reap the exact Room object registered under this
	// id, so a stale reference can never evict a live successor.
	if len(r.clients) == 0 && h.rooms[r.id] == r {
		delete(h.rooms, r.id)
	}
	r.log.Info("left", "user", c.Username)
}

// Rooms returns the number of live rooms (for health/metrics).
func (h *Hub) Rooms() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.rooms)
}

// Room is one activity instance: N participants, at most one publisher.
type Room struct {
	id  string
	log *slog.Logger

	mu        sync.Mutex
	clients   map[*Client]struct{}
	publisher *Client
	config    *protocol.ConfigData // last codec config announced by publisher

	// gop caches the current group of pictures — the last video keyframe and
	// every video chunk since — so late joiners render instantly instead of
	// waiting for the next keyframe. Guarded by mu.
	gop      [][]byte
	gopBytes int

	// blanked is the privacy panic state: while true the room forwards no
	// media at all and the GOP cache stays empty, so neither a live viewer
	// nor a late joiner can be handed a captured frame. It is per-room state
	// owned by the current publisher and cleared whenever the stage changes
	// hands, so a new stream never inherits a stale blank. Guarded by mu.
	blanked bool

	// lastKFReq debounces keyframe requests to the publisher. Guarded by mu.
	lastKFReq time.Time
	// lastHint paces rate-hint feedback to the publisher. Guarded by mu.
	lastHint time.Time

	// stinger and stingerStopWait are copied from the hub at room creation
	// (under Hub.mu) and never written again, so reads under mu are safe.
	stinger         func(kind string) *protocol.StingerData
	stingerStopWait time.Duration
	// stingerGen is bumped by every successful TakeStage; a pending delayed
	// stop compares its snapshot against it and no-ops when stale, which is
	// how a re-take within the stop window cancels the stop. Guarded by mu.
	stingerGen uint64
	// stingerLive is true between a fired start stinger and its matching
	// stop — i.e. "a stop stinger is pending or would be scheduled". While
	// true, TakeStage fires no start: it is the same stream continuing
	// (reconnect, takeover, supersede+retake). Guarded by mu.
	stingerLive bool

	// --- the stage queue ("pedir a vez"), all guarded by mu -----------

	// queue is the visible line, FIFO, at most maxQueue long and at most
	// one entry per person (by baseID: the Activity and its companion tab
	// are one person).
	queue []protocol.QueueEntry
	// mode is "" (livre) or protocol.ModeRodizio. Stored empty rather than
	// "livre" so a zero-value Room is already in the default mode.
	mode string
	// turn is the pending "é tua!", nil when nobody has been called.
	turn *stageTurn
	// turnGen invalidates a pending TTL timer the same way stingerGen
	// invalidates a pending stop stinger: the timer compares its snapshot
	// and no-ops when stale. Every cancel and every grant bumps it.
	turnGen uint64
	// turnWait is copied from the hub at room creation (under Hub.mu) and
	// never written again, so reads under mu are safe.
	turnWait time.Duration
	// rodizioStart is when the current publisher took the stage; zero when
	// the stage is free. Server time is the only clock — a client with a
	// skewed clock renders a wrong countdown, never a different answer.
	rodizioStart time.Time
	// rodizioExtended records the one +5 minutes, reset on every TakeStage.
	rodizioExtended bool
	// lastPass is the per-room pass cooldown stamp.
	lastPass time.Time

	// --- cinema (paused + shared strokes) ---------------------------------
	cinemaPaused  bool
	cinemaStrokes []protocol.StrokeData // FIFO cap 100

	// --- placar (scoreboard), guarded by mu --------------------------
	placarActive   bool
	placarPrompt   string
	placarScores   map[string]int
	placarLastVote map[*Client]time.Time

	// --- session stats for end-of-session awards (guarded by mu) ---------
	sessionStats map[string]*ParticipantStats

	// --- captions (guarded by mu) ---------------------------------------
	CaptionsEnabled bool
	CaptionLast     map[string]int64 // userId -> last submit ms

	// --- instant clips: rolling buffer (video+audio), keyframe-bounded ------
	// clipBuf stores recent media chunks for instant clips. It is trimmed on
	// keyframe boundaries and bounded by both wall-time (~30s) and bytes.
	clipBuf     [][]byte
	clipBytes   int
	clipStartTs int64 // microseconds of first chunk in clipBuf; 0 when empty
	// clip store: token -> bytes with expiry and content type. Guarded by mu.
	clips map[string]clipItem
	// sidecar events per clip token (served as JSON next to /clip/{token}).
	clipEvents map[string][]byte
	// per-client cooldown for clip requests.
	lastClipAsk map[*Client]time.Time

	// probe-only: recent synthetic room events to export as replay sidecar
	probeEvents []map[string]any

	// --- bolao (prediction), guarded by mu ---------------------------------
	boloes map[string]*bolaoState

	// --- chama (call to action), guarded by mu ------------------------------
	chamas map[string]*chamaState
	// --- captions (guarded by mu) ---------------------------------------
	captionsEnabled bool
	captionLast     map[string]int64 // userId -> last submit ms

	// --- jukebox (probe-limited): simple per-room queue of asset URLs ---
	jukeboxQueue []protocol.JukeboxItem
	// last request time per user base id
	jukeboxLast map[string]time.Time
}

// rAwardsCallback is installed by the server layer to receive assembled
// awards for a finished session. Stored at package scope; invoked outside
// locks.
var rAwardsCallback func(roomID string, awards []AwardData)

// ParticipantStats accumulates per-participant counters for a live session.
type ParticipantStats struct {
	UserID       string
	Username     string
	FirstJoin    time.Time
	lastJoin     time.Time
	TotalWatch   time.Duration
	StingerPlays int
	Disconnects  int
}

// Mu exposes the hub mutex for read-only traversal by the server layer.
// Only the server uses it to locate a room; all room state access must still
// go through Room.mu. Keeping the lock-order invariant: Hub.mu before Room.mu.
func (h *Hub) Mu() *sync.Mutex { return &h.mu }

// RoomsUnsafe returns a snapshot of rooms map pointer for read-only scan
// under Hub.mu. Do not hold the pointer beyond Hub.mu.
func (h *Hub) RoomsUnsafe() map[string]*Room { return h.rooms }

type clipItem struct {
	data      []byte
	mime      string
	expiresAt time.Time
}

type bolaoState struct {
	id     string
	prompt string
	open   bool
	yes    int
	no     int
	result string
}

type chamaState struct {
	id     string
	text   string
	active bool
	acks   int
}

// --- bolao API --------------------------------------------------------------

func (r *Room) BolaoStart(c *Client, id, prompt string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return
	}
	if strings.TrimSpace(id) == "" || strings.TrimSpace(prompt) == "" {
		return
	}
	if r.boloes == nil {
		r.boloes = make(map[string]*bolaoState)
	}
	s := &bolaoState{id: id, prompt: prompt, open: true}
	r.boloes[id] = s
	r.broadcastBolaoLocked(s)
}

func (r *Room) BolaoVote(c *Client, id, vote string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return
	}
	if r.boloes == nil {
		return
	}
	s := r.boloes[id]
	if s == nil || !s.open {
		return
	}
	switch vote {
	case "yes":
		s.yes++
	case "no":
		s.no++
	default:
		return
	}
	if len(r.probeEvents) >= 200 {
		r.probeEvents = r.probeEvents[1:]
	}
	r.probeEvents = append(r.probeEvents, map[string]any{"type": "activity", "at": time.Now().UnixMilli()})
	r.broadcastBolaoLocked(s)
}

func (r *Room) BolaoResolve(c *Client, id, result string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return
	}
	if r.boloes == nil {
		return
	}
	s := r.boloes[id]
	if s == nil || !s.open {
		return
	}
	if result != "yes" && result != "no" {
		return
	}
	s.open = false
	s.result = result
	r.broadcastBolaoLocked(s)
}

func (r *Room) broadcastBolaoLocked(s *bolaoState) {
	d := protocol.BolaoStateData{ID: s.id, Prompt: s.prompt, Open: s.open, Yes: s.yes, No: s.no, Result: s.result}
	for c := range r.clients {
		c.enqueueControl(protocol.CtrlBolaoState, d)
	}
}

// --- chama API --------------------------------------------------------------

func (r *Room) ChamaStart(c *Client, id, text string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return
	}
	if strings.TrimSpace(id) == "" || strings.TrimSpace(text) == "" {
		return
	}
	if r.chamas == nil {
		r.chamas = make(map[string]*chamaState)
	}
	s := &chamaState{id: id, text: text, active: true}
	r.chamas[id] = s
	r.broadcastChamaLocked(s)
}

func (r *Room) ChamaAck(c *Client, id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return
	}
	if r.chamas == nil {
		return
	}
	s := r.chamas[id]
	if s == nil || !s.active {
		return
	}
	s.acks++
	r.broadcastChamaLocked(s)
}

func (r *Room) ChamaEnd(c *Client, id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return
	}
	if r.chamas == nil {
		return
	}
	s := r.chamas[id]
	if s == nil || !s.active {
		return
	}
	s.active = false
	r.broadcastChamaLocked(s)
}

func (r *Room) broadcastChamaLocked(s *chamaState) {
	d := protocol.ChamaStateData{ID: s.id, Text: s.text, Active: s.active, Acks: s.acks}
	for c := range r.clients {
		c.enqueueControl(protocol.CtrlChamaState, d)
	}
}

// ClipsTestInit ensures clip maps exist (test helper).
func (r *Room) ClipsTestInit() *Room {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.clips == nil {
		r.clips = make(map[string]clipItem)
	}
	if r.lastClipAsk == nil {
		r.lastClipAsk = make(map[*Client]time.Time)
	}
	if r.captionLast == nil {
		r.captionLast = make(map[string]int64)
	}
	return r
}

// ToggleCaptions flips the room captions enabled state. Publisher-only.
func (r *Room) ToggleCaptions(c *Client, enabled bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.publisher == nil || baseID(r.publisher.UserID) != baseID(c.UserID) {
		return
	}
	if _, ok := r.clients[c]; !ok {
		return
	}
	r.captionsEnabled = enabled
	// Broadcast to all clients
	d := protocol.CaptionStateData{Enabled: enabled}
	for cl := range r.clients {
		cl.enqueueControl(protocol.CtrlCaptionState, d)
	}
}

// SubmitCaption enforces cooldown/length and broadcasts a sanitized caption.
func (r *Room) SubmitCaption(c *Client, text string, nowMs int64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return false
	}
	if !r.captionsEnabled {
		c.enqueueControl(protocol.CtrlError, protocol.ErrorData{Code: protocol.ErrCaptionOff})
		return false
	}
	if r.captionLast == nil {
		r.captionLast = make(map[string]int64)
	}
	last := r.captionLast[baseID(c.UserID)]
	if nowMs-last < 4000 {
		c.enqueueControl(protocol.CtrlError, protocol.ErrorData{Code: protocol.ErrCaptionRate})
		return false
	}
	r.captionLast[baseID(c.UserID)] = nowMs
	// sanitize minimal HTML
	esc := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&#39;").Replace(text)
	d := protocol.CaptionBroadcastData{Text: esc, Author: c.Username, UserID: c.UserID, Timestamp: nowMs}
	for cl := range r.clients {
		cl.enqueueControl(protocol.CtrlCaptionBroadcast, d)
	}
	return true
}

// rTestMint is a test-only wrapper to call mintClipTokenLocked.
// roomTokenForTest exports token minting to tests in other packages.
// roomTokenTestShim is referenced by server tests; exported for cross-package tests only.
// RoomTokenTestShim exposes token minting for server tests.
func RoomTokenTestShim(r *Room, data []byte, mime string, ttl time.Duration) string {
	// Caller already under tests; take lock for safety
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.mintClipTokenLocked(data, mime, ttl)
}

// stageTurn is the person currently being called to the stage.
type stageTurn struct {
	UserID   string
	Username string
	Method   string // protocol.MethodQueue | protocol.MethodWheel
	Ends     time.Time
}

// maxTemporalLayer is the highest SVC temporal layer id (L1T3 → 0,1,2).
const maxTemporalLayer = 2

// tlRecoverAfter is how long a viewer must go without overflowing before the
// relay restores one temporal layer.
const tlRecoverAfter = 8 * time.Second

// rateHintInterval paces congestion feedback to the publisher.
const rateHintInterval = 2 * time.Second

// kfDebounce is the minimum gap between keyframe requests forwarded to a
// publisher. IDRs are the largest frames in the stream, so this must stay at
// or below the old fixed-cadence rate (0.5/s) — a struggling viewer asking
// for more IDRs than that is a positive-feedback congestion loop.
const kfDebounce = 2 * time.Second

// kfClientBudget bounds how often a single client's own keyframe_request
// messages are honored, so one hostile or buggy tab cannot pin the publisher
// at the room-wide debounce rate.
const kfClientBudget = 3 * time.Second

// stingerClientBudget bounds how often one client may fire a manual stinger
// at the whole room. Any member can press the button, so the only thing
// standing between a bored friend and a strobe light is this.
const stingerClientBudget = 3 * time.Second

// maxGOPChunks keeps the late-join cache small enough to replay into a
// fresh client queue (sendBuffer slots, minus room for control messages).
// A GOP that outgrows this is dropped; joiners fall back to
// keyframe-on-demand instead of receiving a truncated stale burst.
const maxGOPChunks = sendBuffer - 16

// Client is one connected WebSocket participant.
type Client struct {
	UserID   string
	Username string

	// out delivers messages to the connection write loop; it is buffered,
	// only ever sent to non-blockingly, and never closed.
	out chan outMsg
	// done is closed exactly once by Leave; the write loop exits on it.
	done      chan struct{}
	closeOnce sync.Once
	// needKeyframe marks that video was dropped and delta frames must be
	// suppressed until the next keyframe arrives. Guarded by Room.mu.
	needKeyframe bool
	// maxTL is the highest SVC temporal layer this viewer currently
	// receives. Congestion sheds layers (halving then quartering framerate)
	// before resorting to the needKeyframe freeze. Guarded by Room.mu.
	maxTL      uint8
	lastTLDrop time.Time
	// lastKFAsk budgets this client's own keyframe requests. Guarded by
	// Room.mu.
	lastKFAsk time.Time
	// lastStingerAsk budgets this client's own manual stinger triggers.
	// Guarded by Room.mu.
	lastStingerAsk time.Time
	// superseded records that this connection was replaced by a newer
	// session — the transport layer closes it with a distinct code so the
	// client treats even a lost in-band signal as terminal. Guarded by
	// Room.mu (of the room it was in when superseded).
	superseded bool
	// queuedBytes tracks bytes accepted into out but not yet handed to the
	// write loop — the byte half of the queue bound. Atomic: incremented
	// under Room.mu, decremented by the write-loop iterator without it.
	queuedBytes atomic.Int64
}

// WasSuperseded reports whether this client was replaced by a newer session.
// Read after the write loop ends; the happens-before edge is done closing.
func (c *Client) WasSuperseded() bool {
	return c.superseded
}

type outMsg struct {
	binary  bool
	payload []byte
}

// OutMsg is a message queued for a client's write loop.
type OutMsg = outMsg

// Binary reports whether the message must be sent as a binary frame.
func (m outMsg) Binary() bool { return m.binary }

// Payload is the raw message bytes.
func (m outMsg) Payload() []byte { return m.payload }

// TakeStage makes c the publisher, replacing any current one. A displaced
// publisher is told who took over so its UI can say so. Departed clients
// cannot claim the stage.
func (r *Room) TakeStage(c *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return // already left: a ghost must never hold the stage
	}
	if old := r.publisher; old != nil && old != c {
		old.enqueueControl(protocol.CtrlStageTaken, protocol.StageTakenData{ByName: c.Username})
	}
	r.publisher = c
	r.config = nil
	r.clearGOPLocked()
	// A new stream must never inherit the previous sharer's blank.
	r.clearBlankLocked()
	r.gateViewersLocked()
	r.broadcastStageStateLocked()
	r.stingerStartLocked()

	// The queue resolves against whoever actually ended up on the stage.
	// The person who was called takes it: that closes their turn happily.
	// Anybody else taking it mid-call is a takeover, so the call is voided
	// and the line restarts under the new publisher.
	if r.turn != nil {
		if baseID(r.turn.UserID) == baseID(c.UserID) {
			r.cancelTurnLocked(protocol.CancelAccepted)
		} else {
			r.cancelTurnLocked(protocol.CancelStageChanged)
			r.advanceTurnLocked()
		}
	}
	// Taking the stage leaves the line: you are not waiting for a thing
	// you are already doing.
	r.removeFromQueueLocked(c.UserID)
	r.rodizioStart = time.Now()
	r.rodizioExtended = false
	r.broadcastStageQueueLocked()
	r.log.Info("stage taken", "user", c.Username)
}

// SetBlank engages or lifts the privacy blank on behalf of the current
// publisher — the relay half of the panic button. Only the publisher may
// call it; a viewer's CtrlBlank is silently refused, because "hide the
// room" must never be reachable by anyone but the person whose screen it is.
//
// Engaging does three things beyond flipping the flag, and each one is an
// independent gate against a leaked frame:
//
//   - ForwardMedia returns early while blanked (stray chunks already in
//     flight from the publisher's socket are dropped here, not fanned);
//   - the GOP cache is evicted, so a client joining mid-blank has no stale
//     keyframe to replay;
//   - viewers go back behind the keyframe gate, so the first thing they can
//     decode after the blank lifts is a fresh IDR.
func (r *Room) SetBlank(c *Client, on bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.publisher != c {
		return // only the person on stage may hide the room
	}
	if _, ok := r.clients[c]; !ok {
		return // a departed client must not be able to latch a blank
	}
	if r.blanked == on {
		return
	}
	r.blanked = on
	if on {
		r.clearGOPLocked()
		r.gateViewersLocked()
	}
	r.broadcastBlankLocked()
	r.log.Info("blank", "on", on, "user", c.Username)
}

// clearBlankLocked lifts a blank because the stage changed hands (taken,
// left, superseded, disconnected). Without it a room could stay latched
// hidden and the next sharer would stream into a card nobody can dismiss.
// Caller must hold r.mu.
func (r *Room) clearBlankLocked() {
	if !r.blanked {
		return
	}
	r.blanked = false
	r.broadcastBlankLocked()
}

// broadcastBlankLocked fans the live blank edge out. The same state also
// rides stageStateLocked(), which is what makes late joiners correct.
// Caller must hold r.mu; all sends are non-blocking.
func (r *Room) broadcastBlankLocked() {
	d := protocol.BlankData{On: r.blanked}
	for c := range r.clients {
		c.enqueueControl(protocol.CtrlBlankState, d)
	}
}

// RequestKeyframeFrom forwards a keyframe request on behalf of client c,
// applying both the per-client budget and the room-wide debounce. The
// publisher asking about itself is ignored.
func (r *Room) RequestKeyframeFrom(c *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if c == r.publisher {
		return
	}
	now := time.Now()
	if now.Sub(c.lastKFAsk) < kfClientBudget {
		return
	}
	c.lastKFAsk = now
	r.requestKeyframeLocked()
}

// PlayStinger broadcasts a caller-supplied stinger to the whole room on
// behalf of client c, applying the per-client cooldown. It reports whether
// the stinger was actually sent.
//
// Shaped exactly like RequestKeyframeFrom, and for the same reasons: the
// payload is resolved by the caller OUTSIDE every relay lock (name lookup is
// filesystem I/O and must never run under r.mu — that is also why Hub.Stinger
// stays a pure pick), this takes only r.mu, never Hub.mu, so the
// Hub.mu-before-Room.mu order is untouched, and the fan-out is
// enqueueControl, which is non-blocking on a channel that is never closed.
func (r *Room) PlayStinger(c *Client, d *protocol.StingerData) bool {
	if d == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return false // a departed client must not be able to fire into a room
	}
	now := time.Now()
	// Zero value means "never asked": now.Sub(zero) is enormous, so the first
	// request passes without a special case (same trick as lastKFAsk).
	if now.Sub(c.lastStingerAsk) < stingerClientBudget {
		return false
	}
	c.lastStingerAsk = now
	r.broadcastStingerLocked(d)
	// Stats: count successful fires by the caller.
	if r.sessionStats != nil {
		if ps, ok := r.sessionStats[c.UserID]; ok {
			ps.StingerPlays++
		}
	}
	return true
}

// --- the stage queue -------------------------------------------------------
//
// Shaped exactly like RequestKeyframeFrom and PlayStinger: every entry point
// takes r.mu and only r.mu (never Hub.mu, so the Hub-before-Room order is
// untouched), validates membership so a departed client can never act on a
// room it left, and fans out with enqueueControl — non-blocking, on channels
// that are never closed. The TTL timer follows scheduleStingerStopLocked:
// AfterFunc re-takes r.mu and compares a generation snapshot, so a stale
// timer firing on a reaped room is a harmless no-op.

// RequestStage puts c in the line ("pedir a vez"). Duplicates, overflow, the
// current publisher and the person already being called are all silently
// ignored — there is nothing useful for the client to do about any of them,
// and the queue broadcast tells it the truth either way.
func (r *Room) RequestStage(c *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return
	}
	if r.publisher != nil && baseID(r.publisher.UserID) == baseID(c.UserID) {
		return // already on stage
	}
	if r.turn != nil && baseID(r.turn.UserID) == baseID(c.UserID) {
		return // already called
	}
	if r.queueIndexLocked(c.UserID) >= 0 || len(r.queue) >= maxQueue {
		return
	}
	name := plainName(c.Username)
	r.queue = append(r.queue, protocol.QueueEntry{
		UserID:        c.UserID,
		Username:      name,
		InitialsEmoji: initialsEmoji(name),
	})
	r.broadcastStageQueueLocked()
}

// WithdrawStage takes c back out of the line.
func (r *Room) WithdrawStage(c *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.removeFromQueueLocked(c.UserID) {
		r.broadcastStageQueueLocked()
	}
}

// SetStageMode switches the room between livre and rodízio. Any member may
// flip it — this is a room of friends, not a permissions model — and an
// unknown value is ignored rather than trusted.
//
// Switching INTO rodízio restarts the clock so the mode always begins with a
// full slot; switching out leaves the line alone, because the line is the
// feature and the clock is the layer on top of it.
func (r *Room) SetStageMode(c *Client, mode string) {
	if mode != protocol.ModeLivre && mode != protocol.ModeRodizio {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return
	}
	if r.modeLocked() == mode {
		return
	}
	if mode == protocol.ModeRodizio {
		r.mode = protocol.ModeRodizio
		if r.publisher != nil {
			r.rodizioStart = time.Now()
			r.rodizioExtended = false
		}
	} else {
		r.mode = ""
	}
	r.broadcastStageQueueLocked()
}

// PassStage is "Passar a vez": the publisher calls the next person and gets
// off the stage in one tap. It reports whether the pass happened and, when it
// did not, a protocol error code the client can translate (an empty code means
// "silently ignored" — a non-publisher or a ghost asking).
//
// The chosen person then claims the stage through the ordinary CtrlTakeStage
// path. There is deliberately no stage-transfer mechanism: the relay still
// has at most one publisher by construction.
func (r *Room) PassStage(c *Client) (bool, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return false, ""
	}
	if r.publisher == nil || baseID(r.publisher.UserID) != baseID(c.UserID) {
		return false, ""
	}
	now := time.Now()
	if now.Sub(r.lastPass) < passCooldown {
		return false, protocol.ErrPassTooSoon
	}
	next, method, ok := r.pickNextLocked()
	if !ok {
		return false, protocol.ErrNoNextUser
	}
	// Pre-warm the next-in-line right away; unicast only to them.
	if nc := r.clientByIDLocked(next.UserID); nc != nil {
		nc.enqueueControl(protocol.CtrlStageWarmup, protocol.StageWarmupData{UserID: next.UserID, Username: next.Username})
	}
	r.lastPass = now
	r.grantTurnLocked(next, method)
	r.leaveStageLocked()
	r.log.Info("stage passed", "from", c.Username, "to", next.Username, "how", method)
	return true, ""
}

// ExtendStage spends the publisher's single +5 minutes.
func (r *Room) ExtendStage(c *Client) (bool, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return false, ""
	}
	if r.publisher == nil || baseID(r.publisher.UserID) != baseID(c.UserID) {
		return false, ""
	}
	if r.rodizioStart.IsZero() {
		return false, ""
	}
	if r.rodizioExtended {
		return false, protocol.ErrAlreadyExt
	}
	r.rodizioExtended = true
	r.broadcastStageQueueLocked()
	return true, ""
}

// pickNextLocked answers "who is up". The visible line always wins; only when
// nobody has asked does rodízio spin for a random member — which is what makes
// the wheel honest rather than an animation over a decided outcome. Entries
// whose connection has gone are skipped, so a stale queue never wastes a turn.
// Caller must hold r.mu.
func (r *Room) pickNextLocked() (protocol.QueueEntry, string, bool) {
	for len(r.queue) > 0 {
		e := r.queue[0]
		r.queue = slices.Delete(r.queue, 0, 1)
		if r.clientByIDLocked(e.UserID) != nil {
			return e, protocol.MethodQueue, true
		}
	}
	if r.modeLocked() != protocol.ModeRodizio {
		return protocol.QueueEntry{}, "", false
	}
	// The wheel: one entry per person (a companion tab is not a candidate
	// of its own), never the sharer who is passing.
	var pool []protocol.QueueEntry
	seen := map[string]bool{}
	for c := range r.clients {
		id := baseID(c.UserID)
		if seen[id] || (r.publisher != nil && baseID(r.publisher.UserID) == id) {
			continue
		}
		if strings.HasSuffix(c.UserID, ":tab") {
			continue // a capture tab has no UI to be called into
		}
		seen[id] = true
		name := plainName(c.Username)
		pool = append(pool, protocol.QueueEntry{
			UserID:        c.UserID,
			Username:      name,
			InitialsEmoji: initialsEmoji(name),
		})
	}
	if len(pool) == 0 {
		return protocol.QueueEntry{}, "", false
	}
	// Sorted first, so the pick depends only on the room's membership and
	// the random draw — never on Go's map iteration order.
	slices.SortFunc(pool, func(a, b protocol.QueueEntry) int {
		return strings.Compare(a.UserID, b.UserID)
	})
	return pool[rand.IntN(len(pool))], protocol.MethodWheel, true
}

// grantTurnLocked calls one person to the stage and arms the window in which
// they may claim it. Caller must hold r.mu.
func (r *Room) grantTurnLocked(e protocol.QueueEntry, method string) {
	r.turnGen++
	gen := r.turnGen
	wait := r.turnWait
	// Pre-warm BEFORE arming the turn so probe can observe it promptly.
	if c := r.clientByIDLocked(e.UserID); c != nil {
		c.enqueueControl(protocol.CtrlStageWarmup, protocol.StageWarmupData{
			UserID:   e.UserID,
			Username: e.Username,
		})
	}
	r.turn = &stageTurn{
		UserID:   e.UserID,
		Username: e.Username,
		Method:   method,
		Ends:     time.Now().Add(wait),
	}
	// Immediately announce the public turn to keep existing semantics/tests.
	d := protocol.StageTurnData{
		UserID:   e.UserID,
		Username: e.Username,
		TTLMs:    int(wait / time.Millisecond),
		Method:   method,
	}
	for c := range r.clients {
		c.enqueueControl(protocol.CtrlStageTurn, d)
	}
	r.broadcastStageQueueLocked()

	time.AfterFunc(wait, func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.turnGen != gen || r.turn == nil {
			return // superseded by a cancel, an accept, or a newer turn
		}
		r.cancelTurnLocked(protocol.CancelTimeout)
		r.advanceTurnLocked()
		r.broadcastStageQueueLocked()
	})
}

// cancelTurnLocked ends the pending turn and says why. Bumping the generation
// is what makes the armed TTL timer a no-op. Caller must hold r.mu.
func (r *Room) cancelTurnLocked(reason string) {
	if r.turn == nil {
		return
	}
	d := protocol.StageCancelData{UserID: r.turn.UserID, Reason: reason}
	r.turn = nil
	r.turnGen++
	for c := range r.clients {
		c.enqueueControl(protocol.CtrlStageCancel, d)
	}
}

// advanceTurnLocked calls the next person in line, if there is one. It only
// ever reads the QUEUE — an unclaimed turn never re-spins the wheel, so a
// room where nobody is paying attention goes quiet instead of pestering
// everybody in it one after another. Caller must hold r.mu.
func (r *Room) advanceTurnLocked() {
	for len(r.queue) > 0 {
		e := r.queue[0]
		r.queue = slices.Delete(r.queue, 0, 1)
		if r.clientByIDLocked(e.UserID) != nil {
			r.grantTurnLocked(e, protocol.MethodQueue)
			return
		}
	}
}

// stopRodizioClockLocked zeroes the turn clock; the stage is free.
// Caller must hold r.mu.
func (r *Room) stopRodizioClockLocked() {
	r.rodizioStart = time.Time{}
	r.rodizioExtended = false
}

func (r *Room) modeLocked() string {
	if r.mode == protocol.ModeRodizio {
		return protocol.ModeRodizio
	}
	return protocol.ModeLivre
}

func (r *Room) queueIndexLocked(userID string) int {
	return slices.IndexFunc(r.queue, func(e protocol.QueueEntry) bool {
		return baseID(e.UserID) == baseID(userID)
	})
}

// removeFromQueueLocked drops a person from the line, reporting whether they
// were in it. Caller must hold r.mu.
func (r *Room) removeFromQueueLocked(userID string) bool {
	i := r.queueIndexLocked(userID)
	if i < 0 {
		return false
	}
	r.queue = slices.Delete(r.queue, i, i+1)
	return true
}

// clientByIDLocked finds a live connection by exact user id. Caller holds mu.
func (r *Room) clientByIDLocked(userID string) *Client {
	for c := range r.clients {
		if c.UserID == userID {
			return c
		}
	}
	return nil
}

// stageQueueLocked snapshots the line and the rodízio clock. TurnLenMs already
// carries the +5 when it has been spent, so no client repeats that maths.
// Caller must hold r.mu.
func (r *Room) stageQueueLocked() protocol.StageQueueData {
	d := protocol.StageQueueData{
		Queue:     slices.Clone(r.queue),
		Mode:      r.modeLocked(),
		TurnLenMs: int(rodizioTurn / time.Millisecond),
	}
	if d.Queue == nil {
		d.Queue = []protocol.QueueEntry{}
	}
	if r.rodizioExtended {
		d.TurnLenMs += int(rodizioExtension / time.Millisecond)
		d.Extended = true
	}
	if !r.rodizioStart.IsZero() {
		d.TimerStartMs = r.rodizioStart.UnixMilli()
	}
	if r.turn != nil {
		d.TurnUserID = r.turn.UserID
		d.TurnEndsMs = r.turn.Ends.UnixMilli()
	}
	return d
}

// broadcastStageQueueLocked fans the whole queue state out. Caller must hold
// r.mu; all sends are non-blocking so holding the lock is cheap.
func (r *Room) broadcastStageQueueLocked() {
	d := r.stageQueueLocked()
	for c := range r.clients {
		c.enqueueControl(protocol.CtrlStageQueue, d)
	}
}

// initialsEmoji maps a name's first Latin letter onto its regional-indicator
// symbol (A → 🇦), so the line reads as a row of little cards rather than a
// row of truncated names. Anything else — a name starting with a digit, an
// emoji, a CJK glyph — gets the neutral chip.
func initialsEmoji(name string) string {
	for _, r := range strings.TrimSpace(name) {
		switch {
		case r >= 'A' && r <= 'Z':
			return string(rune(0x1F1E6 + (r - 'A')))
		case r >= 'a' && r <= 'z':
			return string(rune(0x1F1E6 + (r - 'a')))
		}
		break
	}
	return fallbackEmoji
}

// plainName strips the companion tab's "(sharing)" suffix. The queue is a
// list of PEOPLE, exactly like the roster (docs/design.md § 5.5).
func plainName(name string) string {
	if cut, ok := strings.CutSuffix(strings.TrimSpace(name), "(sharing)"); ok {
		return strings.TrimSpace(cut)
	}
	return name
}

// gateViewersLocked puts every non-publisher behind the keyframe gate —
// called when the GOP cache is invalidated by a stage or config change, so
// stale-parameter deltas are not forwarded. Caller must hold r.mu.
func (r *Room) gateViewersLocked() {
	for c := range r.clients {
		if c != r.publisher {
			c.needKeyframe = true
		}
	}
}

func (r *Room) requestKeyframeLocked() {
	if r.publisher == nil || time.Since(r.lastKFReq) < kfDebounce {
		return
	}
	if r.blanked {
		// Nothing is being encoded: asking would only prod a publisher that
		// is deliberately silent. capture.ts forces its own IDR on unblank.
		return
	}
	r.lastKFReq = time.Now()
	r.publisher.enqueueControl(protocol.CtrlKeyframeRequest, struct{}{})
}

// LeaveStage clears the stage if c holds it — or if c is the same person on
// another connection (a user in the Activity remotely stopping their own
// companion capture tab, whose id is theirs with a ":tab" suffix).
func (r *Room) LeaveStage(c *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.publisher == nil || (r.publisher != c && baseID(r.publisher.UserID) != baseID(c.UserID)) {
		return
	}
	r.leaveStageLocked()
}

// leaveStageLocked frees the stage and stops the rodízio clock. A pending
// turn deliberately SURVIVES: passing the stage is exactly "call the next
// person, then get off", and cancelling the call here would undo the pass.
// Caller must hold r.mu and must already have checked who is asking.
func (r *Room) leaveStageLocked() {
	r.publisher = nil
	r.config = nil
	r.clearGOPLocked()
	r.clearBlankLocked()
	r.stopRodizioClockLocked()
	// Captions belong to the stream they narrate: the publisher leaving
	// disables them and tells every client to wipe the band.
	if r.captionsEnabled {
		r.captionsEnabled = false
		for c := range r.clients {
			c.enqueueControl(protocol.CtrlCaptionClear, nil)
		}
	}
	r.broadcastStageStateLocked()
	r.broadcastStageQueueLocked()
	r.scheduleStingerStopLocked()
}

// SetConfig records the publisher's codec config and announces it.
func (r *Room) SetConfig(c *Client, cfg *protocol.ConfigData) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.publisher != c {
		return
	}
	if _, ok := r.clients[c]; !ok {
		return
	}
	r.config = cfg
	r.clearGOPLocked() // new encoder session invalidates the cache
	r.gateViewersLocked()
	r.broadcastStageStateLocked()
}

// ForwardControl broadcasts a publisher-originated control message (e.g.
// clock sync marks) verbatim to every other participant. Non-publishers are
// ignored.
func (r *Room) ForwardControl(from *Client, t protocol.ControlType, data any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch t {
	case protocol.CtrlSync:
		if r.publisher != from {
			return
		}
		for c := range r.clients {
			if c != from {
				c.enqueueControl(t, data)
			}
		}
	default:
		// Unknown forwarded control: ignore.
	}
}

// BroadcastControl sends a server-originated control to all clients in the room.
func (r *Room) BroadcastControl(t protocol.ControlType, data any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for c := range r.clients {
		c.enqueueControl(t, data)
	}
}

// --- jukebox (probe-limited) -----------------------------------------------

// JukeboxRequest enqueues an asset URL from a viewer with per-user cooldown.
func (r *Room) JukeboxRequest(c *Client, d protocol.JukeboxRequestData) {
	if strings.TrimSpace(d.ID) == "" || strings.TrimSpace(d.Asset) == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return
	}
	if r.jukeboxLast == nil {
		r.jukeboxLast = make(map[string]time.Time)
	}
	base := baseID(c.UserID)
	now := time.Now()
	if last, ok := r.jukeboxLast[base]; ok && now.Sub(last) < 10*time.Second {
		// per-user cooldown
		c.enqueueControl(protocol.CtrlError, protocol.ErrorData{Code: "jukebox_cooldown"})
		return
	}
	r.jukeboxLast[base] = now
	// append to queue
	r.jukeboxQueue = append(r.jukeboxQueue, protocol.JukeboxItem{ID: d.ID, Asset: d.Asset, Requester: c.Username})
	// broadcast queue state to all
	st := protocol.JukeboxQueueState{Queue: append([]protocol.JukeboxItem(nil), r.jukeboxQueue...)}
	for cl := range r.clients {
		cl.enqueueControl(protocol.CtrlJukeboxQueue, st)
	}
}

// JukeboxSendQueue unicasts current state to requester.
func (r *Room) JukeboxSendQueue(c *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return
	}
	st := protocol.JukeboxQueueState{Queue: append([]protocol.JukeboxItem(nil), r.jukeboxQueue...)}
	c.enqueueControl(protocol.CtrlJukeboxQueue, st)
}

// JukeboxApprove pops an item and broadcasts jukebox_play; host only.
func (r *Room) JukeboxApprove(c *Client, id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return false
	}
	if r.publisher == nil || baseID(r.publisher.UserID) != baseID(c.UserID) {
		return false
	}
	// find item
	idx := -1
	for i, it := range r.jukeboxQueue {
		if it.ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return true
	} // nothing to do, treat as ok
	it := r.jukeboxQueue[idx]
	r.jukeboxQueue = slices.Delete(r.jukeboxQueue, idx, idx+1)
	// broadcast play
	// Broadcast play to all, including the host approver.
	play := protocol.JukeboxPlay{ID: it.ID, Asset: it.Asset}
	for cl := range r.clients {
		cl.enqueueControl(protocol.CtrlJukeboxPlay, play)
	}
	// then updated queue
	st := protocol.JukeboxQueueState{Queue: append([]protocol.JukeboxItem(nil), r.jukeboxQueue...)}
	for cl := range r.clients {
		cl.enqueueControl(protocol.CtrlJukeboxQueue, st)
	}
	return true
}

// --- placar (scoreboard) API -----------------------------------------------

// placarStateLocked snapshots the current tally.
func (r *Room) placarStateLocked() protocol.PlacarStateData {
	// copy map so callers cannot mutate internal state
	scores := make(map[string]int, len(r.placarScores))
	for k, v := range r.placarScores {
		scores[k] = v
	}
	return protocol.PlacarStateData{Active: r.placarActive, Prompt: r.placarPrompt, Scores: scores}
}

func (r *Room) broadcastPlacarStateLocked() {
	d := r.placarStateLocked()
	for c := range r.clients {
		c.enqueueControl(protocol.CtrlPlacarState, d)
	}
}

func (r *Room) CreatePlacar(c *Client, prompt string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return nil
	}
	if r.publisher == nil || baseID(r.publisher.UserID) != baseID(c.UserID) {
		return fmt.Errorf("placar.notPublisher")
	}
	if r.placarActive {
		return fmt.Errorf("placar.alreadyActive")
	}
	if n := len(strings.TrimSpace(prompt)); n < 1 || n > 60 {
		return fmt.Errorf("placar.badPrompt")
	}
	r.placarActive = true
	r.placarPrompt = prompt
	r.placarScores = make(map[string]int, len(r.clients))
	for cl := range r.clients {
		r.placarScores[baseID(cl.UserID)] = 0
	}
	r.broadcastPlacarStateLocked()
	return nil
}

func (r *Room) PlacarVote(c *Client, target string, delta int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return nil
	}
	if !r.placarActive {
		return fmt.Errorf("placar.inactive")
	}
	if delta != 1 && delta != -1 {
		return fmt.Errorf("placar.badDelta")
	}
	base := baseID(target)
	if _, ok := r.placarScores[base]; !ok {
		return fmt.Errorf("placar.noMember")
	}
	now := time.Now()
	if last, ok := r.placarLastVote[c]; ok && now.Sub(last) < time.Second {
		return fmt.Errorf("placar.tooFast")
	}
	r.placarLastVote[c] = now
	r.placarScores[base] += delta
	r.broadcastPlacarStateLocked()
	return nil
}

func (r *Room) ClosePlacar(c *Client) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return nil
	}
	if r.publisher == nil || baseID(r.publisher.UserID) != baseID(c.UserID) {
		return fmt.Errorf("placar.notPublisher")
	}
	r.placarActive = false
	r.placarPrompt = ""
	r.placarScores = make(map[string]int)
	r.broadcastPlacarStateLocked()
	return nil
}

// ForwardMedia fans a binary media message from the publisher out to every
// other participant. Slow viewers get video dropped until the next keyframe;
// audio is always queued if there is room, else dropped silently. Messages
// with unknown media kinds are discarded by the header parser.
func (r *Room) ForwardMedia(from *Client, msg []byte) {
	hdr, err := protocol.ParseMediaHeader(msg)
	if err != nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.publisher != from {
		return // stale sender lost the stage
	}
	if _, ok := r.clients[from]; !ok {
		return // departed client: never forward on its behalf
	}
	// Privacy panic, relay gate. The publisher already stopped encoding
	// (web/src/capture.ts drops at the frame-read loop AND suppresses the
	// encoder output), so reaching here means something raced or lied.
	// Drop it: while blanked, no captured byte leaves this room.
	if r.blanked || r.cinemaPaused {
		return
	}

	// Maintain the late-join cache from the video stream. Bounded by both
	// bytes and chunk count: a GOP that cannot fit a fresh client queue is
	// useless as a replay (and would deliver a stale burst instead).
	if hdr.Kind == protocol.KindVideo {
		switch {
		case hdr.Keyframe():
			// Fresh slice: reslicing the old backing array would pin the
			// previous GOP's chunks in unused capacity.
			r.gop = [][]byte{msg}
			r.gopBytes = len(msg)
		case r.gop != nil:
			if r.gopBytes+len(msg) > maxGOPBytes || len(r.gop) >= maxGOPChunks {
				r.clearGOPLocked() // runaway GOP; joiners use keyframe-on-demand
			} else {
				r.gop = append(r.gop, msg)
				r.gopBytes += len(msg)
			}
		}
	}

	// --- rolling clip buffer (video + audio, keyframe-bounded) ---------
	// Append and trim by time/bytes, dropping whole GOPs only (scan to next
	// video keyframe when trimming the head). Guarded by r.mu.
	{
		const clipWindow = 30 * time.Second
		const clipMaxBytes = 32 << 20 // 32MB ceiling
		// Append current chunk.
		r.clipBuf = append(r.clipBuf, msg)
		r.clipBytes += len(msg)
		if r.clipStartTs == 0 {
			r.clipStartTs = int64(hdr.Timestamp)
		}
		// Check caps and trim from head to next keyframe that fits.
		lastTs := int64(hdr.Timestamp)
		span := time.Duration(lastTs-r.clipStartTs) * time.Microsecond
		if span > clipWindow || r.clipBytes > clipMaxBytes {
			drop := 0
			acc := 0
			for i := 0; i < len(r.clipBuf); i++ {
				h, err := protocol.ParseMediaHeader(r.clipBuf[i])
				if err != nil {
					continue
				}
				if h.Kind == protocol.KindVideo && h.Keyframe() {
					// bytes from i..end
					bytes := 0
					for j := i; j < len(r.clipBuf); j++ {
						bytes += len(r.clipBuf[j])
					}
					span2 := time.Duration(int64(hdr.Timestamp)-int64(h.Timestamp)) * time.Microsecond
					if bytes <= clipMaxBytes && span2 <= clipWindow {
						drop = i
						break
					}
				}
			}
			for k := 0; k < drop; k++ {
				acc += len(r.clipBuf[k])
			}
			if drop > 0 {
				r.clipBuf = slices.Delete(r.clipBuf, 0, drop)
				r.clipBytes -= acc
				if len(r.clipBuf) > 0 {
					if nh, err := protocol.ParseMediaHeader(r.clipBuf[0]); err == nil {
						r.clipStartTs = int64(nh.Timestamp)
					} else {
						r.clipStartTs = 0
					}
				} else {
					r.clipStartTs = 0
				}
			}
		}
	}

	now := time.Now()
	for c := range r.clients {
		if c == from {
			continue
		}
		// The sharer's other connections (their Activity view) don't render
		// their own stream — sending it anyway costs a full stream of
		// egress per share (43% of uplink in the observed incident).
		if baseID(c.UserID) == baseID(from.UserID) {
			continue
		}
		if hdr.Kind == protocol.KindVideo {
			if c.needKeyframe && !hdr.Keyframe() {
				continue
			}
			// Temporal shedding: a degraded viewer skips higher SVC layers
			// (smoothly lower framerate) and recovers one layer at a time
			// after a clean stretch.
			if hdr.TemporalID > c.maxTL {
				continue
			}
			if c.maxTL < maxTemporalLayer && now.Sub(c.lastTLDrop) > tlRecoverAfter {
				c.maxTL++
				c.lastTLDrop = now
			}
			if c.trySend(outMsg{binary: true, payload: msg}) {
				c.needKeyframe = false
			} else {
				c.lastTLDrop = now
				if hdr.TemporalID > 0 {
					// A higher temporal layer is non-reference: dropping it
					// is safe, and shedding the layer lowers this viewer's
					// framerate smoothly instead of freezing them.
					if c.maxTL >= hdr.TemporalID {
						c.maxTL = hdr.TemporalID - 1
					}
				} else if !c.needKeyframe {
					// Base-layer chunks are reference frames — a gap here
					// corrupts decode, so freeze until the next keyframe.
					c.needKeyframe = true
					r.requestKeyframeLocked()
				}
			}
		} else {
			// Audio: drop silently under pressure.
			_ = c.trySend(outMsg{binary: true, payload: msg})
		}
	}
	r.maybeSendRateHintLocked(now)
}

// maybeSendRateHintLocked tells the publisher how many viewers the relay is
// degrading, paced to rateHintInterval. Caller must hold r.mu.
func (r *Room) maybeSendRateHintLocked(now time.Time) {
	if r.publisher == nil || now.Sub(r.lastHint) < rateHintInterval {
		return
	}
	r.lastHint = now
	degraded, viewers := 0, 0
	for c := range r.clients {
		if c == r.publisher || baseID(c.UserID) == baseID(r.publisher.UserID) {
			continue // the sharer's own connections receive no media
		}
		viewers++
		if c.needKeyframe || c.maxTL < maxTemporalLayer {
			degraded++
		}
	}
	r.publisher.enqueueControl(protocol.CtrlRateHint, protocol.RateHintData{
		Degraded: degraded,
		Viewers:  viewers,
	})
}

// stageStateLocked snapshots the stage. Caller must hold r.mu.
func (r *Room) stageStateLocked() protocol.StageStateData {
	s := protocol.StageStateData{Config: r.config, Blanked: r.blanked}
	if r.publisher != nil {
		s.PublisherID = r.publisher.UserID
		s.PublisherName = r.publisher.Username
		s.Phase = "live"
	} else {
		s.Phase = "lobby"
	}
	return s
}

// broadcastStageStateLocked fans the stage state out. Caller must hold r.mu;
// all sends are non-blocking so holding the lock is cheap.
func (r *Room) broadcastStageStateLocked() {
	state := r.stageStateLocked()
	for c := range r.clients {
		c.enqueueControl(protocol.CtrlStageState, state)
	}
}

// broadcastRoomPhaseLocked announces the lobby/live edge to everyone.
func (r *Room) broadcastRoomPhaseLocked() {
	phase := "lobby"
	if r.publisher != nil {
		phase = "live"
	}
	d := struct {
		Phase string `json:"phase"`
	}{Phase: phase}
	for c := range r.clients {
		c.enqueueControl(protocol.CtrlRoomPhase, d)
	}
}

func (r *Room) broadcastRoomStateLocked() {
	parts := make([]protocol.Participant, 0, len(r.clients))
	for c := range r.clients {
		parts = append(parts, protocol.Participant{UserID: c.UserID, Username: c.Username})
	}
	state := protocol.RoomStateData{Participants: parts}
	for c := range r.clients {
		c.enqueueControl(protocol.CtrlRoomState, state)
	}
}

// --- cinema: pause/resume/state/strokes -------------------------------------

// CinemaPause pauses the room for everyone. Publisher-only.
func (r *Room) CinemaPause(c *Client) (bool, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.publisher == nil || baseID(r.publisher.UserID) != baseID(c.UserID) {
		return false, protocol.ErrCinemaNotPublisher
	}
	if r.cinemaPaused {
		return true, ""
	}
	r.cinemaPaused = true
	r.broadcastCinemaStateLocked()
	return true, ""
}

// CinemaResume resumes playback and clears strokes; requests a keyframe.
func (r *Room) CinemaResume(c *Client) (bool, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.publisher == nil || baseID(r.publisher.UserID) != baseID(c.UserID) {
		return false, protocol.ErrCinemaNotPublisher
	}
	if !r.cinemaPaused {
		return true, ""
	}
	r.cinemaPaused = false
	r.cinemaStrokes = nil
	r.broadcastCinemaStateLocked()
	r.requestKeyframeLocked()
	return true, ""
}

// AddCinemaStroke validates and appends a stroke while paused.
func (r *Room) AddCinemaStroke(c *Client, d *protocol.CinemaStrokeData) (bool, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return false, ""
	}
	if !r.cinemaPaused {
		return false, protocol.ErrCinemaBadStroke
	}
	// Fixed palette on the server side (tokens mapped client-side).
	allowed := map[string]bool{"redorange": true, "crayon-blue": true, "yellow": true, "grass": true, "pink": true, "purple": true}
	if !allowed[d.Color] || len(d.Points) < 2 || len(d.Points) > 1000 {
		return false, protocol.ErrCinemaBadStroke
	}
	for _, p := range d.Points {
		if p.X < 0 || p.X > 1 || p.Y < 0 || p.Y > 1 {
			return false, protocol.ErrCinemaBadStroke
		}
	}
	// Per-client rate limit: 10 strokes/s. Reuse lastStingerAsk shape.
	now := time.Now()
	if now.Sub(c.lastStingerAsk) < 100*time.Millisecond {
		return false, protocol.ErrCinemaRateLimited
	}
	c.lastStingerAsk = now

	id := c.UserID + ":" + strconv.FormatInt(now.UnixNano(), 16)
	s := protocol.StrokeData{UserID: c.UserID, Color: d.Color, Points: d.Points, StrokeID: id}
	if len(r.cinemaStrokes) >= 100 {
		r.cinemaStrokes = r.cinemaStrokes[1:]
	}
	r.cinemaStrokes = append(r.cinemaStrokes, s)
	for cl := range r.clients {
		cl.enqueueControl(protocol.CtrlCinemaStrokeAdd, s)
	}
	return true, ""
}

// buildRawClipLocked snapshots the rolling buffer into the wire framing served
// by /clip/{token}. Caller must hold r.mu.
func (r *Room) buildRawClipLocked() []byte {
	// Magic + JSON header length + JSON bytes, then per-chunk records.
	// Magic
	out := []byte{'J', 'C', 'L', 'P'}
	// Header
	hdr := map[string]any{}
	if r.config != nil {
		hdr["videoCodec"] = r.config.VideoCodec
		hdr["width"] = r.config.Width
		hdr["height"] = r.config.Height
		hdr["framerate"] = r.config.Framerate
		if r.config.AudioCodec != "" {
			hdr["audioCodec"] = r.config.AudioCodec
			hdr["sampleRate"] = r.config.SampleRate
			hdr["channels"] = r.config.Channels
		}
	}
	j, _ := json.Marshal(hdr)
	// uint32 length big-endian
	out = append(out, byte(len(j)>>24), byte(len(j)>>16), byte(len(j)>>8), byte(len(j)))
	out = append(out, j...)
	// Chunks
	for _, b := range r.clipBuf {
		if len(b) < protocol.HeaderSize {
			continue
		}
		h, err := protocol.ParseMediaHeader(b)
		if err != nil {
			continue
		}
		// kind uint8, flags(uint8 keyframe), uint32 payload len, uint64 ts, payload
		out = append(out, byte(h.Kind))
		flags := uint8(0)
		if h.Keyframe() {
			flags = 1
		}
		out = append(out, flags)
		payloadLen := len(b) - protocol.HeaderSize
		out = append(out, byte(payloadLen>>24), byte(payloadLen>>16), byte(payloadLen>>8), byte(payloadLen))
		ts := h.Timestamp
		out = append(out,
			byte(ts>>56), byte(ts>>48), byte(ts>>40), byte(ts>>32),
			byte(ts>>24), byte(ts>>16), byte(ts>>8), byte(ts))
		out = append(out, b[protocol.HeaderSize:]...)
	}
	return out
}

// mintClipTokenLocked stores the clip bytes and returns a pseudo-random token.
// Caller must hold r.mu.
func (r *Room) mintClipTokenLocked(data []byte, mime string, ttl time.Duration) string {
	if r.clips == nil {
		r.clips = make(map[string]clipItem)
	}
	// Random hex token
	t := strconv.FormatInt(time.Now().UnixNano(), 36) + strconv.FormatInt(rand.Int64(), 36)
	r.clips[t] = clipItem{data: data, mime: mime, expiresAt: time.Now().Add(ttl)}
	return t
}

// GetClip returns clip bytes and mime if token is valid and not expired.
func (r *Room) GetClip(token string) ([]byte, string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	it, ok := r.clips[token]
	if !ok || time.Now().After(it.expiresAt) {
		return nil, "", false
	}
	return it.data, it.mime, true
}

// RequestClip handles a client's clip request: enforces per-client cooldown,
// snapshots the buffer, remuxes, stores a short-lived token, and unicasts a
// CtrlClipReady back to the requester.
func (r *Room) RequestClip(c *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return
	}
	// 5s per-client cooldown
	now := time.Now()
	if last, ok := r.lastClipAsk[c]; ok && now.Sub(last) < 5*time.Second {
		return
	}
	r.lastClipAsk[c] = now
	if len(r.clipBuf) == 0 {
		return
	}
	data := r.buildRawClipLocked()
	token := r.mintClipTokenLocked(data, "application/octet-stream", 2*time.Minute)
	// Relay-origin URL path; actual host determined by client.
	url := "/clip/" + token
	c.enqueueControl(protocol.CtrlClipReady, protocol.ClipReadyData{URL: url, ExpiresMs: time.Now().Add(2 * time.Minute).UnixMilli()})
}

// RequestReplay handles a client's replay request (90s variant). For now we
// reuse the same rolling clip buffer and framing; room sidecar events, when
// present, are exposed via Server's /clip/{token}/events.json.
func (r *Room) RequestReplay(c *Client, seconds int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c]; !ok {
		return
	}
	if len(r.clipBuf) == 0 {
		return
	}
	if seconds <= 0 {
		seconds = 90
	}
	if seconds > 90 {
		seconds = 90
	}
	data := r.buildRawClipLocked()
	token := r.mintClipTokenLocked(data, "application/octet-stream", 2*time.Minute)
	// Attach probe events snapshot as JSON sidecar under the same token.
	if r.clipEvents == nil {
		r.clipEvents = make(map[string][]byte)
	}
	if len(r.probeEvents) > 0 {
		if b, err := json.Marshal(r.probeEvents); err == nil {
			r.clipEvents[token] = b
		} else {
			r.clipEvents[token] = []byte("[]")
		}
	} else {
		r.clipEvents[token] = []byte("[]")
	}
	c.enqueueControl(protocol.CtrlReplayReady, protocol.ReplayReadyData{
		Token:     token,
		ExpiresMs: int64(2 * time.Minute / time.Millisecond),
	})
}

// GetClipEvents returns an empty sidecar by default; server may attach.
func (r *Room) GetClipEvents(token string) ([]byte, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if it, ok := r.clips[token]; ok && time.Now().Before(it.expiresAt) {
		if b, ok2 := r.clipEvents[token]; ok2 {
			out := append([]byte(nil), b...)
			return out, true
		}
	}
	return nil, false
}

// AppendProbeEvent records a synthetic event into the room timeline (probe-only).
func (r *Room) AppendProbeEvent(ev map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.probeEvents) >= 200 {
		r.probeEvents = r.probeEvents[1:]
	}
	r.probeEvents = append(r.probeEvents, ev)
}

func (r *Room) broadcastCinemaStateLocked() {
	d := protocol.CinemaStateData{Paused: r.cinemaPaused, Strokes: slices.Clone(r.cinemaStrokes)}
	for c := range r.clients {
		c.enqueueControl(protocol.CtrlCinemaState, d)
	}
}

// stingerStartLocked runs on every successful TakeStage: it cancels any
// pending stop stinger (the generation bump), and fires the start stinger
// only on a genuine idle→live transition. A re-take while stingerLive — a
// reconnect racing its stop window, a takeover, a supersede+retake — is the
// same stream continuing and fires nothing. Caller must hold r.mu.
func (r *Room) stingerStartLocked() {
	if r.stinger == nil {
		return
	}
	r.stingerGen++ // cancel any pending stop
	if r.stingerLive {
		return
	}
	if d := r.stinger("start"); d != nil {
		r.stingerLive = true
		r.broadcastStingerLocked(d)
	}
}

// scheduleStingerStopLocked arms the delayed stop stinger when the stage
// empties. The timer callback re-takes r.mu and only fires if no TakeStage
// bumped the generation meanwhile and the stage is still empty. Firing on a
// reaped room is harmless: the clients map is empty, nothing is resurrected.
// Caller must hold r.mu.
func (r *Room) scheduleStingerStopLocked() {
	if r.stinger == nil || !r.stingerLive {
		return
	}
	gen := r.stingerGen
	time.AfterFunc(r.stingerStopWait, func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.stingerGen != gen || r.publisher != nil || !r.stingerLive {
			return
		}
		r.stingerLive = false
		if d := r.stinger("stop"); d != nil {
			r.broadcastStingerLocked(d)
		}
	})
}

// broadcastStingerLocked fans a stinger out to every room client — the
// publisher's own connections included, so the sharer's Activity view plays
// it too. Caller must hold r.mu; all sends are non-blocking.
func (r *Room) broadcastStingerLocked(d *protocol.StingerData) {
	for c := range r.clients {
		c.enqueueControl(protocol.CtrlStinger, d)
	}
}

func (r *Room) clearGOPLocked() {
	r.gop = nil
	r.gopBytes = 0
}

// baseID strips the companion-tab suffix, yielding the person's identity.
func baseID(id string) string {
	base, _ := strings.CutSuffix(id, ":tab")
	base, _ = strings.CutSuffix(base, ":telinha")
	return base
}

// SendControl queues a control message for this client alone. Safe to call
// concurrently with Leave: the channel is never closed.
func (c *Client) SendControl(t protocol.ControlType, data any) {
	c.enqueueControl(t, data)
}

// trySend queues a message if both the slot and byte bounds allow it. The
// send is non-blocking and the channel is never closed, so this is safe
// under any lock and against concurrent Leave.
func (c *Client) trySend(m outMsg) bool {
	if c.queuedBytes.Load()+int64(len(m.payload)) > clientQueueBytes {
		return false
	}
	select {
	case c.out <- m:
		c.queuedBytes.Add(int64(len(m.payload)))
		return true
	default:
		return false
	}
}

// enqueueControl marshals and queues a control message.
func (c *Client) enqueueControl(t protocol.ControlType, data any) {
	payload, err := protocol.MarshalControl(t, data)
	if err != nil {
		return
	}
	// Control overflow: connection is doomed anyway; write loop will notice.
	_ = c.trySend(outMsg{payload: payload})
}
