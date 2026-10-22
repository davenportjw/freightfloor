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
  QueueStatus,
  RunMode,
  ServerMessage,
  SiteId,
} from '@warehouse/protocol';
import { lobbyErrorMessage } from './resumeCode.js';

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 8_000;
/** A site socket still CONNECTING after this long is abandoned and retried with backoff (sized for Pattern A shard cold start). */
export const CONNECT_TIMEOUT_MS = 25_000;
/** Periodic lobby queue status poll interval while queued or holding a ready seat lease. */
export const QUEUE_POLL_MS = 3_000;

/** Reconnect jitter: each delay is scaled by a factor in [1 - J, 1 + J]. */
export const RECONNECT_JITTER = 0.3;
/** Minimum delay before retrying after a policy close (4003 auth rejected, 4008 site full). */
export const POLICY_CLOSE_RETRY_MS = 15_000;
/** Site close codes that must not be hammered with fast retries. */
export const SLOW_RETRY_CLOSE_CODES: ReadonlySet<number> = new Set([4003, 4008]);

/**
 * Exponential backoff with ±30% jitter so a fleet of clients dropped together does not reconnect
 * in lockstep. `rand` is injectable for deterministic tests.
 */
export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
  const factor = 1 - RECONNECT_JITTER + 2 * RECONNECT_JITTER * rand();
  return Math.round(base * factor);
}

/** Thrown by `join()` when a newer join superseded it; callers should ignore it silently. */
export class StaleJoinError extends Error {
  constructor() {
    super('Join superseded by a newer request');
    this.name = 'StaleJoinError';
  }
}

