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
import type { StingerData } from "./protocol";
import { startCapture, type CaptureHandle } from "./capture";
import { Player } from "./player";
import {
  BrowserTabDoodle,
  CastMark,
  CloudDoodle,
  EyesDoodle,
  LinkDot,
  MegaphoneDoodle,
  OnAirDot,
  SceneTv,
  ScribbleLoader,
  StickFigure,
  SunDoodle,
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

/** How the connection state is *drawn* (the words go in a tooltip).
 *  `undefined` is the moment before the session exists — that is still
 *  "trying", not "broken": starting up must never flash red. */
const linkState = (s: string | undefined) =>
  s === "open"
    ? "live"
    : s === undefined || s === "connecting" || s === "reconnecting"
      ? "wait"
      : "down";

/**
 * The weather behind the empty stage: sun, two clouds, a strip of grass.
 * The same banner motifs the /share page uses, so the two grounds are
 * visibly one drawing. Purely decorative — it never appears while the
 * canvas is showing a picture.
 */
const StageBackdrop: Component = () => (
  <>
    <SunDoodle class="scene-sun" />
    <CloudDoodle class="scene-cloud scene-cloud--a" />
    <CloudDoodle class="scene-cloud scene-cloud--b" />
    <div class="scene-grass" aria-hidden="true" />
  </>
);

const App: Component = () => {
  const [identity, setIdentity] = createSignal<Identity | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [session, setSession] = createSignal<Session | null>(null);
  const [capture, setCapture] = createSignal<CaptureHandle | null>(null);
  // 60 by default — this is a games-and-video product first, and the
  // encoder's adaptive bitrate hands the frames back when the network
  // can't carry them. This value is also what the companion tab inherits
  // through the /share URL, so it is the single framerate default.
  const [fps, setFps] = createSignal<30 | 60>(60);
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

  // --- stinger overlay ------------------------------------------------------
  // A stream starting/stopping plays a server-chosen meme + sound for the
  // whole room. The image runs one continuous WAAPI timeline (compositor-only
  // transform/opacity, so it never contends with the 60fps drawImage loop):
  // it tumbles in from off-screen shedding spin until it stands upright at
  // center, then winds back up while shrinking away into the distance.
  let stingerLayerRef!: HTMLDivElement;
  let stingerAnim: Animation | null = null;
  let stingerImg: HTMLImageElement | null = null;
  let stingerAudio: HTMLAudioElement | null = null;
  let stingerSeq = 0; // orders overlapping stingers; newest wins

  const clearStinger = () => {
    stingerAnim?.cancel();
    stingerAnim = null;
    stingerImg?.remove();
    stingerImg = null;
    stingerAudio?.pause();
    stingerAudio = null;
  };

  const playStinger = async (s: StingerData) => {
    const seq = ++stingerSeq;
    let img: HTMLImageElement | null = null;
    if (s.image) {
      img = new Image();
      img.src = apiPath(s.image);
      img.className = "stinger-img";
      try {
        await img.decode(); // fully decoded before the first painted frame
      } catch {
        img = null; // broken image: still play the sound
      }
    }
    if (seq !== stingerSeq) return; // a newer stinger arrived mid-decode
    clearStinger();

    if (s.audio) {
      const audio = new Audio(apiPath(s.audio));
      audio.volume = 0.8;
      stingerAudio = audio;
      // Autoplay may be rejected before the first user interaction with the
      // page; the animation still plays, which is acceptable.
      audio.play().catch(() => {});
    }
    if (!img) return;
    stingerImg = img;
    stingerLayerRef.appendChild(img);

    // Travel distances derive from the live stage box, so the arc reads the
    // same in normal, theater, and fullscreen layouts.
    const w = stingerLayerRef.clientWidth || 800;
    const h = stingerLayerRef.clientHeight || 450;

    // One continuous timeline — never two chained animations, which would
    // risk a velocity discontinuity at the joint. Rotation increases
    // monotonically (-540° → 0° → +720°) with both segment easings flat at
    // the 42% joint, so angular velocity glides through zero exactly as the
    // image stands upright: fluid, no snap. The late keyframe carries only
    // opacity (a partial keyframe), leaving transform to interpolate
    // uninterrupted across the whole spin-away.
    stingerAnim = img.animate(
      [
        {
          // enter: tumbling in from off-screen left, slightly low
          transform: `translate(${(-0.75 * w).toFixed(1)}px, ${(0.07 * h).toFixed(1)}px) rotate(-540deg) scale(0.85)`,
          opacity: 1,
          // strong ease-out: high entry speed decaying to zero at upright
          easing: "cubic-bezier(0.16, 0.7, 0.3, 1)",
          offset: 0,
        },
        {
          // upright at center, full size, all velocities ~0
          transform: "translate(0px, 0px) rotate(0deg) scale(1)",
          opacity: 1,
          // strong ease-in: winds the spin back up from stillness
          easing: "cubic-bezier(0.55, 0.02, 0.85, 0.35)",
          offset: 0.42,
        },
        {
          // opacity holds until the last 15%, then fades as it recedes
          opacity: 1,
          easing: "cubic-bezier(0.4, 0, 0.8, 1)",
          offset: 0.85,
        },
        {
          // exit: spinning away into the distance, drifting slightly up
          transform: `translate(0px, ${(-0.16 * h).toFixed(1)}px) rotate(720deg) scale(0.02)`,
          opacity: 0,
          offset: 1,
        },
      ],
      { duration: 4200, fill: "forwards" },
    );
    stingerAnim.onfinish = () => {
      if (seq === stingerSeq) clearStinger();
    };
  };

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
      // Stream start/stop stinger — the sharer's own view plays it too.
      s.onStinger = (st) => void playStinger(st);
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

  // --- "waiting for the picture" -------------------------------------------
  // Joining a live stage is black until the relay delivers a keyframe. That
  // gap gets a crayon loader instead of dead black — and it must vanish the
  // instant a frame lands, because nothing is ever allowed to sit on top of
  // moving video. The signal is the canvas's own backing store: player.ts
  // sizes it to the frame only when it actually draws one, so a canvas still
  // at the 300x150 default has never painted. (Decoded frames/s is the
  // belt-and-braces second opinion, for the impossible 300px-wide stream.)
  const BLANK_W = 300;
  const [painted, setPainted] = createSignal(false);
  let paintedFor: string | undefined | null = null;
  const paintTimer = setInterval(() => {
    const pid = stage().publisherId;
    if (pid !== paintedFor) {
      paintedFor = pid;
      // Also wipes the previous stream's last frame, so it can't linger as
      // a ghost underneath the next sharer's first keyframe.
      canvasRef.width = BLANK_W;
      canvasRef.height = 150;
      setPainted(false);
      return;
    }
    if (
      !painted() &&
      (canvasRef.width !== BLANK_W || (player?.stats().fps ?? 0) > 0)
    ) {
      setPainted(true);
    }
  }, 150);

  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("fullscreenchange", onFsChange);
    if (overlayTimer) clearTimeout(overlayTimer);
    clearInterval(statsTimer);
    clearInterval(paintTimer);
    clearStinger();
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
        // contentHint left to capture.ts's automatic rule (tab ⇒ motion,
        // screen or window ⇒ text). Nothing to choose here.
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
        {/* Connection state is drawn, not spelled out: a scribbled dot that
            changes shape as well as colour (tick / spark / slash). The
            words are still there for anyone who wants them — on hover and
            for screen readers — they just no longer shout "reconnecting"
            across the header. */}
        <span
          class={`conn-dot conn-dot--${linkState(session()?.status())}`}
          title={`${session()?.status() ?? "starting"} · ${identity()?.username ?? "…"}`}
        >
          <LinkDot class="conn-mark" />
          <span class="u-sr-only" role="status">
            Connection {session()?.status() ?? "starting"}
          </span>
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
          {/* Stinger overlay: inside .stage so fullscreen/theater show it;
              above the canvas, below the stage controls; never interactive. */}
          <div class="stinger-layer" ref={stingerLayerRef} />
          {/* Waiting for the first frame: a crayon loader on paper rather
              than a black rectangle. Gone the moment anything paints. */}
          <Show
            when={
              live() && !capture() && !session()?.ownsStage() && !painted()
            }
          >
            <div class="stage-wait" title="Waiting for the picture…">
              <ScribbleLoader class="wait-scribble" />
              <span class="u-sr-only" role="status">
                Waiting for the picture
              </span>
            </div>
          </Show>
          {/* Your own view while you hold the stage: the same set as the
              empty scene, switched on. */}
          <Show when={capture() || session()?.ownsStage()}>
            <div class="stage-scene stage-scene--live">
              <StageBackdrop />
              <div class="scene-stack">
                <SceneTv class="scene-tv" />
                <p class="scene-line">
                  🎥 You are live at {fps()} fps
                  {capture() ? "." : " from your browser tab."}
                </p>
              </div>
            </div>
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
          {/* The empty stage is a drawing, not a sentence: the JanjaCast
              set standing in the grass under a sun, switched off, with the
              one thing you can do about it planted in front of it. The
              button's label is the only text in the scene. */}
          <Show when={!live()}>
            <div class="stage-scene">
              <StageBackdrop />
              <Show
                when={companionOpened()}
                fallback={
                  <div class="scene-stack">
                    <SceneTv class="scene-tv" />
                    <button
                      onClick={shareClicked}
                      class="crayon-btn crayon-btn--go scene-cta"
                    >
                      Share screen
                    </button>
                  </div>
                }
              >
                {/* The companion tab is open in the real browser: point at
                    it rather than describing it. */}
                <div class="scene-stack">
                  <BrowserTabDoodle class="scene-tab" />
                  <p class="scene-line">Start sharing in the new tab.</p>
                </div>
              </Show>
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
                // One --go per screen (docs/design.md § 5.1): while the
                // empty stage is showing its own oversized Share button,
                // the footer keeps quiet. It comes back the moment the
                // stage has a picture on it — or a companion tab to
                // re-open — so the action is never unreachable.
                <Show when={live() || companionOpened()}>
                  <button
                    onClick={shareClicked}
                    class="crayon-btn crayon-btn--go"
                  >
                    {live() ? "Take the stage" : "Share screen"}
                  </button>
                </Show>
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
