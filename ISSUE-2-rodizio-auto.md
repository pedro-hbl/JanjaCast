[sonnet -> claude-sonnet-5-1 via TrustBridge]
# Rodizio Automático com Chapéu do Tempo

**Title:** Rodizio Automático com Chapéu do Tempo

**Pitch (user language, pt-BR):**  
Rodízio cronometrado automático com chapéu visual: o apresentador atual vê quanto tempo ainda tem, a sala vê um chapéu de festa crayonizado que enche conforme o tempo passa, e quando esgota o sistema entrega automaticamente para o próximo da fila—sem negociação, sem constrangimento. Perfeito para noites de jogo onde todo mundo quer mostrar *aquela fase* mas ninguém quer ser o chato que pede a vez de volta.

---

## Why now

1. **Brazilian watch-party culture demands fairness infrastructure.** The existing `rodizio` turn mode already signals the need, but currently the handoff depends on the current publisher voluntarily stopping or someone else claiming—creating social friction ("mais 5 minutinhos?" forever). With Go Live banned and JanjaCast being *the* screen-share, Brazilian friend-groups are running longer multi-hour sessions where time-boxing turns is now table stakes.

2. **The technical surface is ready.** `Corrente da Tela` (live) already proves room-wide countdown + auto-handoff; stage queue + `rodizio` mode (live) prove turn order; the relay tracks `stream_start` timestamps. We need only wire a timer, a visual fuel gauge both sides can see, and an automatic trigger—no new subsystems.

---

## Scope / Non-goals

**In scope:**
- Per-turn countdown timer (admin-set duration: 5/10/15/20/30 min, default 15).
- Real-time "chapéu" (party-hat) visual widget overlaid *outside the video* (respects "nothing over center video"), fills crayon-style as time elapses.
- Publisher sees time-remaining in the companion tab (e.g., "Seu tempo: 12:34").
- Relay enforces time limit: auto-sends `force_stop` to current publisher + `stage_warmup` to next-in-line (reusing `Fila do Proximo` unicast), then standard stage handoff.
- Room message: "Acabou o tempo! Próxima pessoa: @Usuario" (visual + transient toast).
- Admin toggle on lobby: "Rodízio automático" ON/OFF + duration picker (only appears when queue mode = `rodizio`).

**Non-goals:**
- Extending time / negotiation UI (zero-decision: the timer is the social contract).
- Pausing the timer during `INTERVALO` cinema mode (complexity; admin can choose longer durations).
- Per-user custom durations (fairness = uniform turns).
- Recording whose turn was longest (not a competition; trophies cover session stats).

---

## Implementation plan

### 1. Relay: wire turn-timer state into the room session  
**Concern:** The relay currently tracks `publisher_id` and `stream_start_time` but has no concept of turn expiry or admin timer config.  
**Steps:**  
- Add `room.TurnDuration time.Duration` and `room.AutoRodizioEnabled bool` fields (zero-value = OFF).  
- On `ConfigUpdate{auto_rodizio: true, turn_minutes: 15}` from admin, persist in room state.  
- On every `StreamStart` broadcast, record `room.CurrentTurnDeadline = now + TurnDuration` if `AutoRodizioEnabled && QueueMode == "rodizio"`.  
**Verify:** Probe sends `{type: "config_update", auto_rodizio: true, turn_minutes: 10}` from admin user; assert relay's `RoomState` response includes `"auto_rodizio_enabled": true, "turn_duration_sec": 600`; probe sends `stream_start` from publisher A; assert `RoomState` now includes `"turn_deadline_unix": <now+600>`.

---

### 2. Relay: background goroutine enforces turn deadline  
**Concern:** We need a ticker that checks deadlines without blocking the main message loop or creating a goroutine-per-room leak.  
**Steps:**  
- Spawn one `turnTimerWorker(ctx)` per relay (started in `main`), ticks every 2 seconds.  
- Worker iterates `server.rooms`, checks `room.AutoRodizioEnabled && time.Now().After(room.CurrentTurnDeadline)`.  
- On expiry: worker sends internal event `TurnExpired{RoomID, PublisherID}` into room's message channel (reuses existing concurrency model).  
- Room handler on `TurnExpired`: call existing `forceStopPublisher()`, then `advanceQueueAndWarmupNext()` (reuse `Fila do Proximo` + `Corrente` logic), broadcast `{type: "turn_expired", next_user: {...}}`.  
**Verify:** Probe configures `turn_minutes: 0.05` (3 seconds) and starts stream from user A with user B queued; probe waits 4 seconds; assert probe client B receives `{type: "turn_expired"}` and then `{type: "stage_warmup"}` within 500ms; assert client A receives `{type: "force_stop"}`.

