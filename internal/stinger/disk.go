package stinger

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pedro-hbl/janjacast/internal/protocol"
)

// Errors the HTTP layer maps onto status codes.
var (
	ErrNotFound    = errors.New("stinger: no such asset")
	ErrTooLarge    = errors.New("stinger: file too large")
	ErrUnsupported = errors.New("stinger: unsupported file type")
	ErrFull        = errors.New("stinger: too many assets")
	ErrBadName     = errors.New("stinger: bad name")
)

// MaxAssets bounds the directory. It keeps the per-pick ReadDir (which runs
// under relay Room.mu) trivially cheap and keeps the panel a browsable grid.
const MaxAssets = 100

// MaxAssetBytes is the per-file ceiling. A stinger is a reaction image and a
// two-second horn; 8 MiB is generous for both.
const MaxAssetBytes int64 = 8 << 20

// settingsName is the per-asset flag file, kept inside the stinger directory
// so the whole feature is one bind mount. Dot-prefixed and .json, so it can
// never be mistaken for an asset by the extension tables below.
const settingsName = ".janjacast-stingers.json"

// Asset classification by extension. Doubling as the Content-Type table keeps
// "what we serve" and "what we pick" the same set by construction.
var (
	imageTypes = map[string]string{
		".png":  "image/png",
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".gif":  "image/gif",
		".webp": "image/webp",
	}
	audioTypes = map[string]string{
		".mp3": "audio/mpeg",
		".ogg": "audio/ogg",
		".wav": "audio/wav",
	}
)

// sniffedTypes maps what http.DetectContentType reports onto our two
// categories. The check is category agreement, NOT exact equality: a .wav
// sniffs as audio/wave and an .ogg as application/ogg, and both are correct.
// Anything absent here — text/html above all, the stored-XSS shape for a file
// served from our own origin — is refused.
var sniffedTypes = map[string]string{
	"image/png":       TypeImage,
	"image/jpeg":      TypeImage,
	"image/gif":       TypeImage,
	"image/webp":      TypeImage,
	"audio/mpeg":      TypeAudio,
	"audio/wave":      TypeAudio,
	"audio/wav":       TypeAudio,
	"audio/x-wav":     TypeAudio,
	"audio/aiff":      TypeAudio,
	"application/ogg": TypeAudio,
	"audio/ogg":       TypeAudio,
}

// classify returns the category and Content-Type for a base name, or ok=false
// when the extension is not a stinger kind.
func classify(name string) (kind, ctype string, ok bool) {
	ext := strings.ToLower(filepath.Ext(name))
	if ct, found := imageTypes[ext]; found {
		return TypeImage, ct, true
	}
	if ct, found := audioTypes[ext]; found {
		return TypeAudio, ct, true
	}
	return "", "", false
}

// ValidName gates every name that reaches the filesystem. Names arrive here
// already percent-decoded by net/http, so "..%2Fx" and "../x" are the same
// string and both fail the separator check.
func ValidName(name string) bool {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
		return false
	}
	if strings.HasPrefix(name, ".") {
		return false // the settings file and any other dotfile
	}
	_, _, ok := classify(name)
	return ok
}

// settingsFile is the on-disk shape of the flag store.
type settingsFile struct {
	Version int              `json:"version"`
	Assets  map[string]Flags `json:"assets"`
}

// DiskStore is the shipped backend: a plain directory plus one JSON settings
// file. Safe for concurrent use — mu guards the settings read-modify-write
// and the name-allocation half of Create. Bulk upload bytes are written to a
// temp file OUTSIDE the lock, so a slow 8 MiB upload never stalls a room's
// pick.
type DiskStore struct {
	dir string
	log *slog.Logger

	mu sync.Mutex
}

var _ Store = (*DiskStore)(nil)

// NewDiskStore opens (creating if needed) a stinger directory.
func NewDiskStore(dir string, log *slog.Logger) (*DiskStore, error) {
	if dir == "" {
		return nil, errors.New("stinger: empty directory")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("stinger: %w", err)
	}
	return &DiskStore{dir: dir, log: log}, nil
}

