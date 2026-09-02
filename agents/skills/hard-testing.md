# Skill: hard functional testing (the probe)

Unit tests in this repo have passed while features were completely dead on
the wire. The probe is the layer that catches that: it boots the REAL
compiled server and drives it over REAL WebSockets.

## Running

One-time: `cd tools/probe && npm install`. Then from the repo root:

```
node tools/probe/harness.js --scenario tools/probe/scenarios/<feature>.js
```

It builds `./cmd/janjacast`, boots it on :8102 with `JANJACAST_ALLOW_ANON=1`,
runs your scenario, prints a transcript and `PROBE RESULT: PASS|FAIL`, exits
0/1. Check the REAL exit code.

## Writing a scenario

One file per feature in `tools/probe/scenarios/`, exporting
`module.exports.run = async (h) => boolean`. The harness hands you:

- `h.spawnClients(n, room)` → clients with `sendCtrl(type, data)`,
  `sendMedia(buf)`, `onCtrl(type, timeoutMs)` (resolves on receipt, rejects
  on timeout), `ctrl[]`/`bin[]` receive logs, `close()`.
- `buildMediaChunk({kind, keyframe, temporalId, seq, timestampUs, payload})`
  for synthetic publisher media (13-byte header, exported from harness.js).
- `h.note(event, extra)` — write every step and every assertion into the
  transcript; the transcript IS the evidence.

Rules for a scenario that counts as proof:

1. It must assert the OBSERVABLE effect at another client (fan-out), never
   just the sender's echo or an HTTP 200.
2. It must assert exact values from the spec (counts, ids, ordering), not
   "some message arrived".
3. It must fail without the feature (run it once before implementing —
   spec-driven step 3 — and paste that red transcript too).
4. Timeouts are assertions: an expected broadcast that does not arrive
   within its window is a FAIL, logged with what was waited for.
5. For features that produce binary artifacts (clips, media), validate the
   artifact with an independent decoder where one exists (`ffprobe` if
   installed — check with `ffprobe -version`); otherwise assert structural
   invariants (magic bytes, monotonic timestamps, keyframe-first) and say in
   the EVIDENCE which validator was used.

## The dispatch-coverage rule

Every client→server ControlType added to `internal/protocol/protocol.go`
MUST be routed in `internal/server/server.go`'s control switch, and
`TestDispatchCoverage` (internal/server) enforces it by scanning the source.
If you add a control type, that test failing is the system working — wire
the dispatch, don't touch the test's allowlist unless the type is genuinely
server→client only.
