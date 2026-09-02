// Companion capture page (/share?room=...&name=...): opened in the user's
// real browser when Discord's Activity iframe denies display-capture. It
// joins the same room over WebSocket, takes the stage, and streams — while
// the Activity remains the viewing surface for everyone in the call.

import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import type { Identity } from "./discord";
import { Session, type SessionStatus } from "./session";
import { startCapture, type CaptureHandle } from "./capture";
import { CastMark, HandUpDoodle, OnAirDot, SunDoodle, Wordmark } from "./doodles";
import { errorKey, t, type MessageKey, type Params } from "./i18n";
import { LangToggle } from "./LangToggle";
import "./theme.css";

/** Same as App's: an error is stored as a *descriptor* so it re-renders in
 *  the new language when the toggle flips. A bare string is for messages we
 *  do not own (browser DOMExceptions out of getDisplayMedia). */
type ShareError = string | { key: MessageKey; params?: Params };

/** Connection words. /share keeps the words rather than the Activity's
 *  LinkDot, because the wait state would have to be yellow and yellow is
 *  invisible on cream (docs/design.md § 5.11). */
const CONN_KEY: Record<SessionStatus, MessageKey> = {
  connecting: "conn.connecting",
  open: "conn.open",
  reconnecting: "conn.reconnecting",
  closed: "conn.closed",
  unauthorized: "conn.unauthorized",
  superseded: "conn.superseded",
};

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
  // 60 is the default everywhere: this is a games-and-video product first,
  // and the encoder's adaptive bitrate already gives the frames back when
  // the network can't carry them.
  const [fps, setFps] = createSignal<30 | 60>(
    params.get("fps") === "30" ? 30 : 60,
  );
  const [stats, setStats] = createSignal({ fps: 0, kbps: 0, targetKbps: 0 });
  const [error, setError] = createSignal<ShareError | null>(null);
  const errorText = (): string | null => {
    const e = error();
    if (e == null) return null;
    return typeof e === "string" ? e : t(e.key, e.params);
  };
  const connWord = () => t(CONN_KEY[session.status()]);
  // "auto" reads the surface the sharer picked (tab ⇒ motion, screen or
  // window ⇒ text). The two explicit values stay reachable under Advanced.
  const [hint, setHint] = createSignal<"auto" | "text" | "motion">("auto");
  const [audioMode, setAudioMode] = createSignal<"app" | "system" | "none">("app");
  const [takenBy, setTakenBy] = createSignal<string | null>(null);
  /** Privacy panic. Mirrors capture's own gate so the UI can label itself
   *  without reaching into the encoder every render. */
  const [blanked, setBlanked] = createSignal(false);
  const [viewers, setViewers] = createSignal(0);
  const [budgetKbps, setBudgetKbps] = createSignal(0);

  // --- the rodízio clock ----------------------------------------------------
  // The capture tab is where the sharer is actually looking while they share,
  // so this is where the clock lives. Everything is derived from the server's
  // timestamps (session.queue()) against session.serverNow(): a client with a
  // skewed clock renders a wrong countdown, never a different answer than the
  // room's. The only local state is "I dismissed the one-minute warning".
  const [now, setNow] = createSignal(0);
  const clockTimer = setInterval(() => setNow((n) => n + 1), 500);
  const [warnDismissed, setWarnDismissed] = createSignal(false);

  /** Milliseconds left in this turn, or null when no clock is running. */
  const msLeft = (): number | null => {
    now(); // subscribe
    const q = session.queue();
    if (q.mode !== "rodizio" || !q.timerStartMs) return null;
    if (!capture()) return null; // not our turn to be counting
    return q.timerStartMs + q.turnLenMs - session.serverNow();
  };
  const timeLeftLabel = () => {
    const ms = Math.max(0, msLeft() ?? 0);
    return t("rodizio.left", {
      m: Math.floor(ms / 60000),
      s: Math.floor((ms % 60000) / 1000),
    });
  };
  const oneMinuteLeft = () => {
    const ms = msLeft();
    return ms != null && ms > 0 && ms <= 60_000 && !warnDismissed();
  };
  const timeUp = () => {
    const ms = msLeft();
    return ms != null && ms <= 0;
  };

  // A fresh turn (or a fresh +5) re-arms the warning: dismissing it once must
  // not silence it for the rest of the night.
  createEffect(() => {
    const q = session.queue();
    void q.timerStartMs;
    void q.extended;
    setWarnDismissed(false);
  });

  session.onServerError = (code) => {
    const key = errorKey(code);
    if (key) setError({ key });
  };

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
    setBlanked(false);
    setError({ key: "share.replaced" });
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
        setBlanked(false);
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
      // Taking the stage clears the room's blank (a fresh stream must never
      // inherit a stale one — internal/relay/relay.go). If we are still
      // hidden, say so again immediately, or a reconnect would silently
      // un-hide the sharer. The local encoder gate never lapsed.
      if (c.isBlanked()) session.setBlank(true);
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

  /**
   * The panic button. Order is the whole design here, and it is different
   * in each direction:
   *
   *   Hiding — the encoder gate goes first, synchronously, so the frame
   *   being read right now is already refused before the control message
   *   has even been serialized. Nothing waits on a round trip.
   *
   *   Coming back — the relay's gate is lifted first. A WebSocket keeps
   *   text and binary in one order, so telling the relay before un-gating
   *   the encoder guarantees the un-blank is processed ahead of our first
   *   chunk; the other order would have the relay drop the recovery
   *   keyframe and leave the room staring at the card.
   */
  const toggleBlank = () => {
    const c = capture();
    if (!c) return;
    const next = !c.isBlanked();
    if (next) {
      c.setBlanked(true);
      session.setBlank(true);
    } else {
      session.setBlank(false);
      c.setBlanked(false); // also forces the recovery keyframe
    }
    setBlanked(next);
  };

  // Ctrl+Shift+B — a deliberate three-key chord, because an accidental
  // blank is worse than the risk it guards against. No focus-change
  // auto-blank ships anywhere in this file, by design.
  const onKey = (e: KeyboardEvent) => {
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
    if (e.key !== "b" && e.key !== "B") return;
    if (!capture()) return;
    e.preventDefault();
    toggleBlank();
  };
  onMount(() => document.addEventListener("keydown", onKey));

  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
    clearInterval(statsTimer);
    clearInterval(syncTimer);
    clearInterval(clockTimer);
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
        audioMode: audioMode(),
      });
      handle.onended = stop;
      handle.onconfigchange = (cfg) => session.announceConfig(cfg);
      setCapture(handle);
      setBlanked(false);
      // Verification hook for the blank gates: a devtools console can read
      // __janjacast.blankStats() and confirm sentChunks does not move while
      // hidden, without instrumenting the wire. Debug surface only — nothing
      // in the app reads it.
      (globalThis as { __janjacast?: unknown }).__janjacast = handle;
      session.takeStage();
      session.announceConfig(handle.config);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stop = () => {
    capture()?.stop();
    setCapture(null);
    setBlanked(false);
    session.leaveStage();
  };

  return (
    <div class="share-page">
      <SunDoodle class="share-sun" />
      {/* opposite corner from the sun, so the sheet keeps one drawing in
          each top corner rather than two things fighting for the same one */}
      <LangToggle class="share-lang" />

      <div class="share-card">
        <h1 class="share-title">
          {/* the same .logo lockup as the Activity header, one step up the
              type scale — deep-blue ink because the wave sits on cream */}
          <span class="logo u-scribble u-scribble--deep">
            <CastMark class="logo-mark" size={36} />
            <Wordmark />
          </span>
          <span class="share-title-sub">{t("share.sub")}</span>
        </h1>
        <p class="share-room">
          {t("share.room")} <code>{room}</code> · {t("share.connection")}:{" "}
          {connWord()}
        </p>

        <Show when={capture() && session.status() !== "open"}>
          <p class="error-text">
            {session.status() === "unauthorized"
              ? t("share.expired")
              : t("share.notConnected")}
          </p>
        </Show>

        <Show
          when={capture()}
          fallback={
            <>
              <Show when={takenBy()}>
                <p class="error-text">
                  {t("err.tookStage", { name: takenBy() ?? "" })}
                </p>
              </Show>
              <div class="field">
                <span class="field-label" id="share-fps-label">
                  {t("footer.framerate")}
                </span>
                <div class="seg" role="group" aria-labelledby="share-fps-label">
                  <button
                    type="button"
                    class="seg-btn"
                    aria-pressed={fps() === 30}
                    onClick={() => setFps(30)}
                  >
                    30
                  </button>
                  <button
                    type="button"
                    class="seg-btn"
                    aria-pressed={fps() === 60}
                    onClick={() => setFps(60)}
                  >
                    60
                  </button>
                </div>
                <span class="seg-unit">fps</span>
              </div>
              <button
                onClick={start}
                disabled={session.status() !== "open"}
                class="crayon-btn crayon-btn--go crayon-btn--big"
              >
                {t("share.start")}
              </button>
              <p class="share-hint">{t("share.hint")}</p>

              {/* Everything below here already has a right answer, and the
                  right answer is the default. The disclosure keeps the two
                  modes reachable without asking anybody to have an opinion:
                  the codec is gone entirely (always the best the hardware
                  offers), sharpness reads the picked surface, and sound is
                  scoped to the captured app so the call can't echo. */}
              <details class="crayon-details">
                <summary>{t("share.advanced")}</summary>
                <div class="details-body">
                  <label class="fps-label">
                    {t("share.optimize")}{" "}
                    <select
                      class="crayon-select"
                      value={hint()}
                      onChange={(e) =>
                        setHint(
                          e.currentTarget.value as "auto" | "text" | "motion",
                        )
                      }
                    >
                      <option value="auto">{t("share.opt.auto")}</option>
                      <option value="text">{t("share.opt.text")}</option>
                      <option value="motion">{t("share.opt.motion")}</option>
                    </select>
                  </label>
                  <label class="fps-label">
                    {t("share.sound")}{" "}
                    <select
                      class="crayon-select"
                      value={audioMode()}
                      onChange={(e) =>
                        setAudioMode(
                          e.currentTarget.value as "app" | "system" | "none",
                        )
                      }
                    >
                      <option value="app">{t("share.snd.app")}</option>
                      <option value="system">{t("share.snd.system")}</option>
                      <option value="none">{t("share.snd.none")}</option>
                    </select>
                  </label>
                  <p class="share-hint">
                    {audioMode() === "app"
                      ? t("share.sndHint.app")
                      : audioMode() === "system"
                        ? t("share.sndHint.system")
                        : t("share.sndHint.none")}
                  </p>
                </div>
              </details>
            </>
          }
        >
          {/* The panic button sits directly under the live line and above
              everything else: when it is needed it is needed *now*, and the
              first thing the eye lands on after "you are live" should be the
              way to stop being live. Its own badge rides beside it so the
              armed state is never one glance away from being forgotten. */}
          <div class="blank-row">
            <button
              type="button"
              class="crayon-btn crayon-btn--panic crayon-btn--big"
              aria-pressed={blanked()}
              title={t("blank.hotkey.hint")}
              onClick={toggleBlank}
            >
              {blanked() ? t("blank.button.off") : t("blank.button.on")}
            </button>
            <Show when={blanked()}>
              <span class="blank-badge" role="status">
                {t("blank.badge.blanked")}
              </span>
            </Show>
          </div>
          <p class="share-hint">{t("blank.hotkey.hint")}</p>

          <p class="share-live">
            <OnAirDot class="live-dot" />{" "}
            {t("share.liveLine", {
              fps: fps(),
              realFps: stats().fps,
              kbps: stats().kbps,
              target: stats().targetKbps,
            })}
          </p>
          <div class="field">
            <span class="field-label" id="share-live-fps-label">
              {t("footer.framerate")}
            </span>
            <div
              class="seg"
              role="group"
              aria-labelledby="share-live-fps-label"
            >
              <button
                type="button"
                class="seg-btn"
                aria-pressed={fps() === 30}
                onClick={() => {
                  setFps(30);
                  void capture()?.setFramerate(30);
                }}
              >
                30
              </button>
              <button
                type="button"
                class="seg-btn"
                aria-pressed={fps() === 60}
                onClick={() => {
                  setFps(60);
                  void capture()?.setFramerate(60);
                }}
              >
                60
              </button>
            </div>
            <span class="seg-unit">fps</span>
          </div>
          {/* The rodízio clock. Only visible in rodízio mode — in livre mode
              there is nothing counting and therefore nothing to show. */}
          <Show when={msLeft() != null}>
            <p class="rodizio-line">
              <span class="stat-pill">{timeLeftLabel()}</span>
              <button
                type="button"
                class="crayon-btn crayon-btn--chalk crayon-btn--tiny"
                onClick={() => {
                  setError(null);
                  session.passStage();
                }}
              >
                {t("queue.pass")}
              </button>
            </p>
          </Show>
          {/* One minute out: a nudge you can wave away, not a wall. */}
          <Show when={oneMinuteLeft()}>
            <p class="rodizio-warn">
              {t("rodizio.oneMinute")}{" "}
              <button
                type="button"
                class="rodizio-warn-close"
                aria-label={t("modal.no")}
                onClick={() => setWarnDismissed(true)}
              >
                ×
              </button>
            </p>
          </Show>
          <p class="share-room">
            {t("share.watching", { count: viewers() })} ·{" "}
            {t("share.upload", {
              mbps:
                Math.round((stats().kbps * Math.max(viewers(), 1)) / 100) / 10,
            })}
            {budgetKbps() > 0 &&
            stats().kbps * Math.max(viewers(), 1) > budgetKbps()
              ? t("share.overBudget")
              : ""}
          </p>
          <button
            onClick={stop}
            class="crayon-btn crayon-btn--stop crayon-btn--big"
          >
            {t("footer.stopSharing")}
          </button>
          <p class="share-hint">{t("share.minimize")}</p>
        </Show>

        <Show when={error()}>
          <p class="error-text">{errorText()}</p>
        </Show>
      </div>

      {/* Time's up. Blocking, because this is the one moment the rodízio
          needs an answer — but it never takes the stage away by itself
          (there is no forced release), so both buttons are the sharer's own
          decision. Same `.share-card` modal object as the takeover confirm. */}
      <Show when={timeUp()}>
        <div class="modal-scrim">
          <div class="share-card modal-card">
            <h2 class="modal-title">
              <HandUpDoodle class="modal-title-icon" />
              {t("rodizio.upTitle")}
            </h2>
            <p class="modal-msg">{t("rodizio.upBody")}</p>
            <div class="modal-actions">
              <button
                class="crayon-btn crayon-btn--go"
                onClick={() => {
                  setError(null);
                  session.passStage();
                }}
              >
                {t("queue.pass")}
              </button>
              <button
                class="crayon-btn crayon-btn--chalk"
                disabled={session.queue().extended}
                onClick={() => {
                  setError(null);
                  session.extendStage();
                }}
              >
                {t("rodizio.extend")}
              </button>
            </div>
            <Show when={error()}>
              <p class="error-text">{errorText()}</p>
            </Show>
          </div>
        </div>
      </Show>

      <div class="grass-strip" aria-hidden="true" />
    </div>
  );
};

export default SharePage;
