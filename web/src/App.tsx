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
  fetchClientLocale,
  fetchPublicOrigin,
  fetchStingersEnabled,
  openExternal,
  setupIdentity,
  type Identity,
} from "./discord";
import {
  adoptClientLocale,
  errorKey,
  localeParam,
  t,
  type MessageKey,
  type Params,
} from "./i18n";
import { LangToggle } from "./LangToggle";
import { Session, type SessionStatus } from "./session";
import type { StageMode, StageTurnData, StingerData } from "./protocol";
import { playTurnCue } from "./cue";
import { startCapture, type CaptureHandle } from "./capture";
import { Player } from "./player";
import {
  BrowserTabDoodle,
  CastMark,
  CloudDoodle,
  CoveredTv,
  EyesDoodle,
  HandUpDoodle,
  LinkDot,
  MegaphoneDoodle,
  OnAirDot,
  SceneTv,
  StarDoodle,
  ScribbleLoader,
  StickFigure,
  SunDoodle,
  WheelArrow,
  Wordmark,
} from "./doodles";
import { StingerPanel } from "./stingers";
import { ReactionBar } from "./reactions";
import "./theme.css";

/**
 * What the error line is holding. A *descriptor* rather than a rendered
 * string, so an error already on screen re-draws in the new language when
 * the toggle flips. A bare string is the escape hatch for messages we do not
 * own: browser DOMExceptions out of getDisplayMedia, and the Discord SDK's
 * own failures, which arrive in whatever language their source speaks.
 */
type AppError = string | { key: MessageKey; params?: Params };

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

/** The transport states in words. They are only ever *read out* — the `title`
 *  on the dot and its screen-reader label — so they get translated, while
 *  the drawing stays the thing that carries the meaning on screen. */
const CONN_KEY: Record<SessionStatus, MessageKey> = {
  connecting: "conn.connecting",
  open: "conn.open",
  reconnecting: "conn.reconnecting",
  closed: "conn.closed",
  unauthorized: "conn.unauthorized",
  superseded: "conn.superseded",
};

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
    <CloudDoodle class="scene-cloud scene-cloud--c" />
    <CloudDoodle class="scene-cloud scene-cloud--d" />
    <StarDoodle class="scene-star scene-star--a" />
    <StarDoodle class="scene-star scene-star--b" />
    <StarDoodle class="scene-star scene-star--c" />
    <StarDoodle class="scene-star scene-star--d" />
    <StarDoodle class="scene-star scene-star--e" />
    <div class="scene-grass" aria-hidden="true" />
  </>
);

