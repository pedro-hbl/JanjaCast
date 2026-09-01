import {
  createSignal,
  createEffect,
  onCleanup,
  onMount,
  Show,
  For,
  type Component,
} from "solid-js";
import {
  apiPath,
  captureAllowed,
  fetchPublicOrigin,
  openExternal,
  setupIdentity,
  type Identity,
} from "./discord";
import { Session } from "./session";
import { startCapture, type CaptureHandle } from "./capture";
import { Player } from "./player";
import { ScribbleDot, StickFigure, CloudDoodle } from "./doodles";
import "./theme.css";

const App: Component = () => {
  const [identity, setIdentity] = createSignal<Identity | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [session, setSession] = createSignal<Session | null>(null);
  const [capture, setCapture] = createSignal<CaptureHandle | null>(null);
  const [fps, setFps] = createSignal<30 | 60>(30);
  const [stats, setStats] = createSignal<{
    fps: number;
    kbps: number;
    latencyMs?: number | null;
  }>({ fps: 0, kbps: 0 });

  let canvasRef!: HTMLCanvasElement;
  let player: Player | null = null;

  onMount(async () => {
    try {
      const id = await setupIdentity();
      setIdentity(id);
      const s = new Session(id, { accessToken: id.accessToken });
      player = new Player(canvasRef, () => s.serverNow());
      s.onMedia = (buf) => player?.push(buf);
      s.onSync = (sync) => player?.setSync(sync);
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

  const [companionOpened, setCompanionOpened] = createSignal(false);

  /** Discord's iframe denies display-capture, so sharing happens in a
   *  companion tab in the user's real browser (same room, direct origin).
   *  The tab authenticates with a short-lived share token minted here. */
  const openCompanion = async (id: Identity) => {
    const [origin, tokenResp] = await Promise.all([
      fetchPublicOrigin(),
      fetch(apiPath("/api/share-token"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: id.accessToken, room: id.room }),
      }),
    ]);
    if (!tokenResp.ok) throw new Error(`share token refused: ${tokenResp.status}`);
    const { shareToken } = (await tokenResp.json()) as { shareToken: string };

    const url = new URL("/share", origin);
    url.searchParams.set("token", shareToken);
    url.searchParams.set("room", id.room); // display only; token is authoritative
    url.searchParams.set("name", id.username);
    url.searchParams.set("fps", String(fps()));
    await openExternal(url.toString());
    setCompanionOpened(true);
  };

  const share = async () => {
    const s = session();
    const id = identity();
    if (!s || !id) return;
    setError(null);
    if (!captureAllowed()) {
      await openCompanion(id).catch((e) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
      return;
    }
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
    <div class="app">
      <header class="app-header">
        <strong class="logo">JanjaCast</strong>
        <Show when={live()}>
          <span class="live-badge">
            <ScribbleDot class="live-dot" /> LIVE — {stage().publisherName}
          </span>
          <span class="stat-pill">
            {stats().fps} fps · {stats().kbps} kbps
            {stats().latencyMs != null ? ` · ${stats().latencyMs} ms` : ""}
          </span>
        </Show>
        <span class="status-line">
          {session()?.status() ?? "starting"} · {identity()?.username ?? "…"}
        </span>
      </header>

      <main class="app-main">
        <div class="stage">
          <canvas
            ref={canvasRef}
            class="stage-canvas"
            style={{ display: live() && !capture() ? "block" : "none" }}
          />
          <Show when={capture()}>
            <p class="stage-msg">
              You are sharing your screen at {fps()} fps.
            </p>
          </Show>
          <Show when={!live()}>
            <div class="stage-empty">
              <CloudDoodle class="stage-cloud" />
              <p class="stage-msg">
                {companionOpened()
                  ? "Sharing tab opened in your browser — click Start sharing there. The stream will appear here."
                  : "Nobody is live. Take the stage!"}
              </p>
            </div>
          </Show>
        </div>

        <aside class="sidebar">
          <h4 class="sidebar-title">In the room</h4>
          <For each={session()?.participants().participants ?? []}>
            {(p) => (
              <div class="participant">
                <StickFigure class="participant-icon" />
                <span class="participant-name">{p.username}</span>
              </div>
            )}
          </For>
        </aside>
      </main>

      <footer class="app-footer">
        <Show
          when={capture()}
          fallback={
            <Show
              when={session()?.ownsStage()}
              fallback={
                <button onClick={share} class="crayon-btn crayon-btn--go">
                  Share screen
                </button>
              }
            >
              {/* Our companion tab holds the stage: stop it from here. */}
              <button
                onClick={() => session()?.leaveStage()}
                class="crayon-btn crayon-btn--stop"
              >
                Stop sharing
              </button>
            </Show>
          }
        >
          <button onClick={stopSharing} class="crayon-btn crayon-btn--stop">
            Stop sharing
          </button>
        </Show>

        <Show when={live()}>
          <label class="fps-label">
            Volume{" "}
            <input
              type="range"
              min="0"
              max="100"
              value="100"
              onInput={(e) =>
                player?.setVolume(Number(e.currentTarget.value) / 100)
              }
              style={{
                "vertical-align": "middle",
                width: "90px",
                "accent-color": "#5cb53f",
              }}
            />
          </label>
        </Show>

        <label class="fps-label">
          Framerate{" "}
          <select
            class="crayon-select"
            value={fps()}
            disabled={Boolean(capture())}
            onChange={(e) => setFps(Number(e.currentTarget.value) as 30 | 60)}
          >
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>
        </label>

        <Show when={error()}>
          <span class="error-text">{error()}</span>
        </Show>
      </footer>
    </div>
  );
};

export default App;
