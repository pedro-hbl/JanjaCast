title: Clipe Instantâneo — Relay-Side Instant Clip
pitch: Any viewer hits "clipa isso!" and the relay carves the last ~30 seconds out of its rolling keyframe buffer — a remux, not a re-encode — served straight from the relay origin for a one-click download.
effort: M
author: claude-opus-5 via TrustBridge

# Clipe Instantâneo — Relay-Side Instant Clip

## Pitch
Aconteceu algo épico? Qualquer um aperta "clipa isso!" e o relay recorta os últimos ~30 segundos na hora, sem re-encodar. Você baixa o clipe direto e joga no chat — sem CDN, sem servidor externo, tudo saindo da própria sala.

## Why now
The relay already sees a keyframe-delimited stream and keeps a GOP cache — a rolling buffer is a small extension of infrastructure we already run, and no WebRTC competitor has a central point that holds the recent frames at all. For co-watching gaming groups the payoff is huge: the clutch play gets captured and dropped in chat while it's still funny. And because Discord's CSP blocks external CDNs, serving the clip from the relay origin is the *only* compliant way — which also happens to be the simplest.

## Scope / Non-goals
**In:** a rolling ~30 s keyframe-delimited buffer in the relay, a "clipa isso!" action for any viewer, server-side remux (never re-encode) into a downloadable container, delivery from the relay origin via an HMAC-signed expiring URL, and a download step that escapes the CSP-restricted Activity iframe (new browser tab).
**Non-goals:** no re-encoding, no editing/trimming UI, no clip-length choice (zero-decision: 30 s is the clip), no audio mixing beyond what's in the stream, no S3/CDN upload, no clip gallery or persistence beyond a short expiry, no in-iframe playback of the finished clip.

## Implementation plan

### Step 1 — Relay: rolling clip buffer
In `internal/relay/relay.go` add a per-room `clipBuffer`: a ring of published media messages (they already carry the 13-byte header with the keyframe flag and temporal layer — store all layers, full quality) trimmed to the most recent ~30 s, always starting at a keyframe boundary: on trim, drop only whole GOPs. Cap by both time (~30 s) and a hard byte ceiling to protect the single binary's memory. Audio chunks are buffered alongside video so the clip has sound.
**Verification:** in `internal/relay/gop_test.go` add `TestClipBufferKeyframeBoundary`: feed keyframe + delta messages exceeding 30 s, assert the buffer's first video message is always a keyframe, total span ≤ ~30 s, and total bytes ≤ the ceiling.

### Step 2 — Protocol: clip request/ready
In `internal/protocol/protocol.go` add `CtrlClip` (viewer→relay: empty payload) and `CtrlClipReady` (relay→requester only: `ClipReadyData{URL string, ExpiresMs int}`). Mirror in `web/src/protocol.ts`.
**Verification:** `go test ./internal/protocol/...`; round-trip test for both types.

### Step 3 — Relay: remux the buffer on request
On `CtrlClip`, snapshot the clip buffer and remux the chunks into a container chosen by the active `ConfigData.VideoCodec`: fragmented MP4 for `avc1.*` (H.264 + Opus), WebM for `vp8`/`av01.*` — byte-level muxing only, no decode. The decoder init data the muxer needs (SPS/PPS or codec description) is what `CtrlConfig` already carries; reuse it. Store the result in a short-lived in-memory map keyed by a random HMAC-signed token (reuse the share-token signing from `internal/server/auth.go`), expiry ~120 s. Apply a per-client cooldown (~5 s) on `CtrlClip`, reusing the `PlayStinger` cooldown pattern under `Room.mu`. Reply to the requester with `CtrlClipReady{URL, ExpiresMs}` where URL is a relay-origin path.
**Verification:** `go test ./internal/relay/... -run TestClipRemux`: request against a filled buffer, assert a token is issued and the stored container opens with a valid init segment + keyframe; assert a second request from the same client inside the cooldown is refused (mirror `TestPlayStingerCooldown`).

### Step 4 — Server: serve the clip from the relay origin
In `internal/server/server.go` add `GET /clip/{token}`: validate the HMAC token via `auth.go`, return the remuxed bytes with correct `Content-Type` and `Content-Disposition: attachment; filename="janjacast-clip.mp4"` (or `.webm`); 404 on expired or unknown tokens. Served by the same binary — no new infrastructure.
**Verification:** `go test ./internal/server/... -run TestServeClip`: valid token → 200 with attachment header; expired/unknown → 404. Manually: `curl -OJ http://localhost:8080/clip/<token>` downloads a file that plays in a media player from its first frame.

