title: Placar Ao Vivo — the group's hand-drawn scoreboard
pitch: Quem transmite cria um placar ("quantas vezes o Zé falou 'tipo'?") e todo mundo dá +1/−1 em qualquer um da sala — um ranking de crayon na margem, ao vivo, que morre com a sessão.
effort: S
author: claude-sonnet-5-1 via TrustBridge

## Pitch (user language)

The sharer creates a tally board — "o que vamos contar?" — and everyone can +1 or −1 any participant in real time; a live crayon leaderboard sits in the margin, updating as votes land. It's the group's source of truth for trash talk, and it's gone when the stream ends.

## Why now

Brazilian friend-groups turn everything into a competition ("quem riu mais", "quem bugou a call"), and with Go Live gone these rooms are where game nights live. Perfectly ephemeral — no database, pure `Room` state — and it reuses the relay's room-state broadcast pattern plus the margin UI language (`.stat-pill`, roster rows) that already exists.

## Scope

- Publisher creates the tally from the companion tab: modal asking "O que vamos contar?" (≤60 chars) → leaderboard appears for everyone.
- One tally per room; scores start at 0 for every current member; joiners are added at 0.
- Any participant can +1/−1 any participant (self included); ±1 only; scores may go negative.
- Mutations throttled to 1/s per user (relay-enforced, client-debounced).
- Rows sort by score desc, ties share a rank and sort alphabetically; your own row is tinted.
- Publisher can close the tally; it also dies when the publisher leaves the stage or the room empties.
- Late joiners get the current tally in the welcome sequence.

## Non-goals

