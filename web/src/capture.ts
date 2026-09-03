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
  /** "text" sharpens edges for code/slides; "motion" favors smoothness.
   *  "auto" (the default) decides from the surface the sharer actually
   *  picked in the browser's own picker: a *tab* is overwhelmingly video
   *  or game content and wants "motion"; monitors and windows keep the
   *  safe "text" default. Nobody has to answer the question. */
  contentHint?: "text" | "motion" | "auto";
  /** Total relay egress budget (kbit/s). Quality-first semantics: the full
   *  target bitrate is allowed as long as the network delivers it — the
   *  budget ÷ viewers ceiling engages only while congestion is actually
   *  observed, and lifts again after a clean stretch. 0 = unlimited. */
  egressBudgetKbps?: number;
  /** What sound rides along with the share:
   *  - "app" (default): the captured tab/window's OWN audio only
   *    (windowAudio:"window", Chrome 141+). The Discord call can never
   *    leak into the stream, so nobody hears themselves echoed.
   *  - "system": whole-device loopback (screen shares) — includes the
   *    Discord call unless the sharer routes Discord to another output
   *    device. Advanced, echo-prone; the UI warns.
   *  - "none": video only. */
  audioMode?: "app" | "system" | "none";
}

export interface CaptureSample {
  ts: number; // capture timestamp of the last encoded frame, µs
  at: number; // performance.now() when it was encoded
}

/** Verification hook for the privacy blank. `droppedFrames` counts raw
 *  frames refused at the reader (gate 1); `suppressedChunks` counts already
 *  encoded chunks refused at the encoder output (gate 2 — the in-flight
 *  frames gate 1 could not reach). While blanked, `sentChunks` must not
 *  move: that is the property the panic button promises. */
export interface BlankStats {
  droppedFrames: number;
  suppressedChunks: number;
  sentChunks: number;
}

