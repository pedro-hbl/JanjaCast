[sonnet -> claude-sonnet-5-1 via TrustBridge]
# Issue: Telinha — synchronized companion mini-player for co-commentary

**Title:**  
Telinha — synchronized companion mini-player for co-commentary

**Pitch (user language):**  
Abra uma "telinha" sincronizada no seu navegador enquanto assiste no Discord — você vê a mesma transmissão atrasada uns segundos, perfeita pra comentar no microfone sem eco ou pra gravar react sem piratear a tela do Discord.  
Perfect for Brazilian "react" culture: watch the stream in your real browser tab while talking over voice, or capture your own reaction content without fighting Discord's iframe CSP.

---

## Why now

1. **React culture is massive in Brazilian gaming/streaming communities** — friends *constantly* want to record themselves reacting to someone else's gameplay or watch-party screen, but Discord Activities run in an iframe that can't be captured cleanly by OBS/screen-record without grabbing the whole Discord window (UI chrome, chat, notifications).  
2. **Commentary echo hell:** when a viewer wants to talk over what they're watching (live sports commentary style, or just loud friends), their mic picks up their own desktop audio from the Activity, creating feedback loops unless they mute — killing the spontaneous "narração ao vivo" vibe that makes these sessions fun.  
3. **The companion tab architecture already exists** — we have the two-surface pattern; adding a viewer-side companion option is architecturally natural and reuses the relay fan-out with a deliberately introduced offset.

---

## Scope / Non-goals

**In scope:**  
- One-click "Abrir telinha" button in the Activity viewer UI that launches a minimal companion player (same relay session, same decode pipeline, **+2-4s deliberate delay** vs. Activity feed).  
- Telinha runs in a pop-up or regular tab: clean `<video>`-like canvas, zero Discord chrome, OBS-friendly; shows stream title + "X segundos atrás" indicator.  
- Telinha receives the *same* WebSocket data stream but holds it in a longer jitter buffer (4-6s vs. 0.3-0.6s) so the viewer's live voice commentary in Discord doesn't leak their own delayed video audio back into their mic.  
- Telinha closes automatically when the Activity session ends or the user closes the Activity.  

