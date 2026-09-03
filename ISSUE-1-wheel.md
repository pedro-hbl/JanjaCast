[opus -> claude-opus-5 via TrustBridge]
# Title
**Per-Room Timer Consolidation: One Coalescing Wheel per Room, Not N `AfterFunc` Goroutines**

# Pitch
Every feature family that shipped this year (stage-queue TTLs, reaction storm debounce, keyframe-on-demand debounce, claim expiry, countdown banners, rodízio slot expiry, jukebox cooldowns, clip buffer rolls) spawns its own `time.AfterFunc`, each waking an independent goroutine that then contends for `Room.mu`. On a sharer's residential PC running the relay while *also* gaming and encoding, this timer sprawl is invisible tax — dozens of ephemeral goroutines and heap-allocated timers per room, all waking to grab the same mutex — and consolidating them into one per-room coalescing timer wheel cuts scheduler churn and lock contention exactly when the host machine is most starved.

# Why now
Five rounds of TTL/debounce/countdown features have accreted `AfterFunc` calls with no audit; the relay now runs on the host's gaming PC (worst-case CPU contention) and this is pure hardening with zero user-visible change — the ideal "clean the hot path before v0.1 tag" work. No other PM will touch the timer subsystem because it's unglamorous plumbing, which is exactly why it's high-leverage and uncontested.

