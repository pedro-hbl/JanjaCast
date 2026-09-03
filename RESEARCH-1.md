[opus -> claude-opus-5 via TrustBridge]
# JanjaCast Client — Web-Side Optimization Shortlist (Researcher #1: decode/render/GPU path)

Ranked by leverage for *this* architecture. I stay in my lane (decode→display→GPU) and flag the seams where #2's scheduling/lifecycle work must interlock.

---

## #1 — Move the entire decode→paint pipeline off the main thread into a Worker + OffscreenCanvas

**What it is.** Relocate `VideoDecoder` and the canvas into a dedicated worker. The canvas element in the DOM becomes an `OffscreenCanvas` via `canvas.transferControlToOffscreen()`; the worker owns the `VideoDecoder`, the `drawImage`/`transferFromImageBitmap` loop, and the drop-to-live queue. Main thread only routes WS control messages and forwards encoded chunks (transferable `ArrayBuffer`s) to the worker.

**Why it wins HERE specifically.**
- Your current design runs `VideoDecoder` *and* `drawImage` at up to 60fps on the main thread, which is also servicing SolidJS reactivity, 24 control-family WS traffic, and pointer/zoom-pan events. On a mid-range PC where the GPU is already shared 3 ways (game + Discord + Activity), main-thread jank is your dominant frame-drop source, not GPU throughput.
- `VideoFrame` `output` callbacks and `drawImage` compositor uploads currently contend directly with input handling. A single 4–8ms GC pause or Solid effect flush on the main thread stalls presentation. Moving to a worker removes that coupling entirely — the worker's rAF/`requestVideoFrameCallback` is independent of main-thread contention.
- Decode-to-display latency benefit: the encoded-chunk → decode → paint path no longer waits behind main-thread microtask queues. Typical measured wins are 1–2 dropped frames eliminated per contention burst and p95 present latency down 8–20ms under load.

