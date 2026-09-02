// Stingers: short meme-image + sound pairs every participant plays when a
// stream starts or stops, or when somebody presses the button in the
// Stingers panel. The assets live in a server-local store
// (JANJACAST_STINGER_DIR, see internal/stinger) that is never part of the
// repo or image; the relay asks the store for a random eligible pair and this
// file serves the bytes and hosts the management API.
package server

import (
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"strings"

	"github.com/pedro-hbl/janjacast/internal/protocol"
	"github.com/pedro-hbl/janjacast/internal/relay"
	"github.com/pedro-hbl/janjacast/internal/stinger"
)

// maxUploadFiles bounds one multipart request. The per-file ceiling is
// enforced by the store; this stops a single request from being an unbounded
// number of small ones.
const maxUploadFiles = 12

// pickStinger is installed as Hub.Stinger and therefore called under Room.mu:
// it must stay a pure pick (read the store, choose) and never touch relay
// state. Reading per pick — rather than caching — means files added to the
// directory by hand work without a restart.
func (s *Server) pickStinger(kind string) *protocol.StingerData {
	if s.stingers == nil {
		return nil
	}
	return s.stingers.Pick(stinger.Moment(kind))
}

// playStingerFor handles a client's CtrlStingerPlay. Name resolution is
// filesystem I/O, so it happens HERE, with no relay lock held; the relay's
// PlayStinger then applies the per-client cooldown under Room.mu and fans the
// message out.
func (s *Server) playStingerFor(room *relay.Room, client *relay.Client, d protocol.StingerPlayData) {
	if s.stingers == nil {
		return
	}
	var payload *protocol.StingerData
	if d.Random || (d.Image == "" && d.Audio == "") {
		payload = s.stingers.Pick(stinger.MomentManual)
	} else {
		payload = s.stingers.Resolve(d.Image, d.Audio)
	}
	room.PlayStinger(client, payload)
}

