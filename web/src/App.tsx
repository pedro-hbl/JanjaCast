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

import type { StageMode, StageTurnData, StingerData, PlacarStateData } from "./protocol";
import { playTurnCue } from "./cue";
import { startCapture, type CaptureHandle } from "./capture";
import { Player } from "./player";
import {
  BrowserTabDoodle,
  PauseDoodle,
  PlayDoodle,
  UndoDoodle,
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
const baseId = (id: string) => {
  if (id.endsWith(":tab")) return id.slice(0, -4);
  if (id.endsWith(":telinha")) return id.slice(0, -8);
  return id;
};
const plainName = (n: string) => n.replace(/\s*\((sharing|telinha)\)\s*$/i, "");

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
  const [awardsId, setAwardsId] = createSignal<string | null>(null);
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
  // Clip UI state
  const [clipWorking, setClipWorking] = createSignal(false);
  // "Quem entrou?" replay: token + fetched event timeline for the panel.
  const [replayTok, setReplayTok] = createSignal<string | null>(null);
  // "Deixa comigo": one armed tap sends a pointer; the publisher sees crayon
  // arrows that fade on their own (TTL) — nothing ever lingers on the video.
  const [aiming, setAiming] = createSignal(false);
  const [arrows, setArrows] = createSignal<Array<{ id: number; x: number; y: number; name: string }>>([]);
  let arrowSeq = 0;
  // The varal: the session's clothesline of polaroids and quote magnets.
  const [varalPins, setVaralPins] = createSignal<import("./protocol").VaralPinData[]>([]);
  const [varalQuote, setVaralQuote] = createSignal("");
  // Corrente da tela: the nomination banner state — server-driven.
  const [corrente, setCorrente] = createSignal<{ target: string; targetName: string; by: string; endsAtMs: number } | null>(null);
  const [correnteTally, setCorrenteTally] = createSignal<{ vai: number; calma: number }>({ vai: 0, calma: 0 });
  // Aposta paralela: current bet card + session win counts, all server truth.
  const [aposta, setAposta] = createSignal<{ id: string; phase: string; text: string; challengerId: string; challengerName: string; targetId: string; targetName: string; winnerId?: string } | null>(null);
  const [apostaWins, setApostaWins] = createSignal<Record<string, number>>({});
  const [betting, setBetting] = createSignal<{ id: string; name: string } | null>(null);
  const [betText, setBetText] = createSignal("");
  // "Cadê todo mundo?": the room's attention, publisher-only knowledge.
  const [attention, setAttention] = createSignal<{ watching: number; total: number } | null>(null);
  // Pitacos: bezel sticky notes, purely transient — each removes itself.
  const [pitacos, setPitacos] = createSignal<Array<{ id: string; text: string; side: string; slot: number; authorName: string }>>([]);
  const [pitacoDraft, setPitacoDraft] = createSignal("");
  const [replayEvents, setReplayEvents] = createSignal<Array<{ type: string; user?: string; density?: number; at: number }>>([]);
  const [clipUrl, setClipUrl] = createSignal<string | null>(null);
  const [clipExpires, setClipExpires] = createSignal<number | null>(null);

  // --- placar (scoreboard) --------------------------------------------------
  const [placarActive, setPlacarActive] = createSignal(false);
  const [placarPrompt, setPlacarPrompt] = createSignal("");
  const [placarScores, setPlacarScores] = createSignal<Record<string, number>>({});
  const [placarCooldown, setPlacarCooldown] = createSignal<Record<string, number>>({});

  let canvasRef!: HTMLCanvasElement;
  let stageRef!: HTMLDivElement;
  let player: Player | null = null;
  // Listen for awards_ready surfaced by session.
  onMount(() => {
    const h = (e: any) => setAwardsId(e.detail as string);
    (window as any).addEventListener("awards_ready", h);
    onCleanup(() => (window as any).removeEventListener("awards_ready", h));
  });

  // --- the varal ----------------------------------------------------------
  const pinQuote = () => {
    const text = varalQuote().trim();
    if (!text) return;
    session()?.sendVaralPin({ kind: "quote", quote: { text: text.slice(0, 80) } });
    setVaralQuote("");
  };
  /** Polaroid of the exact frame on screen right now. JPEG, walked down in
   *  quality until it fits the 64KB wire cap. */
  const pinFrame = () => {
    if (!canvasRef || !canvasRef.width) return;
    let q = 0.7;
    let url = canvasRef.toDataURL("image/jpeg", q);
    while (url.length > 60_000 && q > 0.15) {
      q -= 0.15;
      url = canvasRef.toDataURL("image/jpeg", q);
    }
    if (url.length > 64_000) return;
    session()?.sendVaralPin({ kind: "frame", frame: { dataUrl: url, publisher: stage().publisherName ?? "" } });
  };

  // --- cinema scribbles (local-only helpers) ------------------------------
  const ownStrokes = () => (session()?.cinemaStrokes() ?? []).filter(s => s.userId === session()?.selfId());
  const undoLocal = () => session()?.undoOwnCinemaStroke();

  const sendStroke = (color: string, pts: {x:number;y:number;}[]) => {
    session()?.sendCinemaStroke({ color, points: pts });
  };

  /** The crayon in hand. Lives at App scope so the swatch row and the
   *  drawing surface hold the same one — both send and preview use it. */
  const [ink, setInk] = createSignal<string>("redorange");

  const ColorSwatches: Component = () => {
    const colors = [
      ["--redorange","cinema.colorRed","redorange"],
      ["--crayon-blue","cinema.colorBlue","crayon-blue"],
      ["--yellow","cinema.colorYellow","yellow"],
      ["--grass","cinema.colorGrass","grass"],
      ["--pink","cinema.colorPink","pink"],
      ["--purple","cinema.colorPurple","purple"],
    ] as const;
    return (
      <div style={{ display: "inline-flex", gap: "6px" }}>
        {colors.map(([varName, key, wire]) => (
          <button
            type="button"
            class="color-swatch"
            aria-pressed={ink() === wire}
            aria-label={t(key as any)}
            style={{ background: `var(${varName})` }}
            onClick={() => setInk(wire as string)}
          />
        ))}
      </div>
    );
  };

  const ScribbleSVG: Component = () => {
    let svg!: SVGSVGElement;
    const [path, setPath] = createSignal<string>("");
    const [drawing, setDrawing] = createSignal(false);
    const pts: {x:number;y:number;}[] = [];
    let raf: number | null = null;
    const build = () => {
      if (pts.length < 2) return "";
      let d = `M ${pts[0]!.x*800} ${pts[0]!.y*450}`;
      for (let i=1;i<pts.length;i++){
        const p = pts[i]!;
        const px = pts[i-1]!;
        const cx = (px.x + p.x)/2*800 + (Math.random()-0.5)*2;
        const cy = (px.y + p.y)/2*450 + (Math.random()-0.5)*2;
        d += ` Q ${cx} ${cy} ${p.x*800} ${p.y*450}`;
      }
      return d;
    };
    const onMove = (e: PointerEvent) => {
      if (!drawing()) return;
      const rect = svg.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      pts.push({x: Math.max(0,Math.min(1,x)), y: Math.max(0,Math.min(1,y))});
      if (raf == null) raf = requestAnimationFrame(() => { setPath(build()); raf = null; });
    };
    const onDown = (e: PointerEvent) => {
      if (!session()?.cinemaPaused()) return;
      e.preventDefault();
      setDrawing(true);
      pts.length = 0;
      onMove(e);
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    };
    const onUp = (e: PointerEvent) => {
      if (!drawing()) return;
      setDrawing(false);
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      if (pts.length>=2) sendStroke(ink(), pts.slice());
      setPath("");
    };
    return (
      <svg
        ref={svg}
        viewBox="0 0 800 450"
        class="cinema-svg"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        {/* existing strokes */}
        <For each={session()?.cinemaStrokes() ?? []}>
          {(s) => (
            <path d={(() => {
              const ps = s.points; if (!ps || ps.length<2) return "";
              let d = `M ${ps[0]!.x*800} ${ps[0]!.y*450}`;
              for (let i=1;i<ps.length;i++){
                const p = ps[i]!; const px = ps[i-1]!;
                const cx = (px.x + p.x)/2*800 + (Math.random()-0.5)*1.6;
                const cy = (px.y + p.y)/2*450 + (Math.random()-0.5)*1.6;
                d += ` Q ${cx} ${cy} ${p.x*800} ${p.y*450}`;
              }
              return d;
            })()}
              fill="none"
              stroke={`var(--${s.color})`}
              stroke-width="6"
              stroke-linecap="round"
            />
          )}
        </For>
        {/* in-progress */}
        <path d={path()} fill="none" stroke={`var(--${ink()})`} stroke-width="6" stroke-linecap="round"/>
      </svg>
    );
  };

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
      // Placar state from the relay.
      s.onPlacarState = (d) => {
        const pd = d as PlacarStateData;
        setPlacarActive(Boolean(pd.active));
        setPlacarPrompt(pd.prompt ?? "");
        setPlacarScores(pd.scores ?? {});
      };
      // Same Discord user opened the Activity somewhere newer (another
      // device, a reloaded iframe): this view is terminally disconnected.
      s.onSuperseded = () => setError({ key: "err.superseded" });
      // Stream start/stop stinger — the sharer's own view plays it too.
      s.onStinger = (st) => void playStinger(st);
      s.onClipReady = (d) => {
        setClipWorking(false);
        setClipUrl(d.url);
        setClipExpires(d.expiresMs);
      };
      s.onAssistShow = (d) => {
        const id = ++arrowSeq;
        setArrows((xs) => [...xs, { id, x: d.x, y: d.y, name: d.username }]);
        setTimeout(() => setArrows((xs) => xs.filter((a) => a.id !== id)), d.ttlMs || 4000);
      };
      s.onVaralState = (d) => setVaralPins(d.pins ?? []);
      s.onAttentionState = (d) => setAttention(d);
      // Report visibility now, on every change, and as a 30s heartbeat —
      // the wire is one boolean, the relay does the thinking.
      const reportVis = () => s.reportAttention(document.visibilityState === "visible");
      reportVis();
      document.addEventListener("visibilitychange", reportVis);
      const attnTimer = setInterval(reportVis, 30_000);
      onCleanup(() => {
        document.removeEventListener("visibilitychange", reportVis);
        clearInterval(attnTimer);
      });
      s.onPitacoShow = (d) => {
        setPitacos((xs) => [...xs.filter((p) => p.id !== d.id), d]);
        setTimeout(() => setPitacos((xs) => xs.filter((p) => p.id !== d.id)), d.ttlMs || 10_000);
      };
      s.onApostaState = (d) => {
        if (d.wins) setApostaWins(d.wins);
        setAposta(d);
        if (d.phase === "resolved" || d.phase === "declined" || d.phase === "expired") {
          setTimeout(() => setAposta((a) => (a && a.id === d.id ? null : a)), 6000);
        }
      };
      s.onCorrenteStarted = (d) => { setCorrente(d); setCorrenteTally({ vai: 0, calma: 0 }); };
      s.onCorrenteTally = (d) => setCorrenteTally(d);
      s.onCorrenteCanceled = () => { setCorrente(null); flashToast("corrente.canceled"); };
      s.onReplayReady = (d) => {
        setReplayTok(d.token);
        void fetch(apiPath(`/clip/${d.token}/events.json`))
          .then((r) => (r.ok ? r.json() : []))
          .then((evs) => setReplayEvents(Array.isArray(evs) ? evs : []))
          .catch(() => setReplayEvents([]));
      };
      // Somebody was called to the stage. The cue is room-wide on purpose —
      // "é tua!" is something the whole call hears, the way it would be said
      // out loud. It rides the viewer's own volume slider, and the token
      // makes a duplicated control message a no-op rather than a double beep.
      s.onStageTurn = (turn) => {
        setCorrente(null); // the banner's countdown delivered (or was outrun)
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
    clearInterval(lateTimer);
    capture()?.stop();
    player?.close();
    session()?.close();
  });

  const [companionOpened, setCompanionOpened] = createSignal(false);
  // Companion-tab phase (ISSUE.md §3). Keep `companionOpened` as a derived
  // alias so concurrent work keeps compiling.
  type CompanionPhase = "idle" | "opening" | "late" | "joined" | "failed";
  const [phase, setPhase] = createSignal<CompanionPhase>("idle");
  const [openedAt, setOpenedAt] = createSignal(0);
  /** The companion tab is a connection, not a guess: the relay puts it in
   *  room_state as "<me>:tab" the instant it joins. */
  const companionJoined = () => {
    const meId = session()?.selfId();
    if (!meId) return false;
    const tabId = `${baseId(meId)}:tab`;
    return (session()?.participants().participants ?? []).some((p) => p.userId === tabId);
  };
  const companionPhase = (): CompanionPhase => (companionJoined() ? "joined" : phase());
  const companionOpenedAlias = () => companionPhase() !== "idle";

  /** Discord's iframe denies display-capture, so sharing happens in a
   *  companion tab in the user's real browser (same room, direct origin).
   *  The tab authenticates with a short-lived share token minted here. */
  /** The telinha: a watch-only mirror in the real browser, a few seconds
   *  late by design. Its token carries a ":telinha" identity so it can
   *  never supersede this person's capture tab. */
  const openTelinha = async () => {
    const id = identity();
    if (!id) return;
    const [origin, tokenResp] = await Promise.all([
      fetchPublicOrigin(),
      fetch(apiPath("/api/share-token"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: id.accessToken,
          room: id.room,
          userId: id.userId,
          username: id.username,
          mode: "telinha",
        }),
      }),
    ]);
    if (!tokenResp.ok) return;
    const { shareToken } = (await tokenResp.json()) as { shareToken: string };
    const url = new URL("/telinha", origin);
    url.searchParams.set("token", shareToken);
    url.searchParams.set("room", id.room);
    url.searchParams.set("name", id.username);
    url.searchParams.set("lang", localeParam());
    void openExternal(url.toString());
  };

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
    // Fresh token every time — do not memoize (stale token → 1008).
    const opened = await openExternal(url.toString());
    setOpenedAt(Date.now());
    setPhase(opened === false ? "failed" : "opening");
    setCompanionOpened(true); // legacy alias
  };

  // Promote opening → late after 20 s.
  const lateTimer = setInterval(() => {
    if (phase() === "opening" && Date.now() - openedAt() > 20_000) setPhase("late");
  }, 1000);

  // When a live share ends, return to idle so the hero CTA comes back.
  createEffect(() => {
    if (!live()) setPhase("idle");
  });

  // The tab's presence is authoritative both ways: joining promotes the
  // stored phase past "opening"/"late", and leaving *without ever going
  // live* means the person closed the tab and changed their mind — that
  // must land on the hero CTA, not back on the stale wait copy.
  createEffect<boolean>((was) => {
    const joined = companionJoined();
    if (joined) setPhase("joined");
    else if (was && !live()) setPhase("idle");
    return joined;
  }, false);

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

  // Placar sorted rows: score desc, ties share rank and sort alphabetically.
  const placarRows = () => {
    const rows = roster().map((r) => ({ id: r.id, name: r.name, score: placarScores()[r.id] ?? 0, isSelf: r.isSelf }));
    rows.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
    let rank = 0, lastScore: number | null = null;
    return rows.map((r, i) => {
      if (lastScore === null || r.score !== lastScore) { rank = i + 1; lastScore = r.score; }
      return { ...r, rank };
    });
  };

  const vote = (id: string, delta: 1 | -1) => {
    const cool = placarCooldown();
    const now = Date.now();
    if ((cool[id] ?? 0) > now) return; // debounce 1s
    setPlacarCooldown({ ...cool, [id]: now + 1000 });
    (session() as any)?.sendControl?.("placar_vote", { targetUserId: id, delta } as any);
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
          <Show when={session()?.ownsStage() && attention()}>
            <span class="stat-pill attn-pill" title={t("attn.title")}>
              👀 {attention()!.watching}/{attention()!.total}
            </span>
          </Show>
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
          class={aiming() ? "stage stage--aiming" : "stage"}
          ref={stageRef}
          onDblClick={() => void toggleFullscreen()}
          onClick={(e) => {
            if (!aiming()) return;
            e.stopPropagation();
            setAiming(false);
            const r = canvasRef.getBoundingClientRect();
            if (!r.width || !r.height) return;
            const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
            session()?.sendAssistPoint(x, y);
          }}
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
          {/* INTERVALO banner — chrome announcing state. Drawn over the frozen
              frame only while cinema pause is on; nothing decorates live
              video. */}
          <Show when={session()?.cinemaPaused() && live() && !blanked()}>
            <div class="cinema-banner" role="status">{t("cinema.interval")}</div>
          </Show>
          {/* Group scribbles — margin canvas on desktop, stacked under stage on
              small screens. Never over the video except the banner above. */}
          <Show when={session()?.cinemaPaused()}>
            <div class="cinema-canvas" aria-label={t("cinema.canvasTitle")}>
              <div class="cinema-toolbar">
                <button
                  type="button"
                  class="crayon-btn crayon-btn--chalk"
                  aria-pressed={!false}
                  onClick={() => session()?.resumeCinema()}
                  title={t("cinema.resume")}
                >
                  <PlayDoodle /> {t("cinema.resume")}
                </button>
                <div class="spacer" />
                <ColorSwatches />
                <button type="button" class="crayon-btn crayon-btn--chalk" onClick={undoLocal} disabled={ownStrokes().length === 0}>
                  <UndoDoodle /> {t("cinema.undo")}
                </button>
              </div>
              <ScribbleSVG />
            </div>
          </Show>
          {/* Assist arrows: the "vai na TERCEIRA opção" made visible. Only
              the publisher renders them, they ride a short TTL, and they are
              chrome over the sharer's own view — viewers never see them. */}
          <Show when={session()?.ownsStage() || capture()}>
            <div class="assist-layer" aria-hidden="true">
              <For each={arrows()}>
                {(a) => (
                  <div class="assist-arrow" style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%` }}>
                    <span class="assist-glyph">👉</span>
                    <span class="assist-name">{a.name}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
          {/* Pitacos: sticky notes on the bezel gutters, never the canvas.
              Four slots a side, each note torn down by its own TTL. */}
          <div class="pitaco-layer" aria-hidden="true">
            <For each={pitacos()}>
              {(p) => (
                <div
                  class={p.side === "left" ? "pitaco pitaco--left" : "pitaco pitaco--right"}
                  style={{ top: `${12 + p.slot * 22}%` }}
                >
                  <span class="pitaco-text">{p.text}</span>
                  <span class="pitaco-author">{p.authorName}</span>
                </div>
              )}
            </For>
          </div>
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
          {/* Instant clip button — edge pinned with the fullscreen control. */}
          <button
            class="fs-btn fs-btn--clip"
            title={clipWorking() ? t("clip.working") : t("clip.button")}
            disabled={clipWorking()}
            onClick={() => {
              setClipWorking(true);
              setClipUrl(null);
              setClipExpires(null);
              session()?.requestClip();
            }}
          >
            {clipWorking() ? "⏳" : "🎬"}
          </button>
          {/* "Quem entrou?" — replay the last stretch for late arrivals. */}
          <button
            class="fs-btn fs-btn--replay"
            title={t("replay.button")}
            onClick={() => session()?.requestReplay(90)}
          >
            ⏪
          </button>
          {/* "Deixa comigo" — arm one tap that points for the streamer. */}
          <button
            class={aiming() ? "fs-btn fs-btn--assist fs-btn--armed" : "fs-btn fs-btn--assist"}
            title={t("assist.button")}
            aria-pressed={aiming()}
            onClick={() => setAiming((v) => !v)}
          >
            👉
          </button>
        </Show>
        {/* Clip ready toast with external-open to escape CSP */}
        <Show when={clipUrl()}>
          <div class="toast clip-toast">
            {t("clip.ready")} <button class="crayon-btn" onClick={async () => {
              const p = clipUrl(); if (!p) return;
              try { const { downloadClip } = await import("./clipmux"); await downloadClip(p); }
              catch { await openExternal(apiPath(p)); }
            }}>{t("clip.download")}</button>
          </div>
        </Show>
          {/* The empty stage is a drawing, not a sentence: the JanjaCast
              set standing in the grass under a sun, switched off, with the
              one thing you can do about it planted in front of it. The
              lobby's presence line rides along under the TV — the room is
              a place even before anybody turns the set on. */}
          <Show when={!live()}>
            <div class="stage-scene">
              <StageBackdrop />
              <Show
                when={companionPhase() !== "idle"}
                fallback={
                  <div class="scene-stack">
                    <SceneTv class="scene-tv" />
                    <p class="scene-line">
                      {roster().length > 1
                        ? t("lobby.here", { count: roster().length })
                        : t("lobby.alone")}
                    </p>
                    <button
                      onClick={shareClicked}
                      class="crayon-btn crayon-btn--go scene-cta"
                    >
                      {t("stage.shareScreen")}
                    </button>
                  </div>
                }
              >
                {/* One <Show>, four faces. */}
                <div class="scene-stack">
                  <BrowserTabDoodle class="scene-tab" />
                  <Show when={companionPhase() === "opening"}>
                    <p class="scene-line">{t("stage.companionOpening")}</p>
                  </Show>
                  <Show when={companionPhase() === "late"}>
                    <p class="scene-line">{t("stage.companionLate")}</p>
                    <button onClick={shareClicked} class="crayon-btn crayon-btn--go scene-cta">
                      {t("stage.openAgain")}
                    </button>
                  </Show>
                  <Show when={companionPhase() === "joined"}>
                    <p class="scene-line">{t("stage.companionOpen")}</p>
                  </Show>
                  <Show when={companionPhase() === "failed"}>
                    <p class="scene-line">{t("stage.companionFailed")}</p>
                    <button onClick={shareClicked} class="crayon-btn crayon-btn--go scene-cta">
                      {t("stage.openAgain")}
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>

        </div>

        {/* Corrente da tela: the nomination countdown — border chrome, the
            room's light consensus in two buttons. */}
        <Show when={corrente()}>
          <div class="corrente-banner" role="status">
            <span class="corrente-line">
              {t("corrente.line", { name: corrente()!.targetName, s: Math.max(0, Math.ceil((corrente()!.endsAtMs - (session()?.serverNow() ?? Date.now())) / 1000) + tick() * 0) })}
            </span>
            <button class="crayon-btn crayon-btn--go" onClick={() => session()?.voteCorrente("vai")}>
              {t("corrente.vai")} {correnteTally().vai || ""}
            </button>
            <button class="crayon-btn crayon-btn--chalk" onClick={() => session()?.voteCorrente("calma")}>
              {t("corrente.calma")} {correnteTally().calma || ""}
            </button>
          </div>
        </Show>

        {/* The varal: a clothesline under the TV where the session's best
            moments hang — polaroids of exact frames and quote magnets.
            Chrome below the stage, never over it; dies with the room. */}
        <div class="varal">
          <div class="varal-line" aria-hidden="true" />
          <div class="varal-pins">
            <For each={varalPins()}>
              {(p) => (
                <div class={p.kind === "frame" ? "varal-pin varal-pin--frame" : "varal-pin varal-pin--quote"}>
                  <Show when={p.kind === "frame" && p.frame}>
                    <img class="varal-photo" src={p.frame!.dataUrl} alt="" />
                  </Show>
                  <Show when={p.kind === "quote" && p.quote}>
                    <span class="varal-text">{p.quote!.text}</span>
                  </Show>
                  <Show when={p.authorId === session()?.selfId() || session()?.ownsStage()}>
                    <button class="varal-x" title={t("varal.remove")} onClick={() => session()?.removeVaralPin(p.id)}>×</button>
                  </Show>
                </div>
              )}
            </For>
            <Show when={!varalPins().length}>
              <span class="varal-empty">{t("varal.empty")}</span>
            </Show>
          </div>
          <div class="varal-actions">
            <Show when={live()}>
              <button class="crayon-btn crayon-btn--chalk" title={t("varal.pinFrame")} onClick={pinFrame}>📸</button>
            </Show>
            <input
              class="varal-input"
              maxlength="80"
              placeholder={t("varal.placeholder")}
              value={varalQuote()}
              onInput={(e) => setVaralQuote(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter") pinQuote(); }}
            />
            <button class="crayon-btn crayon-btn--chalk" onClick={pinQuote}>📌</button>
            <input
              class="varal-input"
              maxlength="60"
              placeholder={t("pitaco.placeholder")}
              value={pitacoDraft()}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const txt = pitacoDraft().trim();
                if (!txt) return;
                session()?.postPitaco(txt, Math.random() < 0.5 ? "left" : "right");
                setPitacoDraft("");
              }}
              onInput={(e) => setPitacoDraft(e.currentTarget.value)}
            />
          </div>
        </div>

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
                  <Show when={!p.isSelf}>
                    <button
                      class="aposta-dare"
                      title={t("aposta.dare", { name: p.name })}
                      onClick={() => { setBetting({ id: p.id, name: p.name }); setBetText(""); }}
                    >
                      🎲
                    </button>
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

          {/* "Quem entrou?" replay panel — margin UI, never over the stage.
              A joins list (the literal answer), a hype heatmap from the
              event timeline, and the 90s cut as a real file. */}
          <Show when={replayTok()}>
            <div class="replay-panel">
              <h5 class="replay-title">{t("replay.title")}</h5>
              <div class="replay-joins">
                <For each={replayEvents().filter((e) => e.type === "join").slice(-6)}>
                  {(e) => <span class="replay-join">{e.user}</span>}
                </For>
                <Show when={!replayEvents().some((e) => e.type === "join")}>
                  <span class="replay-join replay-join--none">{t("replay.noJoins")}</span>
                </Show>
              </div>
              <div class="replay-heat" aria-label={t("replay.heatLabel")}>
                {(() => {
                  const bursts = replayEvents().filter((e) => e.type === "activity");
                  if (!bursts.length) return <span class="replay-join--none">{t("replay.quiet")}</span>;
                  const t0 = bursts[0]!.at;
                  const buckets = new Array<number>(12).fill(0);
                  for (const b of bursts) {
                    const i = Math.min(11, Math.floor((b.at - t0) / 7500));
                    buckets[i] = Math.max(buckets[i]!, b.density ?? 1);
                  }
                  const max = Math.max(...buckets, 1);
                  return buckets.map((v) => (
                    <span class="heat-bar" style={{ height: `${6 + (v / max) * 22}px` }} />
                  ));
                })()}
              </div>
              <div class="replay-actions">
                <button class="crayon-btn" onClick={async () => {
                  const tok = replayTok(); if (!tok) return;
                  try { const { downloadClip } = await import("./clipmux"); await downloadClip(`/clip/${tok}`); }
                  catch { await openExternal(apiPath(`/clip/${tok}`)); }
                }}>{t("replay.download")}</button>
                <button class="crayon-btn crayon-btn--chalk" onClick={() => { setReplayTok(null); setReplayEvents([]); }}>
                  {t("replay.close")}
                </button>
              </div>
            </div>
          </Show>

          {/* Aposta paralela: the composer (writes the bet on the spot) and
              the live bet card — margin UI, the room as witness bench. */}
          <Show when={betting()}>
            <div class="aposta-compose">
              <span class="aposta-vs">{t("aposta.against", { name: betting()!.name })}</span>
              <input
                class="varal-input"
                maxlength="80"
                placeholder={t("aposta.placeholder")}
                value={betText()}
                onInput={(e) => setBetText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setBetting(null);
                  if (e.key !== "Enter") return;
                  const txt = betText().trim();
                  if (!txt) return;
                  session()?.challengeAposta(betting()!.id, txt);
                  setBetting(null);
                }}
              />
            </div>
          </Show>
          <Show when={aposta()}>
            <div class={`aposta-card aposta-card--${aposta()!.phase}`}>
              <span class="aposta-head">
                {aposta()!.challengerName} 🆚 {aposta()!.targetName}
              </span>
              <span class="aposta-text">“{aposta()!.text}”</span>
              <Show when={aposta()!.phase === "offered" && baseId(aposta()!.targetId) === baseId(me())}>
                <div class="aposta-actions">
                  <button class="crayon-btn crayon-btn--go" onClick={() => session()?.answerAposta(aposta()!.id, true)}>{t("aposta.accept")}</button>
                  <button class="crayon-btn crayon-btn--chalk" onClick={() => session()?.answerAposta(aposta()!.id, false)}>{t("aposta.decline")}</button>
                </div>
              </Show>
              <Show when={aposta()!.phase === "offered" && baseId(aposta()!.targetId) !== baseId(me())}>
                <span class="aposta-note">{t("aposta.waiting", { name: aposta()!.targetName })}</span>
              </Show>
              <Show when={aposta()!.phase === "on" && session()?.ownsStage()}>
                <div class="aposta-actions">
                  <button class="crayon-btn" title={t("aposta.judgeChallenger")} onClick={() => session()?.judgeAposta(aposta()!.id, "challenger")}>👍 {aposta()!.challengerName}</button>
                  <button class="crayon-btn" title={t("aposta.judgeTarget")} onClick={() => session()?.judgeAposta(aposta()!.id, "target")}>👍 {aposta()!.targetName}</button>
                </div>
              </Show>
              <Show when={aposta()!.phase === "on" && !session()?.ownsStage()}>
                <span class="aposta-note">{t("aposta.live")}</span>
              </Show>
              <Show when={aposta()!.phase === "resolved"}>
                <span class="aposta-note aposta-note--won">
                  {t("aposta.won", { name: baseId(aposta()!.winnerId ?? "") === baseId(aposta()!.challengerId) ? aposta()!.challengerName : aposta()!.targetName })}
                </span>
              </Show>
              <Show when={aposta()!.phase === "declined"}>
                <span class="aposta-note">{t("aposta.declined")}</span>
              </Show>
              <Show when={aposta()!.phase === "expired"}>
                <span class="aposta-note">{t("aposta.expired")}</span>
              </Show>
            </div>
          </Show>

          {/* Placar panel — margin UI under roster; never over the stage. */}
          <Show when={placarActive()}>
            <div class="placar-panel">
              <h5 class="placar-title">{placarPrompt()}</h5>
              <div class="placar-list">
                <For each={placarRows()}>{(r) => (
                  <div class={r.isSelf ? "placar-row placar-row--self" : "placar-row"}>
                    <span class="placar-rank">{r.rank}</span>
                    <span class="placar-name" title={r.name}>{r.name}</span>
                    <span class="placar-score">{r.score}</span>
                    <button class="placar-btn" aria-label={t("placar.plus", { name: r.name })} onClick={() => vote(r.id, 1)}>+
                    </button>
                    <button class="placar-btn" aria-label={t("placar.minus", { name: r.name })} onClick={() => vote(r.id, -1)}>−
                    </button>
                  </div>
                )}</For>
              </div>
            </div>
          </Show>

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

      <Show when={awardsId()}>
        <div class="toast awards-toast">
          <span>{t("awards.ready")}</span>
          <button class="crayon-btn crayon-btn--go" onClick={() => openExternal(`/awards/${awardsId()}?lang=${localeParam()}`)}>
            {t("awards.view")}
          </button>
          <button class="toast-x" aria-label={t("awards.dismiss")} onClick={() => setAwardsId(null)}>×</button>
        </div>
      </Show>

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
                <Show when={live()}>
                  <button
                    onClick={shareClicked}
                    class="crayon-btn crayon-btn--go"
                  >
                    {t("footer.takeStage")}
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

        {/* Cinema pause/resume (publisher-only) */}
        <Show when={session()?.ownsStage()}>
          <button
            type="button"
            class="crayon-btn crayon-btn--chalk"
            onClick={() =>
              session()?.cinemaPaused()
                ? session()?.resumeCinema()
                : session()?.pauseCinema()
            }
          >
            <Show when={session()?.cinemaPaused()} fallback={<><PauseDoodle /> {t("cinema.pause")}</>}>
              <><PlayDoodle /> {t("cinema.resume")}</>
            </Show>
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
          <button
            type="button"
            class="crayon-btn crayon-btn--chalk"
            title={t("telinha.badge")}
            onClick={() => void openTelinha()}
          >
            {t("telinha.open")}
          </button>
          <Show when={session()?.ownsStage() && roster().filter((p) => !p.isSelf).length > 0}>
            <select
              class="corrente-pick"
              title={t("corrente.pick")}
              onChange={(e) => {
                const id = e.currentTarget.value;
                if (id) session()?.nominateCorrente(id);
                e.currentTarget.value = "";
              }}
            >
              <option value="">{t("corrente.pick")}</option>
              <For each={roster().filter((p) => !p.isSelf)}>
                {(p) => <option value={p.id}>{p.name}</option>}
              </For>
            </select>
          </Show>
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

        {/* The party hat: the slot filling up, drawn not spelled. Rodízio
            only, while somebody holds the stage. */}
        <Show when={queueState().mode === "rodizio" && live() && queueState().timerStartMs}>
          <span class="hat" title={t("hat.title")} aria-hidden="true">
            <span class="hat-cone">🎉</span>
            <span class="hat-fill" style={{ height: `${(() => { tick(); const q = queueState(); const now = session()?.serverNow() ?? Date.now(); return Math.min(100, Math.max(0, ((now - (q.timerStartMs ?? now)) / q.turnLenMs) * 100)); })()}%` }} />
          </span>
        </Show>

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
// dead code guard
export async function __noopClip(p?: string | null) {
  p = p ?? null;
  if (!p) return;
  try {
    const { downloadClip } = await import("./clipmux");
    await downloadClip(p);
  } catch (e) {
    console.error("clip mux failed", e);
    // Fallback: open raw URL
    await openExternal(apiPath(p));
  }
}
// --- Captions + Jukebox UI wiring (under stage and sidebar) -------------
import { For as For2, Show as Show2, createMemo as createMemo2, onCleanup as onCleanup2, onMount as onMount2 } from "solid-js";
import { createSession as createSession2 } from "./session";
import { t as t2 } from "./i18n";

function CaptionsAndJukebox() {
  // Assume ws and role are created similarly to existing app; keep minimal to wire UI
  const ws = new WebSocket((window as any).JANJACAST_WS_URL || "/ws");
  const isPublisher = !!(window as any).JANJACAST_IS_PUBLISHER;
  const s = createSession2(ws, isPublisher);

  // Audio element for jukebox playback (same pattern as stinger overlay)
  let audioEl: HTMLAudioElement | undefined;
  onMount2(() => {
    audioEl = new Audio();
  });
  const nowUrl = createMemo2(() => s.nowPlaying()?.id ? `/api/stingers/${s.nowPlaying()!.id}` : "");
  const playIfAny = () => {
    const url = nowUrl();
    if (audioEl && url) {
      audioEl.src = url;
      audioEl.play().catch(() => {});
    }
  };
  const stopAudio = () => {
    if (audioEl) {
      audioEl.pause();
      audioEl.currentTime = 0;
    }
  };
  // react to nowPlaying changes
  // simple reactive tick: polling memo (Solid lacks subscribe on accessor)
  const tick = setInterval(() => { void nowUrl(); playIfAny(); }, 250);
  onCleanup2(() => {
    stopAudio();
    clearInterval(tick);
  });

  let captionInput!: HTMLInputElement;

  return (
    <div class="app">
      {/* Stage sits elsewhere; we only add under-band and sidebar */}

      {/* Caption band UNDER the stage */}
      <div class="caption-band">
        <For2 each={s.captionLines().slice(-2)}>
          {(line) => (
            <div class="caption-line">{line.text}</div>
          )}
        </For2>
        <Show2 when={s.captionsEnabled()}>
          <form
            class="caption-form"
            onSubmit={(e) => {
              e.preventDefault();
              s.submitCaption(captionInput.value);
              captionInput.value = "";
            }}
          >
            <input
              ref={captionInput}
              type="text"
              placeholder={t2("caption.placeholder")}
            />
            <Show2 when={s.isPublisher}>
              <button type="button" onClick={() => s.toggleCaptions(!s.captionsEnabled())}>
                {s.captionsEnabled() ? t2("caption.disable") : t2("caption.enable")}
              </button>
            </Show2>
          </form>
        </Show2>
      </div>

      {/* Jukebox sidebar */}
      <aside class="jukebox">
        <h3>{t2("jukebox.title")}</h3>
        <div class="queue">
          <For2 each={s.jukeboxQueue()}>
            {(item) => (
              <div class="queue-item">
                <div class="meta">
                  <div class="title">{item.title}</div>
                  <div class="by">{t2("jukebox.by", { name: item.requestedBy })}</div>
                </div>
                <Show2 when={s.isPublisher}>
                  <button onClick={() => s.approveJukebox(item.id)}>{t2("jukebox.approve")}</button>
                </Show2>
              </div>
            )}
          </For2>
        </div>
        <div class="assets">
          <For2 each={(window as any).JANJACAST_STINGERS || []}>
            {(asset: any) => (
              <button class="request" onClick={() => s.requestJukebox(asset.id)}>
                {t2("jukebox.request_asset", { title: asset.title })}
              </button>
            )}
          </For2>
        </div>
      </aside>
      <CaptionsAndJukebox />
    </div>
  );
}
