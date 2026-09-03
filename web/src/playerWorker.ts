// The viewer's video half, off the main thread — now MULTI-TILE (Seam 5).
// One worker owns every tile: a Map<slot, tile> of decoder+OffscreenCanvas
// pairs, demuxed by the chunk's slot byte. One worker (not N) keeps a single
// JS heap and lets the browser pool hardware decode sessions; you only ever
// decode the chairs you subscribed to.
//
// THE INVARIANT (owner-mandated): alt-tab never introduces delay. Drop-to-
// live rules every tile independently — when a tile's decoder or present
// queue is deeper than MAX_QUEUE_DEPTH at a keyframe, that tile's backlog
// dies and it resumes from the live edge. Frames are never held to be shown
// late. A/V delay (bounded 300ms) applies only to the ONE audio-anchored
// slot; every other tile draws immediately.

import { KIND_VIDEO, unpackMedia } from "./protocol";

const MAX_VIDEO_DELAY_MS = 300;
const MAX_QUEUE_DEPTH = 6;

interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

interface Tile {
  slot: number;
  canvas: OffscreenCanvas;
  ctx2d: OffscreenCanvasRenderingContext2D | null;
  decoder: VideoDecoder | null;
  decoderCfg: VideoDecoderConfig | null;
  awaitingKeyframe: boolean;
  pendingFrames: Set<VideoFrame>;
  view: ViewState;
  frameCount: number;
  lastKfAsk: number;
  blanked: boolean;
}

const tiles = new Map<number, Tile>();
/** Server-minus-local clock offset (ms), refreshed from the main thread. */
let serverOffsetMs = 0;
let sync: { captureTs: number; wallTs: number } | null = null;
/** A/V anchor: audio chunk `chunkTsUs` of `slot` plays at wall `playAtMs`. */
let audioAnchor: { slot: number; chunkTsUs: number; playAtMs: number } | null =
  null;
let latencyEma: number | null = null;

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

function applyContextDefaults(t: Tile): void {
  if (!t.ctx2d) return;
  t.ctx2d.imageSmoothingEnabled = true;
  t.ctx2d.imageSmoothingQuality = "high";
}

function resizeCanvas(t: Tile, w: number, h: number): void {
  if (w <= 0 || h <= 0) return;
  if (t.canvas.width !== w || t.canvas.height !== h) {
    t.canvas.width = w;
    t.canvas.height = h;
    applyContextDefaults(t);
    postMessage({ type: "dims", slot: t.slot, w, h });
  }
}

function teardownDecoder(t: Tile): void {
  for (const f of t.pendingFrames) f.close();
  t.pendingFrames.clear();
  if (t.decoder && t.decoder.state !== "closed") t.decoder.close();
  t.decoder = null;
}

function addTile(slot: number, canvas: OffscreenCanvas): void {
  removeTile(slot);
  const t: Tile = {
    slot,
    canvas,
    ctx2d: canvas.getContext("2d"),
    decoder: null,
    decoderCfg: null,
    awaitingKeyframe: true,
    pendingFrames: new Set(),
    view: { zoom: 1, panX: 0.5, panY: 0.5 },
    frameCount: 0,
    lastKfAsk: 0,
    blanked: false,
  };
  applyContextDefaults(t);
  tiles.set(slot, t);
}

function removeTile(slot: number): void {
  const t = tiles.get(slot);
  if (!t) return;
  teardownDecoder(t);
  tiles.delete(slot);
}

function configureTile(
  slot: number,
  cfg: { videoCodec: string; width: number; height: number },
): void {
  const t = tiles.get(slot);
  if (!t) return;
  teardownDecoder(t);
  if (!cfg.videoCodec || cfg.width <= 0) return; // blank/teardown config
  t.awaitingKeyframe = true;
  resizeCanvas(t, cfg.width, cfg.height);
  t.view = { zoom: 1, panX: 0.5, panY: 0.5 };
  t.decoder = new VideoDecoder({
    output: (frame) => presentFrame(t, frame),
    error: (e) => console.error(`video decoder (slot ${slot}):`, e),
  });
  t.decoderCfg = {
    codec: cfg.videoCodec,
    codedWidth: cfg.width,
    codedHeight: cfg.height,
    optimizeForLatency: true,
  };
  t.decoder.configure(t.decoderCfg);
}

