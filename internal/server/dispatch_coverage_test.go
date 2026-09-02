package server

// The single most expensive class of defect this repo has shipped is a
// control type that existed in the protocol, was fully implemented in the
// relay, and was never routed by the dispatch switch below — dead on
// arrival, invisible to unit tests on either side (the reactions feature
// shipped exactly like that). This test closes the gap mechanically: every
// client→server CtrlXxx constant must appear in a `case protocol.CtrlXxx`
// inside server.go.

import (
	"os"
	"regexp"
	"testing"
)

// Server→client-only control types: the dispatch switch legitimately never
// sees these. Adding a name here needs the same scrutiny as deleting a test —
// if a type is in doubt, wire it instead.
var serverToClientOnly = map[string]bool{
	"CtrlPong":            true,
	"CtrlWelcome":         true,
	"CtrlStageState":      true,
	"CtrlRoomState":       true,
	"CtrlStageTaken":      true,
	"CtrlRateHint":        true,
	"CtrlTokenRefresh":    true,
	"CtrlSuperseded":      true,
	"CtrlStinger":         true,
	"CtrlBlankState":      true,
	"CtrlStageQueue":      true,
	"CtrlStageTurn":       true,
	"CtrlStageCancel":     true,
	"CtrlReactionBurst":   true,
	"CtrlPlacarState":     true,
	"CtrlCinemaState":     true,
	"CtrlCinemaStrokeAdd": true,
	"CtrlRoomPhase":       true,
	"CtrlAwardsReady":     true,
	"CtrlClipReady":       true,
	"CtrlError":           true,
	"CtrlJoin":            true, // consumed by handleWS before the switch
}

func TestDispatchCoverage(t *testing.T) {
	proto, err := os.ReadFile("../protocol/protocol.go")
	if err != nil {
		t.Fatalf("read protocol.go: %v", err)
	}
	srv, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatalf("read server.go: %v", err)
	}

	declared := regexp.MustCompile(`(Ctrl[A-Za-z0-9]+)\s+ControlType\s*=`).FindAllStringSubmatch(string(proto), -1)
	if len(declared) < 10 {
		t.Fatalf("suspiciously few ControlType constants found (%d) — did the declaration shape change?", len(declared))
	}
	for _, m := range declared {
		name := m[1]
		if serverToClientOnly[name] {
			continue
		}
		dispatched := regexp.MustCompile(`case\s+protocol\.` + name + `\b`).Match(srv)
		if !dispatched {
			t.Errorf("%s is declared in protocol.go but never dispatched in server.go — the feature is dead on arrival; add a case (or, only if it is truly server->client, add it to serverToClientOnly with justification)", name)
		}
	}
}
