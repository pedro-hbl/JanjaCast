# Deploy runbook: JanjaCast on a server, permanently

A step-by-step an operator — or a coding agent with a shell and a browser —
can execute end to end, from "empty account" to "people are watching". It
assumes nothing about the host beyond **Linux with Docker**, and nothing about
the provider: the same steps work on a VPS, on EC2, or on anything that runs
a container and can be reached over HTTPS.

Every step ends in a command whose output you can check, because the failures
here are silent by nature: a misconfigured Activity shows a blank frame and
logs nothing, anywhere.

[docs/discord-setup.md](discord-setup.md) explains *why* the Discord pieces
exist. This file is *what to type*.

---

## 1. Decide who owns the Discord application

First, because it decides whose secret ends up on the server.

- **Create a new application** (recommended when someone other than the
  original owner is hosting). The host owns their own id and secret, nothing
  is shared, and two deployments can run side by side. Cost: it is a separate
  entry in Discord's Activities list, and testers must be added to it.
- **Reuse an existing application** — only one URL mapping changes, and
  existing users see no difference. But the server needs that app's
  `DISCORD_CLIENT_SECRET`, so its owner has to hand it over. Do this only
  where that trust already exists, and rotate the secret if it stops.

Creating a new one? Do step 2. Reusing? Skip to step 3, and get the id and
secret from the current owner.

---

## 2. Create the Discord application (browser)

The portal renders in the account's language, so headings may be in
Portuguese ("Atividades", "Mapeamentos de URL", "Salvar alterações"). Rather
than describing clicks, this runbook uses **direct URLs** — they are stable
and language-independent. Substitute your application id for `<APP_ID>`.

**2.1 — Create it.** At <https://discord.com/developers/applications>, click
*New Application*, name it, accept the terms, create.

**2.2 — Application id** (public; this is the "client id"):
`https://discord.com/developers/applications/<APP_ID>/information`
Copy *Application ID*. The URL contains it too, once the app exists.

**2.3 — Client secret** (private):
`https://discord.com/developers/applications/<APP_ID>/oauth2`
Click *Reset Secret* and copy the value **immediately** — Discord shows it
once and never again. If it scrolls out of reach, reset it again; resetting
invalidates the previous one, so do it before the server is live, not after.

> Handle this like a password. It goes into the server's `.env` (step 4,
> `chmod 600`) and nowhere else — never into the repo, an issue, or a chat
> log. Anyone holding it can act as your application.

**2.4 — Enable Activities:**
`https://discord.com/developers/applications/<APP_ID>/embedded/settings`
- Turn on *Enable Activities*.
- *Max participants* — raise it if rooms will be bigger than the default.
- *Supported platforms*: **Web** is checked by default; **iOS** and
  **Android** are not. Leave mobile off — see the note at the end of this
  file for why the client is not ready for it yet.

**2.5 — Testers** (so an unpublished app appears in the rocket menu):
`https://discord.com/developers/applications/<APP_ID>/testers`
Add the accounts or server that will be testing.

The URL mapping is step 7 — it needs the public address you do not have yet.

---

## 3. Provision the host

The relay does not transcode. It copies bytes from one socket to many, so CPU
and RAM barely matter — 1 vCPU and 1 GB is plenty, and a bigger box buys you
nothing here. Two things do matter:

**Bandwidth, and how it is billed.** The math is `bitrate × viewers`: 6 Mbps
to 10 viewers is **~27 GB/hour**. That single number should drive the choice:

- *Included / flat traffic* (most VPS plans): ideal. Check whether the
  allowance is region-specific — some providers ship far less traffic in one
  region than another on the same plan.
- *Metered per GB* (AWS, GCP, and most PaaS): works, but this workload is
  pure egress, so the bill scales directly with hours × viewers. At a typical
  $0.05–0.09/GB, a busy evening is real money. If you go this way, set a
  **budget alarm at the provider** — see the warning in step 4, because
  JanjaCast's own egress knob is *not* a spend limit.

**Proximity.** Put the host near the viewers. The media rides a persistent
WebSocket, so no CDN can cache or accelerate it; only the physical distance
to the relay matters.

**Restart policy.** `docker-compose.yml` already sets
`restart: unless-stopped`. Make sure Docker itself starts at boot:

```sh
curl -fsSL https://get.docker.com | sh      # if Docker isn't installed
sudo systemctl enable --now docker
```

