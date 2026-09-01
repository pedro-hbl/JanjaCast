// Package server wires janjacast's HTTP surface: the embedded Activity client,
// the Discord OAuth token exchange, and the WebSocket relay endpoint.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/pedro-hbl/janjacast/internal/protocol"
	"github.com/pedro-hbl/janjacast/internal/relay"
	"github.com/pedro-hbl/janjacast/web"
)

// Config holds server configuration, populated from the environment.
type Config struct {
	Addr                string
	DiscordClientID     string
	DiscordClientSecret string
	// DevWebDir, when set, serves the client from disk instead of the
	// binary-embedded build (useful with `vite build --watch`).
	DevWebDir string
	// PublicOrigin optionally pins the externally reachable origin
	// (e.g. https://stream.example.com) used for companion capture links.
	// When empty it is derived from each request's Host header.
	PublicOrigin string
	// AllowAnon skips join authentication entirely — local development
	// only (JANJACAST_ALLOW_ANON=1). In normal operation every join must
	// present a Discord access token or a JanjaCast share token.
	AllowAnon bool
	// TokenSecret signs share tokens (JANJACAST_TOKEN_SECRET, base64).
	// When empty a random per-process key is used and share tokens die on
	// restart.
	TokenSecret []byte
}

// Server is the root http.Handler.
type Server struct {
	cfg  Config
	log  *slog.Logger
	hub  *relay.Hub
	mux  *http.ServeMux
	auth *authn
	rl   *rateLimiter

	connMu sync.Mutex
	conns  map[*websocket.Conn]struct{}
}

// New builds the handler.
func New(cfg Config, log *slog.Logger) *Server {
	s := &Server{
		cfg:   cfg,
		log:   log,
		hub:   relay.NewHub(log),
		mux:   http.NewServeMux(),
		auth:  newAuthn(cfg.TokenSecret, cfg.DiscordClientID),
		rl:    newRateLimiter(20, time.Minute), // per-IP budget for auth endpoints
		conns: make(map[*websocket.Conn]struct{}),
	}
	if !cfg.AllowAnon && (cfg.DiscordClientID == "" || cfg.DiscordClientSecret == "") {
		log.Warn("DISCORD_CLIENT_ID/SECRET unset and anonymous access disabled — every join will be refused")
	}
	if len(cfg.TokenSecret) == 0 {
		log.Warn("JANJACAST_TOKEN_SECRET unset — share tokens will not survive a server restart")
	}

	s.mux.HandleFunc("POST /api/token", s.handleToken)
	s.mux.HandleFunc("POST /api/share-token", s.handleShareToken)
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.HandleFunc("GET /api/config", s.handleConfig)
	s.mux.HandleFunc("GET /ws", s.handleWS)

	var dist fs.FS
	if cfg.DevWebDir != "" {
		dist = os.DirFS(cfg.DevWebDir)
	} else {
		sub, err := fs.Sub(web.Dist, "dist")
		if err != nil {
			panic(err)
		}
		dist = sub
	}
	// HTML must never be cached (Discord's proxy caches aggressively and
	// serves stale bundles after deploys); hashed assets may cache forever.
	static := http.FileServer(http.FS(dist))
	s.mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || !strings.Contains(r.URL.Path, ".") {
			w.Header().Set("Cache-Control", "no-store")
		}
		static.ServeHTTP(w, r)
	}))
	// SPA route: the companion capture page is client-side routed.
	s.mux.HandleFunc("GET /share", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFileFS(w, r, dist, "index.html")
	})
	return s
}

// handleConfig tells the client where the server is publicly reachable —
// the Activity iframe only knows Discord's proxy origin, but the companion
// capture tab must open against the real origin. JANJACAST_PUBLIC_ORIGIN
// overrides; otherwise the request's Host header is a good default because
// both the tunnel and direct access preserve it.
func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	origin := s.cfg.PublicOrigin
	if origin == "" {
		scheme := "https"
		if host, _, _ := strings.Cut(r.Host, ":"); host == "localhost" || host == "127.0.0.1" {
			scheme = "http"
		}
		origin = scheme + "://" + r.Host
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"publicOrigin": origin,
		// Served at runtime so one published image works for any Discord
		// app — no client id baked into the bundle required.
		"clientId": s.cfg.DiscordClientID,
	})
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