const App: Component = () => {
  const [identity, setIdentity] = createSignal<Identity | null>(null);
  const [error, setError] = createSignal<AppError | null>(null);
  /** The error, rendered in the current language. Reading it inside JSX is
   *  what makes a live error follow the toggle. */
  const errorText = (): string | null => {
    const e = error();
    if (e == null) return null;
    return typeof e === "string" ? e : t(e.key, e.params);
  };
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

  // --- the stage queue ------------------------------------------------------
  // Who is in line, whose turn it is and how long they have left are all
  // SERVER state (session.queue()), never mirrored into local signals — a
  // second copy is a second answer, and this feature's whole job is that
  // everybody in the room has the same one. The only local state here is the
  // two things that are genuinely transient: the wheel animation and the
  // toast that names who was picked.
  const [wheel, setWheel] = createSignal<StageTurnData | null>(null);
  const [turnToast, setTurnToast] = createSignal<{
    key: MessageKey;
    params?: Params;
  } | null>(null);
  /** Ticks the countdowns. Cheap, and one timer for both clocks means the
   *  turn pill and the rodízio pill never disagree by a frame. */
  const [tick, setTick] = createSignal(0);
  let wheelTimer: ReturnType<typeof setTimeout> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  const flashToast = (key: MessageKey, params?: Params) => {
    setTurnToast({ key, params });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setTurnToast(null), 4500);
  };
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

  // --- one focus system: fullscreen, theater, lights-out -------------------
  //
  // Three settings, one ladder, and they compose rather than compete:
  //
  //   fullscreen  the OS gives us the whole display (iframe permitting)
  //   theater     the stage takes the whole Activity, chrome *hidden*
  //   lights-out  the chrome that is still there is *dimmed*, and the HUD
  //               fades after 3s of stillness
  //
  // Lights-out is a state class on the same root as theater and reuses the
  // same idle timer that already governed the hover-stats overlay — there
  // is deliberately no third parallel mode and no second timer.
  const [theater, setTheater] = createSignal(false);
  const [isFullscreen, setIsFullscreen] = createSignal(false);
  const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
  document.addEventListener("fullscreenchange", onFsChange);

  /** Lights-out. Per-session only (sessionStorage, matching `jc-lang`'s
   *  naming): it is a mood for tonight's film, not a preference. */
  const CINEMA_KEY = "jc-cinema";
  const [cinema, setCinema] = createSignal(
    (() => {
      try {
        return sessionStorage.getItem(CINEMA_KEY) === "1";
      } catch {
        return false; // private mode
      }
    })(),
  );

  // The HUD-idle timer. It drove the stats overlay before lights-out
  // existed; now it drives every fading surface. Nothing that reports a
  // *problem* is on it — errors and the connection dot are pinned visible
  // in theme.css, so a hidden HUD can never hide bad news.
  const HUD_IDLE_MS = 3000;
  const [hudVisible, setHudVisible] = createSignal(true);
  let hudTimer: ReturnType<typeof setTimeout> | null = null;
  const pokeHud = () => {
    setHudVisible(true);
    if (hudTimer) clearTimeout(hudTimer);
    hudTimer = setTimeout(() => setHudVisible(false), HUD_IDLE_MS);
  };
  pokeHud(); // arm it once: stillness from the very first second counts

  // Jitter-proof reveal. A resting hand on a touchpad emits 1–2px tremors
  // for minutes; treating those as "the user moved" would strobe the HUD
  // through the whole film. Only cumulative travel past 6px inside a 200ms
  // window counts as a deliberate movement.
  const REVEAL_PX = 6;
  const REVEAL_WINDOW_MS = 200;
  let travel = 0;
  let travelSince = 0;
  let lastX: number | null = null;
  let lastY: number | null = null;
  const onPointerMove = (e: MouseEvent) => {
    const now = performance.now();
    if (now - travelSince > REVEAL_WINDOW_MS) {
      travel = 0;
      travelSince = now;
      // A new window starts from where the pointer is now, so the gap
      // across the idle period is not counted as travel.
      lastX = e.clientX;
      lastY = e.clientY;
      return;
    }
    if (lastX !== null && lastY !== null) {
      travel += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
    }
    lastX = e.clientX;
    lastY = e.clientY;
    if (travel > REVEAL_PX) {
      travel = 0;
      travelSince = now;
      pokeHud();
    }
  };

  const toggleCinema = () => {
    const next = !cinema();
    setCinema(next);
    try {
      sessionStorage.setItem(CINEMA_KEY, next ? "1" : "0");
    } catch {
      /* private mode: the choice lasts for this page load */
    }
    pokeHud(); // never hand someone a dark room and a hidden way out
  };

  /** The root's state classes. `cinema-idle` is the transient half —
   *  `cinema` dims, `cinema-idle` fades — so CSS can treat "lights are
   *  down" and "nobody has moved" as the separate things they are. */
  const appClass = () => {
    const c = ["app"];
    if (theater()) c.push("theater");
    if (cinema()) c.push("cinema");
    if (cinema() && !hudVisible()) c.push("cinema-idle");
    return c.join(" ");
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
    // Reveal keys are handled before the text-field guard, and Tab is never
    // swallowed: a hidden HUD must not become a keyboard trap. Revealing on
    // keydown means the browser's own focus move lands on a control that is
    // already visible, so the focus ring is where docs/design.md § 7 wants it.
    if (
      e.key === "Tab" ||
      e.key === "ArrowUp" ||
      e.key === "h" ||
      e.key === "H"
    ) {
      pokeHud();
    }
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
    // Escape is the one way out of every focus mode at once.
    if (e.key === "Escape") {
      setTheater(false);
      if (cinema()) toggleCinema();
    }
  };
  document.addEventListener("keydown", onKey);

  onMount(async () => {
    try {
      const id = await setupIdentity();
      setIdentity(id);
      // Zero-friction language: adopt whatever the Discord client is set to.
      // It arrives after first paint and loses to an explicit choice, so it
      // can neither delay startup nor undo the toggle.
      void fetchClientLocale().then(adoptClientLocale);
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
          setError({ key: "err.tookStage", params: { name: byName } });
        }
      };
      // Same Discord user opened the Activity somewhere newer (another
      // device, a reloaded iframe): this view is terminally disconnected.
      s.onSuperseded = () => setError({ key: "err.superseded" });
      // Stream start/stop stinger — the sharer's own view plays it too.
      s.onStinger = (st) => void playStinger(st);
      // Somebody was called to the stage. The cue is room-wide on purpose —
      // "é tua!" is something the whole call hears, the way it would be said
      // out loud. It rides the viewer's own volume slider, and the token
      // makes a duplicated control message a no-op rather than a double beep.
      s.onStageTurn = (turn) => {
        playTurnCue(volume() / 100);
        if (turn.method === "wheel") {
          // A real draw just happened, so the spin is showing something
          // rather than dressing up a decided outcome (design.md § 8).
          setWheel(turn);
          if (wheelTimer) clearTimeout(wheelTimer);
          wheelTimer = setTimeout(() => setWheel(null), 3200);
        }
        // Compare against the CALL's own id, not session.hasTurn(): the
        // relay sends this control before the state broadcast that sets
        // turnUserId, so hasTurn() is still answering about the last turn
        // here — and the person being called would get told about
        // themselves in the third person.
        if (baseId(turn.userId) !== baseId(s.selfId())) {
          flashToast(turn.method === "wheel" ? "turn.wheel" : "turn.someone", {
            name: turn.username,
          });
        }
      };
      s.onStageCancel = (cancel) => {
        if (cancel.reason === "timeout") flashToast("turn.missed");
      };
      // A refusal the person can act on ("nobody to hand it to") lands on the
      // footer's error line as a descriptor, so it follows the language
      // toggle like every other error (docs/i18n.md § "Writing messages").
      s.onServerError = (code) => {
        const key = errorKey(code);
        if (key) setError({ key });
      };
      ;(window as any)._jcSession = s;
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

  // Drives both countdowns. 500ms is twice the rate a per-second readout
  // needs, so the digits never look like they skipped one.
  const clockTimer = setInterval(() => setTick((n) => n + 1), 500);

  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("fullscreenchange", onFsChange);
    if (hudTimer) clearTimeout(hudTimer);
    if (wheelTimer) clearTimeout(wheelTimer);
    if (toastTimer) clearTimeout(toastTimer);
    clearInterval(statsTimer);
    clearInterval(clockTimer);
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
    if (!tokenResp.ok) {
      throw new Error(t("err.shareToken", { status: tokenResp.status }));
    }
    const { shareToken } = (await tokenResp.json()) as { shareToken: string };

    const url = new URL("/share", origin);
    url.searchParams.set("token", shareToken);
    url.searchParams.set("room", id.room); // display only; token is authoritative
    url.searchParams.set("name", id.username);
    url.searchParams.set("fps", String(fps()));
    // The companion tab lives on the public origin, not Discord's proxy, so
    // it cannot see this origin's localStorage. Hand it the language on the
    // URL and it opens already speaking it.
    url.searchParams.set("lang", localeParam());
    await openExternal(url.toString());
    setCompanionOpened(true);
  };

  // --- stinger management panel --------------------------------------------
  // A drawer over the sidebar side (never over the video). The button is
  // hidden entirely unless the server actually has an asset store.
  const [stingersOn, setStingersOn] = createSignal(false);
  const [stingerPanel, setStingerPanel] = createSignal(false);
  onMount(() => {
    void fetchStingersEnabled()
      .then(setStingersOn)
      .catch(() => setStingersOn(false));
  });

  const [confirmTakeover, setConfirmTakeover] = createSignal(false);

  /** The takeover question, split either side of its `{name}` slot so the
   *  name can stay bold. `t()` leaves the placeholder alone when no params
   *  are passed, which is what makes this safe. */
  const kickParts = () => t("modal.kick").split("{name}");

  /** Entry point for the Share button: if someone else is live, ask before
   *  kicking them off the stage — unless the stage was just handed to us,
   *  in which case there is nobody to kick and asking would be the app
   *  double-checking a decision it made ten seconds ago. */
  const shareClicked = () => {
    if (live() && !session()?.ownsStage() && !session()?.hasTurn()) {
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
  /** The sharer hit the panic button (or a late-join welcome said so). No
   *  frames are coming; render the card instead of the video. */
  const blanked = () => stage().blanked === true;
  /** Is there a moving picture on the canvas right now? Everything that may
   *  sit over the stage keys off this, so nothing decorates live video. */
  const watching = () => live() && !blanked() && !session()?.ownsStage();

  // The privacy blank replaces the picture, so the picture must actually be
  // gone: resetting the backing store wipes the last real frame that would
  // otherwise sit under the card. Clearing `painted` then makes the unblank
  // keyframe — not a stale pixel — what brings the stage back, with the
  // ordinary "waiting for the picture" loader covering the one-chunk gap.
  createEffect(() => {
    if (!blanked()) return;
    canvasRef.width = BLANK_W;
    canvasRef.height = 150;
    setPainted(false);
  });

  // --- the queue, derived straight off the server's state -------------------

  const me = () => session()?.selfId() ?? "";
  const queueState = () =>
    session()?.queue() ?? { queue: [], mode: "livre" as StageMode, turnLenMs: 0 };
  const queued = () =>
    queueState().queue.some((e) => baseId(e.userId) === baseId(me()));
  /** Seconds left on the pending turn, ticking. */
  const turnSeconds = () => {
    tick(); // subscribe
    const ends = queueState().turnEndsMs;
    const s = session();
    if (!ends || !s) return 0;
    return Math.max(0, Math.ceil((ends - s.serverNow()) / 1000));
  };
  /** The wheel's candidates — everybody but whoever was passing. Used only
   *  to draw the circle; the server already decided who won. */
  const wheelCards = () => {
    const w = wheel();
    if (!w) return [];
    const cards = roster().filter((r) => r.id !== baseId(w.userId));
    return [{ id: baseId(w.userId), name: w.username }, ...cards].slice(0, 8);
  };

  /** Transport state as a word, in the active language. `undefined` is the
   *  beat before the session exists — that is "starting", not "broken". */
  const connWord = () => {
    const s = session()?.status();
    return t(s ? CONN_KEY[s] : "conn.starting");
  };

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
    <div class={appClass()} onMouseMove={onPointerMove}>
      <header class="app-header">
        {/* the scribble is on the lockup, not the word: it runs under mark and
            wordmark alike, so the three pieces read as one drawing */}
        <strong class="logo u-scribble u-scribble--blue">
          <CastMark class="logo-mark" size={28} />
          <Wordmark />
        </strong>
        <Show when={live()}>
          <span class="live-badge">
            <OnAirDot class="live-dot" />
            <span class="live-badge-label">{t("header.onAir")}</span>
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
        <LangToggle class="header-lang" />
        <span
          class={`conn-dot conn-dot--${linkState(session()?.status())}`}
          title={`${connWord()} · ${identity()?.username ?? "…"}`}
        >
          <LinkDot class="conn-mark" />
          <span class="u-sr-only" role="status">
            {t("conn.sr", { status: connWord() })}
          </span>
        </span>
      </header>

      <main class="app-main">
        <div
          class="stage"
          ref={stageRef}
          onDblClick={() => void toggleFullscreen()}
        >
          <Show
            when={
              (isFullscreen() || theater()) && hudVisible() && watching()
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
          {/* The privacy blank. This is the one intentional full-frame
              layer in the app: it *replaces* the video rather than
              decorating it (there is no video — the sharer's encoder is
              gated and the relay's cache is empty), so § "the stage is
              sacred" holds. It outranks the waiting loader below. */}
          <Show when={live() && blanked() && !session()?.ownsStage()}>
            <div class="stage-blank">
              <CoveredTv class="blank-art" />
              <p class="blank-line" role="status">
                {t("blank.card.title")}
              </p>
            </div>
          </Show>
          {/* Waiting for the first frame: a crayon loader on paper rather
              than a black rectangle. Gone the moment anything paints. */}
          <Show
            when={
              live() &&
              !blanked() &&
              !capture() &&
              !session()?.ownsStage() &&
              !painted()
            }
          >
            <div class="stage-wait" title={t("stage.waiting")}>
              <ScribbleLoader class="wait-scribble" />
              <span class="u-sr-only" role="status">
                {t("stage.waiting")}
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
                {/* two whole sentences, not a concatenation: word order
                    around the fps number is not the same in every language */}
                <p class="scene-line">
                  {capture()
                    ? t("stage.liveHere", { fps: fps() })
                    : t("stage.liveTab", { fps: fps() })}
                </p>
              </div>
            </div>
          </Show>
          <Show when={watching() && zoom() > 1.001}>
            <span class="zoom-pill" title={t("stage.zoomTitle")}>
              {zoom().toFixed(1)}x
            </span>
          </Show>
          <Show when={live() && !session()?.ownsStage()}>
            <button
              class="fs-btn"
              title={t("stage.fsTitle")}
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
                      {t("stage.shareScreen")}
                    </button>
                  </div>
                }
              >
                {/* The companion tab is open in the real browser: point at
                    it rather than describing it. */}
                <div class="scene-stack">
                  <BrowserTabDoodle class="scene-tab" />
                  <p class="scene-line">{t("stage.companionOpen")}</p>
                </div>
              </Show>
            </div>
          </Show>
        </div>

        {/* Edge UI: reactions + hype, never over center safe-zone */}
        <ReactionBar />

        <aside class="sidebar">
          {/* count and label are separate spans so the number can carry the
              weight and only the fixed words take the underline — the wave
              would otherwise change length every time somebody joins */}
          <h4 class="sidebar-title">
            <EyesDoodle class="sidebar-title-icon" />
            <span class="sidebar-count">{roster().length}</span>
            <span class="sidebar-count-label u-scribble u-scribble--yellow">
              {t("roster.inRoom")}
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
                      {t("roster.sharing")}
                    </span>
                  </Show>
                  <Show when={p.isSelf && !p.sharing}>
                    <span class="participant-tag participant-tag--you">
                      {t("roster.you")}
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </div>

          {/* The line, as chips. Chrome beside the roster, never over the
              picture (design.md § 2). One emoji per person keeps five in a
              186px sidebar; the name lives in the chip's title and, for
              whoever is actually next, on the line underneath — that is the
              only bit of it anybody has to read. The heading is NOT
              underlined: "in the room" above it already spends this
              region's one scribble (design.md § 3.5). */}
          <div class="queue-panel">
            <h4 class="queue-title">
              <HandUpDoodle class="queue-title-icon" />
              <span>{t("queue.title")}</span>
            </h4>
            <Show
              when={queueState().queue.length > 0}
              fallback={<p class="queue-empty">{t("queue.empty")}</p>}
            >
              <div class="queue-chips">
                <For each={queueState().queue}>
                  {(e, i) => (
                    <span
                      class={
                        i() === 0 ? "queue-chip queue-chip--next" : "queue-chip"
                      }
                      title={t("queue.position", {
                        name: e.username,
                        n: i() + 1,
                      })}
                    >
                      <span class="queue-chip-emoji" aria-hidden="true">
                        {e.initialsEmoji}
                      </span>
                      <span class="u-sr-only">
                        {t("queue.position", { name: e.username, n: i() + 1 })}
                      </span>
                    </span>
                  )}
                </For>
              </div>
              <p class="queue-next" aria-hidden="true">
                {queueState().queue[0]?.username}
              </p>
            </Show>
          </div>
        </aside>

        {/* Anchored inside the positioned main row (design.md § 5.8): the
            drawer must cover neither the header lockup nor the footer. */}
        <Show when={stingerPanel()}>
          <StingerPanel
            token={identity()?.accessToken}
            onClose={() => setStingerPanel(false)}
            onPlay={(opts) => session()?.playStinger(opts)}
          />
        </Show>
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
                    {live() ? t("footer.takeStage") : t("stage.shareScreen")}
                  </button>
                </Show>
              }
            >
              {/* Our companion tab holds the stage: stop it from here. */}
              <button
                onClick={() => session()?.leaveStage()}
                class="crayon-btn crayon-btn--stop"
              >
                {t("footer.stopSharing")}
              </button>
            </Show>
          }
        >
          <button onClick={stopSharing} class="crayon-btn crayon-btn--stop">
            {t("footer.stopSharing")}
          </button>
        </Show>

        {/* "Pedir a vez" / "Passar a vez": one button, whichever side of the
            handover you are on. Chalk, not grass — the footer's one `--go`
            is already spent on Share (design.md § 5.1). */}
        <Show
          when={session()?.ownsStage()}
          fallback={
            <Show when={live() && !session()?.hasTurn()}>
              <button
                type="button"
                class="crayon-btn crayon-btn--chalk"
                onClick={() =>
                  queued()
                    ? session()?.withdrawStage()
                    : session()?.requestStage()
                }
              >
                {queued() ? t("queue.withdraw") : t("queue.request")}
              </button>
            </Show>
          }
        >
          <button
            type="button"
            class="crayon-btn crayon-btn--chalk"
            onClick={() => {
              setError(null);
              session()?.passStage();
            }}
          >
            {t("queue.pass")}
          </button>
        </Show>

        {/* The countdown on your own turn. A stat pill, because it is a
            number being read (design.md § 5.6) — it just happens to be an
            urgent one. */}
        <Show when={session()?.hasTurn()}>
          <span class="stat-pill stat-pill--turn">
            {t("turn.pill", { s: turnSeconds() })}
          </span>
        </Show>

        <Show when={live() && !session()?.ownsStage()}>
          <label class="fps-label" title={t("footer.volumeTitle")}>
            {t("footer.volume")}{" "}
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
            {t("footer.framerate")}
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

        {/* Lights out. Chalk, not grass: the footer already spends the one
            --go this screen gets (docs/design.md § 5.1), and the pressed
            state lives in aria-pressed so the visual and the accessible
            state cannot drift. It stands beside the framerate and stinger
            controls because it is chrome, like they are. */}
        <Show when={live()}>
          <button
            type="button"
            class="crayon-btn crayon-btn--chalk"
            aria-pressed={cinema()}
            title={t("cinema.toggleTitle")}
            onClick={toggleCinema}
          >
            {t("cinema.toggle")}
          </button>
        </Show>

        {/* Livre | Rodízio — a choice with exactly two crayons, so it is
            `.seg` and nothing else (design.md § 5.2). It is the only setting
            this whole feature exposes, and it defaults: the line works with
            nobody touching anything. State lives in `aria-pressed`, and the
            server's broadcast is what everyone reads back, so all viewers
            converge on one mode. */}
        <div class="field">
          <span class="field-label" id="mode-label" title={t("queue.modeTitle")}>
            {t("queue.modeLabel")}
          </span>
          <div class="seg" role="group" aria-labelledby="mode-label">
            <button
              type="button"
              class="seg-btn"
              aria-pressed={queueState().mode !== "rodizio"}
              onClick={() => session()?.setStageMode("livre")}
            >
              {t("queue.modeLivre")}
            </button>
            <button
              type="button"
              class="seg-btn"
              aria-pressed={queueState().mode === "rodizio"}
              onClick={() => session()?.setStageMode("rodizio")}
            >
              {t("queue.modeRodizio")}
            </button>
          </div>
        </div>

        <Show when={stingersOn()}>
          <button
            type="button"
            class="crayon-btn crayon-btn--chalk"
            aria-expanded={stingerPanel()}
            title={t("footer.stingersTitle")}
            onClick={() => setStingerPanel((v) => !v)}
          >
            {t("footer.stingers")}
          </button>
        </Show>

        {/* Everybody who is NOT the one being called just gets told who is
            up. It lives in the footer, beside the error line, rather than
            floating over the stage: a toast centred on the picture is
            exactly what design.md § 2 forbids, and the footer is where this
            app already puts its one transient line. */}
        <Show when={turnToast()}>
          <span class="turn-toast" role="status">
            {t(turnToast()!.key, turnToast()!.params)}
          </span>
        </Show>

        <Show when={error()}>
          <span class="error-text">{errorText()}</span>
        </Show>
      </footer>

      {/* Somebody was picked and nobody asked: the wheel. It runs over a
          `.modal-scrim`, which is chrome — the video keeps its own frame and
          nothing is ever drawn on the picture (design.md § 2). The pick has
          already happened server-side, so this animation is showing a result
          rather than deciding one. */}
      <Show when={wheel()}>
        <div class="modal-scrim wheel-scrim">
          <div class="wheel">
            <For each={wheelCards()}>
              {(c, i) => (
                <span
                  class={i() === 0 ? "wheel-card wheel-card--won" : "wheel-card"}
                  style={{
                    "--card-angle": `${(360 * i()) / Math.max(wheelCards().length, 1)}deg`,
                  }}
                >
                  {c.name}
                </span>
              )}
            </For>
            {/* the winner is card 0, at the top of the circle: the arrow
                spins two whole turns and comes to rest pointing at it */}
            <WheelArrow class="wheel-arrow" />
          </div>
          <p class="wheel-name">{wheel()?.username}</p>
        </div>
      </Show>

      {/* "É tua!" — your own call to the stage. Same modal object as the
          takeover confirm (`.share-card` § 5.7), because it is the same
          question asked from the other side. It is driven straight off the
          server's turn state, so it appears and vanishes with the turn
          itself and can never be left stranded on screen. */}
      <Show when={session()?.hasTurn() && !wheel()}>
        <div class="modal-scrim">
          <div class="share-card modal-card">
            <h2 class="modal-title">{t("turn.yours")}</h2>
            <p class="modal-msg">
              {t("turn.yoursBody", { s: turnSeconds() })}
            </p>
            <div class="modal-actions">
              <button
                class="crayon-btn crayon-btn--go"
                onClick={() => void share()}
              >
                {t("turn.take")}
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={confirmTakeover()}>
        <div class="modal-scrim">
          <div class="share-card modal-card">
            {/* One message with one slot — rendered *around* the slot so the
                name keeps its <strong>. Splitting on the placeholder rather
                than concatenating two half-sentences means a language is
                free to put the name first, last, or in the middle. */}
            <p class="modal-msg">
              {kickParts()[0] ?? ""}
              <strong>{stage().publisherName}</strong>
              {kickParts()[1] ?? ""}
            </p>
            <div class="modal-actions">
              <button
                class="crayon-btn crayon-btn--go"
                onClick={() => {
                  setConfirmTakeover(false);
                  void share();
                }}
              >
                {t("modal.yes")}
              </button>
              <button
                class="crayon-btn crayon-btn--stop"
                onClick={() => setConfirmTakeover(false)}
              >
                {t("modal.no")}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default App;
