# Fix: the companion-tab wait is a dead end

**Status:** shaped, ready to build
**Area:** `web/src/App.tsx` (companion block only), `web/src/discord.ts`, `web/src/i18n.ts`, `web/src/theme.css`
**Effort:** one sitting (~4–6 h incl. the two-window repro)
**Collision note:** Wave B is editing `App.tsx` / `SharePage.tsx` in worktrees. Every
change below is written to be **additive** — one new derived signal, one new `<Show>`
branch inside the existing `companionOpened` fallback, plus one changed boolean in the
footer's `Show`. Nothing in the roster, stage, stinger, player or fullscreen code moves.

---

## 1. The problem

The owner clicked **Compartilhar tela** in a live Discord call with three
participants. The stage flipped to `BrowserTabDoodle` + *"Comece a transmitir na
aba nova."* and stayed there. That screen is shown for **four different
situations that have nothing in common**, and it cannot be left.

Reproduced locally (anon relay on `:8102`, the Activity loaded inside an iframe
with `allow="display-capture 'none'"` so `captureAllowed()` is false, i.e. the
real Discord condition):

| # | Situation | What the Activity shows | Reproduced |
| - | --------- | ----------------------- | ---------- |
| A | `window.open` blocked — returned `null`, no throw. **No tab exists.** | tab doodle + "start in the new tab" | yes — iframe sandboxed without `allow-popups` |
| B | Tab opened and **joined the relay** (`<id>:tab` in `room_state`), user has not pressed Start | **byte-identical to A** | yes — joined `<id>:tab` over WS; DOM diff vs A: none |
| C | Discord's "you're leaving Discord" dialog **dismissed** — `openExternalLink` resolves `{opened:false}` | **byte-identical to A** | not reproducible without the Discord client; proven from the SDK contract (§2.1) |
| D | Share finished, companion tab **closed entirely** | **still** the tab doodle, forever | yes — `leave_stage` + socket close; the hero CTA never returns |

In A/B/C/D there is no error text, no timer, and no in-scene way out. `roster`
still reads **1 na sala** in B because `baseId()` collapses `<id>:tab` onto the
person's own row — so even the sidebar hides the one fact the relay knows.

---

## 2. Root causes, ranked

### 2.1 `openExternal` throws away the only failure signal there is — highest

`web/src/discord.ts:40`

```ts
export async function openExternal(url: string): Promise<void> {
  if (sdkInstance) {
    await sdkInstance.commands.openExternalLink({ url });   // ← return value dropped
  } else {
    window.open(url, "_blank", "noopener");                 // ← null return dropped
  }
}
```

Both branches fail **silently and without rejecting**:

- `openExternalLink` resolves `Promise<{ opened: boolean | null }>`
  (`node_modules/@discord/embedded-app-sdk/output/commands/openExternalLink.d.ts`).
  The response schema is
  `fallbackToDefault(objectType({ opened: booleanType().or(nullType()) }).default({ opened: null }))`
  — so **dismissal is `opened: false`, not a rejection**, and `null` is the
  "old client, don't know" fallback. The current code cannot tell the three apart.
- A blocked `window.open` returns `null`. Verified in the repro:
  `windowOpenReturned: "null (silently blocked, no throw)"`, `errorText: null`.

`openCompanion` then runs `setCompanionOpened(true)` unconditionally
(`App.tsx:436`), which is what makes A and C indistinguishable from B.

### 2.2 The relay already knows the phase; the UI never asks — second

The Activity receives `room_state` containing `<id>:tab` the moment the companion
tab joins (verified: `welcome:{selfId:"uh77h228:tab"}` →
`room_state:[{userId:"uh77h228"},{userId:"uh77h228:tab", username:"owner (sharing)"}]`),
and `stage_state` when it takes the stage. The UI distinguishes only
`ownsStage()` (→ the live scene, which works fine). Everything before that
collapses into one boolean.

Detectable phases, all already on the wire:

