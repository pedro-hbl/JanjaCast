# Max quality at any viewer count: run the relay on a VPS

Self-hosting on a home connection means every viewer multiplies your uplink
load (`bitrate × viewers`). JanjaCast protects your line with an egress
budget, but the *quality-unlimited* architecture is a relay that doesn't
live on your uplink at all: you send **one** stream up (~6 Mbps), the VPS
fans it out, and viewer count stops mattering to you entirely.

## 10-minute setup (any Docker-capable VPS)

Streaming at 6 Mbps to 10 viewers uses **~27 GB/hour** of egress, so the
plan's included traffic matters far more than its CPU. Watch for two traps:
included traffic is often **region-specific** (Hetzner ships 20 TB in its
German locations but 1 TB in the US ones), and platforms that bill per GB
(~$0.05/GB is typical) turn a heavy month into a three-figure bill — this
workload is pure egress. Put the host near the viewers, too: the media rides
a persistent WebSocket, so a CDN cannot accelerate it.

```sh
# on the VPS
mkdir janjacast && cd janjacast
curl -O https://raw.githubusercontent.com/pedro-hbl/JanjaCast/main/docker-compose.yml
cat > .env <<'EOF'
DISCORD_CLIENT_ID=<your app id>
DISCORD_CLIENT_SECRET=<your secret>
JANJACAST_TOKEN_SECRET=<openssl rand -base64 32>
JANJACAST_EGRESS_BUDGET_KBPS=0   # unlimited: VPS bandwidth is the real deal
EOF
docker compose up -d --build
docker compose --profile tunnel up -d             # optional quick tunnel
docker compose logs tunnel | grep trycloudflare   # your public URL
```

`--build` builds from source; the published `ghcr.io/pedro-hbl/janjacast`
image only exists once a `v*` tag has been released.

Put the printed URL in the Discord portal's **Activities → URL Mappings**
(`/` → that host). Done — the image is multi-arch and the client id is
served at runtime, so no build step. The Dockerfile runs the web build first and copies `web/dist` into the final image; the binary serves the embedded assets.

## Make the URL permanent (recommended)

Quick-tunnel URLs rotate on restart. Two stable options:

- **Named Cloudflare tunnel** (free): `cloudflared tunnel create janjacast`,
  route a hostname you own to it, and replace the `tunnel` service command
  with `tunnel run janjacast`. The portal mapping never changes again.
- **Direct TLS**: point a DNS record at the VPS and put Caddy in front
  (`caddy reverse-proxy --from stream.example.com --to localhost:8080`).
  Set `JANJACAST_PUBLIC_ORIGIN=https://stream.example.com`.

## What stays on your PC

Only the sharing tab — it captures and uploads one stream to the VPS. Your
household keeps its bandwidth, viewers get full bitrate, and the egress
budget/guardrail never needs to engage.

---

For the full operator path — secrets, vinhetas, portal configuration, and how
to verify the whole chain without opening Discord — see
[docs/deploy-runbook.md](deploy-runbook.md).
