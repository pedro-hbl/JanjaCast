// WebSocket session with the relay server: joins the room, exposes stage /
// room state as Solid signals, forwards media chunks in both directions,
// reconnects automatically with backoff, and keeps a server-clock estimate
// from ping/pong probes (used for glass-to-glass latency).

import { createSignal } from "solid-js";
import { apiPath, type Identity } from "./discord";
import type {
  ConfigData,
  Control,
  RoomStateData,
  StageStateData,
  SyncData,
  WelcomeData,
} from "./protocol";

export type SessionStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "unauthorized"; // fatal: the server refused our credentials — no retry

export interface Credentials {
  accessToken?: string;
  shareToken?: string;
}

const PING_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 8_000;

export class Session {
  readonly status;
  readonly stage;
  readonly participants;

  private ws: WebSocket | null = null;
  private assignedId: string | null = null;
  private closedByUser = false;
  private reconnectAttempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private clockOffsets: number[] = []; // serverTime - localTime estimates

  private setStatus;
  private setStage;
  private setParticipants;

  /** Called for every incoming binary media message. */
  onMedia: ((buf: ArrayBuffer) => void) | null = null;
  /** Called for publisher clock-sync marks. */
  onSync: ((sync: SyncData) => void) | null = null;
  /** Called after a successful automatic reconnect (not the first open). */
  onReconnected: (() => void) | null = null;
  /** Publisher side: a viewer or the relay needs a keyframe right now. */
  onKeyframeRequest: (() => void) | null = null;
  /** Publisher side: someone took the stage from us (their display name). */
  onStageTaken: ((byName: string) => void) | null = null;
  /** Publisher side: relay congestion feedback (degraded/total viewers). */
  onRateHint: ((degraded: number, viewers: number) => void) | null = null;

  constructor(
    private identity: Identity,
    private creds: Credentials = {},
  ) {
    const [status, setStatus] = createSignal<SessionStatus>("connecting");
    const [stage, setStage] = createSignal<StageStateData>({});
    const [participants, setParticipants] = createSignal<RoomStateData>({
      participants: [],
    });
    this.status = status;
    this.setStatus = setStatus;
    this.stage = stage;
    this.setStage = setStage;
    this.participants = participants;
    this.setParticipants = setParticipants;
  }

  connect(): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}${apiPath("/ws")}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      const reconnected = this.reconnectAttempt > 0;
      this.reconnectAttempt = 0;
      this.sendControl("join", {
        room: this.identity.room,
        userId: this.identity.userId,
        username: this.identity.username,
        accessToken: this.creds.accessToken,
        shareToken: this.creds.shareToken,
      });
      this.setStatus("open");
      this.startPinging();
      if (reconnected) this.onReconnected?.();
    };
    ws.onclose = (ev) => this.handleClose(ev);
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        this.handleControl(JSON.parse(ev.data) as Control);
      } else {
        this.onMedia?.(ev.data as ArrayBuffer);
      }
    };
  }

  private handleClose(ev?: CloseEvent): void {
    this.stopPinging();
    if (this.closedByUser) {
      this.setStatus("closed");
      return;
    }
    // 1008 (policy violation) is the server refusing our credentials.
    // Retrying with the same credentials would loop forever.
    if (ev?.code === 1008) {
      this.setStatus("unauthorized");
      return;
    }
    this.setStatus("reconnecting");
    const delay = Math.min(
      500 * 2 ** this.reconnectAttempt + Math.random() * 250,
      MAX_BACKOFF_MS,
    );
    this.reconnectAttempt++;
    setTimeout(() => {
      if (!this.closedByUser) this.connect();
    }, delay);
  }

  close(): void {
    this.closedByUser = true;
    this.stopPinging();
    this.ws?.close();
  }

  // --- clock sync -----------------------------------------------------------

  private startPinging(): void {
    this.stopPinging();
    const ping = () => this.sendControl("ping", { t: performance.now() });
    ping();
    setTimeout(ping, 500); // a couple of quick early samples
    setTimeout(ping, 1500);
    this.pingTimer = setInterval(ping, PING_INTERVAL_MS);
  }

  private stopPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** Current estimate of the server's wall clock, in Unix milliseconds. */
  serverNow(): number {
    if (this.clockOffsets.length === 0) return Date.now();
    const sorted = [...this.clockOffsets].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    return performance.now() + median;
  }

  // --- outbound -------------------------------------------------------------

  takeStage(): void {
    this.sendControl("take_stage", {});
  }

  leaveStage(): void {
    this.sendControl("leave_stage", {});
  }

  announceConfig(cfg: ConfigData): void {
    this.sendControl("config", cfg);
  }

  sendSync(sync: SyncData): void {
    this.sendControl("sync", sync);
  }

  requestKeyframe(): void {
    this.sendControl("keyframe_request", {});
  }

  sendMedia(buf: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf);
  }

  /** Bytes queued but not yet handed to the network — backpressure signal. */
  bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  /** The server-assigned id of this connection (authoritative after auth). */
  selfId(): string {
    return this.assignedId ?? this.identity.userId;
  }

  isPublisher(): boolean {
    const pid = this.stage().publisherId;
    return pid != null && pid === this.selfId();
  }

  /** True when this user holds the stage on ANY of their connections —
   *  their Activity view or their ":tab" companion capture tab. */
  ownsStage(): boolean {
    const pid = this.stage().publisherId;
    if (!pid) return false;
    const strip = (id: string) => (id.endsWith(":tab") ? id.slice(0, -4) : id);
    return strip(pid) === strip(this.selfId());
  }

  private sendControl(type: Control["type"], data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data }));
    }
  }

  // --- inbound --------------------------------------------------------------

  private handleControl(ctrl: Control): void {
    switch (ctrl.type) {
      case "welcome": {
        const welcome = (ctrl.data ?? {}) as WelcomeData;
        if (welcome.selfId) this.assignedId = welcome.selfId;
        this.setStage(welcome);
        break;
      }
      case "stage_state":
        this.setStage((ctrl.data ?? {}) as StageStateData);
        break;
      case "room_state":
        this.setParticipants((ctrl.data ?? { participants: [] }) as RoomStateData);
        break;
      case "pong": {
        const { t, serverTime } = ctrl.data as { t: number; serverTime: number };
        const rtt = performance.now() - t;
        // offset maps performance.now() -> server Unix ms
        this.clockOffsets.push(serverTime + rtt / 2 - performance.now());
        if (this.clockOffsets.length > 7) this.clockOffsets.shift();
        break;
      }
      case "sync":
        this.onSync?.(ctrl.data as SyncData);
        break;
      case "keyframe_request":
        this.onKeyframeRequest?.();
        break;
      case "rate_hint": {
        const { degraded, viewers } = ctrl.data as {
          degraded: number;
          viewers: number;
        };
        this.onRateHint?.(degraded ?? 0, viewers ?? 0);
        break;
      }
      case "stage_taken": {
        const { byName } = ctrl.data as { byName: string };
        this.onStageTaken?.(byName ?? "someone");
        break;
      }
      case "token_refresh": {
        // Fresh share token so reconnects keep working past token expiry.
        const { shareToken } = ctrl.data as { shareToken: string };
        if (shareToken) this.creds.shareToken = shareToken;
        break;
      }
      case "error":
        console.error("server error:", ctrl.data);
        break;
    }
  }
}
