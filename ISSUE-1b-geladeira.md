[sol -> gemini-3.1-pro via TrustBridge]
**Title:** Geladeira da Turma (The Squad's Fridge: Session Scrapbook)

**Pitch:** 
A persistent, crayon-drawn "fridge door" in the side panel where viewers can stick text magnets (quotes) and emoji magnets during the stream. It gives the friend-group a spatial, collaborative canvas to memorialize inside jokes as they happen, creating a living scrapbook of the watch-party without relying on Discord's fleeting text chat.

**Why now:** 
Brazilian gaming groups thrive on "zoeira" (banter) and emergent lore. Since they are locked entirely into the JanjaCast iframe for video, their attention is decoupled from the main Discord text channel. A shared, spatial fridge door harnesses this localized attention, allowing viewers to passively build a monument to the session's best moments without interrupting the main stream. 

**Scope / Non-goals:** 
*In-scope:* A togglable side-panel (off by default, slides in) acting as a 2D spatial plane; adding text magnets (max 40 chars) or emoji magnets; dragging magnets to reposition them; late-join state sync. 
*Non-goals:* Saving the fridge across different days (it dies when the session ends); drawing on the fridge (we keep that in *Intervalo* cinema mode); uploading images.

**Implementation plan:**

1. **Relay: Define Fridge State and Sync**
   * *Concern:* Late joiners need the current fridge layout immediately upon connecting.
   * *Verify:* Start Go relay. Send a mock `room_join` from a test client. Assert the relay sends a `fridge_sync` message containing a `magnets` array (empty by default).

2. **Relay: Handle Magnet Creation (`fridge_magnet_add`)**
   * *Concern:* Viewers need to add magnets, and the relay must assign a unique ID, cap the total magnets (e.g., 50) to prevent abuse, and broadcast.
   * *Verify:* Connect Client A and Client B. Client A sends `{"type": "fridge_magnet_add", "kind": "text", "content": "Foi de base", "x": 10, "y": 20}`. Assert Client B receives `{"type": "fridge_magnet_added", "id": "<uuid>", "kind": "text", "content": "Foi de base", "x": 10, "y": 20, "author_id": "<A_id>"}`.

3. **Relay: Handle Magnet Repositioning (`fridge_magnet_move`)**
   * *Concern:* The spatial aspect requires moving magnets, utilizing last-writer-wins based on the magnet ID.
   * *Verify:* Client A sends `fridge_magnet_move` for an existing ID with new `x` and `y`. Assert Client B receives `{"type": "fridge_magnet_moved", "id": "<uuid>", "x": 50, "y": 50}`.

4. **Client: Fridge Panel UI & Toggle**
   * *Concern:* The fridge must not obscure the video. It must exist in a toggleable side-drawer (right side) with the hand-drawn crayon aesthetic.
   * *Verify:* (Component test) Clicking the "Geladeira" icon in the bottom control bar sets `isFridgeOpen` to true, rendering the `<FridgePanel />` component with a slide-in CSS animation.

5. **Client: Magnet Creation Tooling**
   * *Concern:* Users need a zero-decision way to add items. A simple input at the bottom of the fridge panel should auto-detect if the input is a single emoji (creates an emoji magnet) or text (creates a word magnet).
   * *Verify:* (Unit test) Submitting the fridge input with "GADO" emits a `fridge_magnet_add` WebSocket payload with `kind: "text"`. Submitting "🤡" emits `kind: "emoji"`.

6. **Client: Spatial Drag-and-Drop**
   * *Concern:* Moving magnets should feel responsive but not flood the relay with every pixel of mouse movement.
   * *Verify:* (Mocked WS test) Dragging a `<Magnet />` updates local state immediately (optimistic UI), but only emits the `fridge_magnet_move` payload to the socket `onPointerUp` (debounced/dropped).

**Acceptance criteria:**
* Any viewer can open the side panel ("Geladeira") and see the same magnets in the same positions.
* A viewer typing "deu ruim" into the fridge input and hitting Enter instantly spawns a text magnet in the center of the fridge.
* Dragging a magnet updates its position for all other viewers in the room.
* Late-joining viewers receive the fully populated fridge upon connection.
* Total magnets cannot exceed 50 (oldest magnets are evicted by the relay and a `fridge_magnet_removed` broadcast is sent).

**Risks:**
* **Screen real estate:** On smaller monitors (or half-screen windows), a side-panel might squish the WebCodecs canvas uncomfortably. *Mitigation:* Ensure the flexbox layout gracefully scales the video down, and auto-closes the fridge if window width drops below a critical threshold (e.g., 800px).
* **Payload flooding:** Malicious users spanning `fridge_magnet_move`. *Mitigation:* Relay enforces a hard rate limit per `author_id` for fridge actions (max 2 moves per second).

**Effort:** M (Requires UI drag-and-drop state management and simple relay state addition, but no complex media/WebCodecs work).
