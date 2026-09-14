# Deploy runbook: JanjaCast on a server, permanently

A step-by-step an operator (or a coding agent with shell + browser access)
can execute end to end. It assumes nothing about the host beyond "Linux with
Docker". Every step ends in a check you can run, because most failures here
are silent: the Activity shows a blank frame and says nothing.

Read [docs/discord-setup.md](discord-setup.md) for *why* the Discord pieces
exist; this file is the *what to type*.

---

## 0. Decide who owns the Discord application

This decision comes first because it determines whose secret lives on the
server.

- **Reuse an existing app** (the stream keeps the same launcher entry, and
  existing users see no change): you only repoint one URL mapping. But the
  server needs that app's `DISCORD_CLIENT_SECRET`, so the app owner has to
  hand it over. Only do this between people who already trust each other with
  it, and rotate the secret if that stops being true.
- **Create a new app** (recommended when someone else hosts): the host owns
  their own id and secret, nothing is shared, and the two deployments can run
  side by side. Cost: it is a different entry in Discord's Activities list,
  and testers must be added to it.

Both paths use this runbook; step 4 says which parts to skip.

---

## 1. Provision the host

The relay does not transcode — it copies bytes from one socket to many. CPU
and RAM are almost irrelevant (1 vCPU / 1 GB is plenty). Two things do matter:

- **Egress.** The math is `bitrate × viewers`: 6 Mbps to 10 viewers is
  **27 GB/hour**. Prefer a host with bandwidth included over one that meters
  per GB, and put the server geographically near the viewers — the media
  rides a persistent WebSocket, so no CDN can help it.
- **Restart policy.** The compose file already sets `restart: unless-stopped`;
  make sure Docker itself starts at boot (`systemctl enable docker`).

```sh
# Docker, if the image isn't there yet
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
```

---

## 2. Get the code and configure it

```sh
git clone https://github.com/pedro-hbl/JanjaCast.git janjacast
cd janjacast

cat > .env <<EOF
DISCORD_CLIENT_ID=<application id>
DISCORD_CLIENT_SECRET=<client secret>
JANJACAST_TOKEN_SECRET=$(openssl rand -base64 32)
JANJACAST_EGRESS_BUDGET_KBPS=0
EOF
chmod 600 .env
```

`JANJACAST_TOKEN_SECRET` is the one people forget. Without it the server
still boots, but it logs `share tokens will not survive a server restart` and
every open companion-capture link and telinha link dies on each restart. It
must be base64 of **at least 32 bytes**, or the process exits at startup.

`JANJACAST_EGRESS_BUDGET_KBPS=0` lifts the per-room ceiling that exists to
protect a home uplink — on a server the host's own bandwidth is the real
limit. Leave the default (25000) if the plan meters traffic tightly.