export function isStaleJoin(err: unknown): err is StaleJoinError {
  return err instanceof StaleJoinError;
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
  if (loc) {
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

export interface JoinOptions {
  requeue?: boolean;
  spectateOnly?: boolean;
  seatLeaseId?: string;
  freshSocket?: boolean;
  runMode?: RunMode;
  resume?: string;
}

export interface NetHandlers {
  onMessage(msg: ServerMessage): void;
  onStatus(status: NetStatus): void;
  /** Called once per successful lobby join (before the socket opens). */
  onJoined?(join: JoinResponse): void;
  /** Called whenever the lobby waiting-line status changes. */
  onQueueUpdate?(queue: QueueStatus | null): void;
  /** Called when a ready queue seat lease is claimed and connected as a driver. */
  onSeatClaimed?(join: JoinResponse): void;
  /**
   * A `/api/queue*` request failed (e.g. 503 `queue_unavailable`): the message to show, or null
   * once a queue request succeeds again. Polling keeps retrying; nothing is faked meanwhile.
   */
  onQueueError?(message: string | null): void;
}

async function readError(res: Response): Promise<string> {
  let body: { message?: string; error?: string } | null = null;
  try {
    body = (await res.json()) as { message?: string; error?: string };
  } catch {
    body = null;
  }
  return lobbyErrorMessage(res.status, body);
}

export class NetClient {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queuePollTimer: ReturnType<typeof setInterval> | null = null;
  private claimingSeat = false;
  private joining = false;
  private stopped = false;
  /** Monotonic join sequence: responses from a superseded join are dropped. */
  private joinSeq = 0;
  private joinAbort: AbortController | null = null;
  /** Site the current socket is connected to (distinct from `siteId`, the latest target site). */
  private socketSiteId: SiteId | null = null;
  /** Delay floor for the next reconnect (set by policy closes such as 4003/4008). */
  private nextRetryFloorMs = 0;
  siteId: SiteId | null = null;
  queue: QueueStatus | null = null;
  autoClaimSeat = true;

  constructor(
    private readonly identity: () => {
      name?: string;
      clientId: string;
      runMode?: RunMode;
      autoClaimSeat?: boolean;
    },
    private readonly handlers: NetHandlers,
  ) {}

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  private isAutoClaimEnabled(): boolean {
    const id = this.identity();
    if (typeof id.autoClaimSeat === 'boolean') return id.autoClaimSeat;
    return this.autoClaimSeat;
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /**
   * Join via the lobby (optionally preferring a site) and open the site socket. Throws on lobby failure.
   * `freshSocket` forces a new WebSocket even when one is already open to the same site: a
   * re-`hello` on a live socket only renames the session server-side, while a new connection runs
   * the full authenticate path (which replaces a finished run with a fresh vehicle).
   */
  async join(
    prefer?: SiteId,
    resumeOrOptions?: string | JoinOptions,
    runModeOverride?: RunMode,
    freshSocket = false,
    extraOptions?: JoinOptions,
  ): Promise<JoinResponse> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const opts: JoinOptions =
      typeof resumeOrOptions === 'object' && resumeOrOptions !== null
        ? { ...resumeOrOptions, ...(extraOptions ?? {}) }
        : { ...(extraOptions ?? {}) };
    const resume = typeof resumeOrOptions === 'string' ? resumeOrOptions : opts.resume;
    const effectiveFreshSocket = freshSocket || Boolean(opts.freshSocket) || Boolean(opts.requeue) || Boolean(opts.seatLeaseId);

    const seq = this.supersedeJoins();
    const abort = new AbortController();
    this.joinAbort = abort;
    this.stopped = false;
    this.joining = true;
    this.handlers.onStatus({ kind: 'joining' });
    try {
      const { name, clientId, runMode } = this.identity();
      const effectiveMode = runModeOverride ?? opts.runMode ?? runMode;
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          ...(name ? { name } : {}),
          prefer: prefer ?? this.siteId ?? undefined,
          ...(resume ? { resume } : {}),
          ...(effectiveMode ? { mode: effectiveMode, runMode: effectiveMode } : {}),
          ...(opts.requeue !== undefined ? { requeue: opts.requeue } : {}),
          ...(opts.spectateOnly !== undefined ? { spectateOnly: opts.spectateOnly } : {}),
          ...(opts.seatLeaseId ? { seatLeaseId: opts.seatLeaseId } : {}),
        }),
        signal: abort.signal,
      }).catch((err: unknown) => {
        if (seq !== this.joinSeq) throw new StaleJoinError();
        throw err;
      });
      if (seq !== this.joinSeq) throw new StaleJoinError();
      if (!res.ok) throw new Error(`Lobby join failed: ${await readError(res)}`);
      const join = (await res.json()) as JoinResponse;
      if (seq !== this.joinSeq) throw new StaleJoinError();
      this.siteId = join.siteId;
      this.applyQueueStatus(join.queue ?? null);
      this.handlers.onJoined?.(join);
      this.open(join, effectiveFreshSocket);
      if (this.queue?.state === 'ready' && this.isAutoClaimEnabled()) {
        void this.claimQueueSeat();
      }
      return join;
    } finally {
      if (seq === this.joinSeq) {
        this.joining = false;
        this.joinAbort = null;
      }
    }
  }

  /** Invalidate (and abort) any in-flight lobby join; returns the new sequence number. */
  private supersedeJoins(): number {
    this.joinAbort?.abort();
    this.joinAbort = null;
    this.joining = false;
    return ++this.joinSeq;
  }

  private applyQueueStatus(raw: QueueStatus | null | undefined): void {
    if (!raw || raw.state === 'none' || raw.state === 'claimed') {
      this.queue = null;
      this.stopQueuePolling();
      this.handlers.onQueueUpdate?.(null);
      return;
    }
    if (raw.state === 'expired') {
      this.queue = null;
      this.stopQueuePolling();
      this.handlers.onQueueUpdate?.(null);
      return;
    }
    this.queue = raw;
    this.handlers.onQueueUpdate?.(raw);
    if (raw.state === 'queued' || raw.state === 'ready') {
      this.startQueuePolling();
    } else {
      this.stopQueuePolling();
    }
  }

  private startQueuePolling(): void {
    if (this.queuePollTimer || this.stopped) return;
    this.queuePollTimer = setInterval(() => {
      void this.pollQueueStatus();
    }, QUEUE_POLL_MS);
  }

  private stopQueuePolling(): void {
    if (!this.queuePollTimer) return;
    clearInterval(this.queuePollTimer);
    this.queuePollTimer = null;
  }

  /** Poll `/api/queue/status` once and auto-claim when a seat lease becomes ready. */
  async pollQueueStatus(): Promise<QueueStatus | null> {
    const { clientId } = this.identity();
    try {
      const res = await fetch(`/api/queue/status?clientId=${encodeURIComponent(clientId)}`);
      if (!res.ok) {
        // e.g. 503 queue_unavailable: surface the real error; polling keeps retrying.
        this.handlers.onQueueError?.(await readError(res));
        return this.queue;
      }
      this.handlers.onQueueError?.(null);
      const body = (await res.json()) as QueueStatus | { queue?: QueueStatus };
      const status: QueueStatus | null =
        body && typeof body === 'object' && 'state' in body
          ? (body as QueueStatus)
          : (body as { queue?: QueueStatus })?.queue ?? null;
      this.applyQueueStatus(status);
      if (this.queue?.state === 'ready' && this.isAutoClaimEnabled()) {
        await this.claimQueueSeat();
      }
      return this.queue;
    } catch {
      return this.queue;
    }
  }

  /** Claim a ready seat lease (`POST /api/queue/claim`) and upgrade to driver. */
  async claimQueueSeat(): Promise<boolean> {
    const seatLeaseId = this.queue?.seatLeaseId;
    if (!seatLeaseId || this.claimingSeat) return false;
    this.claimingSeat = true;
    try {
      const { name, clientId, runMode } = this.identity();
      const targetSite = this.queue?.claimSiteId ?? this.queue?.assignedSiteId ?? this.siteId ?? undefined;
      const res = await fetch('/api/queue/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          seatLeaseId,
          ...(name ? { name } : {}),
          ...(runMode ? { runMode } : {}),
        }),
      });
      if (!res.ok) {
        this.handlers.onQueueError?.(await readError(res));
        return false;
      }
      this.handlers.onQueueError?.(null);
      const data = (await res.json()) as Partial<JoinResponse> & { ok?: boolean; seatLeaseId?: string };
      this.stopQueuePolling();
      this.queue = null;
      this.handlers.onQueueUpdate?.(null);

      if (data && typeof data.ticket === 'string' && typeof data.siteId === 'string' && typeof data.wsUrl === 'string') {
        const join = data as JoinResponse;
        this.supersedeJoins();
        this.siteId = join.siteId;
        this.handlers.onJoined?.(join);
        this.handlers.onSeatClaimed?.(join);
        this.open(join, true);
      } else {
        const join = await this.join(
          (data?.siteId as SiteId | undefined) ?? targetSite,
          undefined,
          runMode,
          true,
          { seatLeaseId },
        );
        this.handlers.onSeatClaimed?.(join);
      }
      return true;
    } catch {
      return false;
    } finally {
      this.claimingSeat = false;
    }
  }

  /** Leave the FIFO waiting line (`POST /api/queue/leave`) and remain a floor spectator. */
  async leaveQueue(): Promise<void> {
    const { clientId } = this.identity();
    this.stopQueuePolling();
    this.queue = null;
    this.handlers.onQueueUpdate?.(null);
    try {
      await fetch('/api/queue/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }),
      });
    } catch {
      // Ignore transient network errors when leaving queue
    }
  }

  /** Connect directly to a target shard using a pre-signed carry-over relocation ticket. */
  joinWithTicket(siteId: SiteId, ticket: string, expiresAt: number, wsUrl = `/ws?site=${siteId}`): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.supersedeJoins();
    this.stopped = false;
    this.siteId = siteId;
    const { name, clientId } = this.identity();
    const join: JoinResponse = {
      siteId,
      wsUrl,
      ticket,
      expiresAt,
      clientId,
      ...(name ? { name } : {}),
    };
    this.handlers.onJoined?.(join);
    // A relocation ticket must run the full authenticate path on a new connection.
    this.open(join, true);
  }

  /**
   * Resume a previous identity via the lobby (`resume` = the player's resume code, or a bare
   * callsign on the browser that already owns it) without dropping the active socket when the
   * lobby refuses it (404 `invalid_resume_code`, 503 `queue_unavailable`, …). On success the
   * caller adopts the returned `clientId`; a different identity gets a fresh socket.
   */
  async resumeIdentity(
    resumeCode: string,
  ): Promise<{ ok: true; name: string; clientId: string; resumeToken?: string } | { ok: false; message: string }> {
    const trimmed = resumeCode.trim();
    if (!trimmed) return { ok: false, message: 'Paste your resume code.' };
    const seq = this.supersedeJoins();
    try {
      const { clientId } = this.identity();
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          prefer: this.siteId ?? undefined,
          resume: trimmed,
        }),
      });
      if (!res.ok) {
        return { ok: false, message: await readError(res) };
      }
      const join = (await res.json()) as JoinResponse;
      if (seq !== this.joinSeq) return { ok: false, message: 'Superseded by a newer join' };
      this.siteId = join.siteId;
      this.applyQueueStatus(join.queue ?? null);
      this.handlers.onJoined?.(join);
      // A different identity must authenticate on a new connection (a re-hello only renames).
      this.open(join, Boolean(join.clientId && join.clientId !== clientId));
      return {
        ok: true,
        name: join.name ?? trimmed,
        clientId: join.clientId ?? clientId,
        ...(join.resumeToken ? { resumeToken: join.resumeToken } : {}),
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** join() with automatic retry/backoff; never throws. */
  async connect(prefer?: SiteId): Promise<void> {
    if (this.joining) return;
    try {
      await this.join(prefer);
    } catch (err) {
      if (isStaleJoin(err)) return;
      this.scheduleReconnect(err instanceof Error ? err.message : String(err));
    }
  }

  stop(): void {
    this.supersedeJoins();
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopQueuePolling();
    this.closeSocket();
    this.handlers.onStatus({ kind: 'idle' });
  }

  private closeSocket(): void {
    if (!this.ws) return;
    const old = this.ws;
    this.ws = null;
    this.socketSiteId = null;
    old.onopen = null;
    old.onclose = null;
    old.onmessage = null;
    old.onerror = null;
    try {
      old.close();
    } catch {
      // already closed
    }
  }

  private open(join: JoinResponse, freshSocket = false): void {
    // Compare against the site the live socket is actually connected to — `this.siteId` has
    // already been updated to the *new* target, so checking it would always re-hello on the old
    // shard and the player would never move.
    if (!freshSocket && this.isOpen && this.socketSiteId === join.siteId && this.ws) {
      this.send({ type: 'hello', ticket: join.ticket });
      return;
    }
    this.closeSocket();
    const loc = typeof window !== 'undefined' ? window.location : null;
    const socket = new WebSocket(resolveWsUrl(join.wsUrl, join.siteId, loc));
    this.ws = socket;
    this.socketSiteId = join.siteId;
    this.handlers.onStatus({ kind: 'connecting', siteId: join.siteId });
    // A handshake that never completes (no open, no close) would otherwise leave the client on
    // "Connecting…" indefinitely: abandon it and fall back to the backoff reconnect.
    const watchdog = setTimeout(() => {
      if (this.ws !== socket || socket.readyState !== WebSocket.CONNECTING) return;
      this.closeSocket();
      if (!this.stopped) this.scheduleReconnect(`Connecting to ${join.siteId.toUpperCase()} timed out`);
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      clearTimeout(watchdog);
      // Backoff `attempts` is reset only on the first `welcome` (see onmessage): a socket that
      // opens and is immediately closed (4003/4008) must keep backing off.
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
      if (msg && msg.type === 'welcome' && this.ws === socket) {
        this.attempts = 0;
        this.nextRetryFloorMs = 0;
      }
      this.handlers.onMessage(msg);
    };
    socket.onclose = (ev) => {
      clearTimeout(watchdog);
      if (this.ws !== socket) return;
      this.ws = null;
      this.socketSiteId = null;
      if (this.stopped) return;
      if (SLOW_RETRY_CLOSE_CODES.has(ev.code)) {
        // Policy close (auth rejected / site full): surface the server's reason and slow down.
        this.nextRetryFloorMs = POLICY_CLOSE_RETRY_MS;
        const label = ev.code === 4008 ? 'Site full' : 'Connection rejected';
        this.scheduleReconnect(`${label}${ev.reason ? `: ${ev.reason}` : ''} (${ev.code})`);
        return;
      }
      this.scheduleReconnect(`Socket closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`);
    };
    socket.onerror = () => {
      // onclose follows and schedules the reconnect.
    };
  }

  private scheduleReconnect(reason: string): void {
    if (this.timer || this.stopped) return;
    const delay = Math.max(this.nextRetryFloorMs, backoffDelay(this.attempts++));
    this.nextRetryFloorMs = 0;
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
