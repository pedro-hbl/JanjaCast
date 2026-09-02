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
  /** Viewer magnification (scroll to zoom, drag to pan — see player.ts). */
  const [zoom, setZoom] = createSignal(1);
  const [stats, setStats] = createSignal<{
    fps: number;
    kbps: number;
    latencyMs?: number | null;
  }>({ fps: 0, kbps: 0 });

  let canvasRef!: HTMLCanvasElement;
  let stageRef!: HTMLDivElement;
  let player: Player | null = null;

  // Fullscreen when the iframe permits it; otherwise "theater mode" —
  // maximize the stage inside the Activity by hiding all chrome.
  const [theater, setTheater] = createSignal(false);
  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
      return;
    }
    if (document.fullscreenEnabled) {
      try {
        await stageRef.requestFullscreen();
        return;
      } catch {
        // permissions policy said no — fall through to theater
      }
    }
    setTheater((t) => !t);
  };

  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (
      t instanceof HTMLInputElement ||
      t instanceof HTMLSelectElement ||
      t instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (e.key === "f" || e.key === "F") void toggleFullscreen();
    if (e.key === "t" || e.key === "T") setTheater((v) => !v);
    if (e.key === "Escape") setTheater(false);
  };
  document.addEventListener("keydown", onKey);

  onMount(async () => {
    try {
      const id = await setupIdentity();
      setIdentity(id);
      const s = new Session(id, { accessToken: id.accessToken });
      player = new Player(canvasRef, () => s.serverNow());
      s.onMedia = (buf) => player?.push(buf);
      s.onSync = (sync) => player?.setSync(sync);
      // Fast recovery: when video stalls waiting for a keyframe, ask for one.
      player.onNeedKeyframe = () => s.requestKeyframe();
      player.onZoomChange = setZoom;
      // Publisher-side plumbing for the local-capture path (plain-browser
      // dev / any future in-iframe capture): same wiring SharePage has.
      s.onKeyframeRequest = () => capture()?.forceKeyframe();
      s.onRateHint = (d, v) => capture()?.applyRateHint(d, v);
      s.onStageTaken = (byName) => {
        if (capture()) {
          stopSharing();
          setError(`✋ ${byName} took the stage.`);
        }
      };
      // Same Discord user opened the Activity somewhere newer (another
      // device, a reloaded iframe): this view is terminally disconnected.
      s.onSuperseded = () =>
        setError("Opened elsewhere — this view is disconnected. Close and reopen the Activity here to take over.");
      s.connect();
      setSession(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  });

  // Rebuild viewer decoders whenever the stage config changes and we're not
  // the one streaming — including via our own companion tab: decoding and
  // *playing* your own stream while your tab captures system audio is a
  // feedback loop (and doubles the sharer's bandwidth).
  createEffect(() => {
    const s = session();
    if (!s) return;
    const st = s.stage();
    if (st.config && !s.ownsStage()) {
      player?.configure(st.config);
    }
  });

  const statsTimer = setInterval(() => {
    const c = capture();
    setStats(c ? c.stats() : (player?.stats() ?? { fps: 0, kbps: 0 }));
  }, 1000);

  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
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
        body: JSON.stringify({
          accessToken: id.accessToken,
          room: id.room,
          // Honored only by anonymous dev servers, so ownsStage()/remote
          // stop work in the plain-browser flow too.
          userId: id.userId,
          username: id.username,
        }),
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

  const [confirmTakeover, setConfirmTakeover] = createSignal(false);

  /** Entry point for the Share button: if someone else is live, ask before
   *  kicking them off the stage. */
  const shareClicked = () => {
    if (live() && !session()?.ownsStage()) {
      setConfirmTakeover(true);
      return;
    }
    void share();
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
      const handle = await startCapture(fps(), (buf) => s.sendMedia(buf), {
        backpressure: () => s.bufferedAmount(),
        contentHint: "text",
      });
      handle.onended = stopSharing;
      handle.onconfigchange = (cfg) => s.announceConfig(cfg);
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
    <div class={theater() ? "app theater" : "app"}>
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
        <div class="stage" ref={stageRef} onDblClick={() => void toggleFullscreen()}>
          <canvas
            ref={canvasRef}
            class="stage-canvas"
            style={{
              display:
                live() && !capture() && !session()?.ownsStage()
                  ? "block"
                  : "none",
            }}
          />
          <Show when={capture() || session()?.ownsStage()}>
            <p class="stage-msg">
              🎥 You are live at {fps()} fps
              {capture() ? "." : " from your browser tab."}
            </p>
          </Show>
          <Show when={live() && !session()?.ownsStage() && zoom() > 1.001}>
            <span class="zoom-pill" title="Scroll to zoom · drag to pan">
              {zoom().toFixed(1)}x
            </span>
          </Show>
          <Show when={live() && !session()?.ownsStage()}>
            <button
              class="fs-btn"
              title="Fullscreen · F (T for theater mode)"
              onClick={() => void toggleFullscreen()}
            >
              ⛶
            </button>
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
                <button onClick={shareClicked} class="crayon-btn crayon-btn--go">
                  {live() ? "Take the stage" : "Share screen"}
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

        <Show when={live() && !session()?.ownsStage()}>
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
            disabled={Boolean(capture()) || session()?.ownsStage()}
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

      <Show when={confirmTakeover()}>
        <div
          style={{
            position: "fixed",
            inset: "0",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            background: "rgba(0,0,0,0.55)",
            "z-index": "10",
          }}
        >
          <div class="share-card" style={{ "max-width": "340px", padding: "24px" }}>
            <p style={{ "font-size": "16px", margin: "0 0 16px" }}>
              ✋ Kick <strong>{stage().publisherName}</strong> off the stage?
            </p>
            <div style={{ display: "flex", gap: "12px", "justify-content": "center" }}>
              <button
                class="crayon-btn crayon-btn--go"
                onClick={() => {
                  setConfirmTakeover(false);
                  void share();
                }}
              >
                Yeah, my turn
              </button>
              <button
                class="crayon-btn crayon-btn--stop"
                onClick={() => setConfirmTakeover(false)}
              >
                Never mind
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default App;
