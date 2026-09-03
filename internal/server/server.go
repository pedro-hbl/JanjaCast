// Package server wires janjacast's HTTP surface: the embedded Activity client,
// the Discord OAuth token exchange, and the WebSocket relay endpoint.
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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
	"github.com/pedro-hbl/janjacast/internal/stinger"
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
	// EgressBudgetKbps caps total relay egress (stream bitrate × viewers).
	// The sharer's encoder divides this by the viewer count to derive its
	// bitrate ceiling. 0 = unlimited (sensible on a VPS; on a residential
	// uplink set ~60% of the measured upload speed).
	EgressBudgetKbps int
	// StingerDir, when set, enables stream start/stop stingers: a directory
	// of images and sounds (JANJACAST_STINGER_DIR) served under /stingers/
	// and picked from at random on stage transitions. Empty = disabled.
	StingerDir string
}

// Server is the root http.Handler.
type Server struct {
	cfg        Config
	log        *slog.Logger
	hub        *relay.Hub
	mux        *http.ServeMux
	auth       *authn
	rl         *rateLimiter
	uploadRL   *rateLimiter
	wsPatterns []string
	// stingers is the asset store; nil when JANJACAST_STINGER_DIR is unset,
	// which disables the whole feature (no routes, no Hub.Stinger).
	stingers stinger.Store
	// instanceID lets a companion tab recognize "the server behind this
	// tunnel is running on MY machine" and hop to loopback, taking the
	// capture stream off the shared uplink entirely.
	instanceID string

	connMu sync.Mutex
	conns  map[*websocket.Conn]struct{}
	awards *awardStore
}

// New builds the handler.
func New(cfg Config, log *slog.Logger) *Server {
	s := &Server{
		cfg:        cfg,
		log:        log,
		hub:        relay.NewHub(log),
		mux:        http.NewServeMux(),
		auth:       newAuthn(cfg.TokenSecret, cfg.DiscordClientID),
		rl:         newRateLimiter(60, time.Minute), // per-IP budget for auth endpoints
		uploadRL:   newRateLimiter(20, time.Minute), // uploads are far more expensive
		wsPatterns: originPatterns(cfg),
		instanceID: newInstanceID(),
		conns:      make(map[*websocket.Conn]struct{}),
	}
	s.initAwards()
	if !cfg.AllowAnon && (cfg.DiscordClientID == "" || cfg.DiscordClientSecret == "") {
		log.Warn("DISCORD_CLIENT_ID/SECRET unset and anonymous access disabled — every join will be refused")
	}
	if len(cfg.TokenSecret) == 0 {
		log.Warn("JANJACAST_TOKEN_SECRET unset — share tokens will not survive a server restart")
	}

	if cfg.StingerDir != "" {
		store, err := stinger.NewDiskStore(cfg.StingerDir, log)
		if err != nil {
			log.Warn("stinger directory unusable — stingers disabled", "dir", cfg.StingerDir, "err", err)
		} else {
			s.stingers = store
			// Installed before the hub serves any traffic; called under
			// Room.mu, so it must stay a pure pick (see pickStinger).
			s.hub.Stinger = s.pickStinger
			s.mux.HandleFunc("GET /stingers/{name}", s.handleStinger)
			s.mux.HandleFunc("GET /api/stingers", s.handleStingerList)
			s.mux.HandleFunc("POST /api/stingers", s.handleStingerUpload)
			s.mux.HandleFunc("PATCH /api/stingers/{name}", s.handleStingerPatch)
			s.mux.HandleFunc("DELETE /api/stingers/{name}", s.handleStingerDelete)
		}
	}

	s.mux.HandleFunc("POST /api/token", s.handleToken)
	s.mux.HandleFunc("POST /api/share-token", s.handleShareToken)
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.HandleFunc("GET /api/config", s.handleConfig)
	// Clip serving: relay-origin, tokenized.
	s.mux.HandleFunc("GET /clip/{token}", s.handleClip)
	// Sidecar for replay events: /clip/{token}/events.json
	s.mux.HandleFunc("GET /clip/{token}/events.json", s.handleClipEvents)
	s.mux.HandleFunc("GET /ws", s.handleWS)
	s.mux.HandleFunc("GET /awards/{id}", s.handleAwards)

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
	port := "8080"
	if _, p, err := net.SplitHostPort(s.cfg.Addr); err == nil && p != "" {
		port = p
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"publicOrigin": origin,
		// Served at runtime so one published image works for any Discord
		// app — no client id baked into the bundle required.
		"clientId": s.cfg.DiscordClientID,
		// For the companion tab's loopback hop and egress budgeting.
		"instance":         s.instanceID,
		"localPort":        port,
		"egressBudgetKbps": s.cfg.EgressBudgetKbps,
		// Whether the asset store exists at all — the client hides the
		// Stingers button entirely rather than opening a panel onto 404s.
		"stingers": s.stingers != nil,
	})
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	// The instance id lets a companion tab probe http://localhost:<port>
	// and confirm it is the very same server it reached via the tunnel.
	w.Header().Set("Access-Control-Allow-Origin", "*") // health is not sensitive
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "instance": s.instanceID})
}

