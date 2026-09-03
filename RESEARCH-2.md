[opus -> claude-opus-5 via TrustBridge]
# JanjaCast Client: Scheduling / Lifecycle / Memory Optimizations (Researcher #2)

Ranked by leverage on *this* architecture. I'm deliberately staying off the raw decode/GPU-copy path (that's #1's lane) and focusing on scheduling, tab lifecycle, reconnect, and memory — where a mid-range PC running game+Discord+Activity on one GPU actually falls over.

---

## 1. Move the entire decode+render pipeline off the main thread into a Worker + OffscreenCanvas — driven by `requestVideoFrameCallback`, not rAF

**Effort: L · Risk: M**

### What it is
Relocate `VideoDecoder`, the canvas `drawImage`, the drop-to-live queue, and zoom/pan source-rect math into a dedicated worker. Transfer the canvas via `canvas.transferControlToOffscreen()`. Keep SolidJS reactivity on the main thread; the worker only receives control messages (zoom rect, gain, queue cap) and emits stats.

### Why it wins *here specifically*
- Your `VideoDecoder` output callback + `drawImage` at 60fps currently competes with SolidJS reactivity, WS message parsing (24 control families), and Discord's own iframe work — all on one main thread. A 4K decode callback firing every ~16.6ms leaves almost no slack; you *will* see input lag on zoom/pan and dropped WS ticks.
- Once in a worker, the main thread's only per-frame cost is nothing — the compositor pulls the OffscreenCanvas directly. This is the single biggest main-thread-contention win available.
- **rVFC over rAF is the real unlock**: `requestVideoFrameCallback` is *frame-cadence accurate* and, critically, gives you `metadata.expectedDisplayTime` + `mediaTime` so you can align decode-to-display and measure true glass-to-glass latency. rAF ties you to compositor cadence (and gets throttled hard when backgrounded — see #2).

### Implementation sketch
- `render.worker.ts`: owns `OffscreenCanvas` 2D (or WebGL — coordinate with #1) context, the `VideoDecoder`, and the ring buffer with cap 6.
- Main thread: `const off = canvas.transferControlToOffscreen(); worker.postMessage({canvas: off, ...}, [off])`.
- Drive display via a rVFC-style loop *inside the worker*. Note: rVFC is on `HTMLVideoElement`, not available in worker. So in-worker you drive on decoder output cadence + a `requestAnimationFrame` in worker context (workers get rAF via OffscreenCanvas), OR keep a tiny hidden `<video>`-less scheduler. **Concrete pattern**: decode callback pushes frames; a worker-rAF drains to canvas honoring `frame.timestamp`. Reserve true rVFC for the latency probe on main thread if you keep any video element.
- Control messages: zoom/pan source rect, gain, queue cap → structured-clone postMessage (tiny, no transfer needed).
- Transfer `VideoFrame` objects are **not** needed — decode happens in-worker so frames never cross threads (avoids the close()/ownership hazard).

### Verify
- `performance.measureUserAgentSpecificMemory()` + Long Animation Frames API (`PerformanceObserver` on `'long-animation-frame'`): main-thread LoAF count should drop toward ~0 during steady playback.
- DevTools Performance: main thread should show idle gaps every frame; worker thread carries decode+paint.
- Probe: `VideoFrame.timestamp` at decode vs. paint wall-clock → decode-to-display delta; target < 1 frame of added queue latency.

### Risk
- OffscreenCanvas + WebGL context loss handling is different (no DOM `webglcontextlost` on main). Must handle in worker.
- Zoom/pan responsiveness now has a postMessage hop (~sub-ms, fine) but debug is harder.
- Coordinate context type (2D vs WebGL/WebGPU) with #1 — this migration is the shared substrate for both our recommendations.

---

## 2. Background-tab lifecycle state machine: freeze render, keep audio + WS alive, resync on foreground

**Effort: M · Risk: L**

### What it is
Explicit handling of `document.visibilityState` + `frozen`/`resume` (Page Lifecycle API) that (a) stops the video decode/paint loop when hidden, (b) keeps audio flowing, (c) hard-flushes the drop-to-live queue on return, and (d) tells the companion/server the client is background so ABR/keyframe cadence can react.

### Why it wins *here specifically*
- When the Activity tab is backgrounded, Chrome throttles rAF to ~1fps and clamps timers to ≥1s. Your current drop-to-live queue (cap 6) will **balloon and stall**: decoder keeps receiving WS chunks but paint is throttled → queue overflows → on return you either show a stale frame burst or a decode backlog spike that hitches the GPU right when the user is looking again.
- A worker rAF (from #1) is *also* throttled when the owning tab is hidden — so you can't rely on the worker to keep cadence. You need explicit "hidden → decode-only-keyframes or full-pause" policy.
- Discord Activities get backgrounded constantly (user clicks another channel). This is a *frequent* real path, not an edge case.

### Implementation sketch
- Main thread listens `visibilitychange`, `freeze`, `resume`, `pagehide`.
- On `hidden`: postMessage worker `{cmd:'suspend'}` → worker stops draining/paint, optionally keeps decoding *only keyframes* (decoder.flush is expensive; prefer: stop feeding all but keyframes). Keep `AudioDecoder`+WebAudio running (audio isn't throttled and keeps the session "alive" and in-sync-able).
- Signal WS: send `{background:true}` so server/companion can drop to audio-priority or lower keyframe interval expectation.
- On `visible`/`resume`: **flush queue to newest keyframe** (you already have drop-to-live semantics — invoke aggressively), request an IDR from companion via WS if last keyframe is stale, resume paint.
- On `freeze`: treat as suspend + tear down decoder if memory pressure (see #4); on `resume`, reinit.

### Verify
- Throttle test: DevTools → background the tab 30s → foreground. Measure time-to-first-fresh-frame (target < 300ms) and confirm no multi-frame catch-up burst (log queue depth on resume; should be ≤1 after flush).
- Confirm audio has no gap (WebAudio `currentTime` continuity).
- `chrome://discards` / Performance panel to confirm timer throttling is being handled, not fought.

### Risk
- Requesting IDR on resume adds companion-side coupling (needs a WS control family — you have 24, add one).
- Audio-keeps-alive can drift from video on long background; the resync-to-keyframe step must re-anchor A/V clock.

---

## 3. WS reconnect + backpressure hardening with jittered backoff and control-family coalescing

**Effort: M · Risk: L**

### What it is
A robust single-WS reconnect layer: exponential backoff with jitter, heartbeat/liveness, sequence-numbered resync, and **coalescing/prioritization across the 24 control families** so a reconnect storm or a chatty family can't starve media chunks.

### Why it wins *here specifically*
- Everything is same-origin via Discord proxy under strict CSP — you have exactly **one** WS carrying both media chunks and 24 control families. No WebTransport available (Discord CSP + proxy). So this WS *is* your transport and its health is the whole session.
- On background→foreground or network blip, naive reconnect = thundering reconnect + full re-subscribe of 24 families + decoder waiting on a fresh keyframe. Without prioritization, control chatter can delay the first post-reconnect keyframe.
- Coalescing matters: zoom/pan drags emit high-frequency control messages; without rAF-batching these on the main thread you flood the WS and compete with media.

### Implementation sketch
- Reconnect: `retry = min(cap, base * 2^n) + rand(0, jitter)`; reset on stable connection (>N seconds). Track `readyState`; never open a second socket while one is CONNECTING.
- Liveness: app-level ping every ~5s; if 2 missed, force-close→reconnect (don't trust TCP).
- Sequence numbers per control family; on reconnect send `lastSeq` map so server replays only deltas.
- **Outbound coalescing**: zoom/pan control messages batched on main-thread rAF (or a 16ms timer) — send only the latest rect per frame, not every pointermove.
- **Inbound priority**: parse media chunk frames first; defer non-critical control-family application to `scheduler.postTask({priority:'background'})` so control parsing yields to decode feed.
- Consider `scheduler.yield()` inside the WS onmessage handler if you batch-process multiple queued messages, to avoid long tasks.

### Verify
- Chaos test: kill WS mid-stream repeatedly; measure reconnect success rate and time-to-first-keyframe after reconnect (target < 500ms on LAN).
- Long Animation Frame observer: WS onmessage should not appear as a long task; pointermove-driven zoom should emit ≤1 WS msg/frame (log outbound rate during a drag).
- Verify no duplicate sockets under rapid background/foreground (assert single instance).

### Risk
- Sequence-resync requires server cooperation (companion/server side). Client-only backoff+coalescing is deliverable independently and still high value.
- Over-aggressive coalescing can make zoom feel laggy — tune to per-frame, not per-100ms.

---

## 4. Bounded VideoFrame lifetime + explicit memory pressure teardown

**Effort: S/M · Risk: M**

### What it is
Guarantee every `VideoFrame` (and `AudioData`, `ImageBitmap`) is `.close()`d deterministically, cap the in-flight frame set, and add a memory-pressure path that tears down and reinits the decoder when backgrounded/frozen or when `measureUserAgentSpecificMemory` / `performance.memory` signals trouble.

### Why it wins *here specifically*
- `VideoFrame` holds GPU/media memory that GC does **not** reclaim promptly — a single leaked 4K frame is multi-MB of GPU-backed memory. On a machine already sharing one GPU with the game + Discord, leaked frames cause GPU memory pressure → the *game* stutters, not just the Activity. This is the failure mode users blame most and diagnose least.
- Your drop-to-live cap 6 controls queue depth but doesn't itself guarantee `close()` on dropped frames — if a dropped frame isn't closed, the cap is meaningless for memory.
- Backgrounded tabs that keep decoders alive (or keep a full queue frozen) are pure GPU-memory waste while the user is looking at something else.

### Implementation sketch
- Wrap the queue so eviction path *always* calls `.close()` on the evicted `VideoFrame`; add a dev assertion counting `constructed - closed` should stay bounded (≤ cap + in-flight).
- On paint, `close()` the frame immediately after `drawImage`/`transferToImageBitmap` (don't hold references for zoom — zoom is source-rect on the *next* frame, not re-reading an old one).
- Memory pressure hook: on `freeze` (Page Lifecycle) or after N seconds hidden → `decoder.close()`, drop queue (closing all), free `ImageBitmap`s. On `resume` → `configure()` freshdecoder and request IDR (ties into #2's resync path).
- Optional periodic probe: `performance.measureUserAgentSpecificMemory()` (cross-origin-isolated required — check if Discord proxy grants COOP/COEP; if not, fall back to `performance.memory` heuristics in Chromium) → if breakpoint exceeded, drop queue cap 6→3 temporarily and log a telemetry event.
- ImageBitmap discipline: if any path uses `createImageBitmap` (e.g., clip-mux thumbnails), `.close()` those too — they're GPU-backed.

### Verify
- Leak probe: run 30 min steady playback, watch `chrome://memory-internals` / Task Manager GPU memory column — should be flat, not sawtooth-climbing.
- Assertion counter (`framesConstructed - framesClosed`) stays ≤ (cap + decoder-internal); log if it exceeds.
- Background 5 min → confirm decoder torn down (GPU memory drops) → foreground → confirm clean reinit with no frame burst.
- Force `about:crash`-adjacent: open the game + Discord + Activity, background/foreground the Activity 20×, confirm no monotonic GPU-mem growth.

### Risk
- `.close()`-after-`drawImage` timing: with the worker+OffscreenCanvas 2D path, `drawImage` is synchronous so close-after is safe. With a WebGL/WebGPU upload path (coordinate with #1), you must close *after* the texture upload completes, not after the JS call returns if using async upload — get this wrong and you draw a freed frame (garbage/black). This is the sharpest edge in this list.
- Decoder teardown/reinit on every background cycle adds ~tens-of-ms reinit cost; only do it past a hidden-duration threshold (e.g., >10s), not on every quick channel-switch.

---

## 5. `scheduler.postTask` / `scheduler.yield` prioritization for the 24 control families + SolidJS work

**Effort: S · Risk: L**

### What it is
Replace implicit microtask/`setTimeout` scheduling with the Prioritized Task Scheduling API. Media-critical work (WS chunk → decoder feed) runs `user-blocking`; control-family application and SolidJS non-visual reactivity run `user-visible`/`background`; teardown/telemetry runs `background`. Use `scheduler.yield()` to break up any long WS-batch parsing.

### Why it wins *here specifically*
- Even after moving decode to a worker (#1), the **main thread still parses the WS**, applies 24 control families, and runs SolidJS. A burst of control messages (e.g., a settings sync, or reconnect replay from #3) can produce a long task that blocks the frame that feeds the decoder or updates the OffscreenCanvas control state.
- Chrome 140-era: `scheduler.yield()` is available and *returns to the same task queue at higher priority than a fresh postTask* — meaning you can chunk a big control-replay loop and still stay ahead of background work. This is strictly better than `await new Promise(setTimeout)` yielding, which drops you to the back.
- SolidJS is fine-grained but a large reconcile (e.g., re-rendering the control panel for all 24 families on reconnect) is still a task you want at `user-visible`, not blocking `user-blocking` media feed.

### Implementation sketch
- WS onmessage: classify message → media chunk path calls `scheduler.postTask(feedDecoder, {priority:'user-blocking'})`; control families → `{priority:'user-visible'}`; telemetry/logging → `{priority:'background'}`.
- Reconnect replay loop: `for (const msg of backlog) { apply(msg); if (needsYield()) await scheduler.yield(); }` so a 200-message replay doesn't hitch.
- Use `TaskController` to abort stale control tasks on reconnect (cancel in-flight application of a now-superseded state).
- Coalesced zoom/pan (from #3) posts at `user-blocking` since it's directly interactive.

### Verify
- Long Animation Frames API: `PerformanceObserver({type:'long-animation-frame'})` — count of LoAF >50ms during a reconnect-replay should drop to ~0.
- `PerformanceObserver` on `'longtask'` for coarse baseline.
- INP-style probe on zoom/pan interaction during a control-storm: interaction-to-visual-update should stay < 100ms.

### Risk
- Very low. Feature-detect `scheduler` (fallback to microtask/postMessage) — but Chrome 140+ has it, and this is a Chrome-only Discord Activity, so fallback is defensive only.
- Over-classifying everything `user-blocking` defeats the purpose — be disciplined that *only* media-feed + direct interaction is top priority.

---

## Ranking rationale (why this order for THIS stack)

| # | Optimization | Effort | Risk | Primary lever |
|---|---|---|---|---|
| 1 | Decode+render → Worker/OffscreenCanvas, rVFC-aware | L | M | Eliminates main-thread frame contention entirely |
| 2 | Background lifecycle state machine | M | L | Kills the #1 real-world hitch source (backgrounding) + GPU waste |
| 3 | WS reconnect + coalescing + priority | M | L | The single transport's resilience = whole session |
| 4 | Bounded VideoFrame lifetime + pressure teardown | S/M | M | Prevents GPU-mem pressure that stutters the *game* |
| 5 | `scheduler.postTask`/`yield` prioritization | S | L | Cheap insurance so control storms don't block media |

**#1 is the substrate** — do it first because #2, #4, and #5 all get cleaner once decode lives in a worker (lifecycle suspend, frame-close discipline, and priority routing all have a clearer boundary). But if you want fast wins while #1 is in flight: **#5 (S) and #4's close-discipline (S) are shippable this week** with near-zero architectural change and directly address the "shared GPU stutters the game" complaint that hurts you most with your mid-range-Windows audience.

## Coordination notes with Researcher #1
- **Shared dependency**: the OffscreenCanvas migration (#1 here) is where #1's decode/GPU/context-type work lands too. Agree on **one** worker owning the canvas and the context type (2D vs WebGL vs WebGPU) before either of us builds — a split ownership here is the worst outcome.
- **`VideoFrame.close()` timing** (my #4) is *dependent* on #1's chosen upload path. If they go async texture upload (WebGL `texImage2D` from `VideoFrame`, or WebGPU `importExternalTexture`), the close-after-upload rule must be jointly specified — this is the one place our two research tracks can create a correctness bug if uncoordinated.
- **rVFC**: I'm using it for latency measurement + display cadence; if #1 wants it for `mediaTime`-based A/V sync, we share the same callback — don't register two.

## What I deliberately excluded (and why)
- **WebTransport / QUIC datagrams**: unavailable under Discord's CSP + same-origin proxy. Not a fit, don't pursue.
- **SharedArrayBuffer ring buffer for A/V**: requires cross-origin isolation (COOP/COEP) which the Discord proxy likely doesn't grant — verify, but assume no. Would otherwise be a great decode→audio-worklet transport.
- **Bundle splitting beyond current lazy clip-mux chunk**: at ~260KB single bundle you're already fine; further splitting adds request waterfalls under the proxy for marginal gain. The one lazy chunk (clip muxing) is the correct seam — leave it. Only revisit if adding a heavy feature (e.g., a WASM muxer > 100KB), in which case lazy-load it on first clip action, not at boot.
- **`content-visibility`**: relevant only if the Activity has significant off-screen DOM (control panels, overlays). If your control UI is heavy, `content-visibility: auto` on off-screen panels is a trivial S-effort win for style/layout cost — but it doesn't touch the media path, so it's below the cut line unless the panel DOM is large.
