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

  // Loopback hop: when the relay runs on THIS machine (self-hosted sharer),
  // capturing through the public tunnel wastes a full stream of uplink AND
  // downlink. Probe localhost; if it is the very same server instance, move
  // this tab there. http://localhost is a secure context, so the mixed-
  // content check permits the probe from an https page.
  if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    void (async () => {
      try {
        const cfg = (await (await fetch("/api/config")).json()) as {
          instance?: string;
          localPort?: string;
        };
        if (!cfg.instance || !cfg.localPort) return;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);
        const health = (await (
          await fetch(`http://localhost:${cfg.localPort}/api/health`, {
            signal: ctrl.signal,
          })
        ).json()) as { instance?: string };
        clearTimeout(timer);
        if (health.instance === cfg.instance) {
          location.replace(
            `http://localhost:${cfg.localPort}/share${location.search}`,
          );
        }
      } catch {
        // No local server — we are a remote sharer; stay on the tunnel.
      }
    })();
  }

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
  const [hint, setHint] = createSignal<"text" | "motion">("text");
  const [codec, setCodec] = createSignal<"auto" | "av1">("auto");
  const [audioMode, setAudioMode] = createSignal<"app" | "system" | "none">("app");
  const [takenBy, setTakenBy] = createSignal<string | null>(null);
  const [viewers, setViewers] = createSignal(0);
  const [budgetKbps, setBudgetKbps] = createSignal(0);

  void fetch("/api/config")
    .then((r) => r.json())
    .then((c: { egressBudgetKbps?: number }) =>
      setBudgetKbps(c.egressBudgetKbps ?? 0),
    )
    .catch(() => {});

  // Keyframe-on-demand: the relay asks when a viewer joins or falls behind.
  session.onKeyframeRequest = () => capture()?.forceKeyframe();
  // Fan-out congestion feedback feeds the encoder's rate controller.
  session.onRateHint = (degraded, v) => {
    setViewers(v);
    capture()?.applyRateHint(degraded, v);
  };
  // If someone takes the stage, say so instead of silently reverting.
  session.onStageTaken = (byName) => setTakenBy(byName);
  // A newer share session replaced this tab (e.g. Share clicked again in
  // Discord): stop capturing here, terminally.
  session.onSuperseded = () => {
    capture()?.stop();
    setCapture(null);
    setError("This share was replaced by a newer sharing tab — you can close this one.");
  };

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
    setTakenBy(null);
    try {
      const handle = await startCapture(fps(), (buf) => session.sendMedia(buf), {
        backpressure: () => session.bufferedAmount(),
        contentHint: hint(),
        egressBudgetKbps: budgetKbps(),
        codecPref: codec(),
        audioMode: audioMode(),
      });
      handle.onended = stop;
      handle.onconfigchange = (cfg) => session.announceConfig(cfg);
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
        <h1 class="share-title">JanjaCast — screen sharing</h1>
        <p class="share-room">
          Room <code>{room}</code> · connection: {session.status()}
        </p>

        <Show when={capture() && session.status() !== "open"}>
          <p class="error-text">
            {session.status() === "unauthorized"
              ? "⛔ Session expired — go back to Discord and click Share screen again."
              : "⚠ Not connected — nobody can see your screen right now. Reconnecting…"}
          </p>
        </Show>

        <Show
          when={capture()}
          fallback={
            <>
              <Show when={takenBy()}>
                <p class="error-text">✋ {takenBy()} took the stage.</p>
              </Show>
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
              <label class="fps-label">
                Optimize for{" "}
                <select
                  class="crayon-select"
                  value={hint()}
                  onChange={(e) => setHint(e.currentTarget.value as "text" | "motion")}
                >
                  <option value="text">📖 Text (code, slides)</option>
                  <option value="motion">🎮 Motion (games, video)</option>
                </select>
              </label>
              <label class="fps-label">
                Codec{" "}
                <select
                  class="crayon-select"
                  value={codec()}
                  onChange={(e) => setCodec(e.currentTarget.value as "auto" | "av1")}
                >
                  <option value="auto">Auto (H.264)</option>
                  <option value="av1">AV1 — sharper per bit (modern GPU)</option>
                </select>
              </label>
              <label class="fps-label">
                Sound{" "}
                <select
                  class="crayon-select"
                  value={audioMode()}
                  onChange={(e) =>
                    setAudioMode(e.currentTarget.value as "app" | "system" | "none")
                  }
                >
                  <option value="app">🎵 App sound — no call echo (recommended)</option>
                  <option value="system">🔊 Whole-screen sound (echo-prone!)</option>
                  <option value="none">🔇 No sound</option>
                </select>
              </label>
              <p class="share-hint">
                {audioMode() === "app"
                  ? "Pick a window or a browser tab — only that app's sound is shared, so the Discord call is never re-broadcast."
                  : audioMode() === "system"
                    ? "⚠ Shares everything on your speakers, INCLUDING the Discord call — everyone will hear themselves unless Discord uses a different output device (Windows: Settings → Sound → Volume mixer → Discord → Output)."
                    : "Video only; the voice call carries the commentary."}
              </p>
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
          <p class="share-room">
            {viewers()} watching · total upload ≈{" "}
            {Math.round((stats().kbps * Math.max(viewers(), 1)) / 100) / 10}{" "}
            Mbps
            {budgetKbps() > 0 &&
            stats().kbps * Math.max(viewers(), 1) > budgetKbps()
              ? " ⚠ over your egress budget"
              : ""}
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
