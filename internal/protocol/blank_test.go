package protocol

import (
	"encoding/json"
	"testing"
)

// The panic button's wire shape. `On:false` matters as much as `On:true`:
// with an `omitempty` tag the un-blank message would serialize to `{}` and a
// room could never be un-hidden.
func TestBlankDataRoundTrip(t *testing.T) {
	for _, on := range []bool{true, false} {
		raw, err := MarshalControl(CtrlBlank, BlankData{On: on})
		if err != nil {
			t.Fatalf("marshal blank(%v): %v", on, err)
		}
		var ctrl Control
		if err := json.Unmarshal(raw, &ctrl); err != nil {
			t.Fatalf("unmarshal envelope: %v", err)
		}
		if ctrl.Type != CtrlBlank {
			t.Fatalf("type = %q, want %q", ctrl.Type, CtrlBlank)
		}
		var got BlankData
		if err := json.Unmarshal(ctrl.Data, &got); err != nil {
			t.Fatalf("unmarshal payload: %v", err)
		}
		if got.On != on {
			t.Fatalf("On = %v, want %v", got.On, on)
		}
	}
}

func TestBlankStateRoundTrip(t *testing.T) {
	raw, err := MarshalControl(CtrlBlankState, BlankData{On: true})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var ctrl Control
	if err := json.Unmarshal(raw, &ctrl); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if ctrl.Type != CtrlBlankState {
		t.Fatalf("type = %q, want %q", ctrl.Type, CtrlBlankState)
	}
	var got BlankData
	if err := json.Unmarshal(ctrl.Data, &got); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if !got.On {
		t.Fatal("On = false, want true")
	}
}

// Late joiners learn the blank from the ordinary handshake, so Blanked has to
// survive being embedded in WelcomeData.
func TestWelcomeCarriesBlanked(t *testing.T) {
	raw, err := MarshalControl(CtrlWelcome, WelcomeData{
		StageStateData: StageStateData{PublisherID: "a:tab", Blanked: true},
		SelfID:         "b",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var ctrl Control
	if err := json.Unmarshal(raw, &ctrl); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	var got WelcomeData
	if err := json.Unmarshal(ctrl.Data, &got); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if !got.Blanked {
		t.Fatalf("Blanked lost inside WelcomeData: %s", raw)
	}
	if got.SelfID != "b" || got.PublisherID != "a:tab" {
		t.Fatalf("welcome fields mangled: %+v", got)
	}
}
