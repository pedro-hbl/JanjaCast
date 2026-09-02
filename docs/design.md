# JanjaCast design system

The contributor reference for how JanjaCast looks and why. If you are adding
a control, an icon, or a screen, read § *Component inventory* and § *Adding to
the system*; everything else is background.

Source of truth is the code, not this document:

| Layer                       | File                |
| --------------------------- | ------------------- |
| Tokens, components, layout  | `web/src/theme.css` |
| Icons, drawings, wordmark   | `web/src/doodles.tsx` |
| Favicon (separate 16px cut) | `web/index.html`    |
| README lockup (standalone)  | `docs/lockup.svg`   |
| Every user-facing string    | `web/src/i18n.ts`   |

Copy is a design surface here and it ships in two languages — en-US and
pt-BR, with Brazilian Discord users as the primary audience. Terminology,
register and the length budget are in `docs/i18n.md`.

---

## 1. Why crayon

### The problem the identity solves

A Discord Activity does not get a title bar, a browser chrome, or a landing
page. It is dropped into an iframe inside Discord's own dark UI, surrounded by
Discord's typography, Discord's greys and Discord's blurple. Every Activity
inherits that frame, and most Activities respond by adopting the host's visual
language — dark neutral panels, a saturated accent, rounded rectangles. The
result is that a user glancing at the window cannot tell where Discord ends and
the app begins, and cannot tell one Activity from another.

So the identity has one job before it has any others: **be unmistakably not
Discord chrome, in a quarter of a second, at panel size.** Differentiation here
is not vanity — it is wayfinding.

### Why *this* answer

Several directions would achieve separation. The crayon direction was chosen
because it also encodes what the product *is*:

- **The product is casual.** JanjaCast is friends watching one person's screen
  in a voice call — not a webinar, not a conference bridge, not a support
  session. A hand-drawn identity sets the correct expectation for what happens
  when you click *Share screen*: something informal, interruptible, and
  low-stakes. "Take the stage", "Kick pedro off the stage?", "Yeah, my turn"
  are the voice this identity licenses; they would read as unprofessional
  under a corporate skin and read as friendly under this one.
- **Crayon has a built-in contrast rule.** Wax crayon is opaque, high-chroma
  and always outlined by the pressure of the tip. That translates directly into
  UI that *has* to carry heavy dark outlines and saturated fills — which is
  exactly what survives being shrunk into a small panel on a dark ground.
  The aesthetic and the legibility requirement point the same way.
- **It leaves the video alone.** The one thing that must never be decorated is
  the picture. A maximalist identity that lived in gradients and glass would
  bleed into the stage; an identity made of *frames and margins* can be loud
  around the edges and silent in the middle. See § *The stage is sacred*.

### What we are not doing

This is a crayon drawing, not a "playful startup". No pastel gradients, no
blobs-as-decoration, no rounded-everything, no 3D emoji illustrations. The
reference is a seven-year-old's drawing on construction paper: flat colour,
visible stroke, crooked corners, nothing measured.

---

## 2. The two grounds

JanjaCast renders in two places and they get two different papers.

|                | **Activity** (`/`)                   | **Share** (`/share`)             |
| -------------- | ------------------------------------ | -------------------------------- |
| Where          | Discord's iframe                     | The user's own browser tab       |
| Ground         | Dark construction paper `#171a24`    | Cream sheet `#f7f1e1` + tooth    |
| Job            | Watch someone's screen               | Pick a source and start          |
| Mood           | Lights down, the picture is the show | Lights up, a form on a desk      |
| Decoration     | Almost none — frame only             | Sun, grass strip, tilted card    |

This is one theme, not two. `.share-page` re-declares the **semantic** tokens
(`--ground`, `--surface`, `--text`, `--outline`, `--focus`, …) and every shared
class recolors itself. The **crayon-box** tokens (`--crayon-blue`, `--grass`,
`--angry`, …) never change: the same crayons, a different sheet of paper.

> **Rule.** A new component is written once against semantic tokens. If you
> find yourself writing `.share-page .my-thing { color: … }` to fix a colour,
> the component is reaching past the token layer — fix the token instead.
> (The two legitimate exceptions are `--chevron` and `--crayon-streaks`, which
> are *images*, and CSS images cannot take `currentColor`.)

### The stage is sacred

The video canvas gets a wobbly crayon frame and nothing else. No overlay, no
tint, no watermark, no border-radius on the picture itself. Everything that
must appear over the video (zoom readout, fullscreen button, stats) is:

- pinned to a corner, never centred;
- on a translucent ink wash so it never competes with the frame;
- transient or low-opacity by default.

In theater and fullscreen the crayon frame is removed entirely (`margin: 0;
border: none`). The identity yields to the content, always.

---

## 3. Tokens

### 3.1 Colour

**The crayon box** — constant across both grounds. These are the fills.

| Token                  | Hex       | Used for                                       |
| ---------------------- | --------- | ---------------------------------------------- |
| `--crayon-blue`        | `#5d9be0` | The system colour: logo screen, pressed states |
| `--crayon-blue-deep`   | `#3e7dc9` | The stage frame, the /share title underline    |
| `--grass`              | `#5cb53f` | Go: *Share screen*, *Start sharing*, the slider thumb |
| `--grass-deep`         | `#3f8f2a` | Grass-strip texture only                       |
| `--angry`              | `#d93a3a` | Live / stop / destructive. **Fill, not text.** |
| `--yellow`             | `#f2c230` | Attention on dark: focus ring, roster underline |
| `--pink`               | `#e86aa6` | Decoration only (flowers)                      |
| `--redorange`          | `#e85d3a` | Decoration only                                |
| `--purple`             | `#8b5fc7` | Decoration; focus ring on cream                |
| `--path-brown`         | `#9c6b3f` | Reserved                                       |

