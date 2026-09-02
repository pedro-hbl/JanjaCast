package server

import (
    "net/http/httptest"
    "testing"
    "time"
    "log/slog"
    relay "github.com/pedro-hbl/janjacast/internal/relay"
)

func TestServeClipNotFound(t *testing.T) {
    s := New(Config{Addr: ":0"}, slog.New(slog.DiscardHandler))
    req := httptest.NewRequest("GET", "/clip/doesnotexist", nil)
    w := httptest.NewRecorder()
    s.ServeHTTP(w, req)
    if w.Result().StatusCode != 404 { t.Fatalf("status %d, want 404", w.Result().StatusCode) }
}

func TestServeClipOK(t *testing.T) {
    s := New(Config{Addr: ":0"}, slog.New(slog.DiscardHandler))
    room, _, _ := s.hub.Join("room1", "u1", "alice")
    room.ClipsTestInit()
    // store a clip via test helper
    // Use relay API within same package via a small wrapper here
    // Use symbol defined in relay package for tests; linkname not needed here since it's exported.
    token := relay.RoomTokenTestShim(room, []byte("JCLP\x00\x00\x00\x00"), "application/octet-stream", time.Minute)
    req := httptest.NewRequest("GET", "/clip/"+token, nil)
    w := httptest.NewRecorder()
    s.ServeHTTP(w, req)
    if w.Result().StatusCode != 200 { t.Fatalf("status %d, want 200", w.Result().StatusCode) }
    if ct := w.Header().Get("Content-Type"); ct != "application/octet-stream" { t.Fatalf("ct %q", ct) }
}

// MintTestClipLocked helper on Room for tests
// Note: test helper methods are added on relay.Room in relay.go behind build tags in real code; kept inline here for simplicity.
