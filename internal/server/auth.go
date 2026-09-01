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
	"net/http"
	"strings"
	"sync"
	"time"
)

// authn verifies who a WebSocket join is: either a Discord OAuth access
// token (checked against Discord's API, cached) or a janjacast share token
// (HMAC-signed, minted by this process for companion capture tabs).
type authn struct {
	secret []byte // HMAC key, random per process — share tokens are short-lived anyway

	mu    sync.Mutex
	cache map[string]cachedIdentity // access token -> verified identity
}

type cachedIdentity struct {
	id       identity
	expireAt time.Time
}

type identity struct {
	UserID   string
	Username string
}

func newAuthn() *authn {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		panic(err)
	}
	return &authn{secret: secret, cache: make(map[string]cachedIdentity)}
}

// verifyDiscordToken resolves an OAuth access token to the Discord user it
// belongs to via GET /users/@me. Results are cached for 10 minutes.
func (a *authn) verifyDiscordToken(ctx context.Context, token string) (identity, error) {
	a.mu.Lock()
	if c, ok := a.cache[token]; ok && time.Now().Before(c.expireAt) {
		a.mu.Unlock()
		return c.id, nil
	}
	a.mu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://discord.com/api/users/@me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return identity{}, fmt.Errorf("discord unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return identity{}, fmt.Errorf("discord rejected token: %d", resp.StatusCode)
	}
	var user struct {
		ID         string `json:"id"`
		Username   string `json:"username"`
		GlobalName string `json:"global_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&user); err != nil || user.ID == "" {
		return identity{}, errors.New("bad discord response")
	}
	id := identity{UserID: user.ID, Username: user.Username}
	if user.GlobalName != "" {
		id.Username = user.GlobalName
	}

	a.mu.Lock()
	if len(a.cache) > 4096 { // crude bound; entries expire anyway
		clear(a.cache)
	}
	a.cache[token] = cachedIdentity{id: id, expireAt: time.Now().Add(10 * time.Minute)}
	a.mu.Unlock()
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
