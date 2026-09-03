[opus -> claude-opus-5 via TrustBridge]
# Issue: "Deixa Comigo" — Cooperative Remote Assist Pointer

## Title
Deixa Comigo — viewer-driven "assist beacons" the publisher actually sees (co-op troubleshooting/gameplay pointer)

## Pitch
Quando um amigo tá travado num boss, num bug ou no menu errado, você não precisa mais gritar "vai na terceira opção, PORRA, a TERCEIRA" — você toca na tela e uma seta desenhada aparece pro streamer, exatamente onde. É o "senta aqui que eu resolvo" transformado em ferramenta: viewers apontam, o publisher decide o que aceita, e nada nunca fica em cima do vídeo pra sempre.

## Why now
Discord matou o screen share no Brasil e as galeras migraram pro JanjaCast pra jogar/resolver PC junto — mas hoje o único canal de "me ajuda aqui" é voz + reação genérica, que não localiza nada na tela. A lane que ninguém pega: a maioria dos PMs vai empilhar mais **broadcast** (mais emoji, mais placar); a real dor da co-op brasileira é **apontar espacialmente** sem poluir o vídeo nem dar controle remoto (que a arquitetura iframe nem permite). Isto reaproveita a rolling buffer + canvas do doodle do cinema, mas inverte a direção: viewer → publisher, efêmero, guard-railed.

## Scope / Non-goals

**In scope:**
- Viewer taps/clicks a normalized coordinate on their canvas → sends a transient "beacon" the publisher sees in *their Activity* (not on the video, see below).
- Beacon = crayon arrow + author name, rendered in a **margin gutter / edge frame**, never over the center video.
- Publisher-side aggregation: multiple viewers pointing at same region = single "heat" beacon with count.
- Rate limit + publisher mute toggle ("pausa os palpites").
- Auto-expire (3s TTL per beacon).