// handleToken exchanges the OAuth authorization code the Activity client got
// from discordSdk.commands.authorize() for an access token. The client
// secret never leaves the server.
func (s *Server) handleToken(w http.ResponseWriter, r *http.Request) {
	if !s.rl.allow(clientIP(r)) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	if s.cfg.DiscordClientID == "" || s.cfg.DiscordClientSecret == "" {
		http.Error(w, "server not configured", http.StatusInternalServerError)
		return
	}
	var body struct {
		Code string `json:"code"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Code == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	form := url.Values{
		"client_id":     {s.cfg.DiscordClientID},
		"client_secret": {s.cfg.DiscordClientSecret},
		"grant_type":    {"authorization_code"},
		"code":          {body.Code},
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://discord.com/api/oauth2/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, "discord unreachable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&token); err != nil || token.AccessToken == "" {
		http.Error(w, "token exchange failed", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"access_token": token.AccessToken})
}

// handleShareToken mints a short-lived signed token that lets a companion
// capture tab join a room. The caller must prove who they are with their
// Discord access token; anonymous servers (dev) skip verification.
func (s *Server) handleShareToken(w http.ResponseWriter, r *http.Request) {
	if !s.rl.allow(clientIP(r)) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	var body struct {
		AccessToken string `json:"accessToken"`
		Room        string `json:"room"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Room == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	claims := shareClaims{
		Room: body.Room,
		Exp:  time.Now().Add(10 * time.Minute).Unix(),
	}
	if s.cfg.AllowAnon {
		claims.UserID = "anon"
		claims.Username = "sharer"
	} else {
		id, err := s.auth.verifyDiscordToken(r.Context(), body.AccessToken)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		claims.UserID = id.UserID + ":tab"
		claims.Username = id.Username + " (sharing)"
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"shareToken": s.auth.mintShareToken(claims),
	})
}

// authenticateJoin resolves a join request to a trusted identity. The
// client-supplied name/id are only honored on anonymous (dev) servers.
func (s *Server) authenticateJoin(ctx context.Context, join protocol.JoinData) (protocol.JoinData, error) {
	switch {
	case join.ShareToken != "":
		claims, err := s.auth.verifyShareToken(join.ShareToken)
		if err != nil {
			return join, err
		}
		join.Room = claims.Room
		join.UserID = claims.UserID
		join.Username = claims.Username
		return join, nil
	case join.AccessToken != "":
		id, err := s.auth.verifyDiscordToken(ctx, join.AccessToken)
		if err != nil {
			return join, err
		}
		join.UserID = id.UserID
		join.Username = id.Username
		return join, nil
	case s.cfg.AllowAnon:
		return join, nil
	default:
		return join, errAuthRequired
	}
}

var errAuthRequired = errors.New("authentication required")

// rateLimiter is a small fixed-window per-key counter — enough to stop
// unauthenticated endpoint abuse without pulling in a dependency.
type rateLimiter struct {
	mu     sync.Mutex
	window time.Duration
	limit  int
	epoch  time.Time
	counts map[string]int
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{window: window, limit: limit, epoch: time.Now(), counts: make(map[string]int)}
}

func (l *rateLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if time.Since(l.epoch) > l.window {
		l.epoch = time.Now()
		clear(l.counts)
	}
	l.counts[key]++
	return l.counts[key] <= l.limit
}

