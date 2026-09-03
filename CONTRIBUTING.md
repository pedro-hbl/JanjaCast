<h1 align="center">
  <img src="docs/lockup.svg" alt="JanjaCast" width="280">
</h1>

# Contributing to JanjaCast

Thanks for helping build the crayon-powered livestream Activity.

## Dev Setup

- Requirements: Go 1.26+, Node 20/22/24+, a recent Chromium.
- One-time installs:
  - `cd web && npm ci`
  - `cd tools/probe && npm install` (wire-level probe harness)

Local run:

```sh
go run ./cmd/janjacast            # API + relay on :8080
cd web && npm run dev             # Vite on :5173, proxies /api and /ws
```

## Gates (must pass before commit)

Run from the repo root. Real exit codes matter (don’t pipe):

1) Web build embeds into the binary:

```sh
cd web && JANJACAST_DISCORD_CLIENT_ID=1544440867799048253 npm run build
```

2) Go vet + tests:

```sh
go vet ./... && go test ./...
```

3) Wire probes (boots the real server and exercises the protocol):

```sh
node tools/probe/harness.js --scenario tools/probe/scenarios/<feature>.js
```

For hygiene PRs, run at least:

```sh
node tools/probe/harness.js --scenario tools/probe/scenarios/slots_seam4.js
node tools/probe/harness.js --scenario tools/probe/scenarios/fila.js
```

## Seam/Probe Philosophy

- Spec-driven: write a failing probe (RED) that proves the behavior at the wire, then implement to turn it GREEN. Never delete or weaken a legacy probe until its replacement seam is live and green.
- Dispatch coverage: keep the `tools/probe` scenarios covering every control path; add scenarios when you add a hop.
- Guards in tests: `TestDispatchCoverage` and `TestNoRawRuntimeTimers` must stay green.

## Commit Style

- Follow the existing `git log` tone: complete sentences, explain the “why”, no changelog noise. One focused commit per issue.

## Docs and Skills

- Read `AGENTS.md` for the working protocol used in this repo.
- The engineering skills that guide probes and seams live under `agents/skills/` — skim them before larger changes.

## i18n and UI Notes

- All user-facing strings go through `t()` with both `en` and `pt-BR` entries.
- Respect the crayon design language (`docs/design.md`); nothing renders over the center stage safe-zone.
