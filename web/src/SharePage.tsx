// Companion capture page (/share?room=...&name=...): opened in the user's
// real browser when Discord's Activity iframe denies display-capture. It
// joins the same room over WebSocket, takes the stage, and streams — while
// the Activity remains the viewing surface for everyone in the call.

import {
  createEffect,
  createSignal,
  onCleanup,
  Show,
  type Component,
} from "solid-js";
import type { Identity } from "./discord";
import { Session } from "./session";
import { startCapture, type CaptureHandle } from "./capture";
import { ScribbleDot, SunDoodle } from "./doodles";
import "./theme.css";

const SharePage: Component = () => {
  const params = new URLSearchParams(location.search);
  const room = params.get("room") ?? "dev";
  const name = params.get("name") ?? "sharer";

  const identity: Identity = {
    inDiscord: false,
    userId: Math.random().toString(36).slice(2, 10), // server overrides via token
    username: `${name} (sharing)`,
    room,
  };

  const session = new Session(identity, {
    shareToken: params.get("token") ?? undefined,
  });
  session.connect();

  const [capture, setCapture] = createSignal<CaptureHandle | null>(null);
  const [fps, setFps] = createSignal<30 | 60>(
    params.get("fps") === "60" ? 60 : 30,
  );
  const [stats, setStats] = createSignal({ fps: 0, kbps: 0, targetKbps: 0 });
  const [error, setError] = createSignal<string | null>(null);

  // Remote stop: if we held the stage and it is no longer ours (the user
  // clicked Stop in the Activity, or someone took over), end capture here.
  // A short grace window after reconnect avoids reacting to the transient
  // empty stage seen before our re-take round-trips.
  let wasPublisher = false;
  let graceUntil = 0;
  createEffect(() => {
    const st = session.stage();
    const mine = st.publisherId != null && st.publisherId === session.selfId();
    if (mine) {
      wasPublisher = true;
      return;
    }
    if (performance.now() < graceUntil) return;
    if (wasPublisher) {
      wasPublisher = false;
      const c = capture();
      if (c) {
        c.stop();
        setCapture(null);
      }
    }
  });

  // Re-claim the stage after a transport reconnect so viewers recover
  // without the sharer touching anything.
  session.onReconnected = () => {
    const c = capture();
    if (c) {
      graceUntil = performance.now() + 3000;
      session.takeStage();
      session.announceConfig(c.config);
    }
  };

  const statsTimer = setInterval(() => {
    const c = capture();
    if (c) setStats(c.stats());
  }, 1000);

  // Publish clock-sync marks so viewers can measure glass-to-glass latency.
  const syncTimer = setInterval(() => {
    const sample = capture()?.lastSample();
    if (!sample) return;
    session.sendSync({
      captureTs: sample.ts,
      wallTs: session.serverNow() - (performance.now() - sample.at),
    });
  }, 1000);

  onCleanup(() => {
    clearInterval(statsTimer);
    clearInterval(syncTimer);
    capture()?.stop();
    session.close();
  });

  const start = async () => {
    setError(null);
    try {
      const handle = await startCapture(fps(), (buf) => session.sendMedia(buf), {
        backpressure: () => session.bufferedAmount(),
      });
      handle.onended = stop;
      setCapture(handle);
      session.takeStage();
      session.announceConfig(handle.config);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stop = () => {
    capture()?.stop();
    setCapture(null);
    session.leaveStage();
  };

  return (
    <div class="share-page">
      <SunDoodle class="share-sun" />

      <div class="share-card">
        <h1 class="share-title">golive — screen sharing</h1>
        <p class="share-room">
          Room <code>{room}</code> · connection: {session.status()}
        </p>

        <Show
          when={capture()}
          fallback={
            <>
              <label class="fps-label">
                Framerate{" "}
                <select
                  class="crayon-select"
                  value={fps()}
                  onChange={(e) => setFps(Number(e.currentTarget.value) as 30 | 60)}
                >
                  <option value={30}>30 fps</option>
                  <option value={60}>60 fps</option>
                </select>
              </label>
              <button
                onClick={start}
                disabled={session.status() !== "open"}
                class="crayon-btn crayon-btn--go crayon-btn--big"
              >
                Start sharing
              </button>
              <p class="share-hint">
                Pick the screen, window, or tab to stream. Keep this tab open
                while sharing — everyone in the Discord call watches through the
                Activity.
              </p>
            </>
          }
        >
          <p class="share-live">
            <ScribbleDot class="live-dot" /> Live at {fps()} fps — {stats().fps}{" "}
            fps · {stats().kbps} kbps (target {stats().targetKbps})
          </p>
          <button
            onClick={stop}
            class="crayon-btn crayon-btn--stop crayon-btn--big"
          >
            Stop sharing
          </button>
          <p class="share-hint">
            You can minimize this tab; the stream keeps running.
          </p>
        </Show>

        <Show when={error()}>
          <p class="error-text">{error()}</p>
        </Show>
      </div>

      <div class="grass-strip" aria-hidden="true" />
    </div>
  );
};

export default SharePage;
