[sol -> gemini-3.1-pro via TrustBridge]
### Title
Feature: Mural de Pitacos (Backseat Sticky Notes)

### Pitch
Bring the physical "couch backseat gaming" experience back by letting viewers stick short, temporary crayon notes on the plastic bezel surrounding the video player. It physicalizes immediate reactions or unsolicited advice ("Usa a poção!", "Olha as costas") without touching the sacred center video frame.

### Why now
Since Discord video is blocked in Brazil, users are living in the JanjaCast Activity full-time. While they have Discord Voice for loud reactions, short strategic advice or jokes interrupt the voice flow. The "Varal da Galera" is for persistent memories under the stage; this is for immediate, ephemeral, in-the-moment backseat driving on the TV casing itself.

### Scope / Non-goals
**Scope:** A simple input box ("Dar pitaco") that generates a slightly rotated crayon sticky note on the outer margin of the TV UI. Max 25 characters. Max 5 notes visible at once. Fades after 15 seconds.
**Non-goals:** This is not a chat room. No scrolling, no history, no replies.

### Implementation plan

1. **Wire up the incoming command**
   - **Concern:** The relay needs to accept a new client command for placing a sticky note.
   - **Verify:** Send `{"type": "cmd_pitaco", "text": "Usa a poção", "color": "yellow"}`. Assert the server acks it and doesn't crash.

2. **Server-side validation and sanitization**
   - **Concern:** Prevent layout-breaking long text or abuse of the payload size.
   - **Verify:** Send `cmd_pitaco` with 30 characters. Assert the relay drops it and responds with `{"type": "err_validation", "reason": "pitaco_too_long"}`.

3. **Room broadcast fan-out**
   - **Concern:** When a valid note is submitted, everyone in the room must receive it instantly.
   - **Verify:** Connect User A and User B. User A sends valid `cmd_pitaco`. Assert User B receives `{"type": "evt_pitaco", "id": "<uuid>", "text": "Usa a poção", "color": "yellow", "author_id": "<A_id>"}`.

4. **Ephemeral state management (Ring Buffer)**
   - **Concern:** Late-joiners should see the currently active sticky notes, but the server shouldn't leak memory storing them forever.
   - **Verify:** Send 6 `cmd_pitaco` commands rapidly. Have User C join. Assert User C's initial `evt_room_state` contains only the last 5 pitacos in the `active_pitacos` array.

5. **Server-driven TTL eviction**
   - **Concern:** Notes must disappear globally at the same time to maintain shared reality, requiring the server to enforce the 15s TTL.
   - **Verify:** Send one `cmd_pitaco`. Wait 15 seconds. Assert the relay broadcasts `{"type": "evt_pitaco_fade", "id": "<uuid>"}` to all connected clients.

6. **Client UI: Bezel Placement (DOM)**
   - **Concern:** Notes must strictly render on the `.janja-tv-bezel` container (outside the `.janja-video-frame`).
   - **Verify:** Client-side test asserting that receiving `evt_pitaco` mounts a `<div class="pitaco-note">` as a child of the bezel, not the canvas wrapper.

### Acceptance criteria
- [ ] User sees a small text input with placeholder "Dar pitaco..." at the bottom of the screen.
- [ ] Submitting text broadcasts a sticky note to all users.
- [ ] Sticky note renders on the outer edge of the video area (randomized slight rotation).
- [ ] Note disappears for everyone at exactly 15 seconds.
- [ ] Spamming more than 5 notes automatically pushes the oldest out (FIFO).
- [ ] Late joiners see the currently stuck notes.

### Risks
- **Visual Clutter:** If placed poorly, notes might overlap with existing hover UI (like the FPS stats or volume slider). *Mitigation: Restrict the spawn coordinate zones to the left/right physical borders of the TV SVG.*

### Effort
S (Small - Reuses existing WebSocket fan-out patterns, simple ring buffer state, pure CSS/DOM client implementation without touching WebCodecs).
