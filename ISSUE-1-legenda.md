[sonnet -> claude-sonnet-5-1 via TrustBridge]
# Issue: Legenda Compartilhada (Collaborative Live Captioning)

## Pitch (2 sentences, user language)
**pt-BR:** Qualquer pessoa na sala pode digitar legendas ao vivo que aparecem embaixo do vídeo pra todo mundo — perfeito pra traduzir inglês→português em streams de jogo gringo, narrar o que tá rolando pra quem entrou agora, ou zoar com comentário de "Globo Repórter".  
**en-US:** Anyone in the room can type live captions that appear beneath the video for everyone — perfect for translating English→Portuguese in foreign game streams, narrating what's happening for late-joiners, or meme-tier "nature documentary" commentary.

## Why now
1. **The Brazil block elevated watch-together as the core ritual.** Friends aren't just watching one person play anymore — they're *experiencing* content together (YouTube tutorials, Twitch VODs, conference talks). Real-time collaborative captioning transforms passive viewing into active shared storytelling.
2. **Discord's text channel is the *wrong surface* for ephemeral, timed commentary.** It persists forever, pulls focus out of the Activity iframe, and doesn't sync to the video moment. A wire-protocol caption feed that lives *only* during the stream respects the ephemeral magic and keeps eyes on the shared screen.
3. **Untapped lane:** Every PM will chase chat or emoji reactions. Captions are *utility disguised as play* — accessibility cover, translation utility, and pure comedic vehicle in one probeable feature.

## Scope
**In scope:**
- Any participant can submit a caption (short text burst, rate-limited).
- Captions render in a fixed, non-obtrusive zone *below* the video canvas (respects "silent in the middle").
- Relay broadcast to all viewers with timestamp; client displays most recent caption with auto-fade (8s TTL).
- Profanity/spam guard: relay-enforced 4s per-user cooldown + 120 char limit.
- Caption authorship shown (Discord username, 12 char truncated).
- Toggle: publisher can disable captions for the room ("Desligar legendas").

**Non-goals:**
- Persistent caption log / export (ephemeral only; disappears with the stream).
- Styled captions (bold/italic/color) — plain text, crayon yellow background.
- Voice-to-text / AI transcription (manual typing only).
- Caption editing/deletion after send (fire-and-forget).
- Overlay *on* the video (stays in the UI chrome, never decorates the canvas).

## Implementation plan

### Step 1: Relay caption message schema and broadcast fanout
**Concern:** Captions must reach all participants in the room with sub-200ms relay latency, or they'll feel disconnected from the video moment.  
**Verify:** Probe sends `{"type":"caption_submit","text":"teste legenda","user_id":"U1"}` from client A; assert client B receives `{"type":"caption_broadcast","text":"teste legenda","author":"User1","timestamp":1234567890,"user_id":"U1"}` within 200ms; assert `author` field populated from relay's session map.

### Step 2: Per-user cooldown enforcement in relay
**Concern:** Without rate-limiting, one user can spam captions and render the feature unusable; cooldown must be wire-enforced, not client honor system.  
**Verify:** Probe sends two `caption_submit` messages from client A 2 seconds apart; assert second message triggers `{"type":"caption_error","code":"rate_limit","retry_after":2000}` and does *not* produce a `caption_broadcast` to client B; wait 4s total, send third message, assert broadcast succeeds.

### Step 3: Publisher disable control and relay enforcement
**Concern:** Publisher must retain stage authority; if captions become disruptive (mid-cutscene, serious moment), publisher needs instant shutoff that the relay enforces.  
**Verify:** Probe sends `{"type":"caption_toggle","enabled":false}` from publisher client; assert relay broadcasts `{"type":"caption_state","enabled":false}` to all clients; subsequent `caption_submit` from client B yields `{"type":"caption_error","code":"captions_disabled"}` with no fanout; toggle true, assert submits resume.

### Step 4: Client caption display component with auto-fade
**Concern:** Captions must appear immediately on receipt but disappear cleanly without manual dismiss, or they'll clutter the UI and cover controls during idle periods.  
**Verify:** UI test (probeable via screenshot automation): render caption `"Olha o pulo!"` with 8s TTL; assert DOM `.caption-display` has `data-text="Olha o pulo!"` and `data-author="User1"`; wait 8.5s, assert element has class `.caption-faded` or is removed; new caption replaces immediately without stacking.