function push(buf: ArrayBuffer): void {
  const chunk = unpackMedia(buf);
  if (!chunk || chunk.kind !== KIND_VIDEO) return;
  const t = tiles.get(chunk.slot);
  if (!t || !t.decoder || t.decoder.state !== "configured" || t.blanked) return;

  if (t.awaitingKeyframe && !chunk.keyframe) {
    const now = Date.now();
    if (now - t.lastKfAsk > 1000) {
      t.lastKfAsk = now;
      postMessage({ type: "needKeyframe", slot: t.slot });
    }
    return;
  }
  t.awaitingKeyframe = false;

  // SVC-aware pre-decode shedding, per tile: a droppable temporal layer is
  // not worth decode cycles when this tile is behind. T0 always passes.
  if (
    chunk.temporalId > 0 &&
    (t.decoder.decodeQueueSize > MAX_QUEUE_DEPTH ||
      t.pendingFrames.size > MAX_QUEUE_DEPTH)
  ) {
    return;
  }

  // Drop to live, per tile: a keyframe is the safe point to shed a backlog.
  if (
    chunk.keyframe &&
    (t.decoder.decodeQueueSize > MAX_QUEUE_DEPTH ||
      t.pendingFrames.size > MAX_QUEUE_DEPTH)
  ) {
    t.decoder.reset();
    t.decoder.configure(t.decoderCfg!);
    for (const f of t.pendingFrames) f.close();
    t.pendingFrames.clear();
  }
  t.decoder.decode(
    new EncodedVideoChunk({
      type: chunk.keyframe ? "key" : "delta",
      timestamp: chunk.timestamp,
      data: chunk.payload,
    }),
  );
}

function videoDelayMs(t: Tile, frameTsUs: number): number {
  // Only the audio-anchored slot aligns to audio; every other tile is a
  // silent picture and draws at the live edge.
  if (!audioAnchor || audioAnchor.slot !== t.slot) return 0;
  const target =
    audioAnchor.playAtMs + (frameTsUs - audioAnchor.chunkTsUs) / 1000;
  return clamp(target - Date.now(), 0, MAX_VIDEO_DELAY_MS);
}

function presentFrame(t: Tile, frame: VideoFrame): void {
  const delayMs = videoDelayMs(t, frame.timestamp ?? 0);
  if (delayMs <= 4 || t.pendingFrames.size > MAX_QUEUE_DEPTH) {
    drawFrame(t, frame);
    return;
  }
  t.pendingFrames.add(frame);
  setTimeout(() => {
    if (t.pendingFrames.delete(frame)) drawFrame(t, frame);
  }, delayMs);
}

function drawFrame(t: Tile, frame: VideoFrame): void {
  if (!t.ctx2d) {
    frame.close();
    return;
  }
  t.frameCount++;
  const w = frame.displayWidth || frame.codedWidth;
  const h = frame.displayHeight || frame.codedHeight;
  resizeCanvas(t, w, h);

  if (t.view.zoom > 1) {
    const size = 1 / t.view.zoom;
    const ox = clamp(t.view.panX - size / 2, 0, 1 - size);
    const oy = clamp(t.view.panY - size / 2, 0, 1 - size);
    t.ctx2d.drawImage(
      frame,
      ox * w,
      oy * h,
      size * w,
      size * h,
      0,
      0,
      t.canvas.width,
      t.canvas.height,
    );
  } else {
    t.ctx2d.drawImage(frame, 0, 0);
  }

  const ts = frame.timestamp ?? 0;
  frame.close();

  // Glass-to-glass latency tracks the anchored (or lowest) tile.
  if (sync && (!audioAnchor || audioAnchor.slot === t.slot)) {
    const capturedAt = sync.wallTs + (ts - sync.captureTs) / 1000;
    const latency = Date.now() + serverOffsetMs - capturedAt;
    if (latency > -5000 && latency < 30_000) {
      latencyEma =
        latencyEma === null ? latency : latencyEma * 0.9 + latency * 0.1;
    }
  }
}

setInterval(() => {
  const perSlot: Record<number, number> = {};
  for (const [slot, t] of tiles) {
    perSlot[slot] = t.frameCount;
    t.frameCount = 0;
  }
  postMessage({
    type: "stats",
    perSlot,
    latencyMs: latencyEma === null ? null : Math.round(latencyEma),
  });
}, 1000);

onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  switch (m.type) {
    case "addTile":
      addTile(m.slot, m.canvas as OffscreenCanvas);
      break;
    case "removeTile":
      removeTile(m.slot);
      break;
    case "config":
      configureTile(m.slot ?? 0, m.cfg);
      break;
    case "chunk":
      push(m.buf as ArrayBuffer);
      break;
    case "view": {
      const t = tiles.get(m.slot ?? 0);
      if (t) t.view = { zoom: m.zoom, panX: m.panX, panY: m.panY };
      break;
    }
    case "sync":
      sync = m.sync;
      break;
    case "clock":
      serverOffsetMs = m.serverOffsetMs;
      break;
    case "audioAnchor":
      audioAnchor = {
        slot: m.slot ?? 0,
        chunkTsUs: m.chunkTsUs,
        playAtMs: m.playAtMs,
      };
      break;
    case "blank": {
      // Wipe a tile between publishers (or on privacy blank): sentinel size
      // 300x150 reads as "never painted" on the front.
      const t = tiles.get(m.slot ?? 0);
      if (!t) break;
      teardownDecoder(t);
      t.awaitingKeyframe = true;
      resizeCanvas(t, 300, 150);
      t.ctx2d?.clearRect(0, 0, 300, 150);
      break;
    }
    case "setBlanked": {
      const t = tiles.get(m.slot ?? 0);
      if (t) t.blanked = !!m.on;
      break;
    }
    case "close":
      for (const slot of [...tiles.keys()]) removeTile(slot);
      close();
      break;
  }
};
