// Purely presentational hand-drawn inline SVG doodles for the crayon
// theme. No logic lives here — just pictures.
//
// House rules (see docs/design.md § Iconography):
//  - Everything is inline SVG so it inherits CSS custom properties and
//    `currentColor`; nothing is fetched (Discord's Activity CSP forbids it).
//  - Strokes are 1.4–2.4 in a 24-ish viewBox, always `stroke-linecap="round"`:
//    a crayon has a blunt tip and never ends in a sharp corner.
//  - Curves are quadratics with deliberately uneven control points. Nothing
//    is symmetric, nothing is a perfect circle.
//  - Every icon is `aria-hidden`; the meaning lives in the adjacent text.

import type { Component } from "solid-js";

/**
 * The JanjaCast mark: a crooked crayon television with a face, standing on
 * two stubby legs, one bold red antenna cocked off its top-right corner.
 *
 * **Miniaturisation is the whole design.** The header renders this at 28px
 * and it must still be a character, not a blue blob. Three decisions follow
 * from that, and none of them should be undone without re-testing at 20px:
 *
 *  - **The screen carries a face, not detail.** Two dot-eyes and a grin are
 *    four marks that a reader's face-detection locks onto instantly; a waxy
 *    glare streak is one mark that turns to grey mush below 24px. Personality
 *    survives shrinking, texture does not. The old highlight streaks are gone.
 *  - **One antenna, not a pair of concentric waves.** Two arcs close their gap
 *    and read as a red smudge. A single fat diagonal stem into a chunky ball
 *    breaks the silhouette out of its bounding box and stays a distinct red
 *    gesture at every size.
 *  - **The screen face is large and the strokes are heavy** (2.1–2.8 in a 24
 *    viewBox). Fewer, bolder strokes; nothing thinner than ~1.4px at 20px.
 *
 * Colours come from CSS, so the mark re-inks itself on the cream page.
 * The favicon is a *separate, bolder cut* of this drawing — see index.html.
 */
export const CastMark: Component<{ class?: string; size?: number }> = (
  props,
) => (
  <svg
    class={props.class}
    width={props.size ?? 22}
    height={props.size ?? 22}
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    {/* legs first, so the box sits on top of them; long enough to still be
        two distinct stubs at 24px */}
    <path
      d="M5.6 19.8 3.9 23.4M13.4 19.4 15.0 22.9"
      fill="none"
      stroke="var(--outline)"
      stroke-width="2.6"
      stroke-linecap="round"
    />
    {/* the screen: a box a child would draw, so none of it is square */}
    <path
      d="M2.3 8.6Q1.9 6.8 3.7 6.6L15.1 5.6Q16.9 5.4 17.0 7.2L17.5 18.5Q17.6 20.3 15.8 20.4L3.6 21.2Q1.8 21.3 1.9 19.5Z"
      fill="var(--crayon-blue)"
      stroke="var(--outline)"
      stroke-width="2.1"
      stroke-linejoin="round"
    />
    {/* the face — the thing that survives 16px */}
    <circle cx="6.7" cy="11.4" r="2" fill="var(--outline)" />
    <circle cx="12.7" cy="10.9" r="2" fill="var(--outline)" />
    <path
      d="M6.9 15.4Q9.8 18.4 12.9 15.0"
      fill="none"
      stroke="var(--outline)"
      stroke-width="2.3"
      stroke-linecap="round"
    />
    {/* the "cast": one bold red antenna, stem merging into the ball so the
        pair reads as a single gesture rather than two small objects */}
    <path
      d="M15.6 6.2Q17.6 4.4 19.1 2.9"
      fill="none"
      stroke="var(--angry)"
      stroke-width="2.8"
      stroke-linecap="round"
    />
    <circle
      cx="19.8"
      cy="2.3"
      r="2.4"
      fill="var(--angry)"
      stroke="var(--outline)"
      stroke-width="1"
    />
  </svg>
);

/**
 * The JanjaCast wordmark — lettering, not typesetting.
 *
 * The Hand face is the raw material; the craft is what is done to it. Every
 * letter gets a hand-tuned rotation, baseline bounce and size nudge, because
 * the tell of "computer pretending to be a hand" is that all the letters agree
 * with each other. Nothing here is generated from a formula — a formula
 * produces regular irregularity, which reads as a wobble filter.
 *
 * The two-colour split is the mark's split, spelled: **Janja** is the blue
 * screen, **Cast** is the red signal. Cast is set a notch smaller and rides
 * slightly higher, echoing how the antenna sits small and high off the box.
 *
 * All offsets are in `em`, so the lettering scales as one drawing — the header
 * (20px) and the /share title (26px) are the same artwork, not two tunings.
 *
 * The per-letter spans would make a screen reader spell the name out, so the
 * accessible name is a single visually-hidden word and the letters are hidden.
 */