**Semantic** — re-declared by `.share-page`.

| Token         | Activity  | Share     | Meaning                          |
| ------------- | --------- | --------- | -------------------------------- |
| `--ground`    | `#171a24` | `#f7f1e1` | The paper                        |
| `--surface`   | `#1e2231` | `#fffdf3` | Header, footer, sidebar, cards   |
| `--surface-2` | `#272c3e` | `#f1e9d2` | Inset controls, pills, code      |
| `--text`      | `#f4efdd` | `#2b2a33` | Body text                        |
| `--muted`     | `#b3aea0` | `#6f6a5b` | Labels, hints, secondary         |
| `--outline`   | `#0b0d14` | `#26222e` | **The crayon line.** Every border. |
| `--angry-lit` | `#ff6b6b` | `#c22f2f` | Red **text** (see below)          |
| `--brand-a`   | crayon-blue | `#2f62a8` | Wordmark "Janja" — the screen  |
| `--brand-b`   | angry-lit | angry-lit | Wordmark "Cast" — the signal     |
| `--focus`     | yellow    | `#6b3fd4` | Focus ring                       |
| `--hover-wash`| chalk 10% | ink 8%    | Hover tint inside controls       |

**Three token pairs exist only because of contrast maths.**

- `--angry` (`#d93a3a`) is a great crayon red and a poor text colour: 3.5:1 on
  the dark surface, 4.45:1 on cream — both under WCAG 2.2 SC 1.4.3's 4.5:1.
  `--angry-lit` is the *text* red and moves in opposite directions on the two
  grounds (lighter on dark = 5.7:1, darker on cream = 5.5:1). Red borders and
  red fills keep using `--angry`.
- `--focus` is yellow on dark (11:1 against the surface) but yellow on cream is
  1.6:1 — effectively invisible, and SC 1.4.11 wants 3:1 for a focus
  indicator. On cream it becomes purple (4.5:1).
- `--brand-a` is the wordmark's blue and is **semantic, not a crayon**, for the
  same reason: `--crayon-blue` is 6.5:1 on the dark ground but 2.3:1 on cream,
  and `--crayon-blue-deep` still only reaches 4.1:1. The cream page moves it to
  a deeper ink (6.1:1). `--brand-b` just follows `--angry-lit`.

  Note the resulting split inside the lockup: the mark's antenna is `--angry`
  (a *fill*, which is allowed to be the full-chroma crayon) while the wordmark's
  "Cast" is `--angry-lit` (*text*, which is not). On the dark ground that makes
  the letters a touch lighter than the antenna. It is the contrast rule working
  as intended rather than an inconsistency, and at 20px it is not perceptible —
  but it is the one place the lockup carries two reds, so it is written down.

### 3.2 Type

Three roles, no external fonts. Discord's Activity CSP blocks external
requests, so every face must already be on the machine.

| Role       | Token         | Stack head                | Job |
| ---------- | ------------- | ------------------------- | --- |
| **Hand**   | `--font-hand` | Comic Sans MS → Chalkboard SE → Comic Neue → Bradley Hand → Segoe Print | Everything JanjaCast *says*: the wordmark, headings, buttons, labels, badges, stage copy, errors. |
| **Body**   | `--font-body` | Trebuchet MS → Segoe UI → system-ui | Prose and list rows: participant names, hints, status. |
| **Ledger** | `--font-num`  | ui-monospace → Cascadia Mono → SF Mono → Menlo → Consolas → DejaVu Sans Mono | Anything measured: fps, kbps, ms, Mbps, room codes. |

Notes on the choices:

- **Hand is Comic Sans, deliberately.** It is the only genuinely ubiquitous
  informal face (Windows and macOS both ship it), it is metrically forgiving,
  and its reputation is an asset here rather than a liability — the identity
  *is* "slightly unhinged". The fallback chain covers macOS (Chalkboard SE,
  Bradley Hand, Marker Felt), Windows (Segoe Print) and Linux distributions
  that carry the metric-compatible clones (Comic Neue, Comic Relief).
- **Body changed from `system-ui` to Trebuchet MS.** `system-ui` resolves to
  Segoe UI / SF Pro / Roboto — neutral UI grotesques designed to disappear.
  Next to a hand face they read as a *different application's* text. Trebuchet
  is humanist, slightly informal (the splayed M, the open apertures), present
  on every Windows and macOS install since the late nineties, and shares enough
  warmth with the Hand face that the two look like one voice.
- **Ledger is monospace and tabular.** Stats update once a second. Proportional
  digits make the header jitter on every tick; `font-variant-numeric:
  tabular-nums` is applied to `.stat-pill`, `.stage-stats` and `.share-live`
  so the numbers change without the layout moving.

**Never**: numbers in the Hand face (they are hard to read and they wobble);
prose in the Hand face longer than a sentence; the Body face on a button.

Scale — five steps, no more:

