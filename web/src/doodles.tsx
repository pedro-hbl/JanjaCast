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
 * The set. The mark's television redrawn at poster size for the empty
 * stage — same object, more paper: a lopsided blue box on two crooked
 * legs, a waxy glare across the screen, and the "cast" nub on the corner.
 *
 * The nub and its waves are *off* by default (grey nub, waves at zero
 * opacity) and CSS turns them on — hovering the Share button previews it,
 * and `.stage-scene--live` leaves them on and rippling. The drawing reads
 * completely without either state, so nothing is encoded in the motion.
 */
export const SceneTv: Component<{ class?: string }> = (props) => (
  <svg
    class={props.class}
    width="240"
    height="160"
    viewBox="0 0 240 160"
    aria-hidden="true"
  >
    {/* legs first, so the box sits on top of them */}
    <path
      d="M62 124 50 150M142 122 154 148"
      fill="none"
      stroke="var(--crayon-blue-deep)"
      stroke-width="6"
      stroke-linecap="round"
    />
    {/* the box: a rectangle a child would draw, so none of it is square */}
    <path
      d="M14 30Q13 20 24 19L164 12Q176 11 177 22L182 108Q183 119 172 120L28 128Q17 129 16 118Z"
      fill="var(--crayon-blue)"
      stroke="var(--outline)"
      stroke-width="5"
      stroke-linejoin="round"
    />
    {/* the screen itself — empty, inked in, nothing playing */}
    <path
      d="M30 42Q29 34 38 33L152 27Q161 26 162 35L166 99Q167 107 158 108L42 114Q33 115 32 107Z"
      fill="var(--outline)"
      stroke="var(--crayon-blue-deep)"
      stroke-width="2.4"
      stroke-linejoin="round"
    />
    {/* the streak you get dragging a crayon across glass — diagonal at
        this size, because two horizontal ones read as lines of text */}
    <path
      d="M44 100Q66 70 96 46M76 106Q100 84 124 64"
      fill="none"
      stroke="rgba(255,255,255,.2)"
      stroke-width="5"
      stroke-linecap="round"
    />
    {/* the "cast": nub + one bold wave, both dark until the set is on */}
    <circle
      class="scene-tv-nub"
      cx="190"
      cy="22"
      r="9"
      stroke="var(--outline)"
      stroke-width="3"
    />
    <g fill="none" stroke="var(--angry)" stroke-width="6" stroke-linecap="round">
      <path class="scene-tv-wave" d="M203 9Q217 22 204 37" />
      <path class="scene-tv-wave scene-tv-wave--far" d="M215 1Q234 22 216 45" />
    </g>
  </svg>
);

/**
 * A browser window with its tab lit up, a green button waiting inside it
 * and an arrow pointing at the button — the whole "we opened a tab in your
 * real browser, go press the green thing" instruction as one picture.
 */
export const BrowserTabDoodle: Component<{ class?: string }> = (props) => (
  <svg
    class={props.class}
    width="216"
    height="156"
    viewBox="0 0 216 156"
    aria-hidden="true"
  >
    {/* The tab — drawn first, overlapped by the window's top edge, and
        filled with the system blue so "that one" is unmistakable. */}
    <path
      d="M22 32Q21 10 34 9L104 6Q118 5 119 27L120 34 21 37Z"
      fill="var(--crayon-blue)"
      stroke="var(--outline)"
      stroke-width="3.5"
      stroke-linejoin="round"
    />
    {/* The window: inked in and framed in blue, the same two crayons as
        the television so the two drawings are visibly siblings. */}
    <path
      d="M10 44Q9 33 20 32L186 26Q197 25 198 36L202 120Q203 131 192 132L24 138Q13 139 12 128Z"
      fill="var(--outline)"
      stroke="var(--crayon-blue)"
      stroke-width="4.5"
      stroke-linejoin="round"
    />
    {/* the address bar, scribbled in */}
    <path
      d="M28 56Q92 52 156 50"
      fill="none"
      stroke="var(--muted)"
      stroke-width="4"
      stroke-linecap="round"
      opacity=".5"
    />
    {/* the green button inside it — the thing to press */}
    <path
      d="M62 78Q61 69 71 68L140 65Q150 64 151 74L152 92Q153 101 143 102L74 105Q64 106 63 96Z"
      fill="var(--grass)"
      stroke="var(--outline)"
      stroke-width="4"
      stroke-linejoin="round"
    />
    {/* the arrow, bobbing toward it (CSS: .scene-tab-arrow) */}
    <g
      class="scene-tab-arrow"
      fill="none"
      stroke="var(--yellow)"
      stroke-width="5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M196 144Q190 116 168 100" />
      <path d="M168 100 184 103M168 100 172 116" />
    </g>
  </svg>
);

/**
 * Loading: a crayon wave that draws itself, over and over. Used for the
 * gap between joining a live stage and the first decoded frame. Under
 * reduced motion the animation collapses and the line simply stands there
 * fully drawn — still a picture, just not a moving one.
 */
export const ScribbleLoader: Component<{ class?: string }> = (props) => (
  <svg
    class={props.class}
    width="132"
    height="24"
    viewBox="0 0 132 24"
    aria-hidden="true"
  >
    <path
      d="M5 14Q21 3 37 14T69 14T101 14T127 11"
      fill="none"
      stroke="var(--crayon-blue)"
      stroke-width="5"
      stroke-linecap="round"
    />
  </svg>
);

/**
 * Connection state, drawn rather than spelled out. One scribbled blob
 * that changes *shape* as well as colour — a tick when the socket is
 * open, an orbiting spark while it is trying, a slash when it is down —
 * so the state never rests on colour alone. The words live in the
 * wrapper's `title` and in its visually-hidden label.
 */
export const LinkDot: Component<{ class?: string }> = (props) => (
  <svg
    class={props.class}
    width="19"
    height="19"
    viewBox="0 0 20 20"
    aria-hidden="true"
  >
    <path
      class="conn-blob"
      d="M9.4 2.6C13 2 16.2 4.6 15.8 8.7 15.4 12.6 12.6 15.3 9 14.8 5.5 14.4 2.8 11.6 3.2 7.9 3.6 4.8 6.2 3.1 9.4 2.6Z"
      stroke="var(--outline)"
      stroke-width="1.5"
    />
    <path
      class="conn-tick"
      d="M6.2 8.6 8.6 11.1 12.7 5.9"
      fill="none"
      stroke="var(--outline)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <circle class="conn-spark" cx="16.6" cy="3.4" r="2.1" />
    <path
      class="conn-slash"
      d="M4.2 15.4 15.4 3.2"
      fill="none"
      stroke-width="2.4"
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
