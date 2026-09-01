// Command janjacast runs the janjacast relay server: a single binary that serves
// the embedded Discord Activity client and relays screen-stream media from
// one publisher to every viewer in a call over WebSockets.
package main

import (
	"cmp"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
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
	if err != nil || resp.StatusCode != http.StatusOK {
		return 1
	}
	resp.Body.Close()
	return 0
}

func main() {
	// `janjacast healthcheck` probes the running server and exits 0/1 — the
	// container healthcheck for a FROM-scratch image with no shell.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	}))
	slog.SetDefault(logger)

	cfg := server.Config{
		Addr:                cmp.Or(os.Getenv("JANJACAST_ADDR"), ":8080"),
		DiscordClientID:     os.Getenv("DISCORD_CLIENT_ID"),
		DiscordClientSecret: os.Getenv("DISCORD_CLIENT_SECRET"),
		DevWebDir:           os.Getenv("JANJACAST_DEV_WEB_DIR"), // serve client from disk instead of embed
		PublicOrigin:        os.Getenv("JANJACAST_PUBLIC_ORIGIN"),
		AllowAnon:           os.Getenv("JANJACAST_ALLOW_ANON") == "1",
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	srv := server.New(cfg, logger)

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("janjacast listening", "addr", cfg.Addr)
		errCh <- httpServer.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		logger.Info("shutting down")
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