---

### 3. Relay: broadcast live chapéu fuel percentage every 5 seconds  
**Concern:** Clients need incremental updates to animate the hat smoothly, but we can't spam the wire every frame.  
**Steps:**  
- In room broadcast loop, if `AutoRodizioEnabled && publisher active`, compute `elapsed = now - stream_start`, `percent = min(100, elapsed/TurnDuration*100)`.  
- Every 5s (tracked via `time.Ticker`), broadcast `{type: "turn_progress", percent_elapsed: 67, seconds_remaining: 300}` to all participants.  
- On `StreamStart`, immediately send `turn_progress` with `0` to reset client UI.  
**Verify:** Probe starts stream with `turn_minutes: 1`; probe asserts it receives `{type: "turn_progress", percent_elapsed: 0, seconds_remaining: 60}` within 1s of `stream_start`; probe waits 30s, asserts next `turn_progress` has `percent_elapsed` ≥ 45 and ≤ 55; waits another 30s, asserts ≥ 95.

---

### 4. Activity UI: render chapéu widget in top-left stage corner (outside video)  
**Concern:** Must respect "nothing over center video"; crayon aesthetic must feel playful, not corporate countdown.  
**Steps:**  
- New SolidJS component `<ChapeuTimer percent={progressSignal()} remaining={remainingSignal()} />` in `StageView.tsx`, positioned `absolute top-2 left-2` (outside the `<canvas>` bounds, inside the stage container).  
- SVG party-hat outline (crayon thick stroke), filled from bottom-up with crayon hatch pattern (reuse `--crayon-fill` from design system), `clip-path` driven by `percent`.  
- Text below hat: "Tempo: 12:34" (MM:SS), synced from `seconds_remaining`, updates every 5s when `turn_progress` arrives.  
- Show only when `room.auto_rodizio_enabled && room.publisher_id !== null`.  
**Verify:** Probe connects as viewer with auto-rodizio ON and active publisher; probe inspects `ActivityState` snapshot includes `{chapeu_visible: true, percent_elapsed: 50, seconds_remaining: 300}`; probe checks rendered DOM contains `.chapeu-timer` with `clip-path` attribute matching ~50%; probe waits for next `turn_progress`, asserts `seconds_remaining` decremented.

---

### 5. Companion tab: display time-remaining banner for current publisher  
**Concern:** Publisher needs awareness without nagging; must not obstruct the browser tab selector or capture controls.  
**Steps:**  
- In `companion.html`, wire `turn_progress` messages into a signal.  
- Render fixed banner `position: fixed; top: 0; left: 0; right: 0; background: var(--crayon-yellow);` with text "⏱️ Seu tempo: 12:34 restantes" (updates every 5s).  
- Show only when `role === "publisher" && auto_rodizio_enabled`.  
- When `seconds_remaining < 60`, change background to `--crayon-red` and text to "⏱️ Último minuto!".  
**Verify:** Probe opens companion tab as publisher with `turn_minutes: 2`; probe asserts banner exists with text matching regex `Seu tempo: [0-9]{1,2}:[0-9]{2}`; probe waits until `turn_progress.seconds_remaining < 60`, asserts banner background changes to red and text includes "Último minuto".

---

### 6. Activity UI: lobby admin controls for auto-rodizio toggle + duration  
**Concern:** Must appear only when queue mode is `rodizio` (not `livre`), and only for room admin; needs clear label in pt-BR.  
**Steps:**  
- In `LobbyView.tsx`, below existing queue-mode radio buttons, conditionally render (if `queueMode === "rodizio"`) a new section:  
  - Checkbox: "⏱️ Rodízio automático" bound to `autoRodizioEnabled` signal.  
  - Dropdown (if checkbox ON): "Duração de cada turno" → 5 / 10 / **15** / 20 / 30 minutos, bound to `turnMinutes` signal.  
- On change, send `{type: "config_update", auto_rodizio: <bool>, turn_minutes: <int>}` to relay (admin-only, existing auth check).  
- Relay validates sender is admin, updates room config, broadcasts new `RoomState` to all.  
**Verify:** Probe joins as admin, sends `{type: "config_update", queue_mode: "rodizio"}`; probe asserts `LobbyControls` snapshot includes `auto_rodizio_toggle_visible: true`; probe toggles `auto_rodizio: true, turn_minutes: 20`; assert all clients receive `room_state` with `{auto_rodizio_enabled: true, turn_duration_sec: 1200}`.