func newInstanceID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
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
		// UserID/Username are honored ONLY on anonymous (dev) servers, so
		// the companion tab's identity lines up with the Activity's and
		// ownsStage()/remote-stop work in the plain-browser flow too.
		UserID   string `json:"userId"`
		Username string `json:"username"`
		// Mode "telinha" mints a WATCH-ONLY identity (":telinha" suffix)
		// so the mini-player never supersedes the person's capture tab.
		Mode string `json:"mode"`
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
	suffix, tag := ":tab", " (sharing)"
	if body.Mode == "telinha" {
		suffix, tag = ":telinha", " (telinha)"
	}
	if s.cfg.AllowAnon {
		id := body.UserID
		if id == "" {
			id = "anon"
		}
		name := body.Username
		if name == "" {
			name = "sharer"
		}
		claims.UserID = id + suffix
		claims.Username = name + tag
	} else {
		id, err := s.auth.verifyDiscordToken(r.Context(), body.AccessToken)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		claims.UserID = id.UserID + suffix
		claims.Username = id.Username + tag
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
	// X-Forwarded-For is client-controlled and trivially spoofable, so it
	// must not be the bucket key on its own; the peer address alone makes
	// everyone behind the tunnel share one bucket. Combine both: spoofing
	// XFF still spends the spoofer's own per-peer budget less granularly
	// than it costs them, and distinct real clients behind one proxy get
	// distinct keys.
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		ip, _, _ := strings.Cut(xff, ",")
		return host + "|" + strings.TrimSpace(ip)
	}
	return host
}

// originPatterns lists origins allowed to open relay WebSockets: Discord's
// Activities proxy, the quick-tunnel domain, local development hosts, and
// the configured public origin. Built once per server — appending to a
// shared package slice per request would be a data race.
func originPatterns(cfg Config) []string {
	patterns := []string{
		"*.discordsays.com",
		"*.trycloudflare.com",
		"localhost:*",
		"127.0.0.1:*",
	}
	if cfg.PublicOrigin != "" {
		if u, err := url.Parse(cfg.PublicOrigin); err == nil && u.Host != "" {
			patterns = append(patterns, u.Host)
		}
	}
	return patterns
}

