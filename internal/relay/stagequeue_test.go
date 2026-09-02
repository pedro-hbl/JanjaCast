package relay

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/pedro-hbl/janjacast/internal/protocol"
)

// queueHub returns a hub whose turn window is short enough to let a test
// watch an unclaimed turn expire without sleeping twenty real seconds.
func queueHub(ttl time.Duration) *Hub {
	hub := NewHub(discard())
	hub.TurnTTL = ttl
	return hub
}

// lastQueue returns the last CtrlStageQueue in a drained outbox, and whether
// there was one at all.
func lastQueue(t *testing.T, msgs []OutMsg) (protocol.StageQueueData, bool) {
	t.Helper()
	var last protocol.StageQueueData
	found := false
	for _, m := range msgs {
		if m.Binary() {
			continue
		}
		var ctrl protocol.Control
		if err := json.Unmarshal(m.Payload(), &ctrl); err != nil {
			t.Fatal(err)
		}
		if ctrl.Type != protocol.CtrlStageQueue {
			continue
		}
		last = protocol.StageQueueData{} // Unmarshal merges; reset first
		if err := json.Unmarshal(ctrl.Data, &last); err != nil {
			t.Fatal(err)
		}
		found = true
	}
	return last, found
}

// turnsAndCancels replays a drained outbox into the sequence of turn calls and
// cancellations it carried, in order.
func turnsAndCancels(t *testing.T, msgs []OutMsg) ([]protocol.StageTurnData, []protocol.StageCancelData) {
	t.Helper()
	var turns []protocol.StageTurnData
	var cancels []protocol.StageCancelData
	for _, m := range msgs {
		if m.Binary() {
			continue
		}
		var ctrl protocol.Control
		if err := json.Unmarshal(m.Payload(), &ctrl); err != nil {
			t.Fatal(err)
		}
		switch ctrl.Type {
		case protocol.CtrlStageTurn:
			var d protocol.StageTurnData
			if err := json.Unmarshal(ctrl.Data, &d); err != nil {
				t.Fatal(err)
			}
			turns = append(turns, d)
		case protocol.CtrlStageCancel:
			var d protocol.StageCancelData
			if err := json.Unmarshal(ctrl.Data, &d); err != nil {
				t.Fatal(err)
			}
			cancels = append(cancels, d)
		}
	}
	return turns, cancels
}

// queueOf snapshots a room's line without racing it.
func queueOf(r *Room) []protocol.QueueEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stageQueueLocked().Queue
}

// queueStateOf snapshots the whole queue + rodízio state.
func queueStateOf(r *Room) protocol.StageQueueData {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stageQueueLocked()
}

// turnOf snapshots the pending turn.
func turnOf(r *Room) *stageTurn {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.turn
}

// waitTurnIdle polls until no turn is pending, bounding the wait so a broken
// TTL timer fails fast instead of hanging the suite.
func waitTurnIdle(t *testing.T, r *Room) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if turnOf(r) == nil {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("pending turn never resolved")
}

// TestInitialsEmoji: the chip is exactly one glyph whoever is in the room.
func TestInitialsEmoji(t *testing.T) {
	cases := map[string]string{
		"João":    "\U0001F1EF", // 🇯
		"Ana":     "\U0001F1E6", // 🇦
		"  zé":    "\U0001F1FF", // 🇿 — leading space trimmed, lowercase folded
		"夏":       fallbackEmoji,
		"42":      fallbackEmoji,
		"":        fallbackEmoji,
		"🙂 pedro": fallbackEmoji,
		"Ávila":   fallbackEmoji, // an accented initial is not A–Z
	}
	for name, want := range cases {
		if got := initialsEmoji(name); got != want {
			t.Fatalf("initialsEmoji(%q) = %q, want %q", name, got, want)
		}
	}
}

