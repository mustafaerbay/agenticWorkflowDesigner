import type { RunEvent, WsServerMessage } from "@/types";

export type WsStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface WsLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close: (code?: number, reason?: string) => void;
}

export interface LocationLike {
  protocol: string;
  host: string;
}

export interface ExecutionStreamOptions {
  runId: string;
  getToken: () => string | null;
  /** Start replay after this seq (defaults to 0 = full replay). */
  after?: number;
  onEvent: (event: RunEvent) => void;
  onStatus?: (status: WsStatus) => void;
  /** Injection points for tests. */
  socketFactory?: (url: string) => WsLike;
  location?: LocationLike;
  /** Base reconnect delay in ms (doubles every failed attempt). */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Close & reconnect if no message (event or ping) arrives within this window. */
  idleTimeoutMs?: number;
  random?: () => number;
}

/** Build a ws:// or wss:// URL for the execution stream from the page location. */
export function buildStreamUrl(loc: LocationLike, runId: string, token: string | null, after: number): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams();
  params.set("token", token ?? "");
  params.set("after", String(after));
  return `${proto}//${loc.host}/api/executions/${encodeURIComponent(runId)}/stream?${params.toString()}`;
}

export function backoffDelay(attempt: number, base: number, max: number, random: () => number = Math.random): number {
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt));
  // Full jitter in [exp/2, exp]
  return Math.round(exp / 2 + (random() * exp) / 2);
}

/**
 * WebSocket client for `/api/executions/{id}/stream`.
 * - tracks the highest `seq` seen and deduplicates replayed events
 * - reconnects with exponential backoff using `after=<lastSeq>`
 * - handles `{type:"event"}` and `{type:"ping"}` messages
 */
export class ExecutionStream {
  private readonly opts: ExecutionStreamOptions;
  private socket: WsLike | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private _lastSeq: number;
  private _status: WsStatus = "closed";

  constructor(opts: ExecutionStreamOptions) {
    this.opts = opts;
    this._lastSeq = opts.after ?? 0;
  }

  get lastSeq(): number {
    return this._lastSeq;
  }

  get status(): WsStatus {
    return this._status;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = null;
      s.onmessage = null;
      s.onclose = null;
      s.onerror = null;
      try {
        s.close(1000, "client closed");
      } catch {
        /* ignore */
      }
    }
    this.setStatus("closed");
  }

  /** Ensure we never go backwards; useful after a REST refetch reports last_event_seq. */
  bumpSeq(seq: number): void {
    if (seq > this._lastSeq) this._lastSeq = seq;
  }

  private setStatus(s: WsStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.opts.onStatus?.(s);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.reconnectTimer = null;
    this.idleTimer = null;
  }

  private armIdle(): void {
    const ms = this.opts.idleTimeoutMs ?? 50_000;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (ms <= 0) return;
    this.idleTimer = setTimeout(() => {
      // Server pings every 20s; silence means a dead connection.
      this.socket?.close(4000, "idle timeout");
    }, ms);
  }

  private connect(): void {
    if (this.stopped) return;
    const loc = this.opts.location ?? window.location;
    const url = buildStreamUrl(loc, this.opts.runId, this.opts.getToken(), this._lastSeq);
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const factory = this.opts.socketFactory ?? ((u: string) => new WebSocket(u) as unknown as WsLike);
    let socket: WsLike;
    try {
      socket = factory(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus("open");
      this.armIdle();
    };
    socket.onmessage = (ev) => {
      this.armIdle();
      this.handleMessage(ev.data);
    };
    socket.onerror = () => {
      /* onclose follows */
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      const code = (ev as { code?: number } | null)?.code;
      // 4401/4403/4404: auth or not-found — don't hammer the server.
      if (code === 4401 || code === 4403 || code === 4404 || code === 1008) {
        this.stopped = true;
        this.setStatus("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setStatus("reconnecting");
    const delay = backoffDelay(
      this.attempt,
      this.opts.baseDelayMs ?? 500,
      this.opts.maxDelayMs ?? 15_000,
      this.opts.random,
    );
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Exposed for tests. */
  handleMessage(raw: unknown): void {
    let msg: WsServerMessage;
    try {
      msg = (typeof raw === "string" ? JSON.parse(raw) : raw) as WsServerMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ping") return;
    if (msg.type === "event" && msg.event && typeof msg.event.seq === "number") {
      if (msg.event.seq <= this._lastSeq) return; // duplicate from replay
      this._lastSeq = msg.event.seq;
      this.opts.onEvent(msg.event);
    }
  }
}