type Glyph = [char: string, rotate: number, bounce: number, scale: number];

/* prettier-ignore */
const JANJA: Glyph[] = [
  ["J", -3.0, 0.020, 1.04],
  ["a",  1.8, -0.030, 0.97],
  ["n", -1.4,  0.035, 1.02],
  ["j",  2.4, -0.010, 1.00],
  ["a", -2.2,  0.045, 1.05],
];
/* prettier-ignore */
const CAST: Glyph[] = [
  ["C",  2.6, -0.080, 1.03],
  ["a", -1.8, -0.060, 0.96],
  ["s",  2.2, -0.090, 1.01],
  ["t", -2.6, -0.050, 0.98],
];

const letters = (glyphs: Glyph[]) =>
  glyphs.map(([char, rotate, bounce, scale]) => (
    <span
      class="wm-l"
      style={{
        "--wm-r": `${rotate}deg`,
        "--wm-y": `${bounce}em`,
        "--wm-s": `${scale}`,
      }}
    >
      {char}
    </span>
  ));

export const Wordmark: Component<{ class?: string }> = (props) => (
  <span class={props.class ? `wordmark ${props.class}` : "wordmark"}>
    <span class="u-sr-only">JanjaCast</span>
    <span class="wm-ink" aria-hidden="true">
      <span class="wm-janja">{letters(JANJA)}</span>
      <span class="wm-cast">{letters(CAST)}</span>
    </span>
  </span>
);

/** Scribbled-in dot. Kept for reuse; the on-air badge uses OnAirDot. */
export const ScribbleDot: Component<{ class?: string }> = (props) => (
  <svg
    class={props.class}
    width="15"
    height="15"
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <path
      d="M8 2.2C11.4 1.6 14.3 4 13.9 7.8 13.5 11.4 10.9 13.9 7.5 13.4 4.3 12.9 2 10.4 2.5 7 2.9 4.1 5.1 2.7 8 2.2Z"
      fill="var(--angry)"
      stroke="var(--outline)"
      stroke-width="1.4"
    />
    <path
      d="M5.2 6.2C6.6 4.6 9.6 4.4 11 6.4M5 8.8c1.8 2 4.6 2 6.2.4"
      fill="none"
      stroke="rgba(255,255,255,.55)"
      stroke-width="1.1"
      stroke-linecap="round"
    />
  </svg>
);

/**
 * On-air indicator: the scribbled dot plus the mark's own broadcast waves.
 * The dot breathes and the waves ripple outwards (CSS `.live-dot`, both
 * silenced under prefers-reduced-motion — the drawing still reads static).
 */
export const OnAirDot: Component<{ class?: string }> = (props) => (
  <svg
    class={props.class}
    width="24"
    height="16"
    viewBox="0 0 26 18"
    aria-hidden="true"
  >
    <g class="live-dot-core">
      <path
        d="M8 3.2C11.4 2.6 14.3 5 13.9 8.8 13.5 12.4 10.9 14.9 7.5 14.4 4.3 13.9 2 11.4 2.5 8 2.9 5.1 5.1 3.7 8 3.2Z"
        fill="var(--angry)"
        stroke="var(--outline)"
        stroke-width="1.4"
      />
      <path
        d="M5.2 7.2C6.6 5.6 9.6 5.4 11 7.4M5 9.8c1.8 2 4.6 2 6.2.4"
        fill="none"
        stroke="rgba(255,255,255,.55)"
        stroke-width="1.1"
        stroke-linecap="round"
      />
    </g>
    <g
      fill="none"
      stroke="var(--angry)"
      stroke-width="1.9"
      stroke-linecap="round"
    >
      <path class="live-wave live-wave--near" d="M16.6 5.4Q18.8 8.6 16.8 12" />
      <path class="live-wave live-wave--far" d="M20 3.2Q23.6 8.6 20.4 14.2" />
    </g>
  </svg>
);

/** Happy stick figure for the participants list. */
export const StickFigure: Component<{ class?: string }> = (props) => (
  <svg
    class={props.class}
    width="14"
    height="18"
    viewBox="0 0 14 18"
    aria-hidden="true"
  >
    <circle
      cx="7"
      cy="4"
      r="2.6"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
    />
    <path
      d="M5.9 4.3q1.1.9 2.2 0"
      fill="none"
      stroke="currentColor"
      stroke-width="0.9"
      stroke-linecap="round"
    />
    <path
      d="M7 7v5M7 8.4 3.4 10.6M7 8.4l3.6 2.2M7 12l-2.8 4.6M7 12l2.8 4.6"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    />
  </svg>
);