// TestQueueCapAndBroadcast: six viewers ask, the line holds the first five,
// and a late joiner is handed the same list in its welcome sequence.
func TestQueueCapAndBroadcast(t *testing.T) {
	hub := queueHub(time.Second)
	room, alice, _ := hub.Join("r1", "a", "alice")
	room.TakeStage(alice)

	var watchers []*Client
	for i := 0; i < 6; i++ {
		_, c, _ := hub.Join("r1", fmt.Sprintf("v%d", i), fmt.Sprintf("Viewer%d", i))
		watchers = append(watchers, c)
	}
	for _, c := range watchers {
		room.RequestStage(c)
		room.RequestStage(c) // a duplicate must not take a second slot
	}

	q := queueOf(room)
	if len(q) != maxQueue {
		t.Fatalf("queue holds %d, want the cap of %d", len(q), maxQueue)
	}
	for i, e := range q {
		if want := fmt.Sprintf("v%d", i); e.UserID != want {
			t.Fatalf("queue[%d] = %q, want %q (FIFO, first five)", i, e.UserID, want)
		}
		if e.InitialsEmoji != "\U0001F1FB" { // 🇻 for "ViewerN"
			t.Fatalf("queue[%d] emoji = %q", i, e.InitialsEmoji)
		}
	}

	_, late, lateOut := hub.Join("r1", "late", "Late")
	hub.Leave(room, late)
	got, ok := lastQueue(t, collect(lateOut))
	if !ok {
		t.Fatal("a joiner received no stage_queue")
	}
	if len(got.Queue) != maxQueue || got.Queue[0].UserID != "v0" {
		t.Fatalf("late joiner saw %+v", got.Queue)
	}
	if got.Mode != protocol.ModeLivre {
		t.Fatalf("mode = %q, want the livre default", got.Mode)
	}
	if got.TimerStartMs == 0 {
		t.Fatal("late joiner got no rodízio clock for a live stage")
	}
}

// TestPublisherCannotQueue: you cannot ask for a turn you are already taking,
// and taking the stage drops you out of the line.
func TestPublisherCannotQueue(t *testing.T) {
	hub := queueHub(time.Second)
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, _ := hub.Join("r1", "b", "bob")

	room.TakeStage(alice)
	room.RequestStage(alice)
	if q := queueOf(room); len(q) != 0 {
		t.Fatalf("the publisher joined its own queue: %+v", q)
	}

	room.RequestStage(bob)
	if q := queueOf(room); len(q) != 1 {
		t.Fatalf("queue = %+v, want just bob", q)
	}
	room.TakeStage(bob) // bob grabs it directly
	if q := queueOf(room); len(q) != 0 {
		t.Fatalf("bob still in the line after taking the stage: %+v", q)
	}
}

// TestPassPromotesQueueHead: one tap calls the head of the line and frees the
// stage — and publishes nobody. The chosen person still has to act.
func TestPassPromotesQueueHead(t *testing.T) {
	hub := queueHub(time.Second)
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, _ := hub.Join("r1", "b", "bob")
	_, carol, carolOut := hub.Join("r1", "c", "carol")

	room.TakeStage(alice)
	room.RequestStage(bob)
	room.RequestStage(carol)

	if ok, code := room.PassStage(alice); !ok {
		t.Fatalf("pass refused: %q", code)
	}
	if got := stageOf(room).PublisherID; got != "" {
		t.Fatalf("stage still held by %q after passing", got)
	}

	turn := turnOf(room)
	if turn == nil || turn.UserID != "b" || turn.Method != protocol.MethodQueue {
		t.Fatalf("turn = %+v, want bob off the queue", turn)
	}
	if q := queueOf(room); len(q) != 1 || q[0].UserID != "c" {
		t.Fatalf("queue = %+v, want carol still waiting", q)
	}

	// Carol — a bystander — heard the call, which is what makes the cue a
	// room-wide event rather than a private notification.
	hub.Leave(room, carol)
	turns, _ := turnsAndCancels(t, collect(carolOut))
	if len(turns) != 1 || turns[0].UserID != "b" || turns[0].TTLMs == 0 {
		t.Fatalf("carol saw turns %+v, want one call for bob with a window", turns)
	}
}

// TestTurnAcceptedOnTakeStage: the called person taking the stage closes the
// turn as accepted and leaves nothing pending.
func TestTurnAcceptedOnTakeStage(t *testing.T) {
	hub := queueHub(2 * time.Second)
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, _ := hub.Join("r1", "b", "bob")
	_, carol, carolOut := hub.Join("r1", "c", "carol")

	room.TakeStage(alice)
	room.RequestStage(bob)
	room.PassStage(alice)
	room.TakeStage(bob)

	if pending := turnOf(room); pending != nil {
		t.Fatalf("turn still pending after it was taken: %+v", pending)
	}
	if got := stageOf(room).PublisherID; got != "b" {
		t.Fatalf("publisher = %q, want bob", got)
	}

	hub.Leave(room, carol)
	_, cancels := turnsAndCancels(t, collect(carolOut))
	if len(cancels) != 1 || cancels[0].Reason != protocol.CancelAccepted {
		t.Fatalf("cancels = %+v, want one 'accepted'", cancels)
	}
}