| Phase | Signal available today |
| ----- | ---------------------- |
| opened, not joined | no participant whose `userId === \`${baseId(selfId())}:tab\`` |
| joined, not capturing | that participant exists, `ownsStage()` false |
| capturing | `ownsStage()` true — already rendered |
| dismissed / blocked | `openExternal` return value (once §2.1 is fixed) |

### 2.3 `companionOpened` is a one-way latch — third

`setCompanionOpened` is called in exactly one place and only ever with `true`.
Once set, `!live() && companionOpened()` is permanent for the rest of the
session: cause D. The hero `.scene-cta` never comes back; the only remaining
affordance is a footer button (`App.tsx:750`) whose label is the *identical*
string `t("stage.shareScreen")`. It is a retry that does not look like one, in a
place the eye is not on.

### 2.4 No timeout — fourth

There is no timer anywhere in the companion path. A tab that never opens leaves
the screen unchanged indefinitely.

### 2.5 Adjacent (out of scope, note only)

Share tokens live 10 min (`internal/server/server.go:284`). If the Discord
confirmation dialog sits unanswered past that, the tab loads with an expired
token → join closed `1008` → `SharePage` status `unauthorized` → **Start is
disabled and no message is shown**, because `share.expired` renders only under
`when={capture() && …}` (`SharePage.tsx:239`). Worth its own issue. It is *not*
a reason to widen this one — but it *is* the reason the retry below must
re-mint (§3, step 4).

### 2.6 Stars are 9 px of ink (cosmetic, ships with this)

Measured in the repro at a 1280 px viewport:

- `.scene-star` computed width **16 px** — `clamp(10px, 2vw, 16px)` is pinned at
  its max for any viewport ≥ 800 px, and at its **10 px floor** below 500 px.
- `StarDoodle`'s path bbox is `9 × 11` inside a `16 × 16` viewBox → the ink fills
  only **56 % × 69 %** of the box. Rendered ink: **9.0 px wide**, stroke 1.3 px.
- Opacity cycles **0.25 → 0.80**.

Against its neighbours: sun 124 px, smallest cloud 64 px. The star's ink is
**7 % of the sun** and **14 % of the smallest cloud** — below the "check it at
its smallest real size" bar in design.md § 6. They read as dust on the paper.

---

## 3. The change

### Step 1 — make the failure detectable (`discord.ts`, no collision)

```ts
/** true = opened, false = the user dismissed Discord's confirmation (or a
 *  popup blocker ate window.open), null = old client, can't tell. */
export async function openExternal(url: string): Promise<boolean | null> {
  if (sdkInstance) {
    const { opened } = await sdkInstance.commands.openExternalLink({ url });
    return opened;
  }
  return window.open(url, "_blank", "noopener") !== null;
}
```

*Verify:* in the repro harness (sandbox without `allow-popups`) the dev branch
returns `false`. No other caller exists — `grep openExternal web/src` returns
`discord.ts` and `App.tsx:435` only.

### Step 2 — a phase signal (`App.tsx`, new block beside `companionOpened`)

Replace the single boolean with a small state machine. Keep the name
`companionOpened` as a derived alias if Wave B references it, so the diff stays
local:

```ts
type CompanionPhase = "idle" | "opening" | "late" | "joined" | "failed";
const [phase, setPhase] = createSignal<CompanionPhase>("idle");
const [openedAt, setOpenedAt] = createSignal(0);

/** The companion tab is a *connection*, not a guess: the relay puts it in
 *  room_state as "<me>:tab" the instant it joins. */
const companionJoined = () => {
  const me = session()?.selfId();
  if (!me) return false;
  const tabId = `${baseId(me)}:tab`;
  return (session()?.participants().participants ?? []).some(
    (p) => p.userId === tabId,
  );
};

const companionPhase = (): CompanionPhase =>
  companionJoined() ? "joined" : phase();

const companionOpened = () => companionPhase() !== "idle";
```

