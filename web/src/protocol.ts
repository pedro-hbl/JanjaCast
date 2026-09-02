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
  | "error";

/** The privacy panic button. `blank` is publisher→relay, `blank_state` is
 *  relay→everyone; one shape both ways. `on` is never omitted — an
 *  un-blank that serialized to `{}` could never lift the blank. */
export interface BlankData {
  on: boolean;
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
