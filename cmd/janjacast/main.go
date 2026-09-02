// Command janjacast runs the JanjaCast relay server: a single binary that
// serves the embedded Discord Activity client and relays screen-stream media
// from one publisher to every viewer in a call over WebSockets.
package main

import (
	"cmp"
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/pedro-hbl/janjacast/internal/server"
)

// healthcheck probes the local server's health endpoint.
func healthcheck() int {
	addr := cmp.Or(os.Getenv("JANJACAST_ADDR"), ":8080")
	if strings.HasPrefix(addr, ":") {
		addr = "localhost" + addr
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://" + addr + "/api/health")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

// envInt reads an integer env var; empty or invalid yields def. Explicit 0
// is honored (e.g. unlimited egress budget on a VPS).
func envInt(name string, def int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	return n
}

func logLevel() slog.Level {
	switch strings.ToLower(os.Getenv("JANJACAST_LOG_LEVEL")) {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func main() {
	// `janjacast healthcheck` probes the running server and exits 0/1 — the
	// container healthcheck for a FROM-scratch image with no shell.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: logLevel(),
	}))
	slog.SetDefault(logger)

	var tokenSecret []byte
	if raw := os.Getenv("JANJACAST_TOKEN_SECRET"); raw != "" {
		secret, err := base64.StdEncoding.DecodeString(raw)
		if err != nil || len(secret) < 32 {
			logger.Error("JANJACAST_TOKEN_SECRET must be base64 of at least 32 bytes")
			os.Exit(1)
		}
		tokenSecret = secret
	}

	cfg := server.Config{
		Addr:                cmp.Or(os.Getenv("JANJACAST_ADDR"), ":8080"),
		DiscordClientID:     os.Getenv("DISCORD_CLIENT_ID"),
		DiscordClientSecret: os.Getenv("DISCORD_CLIENT_SECRET"),
		DevWebDir:           os.Getenv("JANJACAST_DEV_WEB_DIR"), // serve client from disk instead of embed
		PublicOrigin:        os.Getenv("JANJACAST_PUBLIC_ORIGIN"),
		AllowAnon:           os.Getenv("JANJACAST_ALLOW_ANON") == "1",
		TokenSecret:         tokenSecret,
		EgressBudgetKbps:    envInt("JANJACAST_EGRESS_BUDGET_KBPS", 25_000),
	}

	// SIGTERM matters: it is what `docker stop` and orchestrators send.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	srv := server.New(cfg, logger)

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("janjacast listening", "addr", cfg.Addr)
		errCh <- httpServer.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		logger.Info("shutting down")
		// http.Server.Shutdown never touches hijacked WebSockets — drain
		// them explicitly with proper close frames first.
		srv.Drain()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			logger.Error("shutdown", "err", err)
		}
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server", "err", err)
			os.Exit(1)
		}
	}
}
