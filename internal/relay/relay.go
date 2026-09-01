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
	"time"

	"github.com/pedro-hbl/janjacast/internal/protocol"
)

// sendBuffer is the per-viewer outgoing queue length. When a viewer's queue
// overflows the relay drops video until the next keyframe rather than
// letting one slow consumer stall the room.
const sendBuffer = 256

// maxGOPBytes bounds the late-join cache; past this the cache is dropped and
// joiners wait for the next keyframe like before.
const maxGOPBytes = 16 << 20

// Hub owns all rooms.
type Hub struct {
	mu    sync.Mutex
	rooms map[string]*Room
	log   *slog.Logger
}

// NewHub returns an empty hub.
func NewHub(log *slog.Logger) *Hub {
	return &Hub{rooms: make(map[string]*Room), log: log}
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
			id:      roomID,
			clients: make(map[*Client]struct{}),
			log:     h.log.With("room", roomID),
		}
		h.rooms[roomID] = r
	}

	r.mu.Lock()
	defer r.mu.Unlock()

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
		select {
		case c.out <- outMsg{binary: true, payload: msg}:
		default:
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
	seq := func(yield func(OutMsg) bool) {
		for {
			select {
			case m := <-c.out:
				if !yield(m) {
					return
				}
			default:
				select {
				case m := <-c.out:
					if !yield(m) {
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
}

// maxTemporalLayer is the highest SVC temporal layer id (L1T3 → 0,1,2).
const maxTemporalLayer = 2

// tlRecoverAfter is how long a viewer must go without overflowing before the
// relay restores one temporal layer.
const tlRecoverAfter = 8 * time.Second

// rateHintInterval paces congestion feedback to the publisher.
const rateHintInterval = 2 * time.Second

// kfDebounce is the minimum gap between keyframe requests forwarded to a
// publisher — coalesces a burst of struggling viewers into one request.
const kfDebounce = 300 * time.Millisecond

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
// publisher is told who took over so its UI can say so.
func (r *Room) TakeStage(c *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if old := r.publisher; old != nil && old != c {
		old.enqueueControl(protocol.CtrlStageTaken, protocol.StageTakenData{ByName: c.Username})
	}
	r.publisher = c
	r.config = nil
	r.clearGOPLocked()
	r.broadcastStageStateLocked()
	r.log.Info("stage taken", "user", c.Username)
}

// RequestKeyframe forwards a keyframe request to the publisher, debounced
// per room. Safe to call whenever a viewer is stuck waiting for a keyframe.
func (r *Room) RequestKeyframe() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.requestKeyframeLocked()
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
}

// SetConfig records the publisher's codec config and announces it.
func (r *Room) SetConfig(c *Client, cfg *protocol.ConfigData) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.publisher != c {
		return
	}
	r.config = cfg
	r.clearGOPLocked() // new encoder session invalidates the cache
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

	// Maintain the late-join cache from the video stream.
	if hdr.Kind == protocol.KindVideo {
		switch {
		case hdr.Keyframe():
			// Fresh slice: reslicing the old backing array would pin the
			// previous GOP's chunks in unused capacity.
			r.gop = [][]byte{msg}
			r.gopBytes = len(msg)
		case r.gop != nil:
			if r.gopBytes+len(msg) > maxGOPBytes {
				r.clearGOPLocked() // runaway GOP; wait for the next keyframe
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
			select {
			case c.out <- outMsg{binary: true, payload: msg}:
				c.needKeyframe = false
			default:
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
			select {
			case c.out <- outMsg{binary: true, payload: msg}:
			default: // drop audio chunk under pressure
			}
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
		if c == r.publisher {
			continue
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

// enqueueControl marshals and queues a control message. The send is
// non-blocking and the channel is never closed, so this is safe under any
// lock and against concurrent Leave.
func (c *Client) enqueueControl(t protocol.ControlType, data any) {
	payload, err := protocol.MarshalControl(t, data)
	if err != nil {
		return
	}
	select {
	case c.out <- outMsg{payload: payload}:
	default: // control overflow: connection is doomed anyway; write loop will notice
	}
}
