# Agent operating manual (JanjaCast)

JanjaCast is a Discord Activity for screen livestreaming: Go relay (`internal/`,
`cmd/janjacast/`) doing 1→N fan-out over WebSocket, SolidJS + WebCodecs client
(`web/`). Hand-drawn "crayon" design language — read `docs/design.md` before
touching UI. Primary audience is Brazilian; every user-facing string is
localized.

## Non-negotiable rules

- **Relay lock discipline:** `Hub.mu` before `Room.mu`; `Client.out` is NEVER
  closed (use the `done` channel); callbacks invoked under `Room.mu` must be
  pure; all fan-out through the existing non-blocking enqueue paths.
- **i18n:** every user-facing string goes through `t()` in `web/src/i18n.ts`
  with BOTH `en` and `pt-BR` entries, informal Brazilian Discord register
  ("call", "ao vivo", "Bora"). The dictionary is typed off `en`, so a missing
  pt-BR key is a compile error — keep it that way.
- **The stage is sacred:** nothing renders over the center video safe-zone.
  (Single sanctioned exception: the cinema-mode doodle canvas while paused.)
- **CSS animation** on `transform`/`opacity` only.
- **Protocol mirrors:** any change to `internal/protocol/protocol.go` must be
  mirrored in `web/src/protocol.ts`, and vice versa.
- Match the surrounding code style and comment voice (full sentences, the
  "why", no change-log comments).

## Skills (load before coding — they are part of the contract)

Read these three files in full before writing any code; their rules are
binding, and the REPORT must state you applied each:

- `agents/skills/spec-driven.md` — wire trace first, failing proof first,
  hop-by-hop implementation, the no-placeholder rule, UI extra proof.
- `agents/skills/hard-testing.md` — the probe harness (`tools/probe/`): how
  to write and run wire-level scenarios that boot the real server; the
  dispatch-coverage rule.
- `agents/skills/evidence.md` — the EVIDENCE section every issue must carry
  before its final commit.

## Working protocol (agentic runs)

1. **Never end your run with a text-only reply while work remains** — a
   text-only reply terminates the run, and a REPORT with a non-empty
   leftover is a FAILED run. Keep calling tools until the final commit
   exists. Do not ask for permission mid-run; you already have it.
2. Implement the issue file(s) in the repo root (`ISSUE*.md`) step by step,
   running each step's Verify. **Two-commit rhythm per feature:** commit A =
   the probe scenario + any unit tests, with their RED run pasted into the
   issue's EVIDENCE (they must fail for the right reason — an assertion, not
   a crash); commit B+ = the implementation that turns them green.
3. **Gates before the final commit** (check REAL exit codes — piped output
   masks them; if `node_modules` is missing run `npm ci` in web/ first):
   - `cd web && JANJACAST_DISCORD_CLIENT_ID=1544440867799048253 npm run build`
     → must exit 0
   - `go vet ./... && go test ./...` from the repo root → must pass
   - `node tools/probe/harness.js --scenario tools/probe/scenarios/<feature>.js`
     → `PROBE RESULT: PASS`, exit 0 (one-time `cd tools/probe && npm install`)
4. **Self-review before the final commit.** Generate the full diff and send it
   to a *different vendor* for review, ASCII-escaping it first (the gateway
   502s on emoji):

   ```bash
   git diff | python -c "import sys; sys.stdout.buffer.write(sys.stdin.buffer.read().decode('utf8',errors='replace').encode('ascii',errors='backslashreplace'))" | \
     python "C:\Users\pedro\.claude\skills\trustbridge-route\references\tb_route.py" sol \
     "Review this diff for real defects only (lock discipline, races, i18n parity, protocol drift Go<->TS). file:line + concrete failure scenario, or NO DEFECTS FOUND." --stdin
   ```

   Fix any REAL confirmed findings (verify them against the code first — do
   not apply speculative fixes), rerun the gates, then commit.
5. Commit one commit per issue with a clear message. **Never push.**
6. **End with a compact report** (this is the only part a human reads):

   ```
   REPORT
   done: <one line per issue: what shipped>
   skills: spec-driven applied | hard-testing applied | evidence appended
   probe: <scenario file> -> PASS (red run captured first: yes/no)
   review: <vendor verdict + what you fixed>
   gates: web build EXIT:<n>, go test <pass/fail>, probe EXIT:<n>
   commits: <shortsha> <subject> (one per line)
   leftover: none   <- anything else means the run FAILED
   ```

## Environment notes

- Windows; bash available. `.env` exists at repo root but is not needed for
  builds or tests.
- Web assets are `go:embed`ed — the binary must be rebuilt to ship UI changes
  (the orchestrator handles deploys; you never run the server).
- `-race` is unavailable locally (no cgo); CI covers it.