### Step 5 — i18n keys for the clip action
In `web/src/i18n.ts` add:
- `clip.button` — en: `"Clip that!"`, pt-BR: `"Clipa isso!"`
- `clip.working` — en: `"Cutting the last 30s..."`, pt-BR: `"Recortando os últimos 30s..."`
- `clip.ready` — en: `"Clip's ready — grab it"`, pt-BR: `"Clipe pronto — pega aí"`
- `clip.download` — en: `"Download"`, pt-BR: `"Baixar"`
- `clip.cooldown` — en: `"Hang on a sec"`, pt-BR: `"Calma aí, já já"`
- `clip.expired` — en: `"That clip expired"`, pt-BR: `"Esse clipe expirou"`
(Units stay untranslated per docs/i18n.md: "30s" is a unit.)
**Verification:** `cd web && npx tsc --noEmit` compiles; toggle EN/PT and confirm all strings render; check at 440px.

### Step 6 — Clip button + request wiring in the Activity
In `web/src/App.tsx` add a corner-pinned "Clipa isso!" crayon button (edge-pinned on the ink-wash tier with the zoom/fullscreen controls, never over the video center), enabled only while the room is live. On click, send `CtrlClip` via `session.ts`, show `clip.working`, and disable for the cooldown window showing `clip.cooldown` on early re-press.
**Verification:** two-window flow (`JANJACAST_ALLOW_ANON=1 ./janjacast`, publisher streaming): click the button in the viewer window, confirm `CtrlClip` out and `CtrlClipReady` back (devtools WS frames), and the button disables for the cooldown.

### Step 7 — Deliver the clip outside the iframe
On `CtrlClipReady`, show `clip.ready` with a `clip.download` action. The Activity iframe is CSP-restricted (everything through Discord's proxy), so the download must escape it: open the relay-origin `/clip/{token}` URL via the same external-open mechanism the companion tab already uses (`openCompanion()`'s pattern in `web/src/discord.ts`), landing in a real browser tab where the file downloads and the user drops it into Discord chat. If the token has expired by the time they click, the tab 404s — show `clip.expired` on a failed follow-up.
**Verification:** two-window flow: after `CtrlClipReady`, click Baixar, confirm a new browser tab opens the relay-origin URL and downloads a playable ~30 s clip; wait past expiry and confirm the expired message path.

## Acceptance criteria
- Any viewer in a live room can hit "Clipa isso!" and get a downloadable clip of the last ~30 s within a couple of seconds.
- The clip is remuxed, never re-encoded, and always starts on a keyframe (plays from the first frame with audio).
- The clip is served exclusively from the relay origin — no external CDN/S3 URL exists anywhere in the feature.
- The download happens in a browser context outside the Activity iframe.
- A second clip request from the same viewer inside the cooldown is refused with a friendly message.
- Clips expire (~120 s); an expired token 404s and the UI says so.
- All strings render in EN and PT.

## Risks & guardrails
- **Memory blowup on the single binary:** the rolling buffer is capped by time *and* a hard byte ceiling; finished clips live in a ~120 s-expiry map — both asserted in Steps 1 and 3.
- **CSP violation:** the clip is served from the relay origin and opened in a real browser tab, never fetched or played inside the iframe — verified in Step 7.
- **Unplayable clip (mid-GOP start / missing init data):** whole-GOP trimming plus init data taken from the live `ConfigData` — asserted in `TestClipBufferKeyframeBoundary` and `TestClipRemux`.
- **Request flood:** ~5 s per-client cooldown (reused stinger pattern) plus HMAC-signed expiring tokens prevent spam and URL enumeration.
- **Unauthorized access:** `/clip/{token}` validates HMAC via the existing `auth.go` machinery; tokens are unguessable and short-lived, matching the room-id-as-bearer-secret posture.
- **Egress on residential uplinks:** a clip download is a burst on the same uplink the stream uses; serve clip downloads at a throttled rate and count them against the existing `JANJACAST_EGRESS_BUDGET_KBPS` accounting so a download never starves the live stream.

## Effort: M