// TestTurnTimeoutAdvances: nobody claims it, so the line moves on by itself.
func TestTurnTimeoutAdvances(t *testing.T) {
	hub := queueHub(10 * time.Millisecond)
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, _ := hub.Join("r1", "b", "bob")
	_, carol, _ := hub.Join("r1", "c", "carol")
	_, dave, daveOut := hub.Join("r1", "d", "dave")

	room.TakeStage(alice)
	room.RequestStage(bob)
	room.RequestStage(carol)
	room.PassStage(alice)

	waitTurnIdle(t, room) // bob times out, carol is called, carol times out
	hub.Leave(room, dave)

	turns, cancels := turnsAndCancels(t, collect(daveOut))
	if len(turns) != 2 || turns[0].UserID != "b" || turns[1].UserID != "c" {
		t.Fatalf("turns = %+v, want bob then carol", turns)
	}
	if len(cancels) != 2 {
		t.Fatalf("cancels = %+v, want two timeouts", cancels)
	}
	for _, c := range cancels {
		if c.Reason != protocol.CancelTimeout {
			t.Fatalf("cancel reason = %q, want %q", c.Reason, protocol.CancelTimeout)
		}
	}
	if q := queueOf(room); len(q) != 0 {
		t.Fatalf("queue = %+v, want drained", q)
	}
}

// TestTurnHolderDisconnect: closing the tab mid-turn cancels it and calls the
// next person immediately rather than burning the whole window on a ghost.
func TestTurnHolderDisconnect(t *testing.T) {
	hub := queueHub(5 * time.Second)
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, _ := hub.Join("r1", "b", "bob")
	_, carol, _ := hub.Join("r1", "c", "carol")
	_, dave, daveOut := hub.Join("r1", "d", "dave")

	room.TakeStage(alice)
	room.RequestStage(bob)
	room.RequestStage(carol)
	room.PassStage(alice)

	hub.Leave(room, bob) // bob vanishes mid-turn
	if turn := turnOf(room); turn == nil || turn.UserID != "c" {
		t.Fatalf("turn = %+v, want carol called immediately", turn)
	}

	hub.Leave(room, dave)
	turns, cancels := turnsAndCancels(t, collect(daveOut))
	if len(turns) != 2 || turns[1].UserID != "c" {
		t.Fatalf("turns = %+v, want the line to have advanced to carol", turns)
	}
	if len(cancels) != 1 || cancels[0].Reason != protocol.CancelLeft {
		t.Fatalf("cancels = %+v, want one 'left'", cancels)
	}
}

// TestQueuePurgeOnDisconnect: a plain waiter leaving shrinks the line, and so
// does withdrawing on purpose.
func TestQueuePurgeOnDisconnect(t *testing.T) {
	hub := queueHub(time.Second)
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, _ := hub.Join("r1", "b", "bob")
	_, carol, _ := hub.Join("r1", "c", "carol")

	room.TakeStage(alice)
	room.RequestStage(bob)
	room.RequestStage(carol)
	hub.Leave(room, bob)

	q := queueOf(room)
	if len(q) != 1 || q[0].UserID != "c" {
		t.Fatalf("queue = %+v, want only carol", q)
	}
	room.WithdrawStage(carol)
	if q := queueOf(room); len(q) != 0 {
		t.Fatalf("queue = %+v after withdraw, want empty", q)
	}
}

// TestStageChangedCancelsTurn: somebody else grabbing the stage mid-call voids
// the call and restarts the line under the new publisher.
func TestStageChangedCancelsTurn(t *testing.T) {
	hub := queueHub(5 * time.Second)
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, _ := hub.Join("r1", "b", "bob")
	_, carol, _ := hub.Join("r1", "c", "carol")
	_, dave, daveOut := hub.Join("r1", "d", "dave")

	room.TakeStage(alice)
	room.RequestStage(bob)
	room.RequestStage(carol)
	room.PassStage(alice) // bob is called

	room.TakeStage(dave) // dave barges in

	if turn := turnOf(room); turn == nil || turn.UserID != "c" {
		t.Fatalf("turn = %+v, want carol called under the new publisher", turn)
	}

	hub.Leave(room, dave)
	turns, cancels := turnsAndCancels(t, collect(daveOut))
	if len(turns) != 2 || turns[0].UserID != "b" || turns[1].UserID != "c" {
		t.Fatalf("turns = %+v", turns)
	}
	if len(cancels) == 0 || cancels[0].Reason != protocol.CancelStageChanged {
		t.Fatalf("cancels = %+v, want the first to be 'stage_changed'", cancels)
	}
}

