package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pedro-hbl/janjacast/internal/stinger"
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

// ------------------------- management API ----------------------------------

// Real magic bytes: http.DetectContentType must AGREE with the extension, so
// these tests cannot use the placeholder strings the serving tests use.
var (
	gifBytes = []byte("GIF89a" + strings.Repeat("\x00", 32))
	pngBytes = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 32)...)
	mp3Bytes = []byte("ID3\x04\x00\x00\x00\x00\x00\x00" + strings.Repeat("\x00", 32))
)

// apiServer is an anonymous (dev) server over an empty stinger dir.
func apiServer(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	return New(Config{AllowAnon: true, StingerDir: dir}, slog.New(slog.DiscardHandler)), dir
}

func do(s *Server, method, path string, body io.Reader, ctype string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, body)
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	return w
}

// multipartBody builds one upload request body from name → content pairs.
func multipartBody(t *testing.T, files [][2]any) (io.Reader, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for _, f := range files {
		part, err := mw.CreateFormFile("file", f[0].(string))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(f[1].([]byte)); err != nil {
			t.Fatal(err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf, mw.FormDataContentType()
}

func upload(t *testing.T, s *Server, files [][2]any) *httptest.ResponseRecorder {
	t.Helper()
	body, ctype := multipartBody(t, files)
	return do(s, http.MethodPost, "/api/stingers", body, ctype)
}

func listAssets(t *testing.T, s *Server) []stinger.Asset {
	t.Helper()
	w := do(s, http.MethodGet, "/api/stingers", nil, "")
	if w.Code != http.StatusOK {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}
	var resp struct {
		Assets   []stinger.Asset `json:"assets"`
		Max      int             `json:"max"`
		MaxBytes int64           `json:"maxBytes"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Max != stinger.MaxAssets || resp.MaxBytes != stinger.MaxAssetBytes {
		t.Fatalf("limits not advertised: %+v", resp)
	}
	return resp.Assets
}

// TestStingerUploadAndList: a good image and a good sound land, are listed
// with default flags, and are immediately servable at the URL they advertise.
func TestStingerUploadAndList(t *testing.T) {
	s, _ := apiServer(t)

	w := upload(t, s, [][2]any{{"My Meme!!.gif", gifBytes}, {"horn.mp3", mp3Bytes}})
	if w.Code != http.StatusOK {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}

	assets := listAssets(t, s)
	if len(assets) != 2 {
		t.Fatalf("listed %d assets, want 2: %+v", len(assets), assets)
	}
	byName := map[string]stinger.Asset{}
	for _, a := range assets {
		byName[a.Name] = a
		// Backward compat: a directory with no settings file behaves exactly
		// like before — everything on, everything in both pools.
		if !a.Enabled || !a.PlayOnStart || !a.PlayOnStop {
			t.Fatalf("fresh upload %q has non-default flags: %+v", a.Name, a.Flags)
		}
		if got := do(s, http.MethodGet, a.URL, nil, ""); got.Code != http.StatusOK {
			t.Fatalf("advertised URL %q not servable: %d", a.URL, got.Code)
		}
	}
	// The client-supplied name is sanitized, never used as a path.
	if _, ok := byName["My-Meme.gif"]; !ok {
		t.Fatalf("name not sanitized as expected: %v", byName)
	}
	if a := byName["horn.mp3"]; a.Type != stinger.TypeAudio || a.ContentType != "audio/mpeg" {
		t.Fatalf("mp3 classified as %+v", a)
	}
}

// TestStingerUploadRejects: every rejection path, one request each.
func TestStingerUploadRejects(t *testing.T) {
	s, dir := apiServer(t)

	cases := []struct {
		what string
		name string
		body []byte
	}{
		// Extension is fine, bytes are not: the stored-XSS shape.
		{"html masquerading as png", "evil.png", []byte("<!DOCTYPE html><html><body>hi</body></html>")},
		// Bytes are fine, extension is a different category.
		{"audio bytes named .png", "wrong.png", mp3Bytes},
		// Extension is not a stinger kind at all.
		{"executable", "run.exe", []byte("MZ\x90\x00")},
		{"text", "notes.txt", []byte("just words")},
	}
	for _, c := range cases {
		w := upload(t, s, [][2]any{{c.name, c.body}})
		if w.Code == http.StatusOK {
			t.Fatalf("%s accepted: %s", c.what, w.Body.String())
		}
	}
	// A path in the filename is not a path: only the base name survives, so
	// this one is ACCEPTED — as "passwd.gif" inside the stinger folder.
	if w := upload(t, s, [][2]any{{"../../etc/passwd.gif", gifBytes}}); w.Code != http.StatusOK {
		t.Fatalf("sanitizable name refused: %s", w.Body.String())
	}
	assets := listAssets(t, s)
	if len(assets) != 1 || assets[0].Name != "passwd.gif" {
		t.Fatalf("traversal in a filename escaped sanitization: %+v", assets)
	}
	// And nothing was written outside the folder, nor left as a temp file.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "passwd.gif" {
		t.Fatalf("stinger dir holds %v after rejected uploads", entries)
	}
}

// TestStingerUploadTooLarge: the per-file ceiling is enforced by streaming,
// not by buffering, so an oversized body is refused and leaves nothing.
func TestStingerUploadTooLarge(t *testing.T) {
	s, dir := apiServer(t)
	big := append(append([]byte{}, pngBytes...), bytes.Repeat([]byte{7}, int(stinger.MaxAssetBytes)+1024)...)

	w := upload(t, s, [][2]any{{"huge.png", big}})
	if w.Code == http.StatusOK {
		t.Fatalf("oversized upload accepted: %s", w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "too large") {
		t.Fatalf("unexpected rejection reason: %s", w.Body.String())
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("oversized upload left %d files behind", len(entries))
	}
}

// TestStingerUploadCollision: uploading the same name twice never overwrites.
func TestStingerUploadCollision(t *testing.T) {
	s, _ := apiServer(t)
	upload(t, s, [][2]any{{"same.gif", gifBytes}})
	upload(t, s, [][2]any{{"same.gif", gifBytes}})

	names := map[string]bool{}
	for _, a := range listAssets(t, s) {
		names[a.Name] = true
	}
	if !names["same.gif"] || !names["same-2.gif"] || len(names) != 2 {
		t.Fatalf("collision handling produced %v", names)
	}
}

// TestStingerFlagsPersistAndFilterPicks: flags survive as a JSON file in the
// stinger dir, and the server's pick draws only from the pool the moment
// selects.
func TestStingerFlagsPersistAndFilterPicks(t *testing.T) {
	s, dir := apiServer(t)
	upload(t, s, [][2]any{
		{"start-only.gif", gifBytes},
		{"stop-only.png", pngBytes},
		{"off.mp3", mp3Bytes},
	})

	patch := func(name, body string) stinger.Asset {
		t.Helper()
		w := do(s, http.MethodPatch, "/api/stingers/"+name, strings.NewReader(body), "application/json")
		if w.Code != http.StatusOK {
			t.Fatalf("patch %s: %d %s", name, w.Code, w.Body.String())
		}
		var a stinger.Asset
		if err := json.Unmarshal(w.Body.Bytes(), &a); err != nil {
			t.Fatal(err)
		}
		return a
	}

	// A single-key patch must not clobber its neighbours.
	if a := patch("start-only.gif", `{"playOnStop":false}`); a.PlayOnStop || !a.PlayOnStart || !a.Enabled {
		t.Fatalf("partial patch clobbered flags: %+v", a.Flags)
	}
	patch("stop-only.png", `{"playOnStart":false}`)
	patch("off.mp3", `{"enabled":false}`)

	// The settings file exists, is valid JSON, and is not itself an asset.
	raw, err := os.ReadFile(filepath.Join(dir, ".janjacast-stingers.json"))
	if err != nil {
		t.Fatalf("settings file: %v", err)
	}
	var settings struct {
		Version int `json:"version"`
		Assets  map[string]struct {
			Enabled     bool `json:"enabled"`
			PlayOnStart bool `json:"playOnStart"`
			PlayOnStop  bool `json:"playOnStop"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatalf("settings file is not valid JSON: %v\n%s", err, raw)
	}
	if settings.Version != 1 || len(settings.Assets) != 3 {
		t.Fatalf("settings file: %s", raw)
	}
	if len(listAssets(t, s)) != 3 {
		t.Fatal("the settings file leaked into the asset list")
	}
	if w := do(s, http.MethodGet, "/stingers/.janjacast-stingers.json", nil, ""); w.Code == http.StatusOK {
		t.Fatal("the settings file is served as an asset")
	}

	// Picks now honour the pools. The one audio is disabled, so no pick has
	// a sound at all.
	for i := 0; i < 20; i++ {
		start := s.pickStinger("start")
		if start == nil || start.Image != "/stingers/start-only.gif" || start.Audio != "" {
			t.Fatalf("start pick = %+v, want the start-only image and no audio", start)
		}
		stop := s.pickStinger("stop")
		if stop == nil || stop.Image != "/stingers/stop-only.png" || stop.Audio != "" {
			t.Fatalf("stop pick = %+v, want the stop-only image and no audio", stop)
		}
	}

	// Everything disabled = a complete off switch, no extra flag needed.
	patch("start-only.gif", `{"enabled":false}`)
	patch("stop-only.png", `{"enabled":false}`)
	if d := s.pickStinger("start"); d != nil {
		t.Fatalf("pick with everything disabled = %+v, want nil", d)
	}
}

// TestStingerDeleteAndTraversal: delete works, 404s the second time, and
// neither DELETE nor PATCH can be aimed outside the folder.
func TestStingerDeleteAndTraversal(t *testing.T) {
	s, dir := apiServer(t)
	upload(t, s, [][2]any{{"bye.gif", gifBytes}})

	// A secret next to (not inside) the stinger dir.
	secret := filepath.Join(filepath.Dir(dir), "secret-"+filepath.Base(dir)+".gif")
	if err := os.WriteFile(secret, gifBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(secret) })

	for _, name := range []string{
		"..%2F" + filepath.Base(secret),
		"..%5C..%5Csecret.gif",
		"%2e%2e%2fsecret.gif",
		".janjacast-stingers.json",
		"nope.gif",
	} {
		if w := do(s, http.MethodDelete, "/api/stingers/"+name, nil, ""); w.Code != http.StatusNotFound {
			t.Fatalf("DELETE %q = %d, want 404", name, w.Code)
		}
		if w := do(s, http.MethodPatch, "/api/stingers/"+name,
			strings.NewReader(`{"enabled":false}`), "application/json"); w.Code != http.StatusNotFound {
			t.Fatalf("PATCH %q = %d, want 404", name, w.Code)
		}
	}
	if _, err := os.Stat(secret); err != nil {
		t.Fatalf("traversal deleted the file outside the folder: %v", err)
	}

	if w := do(s, http.MethodDelete, "/api/stingers/bye.gif", nil, ""); w.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	if n := len(listAssets(t, s)); n != 0 {
		t.Fatalf("%d assets after deleting the only one", n)
	}
	if w := do(s, http.MethodDelete, "/api/stingers/bye.gif", nil, ""); w.Code != http.StatusNotFound {
		t.Fatalf("second delete: %d", w.Code)
	}
	if w := do(s, http.MethodGet, "/stingers/bye.gif", nil, ""); w.Code != http.StatusNotFound {
		t.Fatalf("deleted asset still served: %d", w.Code)
	}
}

// TestStingerAPIRequiresAuth: on a real (non-anonymous) server every asset
// endpoint demands the same credential a WebSocket join does.
func TestStingerAPIRequiresAuth(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "present.gif"), gifBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	s := New(Config{
		StingerDir:  dir,
		TokenSecret: []byte("test-secret-not-a-real-key-000000"),
	}, slog.New(slog.DiscardHandler))

	endpoints := []struct{ method, path string }{
		{http.MethodGet, "/api/stingers"},
		{http.MethodPatch, "/api/stingers/present.gif"},
		{http.MethodDelete, "/api/stingers/present.gif"},
	}
	for _, e := range endpoints {
		if w := do(s, e.method, e.path, strings.NewReader(`{"enabled":false}`),
			"application/json"); w.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s without a token = %d, want 401", e.method, e.path, w.Code)
		}
		// A garbage bearer token is not a credential either. It never reaches
		// Discord: verifyShareToken rejects the shape first, and the client
		// id being empty rejects it before any request would be made.
		req := httptest.NewRequest(e.method, e.path, strings.NewReader(`{"enabled":false}`))
		req.Header.Set("Authorization", "Bearer not-a-token")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s with a bogus token = %d, want 401", e.method, e.path, w.Code)
		}
	}
	// Uploads too.
	body, ctype := multipartBody(t, [][2]any{{"x.gif", gifBytes}})
	if w := do(s, http.MethodPost, "/api/stingers", body, ctype); w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated upload = %d, want 401", w.Code)
	}
	// Nothing was written by any of that.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("unauthenticated requests changed the folder: %v", entries)
	}

	// A valid share token — the credential a companion tab carries — is
	// accepted.
	token := s.auth.mintShareToken(shareClaims{
		Room:   "r1",
		UserID: "u1",
		Exp:    time.Now().Add(time.Minute).Unix(),
	})
	req := httptest.NewRequest(http.MethodGet, "/api/stingers", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("share-token list = %d %s", w.Code, w.Body.String())
	}

	// Serving an asset stays unauthenticated: it is an <img src> in an
	// iframe that cannot attach headers.
	if got := do(s, http.MethodGet, "/stingers/present.gif", nil, ""); got.Code != http.StatusOK {
		t.Fatalf("asset serving requires auth (%d) — the overlay could never load it", got.Code)
	}
}

// TestStingerRoutesAbsentWithoutDir: no directory configured means the whole
// feature is off, not a set of endpoints answering 500.
func TestStingerRoutesAbsentWithoutDir(t *testing.T) {
	s := New(Config{AllowAnon: true}, slog.New(slog.DiscardHandler))
	for _, path := range []string{"/api/stingers", "/stingers/x.gif"} {
		if w := do(s, http.MethodGet, path, nil, ""); w.Code == http.StatusOK {
			t.Fatalf("%s answered %d with no stinger dir", path, w.Code)
		}
	}
	if d := s.pickStinger("start"); d != nil {
		t.Fatalf("pick with no store = %+v", d)
	}

	w := do(s, http.MethodGet, "/api/config", nil, "")
	var cfg map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg["stingers"] != false {
		t.Fatalf("config advertises stingers = %v with no dir", cfg["stingers"])
	}
}
