# Skill: the evidence contract

A feature does not exist until it is proven on the wire. Before the final
commit of an issue, append an `## EVIDENCE` section to the issue file itself
(it is committed with the feature) containing:

1. **Wire trace** — the hop list from `spec-driven.md`, each hop as
   `file:function`, all checked off.
2. **Probe transcript** — the output of every probe scenario for this issue,
   pasted verbatim (they print a transcript and exit 0/1; include the exit
   code line). A scenario that was green before your change and green after
   is not evidence — the scenario must fail without your feature commit
   (state the commit you verified that against, or show the initial failing
   run from step 3 of spec-driven).
3. **Gate lines** — the last 3 lines of `npm run build` and of
   `go test ./...`, plus their real exit codes (`echo EXIT:$?` on the next
   line — piped output masks codes).
4. **Review verdict** — which vendor reviewed the diff, the verdict, and
   what you changed in response (or "no real findings").
5. **Per-criterion map** — each acceptance criterion → the scenario/test
   name that proves it. A criterion with no proof line means the run is NOT
   done; either prove it or move it to leftover with a reason.

Rules:
- Evidence is output you actually captured this run. Never retype, summarize,
  or reconstruct it from memory — copy it.
- If any evidence item cannot be produced, the REPORT's leftover must say so
  explicitly. Silence about a gap is treated as a fabricated claim.
