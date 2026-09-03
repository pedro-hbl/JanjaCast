// WebSocket session with the relay server: joins the room, exposes stage /
// room state as Solid signals, forwards media chunks in both directions,
// reconnects automatically with backoff, and keeps a server-clock estimate
// from ping/pong probes (used for glass-to-glass latency).

import { createSignal } from "solid-js";
import { apiPath, type Identity } from "./discord";
import type {
  BlankData,
  ConfigData,
  Control,
  RoomStateData,
  StageCancelData,
  StageMode,
  StageQueueData,
  StageStateData,
  StageTurnData,
  StingerData,
  SyncData,
  WelcomeData,
} from "./protocol";

export type SessionStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "unauthorized" // fatal: the server refused our credentials — no retry
  | "superseded"; // fatal: this identity joined from a newer session

export interface Credentials {
  accessToken?: string;
  shareToken?: string;
}

const PING_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 8_000;

/** The stage queue as the client holds it. Mirrors the server's one-message
 *  state broadcast: the line, the mode, and the rodízio clock together. */
const EMPTY_QUEUE: StageQueueData = {
  queue: [],
  mode: "livre",
  turnLenMs: 20 * 60 * 1000,
};

export class Session {
  readonly status;
  readonly stage;
  readonly participants;
  /** Who is in line, what mode the room is in, and the rodízio clock. */
  readonly queue;
  /** Cinema: paused flag and shared strokes. */
  readonly cinemaPaused;
  readonly cinemaStrokes;

  private ws: WebSocket | null = null;
  private assignedId: string | null = null;
  private closedByUser = false;
  private reconnectAttempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private earlyPings: ReturnType<typeof setTimeout>[] = [];
  private clockOffsets: number[] = []; // serverTime - localTime estimates

