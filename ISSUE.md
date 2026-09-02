title: Modo Cinema — synchronized pause with "Rabiscos da Galera"
pitch: "Pausa aí que eu vou pegar pipoca" — quem transmite pausa pra TODO MUNDO de uma vez, cai um cartão INTERVALO de crayon, e a margem vira um caderno de rabiscos compartilhado até a transmissão voltar.
effort: M
author: claude-sonnet-5-1 via TrustBridge

## Pitch (user language)

The sharer can pause the stream for everyone — the picture freezes with a big crayon "INTERVALO" card, and while it's paused everyone doodles together on a shared canvas in the margin, strokes appearing live for the whole room. Resume wipes the doodles and the show goes on. Watching together means pausing together.

## Why now

Brazilian watch-parties (movie nights, YouTube sessions — the core "assistir junto" use since Go Live died) constantly need "pausa aí!" moments, and today each viewer just… keeps watching. Builds on shipped machinery: the relay's room-wide broadcast pattern (stingers), the GOP-cache freeze frame, and the crayon SVG house style already codified in `web/src/doodles.tsx`.

## Scope

- "Pausar pra galera" / "Voltar" button in the companion tab (publisher-only).
- On pause: relay stops forwarding media; every viewer freezes on the last decoded frame; an "INTERVALO 🍿" crayon banner renders as chrome over the frozen stage.
- Shared doodle canvas ("Rabiscos da Galera") appears in the margin — right side on desktop, below the stage under 640px — never over the video.
- One thick crayon brush, 6 fixed colours (from existing tokens), freehand only; local-only undo of your own last stroke.
- Strokes replicate via relay broadcast (normalized 0–1 points); relay keeps the last 100 strokes so late joiners see the canvas mid-intermission.
- Resume clears everything; pausing again starts a fresh canvas.

## Non-goals

- No drawing on the video, ever — the canvas is margin furniture (design.md §2, the stage is sacred; the INTERVALO banner is chrome, not decoration of content).
- No eraser, shapes, text, stickers, brush sizes, or canvas settings (zero-decision: one brush, fixed palette).
- No persistence, export, or doodle history — strokes die on resume; no database.
- No distributed undo (undo is local-only by design — simple and honest).
- No pause by viewers (publisher-only; viewers already have personal pause via their own player if ever needed — out of scope here).

## Implementation plan

1. **Wire protocol types — `internal/protocol/protocol.go`.**
   Client→server: `CtrlCinemaPause`, `CtrlCinemaResume` (no payload), `CtrlCinemaStroke` with `CinemaStrokeData{Color string; Points []Point}`, `Point{X, Y float64}` normalized 0–1. Server→client: `CtrlCinemaState` with `CinemaStateData{Paused bool; Strokes []StrokeData}`, and `CtrlCinemaStrokeAdd` with `StrokeData{UserID, Color string; Points []Point; StrokeID string}`.
   **Verify:** `go build ./internal/protocol/`.

2. **Room state — `internal/relay/relay.go`.**
   Under `r.mu`: `cinemaPaused bool`, `cinemaStrokes []protocol.StrokeData` (cap 100, FIFO). Helpers `cinemaStateLocked()` and `broadcastCinemaStateLocked()` modeled on the stage-state helpers.
   **Verify:** `go build ./internal/relay/`; fresh room reports `{Paused:false}`.

3. **Pause/resume + media gating — `internal/relay/relay.go`.**
   `CinemaPause(c *Client) error` / `CinemaResume(c *Client) error`: publisher-only; resume also clears strokes; both broadcast `CtrlCinemaState`. Gate the media path: in `ForwardMedia`, drop fan-out to viewers while `cinemaPaused` (publisher keeps encoding; the GOP cache keeps updating so resume has a fresh keyframe — reuse the existing `requestKeyframeLocked()` on resume so viewers repaint instantly, same trick as late-join).
   **Verify:** test: pause → viewers stop receiving media messages, state broadcast; resume → keyframe requested, media flows.

4. **Stroke ingestion — `internal/relay/relay.go`.**
   `AddCinemaStroke(c *Client, d *protocol.CinemaStrokeData) error`: only while paused; validate colour against the fixed server-side list, 2–1000 points, coords ∈ [0,1]; per-client rate limit 10 strokes/s (same shape as the stinger 3s cooldown); assign StrokeID; append with FIFO eviction at 100; broadcast `CtrlCinemaStrokeAdd`. Model the whole method on `PlayStinger` — it is the same validate-then-broadcast pattern.
   **Verify:** tests: stroke while unpaused errors; 101st stroke evicts oldest; 11th stroke in 1s rejected; bad coords rejected.

