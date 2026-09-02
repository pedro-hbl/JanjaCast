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
	"iter"
	"log/slog"
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
}

// NewHub returns an empty hub.
func NewHub(log *slog.Logger) *Hub {
	return &Hub{
		rooms:            make(map[string]*Room),
		log:              log,
		StingerStopDelay: stingerStopDelay,
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
		r = &Room{
			id:              roomID,
			clients:         make(map[*Client]struct{}),
			log:             h.log.With("room", roomID),
			stinger:         h.Stinger,
			stingerStopWait: h.StingerStopDelay,
		}
		h.rooms[roomID] = r
	}

	r.mu.Lock()
	defer r.mu.Unlock()

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
			r.gateViewersLocked()
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

	r.clients[c] = struct{}{}
	r.broadcastRoomStateLocked()
	r.log.Info("joined", "user", username, "id", userID)

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

	if r.publisher == c {
		r.publisher = nil
		r.config = nil
		r.clearGOPLocked()
		r.broadcastStageStateLocked()
		r.scheduleStingerStopLocked()
	}
	r.broadcastRoomStateLocked()

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
	r.gateViewersLocked()
	r.broadcastStageStateLocked()
	r.stingerStartLocked()
	r.log.Info("stage taken", "user", c.Username)
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
	return true
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
	r.publisher = nil
	r.config = nil
	r.clearGOPLocked()
	r.broadcastStageStateLocked()
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
	if r.publisher != from {
		return
	}
	for c := range r.clients {
		if c != from {
			c.enqueueControl(t, data)
		}
	}
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
	s := protocol.StageStateData{Config: r.config}
	if r.publisher != nil {
		s.PublisherID = r.publisher.UserID
		s.PublisherName = r.publisher.Username
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
