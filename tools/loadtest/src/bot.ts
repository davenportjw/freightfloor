import WebSocket from 'ws';
import {
  dequantiseCoord,
  ServerMessageSchema,
  type ServerMessage,
  type SiteId,
} from '@warehouse/protocol';
import { computeSteeringControls } from './steering.js';

export interface ProtocolBotOptions {
  botIndex: number;
  name?: string;
  clientId?: string;
  lobbyUrl: string;
  preferSiteId?: SiteId;
  inputIntervalMs?: number;
}

export interface BotMetrics {
  name: string;
  clientId: string;
  siteId: string;
  vehicleId: string | null;
  role: 'driver' | 'spectator';
  ackRttsMs: number[];
  deltaBytes: number;
  deltaCount: number;
  inputsSent: number;
  interactsSent: number;
  deliveries: number;
  points: number;
  unexpectedDisconnects: number;
  connectedAtMs: number;
  disconnectedAtMs: number;
}

interface HudVehicleState {
  id: string;
  x: number;
  y: number;
  angle: number;
  speedNow: number;
  battery: number;
  cargoCount: number;
  inRange: boolean;
  sShipped: number;
  sPts: number;
  guide?: {
    kind?: string;
    x?: number;
    y?: number;
    inRange?: boolean;
  };
}

interface HudOrderSummary {
  id: string | number;
  pickupX: number;
  pickupY: number;
  dropX: number;
  dropY: number;
  value: number;
  p0: boolean;
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

export function extractOrdersFromWire(rawOrders: unknown): HudOrderSummary[] {
  if (!Array.isArray(rawOrders)) return [];
  const out: HudOrderSummary[] = [];
  for (const o of rawOrders) {
    if (!o || typeof o !== 'object') continue;
    const rec = o as Record<string, unknown>;
    if (rec.state && rec.state !== 'open') continue;
    const slot = rec.slot as Record<string, unknown> | undefined;
    const px =
      typeof slot?.ax === 'number'
        ? slot.ax
        : typeof rec.pickupX === 'number'
          ? rec.pickupX
          : 6;
    const py =
      typeof slot?.ay === 'number'
        ? slot.ay
        : typeof rec.pickupY === 'number'
          ? rec.pickupY
          : 6;
    const bayId = typeof rec.bay === 'string' ? rec.bay : typeof rec.drop === 'string' ? rec.drop : 'E1';
    const bay = BAY_COORDS[bayId] ?? { x: 58, y: 15 };
    out.push({
      id: (rec.id as string | number) ?? '1',
      pickupX: px,
      pickupY: py,
      dropX: bay.x,
      dropY: bay.y,
      value: typeof rec.value === 'number' ? rec.value : 50,
      p0: Boolean(rec.p0),
    });
  }
  return out;
}

export class ProtocolBot {
  public readonly name: string;
  public readonly clientId: string;
  private readonly botIndex: number;
  private readonly lobbyUrl: string;
  private readonly preferSiteId?: SiteId;
  private readonly inputIntervalMs: number;

  private ws: WebSocket | null = null;
  private inputTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private seq = 0;
  private stuckTicks = 0;
  private lastInteractAtMs = 0;
  private sentInputAtMs = new Map<number, number>();
  private vehicle: HudVehicleState | null = null;
  private openOrders: HudOrderSummary[] = [];

  public readonly metrics: BotMetrics;