---

## 4. Get the code and configure it

```sh
git clone https://github.com/pedro-hbl/JanjaCast.git janjacast
cd janjacast

cat > .env <<EOF
DISCORD_CLIENT_ID=<application id from 2.2>
DISCORD_CLIENT_SECRET=<client secret from 2.3>
JANJACAST_TOKEN_SECRET=$(openssl rand -base64 32)
JANJACAST_EGRESS_BUDGET_KBPS=0
EOF
chmod 600 .env
```

**`JANJACAST_TOKEN_SECRET`** is the one people forget. Without it the server
still boots, but it logs `share tokens will not survive a server restart`,
and every open companion-capture link and telinha link dies on each restart.
It must be base64 of **at least 32 bytes** or the process exits at startup.

**`JANJACAST_EGRESS_BUDGET_KBPS=0` means unlimited**, and 0 is the right
value on a server. Understand what this knob actually is, though:

> It is **not** a spending limit and does not cap total bytes. The server
> publishes the number to the sharer's browser, which lowers its encoding
> bitrate to `budget ÷ viewers` **only while congestion is actually being
> observed**, lifting again after 15 clean seconds. It exists to stop a
> saturated *home* uplink from oscillating — a condition that does not exist
> on a server with a real pipe. Hence 0 here.
>
> On metered billing, do **not** mistake this for cost control: it reduces
> quality under congestion, it does not stop egress. Control spend at the
> provider, with a budget alarm.

