# golive

[![ci](https://github.com/pedro-hbl/golive/actions/workflows/ci.yml/badge.svg)](https://github.com/pedro-hbl/golive/actions/workflows/ci.yml)
[![release](https://github.com/pedro-hbl/golive/actions/workflows/release.yml/badge.svg)](https://github.com/pedro-hbl/golive/actions/workflows/release.yml)
[![container](https://img.shields.io/badge/ghcr.io-pedro--hbl%2Fgolive-1D63ED?logo=docker&logoColor=white)](https://github.com/pedro-hbl/golive/pkgs/container/golive)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Screen livestreaming as a Discord Activity.** One person shares their
screen; everyone in the voice call watches live inside the Activity —
sub-second latency, tab/system audio, 30/60 fps, and a one-click
"take the stage" model. Open source, self-hosted, one binary.

![golive architecture — capture in a companion Chrome tab, WebCodecs over WSS through a Cloudflare Tunnel into a Go relay in Docker, fanned out through Discord's Activities proxy to every viewer in the call](docs/architecture.svg)

## Features

- 🖥 **Share screen, window, or tab** at 30 or 60 fps, with tab/system audio
- ⚡ **Sub-second latency** (~0.3–0.6 s glass-to-glass), held flat by
  drop-to-live catch-up — it can't drift
- 🚪 **Instant late-join** — new viewers get a picture immediately (server-side
  GOP cache)
- 📉 **Adaptive bitrate** — congestion steps quality down, never latency up
- 🎚 **Per-viewer volume**, live fps / bitrate / latency readout
- 🛑 **Stop from anywhere** — the capture tab or remotely from the Activity
- 🔐 **Authenticated rooms** — Discord OAuth identity + short-lived signed
  share tokens; nobody outside the call can join or hijack a stream
- 🔁 **Self-healing** — automatic reconnect on both ends; the stage re-claims
  itself
- 🖍 Hand-drawn **crayon UI** (see the banner) served by the same binary

## Why it's built this way

Discord Activities are iframes behind a strict CSP: **WebRTC is not
available**, all traffic must flow through Discord's
`<app-id>.discordsays.com` proxy, and the iframe **denies screen capture**
(`display-capture` permissions policy — verified empirically).

So golive does it the hard way, on the open web stack that *is* allowed:

- Capture happens in a **companion tab** in the sharer's real browser (one
  click from the Activity, authenticated by a short-lived token).
- Video/audio are encoded with **WebCodecs** (hardware H.264 with VP8
  fallback, plus Opus) and shipped as binary chunks over **WebSockets**.
- A **Go relay** fans one ingest out to every viewer, dropping intelligently
  for slow consumers.
- Viewers decode with WebCodecs onto a canvas, video slaved to the audio
  clock. Playback is decode-driven, so it keeps running while alt-tabbed.

Wire format and control protocol: [`internal/protocol/protocol.go`](internal/protocol/protocol.go).

## Quick start

### Run the published image (recommended)

The multi-arch image works for **any** Discord application — the client id is
served at runtime, nothing is baked in:

```sh
export DISCORD_CLIENT_ID=...      # Discord developer portal → your app
export DISCORD_CLIENT_SECRET=...
docker compose up
```

Add `--profile tunnel` to also start a Cloudflare quick tunnel (zero-config
public HTTPS; the URL appears in the tunnel container's logs — set it as the
URL mapping in the portal). Full portal walkthrough:
[docs/discord-setup.md](docs/discord-setup.md).

### Build from source

Requires Go 1.26+ and Node 24+.

```sh
make all                      # web client → embed → ./golive
GOLIVE_ALLOW_ANON=1 ./golive  # local dev: auth off, http://localhost:8080
```

Open `http://localhost:8080/?room=demo` in two Chromium windows, hit
**Share screen** in one, watch in the other — no Discord needed for
development.

### Configuration

| Env var | Purpose |
| --- | --- |
| `DISCORD_CLIENT_ID` | Discord application id (portal → General Information) |
| `DISCORD_CLIENT_SECRET` | OAuth secret (portal → OAuth2); server-side only |
| `GOLIVE_ADDR` | Listen address, default `:8080` |
| `GOLIVE_PUBLIC_ORIGIN` | Pin the public origin for companion links (default: derived per request) |
| `GOLIVE_ALLOW_ANON` | `1` disables join auth — local development only |
| `GOLIVE_DEV_WEB_DIR` | Serve the client from disk instead of the embedded build |

## Self-hosting notes

- One process, tiny footprint; a small VPS handles a community. The real cost
  is egress: **stream bitrate × viewers** while live.
- Discord requires HTTPS — any TLS reverse proxy or a Cloudflare Tunnel in
  front of `:8080` works. Quick-tunnel URLs rotate on restart; use a named
  tunnel (free) for anything long-lived, or the portal mapping goes stale.
- The container ships a built-in healthcheck (`/golive healthcheck`), already
  wired in the compose file.

## Development

```sh
go run ./cmd/golive           # API + relay on :8080
cd web && npm run dev         # Vite on :5173, proxies /api and /ws
go test ./...                 # relay + auth tests
```

The client is SolidJS + TypeScript ([`web/src`](web/src)); the server is
plain Go ([`internal`](internal)): `relay` (rooms, fan-out, GOP cache),
`server` (HTTP, WS, auth), `protocol` (wire format).

## Status

Works end-to-end inside Discord today: authenticated Activity, companion-tab
capture, multi-viewer relay, audio, remote stop, volume, live stats. Next up:
worker-based decode for fully background-proof viewers, participant avatars,
a take-the-stage confirm dialog, and a v0.1 tag.

Issues and PRs welcome — the codebase is deliberately small and readable.

## License

[MIT](LICENSE)
