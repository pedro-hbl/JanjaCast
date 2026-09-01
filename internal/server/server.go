// Package server wires golive's HTTP surface: the embedded Activity client,
// the Discord OAuth token exchange, and the WebSocket relay endpoint.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/pedro-hbl/golive/internal/protocol"
	"github.com/pedro-hbl/golive/internal/relay"
	"github.com/pedro-hbl/golive/web"
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
	// only (GOLIVE_ALLOW_ANON=1). In normal operation every join must
	// present a Discord access token or a golive share token.
	AllowAnon bool
}

// Server is the root http.Handler.
type Server struct {
	cfg  Config
	log  *slog.Logger
	hub  *relay.Hub
	mux  *http.ServeMux
	auth *authn
}

// New builds the handler.
func New(cfg Config, log *slog.Logger) *Server {
	s := &Server{
		cfg:  cfg,
		log:  log,
		hub:  relay.NewHub(log),
		mux:  http.NewServeMux(),
		auth: newAuthn(),
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
// capture tab must open against the real origin. GOLIVE_PUBLIC_ORIGIN
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
	if s.cfg.DiscordClientID == "" || s.cfg.DiscordClientSecret == "" {
		http.Error(w, "server missing DISCORD_CLIENT_ID/DISCORD_CLIENT_SECRET", http.StatusInternalServerError)
		return
	}
	var body struct {
		Code string `json:"code"`
	}
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
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil || token.AccessToken == "" {
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
	var body struct {
		AccessToken string `json:"accessToken"`
		Room        string `json:"room"`
	}
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

// handleWS upgrades the connection and runs the relay session: the first
// message must be a CtrlJoin, after which text messages are control and
// binary messages are media chunks forwarded to the room.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The Activity is served same-origin through Discord's proxy, but
		// during local dev the origin is the vite server.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled, // media is already compressed
	})
	if err != nil {
		s.log.Warn("ws accept", "err", err)
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(4 << 20) // 4 MiB: comfortably above any keyframe

	ctx := r.Context()

	// First message: join.
	typ, data, err := conn.Read(ctx)
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
	join, err = s.authenticateJoin(ctx, join)
	if err != nil {
		payload, _ := protocol.MarshalControl(protocol.CtrlError,
			protocol.ErrorData{Message: "unauthorized: " + err.Error()})
		_ = conn.Write(ctx, websocket.MessageText, payload)
		return
	}

	room := s.hub.Room(join.Room)
	client, outbox := room.Join(join.UserID, join.Username)
	defer room.Leave(client)

	// Write loop.
	go func() {
		for msg := range outbox {
			kind := websocket.MessageText
			if msg.Binary() {
				kind = websocket.MessageBinary
			}
			writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Write(writeCtx, kind, msg.Payload())
			cancel()
			if err != nil {
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
			s.handleControl(room, client, data)
		}
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