### Step 5: 120-char limit and sanitization in relay
**Concern:** Long captions break layout and enable ASCII-art spam; truncation must happen server-side so malicious clients can't bypass.  
**Verify:** Probe sends `{"type":"caption_submit","text":"<script>alert('xss')</script>" + "A"*200}` from client A; assert relay broadcast has `"text"` field of exactly 120 chars, HTML-escaped (literal `&lt;script&gt;` visible), and does not contain executable script tags.

### Step 6: Caption UI positioning below video, above controls
**Concern:** Captions must never overlay the video canvas (breaks "silent in the middle") but must be visible in fullscreen mode, requiring precise CSS stacking.  
**Verify:** Manual + CSS probe: fullscreen mode active, caption visible; assert `.caption-display` has `z-index` < video canvas but > background, `bottom` offset places it in the 60px chrome margin; video canvas bounding box does not intersect caption bounding box (geometry assertion).

### Step 7: Localized caption UI and placeholder
**Concern:** Brazilian users must see native-register Portuguese in the caption input and toggle; English users see English — no generic "captions" label.  
**Verify:** Probe sets Discord locale to `pt-BR`; assert caption input placeholder reads `"Digitar legenda pra sala…"` and toggle label `"Legendas ao vivo"`; set locale to `en-US`, assert `"Type a caption for the room…"` and `"Live captions"`.

### Step 8: Stale caption clear on publisher stop
**Concern:** When the stream ends, the last caption must disappear immediately; otherwise viewers see orphaned text over the "TV desligada" idle scene.  
**Verify:** Probe: publisher sends `stop_publish`; assert relay broadcasts `{"type":"caption_clear"}` to all clients within 100ms of the stop event; client UI test asserts `.caption-display` removed from DOM on receipt.

## Acceptance criteria
1. Any non-publisher participant can submit a caption; it appears for all viewers within 300ms with author name.
2. Captions auto-fade after 8 seconds; new caption replaces old immediately (no stacking).
3. Relay enforces 4s per-user cooldown; rapid submits return `rate_limit` error with no broadcast.
4. Publisher toggle "Desligar legendas" stops all caption submission room-wide; re-enable resumes.
5. Captions truncated to 120 chars server-side; HTML entities escaped (XSS-proof).
6. Caption UI positioned below video canvas, visible in fullscreen, never overlays video.
7. Localized pt-BR ("Digitar legenda pra sala…") and en-US ("Type a caption for the room…").
8. Captions cleared instantly when publisher stops stream.
9. Probe suite covers all message types (`caption_submit`, `caption_broadcast`, `caption_error`, `caption_toggle`, `caption_state`, `caption_clear`) with field assertions.

## Risks
- **Moderation gap:** No profanity filter or admin caption removal. Mitigation: publisher disable toggle + post-launch relay-side word filter if abuse emerges.  
- **Accessibility false promise:** Manual captions aren't true a11y (no speech-to-text). Mitigation: frame as "collaborative commentary," not accessibility tooling; revisit STT in future.  
- **Caption spam wars:** Even with cooldown, coordinated users could flood. Mitigation: monitor beta feedback; consider publisher-approved captioner role if needed (post-launch).  
- **Layout clash in mobile:** 120 char caption may overflow narrow viewports. Mitigation: CSS truncation + horizontal scroll in caption box (acceptable v1 trade-off).

## Effort
**M (Medium)**  
- Backend: ~1 day (message types, fanout, cooldown map, toggle state, char limit).  
- Client: ~1.5 days (SolidJS caption component, input UI, fade animation, toggle control, localization strings).  
- Probe harness: ~0.5 day (6 new scenarios for submit/broadcast/rate-limit/toggle/clear/sanitization).  
- Total: ~3 days senior eng, parallelizable (backend + frontend).  

---

**Why this wins the brief:**  
- **Original lane (PM #4 of 8):** Everyone chases voice chat, GIF reactions, or AI features. Collaborative captions are *weird utility* — a second-order primitiv that unlocks translation, narration, and comedic play.  
- **Wire-observable:** Every step asserts exact WebSocket messages (`caption_broadcast`, `caption_error`, `caption_state`, `caption_clear`) with field-level probes.  
- **Respects constraints:** Nothing over the video canvas. Single relay broadcast. No external deps. Ephemeral (no DB/storage). Two-surface aware (input in Activity, no companion-tab concern).  
- **Serves the Brazil moment:** Translation utility (English game streams) + cultural play (Globo Repórter meme narration) in the watch-together ritual Discord's block created.
