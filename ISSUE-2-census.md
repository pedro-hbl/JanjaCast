[opus -> claude-opus-5 via TrustBridge]
# Title
**Bound the per-room timer & goroutine population: an `AfterFunc` census with a hard leak ceiling**

# Pitch
Every feature family that shipped (claim TTLs, stinger debounce, keyframe debounce, countdown banners, slot expiry, panic fade, warmup handoff) quietly spawns `time.AfterFunc` timers and goroutines under `Room.mu` — and on a residential box hosting the sharer's own game, a slow accumulation of un-stopped timers is exactly the kind of thing that turns a 3-hour Friday session into a stuttering mess nobody can debug. This lane makes the relay's background-work population **observable and bounded** so a Brazilian friend-group's all-night stream doesn't die from a thousand tiny leaks.

# Why now
- We are ~24 control-message families deep and the context pack literally flags "many AfterFuncs now." That's a code smell that has never been counted.
- Features like Rodízio Automático (slot expiry), Corrente da Tela (7s countdown), stage warmup, claim TTLs, and panic fade all create timers that can be **superseded** (a new claim before the old TTL fires, a veto before the countdown ends). Superseded-but-not-stopped timers are the classic Go leak.
- Sessions on this platform are *long* and *unattended* (host is gaming, not watching logs). Leaks that are invisible in a 5-minute probe run are the ones that kill a real session.
- Zero user-visible change if done right — this is pure hardening, which is exactly the mandate.

# Scope / Non-goals
**In scope:** a single registry for room-scoped timers/goroutines; converting existing ad-hoc `AfterFunc`/`go func()` sites to route through it; a metrics surface exposing live counts; leak assertions in the probe harness; a hard ceiling that logs+sheds rather than growing unbounded.
**Non-goals:** changing any feature's timing/behavior; touching the fan-out hot path allocation; new endpoints beyond one read-only metrics line; rewriting the mutex model. If a timer fires at the same wall-clock as before, we succeeded.

# Implementation plan

### Step 1 — Introduce a `roomTimers` registry type (one concern: ownership)
Add `roomTimers struct` to `Room` with `named map[string]*time.Timer` (for singleton/superseding timers keyed by name, e.g. `"claim:<seat>"`, `"corrente:countdown"`) and a `counter int64` for anonymous fire-and-forget timers. Methods: `SetNamed(key string, d time.Duration, fn func())` (stops+replaces any existing key), `ClearNamed(key)`, `After(d, fn)` (anonymous, self-decrementing).
**Verify (bench):** unit test `TestRoomTimers_SetNamedSuperseding` — call `SetNamed("k", 10s, A)` then `SetNamed("k", 10s, B)` within the same tick; assert A never runs, B runs once, `named` map len == 1 after fire.

### Step 2 — Wire a live gauge into the registry (one concern: countability)
Every `SetNamed`/`After` increments an atomic `Room.liveTimers`; every fire/clear decrements. Add `Hub.TotalLiveTimers()` summing across rooms under the existing hub mutex read path.
**Verify (bench):** `TestRoomTimers_GaugeBalances` — schedule 100 anonymous `After(1ms,...)`, wait for drain, assert `liveTimers == 0`; supersede a named timer 50× and assert gauge never exceeds 1 for that key.

### Step 3 — Migrate the claim/TTL family to `SetNamed` (one concern: seat claim leaks)
Convert stage-queue claim TTL (20s), Rodízio Automático slot expiry, and Fila do Próximo warmup timers to keyed `SetNamed("claim:<seat>")` / `"rodizio:<room>"` / `"warmup:<next>"`. A re-claim or manual pass must supersede, not stack.
**Verify (probe):** scenario `claim_supersede` — client A claims seat, client B claims same seat before TTL; assert only ONE `seat_expired`-family broadcast ever reaches other clients (the superseded one is silent), and `TotalLiveTimers` (via metrics, Step 6) returns to baseline after the surviving TTL.

