<h1 align="center">
  <img src="docs/lockup.svg" alt="JanjaCast" width="420">
</h1>

<p align="center">
  <a href="https://github.com/pedro-hbl/janjacast/actions/workflows/ci.yml"><img src="https://github.com/pedro-hbl/janjacast/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/pedro-hbl/janjacast/actions/workflows/release.yml"><img src="https://github.com/pedro-hbl/janjacast/actions/workflows/release.yml/badge.svg" alt="release"></a>
  <a href="https://github.com/pedro-hbl/janjacast/pkgs/container/janjacast"><img src="https://img.shields.io/badge/ghcr.io-pedro--hbl%2Fjanjacast-1D63ED?logo=docker&logoColor=white" alt="container"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="license"></a>
</p>

**Screen livestreaming as a Discord Activity.** One person shares their
screen; everyone in the voice call watches live inside the Activity —
sub-second latency, tab/system audio, 30/60 fps, and a one-click
"take the stage" model. Open source, self-hosted, one binary.

![JanjaCast architecture — capture in a companion Chrome tab, WebCodecs over WSS through a Cloudflare Tunnel into a Go relay in Docker, fanned out through Discord's Activities proxy to every viewer in the call](docs/architecture.svg)

## Features

- 🖥 **Share screen, window, or tab** at 30 or 60 fps, with tab/system audio
- ⚡ **Sub-second latency** (~0.3–0.6 s glass-to-glass), held flat by
  drop-to-live catch-up — it can't drift
- 🚪 **Instant late-join** — new viewers get a picture immediately (server-side
  GOP cache)
- 📉 **Adaptive bitrate** — congestion steps quality down, never latency up
- 🎚 **Per-viewer volume**, live fps / bitrate / latency readout
- 🛑 **Stop from anywhere** — the capture tab or remotely from the Activity
- 🔐 **Authenticated rooms** — every join must present a Discord OAuth token
  (verified against Discord, application-audience checked) or a short-lived
  signed share token. Room ids are unguessable activity-instance ids and
  should be treated as bearer secrets; verifying actual call membership is on
  the roadmap
- 🔁 **Self-healing** — automatic reconnect on both ends; the stage re-claims
  itself
- 🖍 Hand-drawn **crayon UI** (see the banner) served by the same binary

## Why it's built this way

Discord Activities are iframes behind a strict CSP: **WebRTC is not
available**, all traffic must flow through Discord's
`<app-id>.discordsays.com` proxy, and the iframe **denies screen capture**
(`display-capture` permissions policy — verified empirically).

So JanjaCast does it the hard way, on the open web stack that *is* allowed:

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
make all                      # web client → embed → ./janjacast
JANJACAST_ALLOW_ANON=1 ./janjacast  # local dev: auth off, http://localhost:8080
```

Open `http://localhost:8080/?room=demo` in two Chromium windows, hit
**Share screen** in one, watch in the other — no Discord needed for
development.

### Configuration

| Env var | Purpose |
| --- | --- |
| `DISCORD_CLIENT_ID` | Discord application id (portal → General Information) |
| `DISCORD_CLIENT_SECRET` | OAuth secret (portal → OAuth2); server-side only |
| `JANJACAST_ADDR` | Listen address, default `:8080` |
| `JANJACAST_PUBLIC_ORIGIN` | Pin the public origin for companion links (default: derived per request) |
| `JANJACAST_ALLOW_ANON` | `1` disables join auth — local development only |
| `JANJACAST_DEV_WEB_DIR` | Serve the client from disk instead of the embedded build |

## Self-hosting notes

- One process, tiny footprint; a small VPS handles a community. The real cost
  is egress: **stream bitrate × viewers** while live. On a home connection,
  set `JANJACAST_EGRESS_BUDGET_KBPS` to ~60% of your measured upload speed —
  it acts as a congestion guardrail only (full quality whenever the network
  is clean). For max quality at any viewer count, run the relay on a VPS:
  [docs/deploy-vps.md](docs/deploy-vps.md).
- A sharer whose machine also hosts the relay is detected automatically and
  captures over loopback — their stream never crosses the internet twice.
- Discord requires HTTPS — any TLS reverse proxy or a Cloudflare Tunnel in
  front of `:8080` works. Quick-tunnel URLs rotate on restart; use a named
  tunnel (free) for anything long-lived, or the portal mapping goes stale.
- The container ships a built-in healthcheck (`/janjacast healthcheck`), already
  wired in the compose file.

## Development

```sh
go run ./cmd/janjacast           # API + relay on :8080
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
