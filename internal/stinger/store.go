// Package stinger owns the stinger asset store: the files a room plays when
// a stream starts or stops, plus the per-asset flags that decide which of
// them are eligible for which moment.
//
// The Store interface exists so a second backend (S3-compatible object
// storage) can slot in without touching the HTTP layer or the relay — see
// docs/stingers.md § 1 for why local disk is the shipped default and what an
// S3 implementation would have to provide. Everything above this package
// addresses an asset by BASE NAME and never by path.
package stinger

import (
	"io"
	"time"

	"github.com/pedro-hbl/janjacast/internal/protocol"
)

// Type classifies an asset: exactly one of these two, decided by extension
// and confirmed by content sniffing at upload time.
const (
	TypeImage = "image"
	TypeAudio = "audio"
)

// Moment is when a stinger fires. MomentStart/MomentStop draw from the pools
// their respective flags select; MomentManual draws from everything enabled
// (a person pressing the dice button meant "surprise me", not "respect my
// start/stop routing").
type Moment string

const (
	MomentStart  Moment = "start"
	MomentStop   Moment = "stop"
	MomentManual Moment = "manual"
)

// Flags are the per-asset settings persisted alongside the files. The zero
// value is NOT the default — see defaultFlags: an asset with no stored entry
// is enabled and in both pools, which is exactly how a settings-less
// directory behaved before this feature existed.
type Flags struct {
    Enabled     bool `json:"enabled"`
    PlayOnStart bool `json:"playOnStart"`
    PlayOnStop  bool `json:"playOnStop"`
    StormTrigger bool `json:"stormTrigger"`
}

func defaultFlags() Flags {
	return Flags{Enabled: true, PlayOnStart: true, PlayOnStop: true}
}

// FlagPatch is a partial update: a nil field means "leave it alone", so the
// UI can send one key per toggle without read-modify-writing the whole set.
type FlagPatch struct {
    Enabled     *bool `json:"enabled"`
    PlayOnStart *bool `json:"playOnStart"`
    PlayOnStop  *bool `json:"playOnStop"`
    StormTrigger *bool `json:"stormTrigger"`
}

// Asset is one stinger file as the API and the UI see it.
type Asset struct {
	Name        string `json:"name"`
	Type        string `json:"type"`        // TypeImage | TypeAudio
	ContentType string `json:"contentType"` // what serving sets
	Size        int64  `json:"size"`
	URL         string `json:"url"` // "/stingers/<escaped name>", origin-relative
	Flags

	// modTime feeds http.ServeContent's conditional-request handling. Not
	// part of the API surface.
	modTime time.Time
}

// ModTime is the asset's last-modified time (for conditional serving).
func (a Asset) ModTime() time.Time { return a.modTime }

// Store is the asset backend. Implementations must be safe for concurrent
// use: the HTTP handlers and the relay's pick call into it from many
// goroutines.
type Store interface {
	// List returns every asset in the store, sorted by name.
	List() ([]Asset, error)

	// Open returns the bytes of one asset by base name. The caller closes
	// the reader. Names that are not present yield ErrNotFound.
	Open(name string) (io.ReadSeekCloser, Asset, error)

	// Create stores a new asset from r under a name derived (and sanitized)
	// from suggested, reading at most limit bytes. It returns ErrTooLarge if
	// r has more than limit bytes, ErrUnsupported if the extension or the
	// sniffed content type disagree, and ErrFull past the asset ceiling.
	Create(suggested string, r io.Reader, limit int64) (Asset, error)

	// Delete removes one asset and its settings entry.
	Delete(name string) error

	// SetFlags applies a partial flag update and returns the asset as it now
	// stands.
	SetFlags(name string, p FlagPatch) (Asset, error)

	// Pick chooses a random image and a random audio eligible for moment,
	// drawn INDEPENDENTLY, and returns them as a ready-to-broadcast payload.
	// It returns nil when neither pool has a member.
	//
	// Pick is called under relay Room.mu (it is installed as Hub.Stinger), so
	// implementations must stay a pure read-and-choose: no relay state, no
	// blocking network call, no lock that anything else in the relay holds.
	Pick(moment Moment) *protocol.StingerData

	// Resolve turns caller-supplied names into a broadcastable payload,
	// dropping names that are absent, disabled, or of the wrong kind. It
	// returns nil when nothing usable is left. Unlike Pick this is called
	// from the HTTP/WebSocket layer with NO relay lock held.
	Resolve(image, audio string) *protocol.StingerData
}
