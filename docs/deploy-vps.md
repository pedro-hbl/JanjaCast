# Max quality at any viewer count: run the relay on a VPS

Self-hosting on a home connection means every viewer multiplies your uplink
load (`bitrate × viewers`). JanjaCast protects your line with an egress
budget, but the *quality-unlimited* architecture is a relay that doesn't
live on your uplink at all: you send **one** stream up (~6 Mbps), the VPS
fans it out, and viewer count stops mattering to you entirely.

## 10-minute setup (any Docker-capable VPS)

Good picks: a small VPS with generous egress. Oracle Cloud's Always Free
ARM tier (4 cores / 24 GB / **10 TB egress per month**) runs this for $0;
Hetzner's smallest instance (20 TB egress) costs a few EUR/month. Streaming
at 6 Mbps to 10 viewers uses ~27 GB/hour of egress — budget accordingly.

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
docker compose --profile tunnel up -d
docker compose logs tunnel | grep trycloudflare   # your public URL
```

Put the printed URL in the Discord portal's **Activities → URL Mappings**
(`/` → that host). Done — the image is multi-arch and the client id is
served at runtime, so no build step.

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
