import WebSocket from 'ws';
import {
  AgentLeaderboardResponseSchema,
  AgentRegisterResponseSchema,
  JoinResponseSchema,
  ServerMessageSchema,
  dequantiseCoord,
  type AgentJoinRequest,
  type AgentLeaderboardResponse,
  type AgentRegisterRequest,
  type AgentRegisterResponse,
  type JoinResponse,
  type Phase,
  type RunMode,
  type ServerMessage,
  type SiteId,
} from '@warehouse/protocol';

export interface VehicleObservation {
  id: string;
  x: number;
  y: number;
  angle: number;
  speedNow: number;
  battery: number;
  cargoCount: number;
  inRange: boolean;
  shipped: number;
  points: number;
  guide?: {
    kind?: string;
    x?: number;
    y?: number;
  };
}

export interface OrderObservation {
  id: string | number;
  pickupX: number;
  pickupY: number;
  dropX: number;
  dropY: number;
  value: number;
  p0: boolean;
}

export interface FloorObservation {
  siteId: SiteId;
  tick: number;
  phase: Phase;
  self: VehicleObservation | null;
  orders: OrderObservation[];
  dealtCards: string[];
  stats: {
    shipped: number;
    backlog: number;
  };
}

export interface InputCommand {
  up?: boolean;
  down?: boolean;
  left?: boolean;
  right?: boolean;
  boost?: boolean;
  moveAngle?: number;
}

export interface AgentClientOptions {
  /** Public lobby origin, e.g. `https://freightfloor.com` or `http://127.0.0.1:8080`. */
  lobbyUrl: string;
  /** Personal bearer key (`ffa_...`) minted via `registerAgent()`. */
  apiKey: string;
  /** Optional preferred site shard. */
  prefer?: SiteId;
  /** Optional run mode (`blitz` default or `freerange`). */
  mode?: RunMode;
  /** Optional self-declared model/runtime label (e.g. `gemini-3.5-flash`, `rust-astar`). */
  model?: string;
  /** Override WS URL (useful in local tests). */
  wsUrlOverride?: string;
  /** Connect timeout in ms (default 10_000). */
  connectTimeoutMs?: number;
  /** Optional hook for every validated server message. */
  onMessage?: (msg: ServerMessage) => void;
  /** Optional hook for server error frames (`type: 'error'`). */
  onErrorFrame?: (err: { code: string; message: string }) => void;
  /** Optional hook when socket closes. */
  onClose?: (code: number, reason: string) => void;
}

const BAY_COORDS: Record<string, { x: number; y: number }> = {
  E1: { x: 58, y: 6 },
  E2: { x: 58, y: 9 },
  E3: { x: 58, y: 15 },
  E4: { x: 58, y: 18 },
  E5: { x: 58, y: 24 },
  E6: { x: 58, y: 27 },
  E7: { x: 58, y: 33 },
  E8: { x: 58, y: 36 },
  E9: { x: 58, y: 47 },
  E10: { x: 58, y: 50 },
  E11: { x: 58, y: 56 },
  E12: { x: 58, y: 59 },
  E13: { x: 58, y: 65 },
  E14: { x: 58, y: 68 },
  E15: { x: 58, y: 74 },
  E16: { x: 58, y: 77 },
  E17: { x: 58, y: 83 },
  E18: { x: 58, y: 86 },
  E19: { x: 58, y: 92 },
  E20: { x: 58, y: 95 },
};

export function extractOrdersFromWire(rawOrders: unknown): OrderObservation[] {
  if (!Array.isArray(rawOrders)) return [];
  const out: OrderObservation[] = [];
  for (const item of rawOrders) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (o.state === 'done' || o.state === 'cancelled') continue;
    const id = (o.id ?? o.orderId) as string | number | undefined;
    if (id === undefined) continue;
    const pickup = o.pickup as { x?: number; y?: number } | undefined;
    const drop = o.drop as { x?: number; y?: number } | undefined;
    const pickupX =
      typeof o.px === 'number'
        ? o.px
        : typeof o.pickupX === 'number'
          ? o.pickupX
          : typeof pickup?.x === 'number'
            ? pickup.x
            : 10;
    const pickupY =
      typeof o.py === 'number'
        ? o.py
        : typeof o.pickupY === 'number'
          ? o.pickupY
          : typeof pickup?.y === 'number'
            ? pickup.y
            : 20;
    const bayCoords = typeof o.bay === 'string' ? BAY_COORDS[o.bay] : undefined;
    const dropX =
      typeof o.dx === 'number'
        ? o.dx
        : typeof o.dropX === 'number'
          ? o.dropX
          : typeof drop?.x === 'number'
            ? drop.x
            : bayCoords?.x ?? 58;
    const dropY =
      typeof o.dy === 'number'
        ? o.dy
        : typeof o.dropY === 'number'
          ? o.dropY
          : typeof drop?.y === 'number'
            ? drop.y
            : bayCoords?.y ?? 24;
    const value = typeof o.value === 'number' ? o.value : 50;
    const p0 = o.priority === 'P0' || o.p0 === true;
    out.push({ id, pickupX, pickupY, dropX, dropY, value, p0 });
  }
  return out;
}

