// The viewer's video half, off the main thread (wave R, packages 1+2).
// Decode and paint happen HERE, against an OffscreenCanvas, so Solid
// re-renders, control storms and tab throttling never touch the picture.
//
// THE INVARIANT (owner-mandated): alt-tab never introduces delay. The same
// drop-to-live discipline as before rules this worker — when the decoder or
// presentation queue is deeper than MAX_QUEUE_DEPTH at a keyframe, the
// backlog dies and playback resumes from the live edge. Frames are never
// held to be shown late.
//
// Audio stays on the main thread (AudioContext lives there); A/V sync
// crosses over as a wall-clock anchor: "audio chunk T plays at Date.now()
// X", which both sides can read without a shared monotonic clock.

import { KIND_VIDEO, unpackMedia } from "./protocol";

const MAX_VIDEO_DELAY_MS = 300;
const MAX_QUEUE_DEPTH = 6;

interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

let canvas: OffscreenCanvas | null = null;
let ctx2d: OffscreenCanvasRenderingContext2D | null = null;
let decoder: VideoDecoder | null = null;
let decoderCfg: VideoDecoderConfig | null = null;
let awaitingKeyframe = true;
const pendingFrames = new Set<VideoFrame>();
let view: ViewState = { zoom: 1, panX: 0.5, panY: 0.5 };
/** Server-minus-local clock offset (ms), refreshed from the main thread. */
let serverOffsetMs = 0;
let sync: { captureTs: number; wallTs: number } | null = null;
/** A/V anchor: audio chunk `chunkTsUs` starts playing at wall time `playAtMs`. */
let audioAnchor: { chunkTsUs: number; playAtMs: number } | null = null;

let frameCount = 0;
let latencyEma: number | null = null;
let lastKfAsk = 0;

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

function applyContextDefaults(): void {
  if (!ctx2d) return;
  ctx2d.imageSmoothingEnabled = true;
  ctx2d.imageSmoothingQuality = "high";
}

function resizeCanvas(w: number, h: number): void {
  if (!canvas || w <= 0 || h <= 0) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    applyContextDefaults();
    // The placeholder element's width/height attributes do NOT track an
    // OffscreenCanvas resize — the front keeps its own mirror from this.
    postMessage({ type: "dims", w, h });
  }
}

function teardownDecoder(): void {
  for (const f of pendingFrames) f.close();
  pendingFrames.clear();
  if (decoder && decoder.state !== "closed") decoder.close();
  decoder = null;
}

function configure(cfg: {
  videoCodec: string;
  width: number;
  height: number;
}): void {
  teardownDecoder();
  awaitingKeyframe = true;
  resizeCanvas(cfg.width, cfg.height);
  view = { zoom: 1, panX: 0.5, panY: 0.5 };
  decoder = new VideoDecoder({
    output: (frame) => presentFrame(frame),
    error: (e) => console.error("video decoder (worker):", e),
  });
  decoderCfg = {
    codec: cfg.videoCodec,
    codedWidth: cfg.width,
    codedHeight: cfg.height,
    optimizeForLatency: true,
  };
  decoder.configure(decoderCfg);
}

function push(buf: ArrayBuffer): void {
  const chunk = unpackMedia(buf);
  if (!chunk || chunk.kind !== KIND_VIDEO) return;
  if (!decoder || decoder.state !== "configured") return;

  if (awaitingKeyframe && !chunk.keyframe) {
    const now = Date.now();
    if (now - lastKfAsk > 1000) {
      lastKfAsk = now;
      postMessage({ type: "needKeyframe" });
    }
    return;
  }
  awaitingKeyframe = false;

  // SVC-aware pre-decode shedding (package 2): when we are already behind,
  // a droppable temporal layer is not worth the decode cycles — refuse it
  // BEFORE the decoder ever sees it. T0 always passes (decode correctness).
  if (
    chunk.temporalId > 0 &&
    (decoder.decodeQueueSize > MAX_QUEUE_DEPTH ||
      pendingFrames.size > MAX_QUEUE_DEPTH)
  ) {
    return;
  }

  // Drop to live, exactly as on the main thread before: a keyframe is the
  // safe point to throw a backlog away.
  if (
    chunk.keyframe &&
    (decoder.decodeQueueSize > MAX_QUEUE_DEPTH ||
      pendingFrames.size > MAX_QUEUE_DEPTH)
  ) {
    decoder.reset();
    decoder.configure(decoderCfg!);
    for (const f of pendingFrames) f.close();
    pendingFrames.clear();
  }
  decoder.decode(
    new EncodedVideoChunk({
      type: chunk.keyframe ? "key" : "delta",
      timestamp: chunk.timestamp,
      data: chunk.payload,
    }),
  );
}

