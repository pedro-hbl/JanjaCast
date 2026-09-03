# Wave R — web performance: the four approved packages

RESEARCH-1.md and RESEARCH-2.md carry the full dossiers. Owner-approved
scope, in implementation order:

1. **Worker pipeline** (R1#1 + R2#1): decode+paint in a Worker with
   OffscreenCanvas, presentation driven by requestVideoFrameCallback.
2. **Zero-copy + SVC-aware decode** (R1#2 + R1#4): no intermediate copies
   on the paint path; drop T1/T2 layers BEFORE decode when behind.
3. **Reconnect hardening** (R2#3): jittered backoff, control coalescing on
   rejoin — no reconnect storms when the tunnel blinks for a whole room.
4. **Compositor/scheduling polish** (R1#5 + R2#5): content-visibility,
   canvas layer isolation, scheduler.postTask for control handling.

## THE INVARIANT (owner-mandated, non-negotiable)

Alt-tab must NEVER introduce delay — for the viewer OR the sharer. Today
the stream stays live through backgrounding and it must remain exactly so:

- drop-to-live keeps ruling: frames are never accumulated to be shown
  late; if the tab was throttled, the next visible frame is the LIVE one.
- The worker must inherit MAX_QUEUE_DEPTH semantics; a backgrounded tab
  drains to live, never buffers.
- The rejected lifecycle package (freeze+resync) is rejected BECAUSE it
  trades delay for smoothness — do not smuggle it in.
- Verify for every package: glass-to-glass latency measured before/after
  alt-tab cycles must not regress (the hover stats already display it).

## Gates
Standard AGENTS.md gates + all 12 probe scenarios green (protocol
untouched by 1/2/4; package 3 touches session reconnect — the probes that
exercise reconnection must stay green).
