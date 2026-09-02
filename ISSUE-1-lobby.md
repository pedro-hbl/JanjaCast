title: Sala Sempre Aberta — Persistent Room + Ambient Presence
pitch: The room doesn't "end" when nobody is streaming — it stays warm as a lobby showing who's around the unlit crayon TV, with one gentle "acender a TV" nudge to whoever feels like sharing.
effort: S
author: claude-opus-5 via TrustBridge

# Sala Sempre Aberta — Persistent Room + Ambient Presence

## Pitch
A sala não "acaba" quando ninguém tá transmitindo — ela fica quentinha, mostrando quem tá por ali na TV de giz apagada. Quando bate a vontade, um empurrão gentil sugere "acender a TV" e começar a transmitir.

## Why now
Right now the Activity is a session: no stream, nothing to see, everyone leaves. To become the place Brazilian friend-groups hang out during the official-screen-share blackout, the room has to be a *place* that persists between streams. We already have a people-not-connections presence roster and an idle launch scene (the crayon TV in a field) — this promotes them into a warm lobby with almost no new infrastructure. This is the tool→institution bet.

## Scope / Non-goals
**In:** a room lobby state whenever no one is publishing (idle crayon-TV scene + presence roster of who's around + live people count), an "acender a TV" CTA that runs the existing take-the-stage flow, and correct lobby↔live transitions for everyone including late-joiners.
**Non-goals:** no persistence of room state across relay restarts, no scheduled events, no room-owner roles beyond the existing publisher model, no text chat, no "poke a specific person to share" targeting.

## Implementation plan

### Step 1 — Protocol: room phase
In `internal/protocol/protocol.go` add `CtrlRoomPhase` (relay→clients: `RoomPhaseData{Phase string}` with values `"lobby"` and `"live"`), and add `Phase string` to `StageStateData` so the current phase rides the existing `CtrlWelcome` handshake (WelcomeData embeds StageStateData — a joining client never guesses). Mirror in `web/src/protocol.ts` with a `RoomPhase = "lobby" | "live"` union.
**Verification:** `go test ./internal/protocol/...`; a round-trip test asserts both phase values serialize and that `Phase` appears in `WelcomeData`.

### Step 2 — Relay: derive and broadcast phase
In `internal/relay/relay.go`, derive phase from publisher presence under `Room.mu`: `"live"` when there is an active publisher, `"lobby"` otherwise. On both transitions (publisher takes the stage / publisher leaves or disconnects — the same paths the session-takeover cleanup already handles), fan `CtrlRoomPhase` to all clients, and always fold current phase into the welcome.
**Verification:** in `internal/relay/relay_test.go` add `TestRoomPhaseTransitions`: join two clients with no publisher, assert both hold `phase:"lobby"`; a publisher takes the stage, assert both receive `phase:"live"`; the publisher disconnects, assert both receive `phase:"lobby"` and no ghost roster entry remains (reuse the existing ghost-entry assertions).

### Step 3 — i18n keys for the lobby
In `web/src/i18n.ts` add:
- `lobby.title` — en: `"The TV's off"`, pt-BR: `"A TV tá apagada"`
- `lobby.subtitle` — en: `"Nobody's sharing yet"`, pt-BR: `"Ninguém tá transmitindo ainda"`
- `lobby.cta` — en: `"Turn on the TV"`, pt-BR: `"Acender a TV"`
- `lobby.here` — plural message; en: one `"{count} person here"` / other `"{count} people here"`, pt-BR: one `"{count} pessoa por aqui"` / other `"{count} pessoas por aqui"` (CLDR `pt` puts 0..1 in `one` — use the plural machinery, never a shared prefix)
- `lobby.alone` — en: `"Just you for now"`, pt-BR: `"Só você por enquanto"`
Note the register: the lobby is the app narrating room state back to you, which is exactly where docs/i18n.md licenses "tá".
**Verification:** `cd web && npx tsc --noEmit` compiles; render with count 0/1/2 and confirm correct plural selection in both languages; check the longest pt-BR strings at 440px on the Activity ground.

### Step 4 — Lobby scene component
Create `web/src/lobby.tsx` exporting `<Lobby/>`: reuses the launch scene's crayon-TV drawing from `doodles.tsx` in an "unlit" variant, shows `lobby.title`/`lobby.subtitle`, the present-people count via `lobby.here`/`lobby.alone` driven by the existing presence roster state, and exactly one CTA (`lobby.cta`) that invokes the existing take-the-stage flow (the same `openCompanion()` path as today's Share screen CTA). Zero-decision: one CTA, no settings, no extra chrome.
**Verification:** `npx tsc --noEmit`; in the two-window flow with a mocked/empty stage, confirm the lobby renders "2 pessoas por aqui" with both windows open and exactly one visible CTA.

### Step 5 — Wire phase into App
In `web/src/App.tsx`, read the phase from `session.ts`. When `"lobby"`, render `<Lobby/>` in place of the stage; when `"live"`, render the stage as today. The presence roster stays visible in both phases (people-not-connections). The transition must not tear down the WS session or the roster.
**Verification:** two-window flow (`JANJACAST_ALLOW_ANON=1 ./janjacast`, `http://localhost:8080/?room=demo`): both windows show the lobby with the correct count; start sharing from one, both flip to the live stage; stop, both flip back to the lobby over the same WS connection (devtools: no reconnect).

### Step 6 — Ambient nudge, not a targeted poke
In `<Lobby/>`, every present viewer sees the same primary "Acender a TV" CTA — the nudge is ambient, never aimed at a person. If the environment cannot start a companion capture (e.g. embedded contexts where the flow is unavailable), de-emphasize the CTA and keep the subtitle as the explanation; do not add a second control.
**Verification:** two-window flow; confirm both windows show the CTA, either can start a stream, and the room transitions to live for all.

## Acceptance criteria
- With no publisher, all viewers in a room see the unlit crayon-TV lobby with a live count of who's around.
- The count uses correct singular/plural in both EN and PT and shows "Só você por enquanto" / "Just you for now" when alone.
- Any present viewer can hit "Acender a TV" and transition the whole room to live.
- Publisher stop or disconnect returns everyone to the lobby with no ghost roster entries and no WS reconnect.
- A client joining an empty room lands directly in the lobby (phase carried in the welcome handshake).
- The lobby has exactly one CTA and no settings.

## Risks & guardrails
- **Ghost entries on transition:** phase transitions reuse the existing session-takeover cleanup; `TestRoomPhaseTransitions` asserts no ghost entry after publisher disconnect.
- **Idle rooms consuming resources:** a lobby room holds only presence + WS state — no media, no GOP cache while idle, no new timers or persistence; an idle room costs what an idle connected client already costs the single binary.
- **State drift on reconnect:** phase always rides `CtrlWelcome`, so a late or reconnecting client never guesses — asserted in Step 2's test and Step 5's no-reconnect check.
- **Zero-decision creep:** one CTA, no settings, ambient nudge only — no per-person poke, preserving the one-publisher model and the launch scene's philosophy.

## Effort: S