// handleWS upgrades the connection and runs the relay session: the first
// message must be a CtrlJoin, after which text messages are control and
// binary messages are media chunks forwarded to the room.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns:     s.wsPatterns,
		InsecureSkipVerify: s.cfg.AllowAnon,               // dev mode: any origin
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
		// Close codes carry the retry semantics: 1008 means "your
		// credentials were rejected, stop retrying"; a transient failure to
		// reach Discord closes 1011 so the client keeps reconnecting.
		if errors.Is(err, errAuthUnavailable) {
			_ = conn.Close(websocket.StatusInternalError, "auth temporarily unavailable")
		} else {
			_ = conn.Close(websocket.StatusPolicyViolation, "unauthorized")
		}
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
		// Belt and braces for takeover: the in-band superseded control has
		// been drained above; a distinct close code makes the transport
		// itself terminal in case the client missed it.
		if client.WasSuperseded() {
			_ = conn.Close(4001, "superseded")
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
// cannot see hijacked WebSockets. Close handshakes run concurrently and the
// whole drain is bounded — one half-open peer must not eat the container's
// stop grace period.
func (s *Server) Drain() {
	s.connMu.Lock()
	conns := make([]*websocket.Conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.connMu.Unlock()

	var wg sync.WaitGroup
	for _, c := range conns {
		wg.Add(1)
		go func(c *websocket.Conn) {
			defer wg.Done()
			_ = c.Close(websocket.StatusGoingAway, "server restarting")
		}(c)
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		for _, c := range conns {
			c.CloseNow()
		}
	}
}

func (s *Server) handleControl(room *relay.Room, client *relay.Client, data []byte) {
	var ctrl protocol.Control
	if err := json.Unmarshal(data, &ctrl); err != nil {
		return
	}
	// Synthetic timeline events for the wire probe — anonymous dev servers
	// only, so production rooms can never have their replay sidecar polluted.
	if ctrl.Type == protocol.ControlType("probe_room_event") && s.cfg.AllowAnon {
		var m map[string]any
		if err := json.Unmarshal(ctrl.Data, &m); err == nil {
			room.AppendProbeEvent(m)
		}
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
	case protocol.CtrlKeyframeRequest:
		room.RequestKeyframeFrom(client)
	case protocol.CtrlBlank:
		var b protocol.BlankData
		if err := json.Unmarshal(ctrl.Data, &b); err == nil {
			room.SetBlank(client, b.On)
		}
	case protocol.CtrlStingerPlay:
		var play protocol.StingerPlayData
		if err := json.Unmarshal(ctrl.Data, &play); err == nil {
			s.playStingerFor(room, client, play)
		}

	// --- the stage queue -------------------------------------------
	// Identity is the connection's, never the payload's. A refusal the
	// sender can act on comes back as a CtrlError carrying a code the
	// client translates; everything else is ignored silently, because a
	// duplicate queue request has nothing useful to report.
	case protocol.CtrlStageRequest:
		room.RequestStage(client)
	case protocol.CtrlStageWithdraw:
		room.WithdrawStage(client)
	case protocol.CtrlStagePass:
		if _, code := room.PassStage(client); code != "" {
			client.SendControl(protocol.CtrlError, protocol.ErrorData{Code: code})
		}
	case protocol.CtrlStageExtend:
		if _, code := room.ExtendStage(client); code != "" {
			client.SendControl(protocol.CtrlError, protocol.ErrorData{Code: code})
		}
	case protocol.CtrlStageMode:
		var mode protocol.StageModeData
		if err := json.Unmarshal(ctrl.Data, &mode); err == nil {
			room.SetStageMode(client, mode.Mode)
		}
	// --- cinema -------------------------------------------------------------
	case protocol.CtrlCinemaPause:
		if ok, code := room.CinemaPause(client); !ok && code != "" {
			client.SendControl(protocol.CtrlError, protocol.ErrorData{Code: code})
		}
	case protocol.CtrlCinemaResume:
		if ok, code := room.CinemaResume(client); !ok && code != "" {
			client.SendControl(protocol.CtrlError, protocol.ErrorData{Code: code})
		}
	case protocol.CtrlCinemaStroke:
		var sd protocol.CinemaStrokeData
		if err := json.Unmarshal(ctrl.Data, &sd); err == nil {
			if ok, code := room.AddCinemaStroke(client, &sd); !ok && code != "" {
				client.SendControl(protocol.CtrlError, protocol.ErrorData{Code: code})
			}
		}
	case protocol.CtrlPlacarCreate:
		var d protocol.PlacarCreateData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			if err2 := room.CreatePlacar(client, d.Prompt); err2 != nil {
				client.SendControl(protocol.CtrlError, protocol.ErrorData{Code: err2.Error()})
			}
		}
	// --- captions --------------------------------------------------------
	case protocol.CtrlCaptionToggle:
		var d protocol.CaptionToggleData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			// Publisher-only toggle; store under Room.mu
			room.ToggleCaptions(client, d.Enabled)
		}
		break
	case protocol.CtrlCaptionSubmit:
		var sd protocol.CaptionSubmitData
		if err := json.Unmarshal(ctrl.Data, &sd); err != nil {
			break
		}
		// Basic guards live outside lock for fast-fail; state checks inside.
		text := sd.Text
		if len(text) > 120 {
			text = text[:120]
		}
		nowMs := time.Now().UnixMilli()
		sent := false
		if ok := room.SubmitCaption(client, text, nowMs); ok {
			sent = true
		}
		_ = sent
		break
	case protocol.CtrlAssistPoint:
		var d protocol.AssistPointData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.AssistPoint(client, d.X, d.Y)
		}
	case protocol.CtrlAttentionReport:
		var d protocol.AttentionReportData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.AttentionReport(client, d.Visible)
		}
	case protocol.CtrlPitacoPost:
		var d protocol.PitacoPostData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.PitacoPost(client, d.Text, d.Side)
		}
	case protocol.CtrlApostaChallenge:
		var d protocol.ApostaChallengeData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.ApostaChallenge(client, d.Target, d.Text)
		}
	case protocol.CtrlApostaAccept:
		var d protocol.ApostaAnswerData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.ApostaAnswer(client, d.ID, true)
		}
	case protocol.CtrlApostaDecline:
		var d protocol.ApostaAnswerData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.ApostaAnswer(client, d.ID, false)
		}
	case protocol.CtrlApostaJudge:
		var d protocol.ApostaAnswerData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.ApostaJudge(client, d.ID, d.Winner)
		}
	case protocol.CtrlCorrenteNominate:
		var d protocol.CorrenteNominateData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.CorrenteNominate(client, d.Target)
		}
	case protocol.CtrlCorrenteVote:
		var d protocol.CorrenteVoteData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.CorrenteVote(client, d.Choice)
		}
	case protocol.CtrlVaralPin:
		var d protocol.VaralPinData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.VaralPin(client, d)
		}
	case protocol.CtrlVaralRemove:
		var d protocol.VaralRemoveData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.VaralRemove(client, d.ID)
		}
	case protocol.CtrlPlacarVote:
		var d protocol.PlacarVoteData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			if err2 := room.PlacarVote(client, d.TargetUserID, d.Delta); err2 != nil {
				client.SendControl(protocol.CtrlError, protocol.ErrorData{Code: err2.Error()})
			}
		}
	case protocol.CtrlPlacarClose:
		if err := room.ClosePlacar(client); err != nil {
			client.SendControl(protocol.CtrlError, protocol.ErrorData{Code: err.Error()})
		}
	case protocol.CtrlBolaoStart:
		var d protocol.BolaoStartData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.BolaoStart(client, d.ID, d.Prompt)
		}
	case protocol.CtrlBolaoVote:
		var d protocol.BolaoVoteData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.BolaoVote(client, d.ID, d.Vote)
		}
	case protocol.CtrlBolaoResolve:
		var d protocol.BolaoResolveData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.BolaoResolve(client, d.ID, d.Result)
		}
	case protocol.CtrlChamaStart:
		var d protocol.ChamaStartData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.ChamaStart(client, d.ID, d.Text)
		}
	case protocol.CtrlChamaAck:
		var d protocol.ChamaAckData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.ChamaAck(client, d.ID)
		}
	case protocol.CtrlChamaEnd:
		var d protocol.ChamaEndData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.ChamaEnd(client, d.ID)
		}
	case protocol.CtrlClip:
		room.RequestClip(client)
	case protocol.CtrlReplay:
		var d protocol.ReplayRequestData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.RequestReplay(client, d.Seconds)
		}
	// --- jukebox ---------------------------------------------------------
	case protocol.CtrlJukeboxRequest:
		var d protocol.JukeboxRequestData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			room.JukeboxRequest(client, d)
		}
	case protocol.CtrlJukeboxApprove:
		var d protocol.JukeboxApproveData
		if err := json.Unmarshal(ctrl.Data, &d); err == nil {
			if ok := room.JukeboxApprove(client, d.ID); !ok {
				client.SendControl(protocol.CtrlError, protocol.ErrorData{Code: "not_host"})
			}
		}
	case protocol.CtrlJukeboxGetQueue:
		room.JukeboxSendQueue(client)
	}
}