# Scope / Non-goals
**In scope:** Inventory every `time.AfterFunc`/`time.NewTimer`/`time.Ticker` behind `Room.mu`; introduce one per-room timer wheel; migrate expiry/debounce callbacks to enqueue onto it; ensure timers are cancelled on room teardown.
**Non-goals:** No feature behavior changes (same TTLs, same debounce windows, same countdown durations, ±tolerance). No change to the fan-out send path itself. No new dependencies (stdlib only). No changes to client. Not touching GC in the byte-buffer path (that's a different lane).

# Implementation plan

### Step 1 — Inventory & assert current timer count (measurement only)
**Concern:** Establish ground truth before touching anything.
Add a debug-gated counter `roomActiveTimers` (atomic int per `Room`) incremented on every timer arm, decremented on fire/cancel. Expose via a test-only hook `Room.debugTimerCount()`.
**Verify:** Probe scenario `timer_inventory`: boot server, one publisher, arm one stage-queue claim + one keyframe debounce, assert `debugTimerCount()` returns exactly the expected N (baseline documented in test). Fails loudly if a feature leaks an untracked timer.
**Effort:** S

### Step 2 — Introduce the per-room wheel struct (no callers yet)
**Concern:** Land the data structure in isolation.
Add `type roomTimerWheel struct` with a single goroutine driven by one `time.Ticker` at a fixed tick (start 50ms), holding a `map[timerID]scheduledCallback` with target-tick buckets. `wheel.Schedule(d, fn) timerID` and `wheel.Cancel(id)`. Wheel runs callbacks by re-entering under `Room.mu`.
**Verify:** Unit bench `BenchmarkWheelSchedule` — schedule+fire 1000 timers, assert callbacks fire within tick+tolerance (≤ 50ms + 20ms). No probe yet (no wire behavior). Assert zero goroutine growth via `runtime.NumGoroutine()` delta ≤ 1 across 1000 schedules.
**Effort:** M

### Step 3 — Migrate keyframe-on-demand debounce (highest-frequency timer)
**Concern:** Move the single hottest timer first, prove parity.
Replace the `AfterFunc` in the keyframe debounce path with `wheel.Schedule`. Debounce window unchanged.
**Verify:** Probe scenario `keyframe_debounce`: two viewers each fire keyframe request within debounce window; assert publisher receives exactly ONE `request_keyframe` message (coalesced), and a request outside the window produces a second. Assert `debugTimerCount()` shows keyframe path now contributes 0 raw `AfterFunc` (all via wheel).
**Effort:** S

### Step 4 — Migrate stage-queue claim TTL + rodízio slot expiry
**Concern:** Move the two "expiry" timers that mutate stage state.
Replace `AfterFunc` in claim-TTL (20s) and rodízio auto-pass with `wheel.Schedule`. Timing tolerance documented (±1 tick).
**Verify:** Probe scenario `claim_ttl_expiry`: viewer claims stage, does NOT confirm; assert all clients receive `stage_claim_expired` broadcast within 20s + 1 tick. Probe `rodizio_autopass`: slot holder idles past expiry; assert `stage_handoff` broadcast to next-in-line with correct `next_user` field.
**Effort:** M

### Step 5 — Migrate countdown banners (Corrente da Tela 7s) + jukebox cooldown
**Concern:** Move fixed-duration one-shots with veto interaction.
Migrate the 7s Corrente countdown and the jukebox/soundboard 3s cooldown gate. Veto must `Cancel` the scheduled auto-handoff.
**Verify:** Probe `corrente_veto`: publisher nominates, a viewer sends `veto`; assert NO `stage_handoff` fires after 7s and `debugTimerCount()` decrements (cancelled cleanly, no leak). Probe `corrente_expire`: no veto; assert `stage_handoff` fires at 7s + 1 tick.
**Effort:** M

### Step 6 — Migrate rolling-clip buffer roll + any remaining TTL fades
**Concern:** Sweep the long-tail (clip buffer roll, Deixa Comigo pointer fade, trophy TTL).
Migrate remaining `AfterFunc`/`Ticker` callers. After this, grep for `time.AfterFunc` under `room/` must return zero hits (enforced by a repo test).
**Verify:** Repo test `TestNoRawAfterFuncInRoom`: static scan of `room/*.go` asserts zero `time.AfterFunc`/`time.NewTimer` outside `roomTimerWheel`. Probe `clip_buffer_roll`: assert clip cut still returns last ~30s window after buffer has rolled.
**Effort:** M

### Step 7 — Teardown correctness: wheel dies with room
**Concern:** No orphaned wheel goroutine after room close.
On room teardown, stop the ticker and drain pending callbacks (fire-none, just release). Ensure hub-level room-map delete happens after wheel stop.
**Verify:** Probe `room_teardown_no_leak`: create + destroy 50 rooms sequentially; assert `runtime.NumGoroutine()` returns to baseline ±2 after final teardown. Assert no callback fires post-teardown (guarded by a closed-room flag).
**Effort:** S

### Step 8 — Contention & allocation bench (the payoff)
**Concern:** Prove the optimization actually reduced churn.
Add `BenchmarkRoomTimerChurn`: simulate one room with all TTL/debounce features active for 60s of scaled activity; compare pre/post via `-benchmem` and goroutine sampling.
**Verify:** Assert post-migration `allocs/op` for timer arming reduced ≥ 40% vs baseline, and peak goroutine count under load reduced by ≥ (N_features − 1) per active room. Document numbers in the issue.
**Effort:** S

# Acceptance criteria
- `grep -r "time.AfterFunc\|time.NewTimer" room/` → **0 hits** (enforced by `TestNoRawAfterFuncInRoom`).
- All migrated probe scenarios (keyframe_debounce, claim_ttl_expiry, rodizio_autopass, corrente_veto/expire, clip_buffer_roll) pass with timing within **duration + 1 tick (≤ 70ms)** tolerance.
- `room_teardown_no_leak`: goroutine count returns to baseline **±2** after 50 room create/destroy cycles.
- `BenchmarkRoomTimerChurn`: **≥ 40% fewer allocs/op** and **peak goroutines reduced by ≥ (N_features−1) per room**.
- **Zero user-visible behavior change**: every existing feature probe still green.

# Risks
- **Timing precision:** wheel tick granularity coarsens sub-tick timers. *Mitigation:* 50ms tick is far below any human-perceptible TTL (min is jukebox 3s); document ±1 tick tolerance; no timer under this codebase is finer than the debounce window.
- **Re-entrancy deadlock:** wheel callbacks re-enter `Room.mu`; if a caller schedules while holding `mu`, ordering matters. *Mitigation:* `Schedule`/`Cancel` must be lock-free on the wheel side (own mutex), never grabbing `Room.mu`; callbacks acquire `Room.mu` themselves.
- **Cancel races:** a timer firing concurrent with its cancel. *Mitigation:* generation-counter on `timerID`; stale fires are dropped (covered by `corrente_veto` probe).
- **Regression surface:** touches many feature paths. *Mitigation:* migrate one family per step, each with its own green probe before the next.

# Effort
**M overall** — mechanical migration once the wheel (Step 2, the only real M-of-Ms) lands; risk is breadth not depth, contained by per-step probes.