// TestPassRejections: only the publisher passes, only once per cooldown, and
// only when there is somebody to pass to.
func TestPassRejections(t *testing.T) {
	hub := queueHub(time.Second)
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, _ := hub.Join("r1", "b", "bob")

	if ok, code := room.PassStage(bob); ok || code != "" {
		t.Fatalf("a non-publisher passed the stage (ok=%v code=%q)", ok, code)
	}

	room.TakeStage(alice)
	// livre mode with nobody in line: there is genuinely nobody to pass to,
	// and the sharer must be told rather than left tapping a dead button.
	if ok, code := room.PassStage(alice); ok || code != protocol.ErrNoNextUser {
		t.Fatalf("pass into an empty room: ok=%v code=%q", ok, code)
	}

	room.RequestStage(bob)
	if ok, code := room.PassStage(alice); !ok {
		t.Fatalf("pass refused with somebody in line: %q", code)
	}

	// Passing again straight away is the double-tap guard, not a real pass.
	room.TakeStage(alice)
	room.RequestStage(bob)
	if ok, code := room.PassStage(alice); ok || code != protocol.ErrPassTooSoon {
		t.Fatalf("double pass: ok=%v code=%q, want the cooldown", ok, code)
	}

	// The window is real, not a one-shot latch.
	room.mu.Lock()
	room.lastPass = time.Now().Add(-passCooldown - time.Millisecond)
	room.mu.Unlock()
	if ok, code := room.PassStage(alice); !ok {
		t.Fatalf("pass refused after the cooldown elapsed: %q", code)
	}
}

// TestGhostCannotQueue: a client that already left must not be able to act on
// the room it left — the same membership check TakeStage and PlayStinger make.
func TestGhostCannotQueue(t *testing.T) {
	hub := queueHub(time.Second)
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, _ := hub.Join("r1", "b", "bob")

	hub.Leave(room, bob)
	room.RequestStage(bob)
	if q := queueOf(room); len(q) != 0 {
		t.Fatalf("a departed client joined the line: %+v", q)
	}
	room.SetStageMode(bob, protocol.ModeRodizio)
	if mode := queueStateOf(room).Mode; mode != protocol.ModeLivre {
		t.Fatalf("a departed client changed the room mode to %q", mode)
	}
	hub.Leave(room, alice)
}

// TestRodizioModeAndClock: the mode is room-wide state, the clock starts on
// TakeStage and stops when the stage frees, and the +5 is spendable once.
func TestRodizioModeAndClock(t *testing.T) {
	hub := queueHub(time.Second)
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, bobOut := hub.Join("r1", "b", "bob")

	room.SetStageMode(bob, protocol.ModeRodizio) // any member may flip it
	room.SetStageMode(bob, "nonsense")           // ignored, not trusted

	room.TakeStage(alice)
	s := queueStateOf(room)
	if s.Mode != protocol.ModeRodizio {
		t.Fatalf("mode = %q, want rodizio", s.Mode)
	}
	if s.TimerStartMs == 0 {
		t.Fatal("the clock did not start on TakeStage")
	}
	if s.TurnLenMs != int(rodizioTurn/time.Millisecond) {
		t.Fatalf("turn length = %d ms, want %v", s.TurnLenMs, rodizioTurn)
	}

	if ok, code := room.ExtendStage(bob); ok || code != "" {
		t.Fatalf("a non-publisher extended the turn (ok=%v code=%q)", ok, code)
	}
	if ok, _ := room.ExtendStage(alice); !ok {
		t.Fatal("the publisher could not spend its +5")
	}
	if s := queueStateOf(room); !s.Extended ||
		s.TurnLenMs != int((rodizioTurn+rodizioExtension)/time.Millisecond) {
		t.Fatalf("after +5: extended=%v len=%d ms", s.Extended, s.TurnLenMs)
	}
	if ok, code := room.ExtendStage(alice); ok || code != protocol.ErrAlreadyExt {
		t.Fatalf("second +5: ok=%v code=%q, want a refusal", ok, code)
	}

	room.LeaveStage(alice)
	if s := queueStateOf(room); s.TimerStartMs != 0 || s.Extended {
		t.Fatalf("the clock survived the stage emptying: %+v", s)
	}

	hub.Leave(room, bob)
	if got, _ := lastQueue(t, collect(bobOut)); got.Mode != protocol.ModeRodizio {
		t.Fatalf("bob's last broadcast mode = %q, want rodizio", got.Mode)
	}
}

