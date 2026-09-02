// The "é tua!" cue: the two-note flourish every client plays when somebody
// is called to the stage.
//
// It is SYNTHESIZED rather than bundled. The spec asked for a small mp3
// imported through Vite; Web Audio gets the same result with no binary in the
// repo, nothing to fetch (the Activity's CSP forbids that anyway — see
// docs/design.md § 6), no decode latency on the first play, and a volume that
// is a number rather than a mastering decision. Two short notes a fifth apart
// with a soft attack is exactly the "ta-daa" the feature needs; a longer sting
// belongs in the Stingers store, which is where per-deployment audio lives.
//
// Deliberately not localized (docs/i18n.md § "What is deliberately not
// localized"): there is no text here.

/** One shared context — browsers cap how many a page may open. Created lazily
 *  on the first cue, because constructing one before a user gesture starts it
 *  suspended and burns the quota. */
let ctx: AudioContext | null = null;

/** Two calls inside this window are one event delivered twice (a reconnect
 *  replaying a control, say), never two people being called half a second
 *  apart — the turn window is twenty seconds long. */
const DEDUPE_MS = 500;
let lastPlayed = -Infinity;

/**
 * Play the cue once, at `volume` (0–1, the viewer's own slider).
 *
 * Silent when the browser refuses audio before the first interaction with the
 * page, which is the same bargain the stinger overlay already makes: the
 * visible prompt is what actually carries the message.
 */
export function playTurnCue(volume = 0.7): void {
  const at = performance.now();
  if (at - lastPlayed < DEDUPE_MS) return;
  lastPlayed = at;
  if (volume <= 0) return;

  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();

    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = Math.min(1, Math.max(0, volume)) * 0.5;
    master.connect(ctx.destination);

    // E5 then B5 — a rising fifth reads as "you're up", where a falling
    // interval reads as "that's over".
    for (const [freq, at, len] of [
      [659.25, 0, 0.16],
      [987.77, 0.14, 0.34],
    ] as const) {
      const osc = ctx.createOscillator();
      // Triangle: a soft edge that carries over a voice call without the
      // square-wave buzz an alarm would have.
      osc.type = "triangle";
      osc.frequency.value = freq;
      const env = ctx.createGain();
      // Ramped rather than switched: a hard gain step is an audible click.
      env.gain.setValueAtTime(0.0001, now + at);
      env.gain.exponentialRampToValueAtTime(1, now + at + 0.02);
      env.gain.exponentialRampToValueAtTime(0.0001, now + at + len);
      osc.connect(env);
      env.connect(master);
      osc.start(now + at);
      osc.stop(now + at + len + 0.02);
    }
  } catch {
    // No audio device, autoplay refused, AudioContext unavailable: the
    // visible prompt carries the message on its own.
  }
}
