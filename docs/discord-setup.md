# Running JanjaCast as a Discord Activity

Discord Activities are web apps embedded in an iframe inside voice calls.
Getting JanjaCast running inside Discord takes four steps.

## 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and click **New Application**.
2. Note the **Application ID** (a.k.a. client id) from *General Information*.
3. Under **OAuth2**, note the **Client Secret**.
4. Under **Activities → Settings** (the portal shows this section once your
   app has the Activities feature), enable Activities for the app.

## 2. Serve JanjaCast over HTTPS

Discord only loads Activities over HTTPS. For local development the simplest
path is a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):

```sh
# terminal 1 — the server (client id/secret from step 1)
export DISCORD_CLIENT_ID=<app id>
export DISCORD_CLIENT_SECRET=<client secret>
make all && ./janjacast

# terminal 2 — public HTTPS tunnel to it
cloudflared tunnel --url http://localhost:8080
```

`cloudflared` prints a `https://<random>.trycloudflare.com` URL — that's your
activity origin for the next step.

> The client bundle needs the application id baked in at build time:
> `cd web && JANJACAST_DISCORD_CLIENT_ID=<app id> npm run build` (or pass it as a
> build arg to `docker compose`, see the repo README).

## 3. Configure URL mappings

In the developer portal under **Activities → URL Mappings**, set the root
mapping:

| Prefix | Target                          |
| ------ | ------------------------------- |
| `/`    | `<random>.trycloudflare.com`    |

All requests from the Activity iframe are proxied by Discord through
`https://<app id>.discordsays.com` to this target. JanjaCast's client prefixes
its API and WebSocket paths with `/.proxy/` as Discord requires.

## 4. Launch it

1. In the portal, add your test server under **App Testers** / enable
   developer mode, or just use the **Activities → Launch** test instructions.
2. In Discord, join a voice channel, open the Activities (rocket) button, and
   pick your app.
3. Click **Share screen**.

## Known constraints inside Discord

- **No WebRTC** — Activities only get WebSockets/HTTPS through Discord's
  proxy. JanjaCast is built around that (WebCodecs over WebSocket).
- **Screen capture from the iframe is blocked** (confirmed: `Access to the
  feature "display-capture" is disallowed by permissions policy`). The Share
  button therefore opens a companion tab in the sharer's real browser
  (`/share?room=...`) that owns the capture; viewers are unaffected and watch
  inside the Activity.
- **Tab/system audio capture** is Chromium-specific: tab audio works broadly,
  full system audio only on Windows.
