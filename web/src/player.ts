// Viewer playback front — multi-tile (Seam 5). ONE module-level worker owns
// every tile's decoder+OffscreenCanvas; this class keeps the main-thread
// half: the AudioContext (decoding ONE chair's audio — solo-on-click),
// pointer/wheel zoom & pan for the focused tile, stats for the HUD, and the
// per-canvas transfer bookkeeping (transferControlToOffscreen is once-per-
// element, so offscreens are cached on the element and tiles re-bind).
//
// The legacy single-stage API (configure/push/stats/...) still works and
// maps to tile 0 on the primary canvas — the App's single-publisher path is
// byte-identical. Multi rooms drive addTile/configureSlot/setAudioSlot.

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
  latencyMs: number | null;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/** transfer is once-per-canvas; remember each element's offscreen. */
const transferred = new WeakSet<HTMLCanvasElement>();

let sharedWorker: Worker | null = null;
function worker(): Worker {
  if (!sharedWorker) {
    sharedWorker = new Worker(new URL("./playerWorker.ts", import.meta.url), {
      type: "module",
    });
  }
  return sharedWorker;
}

export class Player {
  private w: Worker;
  private audioDecoder: AudioDecoder | null = null;
  private audioCtx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private volume = 0.7;
  private audioPlayhead = 0;
  /** Which chair's audio plays (solo-on-click). */
  private audioSlot = 0;
  private audioCfg: ConfigData | null = null;

  private byteCount = 0;
  private perSlotFps: Record<number, number> = {};
  private latencyMs: number | null = null;
  private currentStats: PlayerStats = { fps: 0, kbps: 0, latencyMs: null };
  private statsTimer: ReturnType<typeof setInterval>;
  private clockTimer: ReturnType<typeof setInterval>;

  /** Per-tile mirrors: frame sizes and the focused tile's zoom state. */
  private frameDims: Record<number, { w: number; h: number }> = {};
  private zoomLevel = 1;
  private panX = 0.5;
  private panY = 0.5;
  private dragFrom: { x: number; y: number } | null = null;
  /** The tile pointer input drives (zoom/pan). Legacy = 0. */
  private focusSlot = 0;
  private tileCanvas: Record<number, HTMLCanvasElement> = {};