export interface CaptureHandle {
  config: ConfigData;
  /** What the sharer picked: "monitor" | "window" | "browser" (tab). */
  displaySurface?: string;
  /** Whether an audio track is actually being streamed. */
  hasAudio: boolean;
  stop(): void;
  /** Rolling one-second output stats (encoded frames/s, kbit/s). */
  stats(): CaptureStats;
  /** Timestamp of the most recently encoded frame — used for clock sync. */
  lastSample(): CaptureSample | null;
  /** Encode the next frame as a keyframe (keyframe-on-demand). */
  forceKeyframe(): void;
  /** Privacy panic: while true NOTHING captured is encoded or sent — not a
   *  video frame, not an audio packet. Takes effect on the very next frame
   *  read, and any frame already inside the encoder is suppressed at the
   *  output, so engaging costs at most one frame of latency and zero frames
   *  of leakage. Lifting forces an immediate keyframe so viewers recover in
   *  one chunk. */
  setBlanked(on: boolean): void;
  /** Whether the encoder is currently gated by the privacy blank. */
  isBlanked(): boolean;
  /** Counters proving the gates fired — see BlankStats. */
  blankStats(): BlankStats;
  /** Change the capture/encode framerate mid-stream (no restart). */
  setFramerate(fps: 30 | 60): Promise<void>;
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

/**
 * Always the best encoder the machine actually has — never a question put
 * to the user.
 *
 * The candidate list is ordered strictly best-first and every entry is
 * gated by `VideoEncoder.isConfigSupported`, so the first *supported* one
 * wins and a machine without the hardware simply falls through:
 *
 *   AV1 (hardware) → H.264 (hardware) → H.264 (any) → VP8
 *
 * AV1's screen-content tools (palette mode, intra block copy) cut 30-40%
 * of the bitrate at equal quality on code, slides and UI, which is why it
 * leads. It is requested `prefer-hardware` only: software AV1 encode
 * cannot hold realtime at these resolutions, and isConfigSupported rejects
 * prefer-hardware outright on a GPU without an AV1 encoder — so this is
 * auto-best with a graceful fallback, not a gamble.
 *
 * Safe for viewers: what we announce, viewers must decode, and AV1 *decode*
 * is universal in Chromium (hardware where available, dav1d in software
 * everywhere else) — including the Chromium builds inside every Discord
 * client and webview. Encode is the scarce half, decode is not.
 */
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
  // Ordering is SVC-major, then codec-major: temporal layers (L1T3) let
  // the relay smoothly lower ONE slow viewer's framerate instead of
  // freezing them — a group-call experience property that engages exactly
  // when things are bad. Bitrate efficiency (AV1's 30-40%) matters less
  // here than degradation quality: with the egress budget and byte-bounded
  // queues, bandwidth is not the binding constraint, congestion behavior
  // is. So a GPU exposing hardware AV1 only WITHOUT scalabilityMode (Intel
  // Arc / recent iGPUs) correctly lands on H.264-with-L1T3 rather than
  // AV1-without.
  const av1 = (extra: Partial<VideoEncoderConfig>): VideoCodecChoice => ({
    wire: "av01.0.08M.08",
    config: {
      codec: "av01.0.08M.08",
      width,
      height,
      framerate,
      bitrate,
      latencyMode: "realtime",
      hardwareAcceleration: "prefer-hardware",
      ...extra,
    } as VideoEncoderConfig,
  });
  const candidates: VideoCodecChoice[] = [
    // Tier 1: hardware + SVC — best codec first.
    av1({ scalabilityMode: "L1T3" }),
    h264("avc1.640c34", { hardwareAcceleration: "prefer-hardware", scalabilityMode: "L1T3" }),
    // Tier 2: hardware without SVC.
    av1({}),
    h264("avc1.640c34", { hardwareAcceleration: "prefer-hardware" }),
  ];
  candidates.push(
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
  );
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
  const audioMode = opts.audioMode ?? "app";
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: framerate } },
    audio:
      audioMode === "none"
        ? false
        : {
            // AEC/NS/AGC stay off: Chrome's echo canceller has no useful
            // reference signal for loopback captures (verified against
            // Chromium source) — echo avoidance happens by *scoping* the
            // capture instead, below.
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            // Chrome 141+ (Win/Mac): on a monitor capture, drop THIS
            // browser's own audio from the mix. No-op elsewhere.
            ...(audioMode === "system" ? { restrictOwnAudio: true } : {}),
          },
    // Chromium extras (typed loosely on purpose). The load-bearing echo
    // fix: windowAudio "window" captures the selected window's OWN
    // (per-application) audio, and system loopback is only offered when
    // the sharer explicitly chose the advanced whole-screen-sound mode.
    ...({
      systemAudio: audioMode === "system" ? "include" : "exclude",
      windowAudio: audioMode === "none" ? "exclude" : "window",
      audioSelection: "preferred", // Chrome 152+: pre-check the picker's audio toggle
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
    } as object),
  });

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) throw new Error("no video track from getDisplayMedia");
  const settings = videoTrack.getSettings();
  let width = settings.width ?? 1920;
  let height = settings.height ?? 1080;

  // Content hint, decided *after* the picker so it can use what the sharer
  // actually chose. "text" tells the encoder to preserve sharp edges — the
  // difference between readable and mushy code/slides at a given bitrate;
  // "motion" spends the same bits on smoothness instead. The one surface we
  // can call unambiguously is a browser tab ("browser"), which is nearly
  // always video or a web game, so it gets "motion"; monitors and windows
  // keep the safe "text" default. An explicit caller choice always wins.
  const surface = (settings as { displaySurface?: string }).displaySurface;
  const hint = opts.contentHint ?? "auto";
  videoTrack.contentHint =
    hint === "auto" ? (surface === "browser" ? "motion" : "text") : hint;

  // Echo guard: "app" mode promises the Discord call can never ride the
  // stream, but that promise is only enforceable when the audio is scoped
  // to a window or tab. If the sharer picked a whole MONITOR and the
  // browser still handed us an audio track (a Chrome that ignores the
  // windowAudio/systemAudio extras falls back to system loopback), that
  // track is the entire desktop mix — call included — so everyone hears
  // themselves. Drop it: no sound beats echoing the room back at itself.
  if ((opts.audioMode ?? "app") === "app" && surface === "monitor") {
    for (const track of stream.getAudioTracks()) {
      track.stop();
      stream.removeTrack(track);
    }
  }

  const chosen = await pickVideoCodec(width, height, framerate);

  const targetBitrate = chosen.config.bitrate ?? 4_000_000;
  let bitrate = targetBitrate;

  // --- privacy blank (panic button) ----------------------------------------
  // A correctness feature, not a UI state: while `blanked` is true no
  // captured byte may reach the transport. Two gates live in this file and
  // they are deliberately redundant.
  //
  //   Gate 1 — the frame reader below drops frames before `videoEncoder
  //            .encode()` (and audio before `audioEncoder.encode()`). This
  //            is the one that matters: nothing captured is ever handed to
  //            an encoder while hidden.
  //   Gate 2 — the encoder `output` callbacks refuse to `sendChunk`. The
  //            encoder is asynchronous and may hold up to two frames that
  //            were legitimately admitted a moment before the toggle; gate 1
  //            cannot reach those, so they die here instead. This is what
  //            turns "≤1 frame of latency" into "0 frames of leakage".
  //
  // The relay carries two more (fan-out drop + GOP eviction) so a leak would
  // have to defeat both ends. See internal/relay/relay.go → SetBlank.
  let blanked = false;
  const blankCounters = { droppedFrames: 0, suppressedChunks: 0, sentChunks: 0 };

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
      // Blank gate 2: a frame admitted just before the toggle can still
      // surface here. Never let it onto the wire.
      if (blanked) {
        blankCounters.suppressedChunks++;
        return;
      }
      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
      frameCount++;
      byteCount += payload.byteLength;
      blankCounters.sentChunks++;
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
      // Blank gate 1, and it comes FIRST — ahead of backpressure, ahead of
      // the keyframe bookkeeping, ahead of anything that could touch the
      // pixels. The very next frame read after the toggle is destroyed
      // unlooked-at, which is what bounds "engage" to a single frame.
      if (blanked) {
        blankCounters.droppedFrames++;
        frame.close();
        continue;
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
  // Quality-first ceiling: the budget ÷ viewers cap engages only while
  // congestion has actually been observed recently. A clean network earns
  // the full target bitrate back regardless of viewer count — the budget is
  // a guardrail against saturation oscillation, not a standing quality tax.
  let lastPressureAt = 0;
  const PRESSURE_MEMORY_MS = 15_000;
  const ceiling = () => {
    const budget = (opts.egressBudgetKbps ?? 0) * 1000;
    if (
      budget <= 0 ||
      hintViewers <= 0 ||
      performance.now() - lastPressureAt > PRESSURE_MEMORY_MS
    ) {
      return targetBitrate;
    }
    return Math.max(ABR_MIN_BITRATE, Math.min(targetBitrate, Math.floor(budget / hintViewers)));
  };
  const abrTimer = setInterval(() => {
    if (!opts.backpressure || videoEncoder.state !== "configured") return;
    const backlog = opts.backpressure();
    // Congested when our uplink backs up or when a meaningful share of
    // viewers (>30%) is being degraded by the relay.
    const fanoutPressure =
      hintViewers > 0 && hintDegraded / hintViewers > 0.3;
    if (backlog > ABR_HIGH_WATER || fanoutPressure) lastPressureAt = performance.now();
    const cap = ceiling();
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
        // Blank gate 2, audio. Privacy is not only pixels: the captured
        // app's sound (a notification, a video, someone's voice note) is
        // exactly as leaky as its picture, so the panic button mutes it too.
        if (blanked) {
          blankCounters.suppressedChunks++;
          return;
        }
        const payload = new Uint8Array(chunk.byteLength);
        chunk.copyTo(payload);
        byteCount += payload.byteLength;
        blankCounters.sentChunks++;
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
        // Blank gate 1, audio.
        if (blanked) {
          blankCounters.droppedFrames++;
          data.close();
          continue;
        }
        audioEncoder!.encode(data);
        data.close();
      }
    })();
  }

  const handle: CaptureHandle = {
    displaySurface: surface,
    hasAudio: Boolean(audioTrack),
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
    isBlanked: () => blanked,
    blankStats: () => ({ ...blankCounters }),
    setBlanked(on: boolean) {
      if (blanked === on) return;
      blanked = on;
      if (!on) {
        // Recover in one chunk: the same keyframe-on-demand flag that
        // answers CtrlKeyframeRequest, so viewers whose decoders were left
        // waiting behind the relay's keyframe gate get a fresh IDR
        // immediately instead of the next 4-second safety-net one.
        keyframeWanted = true;
      }
    },
    async setFramerate(fps: 30 | 60) {
      if (videoEncoder.state !== "configured") return;
      await videoTrack.applyConstraints({ frameRate: { ideal: fps } }).catch(() => {});
      chosen.config = { ...chosen.config, framerate: fps };
      videoEncoder.configure({ ...chosen.config, bitrate });
      keyframeWanted = true;
      handle.config = { ...handle.config, framerate: fps };
      handle.onconfigchange?.(handle.config);
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
