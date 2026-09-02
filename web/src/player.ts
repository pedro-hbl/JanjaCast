// Viewer playback: packed media chunks -> WebCodecs decoders -> canvas
// (video) and AudioContext scheduling (audio). Rendering is driven by decode
// output, not requestAnimationFrame, so playback survives the iframe being
// backgrounded (alt-tab). When audio is present, video presentation is
// slaved to the audio clock (bounded to 300ms) for A/V sync.

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

const MAX_VIDEO_DELAY_MS = 300;

// Drop-to-live: if the decoder or presentation queue is deeper than this
// when a keyframe arrives, discard the backlog and resume from the keyframe.
// Without this, a viewer that decodes/draws even slightly slower than the
// sharer encodes falls further behind every second, forever.
const MAX_QUEUE_DEPTH = 6;

/** Viewer zoom range. 1 = whole frame (fit), 8 = 8x magnification. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

export class Player {
  private videoDecoder: VideoDecoder | null = null;
  private videoCfg: VideoDecoderConfig | null = null;
  private audioDecoder: AudioDecoder | null = null;
  private audioCtx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private volume = 1;
  private audioPlayhead = 0;
  /** Maps audio chunk timestamps (µs) to AudioContext time (s). */
  private audioAnchor: { chunkTsUs: number; ctxTime: number } | null = null;
  private ctx2d: CanvasRenderingContext2D;
  private awaitingKeyframe = true;
  private pendingFrames = new Set<VideoFrame>();
  private sync: SyncData | null = null;
  private latencyEma: number | null = null;

  private frameCount = 0;
  private byteCount = 0;
  private currentStats: PlayerStats = { fps: 0, kbps: 0, latencyMs: null };
  private statsTimer: ReturnType<typeof setInterval>;
  private lastKfAsk = 0;

  // --- viewer zoom / pan (purely local: no protocol or bandwidth cost) ---
  private zoomLevel = 1;
  /** Centre of the visible source window, normalized 0..1 of the frame.
   *  Normalized (not pixels) so it survives a mid-stream resolution change. */
  private panX = 0.5;
  private panY = 0.5;
  private dragFrom: { x: number; y: number } | null = null;

  /** Fired (throttled) when video is stalled waiting for a keyframe —
   *  wire it to Session.requestKeyframe for fast recovery. */
  onNeedKeyframe: (() => void) | null = null;

  /** Fired when the viewer's zoom factor changes (for the "N.Nx" pill). */
  onZoomChange: ((zoom: number) => void) | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    /** Server wall clock in Unix ms (from Session.serverNow). */
    private serverNow: () => number = () => Date.now(),
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    this.ctx2d = ctx;
    this.applyContextDefaults();
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    this.statsTimer = setInterval(() => {
      this.currentStats = {
        fps: this.frameCount,
        kbps: Math.round((this.byteCount * 8) / 1000),
        latencyMs: this.latencyEma === null ? null : Math.round(this.latencyEma),
      };
      this.frameCount = 0;
      this.byteCount = 0;
    }, 1000);
  }

  stats(): PlayerStats {
    return this.currentStats;
  }

  /** Publisher clock-sync mark (forwarded by the relay). */
  setSync(sync: SyncData): void {
    this.sync = sync;
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
    this.teardownDecoders();
    this.awaitingKeyframe = true;
    // Provisional only — it stops the canvas showing its 300x150 default
    // (or the previous stream's shape) while we wait for the first frame.
    // The announced config can be stale or racing a reconfigure, so the
    // frames themselves are what actually size the canvas; see drawFrame.
    this.resizeCanvas(cfg.width, cfg.height);
    this.resetView();

    this.videoDecoder = new VideoDecoder({
      output: (frame) => this.presentFrame(frame),
      error: (e) => console.error("video decoder:", e),
    });
    this.videoCfg = {
      codec: cfg.videoCodec,
      codedWidth: cfg.width,
      codedHeight: cfg.height,
      optimizeForLatency: true,
    };
    this.videoDecoder.configure(this.videoCfg);

    if (cfg.audioCodec && cfg.sampleRate && cfg.channels) {
      this.audioCtx = new AudioContext({ sampleRate: cfg.sampleRate });
      this.gain = this.audioCtx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.audioCtx.destination);
      this.audioPlayhead = 0;
      this.audioAnchor = null;
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

  /** Feed one binary WebSocket message. */
  push(buf: ArrayBuffer): void {
    const chunk = unpackMedia(buf);
    if (!chunk) return;
    this.byteCount += chunk.payload.byteLength;

    if (chunk.kind === KIND_VIDEO && this.videoDecoder?.state === "configured") {
      if (this.awaitingKeyframe && !chunk.keyframe) {
        const now = performance.now();
        if (now - this.lastKfAsk > 1000) {
          this.lastKfAsk = now;
          this.onNeedKeyframe?.();
        }
        return;
      }
      this.awaitingKeyframe = false;
      // Drop to live: a keyframe is a safe point to throw away a backlog
      // that the decoder or presenter has fallen behind on.
      if (
        chunk.keyframe &&
        (this.videoDecoder.decodeQueueSize > MAX_QUEUE_DEPTH ||
          this.pendingFrames.size > MAX_QUEUE_DEPTH)
      ) {
        this.videoDecoder.reset();
        this.videoDecoder.configure(this.videoCfg!);
        for (const f of this.pendingFrames) f.close();
        this.pendingFrames.clear();
      }
      this.videoDecoder.decode(
        new EncodedVideoChunk({
          type: chunk.keyframe ? "key" : "delta",
          timestamp: chunk.timestamp,
          data: chunk.payload,
        }),
      );
    } else if (chunk.kind === KIND_AUDIO && this.audioDecoder?.state === "configured") {
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
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.teardownDecoders();
  }

  /** Current viewer magnification (1 = fit). */
  zoom(): number {
    return this.zoomLevel;
  }

  // ------------------------------------------------------------------
  // rendering geometry
  // ------------------------------------------------------------------

  /** Context state is reset by every canvas resize, so this is re-applied
   *  there rather than only once at construction.
   *
   *  On devicePixelRatio: we deliberately do NOT scale the backing store by
   *  dpr. The frame's own pixels are all the information that exists — a
   *  bigger backing store would upsample in JS only for the compositor to
   *  downsample again. Sizing the canvas exactly to the frame means the
   *  browser performs a single filtered resample straight from source
   *  pixels to device pixels when it composites (see the CSS: the canvas is
   *  stretched to the stage with object-fit: contain), which is both the
   *  sharpest and the cheapest option and needs no relayout bookkeeping.
   *  imageSmoothingQuality still matters: while zoomed we upsample a source
   *  sub-rect into the full-size canvas ourselves. */
  private applyContextDefaults(): void {
    this.ctx2d.imageSmoothingEnabled = true;
    this.ctx2d.imageSmoothingQuality = "high";
  }

  private resizeCanvas(w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.applyContextDefaults();
  }

  /** Visible source window in normalized frame coordinates. Its aspect
   *  ratio always equals the canvas's (both are the frame's), so zooming
   *  can never distort: it is a uniform 1/zoom-sized square in [0,1] space. */
  private viewWindow(): { ox: number; oy: number; size: number } {
    const size = 1 / this.zoomLevel;
    return {
      ox: clamp(this.panX - size / 2, 0, 1 - size),
      oy: clamp(this.panY - size / 2, 0, 1 - size),
      size,
    };
  }

  /** Where the canvas's pixels actually land on screen, in client coords.
   *  With object-fit: contain the element box is normally larger than the
   *  painted content (letterboxing), so pointer maths must use this box. */
  private contentBox(): { x: number; y: number; w: number; h: number } | null {
    const r = this.canvas.getBoundingClientRect();
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (r.width <= 0 || r.height <= 0 || cw <= 0 || ch <= 0) return null;
    const ar = cw / ch;
    let w = r.width;
    let h = r.height;
    if (r.width / r.height > ar) w = r.height * ar;
    else h = r.width / ar;
    return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
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
  }

  /** Set zoom, optionally keeping the point under (u, v) — normalized
   *  position inside the painted content — pinned in place. */
  private setZoom(next: number, u?: number, v?: number): void {
    const z = clamp(next, MIN_ZOOM, MAX_ZOOM);
    if (z === this.zoomLevel) return;
    if (u !== undefined && v !== undefined) {
      const { ox, oy, size } = this.viewWindow();
      const px = ox + u * size; // source point under the cursor
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
    // No repaint here on purpose: repainting would mean retaining the last
    // VideoFrame, and frames are closed the moment they are drawn. The next
    // decoded frame (16-33ms away) picks the new window up.
  }

  private onWheel = (e: WheelEvent): void => {
    const box = this.contentBox();
    if (!box) return;
    e.preventDefault(); // don't scroll the Activity behind the stage
    // Per-unit deltas differ wildly between browsers/devices; normalize to
    // roughly "one notch = 15%" and go exponential so a notch feels the
    // same at 1x and at 8x.
    const perUnit = e.deltaMode === 0 ? 0.0015 : e.deltaMode === 1 ? 0.05 : 0.3;
    const u = clamp((e.clientX - box.x) / box.w, 0, 1);
    const v = clamp((e.clientY - box.y) / box.h, 0, 1);
    this.setZoom(this.zoomLevel * Math.exp(-e.deltaY * perUnit), u, v);
  };

  // Drag-to-pan. Note: no preventDefault anywhere in the pointer handlers —
  // the stage's double-click-to-fullscreen relies on the compatibility mouse
  // events, and suppressing them here would silently break it.
  private onPointerDown = (e: PointerEvent): void => {
    if (this.zoomLevel <= MIN_ZOOM || e.button !== 0) return;
    this.dragFrom = { x: e.clientX, y: e.clientY };
    // Capture keeps the drag alive past the canvas edge; not fatal if the
    // UA refuses it (e.g. a synthetic pointer id), so never let it throw.
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
    // Dragging right moves the image right, i.e. the source window left.
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

  private teardownDecoders(): void {
    for (const f of this.pendingFrames) f.close();
    this.pendingFrames.clear();
    if (this.videoDecoder?.state !== "closed") this.videoDecoder?.close();
    if (this.audioDecoder && this.audioDecoder.state !== "closed") {
      this.audioDecoder.close();
    }
    this.videoDecoder = null;
    this.audioDecoder = null;
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.gain = null;
    this.audioAnchor = null;
  }

  /** Present a decoded frame, delaying (bounded) to line up with audio.
   *  When the presentation queue backs up (e.g. throttled timers in a
   *  backgrounded tab), draw immediately instead — holding VideoFrames
   *  starves the decoder's frame pool and stalls the whole pipeline. */
  private presentFrame(frame: VideoFrame): void {
    const delayMs = this.videoDelayMs(frame.timestamp ?? 0);
    if (delayMs <= 4 || this.pendingFrames.size > MAX_QUEUE_DEPTH) {
      this.drawFrame(frame);
      return;
    }
    this.pendingFrames.add(frame);
    setTimeout(() => {
      if (this.pendingFrames.delete(frame)) this.drawFrame(frame);
    }, delayMs);
  }

  private videoDelayMs(frameTsUs: number): number {
    const ctx = this.audioCtx;
    const anchor = this.audioAnchor;
    if (!ctx || !anchor) return 0;
    const target = anchor.ctxTime + (frameTsUs - anchor.chunkTsUs) / 1e6;
    return Math.min(Math.max((target - ctx.currentTime) * 1000, 0), MAX_VIDEO_DELAY_MS);
  }

  private drawFrame(frame: VideoFrame): void {
    this.frameCount++;

    // The frame is the only trustworthy source of dimensions. displayWidth/
    // displayHeight already account for non-square pixels and for visibleRect
    // cropping, which codedWidth/codedHeight (and the announced config) do
    // not — alignment-padded streams are coded larger than they display.
    // Matching the canvas to it and drawing 1:1 makes the aspect ratio
    // correct by construction, including for resolution changes that arrive
    // before (or instead of) a config announcement.
    const w = frame.displayWidth || frame.codedWidth;
    const h = frame.displayHeight || frame.codedHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.resizeCanvas(w, h);
    }

    if (this.zoomLevel > MIN_ZOOM) {
      const { ox, oy, size } = this.viewWindow();
      // Source rect shares the canvas's aspect ratio, so no distortion.
      this.ctx2d.drawImage(
        frame,
        ox * w,
        oy * h,
        size * w,
        size * h,
        0,
        0,
        this.canvas.width,
        this.canvas.height,
      );
    } else {
      this.ctx2d.drawImage(frame, 0, 0); // 1:1, no scaling at all
    }

    const ts = frame.timestamp ?? 0;
    frame.close();

    if (this.sync) {
      // When the sharer captured this frame, in server wall-clock ms:
      const capturedAt = this.sync.wallTs + (ts - this.sync.captureTs) / 1000;
      const latency = this.serverNow() - capturedAt;
      if (latency > -5000 && latency < 30_000) {
        this.latencyEma =
          this.latencyEma === null ? latency : this.latencyEma * 0.9 + latency * 0.1;
      }
    }
  }

  /** Schedule decoded audio back-to-back on the AudioContext clock, keeping
   *  at most ~150ms of buffered lead to bound latency. */
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
    this.audioAnchor = { chunkTsUs, ctxTime: this.audioPlayhead };
    this.audioPlayhead += buffer.duration;
  }
}
