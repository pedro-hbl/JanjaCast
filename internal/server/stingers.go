// Stingers: short meme-image + sound pairs every participant plays when a
// stream starts or stops. The assets live in a server-local directory
// (JANJACAST_STINGER_DIR) that is never part of the repo or image; the relay
// asks pickStinger for a random pair and this file serves the bytes.
package server

import (
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/pedro-hbl/janjacast/internal/protocol"
)

// Stinger asset classification by extension. Doubling as the Content-Type
// table keeps "what we serve" and "what we pick" the same set by
// construction.
var (
	stingerImageTypes = map[string]string{
		".png":  "image/png",
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".gif":  "image/gif",
		".webp": "image/webp",
	}
	stingerAudioTypes = map[string]string{
		".mp3": "audio/mpeg",
		".ogg": "audio/ogg",
		".wav": "audio/wav",
	}
)

// pickStinger scans the stinger directory and returns a random image + audio
// pair as /stingers/ URLs, or nil when the directory yields nothing. It is
// installed as Hub.Stinger and therefore called under Room.mu: it must stay
// pure I/O and never touch relay state. Scanning per pick (10-20 entries)
// means files added to the directory work without a restart.
func (s *Server) pickStinger(kind string) *protocol.StingerData {
	entries, err := os.ReadDir(s.cfg.StingerDir)
	if err != nil {
		return nil
	}
	var images, audios []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name()))
		if _, ok := stingerImageTypes[ext]; ok {
			images = append(images, e.Name())
		} else if _, ok := stingerAudioTypes[ext]; ok {
			audios = append(audios, e.Name())
		}
	}
	if len(images) == 0 && len(audios) == 0 {
		return nil
	}
	d := &protocol.StingerData{Kind: kind}
	if len(images) > 0 {
		d.Image = "/stingers/" + url.PathEscape(images[rand.IntN(len(images))])
	}
	if len(audios) > 0 {
		d.Audio = "/stingers/" + url.PathEscape(audios[rand.IntN(len(audios))])
	}
	return d
}

// handleStinger serves one asset by base name. Only names that literally
// appear in a fresh directory scan are served — anything containing a path
// separator (including an encoded one, which arrives here decoded) is
// rejected outright, so traversal cannot reach outside the directory.
func (s *Server) handleStinger(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\") {
		http.NotFound(w, r)
		return
	}
	ext := strings.ToLower(filepath.Ext(name))
	ctype, ok := stingerImageTypes[ext]
	if !ok {
		ctype, ok = stingerAudioTypes[ext]
	}
	if !ok {
		http.NotFound(w, r)
		return
	}
	entries, err := os.ReadDir(s.cfg.StingerDir)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	found := false
	for _, e := range entries {
		if !e.IsDir() && e.Name() == name {
			found = true
			break
		}
	}
	if !found {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(filepath.Join(s.cfg.StingerDir, name))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", ctype)
	// Names are stable (the pick re-scans, but a given name's bytes don't
	// churn), so let every viewer cache the pair they just fetched.
	w.Header().Set("Cache-Control", "public, max-age=3600")
	http.ServeContent(w, r, name, info.ModTime(), f)
}