/**
 * Two wonky eyes — heads the room roster ("N in the room").
 *
 * Drawn like the mark's face rather than like a line icon: **opaque almond,
 * ink pupil.** Outlined-with-matching-pupil is the obvious drawing and it
 * fails — at 16px the yellow rim and the yellow pupil close their gap and the
 * pair reads as two yellow dots. Filling the almond and punching the pupil in
 * `--outline` keeps hard contrast *inside* the shape, so it still reads as a
 * pair of eyes at roster size, the same bet CastMark makes on its screen.
 */
export const EyesDoodle: Component<{ class?: string }> = (props) => (
  <svg
    class={props.class}
    width="23"
    height="16"
    viewBox="0 0 18 13"
    aria-hidden="true"
  >
    <path
      d="M1.2 6.6Q4.5 1.2 8.2 6.3Q4.8 11.6 1.2 6.6Z"
      fill="currentColor"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linejoin="round"
    />
    <circle cx="4.8" cy="6.4" r="1.6" fill="var(--outline)" />
    <path
      d="M10 6.4Q13.6 1 16.9 6.6Q13.3 11.3 10 6.4Z"
      fill="currentColor"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linejoin="round"
    />
    <circle cx="13.5" cy="6.4" r="1.6" fill="var(--outline)" />
  </svg>
);

/** Crayon megaphone — badges the person currently holding the stage. */
export const MegaphoneDoodle: Component<{ class?: string }> = (props) => (
  <svg
    class={props.class}
    width="15"
    height="13"
    viewBox="0 0 18 16"
    aria-hidden="true"
  >
    <path
      d="M4.6 9.5 5.3 13.5Q5.5 14.8 6.8 14.3 7.2 14.1 7 12.8L6.6 10.4Z"
      fill="currentColor"
      stroke="var(--outline)"
      stroke-width="1.1"
      stroke-linejoin="round"
    />
    <path
      d="M2.1 6.3 9.3 3Q10.4 2.5 10.5 3.9L11 11.5Q11.1 12.9 9.9 12.3L2.6 9.4Q1.4 8.9 1.4 7.9 1.4 6.8 2.1 6.3Z"
      fill="currentColor"
      stroke="var(--outline)"
      stroke-width="1.1"
      stroke-linejoin="round"
    />
    <path
      d="M13.2 5.4Q15 7.9 13.5 10.5M15.5 3.7Q18.2 7.9 15.8 12"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    />
  </svg>
);

/** Scribbled cloud shown on the empty stage. */
export const CloudDoodle: Component<{ class?: string }> = (props) => (
  <svg
    class={props.class}
    width="86"
    height="40"
    viewBox="0 0 86 40"
    aria-hidden="true"
  >
    <path
      d="M14 32C7 32 3 27 5 21.5 6.6 17 11 15.5 15 16.5 15.5 10.5 21 6 27.5 6.5 32 6.8 35.5 9.5 37 13 40 9.5 46.5 9 50.5 12.5 54 15.5 54.5 20 53 23 58.5 22 63.5 25 63 30 62.6 34.6 58 36.5 53 36 49 38.8 42 39.2 37.5 36.5 33 39.5 25.5 39.5 21.5 36.5 19.5 34.8 17 32 14 32Z"
      fill="none"
      stroke="var(--muted)"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M18 27c5 3 11 3.4 16 1M40 30c4 2 9 2 13 0"
      fill="none"
      stroke="var(--muted)"
      stroke-width="1.4"
      stroke-linecap="round"
      opacity="0.6"
    />
  </svg>
);

/** Crayon sun for the corner of the /share paper page. */
export const SunDoodle: Component<{ class?: string }> = (props) => (
  <svg
    class={props.class}
    width="72"
    height="72"
    viewBox="0 0 72 72"
    aria-hidden="true"
  >
    <path
      d="M36 20c8.5-1.4 15.5 4.6 15 13.4-.4 8-6.6 14-15 13.2-8-.7-13.6-6.6-12.9-15C23.7 24.4 29 21.2 36 20Z"
      fill="var(--yellow)"
      stroke="var(--outline)"
      stroke-width="2.4"
    />
    <path
      d="M36 3v9M36 60v9M3 36h9M60 36h9M12 12l6.5 6.5M53.5 53.5 60 60M60 12l-6.5 6.5M18.5 53.5 12 60"
      fill="none"
      stroke="var(--yellow)"
      stroke-width="3.4"
      stroke-linecap="round"
    />
    <path
      d="M31 32.5q1 1.6 2.4.2M39.5 32.5q1 1.6 2.4.2M30.5 39c3.4 3.2 8 3.2 11.4 0"
      fill="none"
      stroke="var(--outline)"
      stroke-width="1.8"
      stroke-linecap="round"
    />
  </svg>
);
