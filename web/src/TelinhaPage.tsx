import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import { Session } from "./session";
import { Player } from "./player";
import { adoptClientLocale, t, type Locale } from "./i18n";
import { CastMark, OnAirDot, ScribbleLoader, Wordmark } from "./doodles";
import "./theme.css";

/**
 * The telinha: a deliberately-late mirror of the stream in the person's real
 * browser, made for talking over the call without hearing yourself back.
 * Media chunks are held in a small FIFO for DELAY_MS before reaching the
 * decoder, so this window runs a few seconds behind the Activity — enough
 * that your mic commentary never races the picture your friends see.
 * Watch-only by construction: it joins as "<id>:telinha", never captures,
 * never takes the stage, and the roster collapses it onto the person's row.
 */
const DELAY_MS = 3000;

const TelinhaPage: Component = () => {
  const params = new URLSearchParams(location.search);
  const token = params.get("token") ?? "";
  const room = params.get("room") ?? "";
  const name = params.get("name") ?? "telinha";
  const lang = params.get("lang");
  if (lang) adoptClientLocale(lang as Locale);

  const [status, setStatus] = createSignal("connecting");
  const [painted, setPainted] = createSignal(false);
  const [muted, setMuted] = createSignal(true); // audio already plays in the call

  let canvasRef!: HTMLCanvasElement;
  let player: Player | null = null;
  let session: Session | null = null;
  // The delay line: [arrival timestamp, chunk] pairs drained on a timer.
  const fifo: Array<{ at: number; buf: ArrayBuffer }> = [];
  let drainTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    if (!token) {
      setStatus("no-token");
      return;
    }
    const s = new Session(
      { room, userId: "telinha", username: name, accessToken: "" } as never,
      { shareToken: token },
    );
    session = s;
    player = new Player(canvasRef, () => s.serverNow());
    player.setVolume(0); // muted by default — the call already carries audio
    player.onNeedKeyframe = () => s.requestKeyframe();
    s.onMedia = (buf) => {
      fifo.push({ at: performance.now(), buf });
    };
    drainTimer = setInterval(() => {
      const now = performance.now();
      while (fifo.length && now - fifo[0]!.at >= DELAY_MS) {
        player?.push(fifo.shift()!.buf);
        if (!painted()) setPainted(true);
      }
    }, 50);
    s.onSync = (sync) => player?.setSync(sync);
    s.connect();
    const statusTimer = setInterval(() => setStatus(s.status()), 500);
    onCleanup(() => {
      clearInterval(statusTimer);
      if (drainTimer) clearInterval(drainTimer);
      player?.close();
      s.close();
    });
  });

  const toggleMute = () => {
    const next = !muted();
    setMuted(next);
    player?.setVolume(next ? 0 : 0.7);
  };

  return (
    <div class="app telinha-page">
      <header class="app-header">
        <strong class="logo u-scribble u-scribble--blue">
          <CastMark class="logo-mark" size={28} />
          <Wordmark />
        </strong>
        <span class="live-badge">
          <OnAirDot class="live-dot" />
          <span class="live-badge-label">{t("telinha.badge")}</span>
        </span>
        <button class="crayon-btn crayon-btn--chalk" onClick={toggleMute}>
          {muted() ? t("telinha.unmute") : t("telinha.mute")}
        </button>
      </header>
      <main class="app-main telinha-main">
        <div class="stage">
          <canvas ref={canvasRef} class="stage-canvas" style={{ display: "block" }} />
          <Show when={!painted()}>
            <div class="stage-wait">
              <ScribbleLoader class="wait-scribble" />
              <p class="scene-line">
                {status() === "no-token" ? t("telinha.noToken") : t("telinha.waiting")}
              </p>
            </div>
          </Show>
        </div>
      </main>
    </div>
  );
};

export default TelinhaPage;
