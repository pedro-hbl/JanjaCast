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
 * The JanjaCast mark: a crooked crayon television with two scribbled
 * broadcast waves coming off its top-right corner.
 *
 * Reads at 20px (header) and at 32px (favicon — the same drawing is
 * hard-coded as a data URI in index.html, keep the two in sync).
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
    {/* two little legs, drawn first so the box sits on top of them */}
    <path
      d="M7.1 18.4 5.9 21.6M13.4 18 14.6 21.1"
      fill="none"
      stroke="var(--outline)"
      stroke-width="1.8"
      stroke-linecap="round"
    />
    {/* the screen: a rectangle a child would draw, so none of it is square */}
    <path
      d="M3.2 7.2Q3 6 4.3 5.9L15.2 5.1Q16.5 5 16.6 6.3L17.2 16.6Q17.3 17.9 16 18L4.4 18.9Q3.1 19 3 17.7Z"
      fill="var(--crayon-blue)"
      stroke="var(--outline)"
      stroke-width="1.8"
      stroke-linejoin="round"
    />
    {/* waxy highlight — the streak you get pressing a crayon on glass */}
    <path
      d="M5.6 9.5Q8.6 8.5 11.5 9.1M5.4 12.4Q9.6 11.2 13.7 12.2"
      fill="none"
      stroke="rgba(255,255,255,.5)"
      stroke-width="1.4"
      stroke-linecap="round"
    />
    {/* the "cast": a red nub on the corner throwing one bold wave.
        Two concentric waves is the obvious drawing, but at 20px the gap
        between them closes and the pair reads as a smudge — so the mark
        keeps one arc and buys the clearance with a fatter nub. */}
    <circle
      cx="16.4"
      cy="5.2"
      r="1.8"
      fill="var(--angry)"
      stroke="var(--outline)"
      stroke-width="1"
    />
    <path
      d="M19.4 2.2Q23 5.4 19.9 8.8"
      fill="none"
      stroke="var(--angry)"
      stroke-width="2.4"
      stroke-linecap="round"
    />
  </svg>
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

/** Two wonky eyes — heads the room roster ("N in the room"). */
export const EyesDoodle: Component<{ class?: string }> = (props) => (
  <svg
    class={props.class}
    width="19"
    height="14"
    viewBox="0 0 18 14"
    aria-hidden="true"
  >
    <path
      d="M1.1 7.3Q4.4 2.1 7.9 7Q4.6 12.3 1.1 7.3Z"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linejoin="round"
    />
    <circle cx="4.5" cy="7.1" r="1.6" fill="currentColor" />
    <path
      d="M10.1 7Q13.5 1.8 16.9 7.2Q13.4 12 10.1 7Z"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linejoin="round"
    />
    <circle cx="13.5" cy="7.1" r="1.6" fill="currentColor" />
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

/**
 * A crooked die, for "surprise the room" — the random-stinger button.
 *
 * Drawn at 18px, which is where it lives: the pips are three fat dots rather
 * than a five-pip face, because five dots at 18px is a grey smear. It owns
 * its palette (a yellow crayon die with ink pips) so it reads as an object
 * being thrown rather than as a glyph in the button's text.
 */
export const DiceDoodle: Component<{ class?: string }> = (props) => (
  <svg
    class={props.class}
    width="18"
    height="18"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path
      d="M5.4 6.2q6-1.5 12.4-1.1.9 6.2.6 12.5-6.3 1.3-12.6.6-.9-6.1-.4-12Z"
      fill="var(--yellow)"
      stroke="var(--outline)"
      stroke-width="2"
      stroke-linejoin="round"
    />
    <path
      d="M9 9.2h.01M15 9.4h.01M12 12.6h.01M9.2 15.6h.01M15.2 15.4h.01"
      fill="none"
      stroke="var(--outline)"
      stroke-width="2.4"
      stroke-linecap="round"
    />
  </svg>
);

/**
 * A scribbled starburst — the Stingers panel's title mark. The idea is "a
 * noise happened", which is what a stinger is: five uneven spikes and a
 * lopsided core, no radial symmetry anywhere.
 */
export const BoomDoodle: Component<{ class?: string }> = (props) => (
  <svg
    class={props.class}
    width="20"
    height="20"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path
      d="M12 3.4 14.4 8l5.2-1.1-2.3 4.7 3.3 3.6-4.9.9-.6 4.6-4-2.9-4.3 2.4.3-4.6L3 14.2l3.6-3.1L4.9 6.6l5 1Z"
      fill="var(--redorange)"
      stroke="var(--outline)"
      stroke-width="1.8"
      stroke-linejoin="round"
    />
    <path
      d="M10.4 10.8q1.6 1.4 3.3.4"
      fill="none"
      stroke="var(--outline)"
      stroke-width="1.6"
      stroke-linecap="round"
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
