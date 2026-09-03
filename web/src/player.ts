// Viewer playback front (wave R): the VIDEO half — decode and paint — runs
// in playerWorker.ts against an OffscreenCanvas, so the picture never
// competes with Solid or suffers tab throttling. This class keeps what must
// stay on the main thread: the AudioContext (audio decode + scheduling),
// pointer/wheel input for zoom & pan, and the stats the HUD reads.
//
// A/V sync crosses the thread boundary as a wall-clock anchor ("audio chunk
// T starts playing at Date.now() X"); the worker bounds video delay to
// 300ms exactly as before — alignment only, never accumulation, so alt-tab
// keeps introducing zero delay by construction.

import {
  KIND_AUDIO,
  KIND_VIDEO,
  unpackMedia,
  type ConfigData,
  type SyncData,
} from "./protocol";

export interface PlayerStats {
  fps: number;
  kbps: number;
  /** Glass-to-glass latency estimate in ms; null until a sync mark arrives. */
  latencyMs: number | null;
}

/** Viewer zoom range. 1 = whole frame (fit), 8 = 8x magnification. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/** transferControlToOffscreen is once-per-canvas; a rebuilt Player on the
 *  same element must reuse the first transfer (and its worker). */
const offscreenCache = new WeakMap<
  HTMLCanvasElement,
  { worker: Worker; offscreen: OffscreenCanvas }
>();

export class Player {
  private worker: Worker;
  private audioDecoder: AudioDecoder | null = null;
  private audioCtx: AudioContext | null = null;
  private gain: GainNode | null = null;
  // Default below unity: the Activity's output is OUTSIDE Discord's echo
  // canceller (it plays via the OS, not Discord's audio engine), so viewer
  // speakers feed it back into the call via their mics. Lower gain lowers
  // that loop's strength; the user slider overrides.
  private volume = 0.7;
  private audioPlayhead = 0;

  private byteCount = 0;
  private videoStats: { fps: number; latencyMs: number | null } = {
    fps: 0,
    latencyMs: null,
  };
  /** Mirror of the OffscreenCanvas size — the placeholder element's
   *  attributes stop tracking after transferControlToOffscreen. */
  private frameW = 300;
  private frameH = 150;
  private currentStats: PlayerStats = { fps: 0, kbps: 0, latencyMs: null };
  private statsTimer: ReturnType<typeof setInterval>;
  private clockTimer: ReturnType<typeof setInterval>;

  // --- viewer zoom / pan (purely local: no protocol or bandwidth cost) ---
  private zoomLevel = 1;
  /** Centre of the visible source window, normalized 0..1 of the frame. */
  private panX = 0.5;
  private panY = 0.5;
  private dragFrom: { x: number; y: number } | null = null;
  /** Fired (throttled) when video is stalled waiting for a keyframe. */
  onNeedKeyframe: (() => void) | null = null;