Full variable list: [README](../README.md#configuration).

### Vinhetas (optional)

Stingers are disabled unless a directory is provided. To enable:

```sh
mkdir -p stingers && cp /path/to/assets/* stingers/    # .webp/.jpg + .mp3
sed -i 's|# volumes:|volumes:|; s|#   - ./stingers|  - ./stingers|' docker-compose.yml
echo 'JANJACAST_STINGER_DIR=/stingers' >> .env
```

See [docs/stingers.md](stingers.md) for the naming rules.

---

## 3. Run it

```sh
docker compose up -d --build
docker compose logs -f janjacast     # expect: "janjacast listening" addr=:8080
```

Build from source (`--build`) is the reliable path: the published
`ghcr.io/pedro-hbl/janjacast` image only exists once a `v*` tag has been
released, so on a fresh fork it may not be there. The Dockerfile is
multi-stage — it builds the web client and embeds it, so no Node or Go is
needed on the host.

**Check:**

```sh
curl -s localhost:8080/api/health
# {"ok":true,"instance":"<hex>","rooms":0,"timers":0}
```

Note that `instance` value. It identifies this exact process and is the tool
that makes every later check unambiguous.

---

## 4. Put it on HTTPS at a fixed address

Discord only loads Activities over HTTPS. Pick one:

**A. Named Cloudflare tunnel (recommended).** No open ports, no certificate
to manage, free, and the hostname never changes.

```sh
cloudflared tunnel login                 # opens a browser; needs a domain on Cloudflare
cloudflared tunnel create janjacast
cloudflared tunnel route dns janjacast stream.example.com
# then replace the compose `tunnel` service command with:
#   tunnel run --token <token>   (or mount ~/.cloudflared)
```

**B. Domain + Caddy.** Point an A record at the host, then:

```sh
caddy reverse-proxy --from stream.example.com --to localhost:8080
```

Also set `JANJACAST_PUBLIC_ORIGIN=https://stream.example.com` so the
companion capture tab opens against the right origin.

**C. Quick tunnel (`docker compose --profile tunnel up -d`).** Zero config,
but **the hostname is regenerated on every restart**, and each rotation means
editing the Discord portal again. Fine for a first smoke test, wrong for
anything permanent.

**Check:**

```sh
curl -s https://stream.example.com/api/health   # same "instance" as step 3
```

---

## 5. Configure the Discord portal (browser)

At <https://discord.com/developers/applications> → your app. The portal
follows the account's language, so headings may be in Portuguese
("Atividades", "Mapeamentos de URL", "Salvar alterações").

**5.1 — Activities → Settings** ("Atividades → Configurações")
- Enable Activities.
- *Supported platforms* ("Plataformas compatíveis"): **Web** is checked by
  default; **iOS** and **Android** are not. Leave mobile off unless the
  client has been adapted for it — see the mobile caveats at the end.
- *Max participants* — raise it if the room will be bigger than the default.

**5.2 — Activities → URL Mappings** ("Mapeamentos de URL")

| Prefix | Target |
| ------ | ------ |
| `/` | `stream.example.com` |

The target is a **bare hostname** — no `https://`, no trailing path.

**Two traps, both of which cost real debugging time:**

1. **The first click on "Save Changes" often does not register**, especially
   right after typing in the field (the click lands as a blur). After
   clicking, confirm the bottom bar switched from *"you have unsaved
   changes"* to *"all your edits have been carefully recorded"*. If it still
   warns, click again. Do not assume it saved.
2. A stale mapping fails **silently** — the Activity renders a blank white
   frame with no error anywhere.

**5.3 — Testers.** Add the test server / accounts under App Testers so the
Activity appears in the rocket menu for an unpublished app.

---

## 6. Verify without opening Discord

This is the highest-value check in the whole runbook, and it is not obvious:
Discord proxies the Activity through `https://<APP_ID>.discordsays.com`, and
that origin is reachable with plain `curl`. So the entire chain — mapping,
tunnel, TLS, server — can be proven from a terminal:

```sh
APP_ID=<application id>
curl -s https://$APP_ID.discordsays.com/api/health
```

Compare the `instance` value with step 3. **Identical means the mapping is
live and traffic is reaching this exact process.** Use `/api/health` rather
than `/` for this: the HTML can be served from cache and will look fine even
when the mapping is broken, whereas the health payload cannot.

Then confirm the client bundle is being served:

```sh
curl -s https://$APP_ID.discordsays.com/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

Finally, the real thing: open the Activity in a voice channel, click
**Share screen**, approve the companion tab, and have a second account watch.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| **Blank white frame** in the Activity | The URL mapping is stale/empty, or the origin is unreachable. `index.html` paints a dark ground before any JS runs, so *white* means the page never arrived at all. | Re-check step 6; confirm the save in 5.2 actually took. |
| Dark frame, UI loads, **stage stays black** | Client-side: the viewer's decoder never got a keyframe. | Reload the Activity (Ctrl+R) to pick up the current bundle. Check `docker compose logs` for joins. |
| `/telinha` or `/share` returns **404** | Server not serving the SPA routes — an old build. | Rebuild: `docker compose up -d --build`. `TestSPARoutesServeIndex` guards this. |
| Companion/telinha links **die after a restart** | `JANJACAST_TOKEN_SECRET` unset. | Set it in `.env` (step 2), recreate the container. |
| **No vinhetas** | `JANJACAST_STINGER_DIR` unset, or the volume isn't mounted. | See step 2; the log says `stinger directory unusable` when the path is wrong. |
| **Everyone hears themselves** | The sharer picked whole-screen sound. | In the share tab's sound selector choose *app sound*, and share a window/tab rather than a whole monitor. |
| Server logs `every join will be refused` | Client id/secret unset and anonymous access off. | Fill `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`. |

---

## 8. Security checklist before inviting people

- `JANJACAST_ALLOW_ANON` **must stay unset** in production. It disables join
  auth entirely and exists only for local development and the wire probes.
- `.env` holds the OAuth secret — `chmod 600`, never commit it.
- **Room ids are bearer secrets.** Anyone who knows a room id and can reach
  the server can join it. This is documented, deliberate, and the reason not
  to paste room ids publicly.
- Rotate `DISCORD_CLIENT_SECRET` in the portal if it was ever shared with
  someone who should no longer have it.

---

## 9. Keeping it current

```sh
git pull && docker compose up -d --build
```

The compose healthcheck (`/janjacast healthcheck`) plus
`restart: unless-stopped` mean the container comes back on its own after a
crash or a host reboot, provided Docker is enabled at boot.

---

## Mobile, if it comes up

Watching on a phone is viable but not free work, and the platform checkboxes
in 5.1 should stay off until it is done:

- **AV1 is the blocker.** The sharer picks the codec alone and prefers AV1;
  iOS has no software AV1 decoder — only iPhone 15 Pro and newer decode it at
  all. An AV1 stream is a black screen on most iPhones. The fix is forcing
  H.264 when a mobile viewer is present.
- **`AudioDecoder` (Opus)** only reached iOS in Safari 26. On older versions
  constructing it throws, so the player needs a guard to degrade to silent
  video rather than break.
- **Safe-area insets** (`--discord-safe-area-inset-*`) are not handled yet,
  so the UI would sit under the notch.

Sharing *from* a phone is not possible at all — there is no `getDisplayMedia`
on iOS — and the client already gates the share button accordingly.
