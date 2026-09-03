[sonnet -> claude-sonnet-5-1 via TrustBridge]
# Aposta Paralela (Side-Bet Overlay)

## Pitch (user language)
Enquanto assiste, qualquer um pode desafiar outro viewer: "Aposto que ele vai morrer nos próximos 30s" — aceita ou recusa, testemunhas assistem, o relay julga quando o publisher resolve com 👍/👎, placar de bets vencidas fica na beira.
(While watching, any viewer can challenge another: "I bet he'll die in the next 30s" — accept or decline, witnesses watch, relay judges when publisher resolves with 👍/👎, winning-bet scoreboard lives at the edge.)

## Why now
Brazilian watch-parties thrive on *secondary games layered over the primary content*—bolão proved viewers want structured side-action with stakes and bragging rights. Gaming streams (the dominant use-case post-suspension) produce natural bet moments ("vai pular essa parte?" / "consegue matar o boss?") but today those bets live only in voice, creating zero persistent hype and no comebacks later. A wire-observable, referee-gated bet system turns organic trash-talk into structured drama, gives quiet viewers a participation vector (witness a spicy 1v1 bet), and produces trophy-ceremony fodder. The companion-tab + Activity split is *perfect* for this: publisher stays in flow (bets happen viewer-side), then deliberately punctuates with a thumbs-up/down (natural streamer beat). No emoji-reaction overlap (bets are 1:1 challenges, not broadcasts), no Bolão overlap (predictions are everyone-on-prompt; bets are viewer-vs-viewer with custom terms).

## Scope
**In:** Two-party challenges (challenger → target, accept/decline/expire). Freeform pt-BR/en-US bet text (64 char, profanity filter reuses caption sanitizer). Publisher-only resolution (👍 challenger wins, 👎 target wins). Relay tracks per-user all-time win count, exposes top-3 leaderboard in a thin vertical bezel strip ("Apostadores da Rodada"). Bet lifecycle observable as discrete wire messages (challenge, accept, resolve, leaderboard_update). Bets die with the room (no DB, TTL in relay memory). Max 3 concurrent live bets per room (prevents spam).  
**Out:** Spectator voting on outcomes. Multi-party bets. Token/points economy. Bet history export. Publisher *creating* bets (they referee, viewers drive). UI over the video (leaderboard is bezel, challenge toasts are corner, resolution is publisher companion-tab button row).

## Implementation plan

1. **Wire protocol: `bet_challenge` client→relay→target.**  
   *Concern:* Target must be a current viewer (not the publisher, not offline).  
   **Verify:** Probe sends `bet_challenge{target_user_id, terms}` from clientA; assert clientB receives `bet_challenge_incoming{challenger_id, challenger_name, terms, challenge_id}`; assert clientC (publisher) receives `bet_announced{challenge_id, challenger_name, target_name, terms}` for witness awareness; assert reject if target == publisher or target not in roster or >3 live bets.

2. **Wire protocol: `bet_respond` (accept/decline) and 30s TTL expiry.**  
   *Concern:* Declined/expired challenges must broadcast so witnesses know the bet is dead.  
   **Verify:** Probe sends `bet_respond{challenge_id, accept: true}` from target; assert all clients receive `bet_active{challenge_id, challenger_name, target_name, terms, timestamp}`; probe waits 31s without response, assert all receive `bet_expired{challenge_id}`; probe sends `accept: false`, assert `bet_declined{challenge_id}`.

3. **Publisher resolution: companion tab button row, `bet_resolve` message.**  
   *Concern:* Only the publisher can resolve; must map challenge_id to outcome (challenger_wins: bool).  
   **Verify:** Probe registers publisher; sends `bet_active` state; publisher client (probe-controlled) sends `bet_resolve{challenge_id, challenger_wins: true}`; assert all clients receive `bet_resolved{challenge_id, winner_id, winner_name, loser_name, terms}`; probe sends resolve from non-publisher clientID, assert `error: not_publisher`.

4. **Relay-side win-count ledger (in-memory, per room) and leaderboard broadcast.**  
   *Concern:* Leaderboard must update atomically after each resolution and reflect top-3 across all past bets in the session.  
   **Verify:** Probe resolves betA (userX wins), then betB (userX wins), then betC (userY wins); assert final `leaderboard_update{entries: [{user_id: X, name: "…", wins: 2}, {user_id: Y, wins: 1}]}` sent to all clients; assert order is desc by wins.

5. **Activity UI: challenge modal (target picker + terms input) and accept/decline toast.**  
   *Concern:* Target picker must exclude publisher and self; terms input must apply the same sanitizer as Legenda.  
   **Verify:** Unit test `sanitizeBetTerms("Aposto que <script>alert(1)</script> vai")` returns stripped text; probe flow from step 1 end-to-end (clientA opens modal, picks clientB, submits) → clientB UI renders toast with Aceitar/Recusar buttons → click Aceitar → wire `bet_respond` fires.