// TestRodizioWheelPicksSomeoneElse: passing with an empty line in rodízio mode
// spins for a real member and never lands on the sharer who is leaving, nor on
// a companion capture tab (which has no UI to be called into). Livre mode
// refuses the same pass instead — the wheel is the rodízio layer, not the core.
func TestRodizioWheelPicksSomeoneElse(t *testing.T) {
	for i := 0; i < 30; i++ {
		hub := queueHub(5 * time.Second)
		room, alice, _ := hub.Join("r1", "a", "alice")
		hub.Join("r1", "b", "bob")
		hub.Join("r1", "c", "carol")
		hub.Join("r1", "a:tab", "alice (sharing)")

		room.SetStageMode(alice, protocol.ModeRodizio)
		room.TakeStage(alice)
		if ok, code := room.PassStage(alice); !ok {
			t.Fatalf("rodízio pass into an empty line refused: %q", code)
		}
		turn := turnOf(room)
		if turn == nil {
			t.Fatal("no turn after a wheel pass")
		}
		if turn.Method != protocol.MethodWheel {
			t.Fatalf("method = %q, want %q", turn.Method, protocol.MethodWheel)
		}
		if turn.UserID != "b" && turn.UserID != "c" {
			t.Fatalf("wheel landed on %q — want bob or carol, never the sharer or a capture tab", turn.UserID)
		}
	}

	// The same room in livre mode has nobody to pass to.
	hub := queueHub(time.Second)
	room, alice, _ := hub.Join("r2", "a", "alice")
	hub.Join("r2", "b", "bob")
	room.TakeStage(alice)
	if ok, code := room.PassStage(alice); ok || code != protocol.ErrNoNextUser {
		t.Fatalf("livre mode spun the wheel: ok=%v code=%q", ok, code)
	}
}

// TestQueueSurvivesSupersede: a reconnect (same identity, new connection) keeps
// the person's place in the line — a blip must not cost you your turn.
func TestQueueSurvivesSupersede(t *testing.T) {
	hub := queueHub(time.Second)
	room, alice, _ := hub.Join("r1", "a", "alice")
	_, bob, _ := hub.Join("r1", "b", "bob")

	room.TakeStage(alice)
	room.RequestStage(bob)

	_, bob2, _ := hub.Join("r1", "b", "bob") // supersedes the first connection
	if q := queueOf(room); len(q) != 1 || q[0].UserID != "b" {
		t.Fatalf("queue = %+v, want bob's place kept across the reconnect", q)
	}
	if ok, code := room.PassStage(alice); !ok {
		t.Fatalf("pass to the reconnected client refused: %q", code)
	}
	if turn := turnOf(room); turn == nil || turn.UserID != "b" {
		t.Fatalf("turn = %+v, want bob", turn)
	}
	room.TakeStage(bob2)
	if got := stageOf(room).PublisherID; got != "b" {
		t.Fatalf("publisher = %q, want the reconnected bob", got)
	}
}

// TestStageQueueConcurrent hammers every queue entry point against join/leave
// churn while turn timers keep firing — where a lock-order or
// send-on-closed-channel mistake would show up. Run with -race.
func TestStageQueueConcurrent(t *testing.T) {
	hub := queueHub(time.Millisecond)
	hub.StingerStopDelay = time.Millisecond

	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 300; i++ {
				id := fmt.Sprintf("q%d-%d", g, i)
				room, c, seq := hub.Join("contested", id, id)
				done := make(chan struct{})
				go func() {
					seq(func(OutMsg) bool { return true })
					close(done)
				}()
				room.RequestStage(c)
				if g%3 == 0 {
					room.SetStageMode(c, protocol.ModeRodizio)
					room.TakeStage(c)
					room.ExtendStage(c)
					room.PassStage(c)
				} else {
					room.SetStageMode(c, protocol.ModeLivre)
					room.WithdrawStage(c)
				}
				hub.Leave(room, c)
				// Everything after Leave must be a silent no-op.
				room.RequestStage(c)
				room.PassStage(c)
				room.ExtendStage(c)
				room.WithdrawStage(c)
				<-done
			}
		}(g)
	}
	wg.Wait()

	// Let every armed turn timer fire against the reaped rooms.
	time.Sleep(50 * time.Millisecond)
	if n := hub.Rooms(); n != 0 {
		t.Fatalf("%d rooms leaked after all clients left", n)
	}
}
