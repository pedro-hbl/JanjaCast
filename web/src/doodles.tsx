// Purely presentational hand-drawn inline SVG doodles for the crayon
// theme. No logic lives here — just pictures.

import type { Component } from "solid-js";

/** Scribbled-in LIVE dot (pulses via the .live-dot CSS class). */
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
