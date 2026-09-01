// Viewer playback: packed media chunks -> WebCodecs decoders -> canvas
// (video) and AudioContext scheduling (audio). Rendering is driven by decode
// output, not requestAnimationFrame, so playback survives the iframe being
// backgrounded (alt-tab) far better; moving decode into a worker is a
// planned hardening step.

import {
  KIND_AUDIO,
  KIND_VIDEO,
  unpackMedia,
  type ConfigData,
} from "./protocol";

export interface PlayerStats {
  fps: number;
  kbps: number;
}

export class Player {
  private videoDecoder: VideoDecoder | null = null;
  private audioDecoder: AudioDecoder | null = null;
  private audioCtx: AudioContext | null = null;
  private audioPlayhead = 0;
  private ctx2d: CanvasRenderingContext2D;
  private awaitingKeyframe = true;

  private frameCount = 0;
  private byteCount = 0;
  private currentStats: PlayerStats = { fps: 0, kbps: 0 };
  private statsTimer: ReturnType<typeof setInterval>;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    this.ctx2d = ctx;
    this.statsTimer = setInterval(() => {
      this.currentStats = {
        fps: this.frameCount,
        kbps: Math.round((this.byteCount * 8) / 1000),
      };
      this.frameCount = 0;
      this.byteCount = 0;
    }, 1000);
  }

  stats(): PlayerStats {
    return this.currentStats;
  }

  /** (Re)build decoders for a new publisher config. */
  configure(cfg: ConfigData): void {
    this.teardownDecoders();
    this.awaitingKeyframe = true;
    this.canvas.width = cfg.width;
    this.canvas.height = cfg.height;

    this.videoDecoder = new VideoDecoder({
      output: (frame) => {
        this.frameCount++;
        this.ctx2d.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
        frame.close();
      },
      error: (e) => console.error("video decoder:", e),
    });
    this.videoDecoder.configure({
      codec: cfg.videoCodec,
      codedWidth: cfg.width,
      codedHeight: cfg.height,
      optimizeForLatency: true,
    });

    if (cfg.audioCodec && cfg.sampleRate && cfg.channels) {
      this.audioCtx = new AudioContext({ sampleRate: cfg.sampleRate });
      this.audioPlayhead = 0;
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
    if (this.videoDecoder?.state !== "closed") this.videoDecoder?.close();
    if (this.audioDecoder && this.audioDecoder.state !== "closed") {
      this.audioDecoder.close();
    }
    this.videoDecoder = null;
    this.audioDecoder = null;
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
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
    data.close();

    const now = ctx.currentTime;
    if (this.audioPlayhead < now || this.audioPlayhead > now + 0.15) {
      this.audioPlayhead = now + 0.02; // resync after underrun or drift
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(this.audioPlayhead);
    this.audioPlayhead += buffer.duration;
  }
}
