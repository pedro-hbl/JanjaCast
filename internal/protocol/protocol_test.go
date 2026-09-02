package protocol

import (
	"encoding/json"
	"testing"
)

// roundTrip marshals a control envelope the way the relay does and unmarshals
// the payload back into a fresh value of the same type, returning it.
func roundTrip[T any](t *testing.T, typ ControlType, in T) T {
	t.Helper()
	raw, err := MarshalControl(typ, in)
	if err != nil {
		t.Fatalf("MarshalControl(%s): %v", typ, err)
	}
	var ctrl Control
	if err := json.Unmarshal(raw, &ctrl); err != nil {
		t.Fatalf("unmarshal envelope(%s): %v", typ, err)
	}
	if ctrl.Type != typ {
		t.Fatalf("envelope type = %q, want %q", ctrl.Type, typ)
	}
	var out T
	if err := json.Unmarshal(ctrl.Data, &out); err != nil {
		t.Fatalf("unmarshal payload(%s): %v", typ, err)
	}
	return out
}

// TestStageQueueRoundTrip: every stage-queue payload survives the wire with
// its fields intact — the client mirror in web/src/protocol.ts is typed off
// these JSON names, so a renamed tag is a silent break.
func TestStageQueueRoundTrip(t *testing.T) {
	in := StageQueueData{
		Queue: []QueueEntry{
			{UserID: "u1", Username: "João", InitialsEmoji: "🇯"},
			{UserID: "u2", Username: "Ana", InitialsEmoji: "🇦"},
		},
		Mode:         ModeRodizio,
		TimerStartMs: 1_700_000_000_000,
		TurnLenMs:    25 * 60 * 1000,
		Extended:     true,
		TurnUserID:   "u1",
		TurnEndsMs:   1_700_000_020_000,
	}
	got := roundTrip(t, CtrlStageQueue, in)

	if len(got.Queue) != 2 || got.Queue[0] != in.Queue[0] || got.Queue[1] != in.Queue[1] {
		t.Fatalf("queue = %+v, want %+v", got.Queue, in.Queue)
	}
	if got.Mode != in.Mode || got.TimerStartMs != in.TimerStartMs ||
		got.TurnLenMs != in.TurnLenMs || !got.Extended ||
		got.TurnUserID != in.TurnUserID || got.TurnEndsMs != in.TurnEndsMs {
		t.Fatalf("state = %+v, want %+v", got, in)
	}
}

// An empty queue must serialize as a present (possibly null) field rather
// than vanishing: the client replaces its whole list from every broadcast, so
// a missing key and an empty list have to mean the same thing.
func TestStageQueueEmptyRoundTrip(t *testing.T) {
	got := roundTrip(t, CtrlStageQueue, StageQueueData{Mode: ModeLivre, TurnLenMs: 1200000})
	if len(got.Queue) != 0 {
		t.Fatalf("queue = %+v, want empty", got.Queue)
	}
	if got.Mode != ModeLivre || got.TimerStartMs != 0 || got.Extended {
		t.Fatalf("state = %+v, want a free livre stage", got)
	}
}

func TestStageTurnRoundTrip(t *testing.T) {
	in := StageTurnData{UserID: "u7", Username: "pedro", TTLMs: 20000, Method: MethodWheel}
	if got := roundTrip(t, CtrlStageTurn, in); got != in {
		t.Fatalf("turn = %+v, want %+v", got, in)
	}
}

func TestStageCancelRoundTrip(t *testing.T) {
	for _, reason := range []string{CancelTimeout, CancelLeft, CancelAccepted, CancelStageChanged} {
		in := StageCancelData{UserID: "u9", Reason: reason}
		if got := roundTrip(t, CtrlStageCancel, in); got != in {
			t.Fatalf("cancel = %+v, want %+v", got, in)
		}
	}
}

func TestStageModeRoundTrip(t *testing.T) {
	for _, mode := range []string{ModeLivre, ModeRodizio} {
		in := StageModeData{Mode: mode}
		if got := roundTrip(t, CtrlStageMode, in); got != in {
			t.Fatalf("mode = %+v, want %+v", got, in)
		}
	}
}

// The error envelope grew a Code field; the old Message-only shape must keep
// working, and a code-only error must not ship an empty "message".
func TestErrorRoundTrip(t *testing.T) {
	if got := roundTrip(t, CtrlError, ErrorData{Message: "bad thing"}); got.Message != "bad thing" || got.Code != "" {
		t.Fatalf("error = %+v, want message only", got)
	}
	raw, err := MarshalControl(CtrlError, ErrorData{Code: ErrNoNextUser})
	if err != nil {
		t.Fatal(err)
	}
	var ctrl Control
	if err := json.Unmarshal(raw, &ctrl); err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(ctrl.Data, &fields); err != nil {
		t.Fatal(err)
	}
	if _, ok := fields["message"]; ok {
		t.Fatalf("code-only error carried an empty message: %v", fields)
	}
	if fields["code"] != ErrNoNextUser {
		t.Fatalf("code = %v, want %q", fields["code"], ErrNoNextUser)
	}
}

// The control names are the wire contract with web/src/protocol.ts. Changing
// one is a protocol break, so they are pinned here rather than only spelled
// once in the const block.
func TestStageControlNames(t *testing.T) {
    want := map[ControlType]string{
		CtrlStageRequest:  "stage_request",
		CtrlStageWithdraw: "stage_withdraw",
		CtrlStagePass:     "stage_pass",
		CtrlStageMode:     "stage_mode",
		CtrlStageExtend:   "stage_extend",
		CtrlStageQueue:    "stage_queue",
		CtrlStageTurn:     "stage_turn",
        CtrlStageCancel:   "stage_cancel",
        CtrlReaction:      "reaction",
        CtrlReactionBurst: "reaction_burst",
    }
    for got, name := range want {
        if string(got) != name {
            t.Fatalf("control %q renamed (want %q)", got, name)
        }
    }
}

func TestReactionRoundTripAndValidate(t *testing.T) {
    // Round-trip a client tap.
    in := ReactionData{Emoji: "fire"}
    if got := roundTrip(t, CtrlReaction, in); got != in {
        t.Fatalf("reaction = %+v, want %+v", got, in)
    }
    // Round-trip an aggregated burst.
    burst := ReactionBurstData{Counts: map[string]int{"fire": 3, "laugh": 1}, Density: 4, WindowMs: 1500}
    if got := roundTrip(t, CtrlReactionBurst, burst); got.Density != 4 || got.WindowMs != 1500 || got.Counts["fire"] != 3 || got.Counts["laugh"] != 1 {
        t.Fatalf("burst = %+v, want %+v", got, burst)
    }
    // Validator accepts curated set and rejects unknown.
    for _, ok := range []struct{
        s string
        v bool
    }{{"fire", true}, {"laugh", true}, {"heart", true}, {"skull", true}, {"clap", true}, {"shock", true}, {"poop", false}} {
        if ValidReactionEmoji(ok.s) != ok.v {
            t.Fatalf("ValidReactionEmoji(%q) = %v, want %v", ok.s, !ok.v, ok.v)
        }
    }
}
