// Companion capture page (/share?room=...&name=...): opened in the user's
// real browser when Discord's Activity iframe denies display-capture. It
// joins the same room over WebSocket, takes the stage, and streams — while
// the Activity remains the viewing surface for everyone in the call.

import { createSignal, onCleanup, Show, type Component } from "solid-js";
import type { Identity } from "./discord";
import { Session } from "./session";
import { startCapture, type CaptureHandle } from "./capture";

const SharePage: Component = () => {
  const params = new URLSearchParams(location.search);
  const room = params.get("room") ?? "dev";
  const name = params.get("name") ?? "sharer";

  const identity: Identity = {
    inDiscord: false,
    userId: params.get("user") ?? Math.random().toString(36).slice(2, 10),
    username: `${name} (sharing)`,
    room,
  };

  const session = new Session(identity);
  session.connect();

  const [capture, setCapture] = createSignal<CaptureHandle | null>(null);
  const [fps, setFps] = createSignal<30 | 60>(
    params.get("fps") === "60" ? 60 : 30,
  );
  const [stats, setStats] = createSignal({ fps: 0, kbps: 0 });
  const [error, setError] = createSignal<string | null>(null);

  const statsTimer = setInterval(() => {
    const c = capture();
    if (c) setStats(c.stats());
  }, 1000);

  onCleanup(() => {
    clearInterval(statsTimer);
    capture()?.stop();
    session.close();
  });

  const start = async () => {
    setError(null);
    try {
      const handle = await startCapture(fps(), (buf) => session.sendMedia(buf));
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
    <div
      style={{
        height: "100%",
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        "justify-content": "center",
        gap: "16px",
        padding: "24px",
        "text-align": "center",
      }}
    >
      <h1 style={{ margin: 0 }}>golive — screen sharing</h1>
      <p style={{ color: "#949ba4", margin: 0 }}>
        Room <code>{room}</code> · connection: {session.status()}
      </p>

      <Show
        when={capture()}
        fallback={
          <>
            <label style={{ color: "#949ba4" }}>
              Framerate{" "}
              <select
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
              style={{
                background: "#248046",
                color: "#fff",
                border: "none",
                "border-radius": "6px",
                padding: "14px 28px",
                "font-size": "16px",
                cursor: "pointer",
              }}
            >
              Start sharing
            </button>
            <p style={{ color: "#949ba4", "max-width": "420px" }}>
              Pick the screen, window, or tab to stream. Keep this tab open
              while sharing — everyone in the Discord call watches through the
              Activity.
            </p>
          </>
        }
      >
        <p style={{ "font-size": "18px" }}>
          🔴 Live at {fps()} fps — {stats().fps} fps · {stats().kbps} kbps
        </p>
        <button
          onClick={stop}
          style={{
            background: "#da373c",
            color: "#fff",
            border: "none",
            "border-radius": "6px",
            padding: "14px 28px",
            "font-size": "16px",
            cursor: "pointer",
          }}
        >
          Stop sharing
        </button>
        <p style={{ color: "#949ba4" }}>
          You can minimize this tab; the stream keeps running.
        </p>
      </Show>

      <Show when={error()}>
        <p style={{ color: "#f23f43" }}>{error()}</p>
      </Show>
    </div>
  );
};

export default SharePage;