// Dir is the directory being served (for logging).
func (s *DiskStore) Dir() string { return s.dir }

// scan lists the asset files. It does NOT consult settings — callers that
// need flags go through List.
func (s *DiskStore) scan() ([]Asset, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	assets := make([]Asset, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !ValidName(e.Name()) {
			continue
		}
		kind, ctype, _ := classify(e.Name())
		a := Asset{
			Name:        e.Name(),
			Type:        kind,
			ContentType: ctype,
			URL:         "/stingers/" + url.PathEscape(e.Name()),
			Flags:       defaultFlags(),
		}
		if info, err := e.Info(); err == nil {
			a.Size = info.Size()
			a.modTime = info.ModTime()
		}
		assets = append(assets, a)
	}
	sort.Slice(assets, func(i, j int) bool { return assets[i].Name < assets[j].Name })
	return assets, nil
}

// loadSettings reads the flag file. A missing, corrupt, or unreadable file is
// NOT an error: it degrades to "every asset has default flags", which is the
// pre-feature behaviour, so a bad byte in this file can never take stingers
// out entirely.
func (s *DiskStore) loadSettings() map[string]Flags {
	b, err := os.ReadFile(filepath.Join(s.dir, settingsName))
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) && s.log != nil {
			s.log.Warn("stinger settings unreadable; using defaults", "err", err)
		}
		return nil
	}
	var f settingsFile
	if err := json.Unmarshal(b, &f); err != nil {
		if s.log != nil {
			s.log.Warn("stinger settings corrupt; using defaults", "err", err)
		}
		return nil
	}
	return f.Assets
}

// saveSettingsLocked writes the flag file atomically (temp in the SAME
// directory, then rename — rename(2) is only atomic within a filesystem) and
// prunes entries for files that no longer exist. Caller must hold s.mu.
func (s *DiskStore) saveSettingsLocked(flags map[string]Flags, present map[string]struct{}) error {
	for name := range flags {
		if _, ok := present[name]; !ok {
			delete(flags, name)
		}
	}
	b, err := json.MarshalIndent(settingsFile{Version: 1, Assets: flags}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, ".settings-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename succeeded
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, filepath.Join(s.dir, settingsName))
}

// List returns every asset decorated with its stored flags (defaults where
// there is no entry), sorted by name.
func (s *DiskStore) List() ([]Asset, error) {
	assets, err := s.scan()
	if err != nil {
		return nil, err
	}
	stored := s.loadSettings()
	for i := range assets {
		if f, ok := stored[assets[i].Name]; ok {
			assets[i].Flags = f
		}
	}
	return assets, nil
}

// find returns one asset by name from a fresh listing. Serving, deleting and
// flag-setting all go through it, so nothing ever acts on a name that is not
// literally present in the directory right now.
func (s *DiskStore) find(name string) (Asset, error) {
	if !ValidName(name) {
		return Asset{}, ErrNotFound
	}
	assets, err := s.List()
	if err != nil {
		return Asset{}, err
	}
	for _, a := range assets {
		if a.Name == name {
			return a, nil
		}
	}
	return Asset{}, ErrNotFound
}

// Open returns the bytes of one asset.
func (s *DiskStore) Open(name string) (io.ReadSeekCloser, Asset, error) {
	a, err := s.find(name)
	if err != nil {
		return nil, Asset{}, err
	}
	f, err := os.Open(filepath.Join(s.dir, a.Name))
	if err != nil {
		return nil, Asset{}, ErrNotFound
	}
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		f.Close()
		return nil, Asset{}, ErrNotFound
	}
	a.Size = info.Size()
	a.modTime = info.ModTime()
	return f, a, nil
}

// Delete removes one asset and prunes its settings entry.
func (s *DiskStore) Delete(name string) error {
	a, err := s.find(name)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(filepath.Join(s.dir, a.Name)); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ErrNotFound
		}
		return err
	}
	flags := s.loadSettings()
	if flags == nil {
		return nil // nothing stored: nothing to prune
	}
	delete(flags, a.Name)
	present, err := s.presentLocked()
	if err != nil {
		return nil // the file is gone, which is what was asked; pruning is best-effort
	}
	if err := s.saveSettingsLocked(flags, present); err != nil && s.log != nil {
		s.log.Warn("stinger settings save failed", "err", err)
	}
	return nil
}

