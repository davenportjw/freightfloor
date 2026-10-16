/**
 * Lobby join + site WebSocket connection with exponential-backoff reconnect.
 *
 * The client is served by the lobby, so `/api/*` is same-origin (vite dev/preview proxy
 * `/api` to `VITE_LOBBY_URL`). Nothing here invents data: failures surface as status text.
 */
import type {
  ClientMessage,
  JoinResponse,
  NetworkResponse,
  ServerMessage,
  SiteId,
} from '@warehouse/protocol';

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 8_000;

export function backoffDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
}

/**
 * The lobby may hand out an internal `ws://localhost` URL in local setups; when the page is
 * not on localhost, route through the same-origin `/ws` proxy instead.
 */
export function resolveWsUrl(
  rawWsUrl: string,
  siteId: SiteId,
  loc: { hostname: string; host: string; protocol: string } | null,
): string {
  if (loc && rawWsUrl.startsWith('ws://localhost') && loc.hostname !== 'localhost') {
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${loc.host}/ws?site=${siteId}`;
  }
  return rawWsUrl;
}

export type NetStatus =
  | { kind: 'idle' }
  | { kind: 'joining' }
  | { kind: 'connecting'; siteId: SiteId }
  | { kind: 'open'; siteId: SiteId }
  | { kind: 'retrying'; inMs: number; reason: string };

export interface NetHandlers {
  onMessage(msg: ServerMessage): void;
  onStatus(status: NetStatus): void;
  /** Called once per successful lobby join (before the socket opens). */
  onJoined?(join: JoinResponse): void;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message || body.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export class NetClient {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private joining = false;
  private stopped = false;
  siteId: SiteId | null = null;

  constructor(
    private readonly identity: () => { name: string; clientId: string },
    private readonly handlers: NetHandlers,
  ) {}

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Join via the lobby (optionally preferring a site) and open the site socket. Throws on lobby failure. */
  async join(prefer?: SiteId): Promise<JoinResponse> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopped = false;
    this.joining = true;
    this.handlers.onStatus({ kind: 'joining' });
    try {
      const { name, clientId } = this.identity();
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, clientId, prefer: prefer ?? this.siteId ?? undefined }),
      });
      if (!res.ok) throw new Error(`Lobby join failed: ${await readError(res)}`);
      const join = (await res.json()) as JoinResponse;
      this.siteId = join.siteId;
      this.handlers.onJoined?.(join);
      this.open(join);
      return join;
    } finally {
      this.joining = false;
    }
  }

  /** join() with automatic retry/backoff; never throws. */
  async connect(prefer?: SiteId): Promise<void> {
    if (this.joining) return;
    try {
      await this.join(prefer);
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : String(err));
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.closeSocket();
    this.handlers.onStatus({ kind: 'idle' });
  }

  private closeSocket(): void {
    if (!this.ws) return;
    const old = this.ws;
    this.ws = null;
    old.onclose = null;
    old.onmessage = null;
    old.onerror = null;
    try {
      old.close();
    } catch {
      // already closed
    }
  }

  private open(join: JoinResponse): void {
    this.closeSocket();
    const loc = typeof window !== 'undefined' ? window.location : null;
    const socket = new WebSocket(resolveWsUrl(join.wsUrl, join.siteId, loc));
    this.ws = socket;
    this.handlers.onStatus({ kind: 'connecting', siteId: join.siteId });

    socket.onopen = () => {
      this.attempts = 0;
      socket.send(JSON.stringify({ type: 'hello', ticket: join.ticket } satisfies ClientMessage));
      this.handlers.onStatus({ kind: 'open', siteId: join.siteId });
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch (err) {
        console.error('Dropped malformed server frame', err);
        return;
      }
      this.handlers.onMessage(msg);
    };
    socket.onclose = (ev) => {
      if (this.ws !== socket) return;
      this.ws = null;
      if (!this.stopped) this.scheduleReconnect(`Socket closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`);
    };
    socket.onerror = () => {
      // onclose follows and schedules the reconnect.
    };
  }

  private scheduleReconnect(reason: string): void {
    if (this.timer || this.stopped) return;
    const delay = backoffDelay(this.attempts++);
    this.handlers.onStatus({ kind: 'retrying', inMs: delay, reason });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect(this.siteId ?? undefined);
    }, delay);
  }
}

export type NetworkFetch =
  | { ok: true; data: NetworkResponse }
  | { ok: false; error: string };

export async function fetchNetwork(): Promise<NetworkFetch> {
  try {
    const res = await fetch('/api/network');
    if (!res.ok) return { ok: false, error: `/api/network ${await readError(res)}` };
    const data = (await res.json()) as NetworkResponse;
    if (!data || !Array.isArray(data.sites) || !Array.isArray(data.leaderboard)) {
      return { ok: false, error: '/api/network returned an unexpected payload' };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