```
--step--1  12px    meta, stats
--step-0   13.5px  body, roster rows
--step-1   15px    buttons, labels, stage copy
--step-2   20px    wordmark
--step-3   26px    /share title
```

### 3.3 Wobble radii

Four recipes. Their whole purpose is that **neighbours never share one** — two
identical "hand-drawn" corners read as a computer pretending to be a hand.

| Token           | Shape                                     | Used on |
| --------------- | ----------------------------------------- | ------- |
| `--wobble-a`    | Big lopsided card corners                 | Primary buttons, `.share-card` |
| `--wobble-b`    | The mirror of `a`                         | The *stop* button, so it never matches the *go* button beside it |
| `--wobble-sm`   | Small crooked pill                        | Pills, tags, selects, the segmented group |
| `--wobble-blob` | A circle drawn badly                      | Slider thumb, the sharer's ring |

The stage frame and the stats overlay carry one-off literal radii — they are
single instances, not a family, and a token would imply reuse.

### 3.4 Texture

Three, all inline, all cheap.

- **`--crayon-streaks`** — a `repeating-linear-gradient` at −40° that lays waxy
  diagonal streaks over any filled surface. It is a *wash*, so it flips from
  white 9% on dark to black 5.5% on cream. Goes on buttons, pressed segments,
  select fields and the slider track. Never on text, never on the video.
- **`--scribble`** — the underline (see next section).
- **Paper tooth** — a 5px radial-gradient dot grid, `/share` only. The dark
  ground gets none: construction paper in a dark room has no visible tooth, and
  a dot grid at that contrast would just be noise.

### 3.5 The scribble underline

The house structural device. A wobbly crayon line under a name, `.u-scribble`.

```html
<span class="u-scribble u-scribble--yellow">in the room</span>
```

**One recipe, no size modifiers.** This is the rule that matters, because the
failure it prevents is the one the shipped design had: a wave tuned in pixels
under 20px type looks like a different hand when it is reused under 13.5px
type — same asset, mismatched amplitude, and the underline stops reading as
part of the drawing.

So both knobs are in `em`, off the underlined element's own font-size:

| Custom property | Value    | What it is                                    |
| --------------- | -------- | --------------------------------------------- |
| `--sc-w`        | `3.8em`  | Wavelength — one tile, four crests            |
| `--sc-h`        | `0.42em` | Amplitude box, and the element's padding-bottom |

Underline a 13.5px label and a 26px title with the same class and you get the
same hand at two distances. **A component that needs a different wave is not
this component.** Do not add `--sm` / `--lg` modifiers; do not override
`--sc-w` at a call site.

Mechanics: one SVG, painted through `mask` with `background-color`, so a single
asset serves every colour via `--scribble-ink`. Colour modifiers only:
`--blue` (default), `--yellow`, `--pink`, `--deep`.

The wave starts at `x=0` and ends at `x=72` on the same `y`, so repeated tiles
butt into a continuous line. **If you redraw it, keep the endpoints level** —
an inset start/end leaves a visible seam every wavelength.

`.error-text` shares the rule rather than copying it (`.u-scribble, .error-text`
declare the geometry together); it only picks its own ink. Anything else that
wants the underline should take the class, not re-implement the `::after`.

**Where it goes: names of places, one per region.**

| Region             | Underlined                  | Ink    |
| ------------------ | --------------------------- | ------ |
| Activity header    | the **whole lockup**        | blue   |
| Activity sidebar   | "in the room" (not the count) | yellow |
| /share card        | the **whole lockup**        | deep blue |
| Anywhere           | error text                  | red    |

Not on: body copy, buttons, participant names, hints, stats. If two things in
one region are underlined, one of them is wrong.

Two of those entries changed in the refinement pass and the reasons are in
§ 4 (the lockup) and § 5.5 (the roster).

---

## 4. The logo

The identity is three objects — mark, wordmark, scribble — and the whole job of
this section is that they are **one drawing**, not three things standing near
each other. That is the specific failure the first version shipped with, and
everything below is the correction.

### 4.1 The mark

A crooked crayon television **with a face**, standing on two stubby legs, one
bold red antenna cocked off its top-right corner. `CastMark` in `doodles.tsx`.

The concept is literal on purpose — a child drawing "a thing that broadcasts"
draws a TV with signal coming off it — and the two halves of the name land on
the two halves of the drawing: **Janja**, the blue screen; **Cast**, the red
signal. Blue is chrome, red is live; the mark says so before any UI does.

#### Miniaturisation *is* the design

The mark is used at 28px in the header and 16px in a browser tab. It is never
used large. So the acceptance test is not "does it look good" — it is **"is it
still a character at 20px."** Three decisions come from that, and none should
be undone without re-testing at size:

- **The screen carries a face, not texture.** Two dot-eyes and a grin are four
  marks a reader's face-detection locks onto instantly. The old waxy glare
  streaks were fine detail, and fine detail is exactly what dissolves first:
  below ~24px they turned to grey mush across the blue field and the mark read
  as an indistinct blob. **Personality survives shrinking; texture does not.**
  The streaks are gone and are not coming back.
