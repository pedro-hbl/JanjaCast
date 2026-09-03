[opus -> claude-opus-5 via TrustBridge]
# Seam 1 Issue Series — Introduce Slot machinery, maxSlots=1

**PM framing for all three issues:** Seam 1 is pure indirection. Nothing observable on the wire, in JSON, or in probe transcripts may change. The `Slot` type and `slots[6]` table exist, but exactly one slot (index 0) is ever live, and every legacy code path must resolve to it through a mechanical rename. If any of the 12 probe scenarios needs even a one-character edit, the seam has leaked and the issue is not done.

Nothing from Seams 2–5 appears here: **no header v2**, **no per-slot subscribe**, **no maxSlots>1**, **no client tiles**, **no epoch two-phase commit** (R1 is a Seam-4 concern; at maxSlots=1 there is one claim path unchanged). `welcome` gains `headerVersion:1 maxSlots:1` only — v1, not v2 — because we have not touched the wire header yet.

---

## Issue S1a — Relay: Slot struct + slots[6] table, all legacy `r.publisher` sites launder through slot 0

### Why this slice
The relay is where "one publisher per room" is hardcoded across 44 read sites plus GOP/clip/kf-debounce singletons. We introduce the target data structure (`Slot`, `slots[6]`) now, but bind everything to slot 0 so behavior is byte-identical. The 44 sites collapse to a single accessor pair so the diff is a mechanical rename, reviewable in one pass, and the singletons *move into* `Slot` without changing their lifetime or contents.

### Steps