  private setStatus;
  private setStage;
  private setParticipants;
  private setQueue;
  private setCinemaPaused;
  private setCinemaStrokes;

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
  /** This identity joined from a newer session; this one is done. */
  onSuperseded: (() => void) | null = null;
  /** A stream started or stopped: play the server-chosen stinger. */
  onStinger: ((s: StingerData) => void) | null = null;
  /** Somebody was called to the stage — "é tua!". The whole room gets this,
   *  so it is a cue plus a prompt, not a private notification. */
  onStageTurn: ((turn: StageTurnData) => void) | null = null;
  /** Unicast heads-up: YOUR turn is being prepared — warm the companion
   *  flow before the public stage_turn lands. */
  onStageWarmup: ((d: { userId: string; username: string }) => void) | null = null;
  /** The pending turn ended, with the reason it did. */
  onStageCancel: ((cancel: StageCancelData) => void) | null = null;
  /** The server refused something we asked for, with a code to translate. */
  onServerError: ((code: string) => void) | null = null;
  /** A caption line landed under the video band. */
  onCaptionBroadcast: ((d: { text: string; author: string }) => void) | null = null;
  /** Captions toggled on/off (publisher-gated). */
  onCaptionState: ((enabled: boolean) => void) | null = null;
  /** Publisher left: wipe the caption band. */
  onCaptionClear: (() => void) | null = null;
  /** The jukebox line changed. */
  onJukeboxQueue: ((d: { queue: Array<{ id: string; asset: string; requester: string }> }) => void) | null = null;
  /** Host approved a sound: the whole room plays it. */
  onJukeboxPlay: ((d: { id: string; asset: string }) => void) | null = null;
  /** Placar state broadcast. */
  onPlacarState: ((d: { active: boolean; prompt: string; scores: Record<string, number> }) => void) | null = null;
  /** A clip is ready to download. */
  onClipReady: ((d: { url: string; expiresMs: number }) => void) | null = null;
  /** A 90s replay is cut and waiting: fetch /clip/{token} and its
   *  /events.json sidecar while the 2min TTL lasts. */
  onReplayReady: ((d: { token: string; expiresMs: number }) => void) | null = null;
  /** Publisher side: a viewer pointed at the screen — draw the arrow. */
  onAssistShow: ((d: { x: number; y: number; userId: string; username: string; ttlMs: number }) => void) | null = null;
  /** Corrente: nomination banner lifecycle. */
  /** Publisher side: how many of the room are actually looking. */
  onAttentionState: ((d: { watching: number; total: number }) => void) | null = null;
  /** A side-bet changed phase — the whole room is the witness bench. */
  onApostaState: ((d: { id: string; phase: string; text: string; challengerId: string; challengerName: string; targetId: string; targetName: string; winnerId?: string; wins?: Record<string, number> }) => void) | null = null;
  onCorrenteStarted: ((d: { target: string; targetName: string; by: string; endsAtMs: number }) => void) | null = null;
  onCorrenteTally: ((d: { vai: number; calma: number }) => void) | null = null;
  onCorrenteCanceled: ((d: { reason: string }) => void) | null = null;

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
    const [queue, setQueue] = createSignal<StageQueueData>(EMPTY_QUEUE);
    this.queue = queue;
    this.setQueue = setQueue;
    const [cinemaPaused, setCinemaPaused] = createSignal(false);
    const [cinemaStrokes, setCinemaStrokes] = createSignal<import('./protocol').StrokeData[]>([]);
    this.cinemaPaused = cinemaPaused;
    this.cinemaStrokes = cinemaStrokes;
    this.setCinemaPaused = setCinemaPaused;
    this.setCinemaStrokes = setCinemaStrokes;
  }

  connect(): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}${apiPath("/ws")}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      const reconnected = this.reconnectAttempt > 0;
      // The attempt counter resets on "welcome" (a *successful* join), not
      // here — a server that accepts the socket and closes immediately
      // would otherwise loop at the minimum backoff forever.
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
    // 4001 backs up the in-band superseded control at the transport level:
    // a newer session for this identity exists; reconnecting would kick it.
    if (ev?.code === 4001) {
      this.closedByUser = true;
      this.setStatus("superseded");
      this.onSuperseded?.();
      return;
    }
    this.setStatus("reconnecting");
    // FULL jitter (AWS style): delay = rand(0, min(cap, base*2^n)). When the
    // tunnel blinks, every client in the room loses the socket in the SAME
    // instant — additive jitter of 250ms still marched the whole room back
    // in near-lockstep and hammered the relay as one thundering herd. Full
    // jitter spreads the rejoin across the entire window.
    const ceiling = Math.min(500 * 2 ** this.reconnectAttempt, MAX_BACKOFF_MS);
    const delay = Math.random() * ceiling;
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
    this.earlyPings = [setTimeout(ping, 500), setTimeout(ping, 1500)];
    this.pingTimer = setInterval(ping, PING_INTERVAL_MS);
  }

  private stopPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const t of this.earlyPings) clearTimeout(t);
    this.earlyPings = [];
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

  // Cinema controls
  pauseCinema(): void { this.sendControl("cinema_pause" as any, {}); }
  resumeCinema(): void { this.sendControl("cinema_resume" as any, {}); }
  sendCinemaStroke(d: import('./protocol').CinemaStrokeData): void { this.sendControl("cinema_stroke" as any, d); }

  // Instant clip: viewer requests the relay to cut the last ~30s.
  requestClip(): void { this.sendControl("clip_request" as any, {}); }

  /** "Quem entrou?" — ask the relay to cut the last ~90s plus the room's
   *  event timeline. Answered with replay_ready. */
  requestReplay(seconds = 90): void { this.sendControl("replay_request" as any, { seconds }); }

  /** Viewer side: point at a spot on the picture (normalized 0..1). */
  sendAssistPoint(x: number, y: number): void { this.sendControl("assist_point" as any, { x, y }); }
  submitCaption(text: string): void { this.sendControl("caption_submit" as any, { text }); }
  toggleCaptions(enabled: boolean): void { this.sendControl("caption_toggle" as any, { enabled }); }
  requestJukebox(id: string, asset: string): void { this.sendControl("jukebox_request" as any, { id, asset }); }
  approveJukebox(id: string): void { this.sendControl("jukebox_approve" as any, { id }); }
  /** Multistream: name the chairs this viewer wants media from. */
  /** Open the room's extra chairs (multistream). */
  setSlotsMax(max: number): void { this.sendControl("slots_max" as any, { max }); }
  subscribeSlots(slots: number[]): void { this.sendControl("subscribe" as any, { slots }); }
  unsubscribeSlots(slots: number[]): void { this.sendControl("unsubscribe" as any, { slots }); }
  reportAttention(visible: boolean): void { this.sendControl("attention_report" as any, { visible }); }
  challengeAposta(target: string, text: string): void { this.sendControl("aposta_challenge" as any, { target, text }); }
  answerAposta(id: string, accept: boolean): void { this.sendControl((accept ? "aposta_accept" : "aposta_decline") as any, { id }); }
  judgeAposta(id: string, winner: "challenger" | "target"): void { this.sendControl("aposta_judge" as any, { id, winner }); }
  nominateCorrente(target: string): void { this.sendControl("corrente_nominate" as any, { target }); }
  voteCorrente(choice: "vai" | "calma"): void { this.sendControl("corrente_vote" as any, { choice }); }

  /** Local-only undo: hide this client's most recent stroke. There is no
   *  cinema_undo on the wire, so a later full `cinema_state` (pause/resume)
   *  may bring it back for a moment — resume clears everything anyway. */
  undoOwnCinemaStroke(): void {
    const me = this.selfId();
    this.setCinemaStrokes((xs) => {
      for (let i = xs.length - 1; i >= 0; i--) {
        if (xs[i]!.userId === me) return [...xs.slice(0, i), ...xs.slice(i + 1)];
      }
      return xs;
    });
  }

  /** Publisher side: engage or lift the privacy blank for the whole room.
   *  The relay honors it from the current publisher only, and answers with
   *  a `blank_state` to everybody. This is the *relay's* gate — the encoder
   *  has its own, applied first (see capture.ts). */
  setBlank(on: boolean): void {
    this.sendControl("blank", { on });
  }

  /** Whether the room is currently hidden behind the "back in a sec" card. */
  blanked(): boolean {
    return this.stage().blanked === true;
  }

  /** Fire a stinger at the whole room. Names are asset base names (not
   *  URLs); omit both and the server picks a random enabled pair. The server
   *  validates the names and applies a ~3s per-client cooldown, so a rejected
   *  trigger is silent by design — there is nothing useful to retry. */
  playStinger(opts: { image?: string; audio?: string; random?: boolean } = {}): void {
    this.sendControl("stinger_play", opts);
  }

  // --- the stage queue ------------------------------------------------------
  // Every one of these is fire-and-forget: the server answers with the whole
  // queue state, so the client never optimistically edits its own copy and
  // the two can therefore never disagree. A refusal the sender can act on
  // arrives as an error code; the rest are silent by design (a duplicate
  // "pedir a vez" has nothing useful to report).

  /** "Pedir a vez" — join the line. */
  requestStage(): void {
    this.sendControl("stage_request", {});
  }

  /** "Sair da fila" — leave it again. */
  withdrawStage(): void {
    this.sendControl("stage_withdraw", {});
  }

  /** "Passar a vez" — publisher only: call the next person and step off. */
  passStage(): void {
    this.sendControl("stage_pass", {});
  }

  /** Publisher only: spend the one +5 minutes of this rodízio turn. */
  extendStage(): void {
    this.sendControl("stage_extend", {});
  }

  /** Flip the room between livre and rodízio. Room-wide, any member. */
  setStageMode(mode: StageMode): void {
    this.sendControl("stage_mode", { mode });
  }

  /** True when this person is the one currently being called to the stage —
   *  which is also what lets the Share button skip the takeover confirm. */
  hasTurn(): boolean {
    const id = this.queue().turnUserId;
    if (!id) return false;
    const strip = (v: string) => (v.endsWith(":tab") ? v.slice(0, -4) : v);
    return strip(id) === strip(this.selfId());
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
        this.reconnectAttempt = 0; // join actually succeeded
        const welcome = (ctrl.data ?? {}) as WelcomeData;
        if (welcome.selfId) this.assignedId = welcome.selfId;
        this.setStage(welcome);
        break;
      }
      case "superseded":
        // This identity joined from a newer session; retrying from here
        // would kick that session in an endless fight. Terminal.
        this.closedByUser = true;
        this.setStatus("superseded");
        this.onSuperseded?.();
        this.ws?.close();
        break;
      case "stage_state":
        this.setStage((ctrl.data ?? {}) as StageStateData);
        break;
      case "room_phase": {
        const d = (ctrl.data ?? { phase: "lobby" }) as import('./protocol').RoomPhaseData;
        this.setStage((s) => ({ ...s, phase: d.phase }));
        break;
      }
      case "cinema_state": {
        const d = (ctrl.data ?? { paused: false, strokes: [] }) as import('./protocol').CinemaStateData;
        this.setCinemaPaused(!!d.paused);
        this.setCinemaStrokes(d.strokes ?? []);
        break;
      }
      case "cinema_stroke_add": {
        const s = ctrl.data as import('./protocol').StrokeData;
        this.setCinemaStrokes((xs) => (xs.find(x => x.strokeId === s.strokeId) ? xs : [...xs, s]));
        break;
      }
      case "blank_state": {
        // The live edge. `stage_state` also carries `blanked`, so this
        // merges rather than replaces — a blank must never wipe the
        // publisher or the codec config out of the stage signal.
        const { on } = (ctrl.data ?? { on: false }) as BlankData;
        this.setStage((s) => ({ ...s, blanked: on === true }));
        break;
      }
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
      case "clip_ready": {
        const d = ctrl.data as { url: string; expiresMs: number };
        if (d && typeof d.url === "string") this.onClipReady?.(d);
        break;
      }
      case "assist_show": {
        const d = ctrl.data as { x: number; y: number; userId: string; username: string; ttlMs: number };
        this.onAssistShow?.(d);
        break;
      }
      case "caption_broadcast": {
        const d = ctrl.data as { text: string; author: string };
        this.onCaptionBroadcast?.(d);
        break;
      }
      case "caption_state": {
        const d = ctrl.data as { enabled: boolean };
        this.onCaptionState?.(!!(d && d.enabled));
        break;
      }
      case "caption_clear": {
        this.onCaptionClear?.();
        break;
      }
      case "jukebox_queue_state": {
        this.onJukeboxQueue?.(ctrl.data as never);
        break;
      }
      case "jukebox_play": {
        this.onJukeboxPlay?.(ctrl.data as { id: string; asset: string });
        break;
      }
      case "attention_state": {
        this.onAttentionState?.(ctrl.data as { watching: number; total: number });
        break;
      }
      case "aposta_state": {
        this.onApostaState?.(ctrl.data as never);
        break;
      }
      case "corrente_started": {
        this.onCorrenteStarted?.(ctrl.data as { target: string; targetName: string; by: string; endsAtMs: number });
        break;
      }
      case "corrente_tally": {
        this.onCorrenteTally?.(ctrl.data as { vai: number; calma: number });
        break;
      }
      case "corrente_canceled": {
        this.onCorrenteCanceled?.(ctrl.data as { reason: string });
        break;
      }
      case "replay_ready": {
        const d = ctrl.data as { token: string; expiresMs: number };
        if (d && typeof d.token === "string") this.onReplayReady?.(d);
        break;
      }
      case "stage_taken": {
        const { byName } = ctrl.data as { byName: string };
        this.onStageTaken?.(byName ?? "someone");
        break;
      }
      case "stinger":
        this.onStinger?.(ctrl.data as StingerData);
        break;
      case "placar_state":
        this.onPlacarState?.(ctrl.data as any);
        break;
      case "stage_queue":
        // Whole-state replacement, never a merge: the server's copy is the
        // only copy, and a missing `queue` means an empty line.
        this.setQueue({
          ...EMPTY_QUEUE,
          ...(ctrl.data as StageQueueData),
          queue: (ctrl.data as StageQueueData)?.queue ?? [],
        });
        break;
      case "stage_warmup":
        this.onStageWarmup?.(ctrl.data as { userId: string; username: string });
        break;
      case "stage_turn":
        this.onStageTurn?.(ctrl.data as StageTurnData);
        break;
      case "stage_cancel":
        this.onStageCancel?.(ctrl.data as StageCancelData);
        break;
      case "token_refresh": {
        // Fresh share token so reconnects keep working past token expiry.
        const { shareToken } = ctrl.data as { shareToken: string };
        if (shareToken) this.creds.shareToken = shareToken;
        break;
      }
      case "awards_ready": {
        const d = ctrl.data as import('./protocol').AwardsReadyData;
        // Surface via a DOM event; App listens by overriding onServerError earlier.
        (window as any).dispatchEvent(new CustomEvent("awards_ready", { detail: d.sessionId }));
        break;
      }
      case "error": {
        // A `code` is a refusal the person can act on and gets translated
        // by the UI; a bare `message` is developer-facing English (see
        // docs/i18n.md) and belongs in the console.
        const { code } = (ctrl.data ?? {}) as { code?: string };
        if (code) this.onServerError?.(code);
        else console.error("server error:", ctrl.data);
        break;
      }
    }
  }
}