**Non-goals:**  
- No independent telinha auth (it inherits the Activity session token via `window.open` + URL fragment).  
- No telinha-specific controls (play/pause/seek) — it's a pure synchronized observer, not a DVR.  
- No mobile support (companion tabs are desktop-browser only, same as publisher companion).  
- Not solving publisher-side echo (that's already handled by per-app audio capture).

---

## Implementation plan

### 1. Add `openTelinha()` UI entry point in viewer Controls component  
**Concern:** Button must be visually distinct from fullscreen/theater (different intent) but not mistaken for a "pop-out player" that replaces the Activity view.  
**Verify:** `tools/probe` connects as viewer, sends `{ type: "uiAction", action: "inspectControls" }` — response includes `controls.telinha.available: true, controls.telinha.label: "Abrir telinha"` when a publisher is live.

### 2. Generate time-scoped telinha token and open window with fragment  
**Concern:** Token must be usable exactly once and expire after 30s (prevent URL sharing), but survive one browser pop-up-blocker retry.  
**Verify:** Probe calls `POST /telinha-token` with session HMAC, asserts response `{ token: string, ttl: 30, scope: "view-delayed" }` and that a second POST with same HMAC returns a *different* token (single-use per request, not per session).

### 3. Telinha route serves minimal SolidJS view (no Discord SDK, no iframe CSP)  
**Concern:** Must validate token on load and establish WebSocket to the *same relay room* with a `viewerRole: "telinha"` flag so relay knows to mark this connection for delayed dispatch.  
**Verify:** Probe connects WebSocket with `?telinha-token=...`, sends `{ type: "join", role: "telinha" }` — relay broadcasts `{ type: "roster", viewers: [{...}, {..., role: "telinha", delay_ms: 3000}] }` to all clients.

### 4. Relay maintains per-connection `delayQueue` and schedules chunks +3s for telinha peers  
**Concern:** Memory overhead if many viewers open telinhas; must cap at 5 concurrent telinhas per room and return `{ type: "error", code: "TELINHA_LIMIT" }` on 6th join.  
**Verify:** Probe spawns 5 telinha connections (all receive delayed `videoChunk` messages), attempts 6th — asserts `TELINHA_LIMIT` error and that existing 5 still receive chunks on schedule.

### 5. Telinha decode pipeline uses 6s jitter buffer (vs. 0.5s standard) and skip-to-live disabled  
**Concern:** Telinha must *never* catch up to live (defeats the purpose); buffer underrun should pause/spinner, not skip forward.  
**Verify:** Probe publisher sends `videoChunk` burst, standard viewer asserts first frame render within 800ms, telinha viewer asserts first frame render between 2800-3200ms and that `bufferHealth` field in telinha `statsUpdate` message shows `target: 6000, current: ~6000`.

### 6. Activity UI shows "Telinha aberta (3s atrás)" toast when window detected open  
**Concern:** User might forget the telinha is open and wonder why they hear delayed audio; toast reminds them of the offset.  
**Verify:** Probe simulates telinha window open (WebSocket role=telinha established), asserts Activity client receives `{ type: "telinhaStatus", open: true, delay_ms: 3000 }` and UI layer emits `toastShow` event with text matching `/Telinha aberta.*3s/`.

### 7. Telinha auto-closes when publisher stops or Activity navigates away  
**Concern:** Orphaned telinha windows are confusing; must clean up via `window.close()` from the Activity or relay hangup signal.  
**Verify:** Probe publisher sends `{ type: "stop" }`, asserts relay broadcasts `{ type: "publisherStopped" }` to all clients *including* telinha connections, and telinha client logs `"Received publisherStopped, closing window"` before WebSocket close (probe checks close frame reason = `"publisher_stopped"`).

### 8. Add "Telinha (react/OBS)" explanation to the launcher scene subtitle or help popover  
**Concern:** First-time users won't understand what telinha is for; needs a one-line contextual hint (not a modal).  
**Verify:** Probe requests `GET /i18n/pt-BR` translations bundle, asserts presence of key `"viewer.telinha.hint"` with value matching regex `/(react|OBS|gravar|comentar)/i` (confirms Brazilian use-case language).

---

## Acceptance criteria

1. **Viewer can open telinha mid-stream:** Click "Abrir telinha" → new window opens showing same video feed delayed by 3±0.5s, confirmed by side-by-side timestamp comparison or probe timing assertions.  
2. **Telinha is OBS-capturable without Discord chrome:** Window contains only canvas + minimal title bar; no Discord UI, no chat, no roster.  
3. **Relay enforces 5-telinha-per-room limit:** 6th attempt returns error; first 5 remain stable.  
4. **Telinha closes on publisher stop:** Publisher ends stream → telinha window auto-closes within 2s.  
5. **Probe suite covers all 8 steps:** `probe/scenarios/telinha_test.go` validates token issue, delayed chunk delivery, roster role flag, limit enforcement, auto-close signal, translation key presence.  
6. **No memory leak over 10min sustained telinha session:** Relay RSS growth <5 MB per telinha connection (verified by existing metrics endpoint + probe long-run scenario).

---

## Risks

- **User confusion about the delay:** Mitigated by persistent "X segundos atrás" indicator in telinha UI and toast in Activity.  
- **Relay memory pressure from deep delay queues:** Each telinha holds ~3-5s of chunks (~1-2 MB at 2 Mbps); 5 concurrent = ~10 MB overhead. Acceptable for target hardware; monitor in production metrics.  
- **Pop-up blockers:** First-time users might need to allow pop-ups. Fallback: show "Permitir pop-ups e tente novamente" message if `window.open` returns null.  
- **Desync over long sessions (clock drift):** Telinha doesn't adjust delay dynamically. If session >30min, delay might drift ±500ms. Acceptable — use case is commentary/recording where rough sync suffices.

---

## Effort

**M** (Medium — 3-5 days, one mid-level full-stack contributor)  
- Relay-side delay queue + role handling: ~1 day  
- Telinha frontend route + decode config: ~1 day  
- Token issuing, limit enforcement, auto-close: ~1 day  
- Probe scenarios + CI integration: ~1 day  
- i18n strings + UI polish: ~0.5 day  

---

**Why this feature wins for PM #pm3:**  
Generic PMs pitch "better chat" or "playlist mode." This targets the **cultural behavior already happening** — Brazilians *love* react content and live commentary ("narração"), but Discord's own suspension created a CSP-locked iframe that makes capturing or commenting over your own audio a nightmare. Telinha is **architecturally elegant** (reuses relay fan-out, same two-surface pattern), **wire-observable** (delay + role flags are first-class protocol concerns), and **uniquely valuable in the suspended-Go-Live context** — it's a feature that *only makes sense* when screen-sharing lives inside an Activity iframe instead of native Discord. It's also **immediately демонстрируемо** in probe scenarios (delay timing, roster role, limit enforcement) — every step has a falsifiable wire assertion.