6. **Publisher companion-tab resolution UI: live-bets card with 👍/👎 buttons per bet.**  
   *Concern:* Card must show all active bets (challenger vs target, terms) and disambiguate multiple simultaneous bets by challenge_id.  
   **Verify:** Probe establishes 2 concurrent active bets (betA: "Alice vs Bob 'vai morrer'", betB: "Carol vs Dave 'pula fase'"); publisher DOM query `[data-challenge-id="${betA.id}"] button[data-outcome="challenger"]` exists and onClick sends `bet_resolve{challenge_id: betA.id, challenger_wins: true}`; assert correct `bet_resolved` for betA, betB remains active.

7. **Activity bezel leaderboard strip: top-3 vertical pill, auto-hide when zero bets resolved.**  
   *Concern:* Strip must never overlap video (right bezel, 60px reserved in theater/fullscreen recalc) and fade in only after first resolution.  
   **Verify:** Probe starts room with zero resolutions; Activity `#leaderboard-strip` has `data-visible="false"` and CSS `opacity: 0`; probe resolves one bet; assert `data-visible="true"`, `opacity: 1`, and rendered list matches `leaderboard_update` payload from step 4.

8. **3-bet concurrency limit and challenge-spam backoff (3 per user per 60s).**  
   *Concern:* Relay must reject 4th concurrent bet and reject 4th challenge from one user within 60s.  
   **Verify:** Probe creates 3 active bets; probe sends 4th `bet_challenge` from clientA, assert `error: room_bet_limit`; probe sends 4 `bet_challenge` from clientA in <60s (first 3 accepted), assert 4th returns `error: rate_limit, retry_after: <seconds>`.

9. **Trophy-ceremony integration: "Apostador Raiz" award for most-wins if ≥3 bets resolved.**  
   *Concern:* Award must appear on the existing trophy page fetch and match the session's final leaderboard top entry.  
   **Verify:** Probe runs session, resolves 5 bets (userX wins 3), triggers trophy fetch (`GET /api/session/{id}/trophies`); assert JSON includes `{award: "apostador_raiz", user_id: X, user_name: "…", stat: "3 apostas ganhas"}`; probe session with <3 bets, assert award absent.

## Acceptance criteria
- AC1: Viewer Alice challenges viewer Bob with terms "vai morrer no chefão"; Bob's client shows toast with text + Aceitar/Recusar; Bob clicks Aceitar; all viewers see transient "Aposta rolando: Alice vs Bob" corner notification. *(Maps to probe steps 1, 2, 5.)*
- AC2: Publisher resolves bet in favor of Alice (👍 button in companion tab); all clients receive `bet_resolved` with Alice as winner; Alice's win-count increments in the leaderboard strip. *(Maps to probe steps 3, 4, 6, 7.)*
- AC3: Leaderboard strip shows top-3 correct order after mixed resolutions; strip is invisible until first bet resolves. *(Probe step 7.)*
- AC4: Fourth concurrent bet attempt returns error; fourth challenge from same user in 60s returns rate-limit error. *(Probe step 8.)*
- AC5: Trophy page includes "Apostador Raiz" award for session leader when ≥3 bets resolved. *(Probe step 9.)*
- AC6: Bet with `<script>` in terms is sanitized identically to Legenda input. *(Probe step 5 unit test.)*
- AC7: Challenger cannot target the publisher, themselves, or an offline user (relay rejects with specific error). *(Probe step 1.)*

## Risks
- **Toxicity spiral:** Bet terms could become hostile (mitigated: reuse Legenda's profanity filter; owner can add moderation dashboard later if needed).  
- **Publisher resolution friction:** If streamer ignores resolution requests, bets languish (mitigated: 5min auto-expiry after accept, though not in v1 scope—accepted risk for v1, can add if painful).  
- **Leaderboard noise:** In long sessions, one user could dominate and discourage others (mitigated: "da Rodada" framing implies session-scoped, trophy ceremony gives everyone a category).  
- **Concurrency edge-case:** Two users challenge each other simultaneously (accepted risk: both challenges can coexist as separate 1v1 bets; if confusing in practice, add mutual-exclusion in v2).

## Effort
**M** (Medium)  
- Protocol: 4 new message types (challenge, respond, resolve, leaderboard_update), ledger logic (~100 lines Go).  
- UI: challenge modal (target picker + input, ~80 lines SolidJS), accept/decline toast (reuse existing toast component), publisher resolution card (new companion-tab section, ~60 lines), bezel leaderboard strip (~40 lines + CSS).  
- Integration: trophy ceremony query join (~20 lines), sanitizer reuse (trivial).  
- Test surface: 9 probe scenarios, 1 unit test, 7 acceptance e2e checks.  
- Total estimate: ~3 eng-days (1 day protocol + relay, 1.5 days UI, 0.5 day probe harness scenarios).
