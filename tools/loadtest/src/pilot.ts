import WebSocket from 'ws';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import {
  dequantiseCoord,
  ServerMessageSchema,
  type ServerMessage,
  type SiteId,
} from '@warehouse/protocol';
import { computeSteeringControls } from './steering.js';
import { extractOrdersFromWire } from './bot.js';

export const PILOT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_PILOT_BUDGET_USD = 1.5;

// Gemini 3.5 Flash-Lite approximate token pricing for budget tracking ($0.075 / 1M in, $0.30 / 1M out)
const COST_PER_INPUT_TOKEN_USD = 0.075 / 1_000_000;
const COST_PER_OUTPUT_TOKEN_USD = 0.3 / 1_000_000;

export const PilotPlanSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('deliverOrder'),
    orderId: z.union([z.string(), z.number()]).transform(String),
    pickupX: z.number(),
    pickupY: z.number(),
    dropX: z.number(),
    dropY: z.number(),
    reason: z.string(),
  }),
  z.object({
    action: z.literal('keepCards'),
    cardIds: z.array(z.string()).min(1).max(3),
    reason: z.string(),
  }),
  z.object({
    action: z.literal('typeOrder'),
    text: z.string().min(1).max(160),
    reason: z.string(),
  }),
  z.object({
    action: z.literal('vote'),
    level: z.enum(['easy', 'normal', 'hard']),
    reason: z.string(),
  }),
]);

export type PilotPlan = z.infer<typeof PilotPlanSchema>;

export const PILOT_PLAN_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    action: {
      type: 'STRING',
      enum: ['deliverOrder', 'keepCards', 'typeOrder', 'vote'],
    },
    orderId: { type: 'STRING' },
    pickupX: { type: 'NUMBER' },
    pickupY: { type: 'NUMBER' },
    dropX: { type: 'NUMBER' },
    dropY: { type: 'NUMBER' },
    cardIds: {
      type: 'ARRAY',
      items: { type: 'STRING' },
    },
    text: { type: 'STRING' },
    level: {
      type: 'STRING',
      enum: ['easy', 'normal', 'hard'],
    },
    reason: { type: 'STRING' },
  },
  required: ['action', 'reason'],
};

export interface PilotHudContext {
  pilotName: string;
  siteId: string;
  vehicle: {
    id: string;
    x: number;
    y: number;
    battery: number;
    cargoCount: number;
    guide?: {
      kind?: string;
      x?: number;
      y?: number;
    };
  };
  topOpenOrders: Array<{
    id: string | number;
    pickupX: number;
    pickupY: number;
    dropX: number;
    dropY: number;
    value: number;
    p0: boolean;
  }>;
  dealtCards: string[];
  difficulty: string;
  stats: {
    shipped: number;
    backlog: number;
  };
}

export interface PilotModelResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export interface PilotModelClient {
  generatePlan(hud: PilotHudContext): Promise<PilotModelResponse>;
}

export class VertexPilotModelClient implements PilotModelClient {
  private readonly ai: GoogleGenAI;
  public readonly model: string;

  constructor(opts?: { projectId?: string; location?: string; model?: string }) {
    const project = opts?.projectId ?? process.env.GCP_PROJECT_ID ?? 'davenporter-freightfloor';
    const location = opts?.location ?? process.env.GCP_LOCATION ?? 'global';
    this.model = opts?.model ?? PILOT_GEMINI_MODEL;
    this.ai = new GoogleGenAI({
      vertexai: true,
      project,
      location,
    });
  }