- No persistence, history, or export (screenshot the Activity — that's the feature).
- No multiple simultaneous tallies, no editing a live prompt (close and recreate).
- No vote attribution ("who voted") — aggregate only.
- No milestone animations/confetti; numbers just tick.
- No configurable increments, no hiding participants, no database.

## Implementation plan

1. **Wire protocol types — `internal/protocol/protocol.go`.**
   Client→server: `CtrlPlacarCreate` (`PlacarCreateData{Prompt string}`), `CtrlPlacarVote` (`PlacarVoteData{TargetUserID string; Delta int}`), `CtrlPlacarClose` (no payload). Server→client: `CtrlPlacarState` (`PlacarStateData{Active bool; Prompt string; Scores map[string]int}`).
   **Verify:** `go build ./internal/protocol/`.

2. **Room state — `internal/relay/relay.go`.**
   Under `r.mu`: `placarActive bool`, `placarPrompt string`, `placarScores map[string]int`, `placarLastVote map[string]time.Time`. Helpers `placarStateLocked()` (copies the map) and `broadcastPlacarStateLocked()` modeled on `broadcastRoomStateLocked`.
   **Verify:** `go build ./internal/relay/`; fresh room reports inactive.

3. **Create — `internal/relay/relay.go`.**
   `CreatePlacar(c *Client, prompt string) error`: publisher-only, no tally already active, prompt 1–60 chars; seed every current member at 0; broadcast.
   **Verify:** test: publisher + 2 viewers, create → broadcast has Active true and 3 zeroed entries; second create errors `placar.alreadyActive`.

4. **Vote — `internal/relay/relay.go`.**
   `PlacarVote(c *Client, target string, delta int) error`: tally active, delta ∈ {+1,−1}, target present in `placarScores`, ≥1s since `c`'s last vote; apply, stamp, broadcast. (Same throttle shape as the stinger cooldown.)
   **Verify:** test: vote applies and broadcasts; immediate second vote errors `placar.tooFast`; after 1s it lands; −1 three times → −3.

5. **Close + lifecycle — `internal/relay/relay.go`.**
   `ClosePlacar(c *Client) error` publisher-only. Auto-clear inside `LeaveStage` (publisher gone → tally gone) and when the room empties in `Hub.Leave`. New member in `Hub.Join` while active → seeded at 0 + state broadcast.
   **Verify:** tests: close clears and broadcasts; publisher leaving stage clears; joiner mid-tally appears at 0 for everyone.

6. **Dispatch — `internal/server/server.go`.**
   Three cases in the control switch; failures answer `CtrlError` with `placar.*` keys.
   **Verify:** `go test ./internal/server/`.

7. **Welcome sequence — `internal/relay/relay.go`.**
   In `Hub.Join`, after `c.enqueueControl(protocol.CtrlWelcome, …)`, enqueue `CtrlPlacarState`.
   **Verify:** test: joiner after votes receives current prompt + scores.

8. **Client protocol mirror — `web/src/protocol.ts`.**
   Mirror the four controls and data interfaces (`scores: Record<string, number>`).
   **Verify:** `cd web && npm run build`.

9. **Session state — `web/src/session.ts`.**
   Add `placarActive`, `placarPrompt`, `placarScores`; handle `CtrlPlacarState` as a batch replace.
   **Verify:** two windows: create in one → both consoles show active state.

10. **Create/close controls — `web/src/SharePage.tsx`.**
    A `.crayon-btn` "Criar placar" (swaps to "Fechar placar" when active). Create opens a `.modal-scrim`/`.modal-card` modal: label "O que vamos contar?", text input (maxlength 60, autofocus, live "{n}/60" counter in `--font-num`), actions "Criar" (disabled while empty) / "Deixa pra lá" (the house cancel verb — takeover-modal precedent).
    **Verify:** create → modal closes, leaderboard appears everywhere; close → it disappears.

11. **Leaderboard — `web/src/App.tsx`.**
    When active, a margin panel below the roster (peer of the queue/roster furniture, never over the stage): prompt as title, then rows — rank, name (ellipsized like roster names), score in `--font-num`, and two icon buttons (+/− doodles). Sort memoized: score desc, then name; tied scores share a rank number. Own row washed with `--hover-wash`. Buttons ≥24×24.
    **Verify:** two windows: +1 someone → both reorder identically; tie shows "1, 1, 3" ranking.

12. **Client-side vote debounce — `web/src/App.tsx`.**
    Disable both buttons on a row's click for 1s (matching the relay throttle) instead of toasting on every tap; if the relay still rejects, show the glyph-led error line.
    **Verify:** rapid clicking sends at most 1/s; no error spam in normal use.

13. **i18n — `web/src/i18n.ts`** (`placar.*`, both dictionaries):
    - `placar.create` en "Create scoreboard" / pt "Criar placar"; `placar.close` en "Close scoreboard" / pt "Fechar placar".
    - `placar.modalTitle` en "What are we counting?" / pt "O que vamos contar?"
    - `placar.placeholder` en "e.g. times someone said 'like'" / pt "ex: vezes que alguém falou 'tipo'".
    - `placar.createBtn` en "Create" / pt "Criar"; `placar.cancel` en "Never mind" / pt "Deixa pra lá".
    - `placar.charCount` en/pt "{count}/60" (shared shape, still two entries — never concatenate).
    - `placar.plus` / `placar.minus` aria-labels en "Add a point for {name}" / pt "Dar um ponto pra {name}", en "Take a point from {name}" / pt "Tirar um ponto de {name}" (accessibility layer stays literal).
    - `error.placar.alreadyActive` en "⛔ A scoreboard is already running — close it first." / pt "⛔ Já tem um placar rolando — fecha ele primeiro."
    - `error.placar.tooFast` en "⛔ One point per second — easy!" / pt "⛔ Um ponto por segundo — calma!"
    - `error.placar.notPublisher` en "⛔ Only the person sharing can do that." / pt "⛔ Só quem tá transmitindo pode fazer isso."
    **Verify:** `make all`; 60-char prompt wraps gracefully at 440px in both languages.

14. **Icons — `web/src/doodles.tsx`.**
    `PlusDoodle` (chunky uneven cross), `MinusDoodle` (single fat bar), `TallyDoodle` (four strokes and a diagonal — the universal tally mark, very crayon) per house rules.
    **Verify:** legible at 16px, aria-hidden.

15. **Styling — `web/src/theme.css`.**
    `.placar-panel`, `.placar-row`, `.placar-rank`, `.placar-score`, `.placar-btn` from existing tokens (`--surface`, `--text`, `--muted`, `--crayon-blue` for the score, `--yellow` wash for the leader row, `--wobble-sm`, `--shadow-ink`). Wobbly hand-drawn row separators consistent with the roster.
    **Verify:** visual pass both grounds; panel fits the margin at 440px without pushing the stage.

16. **Relay tests — `internal/relay/relay_test.go`.**
    Full cycle (create → vote → close); throttle; late joiner; mid-tally join seeds 0; negative scores; publisher-leave clears; non-publisher close rejected.
    **Verify:** `go test ./internal/relay/ -v -run Placar`.

17. **Manual E2E.**
    `JANJACAST_ALLOW_ANON=1 ./janjacast`, 4 windows at `?room=demo&lang=pt` (repeat key flows in `&lang=en`): create, cross-vote, tie, negative, throttle, late join, close, recreate, publisher-leave.
    **Verify:** scores identical in all windows at every step; 440px clean.

## Acceptance criteria

- [ ] Publisher creates a ≤60-char tally from the companion tab; leaderboard appears in every Activity's margin.
- [ ] Every participant (joiners included, seeded at 0) is a row; anyone can ±1 anyone; scores go negative.
- [ ] Relay enforces publisher-only create/close, ±1 deltas, membership, and a 1 vote/s/user throttle; client debounces to match.
- [ ] Rows sort score-desc with shared ranks on ties then alphabetical; own row tinted; leader row highlighted.
- [ ] Late joiners see the live tally immediately after welcome.
- [ ] Tally dies on close, publisher leaving the stage, or room emptying — and never survives a relay restart (by design).
- [ ] All strings in en + pt-BR (build-enforced), register per docs/i18n.md ("Deixa pra lá" as the cancel), no overflow at 440px.
- [ ] `go test ./internal/relay/ -run Placar` green; manual 4-window E2E passes.

## Risks & guardrails

- **Downvote pile-ons** → ephemeral scores, no vote attribution, and the publisher can close a sour tally instantly; the prompt itself frames the game, and the sharer authors it.
- **Vote flooding** → double throttle (client debounce + relay rejection): worst case is room-size messages/second, trivial for the relay.
- **Margin crowding** (roster + queue + placar) → each is a collapsible peer panel; placar is compact (`--wobble-sm`, single-line rows).
- **Prompt abuse** → 60-char cap, plain text rendering (no markup), publisher-only authorship.

## Effort

**S** — one broadcast state map, three controls, one margin panel; every pattern already exists in the codebase. ~1–2 days.
