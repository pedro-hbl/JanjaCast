package server

import (
	"log/slog"
	"net/http/httptest"
	"testing"
)

// The companion capture page and the telinha mirror are client-side routes:
// both must serve index.html, uncached. /telinha silently 404ing once already
// cost a production feature — this pins every SPA path the client router owns.
func TestSPARoutesServeIndex(t *testing.T) {
	s := New(Config{Addr: ":0"}, slog.New(slog.DiscardHandler))
	for _, path := range []string{"/", "/share", "/telinha"} {
		req := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, req)
		res := w.Result()
		if res.StatusCode != 200 {
			t.Fatalf("%s: status %d, want 200", path, res.StatusCode)
		}
		if cc := res.Header.Get("Cache-Control"); cc != "no-store" {
			t.Fatalf("%s: Cache-Control %q, want no-store", path, cc)
		}
	}
}
