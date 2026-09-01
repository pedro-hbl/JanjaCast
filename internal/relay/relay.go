// Package relay implements the fan-out core of golive: rooms keyed by
// Discord activity instance, each with at most one publisher whose media
// chunks are forwarded to every other participant.
package relay

import (
	"iter"
	"log/slog"
	"maps"
	"sync"

	"github.com/pedro-hbl/golive/internal/protocol"
)

// sendBuffer is the per-viewer outgoing queue length. When a viewer's queue
// overflows the relay drops video until the next keyframe rather than
// letting one slow consumer stall the room.
const sendBuffer = 256

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

// Room returns the room with the given id, creating it if needed.
func (h *Hub) Room(id string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[id]
	if !ok {
		r = &Room{
			id:      id,
			hub:     h,
			clients: make(map[*Client]struct{}),
			log:     h.log.With("room", id),
		}
		h.rooms[id] = r
	}
	return r
}

func (h *Hub) removeIfEmpty(r *Room) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r.mu.Lock()
	empty := len(r.clients) == 0
	r.mu.Unlock()
	if empty {
		delete(h.rooms, r.id)
	}
}

// Room is one activity instance: N participants, at most one publisher.
type Room struct {
	id  string
	hub *Hub
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
}

// maxGOPBytes bounds the late-join cache; past this the cache is dropped and
// joiners wait for the next keyframe like before.
const maxGOPBytes = 16 << 20

// Client is one connected WebSocket participant.
type Client struct {
	UserID   string
	Username string

	room *Room
	// Out delivers messages to the connection write loop. Closed by Leave.
	out chan outMsg
	// needKeyframe marks that video was dropped and delta frames must be
	// suppressed until the next keyframe arrives. Guarded by room.mu.
	needKeyframe bool
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

// Join adds a participant and returns its client handle plus a sequence for
// the write loop to range over.
func (r *Room) Join(userID, username string) (*Client, iter.Seq[OutMsg]) {
	c := &Client{
		UserID:   userID,
		Username: username,
		room:     r,
		out:      make(chan outMsg, sendBuffer),
	}
	r.mu.Lock()
	r.clients[c] = struct{}{}
	r.mu.Unlock()

	c.enqueueControl(protocol.CtrlWelcome, r.stageState())

	// Replay the cached GOP so the newcomer has a picture immediately.
	r.mu.Lock()
	replay := make([][]byte, len(r.gop))
	copy(replay, r.gop)
	r.mu.Unlock()
	for _, msg := range replay {
		select {
		case c.out <- outMsg{binary: true, payload: msg}:
		default:
		}
	}

	r.broadcastRoomState()
	r.log.Info("joined", "user", username, "id", userID)

	seq := func(yield func(OutMsg) bool) {
		for m := range c.out {
			if !yield(m) {
				return
			}
		}
	}
	return c, seq
}

// Leave removes the participant, freeing the stage if it held it.
func (r *Room) Leave(c *Client) {
	r.mu.Lock()
	if _, ok := r.clients[c]; !ok {
		r.mu.Unlock()
		return
	}
	delete(r.clients, c)
	close(c.out)
	wasPublisher := r.publisher == c
	if wasPublisher {
		r.publisher = nil
		r.config = nil
	}
	r.mu.Unlock()

	if wasPublisher {
		r.broadcastStageState()
	}
	r.broadcastRoomState()
	r.hub.removeIfEmpty(r)
	r.log.Info("left", "user", c.Username)
}

// TakeStage makes c the publisher, replacing any current one.
func (r *Room) TakeStage(c *Client) {
	r.mu.Lock()
	r.publisher = c
	r.config = nil
	r.clearGOPLocked()
	r.mu.Unlock()
	r.broadcastStageState()
	r.log.Info("stage taken", "user", c.Username)
}

// LeaveStage clears the stage if c holds it.
func (r *Room) LeaveStage(c *Client) {
	r.mu.Lock()
	if r.publisher != c {
		r.mu.Unlock()
		return
	}
	r.publisher = nil
	r.config = nil
	r.clearGOPLocked()
	r.mu.Unlock()
	r.broadcastStageState()
}

// SetConfig records the publisher's codec config and announces it.
func (r *Room) SetConfig(c *Client, cfg *protocol.ConfigData) {
	r.mu.Lock()
	if r.publisher != c {
		r.mu.Unlock()
		return
	}
	r.config = cfg
	r.clearGOPLocked() // new encoder session invalidates the cache
	r.mu.Unlock()
	r.broadcastStageState()
}

// ForwardControl broadcasts a publisher-originated control message (e.g.
// clock sync marks) verbatim to every other participant. Non-publishers are
// ignored.
func (r *Room) ForwardControl(from *Client, t protocol.ControlType, data any) {
	r.mu.Lock()
	isPublisher := r.publisher == from
	r.mu.Unlock()
	if !isPublisher {
		return
	}
	for c := range r.snapshotClients() {
		if c != from {
			c.enqueueControl(t, data)
		}
	}
}

func (r *Room) clearGOPLocked() {
	r.gop = nil
	r.gopBytes = 0
}

// ForwardMedia fans a binary media message from the publisher out to every
// other participant. Slow viewers get video dropped until the next keyframe;
// audio is always queued if there is room, else dropped silently.
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
			r.gop = append(r.gop[:0], msg)
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

	for c := range r.clients {
		if c == from {
			continue
		}
		if hdr.Kind == protocol.KindVideo {
			if c.needKeyframe && !hdr.Keyframe() {
				continue
			}
			select {
			case c.out <- outMsg{binary: true, payload: msg}:
				c.needKeyframe = false
			default:
				c.needKeyframe = true // overflow: drop until next keyframe
			}
		} else {
			select {
			case c.out <- outMsg{binary: true, payload: msg}:
			default: // drop audio chunk under pressure
			}
		}
	}
}

// stageState snapshots the current stage. Callers need not hold r.mu.
func (r *Room) stageState() protocol.StageStateData {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := protocol.StageStateData{Config: r.config}
	if r.publisher != nil {
		s.PublisherID = r.publisher.UserID
		s.PublisherName = r.publisher.Username
	}
	return s
}

func (r *Room) broadcastStageState() {
	state := r.stageState()
	for c := range r.snapshotClients() {
		c.enqueueControl(protocol.CtrlStageState, state)
	}
}

func (r *Room) broadcastRoomState() {
	var parts []protocol.Participant
	r.mu.Lock()
	for c := range r.clients {
		parts = append(parts, protocol.Participant{UserID: c.UserID, Username: c.Username})
	}
	r.mu.Unlock()
	state := protocol.RoomStateData{Participants: parts}
	for c := range r.snapshotClients() {
		c.enqueueControl(protocol.CtrlRoomState, state)
	}
}

// snapshotClients returns an iterator over a point-in-time copy of members,
// safe to range without holding the lock.
func (r *Room) snapshotClients() iter.Seq[*Client] {
	r.mu.Lock()
	snap := maps.Clone(r.clients)
	r.mu.Unlock()
	return maps.Keys(snap)
}

// SendControl queues a control message for this client alone.
func (c *Client) SendControl(t protocol.ControlType, data any) {
	c.enqueueControl(t, data)
}

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
