package server

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newStingerServer(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"meme one.webp": "not-really-webp",
		"horn.mp3":      "not-really-mp3",
		"notes.txt":     "ignored kind",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// A secret OUTSIDE the stinger dir that traversal must never reach.
	secret := filepath.Join(filepath.Dir(dir), "secret-"+filepath.Base(dir)+".env")
	if err := os.WriteFile(secret, []byte("TOP=secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(secret) })

	s := New(Config{AllowAnon: true, StingerDir: dir}, slog.New(slog.DiscardHandler))
	return s, secret
}

func TestStingerServeAndTraversal(t *testing.T) {
	s, secret := newStingerServer(t)

	get := func(path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, req)
		return w
	}

	// A listed image is served with the right type and cache policy.
	w := get("/stingers/meme%20one.webp")
	if w.Code != http.StatusOK {
		t.Fatalf("image fetch: %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "image/webp" {
		t.Fatalf("Content-Type = %q, want image/webp", ct)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "public, max-age=3600" {
		t.Fatalf("Cache-Control = %q", cc)
	}
	if w.Body.String() != "not-really-webp" {
		t.Fatalf("wrong body: %q", w.Body.String())
	}

	if w := get("/stingers/horn.mp3"); w.Code != http.StatusOK ||
		w.Header().Get("Content-Type") != "audio/mpeg" {
		t.Fatalf("audio fetch: %d %q", w.Code, w.Header().Get("Content-Type"))
	}

	// Present in the directory but not a stinger kind: refused.
	if w := get("/stingers/notes.txt"); w.Code != http.StatusNotFound {
		t.Fatalf("txt served: %d", w.Code)
	}
	// Not in the directory at all: refused.
	if w := get("/stingers/ghost.webp"); w.Code != http.StatusNotFound {
		t.Fatalf("unlisted name served: %d", w.Code)
	}
	// Traversal, encoded and plain: refused (any non-404 success is a leak).
	for _, path := range []string{
		"/stingers/..%2F" + filepath.Base(secret),
		"/stingers/../" + filepath.Base(secret),
		"/stingers/..%5C..%5C.env",
		"/stingers/%2e%2e%2f.env",
	} {
		if w := get(path); w.Code == http.StatusOK {
			t.Fatalf("traversal %q served: %d %q", path, w.Code, w.Body.String())
		}
	}
}

func TestPickStinger(t *testing.T) {
	s, _ := newStingerServer(t)
	d := s.pickStinger("start")
	if d == nil {
		t.Fatal("pick returned nil with assets present")
	}
	if d.Kind != "start" {
		t.Fatalf("kind = %q", d.Kind)
	}
	if d.Image != "/stingers/meme%20one.webp" {
		t.Fatalf("image = %q", d.Image)
	}
	if d.Audio != "/stingers/horn.mp3" {
		t.Fatalf("audio = %q", d.Audio)
	}
	// And the picked URL round-trips through the handler.
	req := httptest.NewRequest(http.MethodGet, d.Image, nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("picked image not servable: %d", w.Code)
	}
}

func TestPickStingerEmptyDir(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "readme.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := New(Config{AllowAnon: true, StingerDir: dir}, slog.New(slog.DiscardHandler))
	if d := s.pickStinger("start"); d != nil {
		t.Fatalf("pick from kindless dir = %+v, want nil", d)
	}
	if d := s.pickStinger("stop"); d != nil && !strings.HasPrefix(d.Image, "/stingers/") {
		t.Fatalf("unexpected pick %+v", d)
	}
}
