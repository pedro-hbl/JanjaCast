# docs/multistream-architecture.md

## Multi-Publisher Architecture (v2)

**Decision summary:** Slots `0..5`, header v2 with a `slot u8` field, subscribe-per-slot as the only egress model, N-decoder-in-1-worker on the client, stage-queue-feeds-vacancies. Deploy client+server atomically; HTML is `no-store` so there is no half-upgraded fleet.

---

## 1. Wire Format

**Decision: header v2, insert `slot u8`, `HEADER_SIZE = 14`. Clean cut, no versioning byte.**

Bit-packing into `flags` is rejected: only 6 slots but flags is already committed to future flag bits, and packing forces every one of the 44 call sites into masking arithmetic. Per-slot WS framing (a WS message envelope per slot) is rejected: it doubles framing overhead on the hot path and moves demux off the fixed header that `tools/probe` and every decoder already assume.

New layout (big-endian, offset:size):

```
0:1  kind        u8
1:1  flags        u8   (bit0 keyframe; bits1-7 reserved)
2:1  slot         u8   (0..5; 0xFF reserved = "no slot" / control-ish)
3:1  temporalId   u8
4:2  seq          u16be  (per-slot sequence now)
6:8  timestampUs u64be
== 14 bytes
```

`seq` becomes **per-slot** — each publisher's stream has its own monotonic sequence. This is required for per-slot GOP/reorder logic.

