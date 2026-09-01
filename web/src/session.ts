// WebSocket session with the relay server: joins the room, exposes stage /
// room state as Solid signals, and forwards media chunks in both directions.

import { createSignal } from "solid-js";
import { apiPath, type Identity } from "./discord";
import type {
  ConfigData,
  Control,
  RoomStateData,
  StageStateData,
} from "./protocol";

export type SessionStatus = "connecting" | "open" | "closed";

export class Session {
  readonly status;
  readonly stage;
  readonly participants;

  private ws: WebSocket | null = null;
  private setStatus;
  private setStage;
  private setParticipants;

  /** Called for every incoming binary media message. */
  onMedia: ((buf: ArrayBuffer) => void) | null = null;

  constructor(private identity: Identity) {
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
      this.sendControl("join", {
        room: this.identity.room,
        userId: this.identity.userId,
        username: this.identity.username,
      });
      this.setStatus("open");
    };
    ws.onclose = () => this.setStatus("closed");
    ws.onerror = () => this.setStatus("closed");
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        this.handleControl(JSON.parse(ev.data) as Control);
      } else {
        this.onMedia?.(ev.data as ArrayBuffer);
      }
    };
  }

  close(): void {
    this.ws?.close();
  }

  takeStage(): void {
    this.sendControl("take_stage", {});
  }

  leaveStage(): void {
    this.sendControl("leave_stage", {});
  }

  announceConfig(cfg: ConfigData): void {
    this.sendControl("config", cfg);
  }

  sendMedia(buf: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf);
  }

  /** Bytes queued but not yet handed to the network — backpressure signal. */
  bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  isPublisher(): boolean {
    return this.stage().publisherId === this.identity.userId;
  }

  private sendControl(type: Control["type"], data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data }));
    }
  }

  private handleControl(ctrl: Control): void {
    switch (ctrl.type) {
      case "welcome":
      case "stage_state":
        this.setStage((ctrl.data ?? {}) as StageStateData);
        break;
      case "room_state":
        this.setParticipants((ctrl.data ?? { participants: [] }) as RoomStateData);
        break;
      case "error":
        console.error("server error:", ctrl.data);
        break;
    }
  }
}
