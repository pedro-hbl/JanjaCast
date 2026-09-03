[codex -> gpt-5.6-codex via TrustBridge]
Title
“Quis entrou?” — Join Replay with Heatmap

Pitch (pt-BR, user-facing)
- “Perdeu o começo? Dá play no ‘Quis entrou?’ e vê quem chegou e o que rolou nos primeiros 90s — com mini player fora da tela e mapa de hype.”
- “Sem atrapalhar a live: todo mundo pode rever rapidinho as entradas, storms e placar, e voltar pro ao vivo num toque.”

Why now
- With Brazil’s Go Live suspended, Discord friend-groups are rebuilding routines around JanjaCast sessions. Late-joiners constantly ask “o que perdi?” in chat, disrupting the flow. We can solve this socially-common friction by offering a lightweight, room-synced replay of just the opening beats and big moments, without touching the center video.
- It leverages our existing rolling buffer, storm aggregation, and roster events to produce a tiny, verifiable recap that’s instantly useful for Brazilian watch-parties and gaming squads.

Scope / Non-goals
- In scope:
  - A per-session “Join Replay” that any viewer can open locally: a 60–90s scrub of recent buffer with an event heatmap (joins, reaction storms, scoreboard spikes).
  - Wire-synced event timeline so all clients can reconstruct the same markers.
  - A tiny corner mini-player (outside the main video area), muted by default, with “Voltar ao vivo” CTA.
  - Automatic offer on first join within first 2 minutes of a running session; accessible later via a small “Quis entrou?” button in the chrome.
- Non-goals:
  - Not a full VOD/recording system.
  - No changes to the main video canvas or overlay graphics on top of the stage.
  - No cross-session persistence beyond current session TTL.
  - No server-side storage beyond in-memory timelines already kept by the relay.

Implementation plan
1) Relay: Emit timeline events for joins and key actions
   - Concern: Event spam in large rooms causing bandwidth bloat.
   - Change: On each viewer connect, publisher start/stop, reaction storm start/peak/end, scoreboard delta, relay emits a T_EVENT message to all clients with typed payload.
   - Verify: Probe connects two viewers and a publisher, triggers a storm and a +1 score. Assert watchers receive T_EVENT messages with:
     - {type:"join", userId:"V1", atMs: n}
     - {type:"storm", phase:"start"|"peak"|"end", id:"s123", atMs:n, intensity: number}
     - {type:"score", promptId:"p1", delta:+1, atMs:n, total:number}

2) Relay: Maintain a rolling event window aligned to media buffer
   - Concern: Clock drift between event times and media buffer timestamps.
   - Change: Relay stamps events with relayMonotonicMs and exposes bufferHeadMs (oldest retained) and liveMs (latest).
   - Verify: Probe requests T_TIMELINE_SNAPSHOT; assert server replies T_TIMELINE with:
     - {bufferHeadMs:number, liveMs:number, events:[...<=90s range]}

3) Client: Local “Join Replay” data model and entry point
   - Concern: UI offer may trigger during sensitive UX (e.g., panic mode or cinema interval).
   - Change: On first join within <120s of liveMs - bufferHeadMs, show a subtle pill button “Quis entrou?”; suppress during panic/cinema, then re-offer once normal resumes.
   - Verify: Probe simulates mode flags via T_STATE {panic:false, cinema:false}; upon T_TIMELINE with recent window, assert client emits CONTROL_UI {offerJoinReplay:true, reason:"recent"} to log bus.

4) Client: Mini-player playback from local buffer without disturbing live
   - Concern: Competing decoders or audio conflicts.
   - Change: Spawn a separate WebCodecs decoder instance reading from the same fetched chunks but paused at live; mini-player muted by default; no impact on main canvas.
   - Verify: Trigger CONTROL_UI {openJoinReplay:true}; assert client sends CONTROL_PLAYBACK {mini:{state:"playing", fromMs: liveMs-60000, muted:true}}; no change to CONTROL_PLAYBACK main.

