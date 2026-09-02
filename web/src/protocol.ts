// Wire protocol shared with the Go server (see internal/protocol/protocol.go).
// Text WebSocket messages carry JSON control envelopes; binary messages carry
// one encoded media chunk behind a fixed 13-byte header.

export const KIND_VIDEO = 1;
export const KIND_AUDIO = 2;
export const FLAG_KEYFRAME = 1 << 0;
export const HEADER_SIZE = 13;

export type ControlType =
  | "join"
  | "take_stage"
  | "leave_stage"
  | "config"
  | "ping"
  | "pong"
  | "sync"
  | "keyframe_request"
  | "stage_taken"
  | "rate_hint"
  | "welcome"
  | "stage_state"
  | "room_state"
  | "token_refresh"
  | "superseded"
  | "stinger"
  | "stinger_play"
  | "blank"
  | "blank_state"
  | "stage_request"
  | "stage_withdraw"
  | "stage_pass"
  | "stage_mode"
  | "stage_extend"
  | "stage_queue"
  | "stage_turn"
  | "stage_cancel"
  | "room_phase"
  | "cinema_state"
  | "cinema_stroke_add"
  | "error";

export type OutboundControlType =
  | "join"
  | "take_stage"
  | "leave_stage"
  | "config"
  | "ping"
  | "keyframe_request"
  | "stinger_play"
  | "blank"
  | "stage_request"
  | "stage_withdraw"
  | "stage_pass"
  | "stage_mode"
  | "stage_extend"
  | "cinema_pause"
  | "cinema_resume"
  | "cinema_stroke";

/** The privacy panic button. `blank` is publisher→relay, `blank_state` is
 *  relay→everyone; one shape both ways. `on` is never omitted — an
 *  un-blank that serialized to `{}` could never lift the blank. */
export interface BlankData {
  on: boolean;
}

/* ---------------------------- the stage queue ----------------------------
 * "Pedir a vez": a visible FIFO line beside the roster, and — in rodízio
 * mode — a clock on each turn. Mirrors internal/protocol/protocol.go. */

/** The room's turn-taking mode. Livre is the default: the line exists, the
 *  sharer hands it on whenever. Rodízio adds the clock and the wheel. */
export type StageMode = "livre" | "rodizio";

/** Why a pending turn ended. */
export type StageCancelReason =
  | "timeout"
  | "left"
  | "accepted"
  | "stage_changed";

/** How the next person was chosen. "wheel" is the one that gets an
 *  animation — it is a real draw, so the spin is not a lie. */
export type StageTurnMethod = "queue" | "wheel";

/** One person waiting. `initialsEmoji` is computed server-side so every
 *  client draws the same chip. */
export interface QueueEntry {
  userId: string;
  username: string;
  initialsEmoji: string;
}

/** The whole "who is next" state in one message.
 *
 *  `timerStartMs` / `turnEndsMs` are SERVER wall clock (Unix ms) — read them
 *  against `session.serverNow()`, never `Date.now()`. `turnLenMs` already
 *  includes the +5 once `extended` is true, so the client never repeats that
 *  maths. */
export interface StageQueueData {
  queue: QueueEntry[];
  mode: StageMode;
  timerStartMs?: number; // 0/absent = the stage is free
  turnLenMs: number;
  extended?: boolean;
  turnUserId?: string;
  turnEndsMs?: number;
}

export interface StageModeData {
  mode: StageMode;
}

/** "É tua!" — one person has `ttlMs` to claim the stage. */
export interface StageTurnData {
  userId: string;
  username: string;
  ttlMs: number;
  method: StageTurnMethod;
}

export interface StageCancelData {
  userId: string;
  reason: StageCancelReason;
}

/** Server-chosen stinger: the same image + sound pair (same-origin URLs under
 *  /stingers/) for every participant. "start"/"stop" are the automatic stream
 *  transitions; "manual" is somebody pressing a button in the panel. */
export interface StingerData {
  kind: "start" | "stop" | "manual";
  image?: string;
  audio?: string;
}

/** One stinger asset as the management API reports it. `url` is
 *  origin-relative and must go through apiPath() before it is fetched. */
export interface StingerAsset {
  name: string;
  type: "image" | "audio";
  contentType: string;
  size: number;
  url: string;
  enabled: boolean;
  playOnStart: boolean;
  playOnStop: boolean;
}

/** GET /api/stingers. */
export interface StingerListData {
  assets: StingerAsset[];
  max: number;
  maxBytes: number;
}

/** Publisher clock-sync mark: capture timestamp (µs) ↔ server wall clock
 *  (Unix ms). Lets viewers compute glass-to-glass latency. */
export interface SyncData {
  captureTs: number;
  wallTs: number;
}

export interface Control<T = unknown> {
  type: ControlType;
  data?: T;
}

export interface Point { x: number; y: number }
export interface CinemaStrokeData { color: string; points: Point[] }
export interface StrokeData { userId: string; color: string; points: Point[]; strokeId: string }
export interface CinemaStateData { paused: boolean; strokes: StrokeData[] }

export interface ConfigData {
  videoCodec: string;
  width: number;
  height: number;
  framerate: number;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
}

export interface StageStateData {
  publisherId?: string;
  publisherName?: string;
  config?: ConfigData | null;
  /** Privacy panic state. It rides the stage handshake (and therefore
   *  `welcome`), so a client joining mid-blank renders the card before any
   *  media could arrive — there is none, the relay evicted its GOP cache. */
  blanked?: boolean;
  /** Overall room phase: "lobby" when no publisher, "live" when someone is.
   *  Rides `welcome` so a late joiner never guesses. */
  phase?: "lobby" | "live";
}

/** Welcome payload: stage state plus the server-assigned id of this client. */
export interface WelcomeData extends StageStateData {
  selfId?: string;
}

export interface Participant {
  userId: string;
  username: string;
}

export interface RoomStateData {
  participants: Participant[];
}

export interface MediaChunk {
  kind: number;
  keyframe: boolean;
  /** SVC temporal layer id; 0 = base layer. */
  temporalId: number;
  sequence: number;
  timestamp: number; // microseconds
  payload: Uint8Array;
}

export function packMedia(
  kind: number,
  keyframe: boolean,
  temporalId: number,
  sequence: number,
  timestamp: number,
  payload: Uint8Array,
): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_SIZE + payload.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, kind);
  view.setUint8(1, keyframe ? FLAG_KEYFRAME : 0);
  view.setUint8(2, temporalId & 0xff);
  view.setUint16(3, sequence & 0xffff, false);
  view.setBigUint64(5, BigInt(Math.round(timestamp)), false);
  new Uint8Array(buf, HEADER_SIZE).set(payload);
  return buf;
}

export function unpackMedia(buf: ArrayBuffer): MediaChunk | null {
  if (buf.byteLength < HEADER_SIZE) return null;
  const view = new DataView(buf);
  return {
    kind: view.getUint8(0),
    keyframe: (view.getUint8(1) & FLAG_KEYFRAME) !== 0,
    temporalId: view.getUint8(2),
    sequence: view.getUint16(3, false),
    timestamp: Number(view.getBigUint64(5, false)),
    payload: new Uint8Array(buf, HEADER_SIZE),
  };
}
