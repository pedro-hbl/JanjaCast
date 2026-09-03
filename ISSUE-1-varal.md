[sol -> gemini-3.1-pro via TrustBridge]
### Feature: Varal de Momentos (Shared Crayon Clothesline)

**Pitch**
O chat piscou e perdeu a capotada do streamer? Pendure um "Polaroid" do frame exato no **Varal da Galera** debaixo da TV, criando uma galeria visual das maiores vergonhas da sessão. It gives the friend group a persistent, highly visible inside-joke board that builds lore over the course of the night without interrupting the live feed.

**Why now**
As Brazilian Discord groups transition entirely to JanjaCast for their daily "assistir junto" sessions, they miss the persistent visual banter of pasting screenshots in Discord text channels (which feels disconnected when full-screened in an Activity). The Clothesline provides an immediate, low-latency way to immortalize a funny frame directly inside the shared viewing space, driving engagement through shared memory rather than just ephemeral reactions. 

**Scope / Non-goals**
*   **In Scope:** A visual "clothesline" UI component rendered *below* the main video frame (respecting the "silent in the middle" rule); viewers capturing the current frame as a low-res thumbnail; relay distributing and holding a rolling buffer of up to 10 pinned frames.
*   **Non-goals:** High-resolution screenshots (these are strictly 320x180 thumbnails to look like small polaroids); permanent storage (wiped when the relay session ends); video clips (already solved by "Clipa isso!").

**Implementation plan**

1.  **Define wire protocol for frame capture submission.**
    *   *Concern:* We need a way for a viewer to submit a captured thumbnail to the relay without blocking the main WebCodecs pipeline.
    *   *Verify:* Probe connects as viewer, sends `{"type": "pin_frame", "b64_jpeg": "data:image/jpeg;base64,...", "caption": "LMAO"}`. Assert the relay responds with `{"type": "ack_pin", "id": "<uuid>"}`.

2.  **Enforce relay-side memory limits and validation.**
    *   *Concern:* Malicious or spammy clients could crash the relay by sending massive payloads or thousands of pins.
    *   *Verify:* Probe sends a 1MB payload in `b64_jpeg`. Assert relay drops the message and replies with `{"type": "error", "code": "payload_too_large"}`. Probe sends 15 valid pins; assert the 16th pin causes the relay to evict the oldest pin from its internal state.

3.  **Broadcast the clothesline update to the room.**
    *   *Concern:* All other viewers (and the streamer's Activity) need to know a new polaroid was hung on the clothesline.
    *   *Verify:* Probe A sends a valid `pin_frame`. Assert Probe B (already connected) receives `{"type": "clothesline_update", "action": "add", "pin": {"id": "<uuid>", "user_id": "<discord_id>", "b64_jpeg": "...", "caption": "LMAO"}}`.

4.  **Inject clothesline state into the late-join sync payload.**
    *   *Concern:* Viewers joining mid-stream must see the polaroids that were pinned before they arrived.
    *   *Verify:* Probe A sends a valid `pin_frame`. Probe B connects 5 seconds later. Assert Probe B's initial `{"type": "room_state"}` message includes a populated `clothesline: [{...}]` array containing Probe A's pin.

5.  **Client-side frame extraction via WebCodecs offscreen canvas.**
    *   *Concern:* Extracting the frame must not cause UI stutter or interrupt the decoding loop.
    *   *Verify:* Assert that clicking the "Pendurar no Varal" button draws the *last completely decoded* `VideoFrame` to an `OffscreenCanvas` at 320x180, calls `convertToBlob({ type: 'image/jpeg', quality: 0.6 })`, and dispatches the base64 string to the WebSocket manager. 

6.  **Implement the Crayon Clothesline UI.**
    *   *Concern:* The new UI must fit the hand-drawn aesthetic and not overlap the video frame or the Jukebox/Legenda areas.
    *   *Verify:* Assert that the `<Clothesline />` SolidJS component renders as a flex row below the video container, animating new polaroids with a slight CSS rotation (`transform: rotate(-2deg)`), and displays the user's Discord avatar clipped to the corner of the polaroid.

7.  **Add a "Cortar a corda" (Delete) moderation capability.**
    *   *Concern:* The streamer (publisher) needs the ability to remove a TOS-breaking or annoying polaroid.
    *   *Verify:* Probe A (publisher) sends `{"type": "delete_pin", "id": "<uuid>"}`. Assert Probe B receives `{"type": "clothesline_update", "action": "remove", "id": "<uuid>"}`, and the relay removes it from internal state.

**Acceptance criteria**
*   Viewer can click a "polaroid camera" icon below the player; within 500ms, a thumbnail of that exact video frame appears on a clothesline below the player for *all* participants.
*   Hovering over the polaroid reveals the username of the person who pinned it.
*   The relay correctly maintains a maximum of 10 polaroids, shifting the oldest out (FIFO) when a new one is added.
*   Late-joining clients instantly render the current clothesline state upon loading.
*   Publisher can hover any polaroid and click a red "X" to instantly remove it for the whole room.

**Risks**
*   **Base64 JSON overhead:** Sending images inside JSON via WebSockets is inefficient. *Mitigation:* Aggressively downscale to 320x180 and compress to 60% quality JPEG before Base64 encoding. Max payload should be around 10-15kb, which is negligible even for strict egress budgets.
*   **Offscreen Canvas compatibility:** Older or extremely constrained browsers might struggle with sync `OffscreenCanvas` exports. *Mitigation:* Fallback to a standard `<canvas>` `toDataURL` extraction in a micro-task if `OffscreenCanvas` is missing.

**Effort:** M
