package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// authn verifies who a WebSocket join is: either a Discord OAuth access
// token (checked against Discord's API, cached) or a JanjaCast share token
// (HMAC-signed for companion capture tabs).
type authn struct {
	secret   []byte // HMAC key: JANJACAST_TOKEN_SECRET, or random per process
	clientID string // Discord application id the tokens must be issued for

	mu    sync.Mutex
	cache map[[32]byte]cachedIdentity // sha256(access token) -> verdict
}

type cachedIdentity struct {
	id       identity
	err      error // negative-cache entry when non-nil
	expireAt time.Time
}

type identity struct {
	UserID   string
	Username string
}

// newAuthn builds the verifier. secret may be nil, in which case a random
// per-process key is generated (share tokens then die on restart — the
// caller logs a warning).
func newAuthn(secret []byte, clientID string) *authn {
	if len(secret) == 0 {
		secret = make([]byte, 32)
		if _, err := rand.Read(secret); err != nil {
			panic(err)
		}
	}
	return &authn{
		secret:   secret,
		clientID: clientID,
		cache:    make(map[[32]byte]cachedIdentity),
	}
}

// verifyDiscordToken resolves an OAuth access token to the Discord user it
// belongs to via GET /oauth2/@me, which also reveals — and lets us verify —
// which application issued the token. Verdicts (including failures) are
// cached so bogus-token floods don't turn into outbound Discord calls.
func (a *authn) verifyDiscordToken(ctx context.Context, token string) (identity, error) {
	key := sha256.Sum256([]byte(token))
	a.mu.Lock()
	if c, ok := a.cache[key]; ok && time.Now().Before(c.expireAt) {
		a.mu.Unlock()
		return c.id, c.err
	}
	a.mu.Unlock()

	id, err := a.fetchDiscordIdentity(ctx, token)

	// Transport failures (Discord down, network blip) are NOT verdicts —
	// caching them would brick every client that connects during the blip.
	if errors.Is(err, errAuthUnavailable) {
		return id, err
	}

	a.mu.Lock()
	if len(a.cache) > 4096 { // crude bound; entries expire anyway
		clear(a.cache)
	}
	ttl := 10 * time.Minute
	if err != nil {
		ttl = 30 * time.Second // negative cache: actual rejections only
	}
	a.cache[key] = cachedIdentity{id: id, err: err, expireAt: time.Now().Add(ttl)}
	a.mu.Unlock()
	return id, err
}

// errAuthUnavailable marks verification failures that say nothing about the
// token itself — the caller must treat them as transient, not as rejection.
var errAuthUnavailable = errors.New("auth backend unavailable")

func (a *authn) fetchDiscordIdentity(ctx context.Context, token string) (identity, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://discord.com/api/oauth2/@me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return identity{}, fmt.Errorf("%w: %v", errAuthUnavailable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests {
		return identity{}, fmt.Errorf("%w: discord returned %d", errAuthUnavailable, resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return identity{}, fmt.Errorf("discord rejected token: %d", resp.StatusCode)
	}
	var info struct {
		Application struct {
			ID string `json:"id"`
		} `json:"application"`
		Expires time.Time `json:"expires"`
		User    struct {
			ID         string `json:"id"`
			Username   string `json:"username"`
			GlobalName string `json:"global_name"`
		} `json:"user"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&info); err != nil || info.User.ID == "" {
		return identity{}, errors.New("bad discord response")
	}
	// Audience check: a token minted for any other Discord application must
	// not grant access here.
	if a.clientID == "" || info.Application.ID != a.clientID {
		return identity{}, errors.New("token issued for a different application")
	}
	if !info.Expires.IsZero() && time.Now().After(info.Expires) {
		return identity{}, errors.New("token expired")
	}
	id := identity{UserID: info.User.ID, Username: info.User.Username}
	if info.User.GlobalName != "" {
		id.Username = info.User.GlobalName
	}
	return id, nil
}

// shareClaims is what a share token asserts.
type shareClaims struct {
	Room     string `json:"room"`
	UserID   string `json:"userId"`
	Username string `json:"username"`
	Exp      int64  `json:"exp"` // Unix seconds
}

// mintShareToken signs claims for a companion capture tab.
func (a *authn) mintShareToken(c shareClaims) string {
	payload, _ := json.Marshal(c)
	mac := hmac.New(sha256.New, a.secret)
	mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." +
		base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// verifyShareToken checks signature and expiry.
func (a *authn) verifyShareToken(token string) (shareClaims, error) {
	payloadB64, sigB64, ok := strings.Cut(token, ".")
	if !ok {
		return shareClaims{}, errors.New("malformed token")
	}
	payload, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return shareClaims{}, errors.New("malformed token")
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return shareClaims{}, errors.New("malformed token")
	}
	mac := hmac.New(sha256.New, a.secret)
	mac.Write(payload)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return shareClaims{}, errors.New("bad signature")
	}
	var c shareClaims
	if err := json.Unmarshal(payload, &c); err != nil {
		return shareClaims{}, errors.New("malformed claims")
	}
	if time.Now().Unix() > c.Exp {
		return shareClaims{}, errors.New("token expired")
	}
	return c, nil
}