---

### 7. Activity UI: toast + stage transition on turn expiry  
**Concern:** The forced handoff must feel ceremonial, not punitive—use existing `Corrente da Tela` countdown aesthetic.  
**Steps:**  
- On `{type: "turn_expired", next_user: {username, avatar}}` message, trigger toast (reuse toast system): "⏱️ Acabou o tempo! Próxima pessoa: **@Username**" (3s duration, crayon-yellow background).  
- Simultaneously show fullscreen transition overlay (like `Corrente` countdown) for 2 seconds: big crayon "PRÓXIMO!" text + next user's name, then fade to new stream.  
- Reuse existing `stage_warmup` → `stream_start` handoff path (already live in `Fila do Proximo`).  
**Verify:** Probe sets `turn_minutes: 0.05`, starts stream as user A with user B queued; probe waits for `turn_expired` message; assert all viewer clients receive toast with text matching "Acabou o tempo.*@UserB" within 500ms; assert transition overlay renders for ~2s; assert user B's `stream_start` broadcast arrives and canvas switches to new stream.

---

### 8. Relay: reset timer correctly on manual stop or queue re-order  
**Concern:** If publisher manually stops before time expires, or admin changes queue order, we must clear the deadline to avoid phantom expirations.  
**Steps:**  
- On `StreamStop` (manual or forced), set `room.CurrentTurnDeadline = time.Time{}` (zero value).  
- On `QueueReorder` or `QueueRemove` affecting current publisher, also clear deadline.  
- `turnTimerWorker` ignores zero deadlines (skips expiry check).  
**Verify:** Probe starts stream with `turn_minutes: 10`, then publisher sends `stream_stop` after 2 seconds; probe waits 12 seconds total; assert NO `turn_expired` message is broadcast (timer was cleared). Probe starts new stream from same user, waits 11 seconds, asserts `turn_expired` fires correctly (new timer set).

---

### 9. Acceptance testing: full scenario with three users + duration edge cases  
**Concern:** End-to-end behavior with real queue rotation, rapid successive turns, and zero-config defaults.  
**Steps:**  
- Probe scenario: 3 users (A, B, C) join, admin enables `rodizio` + `auto_rodizio: true, turn_minutes: 0.1` (6 seconds).  
- User A takes stage → after ~6s, assert `turn_expired` → user B receives `stage_warmup` → B's stream starts → after ~6s, assert `turn_expired` → C gets stage → after ~6s, A gets stage again (queue loops).  
- Probe records all `turn_progress`, `turn_expired`, `stage_warmup`, `stream_start` messages and asserts correct sequence and timing (±1s tolerance).  
- Probe also tests: admin disables `auto_rodizio` mid-session → assert `turn_progress` stops broadcasting, timer worker skips the room.  
**Verify:** Probe runs scripted scenario, asserts message log matches expected sequence (A→B→C→A transitions), each turn ~6s ±1s; asserts `turn_progress.percent_elapsed` increments from 0→100 for each turn; asserts no `turn_expired` after `auto_rodizio` disabled.

---

## Acceptance criteria

1. **Lobby config:** Admin can enable "Rodízio automático" toggle (only visible when `queue_mode == "rodizio"`), choose duration (5/10/15/20/30 min), and setting persists + broadcasts to all clients in `room_state`.  
   *(Probe: send config_update as admin, assert room_state fields; non-admin attempt is rejected.)*

2. **Chapéu visual (Activity):** Viewers see party-hat widget in top-left of stage (outside video canvas), fills bottom-up as `percent_elapsed` increases, displays MM:SS remaining, updates every ~5s.  
   *(Probe: inspect DOM for `.chapeu-timer`, assert `clip-path` and text content match `turn_progress` messages.)*

3. **Publisher awareness (companion tab):** Current publisher sees "Seu tempo: MM:SS restantes" banner at top of companion tab, turns red when <60s remain.  
   *(Probe: connect as publisher, assert banner text/color transitions as `seconds_remaining` decreases.)*

4. **Automatic handoff:** When timer expires, relay sends `force_stop` to current publisher, `stage_warmup` to next-in-line, then standard `stream_start`; room sees toast "Acabou o tempo! Próxima pessoa: @User" + 2s transition overlay.  
   *(Probe: configure short turn, assert message sequence and timing; verify canvas switches to new stream.)*

5. **Queue rotation:** After last person in queue finishes their turn, first person gets stage again (continuous loop in `rodizio` mode).  
   *(Probe: 3-user round-robin scenario, assert A→B→C→A rotation over 4 turns.)*

