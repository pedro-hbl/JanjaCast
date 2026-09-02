title: Reações em Rajada — Crayon Reaction Storms
pitch: Tap an emoji and it rises in crayon along the video's edge; when the whole call reacts together the reactions cluster into a storm, a hype meter climbs, and at peak a stinger fires by itself.
effort: M
author: claude-opus-5 via TrustBridge

# Reações em Rajada — Crayon Reaction Storms

## Pitch
Toca um emoji e ele sobe na borda do vídeo em giz; quando o pessoal reage junto, os emojis se acumulam e a tela "esquenta" com um medidor de hype que o streamer sente. Se a galera surtar de vez, uma stinger dispara sozinha e o clima vira festa.

## Why now
The Brazilian moment is watch-parties and gaming groups reacting *together* — "assistir junto" only lands if the room feels alive. We already have the stinger broadcast overlay and the server-picked-random pattern; storms reuse both, so a room-scale hype signal is cheap to add and directly serves the co-watching audience.

## Scope / Non-goals
**In:** curated fixed reaction set (6 emoji, crayon-drawn), tap-to-react from the Activity, relay aggregates counts in a sliding window and fans density back, edge-pinned rising animation, a hype meter shown to everyone (bigger for the sharer), and an auto-stinger trigger when density crosses a threshold (reusing the existing server-side stinger broadcast).
**Non-goals:** no reaction editor, no custom emoji upload, no per-viewer reaction history, no reactions over the center of the video, no reaction persistence across sessions, no text chat.

## Implementation plan

### Step 1 — Protocol: reaction control messages
In `internal/protocol/protocol.go` add `CtrlReaction` (client→relay: `ReactionData{Emoji string}`) and `CtrlReactionBurst` (relay→clients: `ReactionBurstData{Counts map[string]int, Density int, WindowMs int}`), following the existing `Control{Type, Data}` envelope pattern. Add the allowed set `ReactionEmojis = []string{"fire","laugh","heart","skull","clap","shock"}` and a validator `ValidReactionEmoji(s string) bool`. Mirror both types and the set in `web/src/protocol.ts`.
**Verification:** `go test ./internal/protocol/...` passes; a new table test asserts `CtrlReaction`/`CtrlReactionBurst` round-trip through the JSON envelope and that `ValidReactionEmoji` rejects an unknown string.

### Step 2 — Relay: aggregate reactions in a sliding window
In `internal/relay/relay.go` add a per-room `reactionWindow`: a ring of timestamped emoji events over a 1500 ms window, guarded by `Room.mu`. On `CtrlReaction` from any joined client, append the event; on a 250 ms ticker, sum per-emoji counts and total density and — only when non-zero — fan one `CtrlReactionBurst` to all room clients. Apply a 200 ms per-client cooldown on `CtrlReaction`, reusing the per-client cooldown pattern from `PlayStinger` (relay.go, under `Room.mu`).
**Verification:** in `internal/relay/relay_test.go` add `TestReactionAggregation`: inject 5 `CtrlReaction` from 3 fake clients within 300 ms, advance the ticker, assert exactly one `CtrlReactionBurst` fans to all clients with correct summed counts; assert a 6th reaction from one client 50 ms after its last is dropped by cooldown (mirror the shape of `TestPlayStingerCooldown`).

### Step 3 — i18n keys for the reaction bar
In `web/src/i18n.ts` add (typed off `en`, which forces the pt-BR entries at compile time):
- `reactions.bar.label` — en: `"React"`, pt-BR: `"Reagir"`
- `reactions.aria.fire` — en: `"Fire reaction"`, pt-BR: `"Reação de fogo"` (and one aria key per emoji: laugh/heart/skull/clap/shock)
- `reactions.hype.calm` — en: `"Chill"`, pt-BR: `"De boa"`
- `reactions.hype.warm` — en: `"Heating up"`, pt-BR: `"Esquentando"`
- `reactions.hype.storm` — en: `"STORM!"`, pt-BR: `"REBU!"`
**Verification:** `cd web && npx tsc --noEmit` compiles; temporarily delete one pt-BR string and confirm the missing-key type error appears, then restore.