5. **Dispatch — `internal/server/server.go`.**
   Three cases in the control switch beside `CtrlStingerPlay`; failures answer `CtrlError` with `cinema.*` keys.
   **Verify:** `go test ./internal/server/`.

6. **Welcome sequence — `internal/relay/relay.go`.**
   In `Hub.Join`, after the existing `c.enqueueControl(protocol.CtrlWelcome, …)`, enqueue `CtrlCinemaState` (paused flag + stroke backlog) so a late joiner lands mid-intermission correctly.
   **Verify:** test: pause, add 10 strokes, join → new client receives state with 10 strokes.

7. **Client protocol mirror — `web/src/protocol.ts`.**
   Mirror the five controls and the `Point`/`StrokeData`/`CinemaStateData` interfaces.
   **Verify:** `cd web && npm run build`.

8. **Session state — `web/src/session.ts`.**
   Add `cinemaPaused: boolean`, `cinemaStrokes: StrokeData[]`; handle `CtrlCinemaState` (replace both) and `CtrlCinemaStrokeAdd` (append, dedupe by StrokeID).
   **Verify:** two windows: pause in one → both consoles show `cinemaPaused === true`.

9. **Freeze/unfreeze — `web/src/player.ts`.**
   On paused: stop presenting new frames on the canvas but keep the decoder alive (do not reset/close it), and mute/hold the audio clock the video is slaved to. On resume: resume presentation from the next keyframe (the relay's keyframe-on-demand makes this instant). No black frame, no decoder re-init.
   **Verify:** manual: pause mid-motion → picture holds the exact frame; resume → picture continues within ~1s, no artifacts.

10. **Companion-tab button — `web/src/SharePage.tsx`.**
    One `.crayon-btn` next to the stop control: "Pausar pra galera" ↔ "Voltar" driven by `cinemaPaused`. Sends `CtrlCinemaPause`/`CtrlCinemaResume`.
    **Verify:** click toggles state across all windows.

11. **INTERVALO banner — `web/src/App.tsx`.**
    When paused, render `.cinema-banner` centered over the frozen stage: "INTERVALO 🍿" in `--font-hand`, `--surface` wash with wobble radius `--wobble-a`, slight tilt like the share-page lang toggle (+1.5° precedent). This is chrome announcing state — the same license as the on-air badge — not decoration of live video.
    **Verify:** pause → banner in every Activity; resume → gone.

12. **Doodle canvas — new component in `web/src/App.tsx` (rendered from App, drawing helpers may live beside `doodles.tsx`).**
    Visible only while paused. `.crayon-details`-style panel titled "Rabiscos da Galera": an `<svg viewBox="0 0 800 450">` on paper texture, a row of 6 colour swatches (`--redorange`, `--crayon-blue`, `--yellow`, `--grass`, `--pink`, `--purple` — existing tokens only), and "Desfazer". Pointer handlers: pointerdown starts a stroke, pointermove appends (rAF-throttled), pointerup normalizes and sends `CtrlCinemaStroke`.
    **Verify:** local drawing renders immediately (before echo), swatch selection has `aria-pressed`.

13. **Stroke rendering — same component.**
    Each `StrokeData` renders as an SVG `<path>` built from quadratic segments with slightly uneven control points — the exact house rule from `doodles.tsx` (round caps, no symmetry), `stroke-width` 6, the stroke's colour. Newest stroke gets a 200ms dash draw-on. Memoize path `d` strings.
    **Verify:** two windows: draw in each → both see both, colours/positions match; 100 strokes stay smooth (no layout thrash in the Performance tab).

14. **Local undo — same component.**
    Track own StrokeIDs; "Desfazer" hides your last stroke locally only (no delete control on the wire). Disabled at zero.
    **Verify:** undo removes locally, other window still shows it (expected and documented).

15. **i18n — `web/src/i18n.ts`** (`cinema.*`, both dictionaries):
    - `cinema.pause` en "Pause for everyone" / pt "Pausar pra galera"; `cinema.resume` en "Resume" / pt "Voltar".
    - `cinema.interval` en "INTERMISSION 🍿" / pt "INTERVALO 🍿".
    - `cinema.canvasTitle` en "Group scribbles" / pt "Rabiscos da galera"; `cinema.undo` en "Undo" / pt "Desfazer".
    - Swatch aria-labels: `cinema.colorRed`…`cinema.colorPurple` (plain colour names — the accessibility layer stays literal per docs/i18n.md §3).
    - `error.cinema.notPublisher` en "⛔ Only the person sharing can pause." / pt "⛔ Só quem tá transmitindo pode pausar."
    - `error.cinema.rateLimited` en "⛔ Easy! You're drawing too fast." / pt "⛔ Calma! Você tá desenhando rápido demais."
    - `error.cinema.badStroke` en "⛔ That stroke didn't go through — try a shorter one." / pt "⛔ Esse traço não foi — tenta um mais curto."
    Register: "pra galera" is the app talking to a friend; "tá" allowed in the two state-narration errors; buttons keep full verbs.
    **Verify:** `make all`; both languages at 440px (canvas drops below the stage, toolbar wraps).

16. **Icons — `web/src/doodles.tsx`.**
    `PauseDoodle` (two wobbly bars), `PlayDoodle` (uneven triangle), `UndoDoodle` (counter-clockwise arrow) per house rules (1.4–2.4 strokes in a ~24 viewBox, round caps, aria-hidden).
    **Verify:** render at 20px and confirm they stay characters, not blobs.

17. **Styling — `web/src/theme.css`.**
    `.cinema-banner`, `.cinema-canvas`, `.cinema-toolbar`, `.color-swatch` using existing tokens (`--surface`, `--text`, `--muted`, wobble radii, `--shadow-ink`, `--hover-wash`). Under 640px the canvas panel moves below the stage at full width. Swatches ≥24×24 (SC 2.5.8, same bar the lang toggle clears).
    **Verify:** visual pass on both grounds and at 440px; nothing overlaps the video while playing.

18. **Relay tests — `internal/relay/relay_test.go`.**
    Pause/resume lifecycle; stroke replication; FIFO cap; late-joiner backlog; non-publisher rejection; strokes-only-while-paused; resume clears; media gating (viewer receives no media while paused).
    **Verify:** `go test ./internal/relay/ -v -run Cinema`.

19. **Manual E2E.**
    `JANJACAST_ALLOW_ANON=1 ./janjacast`, 3 windows + a 4th joining mid-pause, at `?room=demo&lang=pt` and `&lang=en`. Pause → draw from three windows → late joiner sees backlog → undo → resume clears → pause again is fresh. Check 440px and both grounds.
    **Verify:** full flow clean in both locales; freeze/resume artifact-free.

## Acceptance criteria

- [ ] Publisher-only pause freezes every viewer on the last frame and stops relay media fan-out (publisher's uplink unaffected in shape; egress drops to ~0 while paused).
- [ ] "INTERVALO 🍿" banner shows on every Activity while paused; never during play.
- [ ] Doodle canvas appears only while paused, in the margin (right ≥640px, below stage under 640px), never over the video.
- [ ] Strokes replicate to all viewers with matching colour/position; wobbly crayon rendering per doodles.tsx house rules.
- [ ] Relay caps strokes at 100 FIFO, rate-limits 10/s/user, validates colour/points/coords; violations answer glyph-led errors.
- [ ] Late joiners during a pause receive the frozen state and full stroke backlog.
- [ ] Undo removes only your own last stroke, only locally.
- [ ] Resume requests a keyframe, restores video within ~1s, and clears the canvas everywhere.
- [ ] All strings in en + pt-BR (build-enforced), register per docs/i18n.md, no overflow at 440px.
- [ ] `go test ./internal/relay/ -run Cinema` green; manual 4-window E2E passes.

## Risks & guardrails

- **Offensive doodles** → ephemeral (die on resume), capped at 100, margin-sized, and everyone is an identifiable friend — the room's own social contract moderates; publisher can always resume to wipe.
- **Relay memory/bandwidth** → 100 strokes × ≤1000 points ≈ tens of KB per room; stroke rate limit caps message flood.
- **Decoder state bugs on resume** → keep decoder alive + keyframe-on-demand (both already battle-tested by late-join); never reset the pipeline.
- **Mobile perf** → SVG with memoized paths and rAF-throttled input; 100-stroke ceiling bounds render cost.
- **Crayon rule** → banner is state chrome, canvas is margin: the frame stays loud, the middle stays silent.

## Effort

**M** — media gating + freeze handling touch the player pipeline carefully, and stroke replication is a new (small) realtime surface; but every pattern (validate-broadcast, keyframe-on-demand, GOP freeze) already exists. ~3 days.