`baseId` already exists at `App.tsx:69`. `selfId()` and `participants()` are
already public on `Session`.

In `openCompanion`, after the `await`:

```ts
const opened = await openExternal(url.toString());
setOpenedAt(Date.now());
setPhase(opened === false ? "failed" : "opening");
```

Promote `opening → late` after 20 s from a 1 s interval, cleared in the existing
`onCleanup` alongside `statsTimer` / `paintTimer`:

```ts
const lateTimer = setInterval(() => {
  if (phase() === "opening" && Date.now() - openedAt() > 20_000) setPhase("late");
}, 1000);
```

**Cause D closes here too:** when `ownsStage()` goes false *after* having been
true, reset `setPhase("idle")` so the hero CTA comes back. One `createEffect`
mirroring the pattern `SharePage.tsx:140` already uses.

### Step 3 — one `<Show>`, four faces (`App.tsx`, inside the existing fallback)

The `!live()` branch keeps its structure; only the `companionOpened()` side gains
a `<Switch>`. design.md § 5.9 caps the scene at **one line of words**, so each
phase changes *the sentence*, not the amount of text:

| Phase | Drawing | Line (new i18n keys, en + pt-BR) |
| ----- | ------- | -------------------------------- |
| `opening` | tab doodle, arrow bobbing (today's `.scene-nudge`) | `stage.companionOpening` — "Abrindo a aba de transmissão…" |
| `late` | tab doodle, arrow **still**, doodle tilted/dimmed | `stage.companionLate` — "A aba não abriu? Abre de novo." |
| `joined` | tab doodle, **green button lit + arrow pointing at it** | `stage.companionOpen` (existing string, now only shown when it is true) |
| `failed` | tab doodle dimmed, `--angry` accent | `stage.companionFailed` — "A aba não abriu." |

Rules to respect (design.md § 5.9 / § 8):
- The phase must be legible **standing still** — the sentence and the lit/unlit
  green button carry it; the arrow's motion only reinforces. "Don't add an
  animation that carries information on its own."
- Add `@media (prefers-reduced-motion: reduce)` so the arrow rests.
- Existing hooks to drive from CSS: `.scene-tab-arrow` (`theme.css:1591`) and the
  green-button path in `BrowserTabDoodle` (`doodles.tsx:575`) — give it a class
  the way `SceneTv` already does with `.scene-tv-nub`, and switch it from a
  `.stage-scene--waiting-joined` modifier. No new SVG.

### Step 4 — the retry affordance

Put a `.scene-cta`-styled **"Abrir de novo" / "Open again"** button in the
waiting scene for `late` / `failed` (and, quietly, `opening`), and change the
footer's guard from `when={live() || companionOpened()}` to `when={live()}`.

That one-boolean footer change is what keeps design.md § 5.1's *one `--go` per
screen* true — the scene's button becomes the screen's only `--go`, exactly as
`.scene-cta` already is in the `idle` state. It also removes the duplicate,
identically-labelled footer button that reads as the same action.

**The retry must call `openCompanion(id)` again.** It already POSTs
`/api/share-token` on every call, so a fresh 10-minute token is minted per
attempt. Do **not** memoize the built URL, do not stash `shareToken` in a
signal, do not reuse `url` — a stale token is a `1008` and a silent dead end in
the companion tab (§2.5). Add a comment saying so at the mint site.

Re-opening while an older tab is still connected is safe: the relay supersedes
the previous `<id>:tab` (`relay_test.go:258–298`).

### Step 5 — the stars (`theme.css` only)

```css
.scene-star {
  width: clamp(20px, 3.2vw, 34px);   /* was clamp(10px, 2vw, 16px) */
  opacity: 0.75;                      /* was 0.55 */
}
@keyframes scene-twinkle {
  0%, 100% { opacity: 0.5;  transform: scale(0.85) rotate(-6deg); }  /* floor was 0.25 */
  50%      { opacity: 0.95; transform: scale(1.1)  rotate(8deg); }   /* peak was 0.8   */
}
```

That takes the ink from **9.0 px → 19.1 px** at the top of the clamp and the
stroke from 1.3 px → 2.8 px, landing the star between the smallest cloud (64 px)
and nothing — a sparkle, not dust.

*Optional, only if `doodles.tsx` is free:* `StarDoodle`'s viewBox has ~44 %
dead margin. Tightening it to `viewBox="2.8 1 10.4 12"` gains ~1.8× ink at the
same CSS box, and would let the width bump be smaller. CSS-only is the safe
path while Wave B is in flight; take the viewBox only as a follow-up.

---

## 4. Acceptance criteria

1. **A ≠ B.** With `window.open` blocked (sandboxed iframe, no `allow-popups`),
   the stage shows the *failed* face within one frame — different sentence,
   different drawing — and never shows `stage.companionOpen`.
2. **B is true when it says it is.** `stage.companionOpen` renders **only** while
   a participant with `userId === \`${baseId(selfId())}:tab\`` is in `room_state`.
   Verifiable by joining that id over a bare WebSocket, as in the repro.
3. **C.** With `openExternal` stubbed to resolve `false`, the stage shows the
   *failed* face. With it resolving `null`, the stage shows *opening* (an old
   Discord client must degrade to the timeout path, never to a false failure).
4. **Timeout.** A tab that never joins flips to the *late* nudge at 20 s ± 2 s,
   and the nudge carries the retry button.
5. **Retry re-mints.** Clicking "Abrir de novo" issues a **new**
   `POST /api/share-token` (one per click, visible in the relay log) and opens a
   URL whose `token` differs from the previous attempt's.
6. **D is gone.** After a companion share ends and the tab disconnects, the
   scene returns to the hero `.scene-cta`.
7. **One `--go`.** No screen renders two `.crayon-btn--go` at once (grep the
   rendered DOM in each of the five states).
8. **Both languages.** Every new key exists in `en` and `pt-BR` — `tsc` enforces
   it. Check each new line at 440 px on the dark ground; pt-BR runs 20–30 %
   longer and `.scene-line` is capped at `26ch`.
9. **Stars.** `.scene-star` computed width ≥ 20 px at a 1280 px viewport;
   minimum animated opacity ≥ 0.5.
10. **Reduced motion.** Under `prefers-reduced-motion: reduce` every phase is
    still distinguishable with all animation stopped.
11. `cd web && npm run build` clean (tsc strict + vite); `go test ./...` untouched.

## 5. Out of scope

- The `/share` expired-token dead end (§2.5) — separate issue.
- Any change to the roster's `baseId` collapsing. Showing the tab as a second
  row would be a worse fix than the phase-aware scene.
- Anything on `SharePage.tsx` beyond reading it.

## 6. Repro recipe (for whoever builds it)

```sh
go build -o /tmp/jc.exe ./cmd/janjacast
cd web && npx vite build --outDir /tmp/webdist --emptyOutDir
JANJACAST_ALLOW_ANON=1 JANJACAST_ADDR=:8102 JANJACAST_DEV_WEB_DIR=/tmp/webdist /tmp/jc.exe
```

Serve a harness page from `/tmp/webdist` that embeds `/` in an iframe with
`allow="display-capture 'none'"` (this is what makes `captureAllowed()` false —
`allow=""` does **not**, because a same-origin frame's default allowlist is
`self`). Add `sandbox="allow-scripts allow-same-origin allow-forms"` to
reproduce the blocked-popup path. To reproduce "joined but not capturing"
without a second tab: open a WebSocket to `/ws`, `join` the room to read the
Activity's `userId` out of `room_state`, `POST /api/share-token` with that
`userId`, then `join` a second socket with the returned `shareToken` — the relay
assigns it `<userId>:tab`. Send `take_stage` on it to reach the live phase.