// handleStinger serves one asset by base name. The store only ever resolves
// names that literally appear in a fresh directory listing and rejects
// anything holding a path separator (including an encoded one, which arrives
// here already decoded), so traversal cannot reach outside the directory.
func (s *Server) handleStinger(w http.ResponseWriter, r *http.Request) {
	f, asset, err := s.stingers.Open(r.PathValue("name"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", asset.ContentType)
	// A name's bytes don't churn (uploads never overwrite: they get a -2
	// suffix), so let every viewer cache the pair they just fetched.
	w.Header().Set("Cache-Control", "public, max-age=3600")
	http.ServeContent(w, r, asset.Name, asset.ModTime(), f)
}

// ---------------------------- management API -------------------------------

// authorizeAssets gates every asset endpoint with the SAME credential the
// WebSocket join requires: a JanjaCast share token or a Discord access token,
// presented as "Authorization: Bearer <token>". Anonymous servers (local dev,
// JANJACAST_ALLOW_ANON=1) skip the check exactly as handleShareToken does.
//
// The share token is tried first because it is verified locally by HMAC and
// costs nothing; only a token that is not a valid share token is worth an
// outbound call to Discord.
func (s *Server) authorizeAssets(w http.ResponseWriter, r *http.Request) bool {
	if s.cfg.AllowAnon {
		return true
	}
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if token == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	if _, err := s.auth.verifyShareToken(token); err == nil {
		return true
	}
	// Without a configured application id, verifyDiscordToken's audience
	// check rejects every token anyway — so don't spend an outbound request
	// (or a test's network) discovering that.
	if s.cfg.DiscordClientID != "" {
		if _, err := s.auth.verifyDiscordToken(r.Context(), token); err == nil {
			return true
		}
	}
	http.Error(w, "unauthorized", http.StatusUnauthorized)
	return false
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// assetStatus maps store errors onto the status the client should see.
func assetStatus(err error) (int, string) {
	switch {
	case errors.Is(err, stinger.ErrNotFound):
		return http.StatusNotFound, "no such stinger"
	case errors.Is(err, stinger.ErrTooLarge):
		return http.StatusRequestEntityTooLarge, "file too large"
	case errors.Is(err, stinger.ErrUnsupported):
		return http.StatusUnsupportedMediaType, "not an image or a sound"
	case errors.Is(err, stinger.ErrFull):
		return http.StatusConflict, "stinger folder is full"
	default:
		return http.StatusInternalServerError, "server error"
	}
}

// handleStingerList returns every asset with its flags.
func (s *Server) handleStingerList(w http.ResponseWriter, r *http.Request) {
	if !s.rl.allow(clientIP(r)) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	if !s.authorizeAssets(w, r) {
		return
	}
	assets, err := s.stingers.List()
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"assets":   assets,
		"max":      stinger.MaxAssets,
		"maxBytes": stinger.MaxAssetBytes,
	})
}

// uploadResult reports one rejected file back to the panel by its ORIGINAL
// name, so a user who dragged eight files knows which two bounced.
type uploadResult struct {
	Name  string `json:"name"`
	Error string `json:"error"`
}

// handleStingerUpload accepts multipart uploads. The body is streamed part by
// part — never buffered whole — so an enormous request costs one file's worth
// of reading and then a rejection.
func (s *Server) handleStingerUpload(w http.ResponseWriter, r *http.Request) {
	if !s.uploadRL.allow(clientIP(r)) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	if !s.authorizeAssets(w, r) {
		return
	}
	mr, err := r.MultipartReader()
	if err != nil {
		http.Error(w, "expected multipart/form-data", http.StatusBadRequest)
		return
	}
	var (
		saved  []stinger.Asset
		failed []uploadResult
		files  int
	)
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			break
		}
		if part.FileName() == "" {
			part.Close()
			continue
		}
		files++
		if files > maxUploadFiles {
			failed = append(failed, uploadResult{Name: part.FileName(), Error: "too many files at once"})
			part.Close()
			continue
		}
		a, err := s.stingers.Create(part.FileName(), part, stinger.MaxAssetBytes)
		part.Close()
		if err != nil {
			_, msg := assetStatus(err)
			failed = append(failed, uploadResult{Name: part.FileName(), Error: msg})
			// A full folder or an exhausted request is not going to un-fail
			// for the remaining parts; stop reading and answer.
			if errors.Is(err, stinger.ErrFull) {
				drainParts(mr)
				break
			}
			continue
		}
		saved = append(saved, a)
	}
	if saved == nil {
		saved = []stinger.Asset{}
	}
	if failed == nil {
		failed = []uploadResult{}
	}
	code := http.StatusOK
	if len(saved) == 0 && len(failed) > 0 {
		code = http.StatusBadRequest
	}
	writeJSON(w, code, map[string]any{"assets": saved, "errors": failed})
}

// drainParts closes out the rest of a multipart body so the connection can be
// reused instead of being torn down mid-request.
func drainParts(mr *multipart.Reader) {
	for i := 0; i < maxUploadFiles; i++ {
		p, err := mr.NextPart()
		if err != nil {
			return
		}
		p.Close()
	}
}

// handleStingerPatch applies a partial flag update. Pointer fields make
// "unmentioned" and "set to false" distinguishable, so each toggle sends one
// key and cannot clobber its neighbours.
func (s *Server) handleStingerPatch(w http.ResponseWriter, r *http.Request) {
	if !s.rl.allow(clientIP(r)) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	if !s.authorizeAssets(w, r) {
		return
	}
	var patch stinger.FlagPatch
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	a, err := s.stingers.SetFlags(r.PathValue("name"), patch)
	if err != nil {
		code, msg := assetStatus(err)
		http.Error(w, msg, code)
		return
	}
	writeJSON(w, http.StatusOK, a)
}

// handleStingerDelete removes one asset.
func (s *Server) handleStingerDelete(w http.ResponseWriter, r *http.Request) {
	if !s.rl.allow(clientIP(r)) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	if !s.authorizeAssets(w, r) {
		return
	}
	if err := s.stingers.Delete(r.PathValue("name")); err != nil {
		code, msg := assetStatus(err)
		http.Error(w, msg, code)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
