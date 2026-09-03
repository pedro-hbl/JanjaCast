[codex -> gpt-5.6-codex via TrustBridge]
Title
Fila de Requests Sonoros (Jukebox de Som da Galera)

Pitch
“Quero tocar o áudio do jogo/meme que tá na minha máquina pra todo mundo ouvir rapidinho — sem tomar o palco.” “Deixa a rapaziada mandar sons curtinhos ‘na fila’ enquanto o host streama, sem bagunçar o vídeo.”

Why now
- Brazilian friend groups lost native Go Live; they’re leaning on JanjaCast not just to watch but to vibe. Soundboards exist, but only the publisher’s system audio reaches everyone. Right now, hype moments rely on the host playing everything locally. A request-based, room-wide, low-friction way to inject short user-contributed audio clips keeps energy high without stealing the stage or touching the center video.
- This uniquely suits the moment: Discord soundboards are gated or inconsistent in Activities. A relay-coordinated, queue-driven “jukebox” fits our single-publisher constraint and respects the “silent middle” identity.

Scope
- Add a room-scoped audio request queue where any viewer can:
  - Submit a short local clip (2–8 seconds) via the companion-tab mic/capture microflow, or choose from a tiny shared preset list (pt-BR stickers).
  - See queue order and ETA.
  - Upvote/downvote requests within 20 seconds to reorder lightly.
- The relay mixes these request clips as a secondary audio lane over the stream for all viewers, ducking publisher audio -8 dB while a clip plays, then restoring.
- Publisher can skip next, mute the queue, or toggle “Som da Galera: ligado”.
- Crayon UI stays off the video; controls live in the Activity chrome.
Non-goals
- Not a full soundboard asset manager (we already have stingers/soundboard for publisher).
- Not persistent assets across rooms; requests are ephemeral per session.
- Not long-form music playback or DJing.
- Not speech chat; max 8s per clip, 10s cooldown per user.

Implementation plan
1) Wire protocol: declare new request type
   - Concern: Backward compatibility with older clients.
   - Verify: Probe sends {"t":"jukebox.hello","v":1} on connect; relay echoes {"t":"jukebox.state","enabled":false,"queue":[],"now":null} to all watchers in room. Assert fields and that legacy clients ignore unknown t.

2) Publisher capability toggle broadcast
   - Concern: Only publisher can enable the jukebox.
   - Verify: Publisher sends {"t":"jukebox.set","enabled":true}. Relay updates room and broadcasts {"t":"jukebox.state","enabled":true,"queue":[],"now":null}. Non-publisher attempt returns {"t":"error","code":"not_publisher","op":"jukebox.set"} to sender only.

3) Submit request (metadata first, then payload token)
   - Concern: Large payloads must not cross Discord proxy limits.
   - Verify: Viewer sends {"t":"jukebox.request","id":"r1","title":"Vaia","seconds":3.2,"source":"mic"}; Relay replies to sender {"t":"jukebox.accepted","id":"r1","upload":"ws","maxBytes":200000}. Sender then streams chunks {"t":"jukebox.chunk","id":"r1","seq":0,"data":"<base64>"} ending with {"t":"jukebox.end","id":"r1","codec":"opus","hz":48000"}. Relay finally broadcasts to room (excluding sender’s chunk noise) {"t":"jukebox.queued","id":"r1","by":{"id":"u42","name":"Ana"},"title":"Vaia","lenMs":3200,"votes":1,"pos":0}. Assert order and fields.

4) Lightweight voting and reorder
   - Concern: Prevent spam and vote manipulation.
   - Verify: Another viewer sends {"t":"jukebox.vote","id":"r1","delta":1}. Relay updates and broadcasts {"t":"jukebox.update","id":"r1","votes":2,"pos":0}. Same user repeats vote; relay responds {"t":"error","code":"duplicate_vote","op":"jukebox.vote","id":"r1"}.