- **One antenna, not concentric waves.** Two arcs close their gap and read as a
  red smudge (this was already true of the old drawing's nub-plus-arc). A
  single fat diagonal stem merging into a chunky ball breaks the silhouette
  out of its bounding box and stays one legible red gesture at every size.
- **Fewer, heavier strokes.** 2.1–2.8 in a 24 viewBox, so nothing renders
  thinner than about 1.4px at 20px. The screen face is deliberately large and
  the legs are long enough to still read as two stubs at 24px.

#### The favicon is a different cut, not a copy

At 16px even this drawing softens, so `web/index.html` carries a **separate,
bolder cut**: every stroke thickened (2.6 box, 2.8 grin, 3.2 stem), fatter
eyes and ball, and **the legs deleted** — two 1px stubs cost pixels and read as
dirt at tab size. What survives is the face and the red diagonal, which is the
whole identity.

`CastMark` inherits `--crayon-blue`, `--angry` and `--outline` from CSS, so it
re-inks itself on the cream page. The favicon cannot — a data URI cannot see
custom properties — so its colours are hard-coded to the dark-ground values.

> **If you change the mark, change it in both places**, and re-render at 16 /
> 20 / 34. `CastMark` and the `<link rel="icon">` data URI are hand-kept in
> sync; there is no build step. `docs/lockup.svg` is a third copy — see § 4.4.

### 4.2 The wordmark — lettering, not typesetting

`Wordmark` in `doodles.tsx`. The Hand face is the raw material; the craft is
what is done to it. Picking a font and colouring two halves of it is a font
choice, not a wordmark, and that is what the first version was.

Every letter is its own span carrying three hand-tuned values:

| Property  | Range        | What it does                     |
| --------- | ------------ | -------------------------------- |
| `--wm-r`  | ±3°          | Rotation jitter                  |
| `--wm-y`  | ±0.09em      | Baseline bounce                  |
| `--wm-s`  | 0.96–1.05    | Size variance — uneven hand pressure |

They are applied with `transform` only, so the advance widths never change and
the word keeps the font's kerning while the drawing moves.

**The values are hand-tuned per glyph, never generated.** A formula produces
*regular* irregularity, and regular irregularity reads as a wobble filter
applied to type — which is more obviously mechanical than leaving it alone. If
you add a letter, pick its numbers by eye against its neighbours.

**The two-colour split is the mark's split, spelled.** `Janja` takes
`--brand-a` (the screen), `Cast` takes `--brand-b` (the signal). Cast is set at
0.9em and rides slightly higher, echoing how the antenna sits small and high
off the box. It is not decoration; it is the same idea twice.

`--brand-a` / `--brand-b` are **semantic** tokens, not crayons, because the
wordmark is *text* and has to clear 4.5:1 on whichever paper it lands on.
`--crayon-blue` is 6.5:1 on the dark ground but 2.3:1 on cream, and even
`--crayon-blue-deep` only reaches 4.1:1 — so `.share-page` moves the blue half
to a deeper ink (`#2f62a8`, 6.1:1) and the red half follows `--angry-lit` down
to `#c22f2f` (5.5:1).

An ink outline on the letters (`-webkit-text-stroke` + `paint-order`) was tried
and cut: on the dark ground the ink is the ground, so it did nothing where the
header actually lives, and pushed far enough to show it started closing the
Hand face's counters. The jitter, the bounce and the split carry the character
without it.

The per-letter spans would make a screen reader spell the name out, so the
accessible name is a single `.u-sr-only` word and the letters are `aria-hidden`.

### 4.3 The lockup

Mark, wordmark and scribble, composed as one object. `.logo` in `theme.css`,
used by **both** the Activity header and the `/share` title — one class, one
composition, two sizes.

1. **The scribble runs under the whole lockup**, mark included. It is the
   ground the television stands on and the line the word is written on, and it
   is what ties three objects into one gesture. *This reverses the old "never
   underline the mark" rule* — under that rule the wave was a separate
   decoration parked beside a logo, which is exactly how it read.
2. **The mark stands ON the line.** `align-items: flex-end` bottoms it out with
   the text box; `margin-bottom: -0.2em` then plants its legs in the wave so it
   is standing rather than floating.
3. **Everything is `em`, off the lockup's own font-size** — gap, mark offset,
   wavelength, letter bounce. Set `font-size` and the whole lockup follows;
   the header and the `/share` title are one artwork at two sizes, not two
   tunings to keep in sync. Nothing in the lockup is a px nudge.
4. **The mark is 1.4× the font-size.** 20px type → `<CastMark size={28} />`;
   26px type → `size={36}`. That ratio is what makes the screen face optically
   match the cap height once the antenna is discounted, and what makes the
   `-0.2em` plant land correctly at both sizes. Drift off it and the mark
   starts floating above the wave or sinking behind it.
5. **Clear space** is the lockup gap, `0.4em` of the wordmark size, on all
   sides. The header's 12px flex gap and 16px padding clear it at 20px.

| Site            | font-size    | mark | Ink       |
| --------------- | ------------ | ---- | --------- |
| Activity header | `--step-2` 20px | 28 | blue      |
| `/share` title  | `--step-3` 26px | 36 | deep blue |

The lockup tilts −1.5° (header) / −1° (title) and the mark counter-rotates
+2.5° so it never looks glued on.

On `/share`, "screen sharing" sits on a second line in lowercase muted Hand
type. It is a *caption*, not part of the lockup; it never travels with the mark.

The mark stands alone at 16–32px (favicon, and any future compact context).
**The wordmark never appears without the mark.**

### 4.4 The lockup outside the app

`docs/lockup.svg` is the README masthead. It is the same composition, with
three differences the medium forces:

- **It carries its own cream paper.** GitHub renders it through an `<img>`, so
  it lands on a white *or* a near-black README with no way to know which, and
  a dark crayon outline vanishes on `#0d1117`. Its own sheet makes it
  theme-proof — and construction paper is on-brand anyway.
- **Literal hex, not tokens** — an `<img>`-rendered SVG cannot see the page's
  custom properties. It uses the cream-ground values.
- **The wave is one stretched span, not a tile.** No repeat, so no seam.

The wordmark stays live `<text>` in the Hand stack rather than converted to
paths, so it remains editable and matches the app wherever Comic Sans (or
Chalkboard, or Comic Neue) is installed. It is **one** text run — glyph
advances from the font, rotation from the `rotate` attribute, bounce from
`tspan dy` deltas, size variance from `tspan font-size`. Hand-placing each
letter at a guessed `x` was the first attempt and it collided on any machine
whose metrics differed from the guess. The wave's span is cut to the text's
*measured* right edge, not an estimated one.

---

## 5. Component inventory

### 5.1 Buttons — `.crayon-btn`

Hand face, 3px ink border, wobble-a corners, a hard 2×3px ink drop shadow, and
a −1° rest tilt. Hover swings to +1° and scales 4%; active drops 2px and kills
the shadow — the button is a physical object being pressed onto paper.

| Modifier         | Colour | Meaning                                      |
| ---------------- | ------ | -------------------------------------------- |
| `--go`           | grass  | Start something: *Share screen*, *Start sharing* |
| `--stop`         | angry  | End something. Uses `--wobble-b` so it never matches a `--go` button standing beside it. |
| `--big`          | —      | Size modifier for the primary action on `/share` |

Rules: **one `--go` per screen.** Never two `--go` buttons in a row (the
takeover modal pairs `--go` with `--stop` precisely so the choice is legible).
Destructive text is `#fff` with an ink shadow, not `--text`.

### 5.2 Segmented toggle — `.seg` / `.seg-btn`

**Use for a choice with exactly two crayons.** Two instances:

- **Framerate** (30 | 60), in three places: the Activity footer, the `/share`
  pre-flight form, and the `/share` mid-stream controls.
- **Language** (EN | PT), `.lang-seg`, in two: pinned right in the Activity
  header and in the top-left corner of the `/share` sheet. Same control, only
  the cell metrics change — 38px rather than 46px, 32px under 460px. Its two
  visible letters are an abbreviation, so each button carries the language's
  own name as its `aria-label`. See `docs/i18n.md`.

A binary choice does not deserve a dropdown: a select hides one of two options
behind a click and gives no read of the current value without focus. The
segmented control shows both, shows which is on, and is one tap either way.

Markup contract:

```html
<div class="field">
  <span class="field-label" id="x-label">Framerate</span>
  <div class="seg" role="group" aria-labelledby="x-label">
    <button type="button" class="seg-btn" aria-pressed={…} onClick={…}>30</button>
    <button type="button" class="seg-btn" aria-pressed={…} onClick={…}>60</button>
  </div>
  <span class="seg-unit">fps</span>
</div>
```

- State lives in `aria-pressed`, and the pressed style is selected off it
  (`.seg-btn[aria-pressed="true"]`). There is no `.is-active` class — the
  accessible state and the visual state cannot drift apart.
- Pressed fill is `--crayon-blue` with ink text (6.5:1). Blue, not yellow:
  blue is the system/chrome colour, yellow means *attention*, and a framerate
  choice is chrome.
- The focus ring is inset (`outline-offset: -4px`) because the group clips
  overflow.
- Buttons are ≥46×28px inside a 3px group border, clearing SC 2.5.8's 24×24.

**Three or more options stay a select.** Do not build a three-segment toggle.

### 5.3 Select — `.crayon-select`

For *Optimize for* and *Sound* — lists of three or more with long labels.
Both now live inside the `/share` **Advanced** disclosure (§ 5.10); the
default flow shows no select at all.

`appearance: none`, crayon streaks, ink border, wobble-sm corners, and a
hand-drawn chevron supplied per ground by `--chevron`. Hover tilts −0.6°.
`option` elements are painted with the surface tokens so the native popup at
least lands on our paper.

On `/share` the four fields share one right edge (`.share-card .fps-label,
.share-card .field { justify-content: flex-end }`) with a fixed 344px control
width. Ragged label edges against a straight control edge reads as a form; a
ragged control edge reads as a mistake.

### 5.4 Slider — `.crayon-range`

Volume. A crayon-streaked track with an ink border and a `--wobble-blob` grass
thumb. Vendor track and thumb pseudo-elements are written out separately for
`-webkit-` and `-moz-`: grouping them into one selector list makes the whole
rule invalid in both engines.

### 5.5 Presence

Three components carry "who is streaming", and they must agree.

**On-air badge — `.live-badge`** (Activity header). A wobbly red-outlined pill
holding `OnAirDot`, the label *On air*, and the publisher's name. The label is
uppercase, letter-spaced, in `--angry-lit`; the name is `--text` at normal
weight and truncates with an ellipsis, because the badge must not be able to
push the stats pill off the header.

**On-air dot — `OnAirDot`**. The scribbled dot plus the *mark's own* two
broadcast waves, so the live indicator and the logo are visibly the same idea.
The core breathes (`crayon-pulse`), the waves ripple outward on a stagger
(`crayon-wave`, `--far` delayed 0.22s). Both stop under reduced motion and the
drawing stays legible standing still.

**Roster heading — `.sidebar-title`**. `EyesDoodle` + the count + "in the
room", composed as one unit rather than three pieces at cramped spacing.

```html
<h4 class="sidebar-title">
  <EyesDoodle class="sidebar-title-icon" />
  <span class="sidebar-count">3</span>
  <span class="sidebar-count-label u-scribble u-scribble--yellow">in the room</span>
</h4>
```

- **The count is the information, so it gets the size** — `--step-2` (20px)
  against the label's `--step-0` (13.5px). Previously the number was set at the
  same weight as the words around it, which buried the one thing the heading
  exists to report.
- **Only the label is underlined.** Underlining the count too would make the
  wave change length every time somebody joins or leaves; anchoring it to the
  fixed words keeps the drawing still while the number moves. `tabular-nums` on
  the count holds the label's start position steady from 1 to 25 and beyond.
- **The three pieces share a baseline** (`align-items: baseline`), so the eyes
  rest on the same line as the count and the words instead of being vertically
  centred against a taller neighbour. They sit slightly proud of the numeral's
  cap, peering over it.
- **The wave scales itself** — it is the standard `.u-scribble`, and because
  that recipe is in `em` it comes out proportional to the 13.5px label with no
  per-site tuning. This is the amplitude mismatch from the shipped version.
- "in the room" is deliberately count-agnostic copy, so there is no
  pluralisation branch and 1 reads as well as 25.

`EyesDoodle` is drawn like the mark's face rather than like a line icon:
**opaque almond, ink pupil.** Outlined-with-matching-pupil is the obvious
drawing and it fails — at roster size the yellow rim and the yellow pupil close
their gap and the pair reads as two yellow dots. Filling the almond and
punching the pupil in `--outline` keeps hard contrast *inside* the shape, the
same bet `CastMark` makes on its screen.

**Roster rows — `.roster` / `.participant`**.

Rows are **people, not connections.** A user sharing from the companion tab is
present twice on the wire: as `<id>` ("pedro") and as `<id>:tab` ("pedro
(sharing)"). Rendering both would show two identical stick figures for one
person. `App.tsx`'s `roster()` collapses them on the base id, prefers the
person's own connection for the display name, and folds the `(sharing)` suffix
into a tag on that one row:

| Row state | Treatment |
| --------- | --------- |
| Anyone    | Blue stick figure, alternating ±tilt by row parity |
| **Sharing** | Figure turns `--angry-lit`, sits inside a wobbly red ring, name goes bold, and a red `MegaphoneDoodle` + "sharing" tag follows the name |
| **You**   | A muted "you" tag follows the name |

The tag sits **immediately after the name**, not flushed right. It is that
person's suffix, not a column.

### 5.6 Stats — `.stat-pill`, `.stage-stats`, `.share-live`

Ledger face, tabular figures, muted, quiet surface. Stats are the one place the
identity steps back completely: a person reading 4200 kbps is debugging, and
debugging is not the moment for personality.

### 5.7 Card — `.share-card`

A tilted sheet of paper: surface fill, 3px ink border, wobble-a corners, a
hard offset shadow, rotated −0.6°. Used for the `/share` panel **and** the
takeover modal — one paper object, two contexts. Inside `.app` it picks up the
dark tokens with no extra CSS.

### 5.8 Stingers drawer — `.stinger-drawer`

The one panel in the app. It slides over the **sidebar side** of `.app-main`,
never over the middle of the picture, and it is anchored to the main row so it
covers neither the header lockup nor the footer controls. Full behaviour and
API in `docs/stingers.md`.

Two things it adds to the inventory:

- **`.crayon-btn--chalk`** — a neutral crayon button (surface-2 fill,
  `--wobble-sm`). It exists because the *one `--go` per screen* rule is real:
  the footer already spends the grass crayon on *Share screen*, so every
  button inside the drawer is chalk.
- **`.stinger-chip`** — a small pressable chip carrying `aria-pressed`. Used
  where a thing has **several independent switches** (an asset is in the start
  pool, in the stop pool, and on/off). This is *not* `.seg`: a segmented group
  says "pick one of these", and pressing one of these must not release the
  others. Pressed is blue (chrome) except the master `on` switch, which is
  grass. Disabled assets also drop to 55% opacity and read `aria-pressed
  ="false"` — never colour alone.

### 5.9 Errors — `.error-text`

Hand face in `--angry-lit` with a red scribble underline. Errors in this app
lead with a glyph and say what to do (`✋ pedro took the stage.`,
`⛔ Session expired — go back to Discord and click Share screen again.`). They
do not apologise and they are never vague.

### 5.9 The stage scene — `.stage-scene`

An Activity with nothing on the canvas is a **drawing**, not a sentence: the
`SceneTv` standing in the grass (`--grass-art`) under `SunDoodle` and two
`CloudDoodle`s, on the construction-paper ground rather than the letterbox
black — black reads as *the video is broken*, paper reads as *this is a
drawing*. Three states share one backdrop:

| State | Centre of the scene | Words |
| ----- | ------------------- | ----- |
| Nobody live | set switched off + the oversized `.scene-cta` | the button's label |
| Companion tab opened | `BrowserTabDoodle` with a bobbing arrow | one line |
| You are live (`--live`) | the same set, switched on and rippling | one line |

Rules:

- **It only exists while the canvas is empty**, which is what keeps § *the
  stage is sacred* true: nothing here can ever appear over a picture.
- **The set stands on the grass.** Bottom-anchored, never centred — centred
  it floats in the sky and the drawing stops reading as a place. A button
  may stand *in* the grass; a line of words may not.
- **One line of text, maximum**, and it is `--text`, not `--muted`. Anything
  longer belongs somewhere that is not the stage.
- **The `.scene-cta` is the screen's only `--go`** (§ 5.1). While it is
  showing, the footer's Share button is suppressed; it returns the moment
  the stage has a picture or a companion tab to re-open.
- Hovering or focusing the CTA lights the set's nub and throws its waves —
  decoration that previews the button's own label, never information. The
  drawing means the same standing still.
- The set carries `max-height: 38vh` so a short panel scales the whole
  composition instead of clipping its top, and the weather is dropped below
  340px of viewport height (a short stage has no sky to put it in).

Joining a live stage gets `.stage-wait`: `ScribbleLoader` drawing itself on
paper, unmounted the instant a frame paints (the signal is the canvas's own
backing store — `player.ts` sizes it only when it actually draws).

### 5.10 Disclosure — `.crayon-details`

A dashed crayon tag over a dashed inset panel, for controls that already
have a right answer. `summary` carries its own focus ring (it is not in the
global focus selector list) and its own marker, a rotated `--chevron`.

**Only for settings whose default is right every time.** A control that a
person genuinely has to choose does not belong behind a disclosure — and a
control whose right answer is *always* the same should be deleted instead
(that is what happened to *Codec*).

### 5.11 Connection — `.conn-dot`

Transport state used to be the word `reconnecting` sitting in the Activity
header. It is `LinkDot` now, and it changes **shape** as well as colour so
it never rests on colour alone (§ 7):

| State | Socket | Drawing |
| ----- | ------ | ------- |
| `--live` | `open` | grass blob with an ink tick |
| `--wait` | `connecting`, `reconnecting` | yellow blob, breathing, with a spark orbiting it |
| `--down` | `closed`, `unauthorized`, `superseded` | red blob with a slash through it |

The words survive in the wrapper's `title` and in a `.u-sr-only` label. This
is the *transport*; **`.live-badge` is the stage** (§ 5.5) and the two must
never be conflated — a perfectly connected room with nobody streaming shows
a green dot and no badge.

It stays on the dark ground only. On cream the wait state would have to be
yellow, which is invisible there (§ 3.1), so `/share` keeps its words.

---

## 6. Iconography

Everything is inline SVG in `doodles.tsx`. Nothing is fetched — the Activity's
CSP forbids it, and an icon font would fail the same way.

Drawing rules:

1. **Stroke 1.4–2.8 in a ~24 viewBox, always `stroke-linecap="round"`.** A
   crayon has a blunt tip; it never ends in a sharp corner. The heavy end of
   that range belongs to drawings that must survive being tiny (`CastMark`).
2. **Quadratics with uneven control points.** Nothing symmetric, no perfect
   circles, no shape that could be described by a single CSS property.
3. **Colour comes from the outside.** Use `currentColor` where the icon should
   take its parent's colour (`StickFigure`, `EyesDoodle`, `MegaphoneDoodle`),
   and `var(--…)` where the icon owns its palette (`CastMark`, `OnAirDot`,
   `SunDoodle`). Never a literal hex — it will be wrong on one of the grounds.
   A `currentColor` drawing may still reach for `--outline` for detail *inside*
   its own fill, the way `EyesDoodle` punches its pupils.
4. **`aria-hidden="true"`, always.** The meaning lives in the adjacent text. An
   icon that carries meaning on its own is a bug in the copy, not the icon.
   The one exception is `Wordmark`, which *is* the text — it pairs hidden
   letters with a `.u-sr-only` accessible name.
5. **Design at the size it will be used.** Detail that survives at 34px turns
   to mush at 15px; test before you ship, and cut detail rather than shrink it.
6. **Prefer a face to a texture** — the corollary of rule 5. Both drawings
   redrawn in the refinement pass (`CastMark`, `EyesDoodle`) failed the same
   way: fine detail dissolved at real size while high-contrast features inside
   a filled shape survived. When a drawing has to shrink, cut the texture and
   keep — or add — the face.
7. **Optional `size` prop only where a drawing is used at two sizes** (today:
   `CastMark`). Everything else is fixed.

Current set: `CastMark`, `OnAirDot`, `ScribbleDot`, `StickFigure`, `EyesDoodle`,
`MegaphoneDoodle`, `CloudDoodle`, `SunDoodle`, `StarDoodle`, `DiceDoodle`,
`BoomDoodle`, `SceneTv`, `BrowserTabDoodle`, `ScribbleLoader`, `LinkDot`.
`Wordmark` also lives in `doodles.tsx` — it is a drawing made of letters, not
a component.

`SceneTv`, `BrowserTabDoodle`, `ScribbleLoader` and `LinkDot` are *scene*
drawings rather than icons: they are used at 130–270px, they carry no
adjacent label to lean on, and three of them have CSS-driven states
(`SceneTv`'s nub and waves, `ScribbleLoader`'s self-drawing stroke,
`LinkDot`'s three shapes). Rule 5 — design at the size it will be used — is
why `SceneTv` is a separate drawing from `CastMark` rather than the mark
scaled up: at poster size the mark's horizontal glare streaks read as lines
of text and its stroke weights read as slabs.

**How to test a drawing at size.** Do not judge it in a design tool at 400%.
Rasterise it at its real px size onto its real ground, then blow *that bitmap*
up with nearest-neighbour scaling — scaling the SVG instead just re-renders the
vector and tells you nothing. That is how the 16 / 20 / 24 / 34 decisions above
were made, and it is the only way to see that a 1.6-radius pupil is a
sub-pixel smear at 16px.

Emoji are used sparingly as inline glyphs in copy (🎧 🎥 ✋ ⛔ 🎵) — never as
component icons, because they render as somebody else's artwork.

---

## 7. Accessibility

The floor is not optional and it is not announced in the UI.

**Contrast (SC 1.4.3, 1.4.11).** Every text/ground pair clears 4.5:1 and every
control boundary clears 3:1. The two places this forced a decision are
documented in § 3.1 — red text uses `--angry-lit`, and the focus colour flips
per ground. When you add a colour, check it on **both** papers before you use
it for text.

**Focus (SC 2.4.7, 1.4.11).** A 3px dashed ring in `--focus` with 3px offset,
on `:focus-visible` only, scoped to `a, button, input, select, textarea,
[tabindex]`. Dashed because a dashed line reads as a drawn cut-line — on brand
*and* distinguishable from the solid crayon outlines it sits next to. Two
components override the offset: `.seg-btn` insets it (the group clips
overflow), `.crayon-range` widens it. Never remove the ring; adjust the offset.

**Target size (SC 2.5.8).** Segment buttons are ≥46×28 inside a 3px border;
the fullscreen button is 42×42; selects are ≥30px tall with generous padding.

**Motion (SC 2.3.3).** `prefers-reduced-motion: reduce` collapses animation and
transition durations to 0.001ms rather than setting `animation: none`, so
fill-mode states still resolve and nothing freezes mid-keyframe. `.live-wave`
is pinned to full opacity so the on-air dot stays a complete drawing. **Every
animated element must be legible standing still** — motion may emphasise state,
never encode it.

**State is never colour-only.** The sharer is red *and* ringed *and* bold *and*
tagged. The pressed segment is filled *and* `aria-pressed`. Live is a red dot
*and* the words "On air".

**Semantics.** The segmented group is `role="group"` + `aria-labelledby`; the
toggle state is `aria-pressed`; decorative SVG is `aria-hidden`; the roster is
a list of text rows, so a screen reader gets "pedro sharing", not an icon name.

**Narrow panels.** Discord docks the Activity into a panel that can get very
narrow. At ≤620px the sidebar tightens and the status line drops; at ≤460px the
sidebar goes entirely. The picture is never what gets sacrificed.

---

## 8. Do / Don't

**Do**

- Reach for an existing token. The palette is a crayon box: if the colour you
  want is not in it, you probably want an existing one.
- Give neighbouring elements different wobble recipes and opposite tilts.
- Put the personality in the *chrome* — frames, labels, buttons, empty states.
- Write copy in the app's voice: plain verbs, active, specific, sentence case.
  "Take the stage", not "Initiate broadcast session". Then put it in
  `web/src/i18n.ts` in **both** languages — no user-facing string is written
  inline, and pt-BR is the primary audience, not a translation of the
  English (`docs/i18n.md`).
- Check a new label at 440px on both grounds. pt-BR runs 20–30% longer than
  English; the two shapes that break first are a fixed-width control and a
  row that does not wrap.
- Test on both papers before you commit. Half the bugs in this theme are
  something that only exists on one ground.

**Don't**

- Don't put anything on the video that isn't pinned to a corner and translucent.
- Don't tilt or wobble anything a person has to read at length, or any number.
- Don't use `--angry` for text, or `--yellow` for anything on cream.
- Don't add a fifth type role, a sixth type step, or a second grey.
- Don't hard-code a hex inside a component or an SVG.
- Don't build a three-segment toggle. Three options is a select.
- Don't add an animation that carries information on its own.
- Don't fetch anything — no webfonts, no icon CDNs, no images. The Activity CSP
  blocks it and the failure is silent.
- Don't tilt *everything*. The wobble works because the stage, the stats and
  the body copy are dead straight; if everything leans, nothing does.

---

## 9. Adding to the system

Checklist for a new component:

1. Does an existing component do this? (Buttons, selects, segments, pills,
   tags, cards — the inventory is deliberately small.)
2. Colours from semantic tokens only. Check text contrast on both papers.
3. Pick a wobble recipe that differs from whatever it will sit next to.
4. Hand face for what the app says, Body for prose, Ledger for numbers.
5. Focusable? Confirm the ring is visible and not clipped by an `overflow`
   ancestor.
6. Animated? Confirm it still reads under `prefers-reduced-motion`.
7. New drawing? Follow § 6 and check it at its smallest real size.
8. Touching the mark? Update **all three** copies — `CastMark`, the favicon
   data URI in `index.html`, and `docs/lockup.svg` — then re-render at 16, 20
   and 34px and actually look (see § 6, *How to test a drawing at size*).
9. Build: `cd web && npm run build` (tsc strict + vite).
10. Look at it on both `/` and `/share` before you push.
