// Screen capture + WebCodecs encoding: getDisplayMedia -> VideoEncoder
// (H.264 hardware preferred, VP8 fallback) and AudioEncoder (Opus) -> packed
// media chunks handed to the session.
//
// Chromium-only APIs (MediaStreamTrackProcessor, WebCodecs) — fine for
// Discord clients, which embed Chromium everywhere.

import { KIND_AUDIO, KIND_VIDEO, packMedia, type ConfigData } from "./protocol";

// Safety-net keyframe cadence. Recovery and late-join are driven by
// keyframe-on-demand requests from the relay; this bounds the worst case
// AND keeps a full GOP small enough (≤240 chunks at 60fps) to fit a fresh
// client's 256-slot queue, so the late-join cache stays replayable.
const KEYFRAME_INTERVAL_US = 4_000_000;

// Adaptive bitrate: when the WebSocket send buffer backs up the uplink can't
// keep pace — step the encoder down; after a sustained clear period, step
// back up toward the target.
const ABR_HIGH_WATER = 768 * 1024; // step down above this buffered amount
const ABR_LOW_WATER = 64 * 1024; // count as "clear" below this
const ABR_DROP_WATER = 3 * 1024 * 1024; // stop encoding entirely above this
const ABR_MIN_BITRATE = 400_000;
const ABR_STEP_UP_AFTER_S = 5;

export interface CaptureStats {
  fps: number;
  kbps: number;
  /** Current encoder bitrate target (adaptive), kbit/s. */
  targetKbps: number;
}

export interface CaptureOptions {
  /** Bytes queued on the transport but not yet sent (ws.bufferedAmount). */
  backpressure?: () => number;
  /** "text" sharpens edges for code/slides; "motion" favors smoothness. */
  contentHint?: "text" | "motion";
  /** Total relay egress budget (kbit/s). The encoder's ceiling becomes
   *  budget ÷ viewers, so adding viewers lowers per-viewer bitrate instead
   *  of multiplying uplink load past saturation. 0 = unlimited. */
  egressBudgetKbps?: number;
}

export interface CaptureSample {
  ts: number; // capture timestamp of the last encoded frame, µs
  at: number; // performance.now() when it was encoded
}

export interface CaptureHandle {
  config: ConfigData;
  stop(): void;
  /** Rolling one-second output stats (encoded frames/s, kbit/s). */
  stats(): CaptureStats;
  /** Timestamp of the most recently encoded frame — used for clock sync. */
  lastSample(): CaptureSample | null;
  /** Encode the next frame as a keyframe (keyframe-on-demand). */
  forceKeyframe(): void;
  /** Relay congestion feedback: degraded viewers out of total. */
  applyRateHint(degraded: number, viewers: number): void;
  /** Fires when the user ends capture via the browser's own UI. */
  onended: (() => void) | null;
  /** Fires when the source resized and config changed — re-announce it. */
  onconfigchange: ((cfg: ConfigData) => void) | null;
}

interface VideoCodecChoice {
  wire: string; // codec string sent to viewers
  config: VideoEncoderConfig;
}

async function pickVideoCodec(
  width: number,
  height: number,
  framerate: number,
): Promise<VideoCodecChoice> {
  const bitrate = framerate >= 60 ? 6_000_000 : 4_000_000;
  const h264 = (codec: string, extra: Partial<VideoEncoderConfig>): VideoCodecChoice => ({
    wire: codec,
    config: {
      codec,
      avc: { format: "annexb" },
      width,
      height,
      framerate,
      bitrate,
      latencyMode: "realtime",
      ...extra,
    } as VideoEncoderConfig,
  });
  // SVC (L1T3) first: temporal layers let the relay smoothly lower a slow
  // viewer's framerate instead of freezing them. Non-SVC fallbacks follow
  // for encoders that don't support scalabilityMode.
  const candidates: VideoCodecChoice[] = [
    h264("avc1.640c34", { hardwareAcceleration: "prefer-hardware", scalabilityMode: "L1T3" }),
    h264("avc1.640c34", { hardwareAcceleration: "prefer-hardware" }),
    h264("avc1.42e034", {}),
    {
      wire: "vp8",
      config: {
        codec: "vp8", width, height, framerate, bitrate,
        latencyMode: "realtime", scalabilityMode: "L1T3",
      } as VideoEncoderConfig,
    },
    {
      wire: "vp8",
      config: { codec: "vp8", width, height, framerate, bitrate, latencyMode: "realtime" },
    },
  ];
  for (const cand of candidates) {
    const { supported } = await VideoEncoder.isConfigSupported(cand.config);
    if (supported) return cand;
  }
  throw new Error("no supported video encoder (H.264/VP8)");
}