  public async generatePlan(hud: PilotHudContext): Promise<PilotModelResponse> {
    const systemInstruction =
      'You are an autonomous human-HUD warehouse pilot agent in Warehouse.\n' +
      'Choose one action from deliverOrder, keepCards, typeOrder, or vote based ONLY on the provided HUD JSON.\n' +
      'Always choose action "deliverOrder" whenever topOpenOrders is non-empty or vehicle.cargoCount > 0 so your forklift picks up and delivers freight. ' +
      'When action is "deliverOrder", you MUST include orderId, pickupX, pickupY, dropX, and dropY from topOpenOrders[0] (or vehicle.guide).';

    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await this.ai.models.generateContent({
          model: this.model,
          contents: JSON.stringify(hud),
          config: {
            systemInstruction,
            temperature: 0.2,
            maxOutputTokens: 384,
            responseMimeType: 'application/json',
            responseSchema: PILOT_PLAN_RESPONSE_SCHEMA,
            thinkingConfig: {
              thinkingBudget: 0,
            },
          },
        });

        const text = response.text ?? '';
        if (!text) {
          throw new Error(`Empty response from ${this.model} pilot planner`);
        }
        const tokensIn = response.usageMetadata?.promptTokenCount ?? 120;
        const tokensOut = response.usageMetadata?.candidatesTokenCount ?? 40;
        return { text, tokensIn, tokensOut };
      } catch (err) {
        lastErr = err;
        if (attempt < 3) {
          await new Promise((r) =>
            setTimeout(r, 250 * (attempt + 1) + Math.floor(Math.random() * 200)),
          );
        }
      }
    }
    throw lastErr;
  }
}

export class PilotBudgetTracker {
  public readonly maxBudgetUsd: number;
  private spentUsd = 0;
  private totalTokensIn = 0;
  private totalTokensOut = 0;

  constructor(maxBudgetUsd: number = DEFAULT_PILOT_BUDGET_USD) {
    this.maxBudgetUsd = maxBudgetUsd;
  }

  public canSpend(): boolean {
    return this.spentUsd < this.maxBudgetUsd;
  }

  public recordTokens(tokensIn: number, tokensOut: number): void {
    this.totalTokensIn += tokensIn;
    this.totalTokensOut += tokensOut;
    this.spentUsd +=
      tokensIn * COST_PER_INPUT_TOKEN_USD + tokensOut * COST_PER_OUTPUT_TOKEN_USD;
  }

  public getSpentUsd(): number {
    return Math.round(this.spentUsd * 10000) / 10000;
  }

  public getRemainingUsd(): number {
    return Math.max(0, Math.round((this.maxBudgetUsd - this.spentUsd) * 10000) / 10000);
  }
}

export interface PilotMetrics {
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
  planLatenciesMs: number[];
  plansSucceeded: number;
  pilotErrors: number;
  nlCommandsSent: number;
  nlCommandsRefused: number;
  nlCommandsExecuted: number;
  holdingPositionOnError: boolean;
  connectedAtMs: number;
  disconnectedAtMs: number;
}

export interface GeminiPilotOptions {
  pilotIndex: number;
  name?: string;
  clientId?: string;
  lobbyUrl: string;
  preferSiteId?: SiteId;
  inputIntervalMs?: number;
  planIntervalMs?: number;
  modelClient?: PilotModelClient;
  budgetTracker?: PilotBudgetTracker;
}

export class GeminiPilotAgent {
  public readonly name: string;
  public readonly clientId: string;
  private readonly lobbyUrl: string;
  private readonly preferSiteId?: SiteId;
  private readonly inputIntervalMs: number;
  private readonly planIntervalMs: number;
  private readonly modelClient: PilotModelClient;
  private readonly budgetTracker: PilotBudgetTracker;

  private ws: WebSocket | null = null;
  private inputTimer: ReturnType<typeof setInterval> | null = null;
  private planTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private planningInFlight = false;
  private seq = 0;
  private stuckTicks = 0;
  private lastInteractAtMs = 0;
  private sentInputAtMs = new Map<number, number>();

  private currentPlan: PilotPlan | null = null;
  private holdingOnError = false;

  private vehicle: {
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
  } | null = null;