**Negotiation:** none on the media header itself. The `welcome` JSON gains `"headerVersion": 2` and `"maxSlots": 6` as an assertion, not a negotiation — a client seeing `headerVersion != 2` hard-refreshes (it's stale HTML). This keeps the fixed-header simplicity that the entire probe suite depends on.

---

## 2. Relay Model

**Decision: `Room.publisher *Client` → `Room.slots [6]*Slot`.** Slot index is stable identity for the lifetime of a claim.

```go
type Slot struct {
    idx        uint8
    pub        *Client          // nil = vacant
    gop        *GopCache        // per-slot
    clip       *ClipBuffer      // per-slot, see ceilings
    subs       map[*Client]*SubState // viewers subscribed to THIS slot
    kfDebounce *Debouncer
    rateHint   int              // kbps target sent to this encoder
    mu         sync.Mutex       // per-slot lock (see below)
}
```

**Lock strategy: keep `Room.mu` for membership/slot-claim topology (rare, structural), add per-slot `Slot.mu` for the hot media path.** A single `Room.mu` would serialize all 6 publishers' fan-out — unacceptable. Rule: acquire `Room.mu` → `Slot.mu` never the reverse; media fan-out takes only `Slot.mu`. Slot claim/release takes `Room.mu` then the target `Slot.mu`.

**Memory ceilings.** GOP cache is per-slot, bounded by `min(GOP, 2s)` at slot's rate hint. Clip buffer is the expensive one: 6 × full rolling buffer will blow a relay box. **Decision: clip buffer is per-slot but rolling window is shared-budget** — `JANJACAST_CLIP_BUDGET_BYTES` divided across *active* slots, so 6 publishers each get 1/6 the seconds. A slot going vacant returns its share.

**Claim/release/takeover per person:**
- **Claim:** first free slot (lowest idx). Person → slot binding recorded.
- **Takeover (newest-wins):** now scoped *per slot* by person identity. A person reclaiming their own slot evicts their stale connection on that slot only — no longer a room-wide singleton fight.
- **Release:** slot → vacant, GOP/clip cleared, subs notified `slot_vacated`, kf-debounce cancelled.

**JSON shape: additive arrays, not breaking.** `stage_state` and `room_state` gain a `slots: [{idx, occupant, live, subscribers, rateHint}]`. The old singleton `publisher` field is emitted as `slots[0]` mirror for one release cycle then dropped — but since deploy is atomic and HTML no-store, we drop it immediately. **Decision: break the shape, deploy together.**

**Stage queue / rodizio / corrente / padrinho:** the "stage" is now 6 vacancies. **Decision: the queue feeds SLOT VACANCIES.** Rodizio clock rotates the *longest-held occupied slot* out when the queue is non-empty (fairness across all slots, round-robin by hold-time). Corrente handoff: a leaving publisher can pass their *specific slot* to a named successor (padrinho preserves the direct-nomination semantic per slot). This is the cleanest mapping — one clock, six chairs.

---

## 3. Subscriptions & Egress

**This is the load-bearing decision.** Residential uplink means the relay must never push a slot a viewer isn't watching.

**Control:** `subscribe {slots:[u8]}` / `unsubscribe {slots:[u8]}` — set-based, idempotent. Relay maintains `Slot.subs`. A viewer's default subscription is `[]` (nothing) until the client requests tiles; opening a 4-tile grid sends `subscribe {slots:[0,1,2,3]}`.

**Egress budget split.** Old model: `BUDGET / viewerCount` to the one encoder. New model is two-dimensional. **Decision:**
```
per_slot_target(s) = BUDGET_KBPS × weight(s) / Σ weight
weight(s) = subscriberCount(s)   // slots nobody watches cost ~0
```
Each slot's target is the rate hint sent to *that publisher's encoder*. A slot with zero subscribers gets a floor hint (or pause request) — no reason to encode into the void. Rate hints go per-slot to each companion capture tab via that publisher's control channel.

**Per-slot temporal shedding:** SVC shedding is now per (slot, viewer). A slow viewer sheds temporal layers *independently per tile* — a viewer struggling on slot 3 drops slot 3's high temporal layer while keeping slot 0 crisp. `SubState` holds per-slot shed level.

**Keyframe-on-demand per slot:** debounce is per-slot (already in the struct). A late joiner subscribing to slot 2 triggers slot-2's kf-debounce only; GOP cache for slot 2 serves the immediate catch-up frames.

---

## 4. Client

**Decision: ONE worker, N `VideoDecoder`s, N `OffscreenCanvas`es.** Rejecting N workers:
- 6 workers × decoder context = 6× the JS heap, message-port chatter, and — critically — **6 separate GPU upload paths.** A single worker with N canvases lets us keep one `requestAnimationFrame`-driven paint loop and one A/V clock.
- On a mid Windows PC, the real ceiling is **hardware decode sessions** (Intel/NVIDIA typically 3–8 concurrent HW decode contexts). 6 H.264 decoders may exceed HW and fall to software on some tiles. Mitigation: subscribe-driven — you only decode what's on screen; a 1-tile focus view runs one decoder. The 6-tile case is the stress case and gets lowest per-tile resolution via rate hints.

Layout: one worker owns a `Map<slot, {decoder, canvas, painter}>`. Demux by header `slot`, route chunk to the right decoder.

**Grids:** 1 = full; 2 = side-by-side; 3 = 2-over-1 (or 1 focus + 2 rail); 4 = 2×2; 6 = 3×2. **Focus mode:** one tile large + others as a rail; focus tile keeps full temporal/rate, rail tiles shed aggressively (client sends per-slot shed hints / reduced subscribe priority).

**Audio policy:** **Decision: solo-on-click default, with opt-in mix.** Mixing 6 audio streams is a cacophony and A/V-anchor nightmare (6 clocks). Default: the focused tile's audio plays; clicking a tile solos its audio. Optional "mix" toggle enables all-subscribed with **ducking** — non-focused tiles at −12dB. The wall-clock A/V anchor now anchors to the *soloed/focused* slot's timestamp.

**Per-tile zoom/stats:** per-tile overlay reading that slot's `SubState` (bitrate, shed level, seq gaps).

**Blank/captions/assist/VAR scope per tile:** all become **per-slot**. Privacy blank gates one slot's paint. Captions (legendas) render per-tile. Telinha (PiP/assist) attaches to a chosen slot.

---

## 5. Feature Triage

| Family | Verdict |
|---|---|
| clips | **per-slot** (shared byte budget, per-slot capture) |
| replay | **per-slot** (replay one tile) |
| cinema pause | **redesign** — pause is per-tile freeze; "pause all" = pause focused + hint others |
| blank (privacy) | **per-slot** gating |
| placar (scoreboard) | **unchanged** (room-scoped overlay) |
| bolão | **unchanged** (room-scoped) |
| aposta | **unchanged** (room-scoped) |
| jukebox | **unchanged** (room-scoped audio, separate from tiles) |
| legendas | **per-slot** rendering |
| attention | **per-slot** signal (which tile) |
| corrente | **redesign** — handoff scoped to the leaver's slot |
| fila (queue) | **redesign** — feeds slot vacancies |
| warmup | **per-slot** (warm the slot you'll claim) |
pektiv) | needs slot-awareness (room-scoped now spans N slots) |
| telinha | unchanged (client-side layout) | needs per-slot tile placement + slot→participant binding map |

## 6. Migration Plan

The cuts below are ordered so the tree compiles after each and every existing wire probe stays green. No probe is deleted or weakened until the seam that made it obsolete has shipped and its replacement probe is live.

**Seam 1 — Introduce Slot machinery, `maxSlots = 1`.** Add the `Slot` struct, `SlotTable`, and the `slotId` field threaded through the publish/forward path, but hard-pin `maxSlots = 1` per room. Every publish claims slot 0; every subscribe reads slot 0. The forwarder still does exactly what it did — one media flow per participant — it just launders it through the new indirection. *Guarded by:* the full legacy `single-publish/single-subscribe` probe suite runs unmodified. If `slot-always-zero` diverges from the pre-seam capture, the indirection leaked semantics.

**Seam 2 — Header v2, slot field always 0.** Bump the wire header to carry an explicit `slotId`. Old peers negotiate v1 (implicit slot 0); new peers send v2 with `slotId = 0`. The parser accepts both. *Guarded by:* a new `header-v1-v2-interop` probe pins that a v1 publisher and v2 subscriber produce byte-identical forwarded payloads (modulo the header). The legacy probes still assert v1 on the v1 path.

**Seam 3 — Per-slot subscribe, default = all.** Subscribers gain a `wantSlots` set; when unspecified it defaults to *all slots present*, which with `maxSlots = 1` is still exactly slot 0. This lets the subscribe control plane learn to enumerate and filter before any slot > 0 exists. *Guarded by:* `subscribe-default-all` must match the Seam-1 capture exactly; a new `subscribe-explicit-slot-0` probe asserts that naming slot 0 explicitly is identical to defaulting.

**Seam 4 — Lift the cap (`maxSlots > 1`).** Now `maxSlots` becomes room-configurable. A participant may claim a second slot. The forwarder fans out per slot; subscribers with default `wantSlots` receive the union. This is the first seam where *behavior* changes for a multi-slot room — so it ships behind a room flag, default off. *Guarded by:* legacy probes run in flag-off rooms and stay green; a new `multi-slot-fanout` probe runs only in flag-on rooms.

**Seam 5 — Client tiles (telinha per-slot).** The client binds slots→tiles and renders the slot→participant map. Purely additive on the client. *Guarded by:* `tile-slot-binding` snapshot probe; server probes untouched.

## 7. Risks (ranked) + the 3 nastiest races

**R1 (high) — Slot claim vs. media in flight.** A participant claims slot *k* and begins publishing before the SlotTable commit propagates to the forwarder; media arrives tagged for a slot the forwarder considers unclaimed and drops it, or worse, forwards it to a stale binding. **Guard:** claim is a two-phase commit — media for slot *k* is buffered (bounded, ~1 GOP) at the forwarder until the claim epoch matches; media stamped with a pre-claim epoch is discarded, never mis-routed.

**R2 (high) — Subscribe churn vs. GOP replay.** A subscriber rapidly toggles `wantSlots` and each add triggers a keyframe/GOP replay; churn floods the replay path and starves live forwarding. **Guard:** coalesce subscribe deltas over a short window and rate-limit per-slot replay to one in-flight GOP per subscriber-slot; further toggles within the window collapse to the final desired set before any replay fires.

**R3 (medium) — Per-slot rate hint oscillation.** Two subscribers on the same slot push opposing rate hints; the encoder ping-pongs bitrate. **Guard:** aggregate hints per slot with a hysteresis band (min of active hints, but only step down after N consecutive intervals below the current floor), so a single flapping subscriber cannot drive the shared encoder.
