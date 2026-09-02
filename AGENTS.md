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

## Working protocol (agentic runs)

1. **Never end your run with a text-only reply while work remains** — a
   text-only reply terminates the run. Keep calling tools until the final
   commit exists. Do not ask for permission mid-run; you already have it.
2. Implement the issue file(s) in the repo root (`ISSUE*.md`) step by step,
   running each step's Verify.
3. **Gates before committing** (check REAL exit codes — piped output masks
   them):
   - `cd web && JANJACAST_DISCORD_CLIENT_ID=1544440867799048253 npm run build`
     → must exit 0
   - `go vet ./... && go test ./...` from the repo root → must pass
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
   review: <vendor verdict + what you fixed>
   gates: web build EXIT:<n>, go test <pass/fail>
   commits: <shortsha> <subject> (one per line)
   leftover: <anything not done, or "none">
   ```

## Environment notes

- Windows; bash available. `.env` exists at repo root but is not needed for
  builds or tests.
- Web assets are `go:embed`ed — the binary must be rebuilt to ship UI changes
  (the orchestrator handles deploys; you never run the server).
- `-race` is unavailable locally (no cgo); CI covers it.
