[sol -> gemini-3.1-pro via TrustBridge]
### Title: Feature: "Bolão da Janja" (Live Yes/No Predictions)

### Pitch
Bring the classic Brazilian "bolão" to watch parties by letting anyone in the room launch a quick Yes/No prediction ("Vai dar bom?" / "Vai dar ruim?") during intense stream moments. Winners earn a temporary crayon crown on the presence roster, driving banter and engagement without touching the center video.

### Why now
With Discord's Go Live suspended in Brazil, JanjaCast is the primary venue for gaming groups and reality TV watch parties. Friend groups thrive on high-stakes banter. By weaponizing the existing presence roster and websocket fan-out for interactive micro-predictions, we elevate JanjaCast from a mere screen-mirror to an active social layer that rivals native Twitch features, perfectly tailored to Brazilian streaming culture.

### Scope / Non-goals
**In Scope:** Anyone can start a binary choice prediction (defaults to A/B emojis if no prompt typed); real-time anonymous vote aggregation; creator resolves the outcome; temporary roster flair for winners.
**Non-goals:** No persistent currency or "JanjaCoins"; no multi-choice (strict binary to keep UI small); no betting history or persistent leaderboards.

### Implementation plan

1. **Wire `BOLAO_START` command and broadcast**
   * **Concern:** Anyone can start a Bolão, but we must prevent overlapping active wagers that clutter the UI.
   * **Verify:** Send `{"type": "BOLAO_START", "prompt": "Passa do boss?"}` from Client A. Assert server broadcasts `{"type": "BOLAO_ACTIVE", "id": "<uuid>", "prompt": "Passa do boss?", "author_id": "A"}` to all connected clients. Send a second `BOLAO_START` while one is active; assert server returns `{"type": "ERROR", "code": "BOLAO_ALREADY_ACTIVE"}` to the sender.

2. **Wire `BOLAO_VOTE` command and live aggregation**
   * **Concern:** Preventing vote manipulation (double voting) while keeping the wire payload light (only broadcasting aggregates, not who voted for what).
   * **Verify:** Send `{"type": "BOLAO_VOTE", "id": "<uuid>", "choice": "SIM"}` from Client B. Assert server sends `{"type": "BOLAO_UPDATE", "counts": {"SIM": 1, "NAO": 0}}` to all clients. Send a second vote from Client B for "NAO"; assert server updates and broadcasts `{"counts": {"SIM": 0, "NAO": 1}}`.

3. **Wire `BOLAO_RESOLVE` and winner fan-out**
   * **Concern:** Ensuring only the author (or the current stage publisher) can resolve the prediction, preventing trolls from ruining the payoff.
   * **Verify:** Send `{"type": "BOLAO_RESOLVE", "id": "<uuid>", "winning_choice": "SIM"}` from Client C (non-author). Assert `{"type": "ERROR", "code": "FORBIDDEN"}`. Send the same from Client A (author). Assert server broadcasts `{"type": "BOLAO_RESULT", "winning_choice": "SIM", "winners": ["<client_id_B>"]}` to all clients.

4. **Inject Bolão state into late-join `ROOM_STATE`**
   * **Concern:** A user joining mid-wager needs to see the active poll to participate without requiring a separate state request.
   * **Verify:** While a Bolão is active, connect a new Client D. Assert the initial `ROOM_STATE` payload includes an `active_bolao: {"id": "<uuid>", "prompt": "...", "counts": {...}, "author_id": "A"}` object.

5. **Client: Render Bolão UI in the sidebar**
   * **Concern:** Taking up too much space. The UI must live entirely in the sidebar/roster area, respecting the "Nothing over the center video" constraint.
   * **Verify:** Mount the `BolaoCard` component with an active state. Assert it renders two crayon-styled buttons: "Vai dar bom? (Sim)" and "Vai dar ruim? (Não)". Assert clicking a button emits the `BOLAO_VOTE` websocket message.

6. **Client: Apply temporary roster crowns on resolve**
   * **Concern:** The reward needs to feel earned but must clean itself up automatically so the roster doesn't stay cluttered.
   * **Verify:** Dispatch a mock `BOLAO_RESULT` event to the store. Assert the `Roster` component renders a crayon crown SVG (`<svg data-testid="bolao-crown">`) next to the winning users' names. Assert the crown is removed from the DOM exactly 30 seconds later via a standard `setTimeout` store cleanup.

### Acceptance criteria
- [ ] Any user can open the Bolão panel and start a Yes/No prediction with a custom short text prompt.
- [ ] Viewers see live-updating vote counts (anonymized numbers, e.g., 5 vs 2).
- [ ] The author can click "Deu bom!" or "Deu ruim!" to resolve.
- [ ] Winners receive a visible crayon crown in the presence roster for 30 seconds.
- [ ] No UI elements obscure the `canvas` video player.
- [ ] Late-joiners instantly see the active Bolão upon loading the Activity.

### Risks
- **Attention diversion:** Gamification might distract from the stream itself, though keeping it out of the center frame mitigates this.
- **Toxicity:** Malicious prompts could be used to harass users in the room. Relies on the inherent trust of small Brazilian friend-group servers (our target audience). 

### Effort
M (Pure state sync over existing websocket + lightweight DOM UI additions; no media pipeline changes).
