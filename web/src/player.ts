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

export class Player {
  private videoDecoder: VideoDecoder | null = null;
  private videoCfg: VideoDecoderConfig | null = null;
  private audioDecoder: AudioDecoder | null = null;
  private audioCtx: AudioContext | null = null;
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

  constructor(
    private canvas: HTMLCanvasElement,
    /** Server wall clock in Unix ms (from Session.serverNow). */
    private serverNow: () => number = () => Date.now(),
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    this.ctx2d = ctx;
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

  /** (Re)build decoders for a new publisher config. */
  configure(cfg: ConfigData): void {
    this.teardownDecoders();
    this.awaitingKeyframe = true;
    this.canvas.width = cfg.width;
    this.canvas.height = cfg.height;

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
      this.audioPlayhead = 0;
      this.audioAnchor = null;
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
      if (this.awaitingKeyframe && !chunk.keyframe) return;
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
    this.teardownDecoders();
  }

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
    this.ctx2d.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
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
    src.connect(ctx.destination);
    src.start(this.audioPlayhead);
    this.audioAnchor = { chunkTsUs, ctxTime: this.audioPlayhead };
    this.audioPlayhead += buffer.duration;
  }
}
