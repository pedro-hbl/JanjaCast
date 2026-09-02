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
import {
  CastMark,
  CloudDoodle,
  EyesDoodle,
  MegaphoneDoodle,
  OnAirDot,
  StickFigure,
} from "./doodles";
import "./theme.css";

/** One row of the sidebar roster — one *person*, not one connection. */
interface RosterRow {
  id: string;
  name: string;
  sharing: boolean;
  isSelf: boolean;
}

/** A companion capture tab joins as "<id>:tab" / "<name> (sharing)". Both
 *  belong to one person, so presentation collapses them onto one row. */
const baseId = (id: string) => (id.endsWith(":tab") ? id.slice(0, -4) : id);
const plainName = (n: string) => n.replace(/\s*\(sharing\)\s*$/i, "");

const App: Component = () => {
  const [identity, setIdentity] = createSignal<Identity | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [session, setSession] = createSignal<Session | null>(null);
  const [capture, setCapture] = createSignal<CaptureHandle | null>(null);
  const [fps, setFps] = createSignal<30 | 60>(30);
  const [volume, setVolume] = createSignal(
    (() => {
      try {
        const v = localStorage.getItem("jc-volume");
        return v !== null ? Math.min(100, Math.max(0, Number(v))) : 70;
      } catch {
        return 70;
      }
    })(),
  );
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
  const [isFullscreen, setIsFullscreen] = createSignal(false);
  const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
  document.addEventListener("fullscreenchange", onFsChange);

  // In fullscreen/theater the header (and its stats) is hidden — surface
  // the stats as a hover overlay on the stage instead, auto-hiding after a
  // short idle so they never burn into the movie.
  const [overlayOn, setOverlayOn] = createSignal(false);
  let overlayTimer: ReturnType<typeof setTimeout> | null = null;
  const pokeOverlay = () => {
    setOverlayOn(true);
    if (overlayTimer) clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => setOverlayOn(false), 2500);
  };
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
      player.setVolume(volume() / 100);
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
    document.removeEventListener("fullscreenchange", onFsChange);
    if (overlayTimer) clearTimeout(overlayTimer);
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

  /** Presentation-only view of the participant list: one row per person,
   *  flagged with who is on the stage and which one is you. */
  const roster = (): RosterRow[] => {
    const list = session()?.participants().participants ?? [];
    const pid = stage().publisherId;
    const me = session()?.selfId();
    const rows = new Map<string, RosterRow>();
    for (const p of list) {
      const key = baseId(p.userId);
      const fromTab = p.userId.endsWith(":tab");
      const row = rows.get(key);
      if (row) {
        // the person's own connection wins the display name over the tab's
        if (!fromTab) row.name = p.username;
      } else {
        rows.set(key, {
          id: key,
          name: fromTab ? plainName(p.username) : p.username,
          sharing: false,
          isSelf: me != null && baseId(me) === key,
        });
      }
      if (pid != null && baseId(pid) === key) {
        const r = rows.get(key);
        if (r) r.sharing = true;
      }
    }
    return [...rows.values()];
  };

  return (
    <div class={theater() ? "app theater" : "app"}>
      <header class="app-header">
        <strong class="logo">
          <CastMark class="logo-mark" size={26} />
          <span class="logo-word u-scribble u-scribble--blue">JanjaCast</span>
        </strong>
        <Show when={live()}>
          <span class="live-badge">
            <OnAirDot class="live-dot" />
            <span class="live-badge-label">On air</span>
            <span class="live-badge-name">{stage().publisherName}</span>
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
        <div
          class="stage"
          ref={stageRef}
          onDblClick={() => void toggleFullscreen()}
          onMouseMove={pokeOverlay}
        >
          <Show
            when={
              (isFullscreen() || theater()) &&
              overlayOn() &&
              live() &&
              !session()?.ownsStage()
            }
          >
            <div class="stage-stats">
              {stats().fps} fps · {stats().kbps} kbps
              {stats().latencyMs != null ? ` · ${stats().latencyMs} ms` : ""}
            </div>
          </Show>
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
          <h4 class="sidebar-title">
            <EyesDoodle class="sidebar-title-icon" />
            <span class="u-scribble u-scribble--yellow">
              {roster().length} in the room
            </span>
          </h4>
          <div class="roster">
            <For each={roster()}>
              {(p) => (
                <div
                  class={
                    p.sharing ? "participant participant--live" : "participant"
                  }
                >
                  <span class="participant-ring">
                    <StickFigure class="participant-icon" />
                  </span>
                  <span class="participant-name">{p.name}</span>
                  <Show when={p.sharing}>
                    <span class="participant-tag">
                      <MegaphoneDoodle class="participant-tag-icon" />
                      sharing
                    </span>
                  </Show>
                  <Show when={p.isSelf && !p.sharing}>
                    <span class="participant-tag participant-tag--you">
                      you
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </div>
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
          <label class="fps-label" title="On speakers, your mic feeds the stream back into the call — headphones avoid it.">
            🎧 Volume{" "}
            <input
              class="crayon-range"
              type="range"
              min="0"
              max="100"
              value={volume()}
              onInput={(e) => {
                const v = Number(e.currentTarget.value);
                setVolume(v);
                player?.setVolume(v / 100);
                try {
                  localStorage.setItem("jc-volume", String(v));
                } catch {
                  /* private mode */
                }
              }}
            />
          </label>
        </Show>

        <div class="field">
          <span class="field-label" id="fps-label">
            Framerate
          </span>
          <div class="seg" role="group" aria-labelledby="fps-label">
            <button
              type="button"
              class="seg-btn"
              aria-pressed={fps() === 30}
              disabled={Boolean(capture()) || session()?.ownsStage()}
              onClick={() => setFps(30)}
            >
              30
            </button>
            <button
              type="button"
              class="seg-btn"
              aria-pressed={fps() === 60}
              disabled={Boolean(capture()) || session()?.ownsStage()}
              onClick={() => setFps(60)}
            >
              60
            </button>
          </div>
          <span class="seg-unit">fps</span>
        </div>

        <Show when={error()}>
          <span class="error-text">{error()}</span>
        </Show>
      </footer>

      <Show when={confirmTakeover()}>
        <div class="modal-scrim">
          <div class="share-card modal-card">
            <p class="modal-msg">
              ✋ Kick <strong>{stage().publisherName}</strong> off the stage?
            </p>
            <div class="modal-actions">
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
