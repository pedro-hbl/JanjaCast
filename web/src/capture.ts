// Screen capture + WebCodecs encoding: getDisplayMedia -> VideoEncoder
// (H.264 hardware preferred, VP8 fallback) and AudioEncoder (Opus) -> packed
// media chunks handed to the session.
//
// Chromium-only APIs (MediaStreamTrackProcessor, WebCodecs) — fine for
// Discord clients, which embed Chromium everywhere.

import { KIND_AUDIO, KIND_VIDEO, packMedia, type ConfigData } from "./protocol";

const KEYFRAME_INTERVAL_US = 2_000_000; // request a keyframe every 2s so late joiners sync fast

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
  /** Fires when the user ends capture via the browser's own UI. */
  onended: (() => void) | null;
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
  const candidates: VideoCodecChoice[] = [
    {
      wire: "avc1.640c34", // H.264 High, level 5.2 — covers 4K60
      config: {
        codec: "avc1.640c34",
        avc: { format: "annexb" },
        width,
        height,
        framerate,
        bitrate,
        latencyMode: "realtime",
        hardwareAcceleration: "prefer-hardware",
      },
    },
    {
      wire: "avc1.42e034", // H.264 Baseline, level 5.2
      config: {
        codec: "avc1.42e034",
        avc: { format: "annexb" },
        width,
        height,
        framerate,
        bitrate,
        latencyMode: "realtime",
      },
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
  });

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) throw new Error("no video track from getDisplayMedia");
  const settings = videoTrack.getSettings();
  const width = settings.width ?? 1920;
  const height = settings.height ?? 1080;

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
    output: (chunk) => {
      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
      frameCount++;
      byteCount += payload.byteLength;
      sendChunk(
        packMedia(KIND_VIDEO, chunk.type === "key", videoSeq++, chunk.timestamp, payload),
      );
    },
    error: (e) => console.error("video encoder:", e),
  });
  videoEncoder.configure(chosen.config);

  const videoProcessor = new MediaStreamTrackProcessor<VideoFrame>({ track: videoTrack });
  const videoReader = videoProcessor.readable.getReader();
  let lastKeyframeTs = 0;
  let running = true;
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
      const keyframe = ts - lastKeyframeTs >= KEYFRAME_INTERVAL_US;
      if (keyframe) lastKeyframeTs = ts;
      sample = { ts, at: performance.now() };
      videoEncoder.encode(frame, { keyFrame: keyframe });
      frame.close();
    }
  })();

  // --- adaptive bitrate -----------------------------------------------------
  let clearSeconds = 0;
  const abrTimer = setInterval(() => {
    if (!opts.backpressure || videoEncoder.state !== "configured") return;
    const backlog = opts.backpressure();
    if (backlog > ABR_HIGH_WATER) {
      const next = Math.max(ABR_MIN_BITRATE, Math.round(bitrate * 0.7));
      clearSeconds = 0;
      if (next < bitrate) {
        bitrate = next;
        videoEncoder.configure({ ...chosen.config, bitrate });
      }
    } else if (backlog < ABR_LOW_WATER && bitrate < targetBitrate) {
      clearSeconds++;
      if (clearSeconds >= ABR_STEP_UP_AFTER_S) {
        clearSeconds = 0;
        bitrate = Math.min(targetBitrate, Math.round(bitrate * 1.15));
        videoEncoder.configure({ ...chosen.config, bitrate });
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
        sendChunk(packMedia(KIND_AUDIO, true, audioSeq++, chunk.timestamp, payload));
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
    config: {
      videoCodec: chosen.wire,
      width,
      height,
      framerate,
      ...audioConfig,
    },
    stats: () => stats,
    lastSample: () => sample,
    onended: null,
    stop() {
      running = false;
      clearInterval(statsTimer);
      clearInterval(abrTimer);
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