// SetFlags applies a partial update and returns the asset as it now stands.
func (s *DiskStore) SetFlags(name string, p FlagPatch) (Asset, error) {
	a, err := s.find(name)
	if err != nil {
		return Asset{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	flags := s.loadSettings()
	if flags == nil {
		flags = make(map[string]Flags)
	}
	cur, ok := flags[a.Name]
	if !ok {
		cur = defaultFlags()
	}
	if p.Enabled != nil {
		cur.Enabled = *p.Enabled
	}
	if p.PlayOnStart != nil {
		cur.PlayOnStart = *p.PlayOnStart
	}
	if p.PlayOnStop != nil {
		cur.PlayOnStop = *p.PlayOnStop
	}
	flags[a.Name] = cur

	present, err := s.presentLocked()
	if err != nil {
		return Asset{}, err
	}
	if err := s.saveSettingsLocked(flags, present); err != nil {
		return Asset{}, err
	}
	a.Flags = cur
	return a, nil
}

// presentLocked is the current set of asset names, for settings pruning.
func (s *DiskStore) presentLocked() (map[string]struct{}, error) {
	assets, err := s.scan()
	if err != nil {
		return nil, err
	}
	present := make(map[string]struct{}, len(assets))
	for _, a := range assets {
		present[a.Name] = struct{}{}
	}
	return present, nil
}

// Create stores an upload. The body is streamed to a temp file first — the
// lock is taken only to allocate a free name and rename into place, so a slow
// 8 MiB upload never blocks a room's pick.
func (s *DiskStore) Create(suggested string, r io.Reader, limit int64) (Asset, error) {
	if limit <= 0 || limit > MaxAssetBytes {
		limit = MaxAssetBytes
	}
	stem, ext, ok := sanitizeName(suggested)
	if !ok {
		return Asset{}, ErrUnsupported
	}
	wantKind, ctype, _ := classify("x" + ext)

	// Fail fast before reading a body we would only throw away.
	if assets, err := s.scan(); err == nil && len(assets) >= MaxAssets {
		return Asset{}, ErrFull
	}

	tmp, err := os.CreateTemp(s.dir, ".upload-*.tmp")
	if err != nil {
		return Asset{}, err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			os.Remove(tmpName)
		}
	}()

	// Sniff from the head, then write head+rest through. limit+1 is how an
	// oversized body is detected without ever buffering it.
	head := make([]byte, 512)
	n, err := io.ReadFull(r, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		tmp.Close()
		return Asset{}, err
	}
	head = head[:n]
	if sniffedTypes[trimMediaType(http.DetectContentType(head))] != wantKind {
		tmp.Close()
		return Asset{}, ErrUnsupported
	}
	written, err := io.Copy(tmp, io.LimitReader(io.MultiReader(bytes.NewReader(head), r), limit+1))
	if err != nil {
		tmp.Close()
		return Asset{}, err
	}
	if written > limit {
		tmp.Close()
		return Asset{}, ErrTooLarge
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return Asset{}, err
	}
	if err := tmp.Close(); err != nil {
		return Asset{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	present, err := s.presentLocked()
	if err != nil {
		return Asset{}, err
	}
	if len(present) >= MaxAssets {
		return Asset{}, ErrFull
	}
	name := freeName(stem, ext, present)
	if err := os.Rename(tmpName, filepath.Join(s.dir, name)); err != nil {
		return Asset{}, err
	}
	cleanup = false
	return Asset{
		Name:        name,
		Type:        wantKind,
		ContentType: ctype,
		Size:        written,
		URL:         "/stingers/" + url.PathEscape(name),
		Flags:       defaultFlags(),
		modTime:     time.Now(),
	}, nil
}

// trimMediaType drops the parameters http.DetectContentType appends to text
// types ("text/plain; charset=utf-8").
func trimMediaType(ct string) string {
	base, _, _ := strings.Cut(ct, ";")
	return strings.TrimSpace(base)
}

// sanitizeName reduces a client-supplied filename to a safe stem plus a known
// lowercase extension. The client's string is NEVER used as a path: only the
// base name survives, and only [A-Za-z0-9._-] characters of it.
func sanitizeName(suggested string) (stem, ext string, ok bool) {
	// Both separators, because a Windows client may send a full path.
	base := suggested
	if i := strings.LastIndexAny(base, `/\`); i >= 0 {
		base = base[i+1:]
	}
	ext = strings.ToLower(filepath.Ext(base))
	if _, isImg := imageTypes[ext]; !isImg {
		if _, isAud := audioTypes[ext]; !isAud {
			return "", "", false
		}
	}
	stem = strings.TrimSuffix(base, filepath.Ext(base))
	var b strings.Builder
	lastDash := false
	for _, r := range stem {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash && b.Len() > 0 {
				b.WriteByte('-')
				lastDash = true
			}
		}
		if b.Len() >= 60 {
			break
		}
	}
	stem = strings.Trim(b.String(), "-_")
	if stem == "" {
		stem = "stinger-" + strconv.FormatInt(time.Now().UnixNano()%1e9, 36)
	}
	return stem, ext, true
}

// freeName resolves collisions with a -2, -3, … suffix rather than clobbering
// or randomizing, so uploaded names stay recognizable in the panel.
func freeName(stem, ext string, present map[string]struct{}) string {
	name := stem + ext
	for i := 2; ; i++ {
		if _, taken := present[name]; !taken {
			return name
		}
		name = stem + "-" + strconv.Itoa(i) + ext
	}
}

// Pick draws one eligible image and one eligible audio INDEPENDENTLY. An
// empty pool contributes nothing (silent stinger / pictureless stinger); both
// empty yields nil and the relay broadcasts nothing at all.
//
// Called under relay Room.mu: a directory read and a random choice, no relay
// state, no blocking call.
func (s *DiskStore) Pick(moment Moment) *protocol.StingerData {
	assets, err := s.List()
	if err != nil {
		return nil
	}
	var images, audios []Asset
	for _, a := range assets {
		if !eligible(a, moment) {
			continue
		}
		if a.Type == TypeImage {
			images = append(images, a)
		} else {
			audios = append(audios, a)
		}
	}
	if len(images) == 0 && len(audios) == 0 {
		return nil
	}
	d := &protocol.StingerData{Kind: string(moment)}
	if len(images) > 0 {
		d.Image = images[rand.IntN(len(images))].URL
	}
	if len(audios) > 0 {
		d.Audio = audios[rand.IntN(len(audios))].URL
	}
	return d
}

func eligible(a Asset, moment Moment) bool {
	if !a.Enabled {
		return false
	}
	switch moment {
	case MomentStart:
		return a.PlayOnStart
	case MomentStop:
		return a.PlayOnStop
	default:
		// Manual: the operator picked "surprise me", which means anything
		// they have left switched on — start/stop routing is about automatic
		// transitions, not about a button they just pressed.
		return true
	}
}

// Resolve turns caller-supplied names into a broadcastable payload. Names
// that are absent, disabled, or of the wrong kind are dropped rather than
// rejected, so a stale panel firing a just-deleted asset degrades to "the
// other half still plays" instead of erroring. nil means nothing usable.
func (s *DiskStore) Resolve(image, audio string) *protocol.StingerData {
	if image == "" && audio == "" {
		return nil
	}
	assets, err := s.List()
	if err != nil {
		return nil
	}
	byName := make(map[string]Asset, len(assets))
	for _, a := range assets {
		byName[a.Name] = a
	}
	d := &protocol.StingerData{Kind: string(MomentManual)}
	if a, ok := byName[image]; ok && a.Enabled && a.Type == TypeImage {
		d.Image = a.URL
	}
	if a, ok := byName[audio]; ok && a.Enabled && a.Type == TypeAudio {
		d.Audio = a.URL
	}
	if d.Image == "" && d.Audio == "" {
		return nil
	}
	return d
}