/** Register a new BYO external forklift agent and mint a one-time bearer API key (`ffa_...`). */
export async function registerAgent(
  lobbyUrl: string,
  req: AgentRegisterRequest,
): Promise<AgentRegisterResponse> {
  const base = lobbyUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/api/agents/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/agents/register failed (${res.status}): ${text}`);
  }
  return AgentRegisterResponseSchema.parse(await res.json());
}

/** Request a short-lived signed WebSocket driver ticket for a registered external agent. */
export async function joinAgent(
  lobbyUrl: string,
  apiKey: string,
  req: AgentJoinRequest = {},
): Promise<JoinResponse> {
  const base = lobbyUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/api/agents/join`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/agents/join failed (${res.status}): ${text}`);
  }
  return JoinResponseSchema.parse(await res.json());
}

/** Fetch the public Agent League leaderboard (BYO external agents only). */
export async function getAgentLeaderboard(lobbyUrl: string): Promise<AgentLeaderboardResponse> {
  const base = lobbyUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/api/agents/leaderboard`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /api/agents/leaderboard failed (${res.status}): ${text}`);
  }
  return AgentLeaderboardResponseSchema.parse(await res.json());
}

/**
 * Typed WebSocket client for driving a Freight Floor forklift as a BYO external agent.
 * Handles `/api/agents/join`, `hello` handshake, quantized delta decoding, and clean actions.
 */
export class FreightFloorAgentClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private joinInfo: JoinResponse | null = null;
  private vehicleId: string | null = null;
  private self: VehicleObservation | null = null;
  private orders: OrderObservation[] = [];
  private dealtCards: string[] = [];
  private phase: Phase = 'running';
  private tick = 0;
  private shipped = 0;
  private backlog = 0;

  constructor(private readonly opts: AgentClientOptions) {}

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get session(): JoinResponse | null {
    return this.joinInfo;
  }

  getObservation(): FloorObservation | null {
    if (!this.joinInfo) return null;
    return {
      siteId: this.joinInfo.siteId,
      tick: this.tick,
      phase: this.phase,
      self: this.self ? { ...this.self, guide: this.self.guide ? { ...this.self.guide } : undefined } : null,
      orders: this.orders.map((o) => ({ ...o })),
      dealtCards: [...this.dealtCards],
      stats: {
        shipped: this.shipped,
        backlog: this.backlog,
      },
    };
  }

  async connect(): Promise<JoinResponse> {
    const joined = await joinAgent(this.opts.lobbyUrl, this.opts.apiKey, {
      ...(this.opts.prefer ? { prefer: this.opts.prefer } : {}),
      ...(this.opts.mode ? { mode: this.opts.mode } : {}),
      ...(this.opts.model ? { model: this.opts.model } : {}),
    });
    this.joinInfo = joined;
    const wsUrl = this.opts.wsUrlOverride ?? joined.wsUrl;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      let welcomed = false;
      const timeout = setTimeout(() => {
        if (!welcomed) {
          ws.close();
          reject(new Error('Timed out waiting for welcome message from Freight Floor site'));
        }
      }, this.opts.connectTimeoutMs ?? 10_000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', ticket: joined.ticket }));
      });

      ws.on('message', (raw) => {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw.toString());
        } catch {
          return;
        }
        const parsed = ServerMessageSchema.safeParse(parsedJson);
        if (!parsed.success) return;
        const msg = parsed.data;
        this.opts.onMessage?.(msg);

        if (msg.type === 'welcome') {
          this.vehicleId = msg.you.vid ?? null;
          if (msg.snapshot) {
            this.ingestSnapshot(msg.snapshot);
          }
          if (!welcomed) {
            welcomed = true;
            clearTimeout(timeout);
            resolve();
          }
          return;
        }

        if (msg.type === 'error') {
          this.opts.onErrorFrame?.({ code: msg.code, message: msg.message });
          if (!welcomed) {
            clearTimeout(timeout);
            reject(new Error(`Site rejected connection (${msg.code}): ${msg.message}`));
          }
          return;
        }

        if (msg.type === 'delta') {
          this.ingestDelta(msg);
        } else if (msg.type === 'phase') {
          this.phase = msg.phase;
        } else if (msg.type === 'ack' && this.self) {
          if (typeof msg.x === 'number') this.self.x = msg.x;
          if (typeof msg.y === 'number') this.self.y = msg.y;
          if (typeof msg.angle === 'number') this.self.angle = msg.angle;
          if (typeof msg.speedNow === 'number') this.self.speedNow = msg.speedNow;
        }
      });

      ws.on('error', (err) => {
        if (!welcomed) {
          clearTimeout(timeout);
          reject(err);
        }
      });

      ws.on('close', (code, reasonBuf) => {
        this.ws = null;
        this.opts.onClose?.(code, reasonBuf.toString());
      });
    });

    return joined;
  }

  sendRaw(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  sendInput(cmd: InputCommand): void {
    this.seq += 1;
    this.sendRaw({
      type: 'input',
      seq: this.seq,
      up: Boolean(cmd.up),
      down: Boolean(cmd.down),
      left: Boolean(cmd.left),
      right: Boolean(cmd.right),
      boost: Boolean(cmd.boost),
      ...(typeof cmd.moveAngle === 'number' ? { moveAngle: cmd.moveAngle } : {}),
    });
  }

  interact(): void {
    this.sendRaw({ type: 'interact' });
  }

  chooseOrder(orderId: number): void {
    this.sendRaw({ type: 'chooseOrder', orderId });
  }

  keepCards(ids: string[]): void {
    this.sendRaw({ type: 'keepCards', ids });
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close(1000, 'Agent shutdown');
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }
  }

  private ingestSnapshot(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== 'object') return;
    const snap = snapshot as Record<string, unknown>;
    if (typeof snap.phase === 'string') {
      this.phase = snap.phase as Phase;
    }
    this.orders = extractOrdersFromWire(snap.orders);
    this.backlog = this.orders.length;
    if (Array.isArray(snap.vehicles) && this.vehicleId) {
      const found = snap.vehicles.find(
        (v: unknown) => v && typeof v === 'object' && (v as { id?: string }).id === this.vehicleId,
      ) as Record<string, unknown> | undefined;
      if (found) this.updateSelfFromRecord(found);
    }
  }

  private ingestDelta(delta: Extract<ServerMessage, { type: 'delta' }>): void {
    this.tick = delta.t;
    if (delta.stats) {
      if (typeof delta.stats.shipped === 'number') this.shipped = delta.stats.shipped;
      if (typeof delta.stats.backlog === 'number') this.backlog = delta.stats.backlog;
    }
    if (delta.orders) {
      this.orders = extractOrdersFromWire(delta.orders);
    }
    if (this.vehicleId) {
      const found = delta.vehicles.find((v) => v.id === this.vehicleId) as
        | Record<string, unknown>
        | undefined;
      if (found) this.updateSelfFromRecord(found);
    }
    if (delta.hands) {
      const firstHand = Object.values(delta.hands)[0];
      if (firstHand?.cards) {
        this.dealtCards = firstHand.cards
          .filter((c) => c.status === 'offer')
          .map((c) => c.id);
      }
    }
  }

  private updateSelfFromRecord(rec: Record<string, unknown>): void {
    const x =
      typeof rec.px === 'number'
        ? rec.px
        : typeof rec.qx === 'number'
          ? dequantiseCoord(rec.qx)
          : this.self?.x ?? 4.5;
    const y =
      typeof rec.py === 'number'
        ? rec.py
        : typeof rec.qy === 'number'
          ? dequantiseCoord(rec.qy)
          : this.self?.y ?? 20.5;
    const angle = typeof rec.angle === 'number' ? rec.angle : this.self?.angle ?? 0;
    const speedNow = typeof rec.speedNow === 'number' ? rec.speedNow : this.self?.speedNow ?? 0;
    const battery = typeof rec.battery === 'number' ? rec.battery : this.self?.battery ?? 100;
    const cargoCount =
      typeof rec.cargoCount === 'number'
        ? rec.cargoCount
        : Array.isArray(rec.cargo)
          ? rec.cargo.length
          : 0;
    const inRange = Boolean(rec.inRange);
    const shipped = typeof rec.sShipped === 'number' ? rec.sShipped : this.self?.shipped ?? 0;
    const points = typeof rec.sPts === 'number' ? rec.sPts : this.self?.points ?? 0;
    const prevCargoCount = this.self?.cargoCount ?? 0;
    const guide =
      rec.guide && typeof rec.guide === 'object'
        ? (rec.guide as VehicleObservation['guide'])
        : rec.guide === null || cargoCount !== prevCargoCount
          ? undefined
          : this.self?.guide;

    this.self = {
      id: this.vehicleId!,
      x,
      y,
      angle,
      speedNow,
      battery,
      cargoCount,
      inRange,
      shipped,
      points,
      guide,
    };
  }
}
