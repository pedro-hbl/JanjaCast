[opus -> claude-opus-5 via TrustBridge]
# Issue: "Chama a Galera" — Ephemeral Watch-Party Invite Pings

## Title
**Chama a Galera** — one-tap re-invite pings that wake up idle/AFK friends when a stream goes live

## Pitch (user language)
> "Você tá ao vivo mas metade da galera nem viu. Aperta **Chama a galera** e todo mundo que tá no server (mas não na Activity) recebe um ping — quem quiser entra num toque."

The publisher (or any watcher) can fire a single, rate-limited "the TV is on!" ping to server members who aren't yet in the room, turning a lonely stream into a full couch without anyone leaving the Activity to DM friends.

## Why now
The whole Brazilian moment is **assistir junto** — but a stream is only a watch-party if people actually show up. Right now getting friends in means someone alt-tabs to type "entra aí" in text chat, which breaks the two-surface flow and kills the "zero-decision" magic. Discord's screen-share suspension means these groups have *no muscle memory* for gathering here yet; a built-in gather primitive is the difference between "Pedro is streaming alone" and "the room fills up in 30 seconds."

## Scope / Non-goals
**In scope:**
- A room-level "invite pulse" broadcast: relay records who's present, computes who's *absent but eligible*, and emits a structured invite event.
- Rate-limited, deduped, TTL'd invites (guardrails over knobs — one shared cooldown per room).
- A crayon "toast/banner" surface **outside** the video frame for anyone who receives it.
- pt-BR / en-US strings.

**Non-goals:**
- No push notifications / DMs / OS-level alerts (no external infra, respects single-process relay). The ping lands *inside Discord* only for members who have the Activity/server open.
- No persistent invite log or analytics dashboard.
- Nothing rendered over the center video (banner is chrome-only).
- No membership-source-of-truth work (uses roster presence the relay already has; the deeper "room membership verification" backlog item is separate).

## Lane (why this, PM #pm1)
No generic PM picks *audience acquisition inside the room* — they'd polish cinema mode or ship VOD. But the load-bearing risk right now isn't features, it's **cold rooms**. I'm shaping the growth-loop primitive: a stream that recruits its own audience. That's the lane.

## Implementation plan (small steps, each with a probeable Verify)

**Step 1 — Relay tracks "seen this session" set per room.**
Concern: know who *could* be pinged (previously present, now absent) vs. never-here.
Verify: probe connects client A, disconnects it, reconnects client B. Server-internal state exposed via a debug `room_state` reply lists A in `absent_members[]` and B in `present_members[]`. Assert `absent_members` contains A's user id.

**Step 2 — Define `invite_pulse` client→server control message.**
Concern: a single command triggers the gather; carries only `{ type: "invite_pulse" }` (no target list — server computes).
Verify: probe (as publisher) sends `invite_pulse`; server responds to sender with `invite_pulse_ack { accepted: true, cooldown_ms }`. Assert `accepted === true` and `cooldown_ms` is a positive integer.

**Step 3 — Relay computes recipients and broadcasts `invite_ping`.**
Concern: fan-out only to eligible absent members, not to people already in the room.
Verify: connect A + B (present), disconnect A. B fires `invite_pulse`. Reconnect A on a fresh socket that the harness treats as a "server member" channel; assert A receives `invite_ping { room_id, from_user, watcher_count }` and B (present) receives **no** `invite_ping`. Assert `from_user` equals B's id and `watcher_count === 1`.

**Step 4 — Shared room cooldown enforced server-side.**
Concern: guardrail against ping spam (one pulse per room per window, regardless of sender).
Verify: B fires `invite_pulse` (accepted). Immediately A fires `invite_pulse`. Assert A's `invite_pulse_ack` has `accepted: false` and `reason: "cooldown"` and `cooldown_ms > 0`. Assert no second `invite_ping` reaches recipients.

**Step 5 — Coalesce duplicate recipients across rapid pulses.**
Concern: after cooldown, a member who *just declined/ignored* isn't re-hammered within a longer per-recipient dedupe TTL.
Verify: pulse fires, TTL set. After room cooldown expires, fire again; assert `invite_ping` recipient list (observable via which sockets receive it) **excludes** any user pinged inside the per-recipient TTL, and `invite_pulse_ack.recipients_count` reflects the reduced number.

**Step 6 — Client renders crayon invite banner (chrome only, never over video).**
Concern: recipient sees a dismissible banner with one CTA; layout lives in the lobby/roster region.
Verify: committed component test asserts banner mounts outside the `<video>`/canvas stage container (DOM assertion: banner is **not** a descendant of `.stage-video`), shows pt-BR string `"{from_user} tá ao vivo — bora assistir?"` and a `"Entrar"` button. Assert clicking `"Entrar"` emits the existing join/launch intent.

**Step 7 — Auto-expire the banner and emit `invite_expired`.**
Concern: stale invites don't linger; state stays clean.
Verify: after `invite_ttl_ms`, server emits `invite_expired { room_id }` to recipients who didn't join. Probe asserts the message arrives once per un-joined recipient and that a subsequent `invite_pulse` from the same room is now `accepted: true` (recipient re-eligible after expiry).

**Step 8 — Egress-safe: pulse never fires when room is at max capacity.**
Concern: respect the ~25 cap and egress budget (don't invite into a full room).
Verify: harness fills room to capacity, fires `invite_pulse`; assert `invite_pulse_ack { accepted: false, reason: "room_full" }` and zero `invite_ping` broadcasts.

## Acceptance criteria (each maps to a probe scenario / test)
1. `invite_pulse` from any connected client returns `invite_pulse_ack` with `accepted` + `cooldown_ms`. *(Step 2)*
2. `invite_ping` reaches only eligible absent members; present members receive none; `from_user` and `watcher_count` are correct. *(Step 3)*
3. A second `invite_pulse` inside the room cooldown is rejected with `reason: "cooldown"` and produces no new pings. *(Step 4)*
4. A recipient pinged inside the per-recipient dedupe TTL is excluded from the next eligible pulse's recipient set. *(Step 5)*
5. The invite banner renders in room chrome and is **never** a descendant of the video/canvas stage container; CTA emits the join intent; string is pt-BR/en-US correct. *(Step 6)*
6. `invite_expired` is delivered to non-joiners after TTL, and the room becomes eligible for a fresh pulse afterward. *(Step 7)*
7. `invite_pulse` at max capacity is rejected with `reason: "room_full"` and emits zero pings. *(Step 8)*

## Risks
- **Spam / social annoyance** → mitigated by shared room cooldown (Step 4) + per-recipient dedupe TTL (Step 5). Tune defaults conservatively; no user-facing knob.
- **False "absent" set** → relay only knows sockets it has seen this session, not the full server roster; framed honestly in copy ("chama quem tá por perto"), not promised as "everyone." Deeper roster truth deferred to the membership-verification backlog item.
- **Iframe reach limit** → recipients only see the ping if they have the Activity/server surface open; we do **not** claim OS push. Acceptable — matches the "friends already hanging in the server" reality.
- **Abuse via non-publisher pulses** → cooldown is room-scoped so a watcher can't out-spam; if needed, publisher-only can be gated later without wire changes.

## Effort
**M** — server-side presence-diff + cooldown/dedupe state and 3 new control messages are the bulk; client banner is small and reuses existing lobby/roster crayon components. No new infra, no video-path changes.