### Step 4 — Migrate the countdown/handoff family (one concern: veto-cancels-timer)
Convert Corrente da Tela 7s countdown and its Vai!/Calma! veto to `SetNamed("corrente:<room>")` + `ClearNamed` on veto. Convert panic-fade TTL and keyframe-on-demand debounce similarly.
**Verify (probe):** scenario `corrente_veto` — publisher nominates successor, another client sends veto at t=3s; assert NO `handoff_commit` broadcast reaches any client, and gauge decrements by exactly 1 within 50ms of the veto (timer actually stopped, not just ignored on fire).

### Step 5 — Migrate remaining debounce/stinger sites, then grep-gate (one concern: no stragglers)
Convert stinger start/stop debounce and any leftover `time.AfterFunc`. Add a CI lint step: `grep -rn 'time.AfterFunc\|go func' --include=*.go relay/ | grep -v roomtimers_test` must return zero hits outside the registry file (allowlist comment `//timers:exempt` for the fan-out send goroutines, which are lifecycle-bound not timer-bound).
**Verify (bench):** CI job `no-raw-timers` fails the build on any un-migrated `AfterFunc`; passes on current tree after migration.

### Step 6 — Expose a read-only metrics line (one concern: observability, not new protocol)
Add `GET /debug/relay` returning plaintext `live_timers <n>\nlive_goroutines <runtime.NumGoroutine()>\nrooms <n>\ntimers_per_room_max <n>`. No auth change; localhost/tunnel only, no room data.
**Verify (probe):** scenario `metrics_smoke` — boot binary, create 1 room with 1 active claim, hit `/debug/relay`, assert `live_timers >= 1` and `rooms == 1`; tear down room, assert `live_timers` returns to `0` and `timers_per_room_max == 0` within 200ms.

### Step 7 — Enforce a per-room hard ceiling with shed-and-log (one concern: bounded worst case)
In `SetNamed`/`After`, if `Room.liveTimers > CEILING` (default 256, generous), refuse the new timer, run `fn` synchronously-degraded or drop per its class, and increment `Room.timersShed` counter surfaced in metrics.
**Verify (bench):** `TestRoomTimers_Ceiling` — schedule CEILING+50 timers, assert exactly 50 shed, `timersShed == 50`, no panic, and process goroutine count stays within `NumGoroutine()+CEILING+epsilon`.

### Step 8 — Soak assertion in the harness (one concern: no drift over a long session)
Add probe scenario `timer_soak` — run a 60s scripted session cycling claim→supersede→veto→panic→clear ×200, sampling `/debug/relay` every 5s. Assert `live_timers` never trends upward (last sample ≤ first sample + 5) and ends at baseline.
**Verify (probe):** `timer_soak` passes with final `live_timers` == pre-run baseline; a deliberately-reverted Step 3 (stacking claims) makes it FAIL — proving the assertion has teeth.

# Acceptance criteria
- Zero raw `time.AfterFunc`/timer-`go func` outside the registry (Step 5 CI gate green).
- `/debug/relay` reports `live_timers` that returns to baseline within 200ms of room teardown (Step 6).
- `timer_soak`: `live_timers` growth over 60s / 200 cycles ≤ 5, ends at baseline (Step 8).
- Superseded named timers never double-fire on the wire (Steps 3–4 probes).
- Per-room `live_timers` provably capped at CEILING; overflow shed and counted, no panic (Step 7).
- No change to any feature's observable timing (all existing probe scenarios still green — regression gate).

# Risks
- **Behavioral drift from migration:** a keyed timer that *should* stack (rare) gets collapsed. Mitigation: audit each site's supersede semantics in the PR description; existing per-feature probes catch timing changes.
- **Lock contention:** registry ops run under `Room.mu`; atomic gauge avoids extra locking, but `TotalLiveTimers` walks rooms under hub mutex — keep it read-only and infrequent (metrics scrape only).
- **Ceiling misfires:** 256 too low for a legit 25-viewer room with many features. Mitigation: instrument `timers_per_room_max` first (Step 6) on real sessions before trusting the shed path; default generous.
- **`/debug/relay` exposure:** ensure it leaks no room IDs/tokens — counts only.

# Effort
**M** — mostly mechanical migration (Steps 3–5) plus small registry + metrics + probe scenarios. No hot-path or protocol surgery. The soak scenario (Step 8) is the only genuinely new harness capability and is the highest-value single artifact here.