5) Client: Render heatmap scrub bar from timeline events
   - Concern: Visual clutter violating “silent middle”.
   - Change: Draw a thin crayon heat strip in the bottom chrome, not on the video. Buckets show intensity from storms, ticks for joins and score deltas; hover shows pt-BR tooltips.
   - Verify: After T_TIMELINE and CONTROL_UI {openJoinReplay:true}, assert client emits CONTROL_UI {heatmap:{buckets:[{t:number,intensity:number,joins:number,scoreDelta:number}, ...]}}.

6) Sync: Seeking and resume-to-live behavior
   - Concern: User gets “stuck” in replay and misses current action.
   - Change: Provide “Voltar ao vivo” button; any seek beyond liveMs-3s snaps back to live and closes mini-player.
   - Verify: Probe sends CONTROL_UI {seekMini:{toMs: liveMs-1000}}; assert client emits CONTROL_PLAYBACK {mini:{state:"closed"}} and CONTROL_PLAYBACK {main:{state:"live"}}.

7) Server: Lightweight backfill on late open
   - Concern: Client opening replay much later needs consistent markers.
   - Change: On T_JOIN_REPLAY_REQUEST from client, relay responds with T_TIMELINE including last 90s at that moment.
   - Verify: Probe issues T_JOIN_REPLAY_REQUEST; assert T_TIMELINE with correct window and monotonically increasing atMs, plus bufferHeadMs/liveMs sanity (liveMs-bufferHeadMs >= 90000 or capped).

8) Privacy & panic/cinema integration
   - Concern: Replay shows content captured before panic was triggered.
   - Change: When panic is active or cinema paused, mark timeline segments as redacted; client disables playback into those ranges.
   - Verify: Relay sends T_STATE {panic:true}; assert subsequent T_TIMELINE includes segments [{from: a, to: b, redacted:true}]; client emits CONTROL_UI {miniPlayable:false, reason:"panic"} if the requested window overlaps.

9) Rate-limit and coalescing of storm events
   - Concern: Excess storm phases inflate event count.
   - Change: Relay coalesces storm updates per 500ms window, sending only latest intensity in that bucket.
   - Verify: Probe fires rapid storm updates; assert watchers receive ≤1 T_EVENT per 500ms per storm id, with the highest intensity of that slice.

Acceptance criteria
- When a viewer joins within two minutes of session start or a big moment, they see a “Quis entrou?” pill; clicking opens a muted mini-player showing the last 60–90s with a heatmap. Probe: Assert CONTROL_UI {offerJoinReplay:true} then CONTROL_PLAYBACK {mini:{state:"playing", muted:true}}.
- Timeline events (join, storm start/peak/end, score deltas) are broadcast as T_EVENT with relayMonotonicMs timestamps and appear in T_TIMELINE snapshots. Probe: Assert correct types/fields and times within the buffer window.
- Seeking within the mini-player updates the heatmap cursor and never pauses or alters the main live playback. Probe: After CONTROL_UI {seekMini:{toMs:x}}, assert only mini state changes; main remains {state:"live"}.
- “Voltar ao vivo” closes the mini-player and returns focus to the live stream. Probe: CONTROL_UI {returnLive:true} -> CONTROL_PLAYBACK {mini:{state:"closed"}}.
- Panic or cinema intervals never play back in the mini-player; those ranges are visually indicated and unseekable. Probe: T_STATE {panic:true} then attempt seek; assert CONTROL_UI {miniPlayable:false, reason:"panic"}.
- Event coalescing limits storm messages to at most 1 per 500ms per storm id without losing peak intensity information. Probe: Burst updates -> count messages and check intensity equals peak in window.
- No messages are emitted that are not proxied through Discord’s allowed channels; no external fetches. Probe: Traffic inspection shows only WebSocket control/data frames to relay.

Risks
- Decoder resource contention on lower-end machines running two WebCodecs paths. Mitigation: cap mini-player to 360p/15fps via existing SVC shedding; auto-pause mini if device throttles.
- Timeline/event clock skew causing misaligned heatmap. Mitigation: rely solely on relayMonotonicMs and bufferHeadMs/liveMs; never trust client clocks.
- UX confusion for users expecting full rewind. Mitigation: tight scope to 90s and clear “Voltar ao vivo” CTA; optional tooltip “Replay curto, só os últimos 90s”.

Effort
M (medium)
