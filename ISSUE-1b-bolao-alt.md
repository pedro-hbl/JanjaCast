[sol -> gemini-3.1-pro via TrustBridge]
**Title:** Feature: Aposta da Galera (A/B Crowd Predictions)

**Pitch:** 
"Vai dar bom ou vai de base?" The streamer can pop a quick A/B prediction board on the "wall" below the TV for the room to vote on the current gameplay moment. It turns passive watching into active *zueira* (banter) and anticipation, completely independent of the video frame.

**Why now:** 
Brazilian friend groups watching screenshares thrive on betting against the streamer's skills (e.g., "Will he beat the boss?"). Since we already have the relay infrastructure for reaction storms and ephemaral scoreboards, adding a Twitch-style prediction mechanic (simplified to an ephemeral crayon chalkboard) supercharges the "assistir junto" (watch party) vibe that they lost when Discord disabled Go Live. 

**Scope / Non-goals:** 
**Scope:** Streamer triggers an A/B vote (defaults to "Deu bom" / "Deu ruim" if no text provided). Viewers click to lock in. Streamer resolves it (A or B wins). Winners get a visual crayon crown next to their roster name until the next bet.
**Non-goals:** No persistent economy or points (no coins). No more than 2 options (strictly A vs B). No covering the video player (lives in the flex space below/beside the theater).

**Implementation plan:**

1.  **Define Prediction Wire Types**
    *   *Concern:* We need strict message types for the prediction lifecycle to avoid state corruption.
    *   *Verify:* Probe connects as publisher, sends invalid `prediction_open` (e.g., 3 options), server rejects with standard error.
2.  **Relay: Handle `prediction_open`**
    *   *Concern:* The relay must accept the open command from the current stage owner and broadcast the new active state.
    *   *Verify:* Probe (publisher) sends `{"type": "prediction_open", "optA": "Sim", "optB": "Não"}`. Probe (viewer) asserts receipt of `{"type": "prediction_state", "active": true, "optA": "Sim", "optB": "Não", "votesA": 0, "votesB": 0}`.
3.  **Relay: Handle Viewer `prediction_vote`**
    *   *Concern:* Viewers need to cast a vote that increments the tally exactly once per user.
    *   *Verify:* Probe (viewer 1) sends `{"type": "prediction_vote", "choice": "A"}`. Probe (viewer 2) asserts receipt of updated `prediction_state` with `"votesA": 1`. Viewer 1 sending a second vote for "B" is ignored or updates the vote (but does not increment total over 1 per user).
4.  **Relay: Handle `prediction_resolve`**
    *   *Concern:* The publisher must be able to close the bet and declare a winner, broadcasting the result so clients can trigger UI celebrations.
    *   *Verify:* Probe (publisher) sends `{"type": "prediction_resolve", "winner": "A"}`. Probe (viewers) assert receipt of `{"type": "prediction_result", "winner": "A", "winning_users": ["user_id_1"]}`.
5.  **Client UI: The Chalkboard**
    *   *Concern:* The UI must render the active prediction and allow one-click voting without stealing focus from the stream.
    *   *Verify:* Send mocked `prediction_state` over the wire; assert Playwright test locates the crayon chalkboard buttons ("Sim" / "Não") below the video and clicks one, verifying the `prediction_vote` payload is sent.
6.  **Client UI: Result Celebration & Roster Crowns**
    *   *Concern:* Winners need bragging rights. We must append a small crayon crown to the roster items of the `winning_users`.
    *   *Verify:* Send mocked `prediction_result` over the wire; assert Playwright test locates the `.roster-item[data-user="user_id_1"] .crayon-crown` SVG.

**Acceptance criteria:**
*   Only the active publisher can start and resolve a prediction.
*   Viewers see the options update in real-time as others vote.
*   The video frame remains 100% unobstructed (UI lives in the surrounding Activity wrapper).
*   When resolved, users who voted for the winning side get a visual indicator in the roster.

**Risks:**
*   *State desync on late join:* If a user late-joins via GOP cache while a bet is active, they might miss the initial `prediction_state` broadcast. Mitigation: The relay must append the current `prediction_state` to the `room_welcome` payload sent upon initial WebSocket connection.

**Effort:** M
