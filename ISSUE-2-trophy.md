title: Entrega de Troféu — end-of-session crayon award ceremony
pitch: Quando a transmissão acaba, o JanjaCast entrega os troféus da noite — Mais Barulhento, Maratonista, Fantasma — numa página de crayon que dura 60 minutos e vira print no chat do grupo.
effort: S
author: claude-sonnet-5-1 via TrustBridge

## Pitch (user language)

When the stream ends, everyone gets a link to a crayon award page: auto-assigned superlatives like "Mais Barulhento 📢" (most stinger plays), "Maratonista 🏃" (longest watch), "Fantasma 👻" (joined last), "Fiel 💙" (never dropped). It lives for 60 minutes — long enough to screenshot and feed the group chat for days.

## Why now

The end-of-night "quem foi o mais…" recap already happens organically in Brazilian voice calls; this turns it into a shareable artifact that closes the session like a post-game lobby. It builds entirely on data the relay already sees (join times, connection lifetimes, stinger plays) and the ephemeral-by-design philosophy — memory + TTL, no database.

## Scope

- On stage end (`LeaveStage` or publisher disconnect) with ≥4 distinct session participants, the relay assembles award data and the server stores it in memory under a random UUID with a 60-minute TTL.
- Five fixed categories, auto-assigned, ties broken alphabetically, vacant categories omitted:
  - **Anfitrião 🏠** — the sharer. **Maratonista 🏃** — longest total watch time. **Fantasma 👻** — latest first-join. **Fiel 💙** — zero disconnects. **Mais Barulhento 📢** — most stinger plays.
- Every Activity gets a dismissible toast: "Sessão encerrada! Ver troféus" → opens `/awards/{uuid}?lang=<locale>` in a new tab (public origin, like the companion tab).
- Server-rendered Go-template HTML page, crayon poster aesthetic, screenshot-optimized (~800px), with a "tira um print" hint. Expired links render a small crayon "Troféus expiraram" page.

## Non-goals

- No database, no history, no per-server aggregation (that is the future "Memória da Turma" — explicitly deferred until demand is proven).
- No voting, custom categories, or user-submitted awards.
- No auto-posting to Discord channels (no bot/webhook dependency); humans screenshot — that IS the sharing model.
- No confetti/animation on the page; static, print-friendly.
- No awards under 4 participants (a 2-person ceremony is cringe, per the critique round).
- No auth on the page beyond the unguessable UUID (same bearer-secret stance as room ids in README).

## Implementation plan

1. **Session stats tracking — `internal/relay/relay.go`.**
   Under `r.mu`, add `sessionStats map[string]*ParticipantStats` with `{UserID, Username string; FirstJoin time.Time; lastJoin time.Time; TotalWatch time.Duration; StingerPlays, Disconnects int}`. `Hub.Join`: create on first sight (set `FirstJoin`), else stamp `lastJoin` and increment `Disconnects`. `Hub.Leave`: fold `time.Since(lastJoin)` into `TotalWatch`. `PlayStinger`: increment the caller's `StingerPlays` (hooking the existing cooldown-guarded success path).
   **Verify:** test in `internal/relay/relay_test.go`: join 10s, leave, rejoin 5s → `TotalWatch≈15s`, `Disconnects==1`, `FirstJoin` unchanged; stinger play increments.

2. **Award assembly — new file `internal/relay/awards.go`.**
   `type AwardData struct{ Category, UserID, Username, Value string }`; `(r *Room) assembleAwardsLocked() []AwardData` — nil if fewer than 4 entries in `sessionStats`. Categories: `host` (publisher), `marathon` (max TotalWatch, value "47m"), `ghost` (max FirstJoin), `faithful` (Disconnects==0, longest watch wins ties), `loudest` (max StingerPlays, >0 required, value "23"). Ties alphabetical; vacant → omitted; values preformatted (units like "min" stay untranslated per docs/i18n.md).
   **Verify:** table-driven test with crafted stats hits every category, tie, and vacancy branch.

3. **Award publication hook — `internal/relay/relay.go` + `internal/protocol/protocol.go`.**
   Add `CtrlAwardsReady` (`AwardsReadyData{SessionID string}`) to the protocol. Give `Room` an `OnAwards func(sessionID string, awards []AwardData)` callback (set by the server at room creation, mirroring how stinger config flows in). In `LeaveStage` (and the disconnect path that clears the publisher), assemble; if non-nil: generate UUID, invoke callback, then `broadcast` `CtrlAwardsReady` to the room.
   **Verify:** test: 4 participants, publisher leaves → callback fired once with 1–5 awards; every client got `CtrlAwardsReady`; 3 participants → nothing.

4. **TTL store — `internal/server/awards.go` (new file, `stingers.go` as the structural precedent).**
   `awardStore` around a `sync.Map` keyed by sessionID → `{createdAt, awards}`; `Get` checks 60-min TTL; a janitor goroutine sweeps every 10 min. Wire the room callback in `internal/server/server.go` where rooms are created.
   **Verify:** unit test with injected clock: fresh hit, 61-min miss, janitor removes.

5. **Award page endpoint — `internal/server/awards.go`.**
   `GET /awards/{sessionID}` on the public mux (reachable outside the Discord proxy, like `/share`). Locale from `?lang=` (`pt*` → pt-BR, else en — same normalization contract as the client). Render `//go:embed`-ed `awards.tmpl.html`; unknown/expired IDs render the embedded expired page with HTTP 404.
   **Verify:** `curl localhost:8080/awards/bogus` → 404 expired page; a stored ID renders HTML with all award rows.