  private openOrders: ReturnType<typeof extractOrdersFromWire> = [];
  private dealtCards: string[] = [];
  private difficulty = 'normal';

  public readonly metrics: PilotMetrics;

  constructor(opts: GeminiPilotOptions) {
    const padded = String(opts.pilotIndex).padStart(2, '0');
    this.name = opts.name ?? `pilot-${padded}`;
    this.clientId =
      opts.clientId ?? `${this.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.lobbyUrl = opts.lobbyUrl.replace(/\/$/, '');
    this.preferSiteId = opts.preferSiteId;
    this.inputIntervalMs = opts.inputIntervalMs ?? 100;
    this.planIntervalMs = opts.planIntervalMs ?? 3500;
    this.modelClient = opts.modelClient ?? new VertexPilotModelClient();
    this.budgetTracker = opts.budgetTracker ?? new PilotBudgetTracker();

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
      planLatenciesMs: [],
      plansSucceeded: 0,
      pilotErrors: 0,
      nlCommandsSent: 0,
      nlCommandsRefused: 0,
      nlCommandsExecuted: 0,
      holdingPositionOnError: false,
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
      throw new Error(`GeminiPilotAgent ${this.name} join failed (${joinRes.status}): ${txt}`);
    }

    const joinBody = (await joinRes.json()) as {
      siteId: SiteId;
      wsUrl: string;
      ticket: string;
    };

    this.metrics.siteId = joinBody.siteId;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(joinBody.wsUrl);
      this.ws = ws;
      let welcomed = false;

      const timeout = setTimeout(() => {
        if (!welcomed) {
          ws.terminate();
          reject(new Error(`GeminiPilotAgent ${this.name} timed out waiting for welcome`));
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
            // Request initial plan immediately, then start periodic replanning + 10Hz steering
            void this.requestPlanFromGemini();
            this.startLoops();
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
        } else if (msg.type === 'commandEcho') {
          if (msg.executed) {
            this.metrics.nlCommandsExecuted++;
          } else {
            this.metrics.nlCommandsRefused++;
          }
        }
      });

      ws.on('close', () => {
        this.metrics.disconnectedAtMs = Date.now();
        if (this.planTimer) {
          clearInterval(this.planTimer);
          this.planTimer = null;
        }
        if (this.inputTimer) {
          clearInterval(this.inputTimer);
          this.inputTimer = null;
        }
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
    if (typeof snap.difficulty === 'string') {
      this.difficulty = snap.difficulty;
    }
    if (Array.isArray(snap.vehicles) && this.metrics.vehicleId) {
      const found = snap.vehicles.find(
        (v: unknown) =>
          v && typeof v === 'object' && (v as { id?: string }).id === this.metrics.vehicleId
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
    if (typeof delta.difficulty === 'string') {
      this.difficulty = delta.difficulty;
    }
    if (delta.hands && typeof delta.hands === 'object' && this.metrics.vehicleId) {
      const handsRec = delta.hands as Record<string, unknown>;
      const myHand = handsRec[this.metrics.vehicleId] ?? handsRec[this.clientId];
      if (Array.isArray(myHand)) {
        this.dealtCards = myHand
          .map((c: unknown) =>
            typeof c === 'string'
              ? c
              : c && typeof c === 'object' && typeof (c as { id?: string }).id === 'string'
                ? (c as { id: string }).id
                : ''
          )
          .filter(Boolean);
      }
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
        ? (rec.guide as NonNullable<typeof this.vehicle>['guide'])
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

    if (prevCargoCount > 0 && cargoCount === 0 && this.currentPlan?.action === 'deliverOrder') {
      this.currentPlan = null;
      void this.requestPlanFromGemini();
    }
  }

  /**
   * Requests a structured JSON plan from Gemini 3.8 Flash.
   * STRICT NO-MOCK DIRECTIVE: If the Gemini call fails or budget is exhausted,
   * the pilot holds position (`holdingOnError = true`, `currentPlan = null`) and
   * increments `pilotErrors++` — it NEVER falls back to rule-based play.
   */
  public async requestPlanFromGemini(): Promise<void> {
    if (this.stopping || this.planningInFlight || !this.vehicle) return;

    if (!this.budgetTracker.canSpend()) {
      this.holdingOnError = true;
      this.currentPlan = null;
      this.metrics.pilotErrors++;
      this.metrics.holdingPositionOnError = true;
      return;
    }

    this.planningInFlight = true;
    const t0 = Date.now();
    try {
      const vx = this.vehicle.x;
      const vy = this.vehicle.y;
      const gx = this.vehicle.guide?.x;
      const gy = this.vehicle.guide?.y;
      const sortedOrders = this.openOrders.slice().sort((a, b) => {
        const aGuideBonus = gx === a.pickupX && gy === a.pickupY ? -100 : 0;
        const bGuideBonus = gx === b.pickupX && gy === b.pickupY ? -100 : 0;
        const da = Math.hypot(a.pickupX - vx, a.pickupY - vy) + aGuideBonus;
        const db = Math.hypot(b.pickupX - vx, b.pickupY - vy) + bGuideBonus;
        return da - db;
      });

      const hud: PilotHudContext = {
        pilotName: this.name,
        siteId: this.metrics.siteId,
        vehicle: {
          id: this.vehicle.id,
          x: Math.round(this.vehicle.x * 10) / 10,
          y: Math.round(this.vehicle.y * 10) / 10,
          battery: Math.round(this.vehicle.battery),
          cargoCount: this.vehicle.cargoCount,
          guide: this.vehicle.guide
            ? {
                kind: this.vehicle.guide.kind,
                x: this.vehicle.guide.x,
                y: this.vehicle.guide.y,
              }
            : undefined,
        },
        topOpenOrders: sortedOrders.slice(0, 5),
        dealtCards: this.dealtCards.slice(0, 3),
        difficulty: this.difficulty,
        stats: {
          shipped: this.metrics.deliveries,
          backlog: this.openOrders.length,
        },
      };

      const res = await this.modelClient.generatePlan(hud);
      const latencyMs = Math.max(1, Date.now() - t0);
      this.metrics.planLatenciesMs.push(latencyMs);
      this.budgetTracker.recordTokens(res.tokensIn, res.tokensOut);

      const parsedJson = JSON.parse(res.text) as Record<string, unknown>;
      if (parsedJson && parsedJson.action === 'deliverOrder') {
        const matchedOrder =
          sortedOrders.find(
            (o) => String(o.id) === String(parsedJson.orderId ?? ''),
          ) ?? sortedOrders[0];
        if (parsedJson.orderId === undefined || parsedJson.orderId === null) {
          parsedJson.orderId = String(matchedOrder?.id ?? '1');
        }
        if (typeof parsedJson.pickupX !== 'number') {
          parsedJson.pickupX =
            matchedOrder?.pickupX ?? this.vehicle.guide?.x ?? 6;
        }
        if (typeof parsedJson.pickupY !== 'number') {
          parsedJson.pickupY =
            matchedOrder?.pickupY ?? this.vehicle.guide?.y ?? 6;
        }
        if (typeof parsedJson.dropX !== 'number') {
          parsedJson.dropX =
            matchedOrder?.dropX ?? this.vehicle.guide?.x ?? 58;
        }
        if (typeof parsedJson.dropY !== 'number') {
          parsedJson.dropY =
            matchedOrder?.dropY ?? this.vehicle.guide?.y ?? 15;
        }
      }
      const validated = PilotPlanSchema.parse(parsedJson);

      this.holdingOnError = false;
      this.metrics.holdingPositionOnError = false;
      this.currentPlan = validated;
      this.metrics.plansSucceeded++;

      // Execute non-driving immediate WS actions if selected by Gemini
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (validated.action === 'keepCards') {
          this.ws.send(JSON.stringify({ type: 'keepCards', ids: validated.cardIds }));
        } else if (validated.action === 'typeOrder') {
          this.metrics.nlCommandsSent++;
          this.ws.send(JSON.stringify({ type: 'nlCommand', text: validated.text }));
        } else if (validated.action === 'vote') {
          this.ws.send(JSON.stringify({ type: 'voteDifficulty', level: validated.level }));
        }
      }
    } catch {
      // STRICT NO-MOCK DIRECTIVE: Hold position and increment pilotErrors++.
      // Never fall back to scripted or rule-based target selection.
      this.holdingOnError = true;
      this.currentPlan = null;
      this.metrics.pilotErrors++;
      this.metrics.holdingPositionOnError = true;
    } finally {
      this.planningInFlight = false;
    }
  }

  private startLoops(): void {
    if (this.planTimer) clearInterval(this.planTimer);
    this.planTimer = setInterval(() => {
      if (this.currentPlan?.action === 'deliverOrder') {
        const cargoCount = this.vehicle?.cargoCount ?? 0;
        if (cargoCount > 0) {
          return;
        }
        const planOrderId = String(this.currentPlan.orderId);
        const stillOpen = this.openOrders.some((o) => String(o.id) === planOrderId);
        const matchGuide =
          this.vehicle?.guide?.kind === 'pick' &&
          this.vehicle.guide.x === this.currentPlan.pickupX &&
          this.vehicle.guide.y === this.currentPlan.pickupY;
        if (stillOpen || matchGuide) {
          return;
        }
      }
      void this.requestPlanFromGemini();
    }, this.planIntervalMs);

    if (this.inputTimer) clearInterval(this.inputTimer);
    this.inputTimer = setInterval(() => {
      if (this.stopping || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (!this.vehicle || !this.metrics.vehicleId) return;

      // If Gemini call errored, budget ran out, or non-driving action is active, hold position & send keepalive input!
      if (this.holdingOnError || !this.currentPlan || this.currentPlan.action !== 'deliverOrder') {
        const seq = ++this.seq;
        this.sentInputAtMs.set(seq, Date.now());
        this.ws.send(
          JSON.stringify({
            type: 'input',
            up: false,
            down: false,
            left: false,
            right: false,
            seq,
          })
        );
        this.metrics.inputsSent++;
        return;
      }

      // Carry out Gemini's deliverOrder plan via local 10 Hz steering + interact
      const plan = this.currentPlan;
      const planOrderOpen = this.openOrders.some((o) => String(o.id) === String(plan.orderId));
      const targetX =
        this.vehicle.cargoCount > 0
          ? this.vehicle.guide?.kind === 'drop' && typeof this.vehicle.guide.x === 'number'
            ? this.vehicle.guide.x
            : plan.dropX
          : planOrderOpen
            ? plan.pickupX
            : this.vehicle.guide?.kind === 'pick' && typeof this.vehicle.guide.x === 'number'
              ? this.vehicle.guide.x
              : plan.pickupX;
      const targetY =
        this.vehicle.cargoCount > 0
          ? this.vehicle.guide?.kind === 'drop' && typeof this.vehicle.guide.y === 'number'
            ? this.vehicle.guide.y
            : plan.dropY
          : planOrderOpen
            ? plan.pickupY
            : this.vehicle.guide?.kind === 'pick' && typeof this.vehicle.guide.y === 'number'
              ? this.vehicle.guide.y
              : plan.pickupY;

      const { controls, distance, nextStuckTicks } = computeSteeringControls({
        vx: this.vehicle.x,
        vy: this.vehicle.y,
        angle: this.vehicle.angle,
        speedNow: this.vehicle.speedNow,
        targetX,
        targetY,
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
    if (this.planTimer) {
      clearInterval(this.planTimer);
      this.planTimer = null;
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