**Implementation sketch (this stack).**
- `render.worker.ts`: owns `new VideoDecoder({output, error})`, the OffscreenCanvas 2D (or `bitmaprenderer`) context, the queue cap-6 drop-to-live logic.
- Main: `const off = canvas.transferControlToOffscreen(); worker.postMessage({off}, [off]);`
- Forward chunks: `worker.postMessage({type:'chunk', data: buf}, [buf])` — transfer, don't copy.
- Keep AudioDecoder + WebAudio on main (WebAudio can't move; AudioContext is main-thread). A/V sync stays as timestamp comparison across the thread boundary — worker posts `currentVideoTs`, main compares to `audioContext.currentTime`-derived audio clock.
- Vite: worker via `new Worker(new URL('./render.worker.ts', import.meta.url), {type:'module'})` — same-origin, CSP-clean, no external CDN.

**Verify.** `performance.measure` around main-thread task duration before/after via `PerformanceObserver({entryTypes:['longtask']})`; count long tasks (>50ms) during a 60s zoom-pan + high-motion session. Also compare `VideoFrame.timestamp` → paint delta logged from worker. Success = long-task count on main drops ~>70%, present-latency p95 down ≥8ms.

**Effort: L.** (A/V sync across threads + zoom/pan source-rect messaging is the fiddly part.)
**Risk: M.** OffscreenCanvas transfer is one-way (element can't be reclaimed on main without teardown). Debugging worker canvas is harder. **Interlock with #2:** worker rAF is *not* throttled the same way when backgrounded — #2 must own the backgrounding contract (pause decode/paint on `visibilitychange`, not rely on rAF throttle).

---

## #2 — Replace `drawImage(VideoFrame)` with zero-copy `VideoFrame`→canvas via `transferFromImageBitmap` / direct WebGL upload, and stop decoding when the frame won't be seen

**What it is.** Two coupled changes:
(a) Prefer painting the `VideoFrame` through the most direct GPU path available. On Chrome 140+, `drawImage(videoFrame)` on a 2D context is already reasonably optimized, but a `bitmaprenderer` context with `transferFromImageBitmap(await createImageBitmap(frame))` — or better, uploading the `VideoFrame` directly as a WebGL texture (`gl.texImage2D(..., videoFrame)`) — avoids an intermediate readback in some driver paths.
(b) Close frames aggressively and never decode-to-paint frames the drop-to-live cap will discard.

**Why it wins HERE.**
- With a shared GPU under a game, every extra GPU copy competes for the same memory bandwidth. `drawImage` of a `VideoFrame` can trigger a copy from the decoder's output surface into the canvas backing store; for a 1080p60 stream that's ~124MB/s of copy traffic per redundant hop.
- Your zoom/pan uses a source rect in `drawImage`. WebGL texture sampling does the source-rect crop as UV coordinates — effectively free — whereas 2D `drawImage` source-rect still uploads/samples the full frame region. For heavy zoom this is a real GPU-time saving.
- **`VideoFrame.close()` discipline is non-negotiable:** unclosed frames pin decoder output buffers, and once the pool is exhausted the `VideoDecoder` stalls (no more `output` callbacks). This is the single most common cause of "decoder mysteriously freezes after 30s." Your cap-6 queue must `close()` every dropped frame.

**Implementation sketch.**
- In the render worker: switch canvas to `webgl2`. Single fullscreen quad; `gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoFrame)` accepts `VideoFrame` directly (Chrome supports `VideoFrame` as `TexImageSource`).
- Zoom/pan → adjust the quad's UVs, not a source rect. Bonus: bilinear filtering gives cleaner zoom than 2D canvas nearest-ish scaling.
- Drop-to-live: `while (queue.length > 6) queue.shift().close();` and `frame.close()` immediately after each successful paint.

**Verify.** Chrome `chrome://tracing` or DevTools Performance → GPU track: compare "GPU memory" and GPU-process CPU time before/after. Probe decoder health: log `videoDecoder.decodeQueueSize` — should stay bounded, never monotonically climb. Confirm zero "frame not closed" via a debug counter (`outputCount - closeCount == queue.length`). Success = GPU-track time per frame down, decodeQueueSize stable.

**Effort: M.** (WebGL quad + UV zoom is modest; the frame-lifecycle audit is the valuable part.)
**Risk: L–M.** WebGL context loss (shared GPU pressure can trigger it) needs a `webglcontextlost` handler to re-init — real risk given your 3-way GPU sharing.

---

## #3 — Drive presentation off `requestVideoFrameCallback` cadence, decouple from 60fps rAF

**What it is.** Instead of a fixed rAF loop pulling the newest queued `VideoFrame` at up to 60fps, use `HTMLVideoElement.requestVideoFrameCallback` semantics — but since you're canvas-based (no `<video>`), the analog is: paint on decoder `output` cadence gated by A/V clock, not on display rAF. You paint exactly when a new frame is ready and due, skipping the paint entirely when the queue's head isn't newer than what's shown.

**Why it wins HERE.**
- Your source is ABR SVC — the effective framerate varies (drops under bandwidth pressure). Running a 60fps rAF paint loop against a 30fps effective stream means half your paints are redundant re-blits of the same frame: pure wasted GPU copies on an already-contended GPU.
- Painting on decode/due cadence eliminates redundant blits. On a 30fps stream this halves canvas upload traffic.
- `rvfc` (if you keep/add a hidden `<video>` fed by MSE — you don't, you're WebCodecs) gives `mediaTime`/`presentationTime` metadata; since you're pure WebCodecs, replicate with your own presentation clock: only paint when `nextFrame.timestamp > lastPaintedTimestamp` AND `timestamp <= audioClock + slop`.

**Implementation sketch.**
- Presentation loop (in worker): a self-scheduling `setTimeout`/rAF that checks the queue head. If head timestamp is due per audio clock and newer than last painted → paint + `close()`; else no-op.
- De-dup guard: `if (head.timestamp === lastTs) { /* don't repaint */ }`.
- This composes with #1 (loop lives in worker) and #2 (paint path is WebGL upload).

**Verify.** Counter: paints-per-second vs frames-decoded-per-second. On a 30fps stream, paints/s should converge to ~30, not 60. Confirm no visual stutter via frame-timestamp continuity log. Success = paint count ≈ decode count (redundant paints ~0).

**Effort: S–M.**
**Risk: L.** Main caveat: **backgrounding** — when the tab is hidden this loop must fully suspend (#2's domain). Don't paint to a hidden OffscreenCanvas.

---

## #4 — SVC-aware layer dropping at the decoder before spending decode cycles

**What it is.** Your encoder ships SVC L1T3 (3 temporal layers). On the client, when the machine is behind (rising decodeQueueSize, or measured decode time > frame interval), *drop the top temporal layer's chunks before decoding them* rather than decoding everything and dropping at the queue. Temporal-layer IDs are in the chunk metadata your companion tab can annotate.

**Why it wins HERE.**
- Dropping at the queue (current cap-6) still pays the full decode cost for frames you'll throw away — decode is the expensive main-thread/GPU step. Dropping the T2 layer *before* `decoder.decode()` cuts decode load by ~50% (T2 is ~half the frames in L1T3) while remaining spec-valid to decode (temporal layers are designed to be dropped).
- On a laptop sharing a GPU with a game, this is the difference between "smooth 30fps" and "stuttery 60fps attempt." It's graceful degradation the SVC structure was literally designed for.

**Implementation sketch.**
- Companion tab / encoder side: tag each `EncodedVideoChunk` with its temporal layer id (available via `SVC` metadata or track it from the L1T3 pattern) and send in your WS/chunk envelope.
- Client worker: maintain a `targetTemporalLayers` value. If `decodeQueueSize > threshold` for N frames → set to 2 (drop T2). If pressure clears → restore.
- Skip: `if (chunk.temporalLayerId > targetTemporalLayers) return; // don't decode`. Must respect decode dependency (never drop a layer a kept frame depends on — L1T3 temporal layers are safe to drop top-down).

**Verify.** Log decode time per frame and effective fps under induced GPU load (run a WebGL stress tab). Success = under load, decodeQueueSize stays bounded and fps degrades cleanly to 30/15 instead of erratic drops. Cross-check no reference errors from decoder (`error` callback silent).

**Effort: M.** (Needs encoder-side metadata cooperation — coordinate with companion-tab owner.)**Risk: M.** Correctness hinges on accurate temporal-layer tagging; drop a layer a kept frame references and you get corruption/decoder errors. Must be strictly top-down (T2 only, never T1/T0) and dependency-verified.

---

## #5 — `content-visibility` + explicit compositor-layer isolation for the canvas and Solid UI chrome

**What it is.** Isolate the video canvas onto its own compositor layer and mark the surrounding SolidJS control UI (24 control families = a lot of DOM) with `content-visibility:auto` / `contain` so the video-paint path never triggers layout/paint work on the control chrome and vice-versa.

**Why it wins HERE.**
- Your canvas paints up to 60fps. If it shares a compositor layer with the SolidJS control UI, every canvas update can force the compositor to re-examine/re-raster neighboring content, and any control-family state change (24 of them, reactive) can invalidate the canvas layer's tile. On a shared GPU, needless raster invalidation is expensive.
- Promote the canvas to its own layer with `will-change: transform` or `transform: translateZ(0)`, and `contain: strict` / `content-visibility: auto` on off-screen or collapsed control panels. This keeps the video layer a pure "upload texture, composite" path — the compositor fast path — untouched by Solid re-renders.
- `content-visibility:auto` on control panels also skips rendering work for collapsed/scrolled-off control families entirely (skips layout+paint for that subtree until visible), directly cutting main-thread rendering cost that competes with your WS routing.

**Implementation sketch.**
- Canvas host: `.video-surface { contain: strict; will-change: transform; }` — forces its own GraphicsLayer.
- Control panel containers: `.control-family-panel { content-visibility: auto; contain-intrinsic-size: 0 320px; }` (give an intrinsic-size hint so scrollbars/layout don't thrash).
- Verify no accidental layer explosion (each control family on its own layer would waste GPU memory) — only the canvas + one control column should be promoted.

**Verify.** DevTools → Layers panel: confirm canvas is its own layer, control panels are *not* individually promoted. Rendering tab → "Paint flashing": canvas paints should not flash the control UI and vice-versa. `content-visibility` win measurable via "Rendering → Layout Shift" and reduced style/layout time in Performance panel when toggling control families. Success = canvas paint doesn't invalidate UI region; style+layout time per control-family toggle drops.

**Effort: S.**
**Risk: L.** Main risk is over-promotion (layer count → GPU memory bloat, bad on shared GPU) or `contain-intrinsic-size` mismatch causing scroll jump. Keep it surgical.

---

## Ranked summary

| # | Optimization | Effort | Risk | Primary win |
|---|---|---|---|---|
| 1 | Worker + OffscreenCanvas full decode→paint offload | L | M | Removes main-thread contention (biggest jank source under shared GPU) |
| 2 | Zero-copy `VideoFrame`→WebGL upload + strict `close()` discipline | M | L–M | Cuts GPU copies; UV-based zoom is free; prevents decoder stall |
| 3 | Paint on decode/due cadence, not 60fps rAF | S–M | L | Eliminates redundant blits on variable-fps ABR stream (~50% on 30fps) |
| 4 | SVC L1T3 pre-decode temporal-layer dropping | M | M | ~50% decode cost cut under load; graceful degradation |
| 5 | `content-visibility` + compositor-layer isolation | S | L | Decouples video layer from 24-family Solid UI raster |

---

## Sequencing & seams for Researcher #2

- **Do #1 first** — it's the substrate. #2, #3, #4 all assume the pipeline lives in a worker. But #1 has a hard dependency on **#2's lifecycle contract**: OffscreenCanvas + worker rAF do *not* get the same automatic backgrounding throttle, and a paused-but-not-closed pipeline leaks decoder buffers. #2 (you) must own: `visibilitychange` → post `{type:'suspend'}` to worker → worker stops decode/paint and optionally flushes+closes the queue; on resume, re-prime.
- **#4 crosses the WS/encoder boundary** — needs temporal-layer metadata in the chunk envelope. That touches your 24-control-family WS framing and the companion tab. Coordinate framing changes with whoever owns the reconnect/backpressure logic (#2's WS reconnect work).
- **Bundle interaction:** the render worker is a new entry point for Vite. Under strict Discord CSP (same-origin only, no CDN), confirm the worker chunk is emitted same-origin and the `new URL(..., import.meta.url)` pattern survives your proxy rewriting. This overlaps #2's bundle-strategy remit — the ~260KB bundle + lazy clip-mux chunk now gains a worker chunk; verify it doesn't blow the initial-load budget (worker can load *after* first paint since it's not needed for control UI hydration).
- **Memory:** #2 owns the leak surface. My frame-`close()` discipline (#2 in my list) is the acute leak; #2's broader memory-under-reconnect (dangling decoders after WS drop → recreate) must call `decoder.close()` and drop OffscreenCanvas references cleanly. A reconnect that spawns a second worker without tearing down the first doubles GPU memory on an already-contended GPU.

**One explicit non-recommendation:** WebTransport is unavailable in the Discord Activity iframe/CSP context, so anything that would want datagram transport for lower-latency chunk delivery is off the table — stay on the WS. Don't spend cycles researching it.

**Highest single bet if you can only ship one thing:** #1 + the `close()` half of #2 together. That combination addresses the dominant failure mode (main-thread contention jank + decoder stall) on the exact hardware profile you described (shared GPU, mid-range Windows, laptops).