### Step 4 — Reaction bar UI + send wiring
Create `web/src/reactions.tsx` exporting `<ReactionBar/>`: a corner-pinned (bottom-right, outside the video center) row of 6 crayon emoji doodles added to `web/src/doodles.tsx` as hand-drawn SVGs. Tapping sends `CtrlReaction` via `session.ts`. Style with semantic tokens plus crayon-box fills (`--crayon-blue`, `--angry`) and reuse the `.seg` button shape from `theme.css`. Mount `<ReactionBar/>` in `App.tsx`'s stage layer, never overlapping the center safe-zone; per design.md § "The stage is sacred", it sits on a translucent ink wash, corner-pinned.
**Verification:** `JANJACAST_ALLOW_ANON=1 ./janjacast`, open `http://localhost:8080/?room=demo` in two Chromium windows; click fire in window A, confirm window B's WS receives a `CtrlReactionBurst` (devtools → Network → WS frames).

### Step 5 — Rising crayon reaction animation
In `reactions.tsx` add a transient float layer: on each `CtrlReactionBurst`, spawn N crayon emoji sprites (N = per-emoji count, capped at 12) that rise along the left/right edges with a hand-drawn wobble and fade over 1.2 s. Add `.reaction-float` in `theme.css` using `translateY` + `opacity` keyframes; sprites auto-remove on `animationend`. Enforce a center safe-zone rect in code so nothing spawns over the picture.
**Verification:** two-window flow; spam fire in window A, observe wobbling emoji rising only on the edges in window B, gone within ~1.2 s, never crossing the center.

### Step 6 — Hype meter
In `reactions.tsx` add `<HypeMeter/>` reading rolling `Density` from `CtrlReactionBurst`: a small crayon gauge in the footer band (below the stage frame, never over it) with three states mapped to `reactions.hype.*`. Show a larger, animated variant to the publisher (detect via the existing publisher flag in session state).
**Verification:** two-window flow with one publisher; drive density up with rapid reactions, confirm the meter climbs calm→warm→storm and the amplified variant appears only in the publisher window.

### Step 7 — Auto-stinger on storm
In `internal/stinger/store.go` add a `StormTrigger bool` flag per asset (default false; persisted by `disk.go`), plus a checkbox in the `web/src/stingers.tsx` drawer (served/updated via the existing `internal/server/stingers.go` endpoints). In `relay.go`, when window density crosses the threshold (≥ 15 reactions in-window) and no storm stinger fired in the last 20 s, pick a random *enabled, StormTrigger* asset and broadcast an ordinary `CtrlStinger` through the existing server-picked-random path — the client overlay needs no new machinery.
**Verification:** `go test ./internal/relay/... -run TestStormStinger`: cross the threshold with a storm-flagged asset present, assert exactly one `CtrlStinger` broadcast; cross again 5 s later, assert none (cooldown holds); with no storm-flagged assets, assert nothing fires.

## Acceptance criteria
- Tapping a reaction in one window makes an edge-pinned crayon emoji rise in all windows within ~0.5 s.
- No reaction sprite, meter, or hype element ever renders over the center video safe-zone.
- Rapid reactions from multiple viewers raise a shared hype meter through calm→warm→storm.
- A storm crossing the threshold fires exactly one room stinger, then respects a ≥ 20 s cooldown.
- Only the 6 curated emoji exist; unknown emoji strings are rejected server-side.
- The per-client reaction cooldown prevents a single viewer from flooding.
- All strings render correctly under both the EN and PT toggles.

## Risks & guardrails
- **Flood/DoS:** 200 ms per-client cooldown + relay-side unknown-emoji rejection + sprite cap (12/burst) bound both wire traffic and render cost.
- **Stage sacredness:** sprites and meter are constrained to edge/footer coordinates by a center safe-zone rect enforced in `reactions.tsx`; verified visually in Step 5.
- **Stinger spam from storms:** 20 s auto-storm cooldown in the relay, gated on an explicit per-asset `StormTrigger` opt-in.
- **Bandwidth:** `CtrlReactionBurst` is one small JSON per 250 ms per room regardless of reaction volume (aggregated, not per-event fan-out) — nothing touches the media path or the egress budget meaningfully.

## Effort: M