  constructor(opts: ProtocolBotOptions) {
    this.botIndex = opts.botIndex;
    const padded = String(opts.botIndex).padStart(3, '0');
    this.name = opts.name ?? `loadtest-${padded}`;
    this.clientId = opts.clientId ?? `${this.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.lobbyUrl = opts.lobbyUrl.replace(/\/$/, '');
    this.preferSiteId = opts.preferSiteId;
    this.inputIntervalMs = opts.inputIntervalMs ?? 100;

    this.metrics = {
      name: this.name,
      clientId: this.clientId,
      siteId: '',
      vehicleId: null,
      role: 'spectator',
      ackRttsMs: [],
      deltaBytes: 0,
      deltaCount: 0,
      inputsSent: 0,
      interactsSent: 0,
      deliveries: 0,
      points: 0,
      unexpectedDisconnects: 0,
      connectedAtMs: 0,
      disconnectedAtMs: 0,
    };
  }

  public async start(): Promise<void> {
    this.stopping = false;
    const joinRes = await fetch(`${this.lobbyUrl}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: this.name,
        clientId: this.clientId,
        ...(this.preferSiteId ? { prefer: this.preferSiteId } : {}),
      }),
    });

    if (joinRes.status !== 200) {
      const txt = await joinRes.text();
      throw new Error(`ProtocolBot ${this.name} join failed (${joinRes.status}): ${txt}`);
    }

    const joinBody = (await joinRes.json()) as {
      siteId: SiteId;
      wsUrl: string;
      ticket: string;
      role?: 'driver' | 'spectator';
    };

    this.metrics.siteId = joinBody.siteId;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(joinBody.wsUrl);
      this.ws = ws;
      let welcomed = false;

      const timeout = setTimeout(() => {
        if (!welcomed) {
          ws.terminate();
          reject(new Error(`ProtocolBot ${this.name} timed out waiting for welcome`));
        }
      }, 8000);

      ws.on('open', () => {
        this.metrics.connectedAtMs = Date.now();
        ws.send(JSON.stringify({ type: 'hello', ticket: joinBody.ticket }));
      });

      ws.on('message', (raw) => {
        const byteLen = Buffer.isBuffer(raw)
          ? raw.byteLength
          : ArrayBuffer.isView(raw)
            ? raw.byteLength
            : Buffer.byteLength(raw.toString());

        let msg: ServerMessage;
        try {
          const parsedJson = JSON.parse(raw.toString()) as ServerMessage;
          if (!parsedJson || typeof parsedJson !== 'object' || typeof parsedJson.type !== 'string') {
            return;
          }
          msg = parsedJson;
        } catch {
          return;
        }

        if (msg.type === 'welcome') {
          this.metrics.vehicleId = msg.you.vid;
          this.metrics.role = msg.you.vid ? 'driver' : 'spectator';
          this.ingestSnapshot(msg.snapshot);
          if (!welcomed) {
            welcomed = true;
            clearTimeout(timeout);
            this.startSteeringLoop();
            resolve();
          }
        } else if (msg.type === 'delta') {
          const quantisedBytes =
            msg.vehicles.length * 10 + (Array.isArray(msg.events) ? msg.events.length * 12 : 0);
          this.metrics.deltaBytes += quantisedBytes > 0 ? quantisedBytes : byteLen;
          this.metrics.deltaCount++;
          this.ingestDelta(msg);
        } else if (msg.type === 'ack') {
          const sentAt = this.sentInputAtMs.get(msg.seq);
          if (sentAt !== undefined) {
            this.metrics.ackRttsMs.push(Math.max(0, Date.now() - sentAt));
            this.sentInputAtMs.delete(msg.seq);
          }
          if (this.vehicle) {
            if (typeof msg.x === 'number') this.vehicle.x = msg.x;
            if (typeof msg.y === 'number') this.vehicle.y = msg.y;
            if (typeof msg.angle === 'number') this.vehicle.angle = msg.angle;
            if (typeof msg.speedNow === 'number') this.vehicle.speedNow = msg.speedNow;
          }
        }
      });

      ws.on('close', () => {
        if (this.inputTimer) {
          clearInterval(this.inputTimer);
          this.inputTimer = null;
        }
        this.metrics.disconnectedAtMs = Date.now();
        if (!this.stopping && welcomed) {
          void this.start().catch(() => {
            this.metrics.unexpectedDisconnects++;
          });
        }
      });

      ws.on('error', (err) => {
        if (!welcomed) {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  private ingestSnapshot(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== 'object') return;
    const snap = snapshot as Record<string, unknown>;
    this.openOrders = extractOrdersFromWire(snap.orders);
    if (Array.isArray(snap.vehicles) && this.metrics.vehicleId) {
      const found = snap.vehicles.find(
        (v: unknown) => v && typeof v === 'object' && (v as { id?: string }).id === this.metrics.vehicleId
      ) as Record<string, unknown> | undefined;
      if (found) {
        this.updateVehicleFromRecord(found);
      }
    }
  }

  private ingestDelta(delta: Extract<ServerMessage, { type: 'delta' }>): void {
    if (delta.orders) {
      this.openOrders = extractOrdersFromWire(delta.orders);
    }
    if (this.metrics.vehicleId) {
      const found = delta.vehicles.find((v) => v.id === this.metrics.vehicleId) as
        | Record<string, unknown>
        | undefined;
      if (found) {
        this.updateVehicleFromRecord(found);
      }
    }
  }

  private updateVehicleFromRecord(rec: Record<string, unknown>): void {
    const x =
      typeof rec.px === 'number'
        ? rec.px
        : typeof rec.qx === 'number'
          ? dequantiseCoord(rec.qx)
          : this.vehicle?.x ?? 4.5;
    const y =
      typeof rec.py === 'number'
        ? rec.py
        : typeof rec.qy === 'number'
          ? dequantiseCoord(rec.qy)
          : this.vehicle?.y ?? 20.5;
    const angle = typeof rec.angle === 'number' ? rec.angle : this.vehicle?.angle ?? 0;
    const speedNow = typeof rec.speedNow === 'number' ? rec.speedNow : this.vehicle?.speedNow ?? 0;
    const battery = typeof rec.battery === 'number' ? rec.battery : this.vehicle?.battery ?? 100;
    const cargoCount =
      typeof rec.cargoCount === 'number'
        ? rec.cargoCount
        : Array.isArray(rec.cargo)
          ? rec.cargo.length
          : 0;
    const inRange = Boolean(rec.inRange);
    const sShipped = typeof rec.sShipped === 'number' ? rec.sShipped : this.metrics.deliveries;
    const sPts = typeof rec.sPts === 'number' ? rec.sPts : this.metrics.points;
    const prevCargoCount = this.vehicle?.cargoCount ?? 0;
    const guide =
      rec.guide && typeof rec.guide === 'object'
        ? (rec.guide as HudVehicleState['guide'])
        : rec.guide === null || cargoCount !== prevCargoCount
          ? undefined
          : this.vehicle?.guide;

    this.metrics.deliveries = Math.max(this.metrics.deliveries, sShipped);
    this.metrics.points = Math.max(this.metrics.points, sPts);

    this.vehicle = {
      id: this.metrics.vehicleId!,
      x,
      y,
      angle,
      speedNow,
      battery,
      cargoCount,
      inRange,
      sShipped,
      sPts,
      guide,
    };
  }

  private pickTarget(): { x: number; y: number } {
    const v = this.vehicle;
    if (!v) return { x: 10, y: 11 };

    // Use server HUD guide when present
    if (v.guide && typeof v.guide.x === 'number' && typeof v.guide.y === 'number') {
      return { x: v.guide.x, y: v.guide.y };
    }

    if (v.cargoCount > 0) {
      return { x: 58, y: 15 };
    }

    // Partition open orders across bots so all 28 bots don't crowd the same order
    if (this.openOrders.length > 0) {
      const sorted = this.openOrders
        .slice()
        .sort(
          (a, b) =>
            Math.hypot(a.pickupX - v.x, a.pickupY - v.y) -
            Math.hypot(b.pickupX - v.x, b.pickupY - v.y),
        );
      const chosen = sorted[(this.botIndex - 1) % Math.min(8, sorted.length)];
      if (chosen) {
        return { x: chosen.pickupX, y: chosen.pickupY };
      }
    }

    return { x: 15, y: 11 };
  }

  private startSteeringLoop(): void {
    if (this.inputTimer) clearInterval(this.inputTimer);
    this.inputTimer = setInterval(() => {
      if (this.stopping || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (!this.vehicle || !this.metrics.vehicleId) return;

      const target = this.pickTarget();
      const { controls, distance, nextStuckTicks } = computeSteeringControls({
        vx: this.vehicle.x,
        vy: this.vehicle.y,
        angle: this.vehicle.angle,
        speedNow: this.vehicle.speedNow,
        targetX: target.x,
        targetY: target.y,
        stuckTicks: this.stuckTicks,
      });
      this.stuckTicks = nextStuckTicks;

      const now = Date.now();
      const seq = ++this.seq;
      this.sentInputAtMs.set(seq, now);
      this.ws.send(
        JSON.stringify({
          type: 'input',
          up: controls.up,
          down: controls.down,
          left: controls.left,
          right: controls.right,
          seq,
        })
      );
      this.metrics.inputsSent++;

      if (
        (this.vehicle.inRange || this.vehicle.guide?.inRange || distance <= 1.6) &&
        now - this.lastInteractAtMs >= 300
      ) {
        this.lastInteractAtMs = now;
        this.ws.send(JSON.stringify({ type: 'interact' }));
        this.metrics.interactsSent++;
      }
    }, this.inputIntervalMs);
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (!this.metrics.disconnectedAtMs) {
      this.metrics.disconnectedAtMs = Date.now();
    }
    if (this.inputTimer) {
      clearInterval(this.inputTimer);
      this.inputTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            ws.terminate();
            resolve();
          }, 40);
          ws.once('close', () => {
            clearTimeout(t);
            resolve();
          });
          ws.close();
        });
      }
    }
  }
}