  onNeedKeyframe: ((slot: number) => void) | null = null;
  onZoomChange: ((zoom: number) => void) | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private serverNow: () => number = () => Date.now(),
  ) {
    this.w = worker();
    this.addTile(0, canvas);
    this.w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "stats") {
        this.perSlotFps = m.perSlot ?? {};
        this.latencyMs = m.latencyMs;
      } else if (m.type === "dims") {
        this.frameDims[m.slot] = { w: m.w, h: m.h };
      } else if (m.type === "needKeyframe") {
        this.onNeedKeyframe?.(m.slot ?? 0);
      }
    };

    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);

    this.statsTimer = setInterval(() => {
      const fps = this.perSlotFps[this.focusSlot] ?? 0;
      this.currentStats = {
        fps,
        kbps: Math.round((this.byteCount * 8) / 1000),
        latencyMs: this.latencyMs,
      };
      this.byteCount = 0;
    }, 1000);
    const sendClock = () =>
      this.w.postMessage({
        type: "clock",
        serverOffsetMs: this.serverNow() - Date.now(),
      });
    sendClock();
    this.clockTimer = setInterval(sendClock, 5000);
  }

  // ---------------- multi-tile API (Seam 5) ----------------

  /** Bind a chair to a canvas element. Idempotent per element. */
  addTile(slot: number, canvas: HTMLCanvasElement): void {
    this.tileCanvas[slot] = canvas;
    if (transferred.has(canvas)) return;
    transferred.add(canvas);
    const off = canvas.transferControlToOffscreen();
    this.w.postMessage({ type: "addTile", slot, canvas: off }, [off]);
  }

  removeTile(slot: number): void {
    delete this.tileCanvas[slot];
    delete this.frameDims[slot];
    this.w.postMessage({ type: "removeTile", slot });
  }

  /** (Re)build one chair's video decoder; audio follows only for the solo. */
  configureSlot(slot: number, cfg: ConfigData): void {
    this.w.postMessage({
      type: "config",
      slot,
      cfg: { videoCodec: cfg.videoCodec, width: cfg.width, height: cfg.height },
    });
    if (slot === this.audioSlot) this.buildAudio(cfg);
  }

  /** Solo-on-click: this chair's audio plays; the anchor follows it. */
  setAudioSlot(slot: number, cfg: ConfigData | null): void {
    if (slot === this.audioSlot && this.audioDecoder) return;
    this.audioSlot = slot;
    if (cfg) this.buildAudio(cfg);
  }

  setFocusSlot(slot: number): void {
    this.focusSlot = slot;
  }

  fpsFor(slot: number): number {
    return this.perSlotFps[slot] ?? 0;
  }

  setTileBlank(slot: number, on: boolean): void {
    this.w.postMessage({ type: "setBlanked", slot, on });
    if (on) this.w.postMessage({ type: "blank", slot });
  }

  clearTile(slot: number): void {
    this.frameDims[slot] = { w: 300, h: 150 };
    this.w.postMessage({ type: "blank", slot });
  }

  // ---------------- legacy single-stage API ----------------

  stats(): PlayerStats {
    return this.currentStats;
  }

  setSync(sync: SyncData): void {
    this.w.postMessage({ type: "sync", sync });
  }

  setVolume(v: number): void {
    this.volume = Math.min(Math.max(v, 0), 1);
    if (this.gain) this.gain.gain.value = this.volume;
    this.audioCtx?.resume().catch(() => {});
  }

  configure(cfg: ConfigData): void {
    this.resetView();
    this.configureSlot(0, cfg);
  }

  /** Feed one binary WS message; the header's slot byte routes the video,
   *  and only the solo chair's audio is decoded at all. */
  push(buf: ArrayBuffer): void {
    this.byteCount += buf.byteLength;
    const head = new Uint8Array(buf, 0, 3);
    if (head[0] === KIND_VIDEO) {
      this.w.postMessage({ type: "chunk", buf }, [buf]);
      return;
    }
    if (
      head[0] === KIND_AUDIO &&
      head[2] === this.audioSlot &&
      this.audioDecoder?.state === "configured"
    ) {
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
    // Tiles idle out via a config teardown; the worker (and each canvas's
    // transferred control) survive for the next Player on this page.
    this.w.postMessage({ type: "config", slot: 0, cfg: { videoCodec: "", width: 0, height: 0 } });
  }

  zoom(): number {
    return this.zoomLevel;
  }

  frameSize(): { w: number; h: number } {
    return this.frameDims[0] ?? { w: 300, h: 150 };
  }

  clearFrame(): void {
    this.clearTile(0);
  }

  // ---------------- zoom / pan (focused tile) ----------------

  private pushView(): void {
    this.w.postMessage({
      type: "view",
      slot: this.focusSlot,
      zoom: this.zoomLevel,
      panX: this.panX,
      panY: this.panY,
    });
  }

  private contentBox(): { x: number; y: number; w: number; h: number } | null {
    const el = this.tileCanvas[this.focusSlot] ?? this.canvas;
    const dims = this.frameDims[this.focusSlot] ?? { w: 300, h: 150 };
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || dims.w <= 0 || dims.h <= 0) return null;
    const ar = dims.w / dims.h;
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
    this.pushView();
  }

  private onWheel = (e: WheelEvent): void => {
    const box = this.contentBox();
    if (!box) return;
    e.preventDefault();
    const perUnit = e.deltaMode === 0 ? 0.0015 : e.deltaMode === 1 ? 0.05 : 0.3;
    const u = clamp((e.clientX - box.x) / box.w, 0, 1);
    const v = clamp((e.clientY - box.y) / box.h, 0, 1);
    this.setZoom(this.zoomLevel * Math.exp(-e.deltaY * perUnit), u, v);
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (this.zoomLevel <= MIN_ZOOM || e.button !== 0) return;
    this.dragFrom = { x: e.clientX, y: e.clientY };
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* drag stops at the element boundary */
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

  // ---------------- audio (solo chair only) ----------------

  private buildAudio(cfg: ConfigData): void {
    this.teardownAudio();
    this.audioCfg = cfg;
    if (!cfg.audioCodec || !cfg.sampleRate || !cfg.channels) return;
    this.audioCtx = new AudioContext({ sampleRate: cfg.sampleRate });
    this.gain = this.audioCtx.createGain();
    this.gain.gain.value = this.volume;
    this.gain.connect(this.audioCtx.destination);
    this.audioPlayhead = 0;
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

  private teardownAudio(): void {
    if (this.audioDecoder && this.audioDecoder.state !== "closed") {
      this.audioDecoder.close();
    }
    this.audioDecoder = null;
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.gain = null;
  }

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
      this.audioPlayhead = now + 0.02;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain ?? ctx.destination);
    src.start(this.audioPlayhead);
    this.w.postMessage({
      type: "audioAnchor",
      slot: this.audioSlot,
      chunkTsUs,
      playAtMs: Date.now() + (this.audioPlayhead - now) * 1000,
    });
    this.audioPlayhead += buffer.duration;
  }
}