Full variable list: [README](../README.md#configuration).

### Vinhetas (optional)

Stingers stay disabled unless a directory is provided:

```sh
mkdir -p stingers && cp /path/to/assets/* stingers/    # .webp/.jpg + .mp3
sed -i 's|# volumes:|volumes:|; s|#   - ./stingers|  - ./stingers|' docker-compose.yml
echo 'JANJACAST_STINGER_DIR=/stingers' >> .env
```

Naming rules: [docs/stingers.md](stingers.md).

---

## 5. Run it

```sh
docker compose up -d
docker compose logs -f janjacast     # expect: "janjacast listening" addr=:8080
```

This pulls `ghcr.io/pedro-hbl/janjacast:latest`, a public multi-arch image
(amd64 + arm64) republished by CI on every push to `main`. Nothing is baked
into it — the Discord client id is served at runtime — so the same image
serves any application.

- **Pin a version** for a deployment you do not want changing under you:
  set `image: ghcr.io/pedro-hbl/janjacast:0.1.0` in `docker-compose.yml`.
- **Build from source instead** (a fork, or local changes):
  `docker compose up -d --build`. The Dockerfile is multi-stage and builds
  the web client itself, so the host needs neither Go nor Node.

**Check:**

```sh
curl -s localhost:8080/api/health
# {"ok":true,"instance":"<hex>","rooms":0,"timers":0}
```

Note that `instance` value — it identifies this exact process, and it is what
makes the verification in step 8 unambiguous.

---

## 6. Put it on HTTPS at a fixed address

Discord only loads Activities over HTTPS. Any of these works; pick by what
you already have.

**A. Domain + reverse proxy with automatic TLS.** Point an A record at the
host, then:

```sh
caddy reverse-proxy --from stream.example.com --to localhost:8080
```

Also set `JANJACAST_PUBLIC_ORIGIN=https://stream.example.com` in `.env`, so
the companion capture tab opens against the right origin.

**B. Named Cloudflare tunnel.** No inbound ports, no certificate management,
and it works on a host with no public IP. Needs a domain on Cloudflare:

```sh
cloudflared tunnel login
cloudflared tunnel create janjacast
cloudflared tunnel route dns janjacast stream.example.com
cloudflared tunnel run janjacast          # point it at http://localhost:8080
```

**C. Quick tunnel** (`docker compose --profile tunnel up -d`) — zero config,
URL printed in the tunnel container's logs. **The hostname is regenerated on
every restart**, and each rotation means editing the portal again. Fine for a
first smoke test; wrong for anything permanent.

**Check:**

```sh
curl -s https://stream.example.com/api/health   # same "instance" as step 5
```

---

## 7. Point the Activity at it

`https://discord.com/developers/applications/<APP_ID>/embedded/url-mappings`

| Prefix | Target |
| ------ | ------ |
| `/` | `stream.example.com` |

The target is a **bare hostname** — no `https://`, no trailing path.

Two traps, both of which have cost real debugging time here:

1. **The first click on "Save changes" frequently does not register**,
   especially right after typing in the field, where the click lands as a
   blur. After clicking, confirm the bottom bar flipped from *"you have
   unsaved changes"* to *"all your edits have been carefully recorded"* — and
   click again if it did not. Never assume it saved.
2. A wrong or stale mapping fails **silently**: blank white frame, no error
   in any log, on either side.

---

## 8. Verify the whole chain without opening Discord

The highest-value check here, and not an obvious one. Discord proxies the
Activity through `https://<APP_ID>.discordsays.com`, and that origin answers
plain `curl` — so mapping, TLS, tunnel and server can all be proven from a
terminal:

```sh
APP_ID=<application id>
curl -s https://$APP_ID.discordsays.com/api/health
```

**Identical `instance` to step 5 means the mapping is live and traffic is
reaching this exact process.** Use `/api/health`, not `/`: HTML can come from
a cache and look perfectly fine while the mapping is broken, whereas the
health payload cannot.

Then confirm the client bundle is being served:

```sh
curl -s https://$APP_ID.discordsays.com/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

Finally the real thing: join a voice channel, open the Activity from the
rocket menu, click **Share screen**, approve the companion tab that opens,
and have a second account watch.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| **Blank white frame** in the Activity | Stale/empty URL mapping, or the origin is unreachable. `index.html` paints a dark ground before any JS runs, so *white* means the page never arrived at all. | Redo step 8; confirm the save in step 7 actually took. |
| Dark frame, UI loads, **stage stays black** | Viewer's decoder never got a keyframe. | Reload the Activity (Ctrl+R) so it picks up the current bundle; check `docker compose logs` for joins. |
| `/telinha` or `/share` returns **404** | Server predates those SPA routes. | `docker compose pull && docker compose up -d`. `TestSPARoutesServeIndex` guards this. |
| Companion/telinha links **die after a restart** | `JANJACAST_TOKEN_SECRET` unset. | Set it (step 4), recreate the container. |
| **No vinhetas** | Directory unset or volume not mounted. | Step 4. The log says `stinger directory unusable` when the path is wrong. |
| **Everyone hears themselves** | Sharer chose whole-screen sound. | In the share tab's sound selector pick *app sound*, and share a window or tab rather than a whole monitor. |
| Log says `every join will be refused` | Client id/secret unset with anonymous access off. | Fill both in `.env`. |
| Joins refused after changing the app | Client id and secret belong to different applications. | Re-copy both from the same app (steps 2.2 and 2.3). |

---

## 10. Before inviting people

- **`JANJACAST_ALLOW_ANON` must stay unset.** It disables join auth entirely
  and exists only for local development and the wire probes.
- `.env` holds the OAuth secret: `chmod 600`, never committed.
- **Room ids are bearer secrets.** Anyone who knows one and can reach the
  server can join that room. This is deliberate and documented — it is the
  reason not to paste room ids publicly.
- Rotate `DISCORD_CLIENT_SECRET` in the portal if it ever reached someone who
  should no longer have it.

---

## 11. Keeping it running

```sh
docker compose pull && docker compose up -d     # published image
git pull && docker compose up -d --build        # building from source
```

The compose healthcheck (`/janjacast healthcheck`) plus
`restart: unless-stopped` bring the container back on its own after a crash
or a host reboot, as long as Docker is enabled at boot.

---

## Mobile, if it comes up

Watching on a phone is viable but unfinished work, which is why the platform
checkboxes in 2.4 should stay off:

- **AV1 is the blocker.** The sharer picks the codec alone and prefers AV1;
  iOS has no software AV1 decoder — only iPhone 15 Pro and newer decode it at
  all — so an AV1 stream is a black screen on most iPhones. The fix is
  forcing H.264 whenever a mobile viewer is in the room.
- **`AudioDecoder` (Opus)** only reached iOS in Safari 26. On older versions
  constructing it throws, so the player needs a guard to degrade to silent
  video instead of breaking.
- **Safe-area insets** (`--discord-safe-area-inset-*`) are unhandled, so the
  UI would sit under the notch.

Sharing *from* a phone is not possible at all — there is no `getDisplayMedia`
on iOS — and the client already hides the share button accordingly.