1. **Define `Slot` with singleton-equivalent fields; no behavior yet.**
   Add the `Slot` struct (`idx`, `pub *Client`, `gop`, `clip`, `subs`, `kfDebounce`, `mu`) and `slots [6]*Slot` on `Room`, with only `slots[0]` ever allocated. Do NOT move any logic yet — struct exists, is populated at room init with `slots[0] = &Slot{idx:0}`, rest nil.
   *Verify:* `go test ./internal/server/ -run TestRoomInit` asserts `r.slots[0] != nil && r.slots[1] == nil` and room compiles/boots. All 12 probes untouched (they don't read this yet).

2. **Introduce the accessor pair `r.publisherLocked()` and `r.slotOf(c *Client)`.**
   `publisherLocked() *Client` returns `r.slots[0].pub`. `slotOf(c) *Slot` returns `r.slots[0]` if `r.slots[0].pub == c`, else nil. These are the ONLY two functions the 44 sites will call. Assert callers hold `Room.mu` (the "Locked" suffix is the contract).
   *Verify:* `go test -run TestAccessorPairSlotZero` — set `slots[0].pub = clientA`, assert `publisherLocked()==clientA`, `slotOf(clientA)==slots[0]`, `slotOf(clientB)==nil`.

3. **Mechanical rename: all 44 `r.publisher` read sites → `r.publisherLocked()`.**
   One commit, read sites only (no write sites, no logic). Grep-driven: every `r.publisher` that is a read becomes `r.publisherLocked()`. Write sites (claim/release) are step 6.
   *Verify:* `git grep 'r\.publisher\b' internal/server/ | grep -v publisherLocked` returns zero read sites. `go build ./...` green. `go test ./internal/server/` green.

4. **Move GOP cache into `slots[0].gop`, keep singleton lifetime.**
   The per-room `r.gop` / `r.clearGOPLocked()` (sites at 181, 227, 232, 300, 901, 958, 1441) now operate on `r.slots[0].gop`. `clearGOPLocked` becomes `r.slots[0].clearGOP()` guarded by the same `Room.mu` (no `Slot.mu` yet — introducing it here would be Seam-4 lock-strategy scope). Contents and trim behavior identical.
   *Verify:* `go test -run TestGOPReplayUnchanged` — publish a GOP, subscribe a late joiner, assert replayed chunk bytes identical to a pre-seam golden captured in step-0 of S1c.

5. **Move clip buffer into `slots[0].clip`, keep single-room byte budget.**
   `clipBuf`/`clipStartTs` (sites 441–445) move into `slots[0].clip`. The shared-budget division from the architecture doc is explicitly NOT implemented — at maxSlots=1 the one active slot gets the whole budget, which is exactly the old behavior. No `JANJACAST_CLIP_BUDGET_BYTES` slicing.
   *Verify:* `go test -run TestClipCaptureUnchanged` — capture a clip, assert byte length and start-ts identical to pre-seam golden.

6. **Route claim/release/takeover through `slots[0]`, preserving room-wide singleton takeover.**
   Publish-claim sets `slots[0].pub = c`. Release nils it, clears `slots[0].gop`, cancels `slots[0].kfDebounce`. Takeover stays **room-wide newest-wins** (NOT per-slot-per-person — that's Seam-4 redesign): a new publisher evicts the slot-0 occupant exactly as the old singleton did.
   *Verify:* `go test -run TestTakeoverEvictsSlotZero` — publisher A claims, publisher B publishes, assert A evicted, `slots[0].pub==B`, and eviction message sequence matches pre-seam golden.

7. **Move kf-debounce into `slots[0].kfDebounce`, same debounce window.**
   The keyframe-on-demand debouncer moves into the slot; window value and trigger conditions unchanged.
   *Verify:* `go test -run TestKfDebounceUnchanged` — fire N rapid keyframe requests, assert exactly one keyframe emitted within window, timing identical to golden.

### Acceptance criteria
1. **All 12 existing probe scenarios green, source UNMODIFIED** (`tools/probe --all`).
2. `git grep 'r\.publisher\b' internal/server/` shows zero sites outside the accessor pair.
3. `slots[1..5]` are `nil` at all times; a test asserts no code path allocates them.
4. GOP/clip/kf-debounce state lives inside `slots[0]` with unchanged lifetime and byte contents (golden tests 4/5/7 green).
5. No `Slot.mu` introduced; locking still `Room.mu` only.
6. `go build ./...` green after every commit (steps are individually compilable).

### Risks
- **Rename catches a false positive** (a `r.publisher` that is actually a write). Mitigation: step 3 is read-only by construction; writes handled in step 6.
- **GOP/clip move accidentally changes trim timing.** Mitigation: golden byte-equality tests in S1c capture pre-seam behavior first.
- **Reviewer conflates "move into Slot" with "add per-slot lock."** Explicitly out of scope; lock strategy is Seam-4.

---

## Issue S1b — Protocol + server: `stage_state` gains `slots[]`, legacy fields kept byte-identical; `welcome` carries `headerVersion:1 maxSlots:1`

### Why this slice
Seam 3+ need the client and probes to eventually read `slots[]`, but Seam 1 must not disturb any existing consumer. We add the additive `slots[]` array to `stage_state`/`room_state` **alongside** the existing `publisherId`/`publisherName` fields, which must serialize byte-identically. We also add the `welcome` assertion fields — but at **v1**, because we have not touched the wire header (that's Seam 2). This is the "additive, not breaking" step done conservatively: nothing is dropped, contra the architecture doc's atomic-deploy plan, because at Seam 1 the probes still assert the old shape.

### Steps

1. **Add `slots []SlotView` to the `stage_state` struct, populated as a slot-0 mirror.**
   `SlotView{Idx, Occupant, Live, Subscribers, RateHint}`. Populate `slots[0]` from the same source as `publisherId`/`publisherName`. Emit `slots` as a one-element array (only occupied/live slots, or slot 0 always — pick "slot 0 always present" for stability).
   *Verify:* `go test -run TestStageStateHasSlotZeroMirror` — assert `stage_state.slots[0].Occupant == stage_state.publisherId`.

2. **Guarantee legacy fields serialize byte-identically (field order, omitempty, null handling).**
   The `slots` field must be appended in JSON such that `publisherId`/`publisherName` bytes are unchanged. Verify with a serialization diff, not a semantic compare — probes match on bytes.
   *Verify:* `go test -run TestLegacyFieldsByteIdentical` — marshal a `stage_state` with a known publisher, assert the substring `"publisherId":"...","publisherName":"..."` appears byte-for-byte as pre-seam golden.

3. **Mirror the same additive change into `room_state`.**
   Same `slots []SlotView`, same slot-0 population, same byte-identity guarantee for legacy fields.
   *Verify:* `go test -run TestRoomStateHasSlotZeroMirror` + byte-identity assertion for `room_state`.

4. **Add `headerVersion:1` and `maxSlots:1` to the `welcome` message.**
   These are additive JSON fields. `headerVersion` is **1** (wire header untouched this seam) and `maxSlots` is **1** (hard pin). No client hard-refresh logic wired yet — the fields are informational until Seam 2.
   *Verify:* `go test -run TestWelcomeCarriesV1MaxSlots1` — assert `welcome.headerVersion==1 && welcome.maxSlots==1`, and legacy `welcome` fields byte-identical to golden.

5. **Assert `slots[]` never exceeds length matching maxSlots=1 semantics.**
   A guard: the emitted `slots` array reflects at most one live slot; nothing populates `slots[1..5]` in any state message.
   *Verify:* `go test -run TestNoSlotAboveZeroEmitted` — drive a publish/subscribe/release cycle, assert every `stage_state`/`room_state` emitted has no slot index > 0.

6. **Vacancy/release reflected in the mirror without new message types.**
   On release, `slots[0].Live=false, Occupant=""`; do NOT emit a new `slot_vacated` message (that's Seam 3+). The existing vacancy signalling (whatever the old `stage_state` did) is preserved and the mirror just tracks it.
   *Verify:* `go test -run TestReleaseMirror` — release publisher, assert no new message kind appears vs. golden transcript, and `slots[0].Live==false`.

### Acceptance criteria
1. **All 12 existing probe scenarios green, source UNMODIFIED** (`tools/probe --all`).
2. `publisherId`/`publisherName` bytes in `stage_state`/`room_state` are byte-identical to pre-seam golden (test 2/3).
3. `welcome.headerVersion==1` (NOT 2) and `welcome.maxSlots==1`.
4. No new message kinds introduced (`slot_vacated`, `subscribe`, etc. are Seam 3+).
5. No state message ever emits a slot index > 0.
6. `slots[]` is present and mirrors slot 0, consumed by nobody yet (client changes are Seam 5).

### Risks
- **JSON field-ordering change breaks byte-matching probes.** Mitigation- **JSON field-ordering change breaks byte-matching probes.** Mitigation: test 2/3 assert on the exact byte substring of the legacy fields, and `slots` is appended after existing fields; Go's `encoding/json` emits struct fields in declaration order, so place `Slots` last in the struct.
- **Temptation to set `headerVersion:2` "since we're here."** Explicitly wrong — the wire header is untouched in Seam 1; a probe decoding a v2 header would fail. Test 4 pins it to 1.
- **Temptation to drop the legacy `publisher` field** per the architecture doc's "drop it immediately." That drop belongs to the atomic client+server cut in a later seam; at Seam 1 the probes still assert the old shape, so dropping it fails criterion #1.
- **`slots[]` accidentally emitted as `null` vs `[]` vs 1-element** confusing a future consumer. Mitigation: fix the shape now (slot 0 always present, 1 element) via test 1/5 so Seam 3 inherits a stable contract.

---

## Issue S1c — Probe guard: capture-replay meta-scenario pinning pre-seam control transcript equality

### Why this slice
S1a and S1b claim "byte-identical" behavior. That claim needs an executable witness, not reviewer trust. This issue builds a meta-scenario that **records** the full control transcript of 3 representative existing scenarios *before* the seam lands, stores them as goldens, and *after* the seam asserts exact equality. This is the mechanical proof that the indirection leaked no semantics. It also provides the golden files that S1a steps 4/5/7 and S1b steps 2/3/4/6 reference — so **this issue's step 1 must land first on the pre-seam commit.**

### Steps

1. **Record pre-seam control transcripts for 3 scenarios (MUST run on the pre-seam tree).**
   Pick 3 scenarios that exercise the coupling: (a) single-publish/single-subscribe happy path, (b) publisher takeover/eviction, (c) late-joiner GOP replay + clip capture. Add `tools/probe --record <scenario> > testdata/golden/<scenario>.transcript`. Transcript = ordered list of control messages (kind + normalized JSON body) plus forwarded-media byte digests.
   *Verify:* `tools/probe --record all-three` on the pre-seam commit produces 3 non-empty golden files; committed as the baseline artifact. (This is the one step whose "green" is measured on the old tree.)

2. **Define transcript normalization (strip nondeterminism, keep semantics).**
   Normalize timestamps to relative-from-first, connection IDs to stable ordinals, and media payloads to length+SHA256. Anything that legitimately varies run-to-run is normalized; anything semantic (message kind, ordering, publisherId, slot mirror, GOP bytes) is preserved.
   *Verify:* `go test -run TestTranscriptNormalizationStable` — record the same scenario twice on one tree, assert normalized transcripts are equal (proves the harness itself is deterministic).

3. **Add the capture-replay meta-scenario that asserts post-seam equality.**
   `tools/probe --verify <scenario>` replays the scenario against the current tree and diffs the normalized transcript against the golden. Wrap all 3 in one meta-scenario `slot-zero-equivalence`.
   *Verify:* `go test -run TestSlotZeroEquivalence` — runs all 3 verifies; on the pre-seam tree this is trivially green (golden == self), establishing the guard works before S1a/S1b change anything.

4. **Add golden byte-fixtures consumed by S1a/S1b unit tests.**
   Export the GOP-replay bytes, clip bytes, kf-debounce timing, and legacy-JSON-field substrings from the recorded transcripts as named fixtures (`testdata/golden/gop.bytes`, `clip.bytes`, `stage_state.legacy.json`) so S1a step 4/5/7 and S1b step 2/3/4/6 assert against these exact artifacts rather than hand-written expectations.
   *Verify:* `go test -run TestGoldenFixturesLoadable` — all fixture files load and are non-empty; asserts the contract surface S1a/S1b depend on exists.

5. **Wire `slot-zero-equivalence` into the default probe run and CI gate.**
   `tools/probe --all` includes the meta-scenario. CI fails if any of the 3 diverge post-seam.
   *Verify:* `tools/probe --all` lists 12 legacy scenarios + `slot-zero-equivalence`; `go test ./tools/probe/...` green.

6. **Post-seam confirmation gate (runs after S1a + S1b merge).**
   After S1a/S1b land, `tools/probe --verify slot-zero-equivalence` must be green with the pre-seam goldens *unchanged*. If the golden had to be regenerated to pass, the seam leaked — regeneration is a failure signal, not a fix.
   *Verify:* `go test -run TestSlotZeroEquivalence` green against pre-seam goldens with zero golden edits; a CI check asserts `testdata/golden/*.transcript` are unmodified since step 1.

### Acceptance criteria
1. **All 12 existing probe scenarios green, source UNMODIFIED** (`tools/probe --all`).
2. 3 pre-seam golden transcripts committed and byte-frozen; any need to regenerate them to pass is a defect, not a merge.
3. `slot-zero-equivalence` meta-scenario green post-S1a/S1b with unmodified goldens.
4. Normalization is deterministic (test 2) — no flaky guard.
5. Golden fixtures consumed by S1a/S1b exist and load (test 4).
6. Guard added to default `tools/probe --all` and CI.

### Risks
- **Golden captured on wrong (post-seam) tree**, silently baking in leaked behavior. Mitigation: step 1 is explicitly ordered first on the pre-seam commit; step 6 CI check asserts goldens are immutable after capture.
- **Over-aggressive normalization hides a real regression** (e.g., normalizing away slot mirror content). Mitigation: normalization strips only timestamps/IDs/payload-to-digest; message kinds, ordering, and semantic fields are preserved and diffed.
- **Under-normalization makes the guard flaky**, tempting reviewers to loosen it. Mitigation: test 2 proves determinism on a single tree before the guard is trusted; flakiness is fixed in normalization, never by weakening the diff.
- **Transcript captures too little to catch the GOP/clip move.** Mitigation: scenario (c) specifically exercises late-joiner GOP replay + clip capture, and media payloads are digested, so a byte change in replayed frames breaks the diff.

---

## Series-level sequencing note (for the PM)

Merge order is **S1c step 1 → (S1a ‖ S1b) → S1c steps 3–6**:

1. **S1c step 1 lands first on the pre-seam tree** to freeze goldens. Nothing else has changed yet.
2. **S1a and S1b are independently mergeable** (relay indirection vs. JSON/welcome additions don't collide), each gated by the 12 legacy probes staying green unmodified.
3. **S1c's equivalence gate closes the seam** — it is the single artifact proving Seam 1 was pure indirection.

The invariant that makes Seam 1 "done": every one of the 12 legacy scenarios passes with an unmodified source tree, and the `slot-zero-equivalence` transcripts match the pre-seam goldens with zero regeneration. If either fails, the indirection leaked and Seam 2 cannot start.