export async function startCapture(
  framerate: 30 | 60,
  sendChunk: (buf: ArrayBuffer) => void,
  opts: CaptureOptions = {},
): Promise<CaptureHandle> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: framerate } },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    // Chromium extras (typed loosely on purpose): reliably capture system
    // audio, keep this tab out of its own picker, and let the sharer switch
    // the shared surface without restarting the stream.
    ...({
      systemAudio: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
    } as object),
  });

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) throw new Error("no video track from getDisplayMedia");
  // "text" tells the encoder to preserve sharp edges — the difference
  // between readable and mushy code/slides at a given bitrate.
  videoTrack.contentHint = opts.contentHint ?? "text";
  const settings = videoTrack.getSettings();
  let width = settings.width ?? 1920;
  let height = settings.height ?? 1080;

  const chosen = await pickVideoCodec(width, height, framerate);

  const targetBitrate = chosen.config.bitrate ?? 4_000_000;
  let bitrate = targetBitrate;

  // --- stats ----------------------------------------------------------------
  let frameCount = 0;
  let byteCount = 0;
  let stats: CaptureStats = { fps: 0, kbps: 0, targetKbps: bitrate / 1000 };
  const statsTimer = setInterval(() => {
    stats = {
      fps: frameCount,
      kbps: Math.round((byteCount * 8) / 1000),
      targetKbps: Math.round(bitrate / 1000),
    };
    frameCount = 0;
    byteCount = 0;
  }, 1000);

  // --- video pipeline -------------------------------------------------------
  let videoSeq = 0;
  const videoEncoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
      frameCount++;
      byteCount += payload.byteLength;
      const tid =
        (metadata as { svc?: { temporalLayerId?: number } } | undefined)?.svc
          ?.temporalLayerId ?? 0;
      sendChunk(
        packMedia(KIND_VIDEO, chunk.type === "key", tid, videoSeq++, chunk.timestamp, payload),
      );
    },
    error: (e) => console.error("video encoder:", e),
  });
  videoEncoder.configure(chosen.config);

  const videoProcessor = new MediaStreamTrackProcessor<VideoFrame>({ track: videoTrack });
  const videoReader = videoProcessor.readable.getReader();
  let lastKeyframeTs = 0;
  let running = true;
  let keyframeWanted = false;
  let sample: CaptureSample | null = null;

  (async () => {
    for (;;) {
      const { value: frame, done } = await videoReader.read();
      if (done || !running) {
        frame?.close();
        break;
      }
      // Drop at the source when the encoder or the network is behind —
      // latency must never accumulate in queues.
      const backlog = opts.backpressure?.() ?? 0;
      if (videoEncoder.encodeQueueSize > 2 || backlog > ABR_DROP_WATER) {
        frame.close();
        continue;
      }
      const ts = frame.timestamp ?? 0;
      const keyframe = keyframeWanted || ts - lastKeyframeTs >= KEYFRAME_INTERVAL_US;
      if (keyframe) {
        lastKeyframeTs = ts;
        keyframeWanted = false;
      }
      sample = { ts, at: performance.now() };
      videoEncoder.encode(frame, { keyFrame: keyframe });
      frame.close();
    }
  })();

  // Shared-source resizes (window shares especially) must reconfigure the
  // encoder and re-announce dimensions, or viewers keep a stale canvas and
  // the encoder may error. Debounced: live window-dragging fires storms.
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  videoTrack.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const now = videoTrack.getSettings();
      const w = now.width ?? width;
      const h = now.height ?? height;
      if ((w === width && h === height) || videoEncoder.state !== "configured") return;
      width = w;
      height = h;
      chosen.config = { ...chosen.config, width, height };
      videoEncoder.configure({ ...chosen.config, bitrate });
      keyframeWanted = true; // fresh parameter set needs a fresh IDR
      handle.config = { ...handle.config, width, height };
      handle.onconfigchange?.(handle.config);
    }, 500);
  });

  // --- adaptive bitrate -----------------------------------------------------
  // Two congestion signals: our own uplink (ws.bufferedAmount) and the
  // relay's fan-out side (rate hints reporting degraded viewers) — the
  // uplink signal alone cannot see relay->viewer pressure.
  let clearSeconds = 0;
  let hintDegraded = 0;
  let hintViewers = 0;
  // The per-viewer ceiling: with an egress budget, every viewer multiplies
  // uplink cost, so the ceiling is budget ÷ viewers.
  const ceiling = () => {
    const budget = (opts.egressBudgetKbps ?? 0) * 1000;
    if (budget <= 0 || hintViewers <= 0) return targetBitrate;
    return Math.max(ABR_MIN_BITRATE, Math.min(targetBitrate, Math.floor(budget / hintViewers)));
  };
  const abrTimer = setInterval(() => {
    if (!opts.backpressure || videoEncoder.state !== "configured") return;
    const backlog = opts.backpressure();
    const cap = ceiling();
    // Congested when our uplink backs up, when a meaningful share of
    // viewers (>30%) is being degraded by the relay, or when the viewer
    // count pushed the egress budget below the current bitrate.
    const fanoutPressure =
      hintViewers > 0 && hintDegraded / hintViewers > 0.3;
    if (backlog > ABR_HIGH_WATER || fanoutPressure || bitrate > cap) {
      const next = Math.max(ABR_MIN_BITRATE, Math.min(Math.round(bitrate * 0.7), cap));
      clearSeconds = 0;
      if (next < bitrate) {
        bitrate = next;
        // No forced IDR here: pushing the largest possible frame into an
        // already-congested uplink defeats the point of stepping down.
        videoEncoder.configure({ ...chosen.config, bitrate });
      }
    } else if (backlog < ABR_LOW_WATER && bitrate < cap) {
      clearSeconds++;
      if (clearSeconds >= ABR_STEP_UP_AFTER_S) {
        clearSeconds = 0;
        // Additive increase, divided by the viewer count: a +400kbps step
        // costs the uplink 400kbps × viewers, so step by what one viewer's
        // worth of headroom actually buys.
        const step = Math.max(100_000, Math.floor(400_000 / Math.max(hintViewers, 1)));
        bitrate = Math.min(cap, bitrate + step);
        videoEncoder.configure({ ...chosen.config, bitrate });
        keyframeWanted = true;
      }
    } else {
      clearSeconds = 0;
    }
  }, 1000);

  // --- audio pipeline (best-effort: track may be absent) --------------------
  const audioTrack = stream.getAudioTracks()[0];
  let audioEncoder: AudioEncoder | null = null;
  let audioReader: ReadableStreamDefaultReader<AudioData> | null = null;
  let audioConfig: Pick<ConfigData, "audioCodec" | "sampleRate" | "channels"> = {};

  if (audioTrack) {
    const audioSettings = audioTrack.getSettings();
    const sampleRate = audioSettings.sampleRate ?? 48000;
    const channels = audioSettings.channelCount ?? 2;
    audioConfig = { audioCodec: "opus", sampleRate, channels };

    let audioSeq = 0;
    audioEncoder = new AudioEncoder({
      output: (chunk) => {
        const payload = new Uint8Array(chunk.byteLength);
        chunk.copyTo(payload);
        byteCount += payload.byteLength;
        sendChunk(packMedia(KIND_AUDIO, true, 0, audioSeq++, chunk.timestamp, payload));
      },
      error: (e) => console.error("audio encoder:", e),
    });
    audioEncoder.configure({
      codec: "opus",
      sampleRate,
      numberOfChannels: channels,
      bitrate: 128_000,
    });

    const audioProcessor = new MediaStreamTrackProcessor<AudioData>({ track: audioTrack });
    const reader = audioProcessor.readable.getReader();
    audioReader = reader;
    (async () => {
      for (;;) {
        const { value: data, done } = await reader.read();
        if (done || !running) {
          data?.close();
          break;
        }
        audioEncoder!.encode(data);
        data.close();
      }
    })();
  }

  const handle: CaptureHandle = {
    applyRateHint(degraded, viewers) {
      hintDegraded = degraded;
      hintViewers = viewers;
    },
    config: {
      videoCodec: chosen.wire,
      width,
      height,
      framerate,
      ...audioConfig,
    },
    stats: () => stats,
    lastSample: () => sample,
    forceKeyframe: () => {
      keyframeWanted = true;
    },
    onended: null,
    onconfigchange: null,
    stop() {
      running = false;
      clearInterval(statsTimer);
      clearInterval(abrTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      for (const track of stream.getTracks()) track.stop();
      videoReader.cancel().catch(() => {});
      audioReader?.cancel().catch(() => {});
      videoEncoder.close();
      audioEncoder?.close();
    },
  };

  videoTrack.addEventListener("ended", () => handle.onended?.());
  return handle;
}
