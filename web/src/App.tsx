import {
  createSignal,
  createEffect,
  onCleanup,
  onMount,
  Show,
  For,
  type Component,
} from "solid-js";
import { setupIdentity, type Identity } from "./discord";
import { Session } from "./session";
import { startCapture, type CaptureHandle } from "./capture";
import { Player } from "./player";

const App: Component = () => {
  const [identity, setIdentity] = createSignal<Identity | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [session, setSession] = createSignal<Session | null>(null);
  const [capture, setCapture] = createSignal<CaptureHandle | null>(null);
  const [fps, setFps] = createSignal<30 | 60>(30);
  const [stats, setStats] = createSignal({ fps: 0, kbps: 0 });

  let canvasRef!: HTMLCanvasElement;
  let player: Player | null = null;

  onMount(async () => {
    try {
      const id = await setupIdentity();
      setIdentity(id);
      const s = new Session(id);
      player = new Player(canvasRef);
      s.onMedia = (buf) => player?.push(buf);
      s.connect();
      setSession(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  });

  // Rebuild viewer decoders whenever the stage config changes and we're not
  // the one streaming.
  createEffect(() => {
    const s = session();
    if (!s) return;
    const st = s.stage();
    if (st.config && !s.isPublisher()) {
      player?.configure(st.config);
    }
  });

  const statsTimer = setInterval(() => {
    const c = capture();
    setStats(c ? c.stats() : (player?.stats() ?? { fps: 0, kbps: 0 }));
  }, 1000);

  onCleanup(() => {
    clearInterval(statsTimer);
    capture()?.stop();
    player?.close();
    session()?.close();
  });

  const share = async () => {
    const s = session();
    if (!s) return;
    try {
      const handle = await startCapture(fps(), (buf) => s.sendMedia(buf));
      handle.onended = stopSharing;
      setCapture(handle);
      s.takeStage();
      s.announceConfig(handle.config);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stopSharing = () => {
    capture()?.stop();
    setCapture(null);
    session()?.leaveStage();
  };

  const stage = () => session()?.stage() ?? {};
  const live = () => Boolean(stage().publisherId);

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%" }}>
      <header
        style={{
          display: "flex",
          "align-items": "center",
          gap: "12px",
          padding: "10px 16px",
          background: "#111214",
        }}
      >
        <strong>golive</strong>
        <Show when={live()}>
          <span style={{ color: "#f23f43" }}>
            ● LIVE — {stage().publisherName}
          </span>
          <span style={{ color: "#949ba4" }}>
            {stats().fps} fps · {stats().kbps} kbps
          </span>
        </Show>
        <span style={{ "margin-left": "auto", color: "#949ba4" }}>
          {session()?.status() ?? "starting"} · {identity()?.username ?? "…"}
        </span>
      </header>

      <main style={{ flex: 1, display: "flex", "min-height": 0 }}>
        <div
          style={{
            flex: 1,
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            background: "#000",
          }}
        >
          <canvas
            ref={canvasRef}
            style={{
              "max-width": "100%",
              "max-height": "100%",
              display: live() && !capture() ? "block" : "none",
            }}
          />
          <Show when={capture()}>
            <p style={{ color: "#949ba4" }}>
              You are sharing your screen at {fps()} fps.
            </p>
          </Show>
          <Show when={!live()}>
            <p style={{ color: "#949ba4" }}>Nobody is live. Take the stage!</p>
          </Show>
        </div>

        <aside style={{ width: "180px", padding: "12px", background: "#111214" }}>
          <h4 style={{ margin: "0 0 8px" }}>In the room</h4>
          <For each={session()?.participants().participants ?? []}>
            {(p) => <div style={{ padding: "2px 0" }}>{p.username}</div>}
          </For>
        </aside>
      </main>

      <footer
        style={{
          display: "flex",
          gap: "12px",
          "align-items": "center",
          padding: "10px 16px",
          background: "#111214",
        }}
      >
        <Show
          when={capture()}
          fallback={
            <button onClick={share} style={buttonStyle("#248046")}>
              Share screen
            </button>
          }
        >
          <button onClick={stopSharing} style={buttonStyle("#da373c")}>
            Stop sharing
          </button>
        </Show>

        <label style={{ color: "#949ba4" }}>
          Framerate{" "}
          <select
            value={fps()}
            disabled={Boolean(capture())}
            onChange={(e) => setFps(Number(e.currentTarget.value) as 30 | 60)}
          >
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>
        </label>

        <Show when={error()}>
          <span style={{ color: "#f23f43" }}>{error()}</span>
        </Show>
      </footer>
    </div>
  );
};

function buttonStyle(bg: string) {
  return {
    background: bg,
    color: "#fff",
    border: "none",
    "border-radius": "4px",
    padding: "8px 16px",
    cursor: "pointer",
    font: "inherit",
  };
}

export default App;