5) Start playback and ducking signal
   - Concern: Global timing alignment for all clients.
   - Verify: When current clip starts, relay broadcasts {"t":"jukebox.play","id":"r1","atMs":ServerNow+150,"duckDb":-8}. Assert all connected clients receive before atMs and locally start duck at atMs, then restore on stop.

6) Deliver audio frames to all viewers
   - Concern: Keep AV lip-sync of main stream while adding a side channel.
   - Verify: Relay fans out prebuffered opus frames as {"t":"jukebox.audio","id":"r1","seq":N,"tsMs":...,"data":"<base64>"} at 20ms pacing until done; ends with {"t":"jukebox.stop","id":"r1","reason":"eof"}. Assert monotonic seq and matching stop.

7) Publisher controls: skip, mute, global off
   - Concern: Control messages must preempt audio safely.
   - Verify: Publisher sends {"t":"jukebox.action","op":"skip"}; relay broadcasts {"t":"jukebox.stop","id":"r1","reason":"skip"} then {"t":"jukebox.next","nextId":"r2"}. For mute: {"t":"jukebox.action","op":"mute","value":true} -> broadcast {"t":"jukebox.muted","value":true}. For off: {"t":"jukebox.set","enabled":false} -> broadcast state with enabled:false and implicit stop of any now.

8) Abuse and budget guardrails
   - Concern: Residential uplinks and moderation.
   - Verify: Exceeding maxBytes yields {"t":"error","code":"payload_too_large","id":"rX"} and auto-drop pending upload. Per-user cooldown exceeded yields {"t":"error","code":"cooldown","retryMs":9000}. NSFW flag trip (simple VAD+peak check server-side) yields {"t":"jukebox.reject","id":"rX","reason":"loudness"} only to sender.

9) Presence and UI hints
   - Concern: Avoid clutter; no overlay on center video.
   - Verify: On queue length change, relay broadcasts {"t":"jukebox.badge","count":K}. Clients reflect a small crayon badge in chrome. On play, also broadcast {"t":"jukebox.marquee","text":"Som da galera: Vaia — Ana"}. Assert messages and fields.

Acceptance criteria
- A viewer can submit a 2–8s clip and see it appear in the shared queue with correct metadata and initial vote of 1 (self). Probe: request -> accepted -> queued with lenMs and pos=0.
- Multiple viewers can vote a request up and see its updated vote count and reordering reflect via jukebox.update messages. Probe asserts duplicate_vote for repeats.
- When enabled, the next queued item auto-plays; all clients receive jukebox.play with future atMs, then a sequence of jukebox.audio frames followed by jukebox.stop: reason=eof. Probe asserts monotonic seq and timely arrival.
- During playback, clients duck main audio by -8 dB and restore within 50ms of jukebox.stop. Probe inspects broadcast duckDb and that a stop occurs.
- Publisher controls work: skip immediately stops current, advances to next, and emits jukebox.next. Mute prevents new jukebox.play broadcasts while value=true. Disabling clears queue and stops now. Probe asserts message order.
- Upload budget and cooldown enforced: payload_too_large, cooldown errors are returned appropriately; rejected uploads do not create queued items. Probe attempts oversize and rapid submissions.
- Legacy clients remain stable: they ignore new t messages, and standard stream/watch still functions. Probe runs legacy handshake and confirms no disconnect on unknown t.
- No UI elements are drawn over the center video; all observable states come via the badge/marquee messages only. Probe verifies only badge/marquee types are sent for UI hints, no video overlay commands exist.

Risks
- Audio drift or perceived desync versus the main stream if clients schedule poorly; mitigated by atMs and short clip lengths.
- Residential uplink strain from extra audio; mitigated by small opus, hard maxBytes, and per-user cooldown.
- Abuse or low-quality mic spam; mitigated by short durations, vote-gated prominence, and quick publisher skip/mute.
- Complexity of a second audio lane in clients using WebCodecs output; require careful mixing without touching the encoded main audio.

Effort
M (protocol, relay mixer, opus framing, basic UI, guardrails)