**Non-goals:**
- No remote input/control of the publisher's machine (arch-forbidden anyway).
- No persistent annotations (that's Legenda territory, and it violates "silent in the middle").
- No overlay *on* the video pixels — beacons live in a **crayon border gutter** with a leader-arrow pointing inward. Nothing over the center video.
- No viewer→viewer beacons (publisher is the only recipient).

## Implementation plan

### Step 1 — Wire the beacon message (viewer → relay → publisher only)
Concern: one new client→server message and its targeted fan-out to the publisher alone.
Add `assist_beacon` `{roomId, x:0..1, y:0..1, ts}`. Relay routes it **only to the current publisher's socket**.
**Verify (probe):** two viewers + one publisher joined; viewer A sends `assist_beacon{x:0.5,y:0.5}`; assert publisher receives `assist_beacon_relayed{authorId:A, x:0.5, y:0.5, seq}` and viewer B receives **nothing**.

### Step 2 — Server-side rate limit per author
Concern: prevent spam floods on the publisher.
Cap at 3 beacons/sec/author; excess dropped silently server-side.
**Verify (probe):** viewer A sends 10 `assist_beacon` in one tick; assert publisher receives exactly ≤3 `assist_beacon_relayed` within the window and no `error` frame is broadcast to others.

### Step 3 — Spatial aggregation into heat beacons
Concern: collapse multiple viewers pointing at the same region.
Relay buckets beacons on a coarse grid (e.g. 8×8 normalized) within a 400ms window; emits one `assist_beacon_relayed{gridX,gridY,count,authors[]}`.
**Verify (probe):** viewers A and B both send beacons at x∈[0.5,0.6],y∈[0.5,0.6] within 400ms; assert publisher receives a single `assist_beacon_relayed` with `count:2` and `authors` containing both ids.

### Step 4 — Publisher mute toggle ("pausa os palpites")
Concern: publisher can silence the channel with one control.
Add `assist_set_muted{roomId, muted:bool}` (publisher-only, HMAC/author-checked). While muted, relay drops all `assist_beacon`.
**Verify (probe):** publisher sends `assist_set_muted{muted:true}`; assert broadcast `assist_muted_changed{muted:true}` reaches all viewers; then viewer A sends a beacon and assert publisher receives **nothing**.

### Step 5 — Auto-expire signal
Concern: beacons must be transient, not linger.
Each relayed beacon carries `ttlMs:3000`; client removes on timeout (no server retract needed, but server tags it).
**Verify (test):** unit/integration test asserts every `assist_beacon_relayed` includes `ttlMs:3000`; client-side timer test asserts the DOM node is removed after 3000ms.

### Step 6 — Publisher-side gutter render (Activity, NOT companion tab)
Concern: render beacons in the crayon border gutter with an inward leader-arrow, never over video.
Beacon anchors to the nearest frame edge at the beacon's projected position; crayon arrow points inward toward (x,y); shows author name or "+N".
**Verify (test):** component test — given `assist_beacon_relayed{x:0.5,y:0.02,count:3}`, assert the beacon node's bounding box is within the top gutter region and does NOT intersect the video element's rect; assert label reads "+3".

### Step 7 — Viewer-side aim affordance
Concern: viewers need a clear "aponta aqui" gesture without hijacking zoom/pan.
Long-press (or a held modifier) on the viewer canvas arms aim mode; tap emits normalized coords derived from the *current zoom/pan transform* so it maps to true source coords.
**Verify (test):** given viewer zoomed 4x panned to top-left, a tap at screen-center resolves to the correct source-normalized (x,y); assert emitted `assist_beacon.x/y` matches expected within tolerance.

### Step 8 — De-dupe against panic/cinema/telinha states
Concern: don't emit beacons when there's nothing meaningful to point at.
Relay rejects `assist_beacon` while room is in panic-blanked or INTERVALO-paused state.
**Verify (probe):** publisher triggers panic; viewer sends `assist_beacon`; assert publisher receives no `assist_beacon_relayed` and an `assist_rejected{reason:"panic"}` returns to the sender only.

## Acceptance criteria
1. A viewer beacon reaches **only** the publisher, never other viewers. *(probe: Step 1)*
2. A single author cannot exceed 3 beacons/sec reaching the publisher. *(probe: Step 2)*
3. Two viewers pointing at the same region produce one aggregated beacon with `count:2` and both author ids. *(probe: Step 3)*
4. Publisher mute stops all beacons and broadcasts `assist_muted_changed`. *(probe: Step 4)*
5. Every relayed beacon carries `ttlMs:3000` and disappears client-side after 3s. *(test: Step 5)*
6. Rendered beacons never intersect the video element's rect; multi-author shows "+N". *(test: Step 6)*
7. Beacon coords survive viewer zoom/pan and map to true source coords. *(test: Step 7)*
8. Beacons are rejected during panic and INTERVALO with a sender-only `assist_rejected`. *(probe: Step 8)*

## Risks
- **Zoom/pan coordinate drift** (Step 7): if the transform math is wrong, arrows point at the wrong spot — worse than no feature. Mitigation: tolerance-tested resolver, ship behind aim-mode long-press so accidental beacons are rare.
- **Gutter clutter** at high viewer counts: aggregation (Step 3) + 3s TTL is the guardrail; if still noisy, publisher mute is one tap.
- **Publisher attention split**: beacons appear in the Activity, but the publisher is usually looking at their *game* (companion tab / full screen). Real value lands in co-op troubleshooting / menu-navigation sessions, not fast action games — acceptable, it's a tool not a toy. A subtle audio tick on first beacon per burst could help (out of scope for v1).
- **Aggregation window tuning** (400ms / 8×8 grid) may feel laggy or too coarse; values are relay constants, cheap to iterate post-probe.

## Effort
**M** — one new message pair + targeted (non-broadcast) routing + server-side rate-limit/aggregation state are the meat; client render reuses the existing crayon canvas + gutter primitives. No new infra, no companion-tab changes.