  /** Fired when the viewer's zoom factor changes (for the "N.Nx" pill). */
  onZoomChange: ((zoom: number) => void) | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    /** Server wall clock in Unix ms (from Session.serverNow). */
    private serverNow: () => number = () => Date.now(),
  ) {
    let cached = offscreenCache.get(canvas);
    if (!cached) {
      const offscreen = canvas.transferControlToOffscreen();
      const worker = new Worker(new URL("./playerWorker.ts", import.meta.url), {
        type: "module",
      });
      worker.postMessage({ type: "init", canvas: offscreen }, [offscreen]);
      cached = { worker, offscreen };
      offscreenCache.set(canvas, cached);
    }
    this.worker = cached.worker;
    this.worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "stats") {
        this.videoStats = { fps: m.fps, latencyMs: m.latencyMs };
      } else if (m.type === "dims") {
        this.frameW = m.w;
        this.frameH = m.h;
      } else if (m.type === "needKeyframe") {
        this.onNeedKeyframe?.();
      }
    };

    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);

    this.statsTimer = setInterval(() => {
      this.currentStats = {
        fps: this.videoStats.fps,
        kbps: Math.round((this.byteCount * 8) / 1000),
        latencyMs: this.videoStats.latencyMs,
      };
      this.byteCount = 0;
    }, 1000);
    // The worker computes glass-to-glass latency against the server clock;
    // hand it the offset periodically (it drifts as ping samples refine it).
    const sendClock = () =>
      this.worker.postMessage({
        type: "clock",
        serverOffsetMs: this.serverNow() - Date.now(),
      });
    sendClock();
    this.clockTimer = setInterval(sendClock, 5000);
  }

  stats(): PlayerStats {
    return this.currentStats;
  }

  /** Publisher clock-sync mark (forwarded by the relay). */
  setSync(sync: SyncData): void {
    this.worker.postMessage({ type: "sync", sync });
  }

  /** Playback volume, 0..1. Survives decoder rebuilds. */
  setVolume(v: number): void {
    this.volume = Math.min(Math.max(v, 0), 1);
    if (this.gain) this.gain.gain.value = this.volume;
    // A volume gesture is also the perfect moment to unstick autoplay.
    this.audioCtx?.resume().catch(() => {});
  }

  /** (Re)build decoders for a new publisher config. */
  configure(cfg: ConfigData): void {
    this.teardownAudio();
    this.resetView();
    this.worker.postMessage({
      type: "config",
      cfg: { videoCodec: cfg.videoCodec, width: cfg.width, height: cfg.height },
    });

    if (cfg.audioCodec && cfg.sampleRate && cfg.channels) {
      this.audioCtx = new AudioContext({ sampleRate: cfg.sampleRate });
      this.gain = this.audioCtx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.audioCtx.destination);
      this.audioPlayhead = 0;
      // Autoplay policy: a context created without a user gesture starts
      // suspended and produces silence. Resume on the next interaction.
      if (this.audioCtx.state === "suspended") {
        const resume = () => {
          this.audioCtx?.resume().catch(() => {});
          document.removeEventListener("pointerdown", resume);
          document.removeEventListener("keydown", resume);
        };
        this.audioCtx.resume().catch(() => {});
        document.addEventListener("pointerdown", resume);
        document.addEventListener("keydown", resume);
      }
      this.audioDecoder = new AudioDecoder({
        output: (data) => this.playAudio(data),
        error: (e) => console.error("audio decoder:", e),
      });
      this.audioDecoder.configure({
        codec: cfg.audioCodec,
        sampleRate: cfg.sampleRate,
        numberOfChannels: cfg.channels,
      });
    }
  }

  /** Feed one binary WebSocket message. Video transfers to the worker
   *  (zero-copy move of the ArrayBuffer); audio decodes here. */
  push(buf: ArrayBuffer): void {
    this.byteCount += buf.byteLength;
    // Peek the kind byte without unpacking twice.
    const kind = new Uint8Array(buf, 0, 1)[0];
    if (kind === KIND_VIDEO) {
      this.worker.postMessage({ type: "chunk", buf }, [buf]);
      return;
    }
    if (kind === KIND_AUDIO && this.audioDecoder?.state === "configured") {
      const chunk = unpackMedia(buf);
      if (!chunk) return;
      this.audioDecoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: chunk.timestamp,
          data: chunk.payload,
        }),
      );
    }
  }

  close(): void {
    clearInterval(this.statsTimer);
    clearInterval(this.clockTimer);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.teardownAudio();
    // The worker (and the transferred canvas control) outlive one Player on
    // purpose: transferControlToOffscreen is once-per-canvas, and the next
    // Player for this canvas reuses both via offscreenCache.
    this.worker.postMessage({ type: "config", cfg: { videoCodec: "", width: 0, height: 0 } });
  }

  /** The size of the last painted frame (300x150 = never painted). */
  frameSize(): { w: number; h: number } {
    return { w: this.frameW, h: this.frameH };
  }

  /** Wipe the picture between publishers — no ghost frame ever lingers
   *  under the next stream's first keyframe. */
  clearFrame(): void {
    this.frameW = 300;
    this.frameH = 150;
    this.worker.postMessage({ type: "blank" });
  }

  /** Current viewer magnification (1 = fit). */
  zoom(): number {
    return this.zoomLevel;
  }

  // ------------------------------------------------------------------
  // zoom / pan input (main thread; the worker just receives the window)
  // ------------------------------------------------------------------

  private pushView(): void {
    this.worker.postMessage({
      type: "view",
      zoom: this.zoomLevel,
      panX: this.panX,
      panY: this.panY,
    });
  }

  /** Where the canvas's pixels actually land on screen, in client coords.
   *  With object-fit: contain the element box is normally larger than the
   *  painted content (letterboxing), so pointer maths must use this box.
   *  frameW/frameH mirror the worker's resizes (the element's attributes
   *  freeze after transferControlToOffscreen). */
  private contentBox(): { x: number; y: number; w: number; h: number } | null {
    const r = this.canvas.getBoundingClientRect();
    const cw = this.frameW;
    const ch = this.frameH;
    if (r.width <= 0 || r.height <= 0 || cw <= 0 || ch <= 0) return null;
    const ar = cw / ch;
    let w = r.width;
    let h = r.height;
    if (r.width / r.height > ar) w = r.height * ar;
    else h = r.width / ar;
    return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
  }

  private viewWindow(): { ox: number; oy: number; size: number } {
    const size = 1 / this.zoomLevel;
    return {
      ox: clamp(this.panX - size / 2, 0, 1 - size),
      oy: clamp(this.panY - size / 2, 0, 1 - size),
      size,
    };
  }

  private resetView(): void {
    this.panX = 0.5;
    this.panY = 0.5;
    this.dragFrom = null;
    if (this.zoomLevel !== 1) {
      this.zoomLevel = 1;
      this.canvas.style.cursor = "";
      this.onZoomChange?.(1);
    }
    this.pushView();
  }

  /** Set zoom, optionally keeping the point under (u, v) pinned in place. */
  private setZoom(next: number, u?: number, v?: number): void {
    const z = clamp(next, MIN_ZOOM, MAX_ZOOM);
    if (z === this.zoomLevel) return;
    if (u !== undefined && v !== undefined) {
      const { ox, oy, size } = this.viewWindow();
      const px = ox + u * size;
      const py = oy + v * size;
      const s2 = 1 / z;
      this.panX = clamp(px - u * s2, 0, 1 - s2) + s2 / 2;
      this.panY = clamp(py - v * s2, 0, 1 - s2) + s2 / 2;
    }
    this.zoomLevel = z;
    if (z <= MIN_ZOOM) {
      this.panX = 0.5;
      this.panY = 0.5;
    }
    this.canvas.style.cursor = z > MIN_ZOOM ? (this.dragFrom ? "grabbing" : "grab") : "";
    this.onZoomChange?.(z);
    // No repaint request on purpose: the next decoded frame (16-33ms away)
    // picks the new window up, same as it always has.
    this.pushView();
  }

  private onWheel = (e: WheelEvent): void => {
    const box = this.contentBox();
    if (!box) return;
    e.preventDefault(); // don't scroll the Activity behind the stage
    const perUnit = e.deltaMode === 0 ? 0.0015 : e.deltaMode === 1 ? 0.05 : 0.3;
    const u = clamp((e.clientX - box.x) / box.w, 0, 1);
    const v = clamp((e.clientY - box.y) / box.h, 0, 1);
    this.setZoom(this.zoomLevel * Math.exp(-e.deltaY * perUnit), u, v);
  };

  // Drag-to-pan. No preventDefault anywhere in the pointer handlers — the
  // stage's double-click-to-fullscreen relies on compatibility mouse events.
  private onPointerDown = (e: PointerEvent): void => {
    if (this.zoomLevel <= MIN_ZOOM || e.button !== 0) return;
    this.dragFrom = { x: e.clientX, y: e.clientY };
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* drag still works, it just stops at the element boundary */
    }
    this.canvas.style.cursor = "grabbing";
  };

  private onPointerMove = (e: PointerEvent): void => {
    const from = this.dragFrom;
    if (!from) return;
    const box = this.contentBox();
    if (!box) return;
    const size = 1 / this.zoomLevel;
    this.panX = clamp(
      this.panX - ((e.clientX - from.x) / box.w) * size,
      size / 2,
      1 - size / 2,
    );
    this.panY = clamp(
      this.panY - ((e.clientY - from.y) / box.h) * size,
      size / 2,
      1 - size / 2,
    );
    this.dragFrom = { x: e.clientX, y: e.clientY };
    this.pushView();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.dragFrom) return;
    this.dragFrom = null;
    try {
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* nothing to release */
    }
    this.canvas.style.cursor = this.zoomLevel > MIN_ZOOM ? "grab" : "";
  };

  private teardownAudio(): void {
    if (this.audioDecoder && this.audioDecoder.state !== "closed") {
      this.audioDecoder.close();
    }
    this.audioDecoder = null;
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.gain = null;
  }

  /** Schedule decoded audio back-to-back on the AudioContext clock, keeping
   *  at most ~150ms of buffered lead to bound latency. Each scheduling also
   *  refreshes the worker's A/V anchor in wall-clock terms. */
  private playAudio(data: AudioData): void {
    const ctx = this.audioCtx;
    if (!ctx) {
      data.close();
      return;
    }
    const buffer = ctx.createBuffer(
      data.numberOfChannels,
      data.numberOfFrames,
      data.sampleRate,
    );
    for (let ch = 0; ch < data.numberOfChannels; ch++) {
      const channel = new Float32Array(data.numberOfFrames);
      data.copyTo(channel, { planeIndex: ch, format: "f32-planar" });
      buffer.copyToChannel(channel, ch);
    }
    const chunkTsUs = data.timestamp ?? 0;
    data.close();

    const now = ctx.currentTime;
    if (this.audioPlayhead < now || this.audioPlayhead > now + 0.15) {
      this.audioPlayhead = now + 0.02; // resync after underrun or drift
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain ?? ctx.destination);
    src.start(this.audioPlayhead);
    this.worker.postMessage({
      type: "audioAnchor",
      chunkTsUs,
      playAtMs: Date.now() + (this.audioPlayhead - now) * 1000,
    });
    this.audioPlayhead += buffer.duration;
  }
}
