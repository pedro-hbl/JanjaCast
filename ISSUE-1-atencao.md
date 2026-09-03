[opus -> claude-opus-5 via TrustBridge]
# JanjaCast Feature Issue — PM #pm1

## My lane (why no generic PM would pick this)
Every other PM is shaping *watch-party engagement* (reactions, clips, polaroids, scoreboards). I'm picking the **abandonment lane**: the single most common failure in a Brazilian friend-group stream is *"cadê todo mundo? o stream tá rodando pra ninguém"* — the publisher keeps streaming into an empty room because Discord Activities give **zero attention signal**. Nobody knows if people are actually *looking* at the tab or if it's minimized behind the game. I'm shaping a **collective presence-of-attention signal on the wire**, not more content.

---

## Title
**Tá todo mundo aí? — collective "eyes on stream" awareness (relay-aggregated focus census)**

## Pitch
Sabe quando você tá compartilhando e não faz ideia se a galera tá assistindo ou se minimizou tudo pra jogar? O JanjaCast agora mostra uma barra viva de "olhos na tela" — quantos realmente estão com a Activity em foco *agora* — e avisa o publisher com um toque discreto ("**Esvaziou a sala 👀**") quando a atenção despenca, sem nunca poluir o vídeo.

## Why now
Discord Activities have no native "is this tab focused/visible" broadcast, and Brazilian friend-groups stream for hours — the #1 silent frustration is streaming into a void. This is pure wire-observable presence data (Page Visibility API → relay census → fan-out), respects zero-decision (no opt-in, no settings), and lives *around* the frame per the crayon rule. No other backlog item touches **attention**, only content.

## Scope / Non-goals
**In scope:**
- Each viewer client reports focus/visibility state changes to the relay.
- Relay aggregates a live census (watching / here-but-away counts) and fans it out.
- A crayon "olhos na tela" strip in the roster/edge area (never over video).
- A publisher-side threshold nudge when attention collapses.

**Non-goals:**
- No per-person "you were caught not watching" callouts (privacy/toxicity).
- No gaze/webcam tracking — purely Page Visibility + window focus.
- No settings/knobs. No persistence beyond room lifetime.
- Nothing rendered over the center video.

---

## Implementation plan (small steps, each one concern + probeable Verify)

### Step 1 — Client emits focus state on visibility change
**Concern:** Wire a `focus_state` client→relay message driven by `document.visibilitychange` + `window` blur/focus (debounced 500ms).
**Verify:** Probe connects as viewer A, drives a `visibilitychange` (hidden). Assert relay *receives* `{type:"focus_state", state:"away", client_id:A}`. Flip to visible → assert `{type:"focus_state", state:"watching"}`.

### Step 2 — Relay tracks per-room focus map
**Concern:** Relay stores `client_id → state` in the room struct; defaults new joiners to `"watching"`.
**Verify:** Viewer B joins after A is `away`. Probe asserts relay internal census on next broadcast reflects `watching:1, away:1` (see Step 3 for the wire message carrying it).

### Step 3 — Relay broadcasts aggregate census (counts only, no names)
**Concern:** On any focus_state change (rate-limited to 1 broadcast/sec), fan out `focus_census` with counts only.
**Verify:** With A=away, B=watching, probe on client C asserts broadcast `{type:"focus_census", watching:1, away:1, total:2}`. Assert **no** `client_id` list is present in the payload.

### Step 4 — Publisher receives the same census (it's a broadcast)
**Concern:** Ensure publisher socket is in the fan-out set for `focus_census`.
**Verify:** Probe as publisher P; drive two viewers to `away`. Assert P receives `focus_census` with `away:2`. Assert census excludes P's own publisher connection from `total`.

### Step 5 — Relay fires attention-collapse nudge to publisher only
**Concern:** When `watching / total < 0.34` **and** total ≥ 3, relay sends `attention_low` **unicast to publisher** (once per 60s cooldown).
**Verify:** Probe: P + 3 viewers, drive all 3 to `away`. Assert **only P** receives `{type:"attention_low", watching:0, total:3}`. Assert viewers A/B/C do **not** receive it. Re-drive within 60s → assert no second `attention_low`.

### Step 6 — Recovery signal clears the state
**Concern:** When ratio climbs back ≥ 0.5, relay sends `attention_ok` unicast to publisher (resets cooldown).
**Verify:** From collapsed state, drive 2 viewers back to `watching`. Assert P receives `{type:"attention_ok", watching:2, total:3}`.

### Step 7 — Disconnect cleans the census
**Concern:** On viewer socket close, remove from focus map and re-broadcast census.
**Verify:** With `watching:2, away:1`, disconnect the `away` viewer. Assert next `focus_census` broadcast is `{watching:2, away:0, total:2}`.

### Step 8 — Client renders crayon "olhos na tela" strip (roster edge, never over video)
**Concern:** Render census counts as a hand-drawn strip in the roster area; publisher sees the "**Esvaziou a sala 👀**" toast on `attention_low`, cleared on `attention_ok`.
**Verify:** Committed component test: given `focus_census {watching:1, away:1, total:2}`, assert DOM shows `1 assistindo` / `1 deu uma saidinha` in the roster region and **no** node overlaps the video canvas bounding box. Given `attention_low`, assert toast text `Esvaziou a sala 👀` renders; given `attention_ok`, assert toast removed.

---

## Acceptance criteria
1. A viewer switching tabs produces exactly one debounced `focus_state:"away"` at the relay within 500ms (→ Step 1 probe).
2. Every focus change yields a `focus_census` broadcast to **all** clients including publisher, carrying only aggregate counts, never `client_id`s (→ Steps 3–4).
3. When watching-ratio < 0.34 with total ≥ 3, **only the publisher** gets `attention_low`, at most once per 60s (→ Step 5).
4. Recovery ≥ 0.5 ratio sends `attention_ok` to publisher and resets the cooldown (→ Step 6).
5. Viewer disconnect updates census counts within one broadcast (→ Step 7).
6. UI shows counts in pt-BR/en-US in the roster edge, publisher toast `Esvaziou a sala 👀` / `Room's gone quiet 👀`, and nothing renders over the video canvas (→ Step 8 test).

## Risks
- **False "away" on legit backgrounding** (music, alt-tab to look something up): mitigated by ratio+total thresholds and 60s cooldown, framed as soft ("deu uma saidinha", not "abandoned").
- **Privacy optics** — must stay aggregate-only; per-person exposure would be toxic. Enforced by Step 3 asserting no `client_id` in census.
- **Telinha/watch-only mirror clients** could skew counts; treat `:telinha` identity as `away` by default (small follow-up if it distorts).
- Rate-limiting must prevent focus-flapping storms on the relay (1 broadcast/sec cap).

## Effort
**M** — client visibility wiring + roster UI are small; relay census/threshold/cooldown state and the seven wire messages are the bulk, all cleanly probeable.