6. **Manual stop clears timer:** If publisher stops before expiry, timer is cleared and does NOT fire later; next publisher gets a fresh timer.  
   *(Probe: manual stop after 2s of 10min turn, wait 11s, assert no `turn_expired`; start new stream, assert new timer fires correctly.)*

7. **Disable mid-session:** Admin can toggle `auto_rodizio` OFF during active session; `turn_progress` stops broadcasting, no forced handoffs occur.  
   *(Probe: disable after 50% elapsed, assert no further `turn_progress` or `turn_expired` messages.)*

8. **Localization:** All UI strings are pt-BR ("Rodízio automático," "Acabou o tempo!"), consistent with existing feature language.  
   *(Manual review + probe snapshot of rendered text nodes.)*

---

## Risks

- **Social acceptance:** Groups may feel the auto-cutoff is too rigid for casual hangouts.  
  *Mitigation:* Make it opt-in (default OFF), with clear admin control and generous default duration (15 min). The hat visual softens the enforcement ("it's the hat's fault, not mine").

- **Timing accuracy under relay load:** `turnTimerWorker` ticking every 2s could drift under CPU contention on shared VPS or residential Windows PC.  
  *Mitigation:* Use `time.After(deadline - now)` per-room rather than global 2s tick; acceptable drift is ±2s (won't break social contract for 10+ min turns). Probe verifies ±1s tolerance.

- **Chapéu visual clutter:** Adding a persistent widget risks violating "silent in the middle" if it draws too much attention during key moments.  
  *Mitigation:* Top-left corner (dead zone in most content), small size (~64px hat), crayon aesthetic keeps it playful not clinical. Can be refined in polish pass if needed; core mechanic doesn't depend on the visual perfection.

- **Companion tab visibility:** Publisher might miss the time banner if tab is backgrounded or they're alt-tabbed to the game.  
  *Mitigation:* Primary awareness is the room-side chapéu (everyone sees it, peer pressure helps); companion banner is secondary. Consider browser Notification API in future (out of scope now, needs permission flow).

- **Queue state races:** If admin reorders queue or someone leaves exactly when timer expires, could have collision between manual state change and auto-handoff.  
  *Mitigation:* Relay processes all room events sequentially in same goroutine (existing architecture); `TurnExpired` is just another event in the queue. Verify step 8 explicitly tests stop-during-countdown.

---

## Effort

**M (Medium ~ 4-6 days)**

**Breakdown:**
- Relay timer logic + expiry enforcement: ~1.5 days (steps 1, 2, 8 — needs careful testing of goroutine lifecycle and edge cases)
- Relay broadcast of progress + config persistence: ~0.5 day (step 3 — straightforward state broadcast)
- Activity chapéu UI component + lobby controls: ~1.5 days (steps 4, 6 — new SVG component, signal wiring, conditional rendering)
- Companion tab banner: ~0.5 day (step 5 — simpler surface, reuses existing message plumbing)
- Toast + transition overlay: ~0.5 day (step 7 — reuses `Corrente da Tela` patterns, mostly config)
- Probe scenarios + end-to-end acceptance: ~1 day (step 9 + criteria validation — wire-level timing assertions are fiddly)
- **Buffer:** ~0.5 day for localization review, design-system color tweaks, and real-world playtest with 3-person Brazilian group

**Why not S:** Nine implementation steps with timing-sensitive state machine changes, new UI surface in two contexts (Activity + companion), and need for robust probe scenarios covering concurrency/edge cases.  
**Why not L:** Reuses three existing subsystems (`Corrente da Tela` countdown/handoff, `Fila do Proximo` warmup unicast, lobby admin config model), no new protocols or infra, chapéu is a single self-contained component.

---

## Why this lane (PM #4 perspective)

Most PMs would propose engagement features (more reactions, gamification) or technical polish (performance, recording). **PM #4 sees the social infrastructure gap:** Brazilian friend-groups have *soft* turn-taking norms ("just a little longer...") that create awkwardness in long sessions, especially with the heightened emotion around JanjaCast being their *only* screen-share after the Go Live ban. 

The "chapéu" framing transforms enforcement into a shared joke—the hat becomes the bad guy, not the friend asking for their turn. This respects the Brazilian cultural context (high-context communication, face-saving) while solving a real coordination problem that will only intensify as sessions grow longer and groups get larger.

The feature is also **architecturally honest:** it surfaces state the relay already tracks (stream duration, queue order) and makes it legible to the room, rather than inventing new mechanics. Every step is wire-observable, making it a perfect fit for the probe-driven delivery model.