function videoDelayMs(frameTsUs: number): number {
  if (!audioAnchor) return 0;
  const target =
    audioAnchor.playAtMs + (frameTsUs - audioAnchor.chunkTsUs) / 1000;
  return clamp(target - Date.now(), 0, MAX_VIDEO_DELAY_MS);
}

function presentFrame(frame: VideoFrame): void {
  const delayMs = videoDelayMs(frame.timestamp ?? 0);
  // Delay is bounded A/V alignment only — never accumulation. A throttled
  // or overloaded worker draws immediately (live edge), same as before.
  if (delayMs <= 4 || pendingFrames.size > MAX_QUEUE_DEPTH) {
    drawFrame(frame);
    return;
  }
  pendingFrames.add(frame);
  setTimeout(() => {
    if (pendingFrames.delete(frame)) drawFrame(frame);
  }, delayMs);
}

function drawFrame(frame: VideoFrame): void {
  if (!ctx2d || !canvas) {
    frame.close();
    return;
  }
  frameCount++;
  const w = frame.displayWidth || frame.codedWidth;
  const h = frame.displayHeight || frame.codedHeight;
  resizeCanvas(w, h);

  if (view.zoom > 1) {
    const size = 1 / view.zoom;
    const ox = clamp(view.panX - size / 2, 0, 1 - size);
    const oy = clamp(view.panY - size / 2, 0, 1 - size);
    ctx2d.drawImage(
      frame,
      ox * w,
      oy * h,
      size * w,
      size * h,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  } else {
    ctx2d.drawImage(frame, 0, 0);
  }

  const ts = frame.timestamp ?? 0;
  frame.close();

  if (sync) {
    const capturedAt = sync.wallTs + (ts - sync.captureTs) / 1000;
    const latency = Date.now() + serverOffsetMs - capturedAt;
    if (latency > -5000 && latency < 30_000) {
      latencyEma =
        latencyEma === null ? latency : latencyEma * 0.9 + latency * 0.1;
    }
  }
}

setInterval(() => {
  postMessage({
    type: "stats",
    fps: frameCount,
    latencyMs: latencyEma === null ? null : Math.round(latencyEma),
  });
  frameCount = 0;
}, 1000);

onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  switch (m.type) {
    case "init":
      canvas = m.canvas as OffscreenCanvas;
      ctx2d = canvas.getContext("2d");
      applyContextDefaults();
      break;
    case "config":
      configure(m.cfg);
      break;
    case "chunk":
      push(m.buf as ArrayBuffer);
      break;
    case "view":
      view = { zoom: m.zoom, panX: m.panX, panY: m.panY };
      break;
    case "sync":
      sync = m.sync;
      break;
    case "clock":
      serverOffsetMs = m.serverOffsetMs;
      break;
    case "audioAnchor":
      audioAnchor = { chunkTsUs: m.chunkTsUs, playAtMs: m.playAtMs };
      break;
    case "blank":
      // Wipe the previous stream's last frame (no ghost under the next
      // sharer's first keyframe) and report the sentinel size, which the
      // front reads as "has never painted".
      teardownDecoder();
      awaitingKeyframe = true;
      resizeCanvas(300, 150);
      if (ctx2d) ctx2d.clearRect(0, 0, 300, 150);
      break;
    case "close":
      teardownDecoder();
      canvas = null;
      ctx2d = null;
      close();
      break;
  }
};