6. **Templates — `internal/server/awards.tmpl.html` + `awards_expired.tmpl.html`.**
   Self-contained HTML (inline CSS only — the page must not depend on the client bundle): ~800px poster, paper ground, wobbly borders, big hand-style title "Troféus da Sessão 🏆", one card per award (icon, category name, recipient, one-line description, value), footer "JanjaCast • {date}" and the screenshot hint. All copy exists in both languages inside the template, switched by the locale value (server-rendered pages cannot reach `web/src/i18n.ts`; this page is the documented exception, with copy register still following docs/i18n.md — e.g. "Ficou até o fim sem desgrugar" style descriptions, full sentences).
   pt-BR strings: Anfitrião/"Compartilhou a tela pra galera"; Maratonista/"Ficou até o fim sem desgrudar"; Fantasma/"Chegou por último, chegando"; Fiel/"Não caiu da call nem uma vez"; Mais Barulhento/"Tocou stinger que só"; hint "📸 Tira um print e joga no chat!"; expired "Esses troféus já foram pro baú — eles expiram depois de 60 minutos."
   en strings: Host/"Shared their screen with the crew"; Marathoner/"Stayed glued to the very end"; Ghost/"Arrived fashionably late"; Faithful/"Never dropped, not once"; Loudest/"Played stingers like it was a job"; hint "📸 Screenshot it and drop it in the chat!"; expired "These trophies are in the vault — they expire after 60 minutes."
   **Verify:** render with mock data in both locales; screenshot at 800px reads clean; expired page renders.

7. **Client protocol + toast — `web/src/protocol.ts`, `web/src/session.ts`, `web/src/App.tsx`.**
   Mirror `CtrlAwardsReady`; store `awardsSessionID` in session state. In App, when it lands, show a persistent dismissible toast (crayon card, top-center, `--yellow` ground, `--wobble-a`, X doodle to dismiss): text `awards.ready`, button `awards.view` opening `` `${publicOrigin}/awards/${id}?lang=${locale}` `` via the same new-tab mechanism `openCompanion()` uses (the Activity iframe cannot navigate itself; the companion-tab opener is the precedent, including the `?lang=` handoff).
   **Verify:** two windows: end a ≥4-user session → toast in both; click → page opens in a real tab in the right language; X dismisses without reappearing.

8. **i18n — `web/src/i18n.ts`** (`awards.*`, both dictionaries — Activity-side strings only; the page itself is templated):
   - `awards.ready` en "That's a wrap! The trophy ceremony is ready." / pt "Acabou! A entrega de troféus tá pronta."
   - `awards.view` en "See the trophies" / pt "Ver os troféus".
   - `awards.dismiss` aria-label en "Dismiss" / pt "Fechar" (accessibility layer stays literal).
   **Verify:** `make all`; toast fits at 440px in pt-BR.

9. **Icons + styling — `web/src/doodles.tsx`, `web/src/theme.css`.**
   `TrophyDoodle` (lopsided cup, one fat handle bigger than the other, house rules) for the toast; `.awards-toast` classes from existing tokens only.
   **Verify:** legible at 20px; visual pass both grounds.

10. **Relay + server tests.**
    `internal/relay/relay_test.go`: stats accumulation, threshold, tie-breaks, vacancy, broadcast. `internal/server/` tests: store TTL, endpoint 200/404, locale switch.
    **Verify:** `go test ./... -run 'Award|Trofeu'` green alongside the full suite.

11. **Manual E2E.**
    `JANJACAST_ALLOW_ANON=1 ./janjacast`, 5 windows at `?room=demo&lang=pt` with scripted behavior (one late joiner, one rejoiner, one stinger-spammer). End the stage → toast everywhere → page shows the right five names → mock the clock → expired page. Repeat headline flow in `&lang=en`.
    **Verify:** award attribution matches the scripted behavior exactly; screenshot quality is share-worthy.

## Acceptance criteria

- [ ] Ending a session with ≥4 distinct participants produces an award page; <4 produces nothing (no toast, no page).
- [ ] The five categories assign from real tracked stats; ties alphabetical; vacant categories (e.g. zero stinger plays) omitted; Anfitrião always present.
- [ ] Every Activity receives `CtrlAwardsReady` and shows a dismissible toast that opens `/awards/{uuid}?lang=<locale>` in a real browser tab.
- [ ] The page renders server-side in en or pt-BR from `?lang=`, self-contained (no client-bundle dependency), crayon poster style, screenshot-clean at ~800px.
- [ ] Links expire after 60 minutes → crayon 404 page; janitor prevents unbounded memory growth.
- [ ] No database anywhere; a relay restart forgets everything (by design).
- [ ] Stats survive reconnects correctly (watch time accumulates, disconnect count increments, first-join preserved).
- [ ] Activity strings in en + pt-BR (build-enforced); template copy in both languages with docs/i18n.md register.
- [ ] `go test ./...` green including new award tests; manual 5-window E2E attributes every trophy correctly.

## Risks & guardrails

- **"Fantasma" lands mean** → all copy is affectionate zoeira, not ranking; categories celebrate presence, and the whole page dies in 60 minutes — a joke, not a record.
- **Stat gaming (stinger spam for Barulhento)** → the existing 3s soundboard cooldown already caps it; winning by playing memes is the intended joke anyway.
- **Memory growth** → one small struct per session, 60-min TTL, 10-min janitor.
- **Link leakage** → 128-bit UUID, unlisted, expiring; same bearer-secret posture the README applies to room ids.
- **Localization drift** (template vs client dictionaries) → the template carries only its own page copy; the shared terminology table in docs/i18n.md is the single reference for both.

## Effort

**S** — stat counters on existing hooks, one pure assembly function, a TTL map, one embedded template, one toast. No new realtime surface. ~1–2 days.