// handleClip serves a stored clip by token with throttling. Clips live in the
// room state; we do not reveal whether the room exists.
func (s *Server) handleClip(w http.ResponseWriter, r *http.Request) {
	// Strip optional suffix like "/events.json" if misrouted here.
	token := strings.TrimPrefix(r.URL.Path, "/clip/")
	if i := strings.IndexByte(token, '/'); i >= 0 {
		token = token[:i]
	}
	if token == "" {
		http.NotFound(w, r)
		return
	}
	// Find the room that holds this token. Linear scan is fine at this scale.
	// Locate and copy data out while under Hub.mu, then release BEFORE I/O.
	var data []byte
	var mime string
	found := false
	mu := s.hub.Mu()
	mu.Lock()
	for _, room := range s.hub.RoomsUnsafe() {
		if b, m, ok := room.GetClip(token); ok {
			data = append([]byte(nil), b...)
			mime = m
			found = true
			break
		}
	}
	mu.Unlock()
	if !found {
		http.NotFound(w, r)
		return
	}
	// Serve outside of Hub.mu
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition", "attachment; filename=\"janjacast-clip.jclp\"")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}

// handleClipEvents serves a JSON sidecar of events for a given clip token.
func (s *Server) handleClipEvents(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.URL.Path, "/clip/")
	// expect {token}/events.json
	if i := strings.IndexByte(token, '/'); i >= 0 {
		token = token[:i]
	}
	if token == "" {
		http.NotFound(w, r)
		return
	}
	var data []byte
	found := false
	mu := s.hub.Mu()
	mu.Lock()
	for _, room := range s.hub.RoomsUnsafe() {
		if b, ok := room.GetClipEvents(token); ok {
			data = append([]byte(nil), b...)
			found = true
			break
		}
	}
	mu.Unlock()
	if !found {
		// Return empty array to keep client simple; 200 aligns with probe.
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("[]"))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}
