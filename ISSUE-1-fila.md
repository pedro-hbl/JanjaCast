[opus -> claude-opus-5 via TrustBridge]
# Feature Issue: "Fila do Próximo" — Handoff Continuity Bridge

## Title
**Fila do Próximo** — zero-gap publisher handoff with a pre-warmed "aquecendo" slot

## Pitch
Quando o publisher atual termina ou passa a vez, o próximo da fila já entra com a companion tab **aquecida** — sem tela preta, sem "cadê a stream", sem reabrir aba do zero. A TV nunca apaga entre um jogador e outro: **"Já tá aquecendo a próxima!"**

## Why now
The stage queue ("pedir a vez") shipped, but it only decides *who's next* — it doesn't solve the **dead-air gap** when the current publisher stops and the next one has to open the companion tab, grant capture, and wait through wait-phases. In a Brazilian friend-group rotation (rodízio de FIFA, entre partidas de valorant), that 10-30s black gap is where the vibe dies and people leave the Activity. Since JanjaCast is now the *only* screen-share on Discord BR, retention across handoffs is the actual moat — the queue exists but the transition is unpolished, and no generic PM is looking at the *seam* between publishers.

## Scope / Non-goals
**In scope:**
- A "próximo aquecendo" pre-warm state: the next-in-queue is signaled to open + prep their companion tab *while the current publisher is still live*.
- A handoff sequence where the relay only clears the outgoing publisher's GOP cache *after* the incoming publisher's first keyframe lands.
- A room-visible "aquecendo" indicator so viewers know continuity is coming.

**Non-goals:**
- No changes to turn-mode logic (livre/rodízio/wheel) — this consumes the existing queue order.
- No overlay on the center video (crayon indicator lives in the roster/stage-strip, never over the frame).
- No multi-publisher simultaneous streaming (still one publisher per room).
- No recording/VOD interaction.

## Implementation plan

### Step 1 — Relay computes and broadcasts "who's warming"
**Concern:** the relay must know which queue member to pre-warm and tell the room.
When a publisher is live AND the queue has a next entry, relay emits `next_warming` to all clients.
**Verify:** Probe: publisher A live, user B claims next in queue → assert **all** clients (including A) receive `next_warming` with fields `{ userId: "B", position: 1, phase: "idle" }`.

### Step 2 — Warming target receives a private warm-up cue
**Concern:** only B should be told to open the companion tab early.
Relay sends a targeted `warm_up_request` to B's socket only, carrying a fresh HMAC share token.
**Verify:** Probe: assert **only** B's socket receives `warm_up_request` with `{ shareToken: <non-empty>, expiresInMs: number }`; assert A and other viewers do **not** receive this message.

### Step 3 — Companion tab reports warm-up progress phases
**Concern:** the room needs truthful phase state, not a fake spinner.
B's companion tab, once capturing, sends `warm_progress` transitions (`opening → captured → encoding_ready`).
**Verify:** Probe (simulating B's companion socket): send each phase; assert relay rebroadcasts `next_warming` update with matching `phase` field to all clients in order.

### Step 4 — Incoming publisher buffers frames without going live
**Concern:** B may send keyframes before it's B's turn; relay must not fan them out yet.
Relay accepts B's encoded chunks into a **staging buffer** but does NOT fan out while A is still the active publisher.
**Verify:** Probe: while A is publisher, B sends chunk frames → assert other viewers receive **zero** media chunks attributed to B (`publisherId` on all fanned chunks stays `"A"`).

### Step 5 — Atomic swap on stop/handoff
**Concern:** the swap must be single-transaction so no frame from A leaks after B is live and vice versa.
On A's `stop`/`pass_turn`, relay flips active publisher to B **only if** B's `warm_progress` reached `encoding_ready`; else falls back to normal empty-stage flow.
**Verify:** Probe: A `pass_turn` with B ready → assert `stage_changed` broadcast with `{ publisherId: "B", handoff: true, gapMs: number }`; assert first post-swap media chunk carries `publisherId: "B"`.

### Step 6 — GOP cache continuity for late/existing viewers
**Concern:** existing viewers must decode B's stream immediately without a black flash.
Relay serves B's staged keyframe as the GOP-cache anchor at swap moment; A's cache is dropped only *after* swap confirmed.
**Verify:** Probe: viewer C attached throughout → assert C receives a keyframe (`isKeyframe: true, publisherId: "B"`) within same broadcast tick as `stage_changed`, with no intervening `stage_empty` message.

### Step 7 — Fallback when warming fails or times out
**Concern:** B may never reach `encoding_ready` (closed tab, denied capture).
If warm-up TTL expires (reuse 20s claim TTL convention), relay emits `warm_failed` and reverts to standard empty-stage / next-in-queue flow.
**Verify:** Probe: B warms but never sends `encoding_ready` before TTL → assert all clients receive `warm_failed { userId: "B", reason: "timeout" }` followed by normal empty-stage broadcast.

### Step 8 — Room-visible crayon "aquecendo" indicator (roster only)
**Concern:** viewers should see continuity is coming, without touching the video frame.
Client renders "🔥 aquecendo a próxima…" in the stage-strip/roster driven purely by `next_warming.phase`.
**Verify:** Committed client test: given `next_warming { phase: "encoding_ready" }`, assert roster node renders string `"aquecendo a próxima"` and indicator is **not** a child of the center-video container (DOM assertion on parent node).

## Acceptance criteria
1. When a publisher is live with a queued next, all clients observe `next_warming` (→ Step 1 probe).
2. Only the warming target receives capture credentials (→ Step 2 probe, negative assertion on others).
3. Warm-up phases propagate truthfully to the room (→ Step 3 probe).
4. No media from the incoming publisher reaches viewers before swap (→ Step 4 probe, zero-chunk assertion).
5. Handoff produces a single `stage_changed` with `handoff: true` and measurable `gapMs` (→ Step 5 probe).
6. Existing viewers get a B-keyframe with no intervening `stage_empty` (→ Step 6 probe — this is the "no black gap" guarantee).
7. Failed warm-up degrades gracefully to existing empty-stage flow (→ Step 7 probe).
8. Continuity indicator never renders over the center video (→ Step 8 DOM test).

## Risks
- **Egress budget on residential uplinks:** staging B's frames while A is live *doubles* inbound bandwidth to the relay momentarily. Mitigation: cap staging to keyframe + minimal SVC base layer (L1T3 base only) until swap; gate warm-up on egress budget headroom (reuse existing budget system).
- **Companion-tab double-open UX:** B might already have a tab open from a prior turn; must dedupe via share token, not spawn a second tab.
- **Two-publisher-encoding on one PC:** if A and B are on the *same* physical machine (couch co-op), pre-warm encode could thrash. Mitigation: warm-up requests base-layer-only; acceptable single-machine degradation.
- **Timing edge:** A stops *before* B reaches `encoding_ready` — Step 5's conditional swap + Step 7 fallback cover this, but probe must cover the race explicitly.

## Effort
**M** — reuses queue order, HMAC tokens, GOP cache, egress budget, and 20s TTL convention; the novel work is the relay's staging-buffer + atomic-swap state machine and its probe coverage. No new infra, no video-frame changes.