func clientIP(r *http.Request) string {
	// Behind the tunnel/proxy chain the peer address is the proxy; prefer
	// the standard forwarding headers when present.
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		ip, _, _ := strings.Cut(xff, ",")
		return strings.TrimSpace(ip)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// wsOriginPatterns lists origins allowed to open relay WebSockets: Discord's
// Activities proxy, the quick-tunnel domain, and local development hosts.
// The configured public origin's host is appended at accept time.
var wsOriginPatterns = []string{
	"*.discordsays.com",
	"*.trycloudflare.com",
	"localhost:*",
	"127.0.0.1:*",
}

// handleWS upgrades the connection and runs the relay session: the first
// message must be a CtrlJoin, after which text messages are control and
// binary messages are media chunks forwarded to the room.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	patterns := wsOriginPatterns
	if s.cfg.PublicOrigin != "" {
		if u, err := url.Parse(s.cfg.PublicOrigin); err == nil && u.Host != "" {
			patterns = append(patterns, u.Host)
		}
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns:     patterns,
		InsecureSkipVerify: s.cfg.AllowAnon, // dev mode: any origin
		CompressionMode:    websocket.CompressionDisabled, // media is already compressed
	})
	if err != nil {
		s.log.Warn("ws accept", "err", err)
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(4 << 20) // 4 MiB: comfortably above any keyframe

	s.trackConn(conn, true)
	defer s.trackConn(conn, false)

	// The connection context outlives the HTTP handler's request context
	// semantics we need: cancel it explicitly when either loop dies.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// First message: join (bounded wait).
	joinCtx, cancelJoin := context.WithTimeout(ctx, 15*time.Second)
	typ, data, err := conn.Read(joinCtx)
	cancelJoin()
	if err != nil || typ != websocket.MessageText {
		return
	}
	var ctrl protocol.Control
	if err := json.Unmarshal(data, &ctrl); err != nil || ctrl.Type != protocol.CtrlJoin {
		return
	}
	var join protocol.JoinData
	if err := json.Unmarshal(ctrl.Data, &join); err != nil || (join.Room == "" && join.ShareToken == "") {
		return
	}
	viaShareToken := join.ShareToken != ""
	join, err = s.authenticateJoin(ctx, join)
	if err != nil {
		// A close frame with a policy code lets the client distinguish
		// "unauthorized, stop retrying" from a network blip.
		_ = conn.Close(websocket.StatusPolicyViolation, "unauthorized")
		return
	}

	room, client, outbox := s.hub.Join(join.Room, join.UserID, join.Username)
	defer s.hub.Leave(room, client)

	// Companion tabs joined with a share token get periodic fresh tokens so
	// reconnects keep working past the token's short expiry.
	if viaShareToken {
		refresh := func() {
			client.SendControl(protocol.CtrlTokenRefresh, protocol.TokenRefreshData{
				ShareToken: s.auth.mintShareToken(shareClaims{
					Room:     join.Room,
					UserID:   join.UserID,
					Username: join.Username,
					Exp:      time.Now().Add(10 * time.Minute).Unix(),
				}),
			})
		}
		refresh()
		go func() {
			t := time.NewTicker(4 * time.Minute)
			defer t.Stop()
			for {
				select {
				case <-t.C:
					refresh()
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	// Liveness: protocol-level pings detect half-open connections (slept
	// laptops, dropped NAT mappings) that would otherwise hold the stage
	// forever, since the server rarely writes to an idle publisher.
	go func() {
		t := time.NewTicker(20 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				pingCtx, cancelPing := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Ping(pingCtx)
				cancelPing()
				if err != nil {
					cancel()
					conn.CloseNow()
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// Write loop.
	go func() {
		defer cancel()
		for msg := range outbox {
			kind := websocket.MessageText
			if msg.Binary() {
				kind = websocket.MessageBinary
			}
			if err := conn.Write(ctx, kind, msg.Payload()); err != nil {
				conn.CloseNow()
				return
			}
		}
	}()

	// Read loop.
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		switch typ {
		case websocket.MessageBinary:
			room.ForwardMedia(client, data)
		case websocket.MessageText:
			if len(data) > 64<<10 {
				continue // control frames have no business being this large
			}
			s.handleControl(room, client, data)
		}
	}
}

func (s *Server) trackConn(c *websocket.Conn, add bool) {
	s.connMu.Lock()
	defer s.connMu.Unlock()
	if add {
		s.conns[c] = struct{}{}
	} else {
		delete(s.conns, c)
	}
}

// Drain tells every connected client the server is going away (a proper
// close frame, so clients back off instead of thundering back) and closes
// the connections. Called on SIGTERM/SIGINT before HTTP shutdown, which
// cannot see hijacked WebSockets.
func (s *Server) Drain() {
	s.connMu.Lock()
	conns := make([]*websocket.Conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.connMu.Unlock()
	for _, c := range conns {
		_ = c.Close(websocket.StatusGoingAway, "server restarting")
	}
}

func (s *Server) handleControl(room *relay.Room, client *relay.Client, data []byte) {
	var ctrl protocol.Control
	if err := json.Unmarshal(data, &ctrl); err != nil {
		return
	}
	switch ctrl.Type {
	case protocol.CtrlTakeStage:
		room.TakeStage(client)
	case protocol.CtrlLeaveStage:
		room.LeaveStage(client)
	case protocol.CtrlConfig:
		var cfg protocol.ConfigData
		if err := json.Unmarshal(ctrl.Data, &cfg); err == nil {
			room.SetConfig(client, &cfg)
		}
	case protocol.CtrlPing:
		var ping protocol.PingData
		if err := json.Unmarshal(ctrl.Data, &ping); err == nil {
			client.SendControl(protocol.CtrlPong, protocol.PongData{
				T:          ping.T,
				ServerTime: float64(time.Now().UnixMilli()),
			})
		}
	case protocol.CtrlSync:
		room.ForwardControl(client, protocol.CtrlSync, ctrl.Data)
	}
}
