# Skill: spec-driven delivery

Load this before writing any code. It exists because past runs shipped
features that compiled, passed unit tests, and did not work.

## The order of work is fixed

1. **Read the whole issue.** List its acceptance criteria verbatim at the top
   of your working notes. Everything below serves them.
2. **Trace the wire first.** Before implementing, write down the full path a
   message takes: UI event → Session method → `sendControl` → server dispatch
   switch (`internal/server/server.go`) → Room method under `Room.mu` →
   broadcast → client `handleControl` case → signal → UI. **Every hop must be
   named with file:function.** The single most common defect in this repo has
   been a missing hop (a control type the server never dispatched), invisible
   to unit tests on either side.
3. **Write the failing proof first.** Before the feature: a probe scenario in
   `tools/probe/scenarios/` (see `hard-testing.md`) that exercises the wire
   path end-to-end and FAILS. Run it, paste the failure into your notes. Only
   then implement.
4. **Implement hop by hop**, re-running the probe until it passes.
5. **No placeholders, ever.** If a sub-problem is too hard to do properly in
   this run (a real container muxer, a real codec parse), you MUST NOT ship a
   fake that produces plausible-looking but broken output. Stop, write the
   blocker into the REPORT's leftover, and leave the feature un-wired rather
   than wired to a lie. A placeholder labeled "done" is the worst outcome
   this pipeline knows.

## Definition of done (all of these, no exceptions)

- Every acceptance criterion has either a probe scenario or a Go/TS test
  named next to it in the EVIDENCE section.
- The wire trace in your notes has zero unimplemented hops.
- Both gates pass with real exit codes.
- The cross-vendor self-review found no real defects (or they are fixed).
- EVIDENCE section appended to the issue file (see `evidence.md`).

## UI changes carry extra proof

Compiling is not evidence for UI. For any change to what renders:
- State which existing UI elements share the region you touched and confirm
  each still renders under its `Show`/route condition (list the conditions).
- Never gate a primary action behind a capability flag without reading how
  the flag behaves INSIDE Discord's iframe (e.g. `captureAllowed()` is false
  there by design — the companion tab exists because of it).
- If you removed or replaced a JSX block, diff it against `git show
  HEAD:<file>` and account for every interactive element that existed in the
  old block: button, input, handler. Each one either survives or its removal
  is called out in the REPORT.
