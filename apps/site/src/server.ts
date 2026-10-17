import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  ClientMessageSchema,
  MAX_WS_FRAME_BYTES,
  PROXY_HEADER_NAME,
  SITE_IDS,
  TransferSchema,
  signTicket,
  verifyProxyHeader,
  verifyTicket,
  quantiseCoord,
  MAX_PATH_WAYPOINTS,
  HEAT_MIN_VALUE,
  HEAT_INTERVAL_MS,
  BOARD_INTERVAL_MS,
  type SiteId,
  type ServerMessage,
  type DeltaMessage,
  type DeltaStats,
  type HeatLayer,
  type PresenceMessage,
  type QuantisedVehicleDelta,
  type SiteLimits,
  type VehicleDecision,
  type Transfer,
  type WelcomeMessage,
} from '@warehouse/protocol';
import {
  ArmorGuard,
  checkFrameSize,
  validateDisplayName,
} from '@warehouse/armor';
import {
  createWorld,
  tick,
  serialize,
  restore,
  spawnPlayerVehicle,
  removePlayerVehicle,
  extractRunNumber,
  setDriverRunMode,
  SKILLS,
  takeWheel,
  release,
  releaseWheel,
  setVehicleAutopilot,
  applyAgentDirective,
  humanInteract,
  keepCards,
  receiveTransfer,
  setPhase,
  compactFacilityIfNeeded,
  guide,
  interactAt,
  postOrder,
  board,
  BASE_FLEET,
  FLEET_CAP,
  MAX_TIER,
  TIER_STEP,
  type BoardRow,
  type Card,
  type CardHand,
  type RunMode,
  type Vehicle,
  type World,
  type WorldSnapshotV5,
  type SimEvent,
} from '@warehouse/sim';
import {
  InMemoryPersistenceStore,
  type PersistenceStore,
} from './persistence.js';
import {
  FacilityGovernor,
  MAX_AUTONOMOUS_AGENTS,
  MIN_AUTONOMOUS_AGENTS,
} from './governance.js';
import {
  AgentBrainScheduler,
  DEFAULT_GEMINI_MODEL,
  VertexGeminiBrainClient,
  type GeminiBrainClient,
} from './brain.js';
import {
  NlOrderPipeline,
  CloudModelArmorClient,
  VertexNlOrderParser,
  buildA2uiScreen,
  type ModelArmorClient,
  type NlOrderParserClient,
} from './armor-pipeline.js';

export const MAX_SOCKETS = 300;
export const MAX_DRIVERS = 32;
export const FREE_RANGE_SOFT_CAP = 26;
export const RELOCATION_BONUS_PTS = 75;
export const RELOCATION_COOLDOWN_MS = 90_000;
export const MAX_DRIVERS_PER_CLIENT = 2;
export const DEFAULT_INPUT_LEASE_MS = 5_000;
export const DEFAULT_IDLE_BREAK_MS = 5 * 60 * 1000;
export const DEFAULT_WIND_DOWN_MAX_MS = 60_000;
export const DEFAULT_TICKET_SECRET =
  process.env.TICKET_SECRET ||
  process.env.TICKET_HMAC_KEY ||
  process.env.TICKET_HMAC_SECRET ||
  'dev-local-warehouse-hmac-secret-key-2026';

/** Real server + sim limits advertised in `welcome.limits`. */
export const SITE_LIMITS: SiteLimits = {
  maxDrivers: MAX_DRIVERS,
  maxDriversPerClient: MAX_DRIVERS_PER_CLIENT,
  fleetCap: FLEET_CAP,
  maxTier: MAX_TIER,
  baseFleet: BASE_FLEET,
  tierStep: TIER_STEP,
  minAutonomousAgents: MIN_AUTONOMOUS_AGENTS,
  maxAutonomousAgents: MAX_AUTONOMOUS_AGENTS,
};

/**
 * Snapshot safe to hand to a given connection: human players' card hands are
 * stripped except the recipient's own (agent hands, flagged `ai`, stay public).
 */
export function snapshotForRecipient(
  world: World,
  recipientClientId: string | null,
  opts?: { leanBot?: boolean },
): WorldSnapshotV5 {
  if (opts?.leanBot) {
    const botCards: Record<string, CardHand> = {};
    if (recipientClientId !== null && world.cards[recipientClientId]) {
      botCards[recipientClientId] = world.cards[recipientClientId];
    }
    return {
      version: 5,
      v: 5,
      siteId: world.siteId,
      seed: world.seed,
      rngState: world.rngState,
      t: world.t,
      shiftTime: world.shiftTime,
      tier: world.tier,
      phase: world.phase,
      resumeCountdown: world.resumeCountdown,
      vehicleSeq: world.vehicleSeq,
      nextOrderId: world.nextOrderId,
      nextHazardId: world.nextHazardId,
      nextDecisionSeq: world.nextDecisionSeq,
      nextTransferSeq: world.nextTransferSeq,
      nextPlayerSeq: world.nextPlayerSeq,
      cardSeq: world.cardSeq,
      difficulty: world.difficulty,
      difficultyVotes: { ...world.difficultyVotes },
      rushUntil: world.rushUntil,
      humanValue: world.humanValue,
      agentValue: world.agentValue,
      aiShift: world.aiShift,
      totals: { ...world.totals, decisions: { ...world.totals.decisions } },
      day: { ...world.day },
      shift: { ...world.shift },
      tuned: { ...world.tuned },
      cones: [...world.cones],
      bays: world.bays.map((b) => ({ ...b })),
      orders: world.orders.map((o) => ({ ...o, slot: { ...o.slot } })),
      spills: world.spills.map((s) => ({ ...s })),
      vehicles: world.vehicles.map((v) => ({
        ...v,
        tile: { ...v.tile },
        moveTo: v.moveTo ? { ...v.moveTo } : null,
        path: [],
        orders: v.orders.map((o) => ({ ...o, slot: { ...o.slot } })),
        cargo: v.cargo.map((o) => ({ ...o, slot: { ...o.slot } })),
        input: { ...v.input },
        hzSeen: [],
        tactics: { ...v.tactics },
        fareLog: [],
        precisionArmed: null,
        autopilot: Boolean(v.autopilot),
        directive: null,
        lastDecision: null,
        lastBrainDecision: null,
        target: null,
      })),
      cards: botCards,
      valueSeries: [],
      hallOfFame: [],
      history: [],
      events: [],
      deliveries: [],
      incidentLog: [],
      receivedTransferIds: [],
      outboundTransfers: [],
      pendingDecisions: [],
      decisionJournal: [],
      players: [],
      heat: [],
    };
  }

  const filteredCards: Record<string, CardHand> = {};
  for (const [key, hand] of Object.entries(world.cards)) {
    if (hand.ai || (recipientClientId !== null && key === recipientClientId)) {
      filteredCards[key] = structuredClone(hand);
    }
  }

  const origCards = world.cards;
  world.cards = {};
  let snap: WorldSnapshotV5;
  try {
    snap = serialize(world);
  } finally {
    world.cards = origCards;
  }
  snap.cards = filteredCards;
  return snap;
}

/** Sparse heat cells `[index, value]` (value rounded to 0.1, tiles < HEAT_MIN_VALUE omitted). */
export function sparseHeat(world: World): HeatLayer {
  const cells: [number, number][] = [];
  const heat = world.heat;
  for (let i = 0; i < heat.length; i++) {
    const v = heat[i];
    if (v >= HEAT_MIN_VALUE) {
      cells.push([i, Math.round(v * 10) / 10]);
    }
  }
  return { w: world.map.w, h: world.map.h, cells };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Fare combo stats (sim `Vehicle.combo` etc.); omitted when the sim hasn't set them. */
export function fareStats(
  v: Vehicle,
): Pick<QuantisedVehicleDelta, 'combo' | 'comboBest' | 'fareTrips' | 'speedyTrips'> {
  return {
    ...(v.combo !== undefined ? { combo: v.combo } : {}),
    ...(v.comboBest !== undefined ? { comboBest: v.comboBest } : {}),
    ...(v.fareTrips !== undefined ? { fareTrips: v.fareTrips } : {}),
    ...(v.speedyTrips !== undefined ? { speedyTrips: v.speedyTrips } : {}),
  };
}

/** Inspector-only vehicle detail carried on FULL deltas. */
export type VehicleDetail = Pick<
  QuantisedVehicleDelta,
  | 'incidents'
  | 'nearMisses'
  | 'skids'
  | 'palletDrops'
  | 'deliveries'
  | 'tactics'
  | 'path'
  | 'extra'
  | 'decision'
  | 'autopilot'
  | 'directive'
  | 'runMode'
  | 'runStartedAt'
  | 'runEndsAt'
  | 'runGraceUntil'
  | 'runPts'
  | 'runDeliveries'
  | 'runOnTime'
  | 'runIncidents'
  | 'streak'
  | 'bestStreak'
  | 'combo'
  | 'comboBest'
  | 'fareTrips'
  | 'speedyTrips'
  | 'runFinished'
>;

export function vehicleDetail(v: Vehicle): VehicleDetail {
  const path: number[] = [];
  const n = Math.min(MAX_PATH_WAYPOINTS, v.path.length);
  for (let i = 0; i < n; i++) {
    path.push(Math.round(v.path[i].x), Math.round(v.path[i].y));
  }
  const t = v.tactics;
  const includeRunTelemetry = v.human && !v.isBot;
  const out: VehicleDetail = {
    incidents: v.incidents,
    nearMisses: v.nearMisses,
    skids: v.skids ?? 0,
    palletDrops: v.palletDrops ?? 0,
    deliveries: v.deliveries ?? 0,
    tactics: {
      speed: round2(t.speed),
      respect: round2(t.respect),
      buffer: round2(t.buffer),
      chargeAt: round2(t.chargeAt),
      batch: round2(t.batch),
      flatPath: t.flatPath,
      preemptForP0: t.preemptForP0,
      poach: t.poach,
      ...(t.note ? { note: t.note } : {}),
    },
    path,
    extra: Boolean(v.extra),
    autopilot: Boolean(v.autopilot),
    directive: v.directive ?? null,
    ...(includeRunTelemetry
      ? {
          ...(v.runMode ? { runMode: v.runMode } : {}),
          ...(v.runStartedAt !== undefined
            ? { runStartedAt: v.runStartedAt === null ? null : round2(v.runStartedAt) }
            : {}),
          ...(v.runEndsAt !== undefined
            ? { runEndsAt: v.runEndsAt === null ? null : round2(v.runEndsAt) }
            : {}),
          ...(v.runGraceUntil !== undefined
            ? { runGraceUntil: v.runGraceUntil === null ? null : round2(v.runGraceUntil) }
            : {}),
          ...(v.runPts !== undefined ? { runPts: Math.round(v.runPts) } : {}),
          ...(v.runDeliveries !== undefined ? { runDeliveries: v.runDeliveries } : {}),
          ...(v.runOnTime !== undefined ? { runOnTime: v.runOnTime } : {}),
          ...(v.runIncidents !== undefined ? { runIncidents: v.runIncidents } : {}),
          ...(v.streak !== undefined ? { streak: v.streak } : {}),
          ...(v.bestStreak !== undefined ? { bestStreak: v.bestStreak } : {}),
          ...fareStats(v),
          ...(v.runFinished !== undefined ? { runFinished: Boolean(v.runFinished) } : {}),
        }
      : {}),
  };
  const d = v.lastDecision;
  // Only real, applied brain calls populate lastDecision; never synthesise one.
  if (d && d.model && Number.isFinite(d.latencyMs)) {
    const decision: VehicleDecision = {
      kind: d.kind,
      model: d.model,
      latencyMs: Math.round(d.latencyMs),
      reason: d.reason,
      t: d.t,
    };
    out.decision = decision;
  }
  return out;
}

export interface ConnectedClient {
  socket: WebSocket;
  authenticated: boolean;
  clientId: string;
  playerId: string;
  name: string;
  ip: string;
  isBot: boolean;
  vid: string | null;
  role: 'driver' | 'spectator';
  runMode?: RunMode;
  connectedAtMs: number;
  lastInputAtMs: number;
  lastInputSeq: number;
  authTimer?: ReturnType<typeof setTimeout>;
  /** Subscribed to the sparse heat (traffic) layer via `{type:'layers'}`. */
  trafficLayer?: boolean;
  /** Wall-clock ms the last heat layer was sent to this connection. */
  lastHeatSentAtMs?: number;
  /** `t` of the newest value sample this connection already has. */
  seriesSentT?: number | null;
  /** Signature of `world.history` last sent to this connection. */
  historySentKey?: string;
  /** Signature of `world.hallOfFame` last sent to this connection. */
  hallSentKey?: string;
}

export interface SiteServerOptions {
  siteId?: SiteId;
  seed?: number;
  initialAgents?: number;
  ticketSecret?: string;
  wsPublicUrl?: string;
  persistence?: PersistenceStore;
  governor?: FacilityGovernor;
  guard?: ArmorGuard;
  strikes?: ArmorGuard;
  brainClient?: GeminiBrainClient;
  brainScheduler?: AgentBrainScheduler;
  armorClient?: ModelArmorClient;
  nlParser?: NlOrderParserClient;
  nlPipeline?: NlOrderPipeline;
  enableIntervals?: boolean;
  inputLeaseMs?: number;
  idleBreakThresholdMs?: number;
  windDownMaxMs?: number;
  restoreFromPersistence?: boolean;
  /**
   * When true (default in Cloud Run / production), rejects direct WebSocket upgrades
   * and internal HTTP requests that do not carry a valid `x-warehouse-proxy` HMAC header
   * from the frontend `warehouse-lobby` gateway.
   */
  requireProxyAuth?: boolean;
}

export interface SiteServerInstance {
  app: FastifyInstance;
  wss: WebSocketServer;
  world: World;
  siteId: SiteId;
  persistence: PersistenceStore;
  governor: FacilityGovernor;
  guard: ArmorGuard;
  strikes: ArmorGuard;
  brainScheduler: AgentBrainScheduler;
  nlPipeline: NlOrderPipeline;
  clients: Set<ConnectedClient>;
  stepTick: (nowMs?: number, background?: boolean) => Promise<void>;
  checkFactoryBreakPhase: (nowMs?: number) => Promise<void>;
  checkSurgeRelocation: (nowMs?: number) => Promise<void>;
  flushSnapshot: (nowMs?: number) => Promise<void>;
  flushHeartbeat: (nowMs?: number) => Promise<void>;
  broadcast: (msg: ServerMessage) => void;
  gracefulShutdown: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createSiteServer(
  options: SiteServerOptions = {},
): Promise<SiteServerInstance> {
  const siteId: SiteId =
    options.siteId ?? ((process.env.SITE_ID as SiteId) || 'den-1');
  const ticketSecret =
    options.ticketSecret ??
    process.env.TICKET_SECRET ??
    process.env.TICKET_HMAC_KEY ??
    process.env.TICKET_HMAC_SECRET ??
    DEFAULT_TICKET_SECRET;
  const requireProxyAuth =
    options.requireProxyAuth ??
    (Boolean(process.env.K_SERVICE) ||
      process.env.REQUIRE_PROXY_AUTH === '1' ||
      process.env.REQUIRE_PROXY_AUTH === 'true');
  const inputLeaseMs = options.inputLeaseMs ?? DEFAULT_INPUT_LEASE_MS;
  const idleBreakThresholdMs =
    options.idleBreakThresholdMs ?? DEFAULT_IDLE_BREAK_MS;
  const windDownMaxMs = options.windDownMaxMs ?? DEFAULT_WIND_DOWN_MAX_MS;

  const persistence = options.persistence ?? new InMemoryPersistenceStore();
  const governor = options.governor ?? new FacilityGovernor();
  const guard = options.guard ?? options.strikes ?? new ArmorGuard();

  let world: World;
  if (options.restoreFromPersistence) {
    const saved = await persistence.loadLatestSnapshot(siteId);
    if (saved) {
      world = restore(saved);
      for (const cid of [...world.players.keys()]) {
        removePlayerVehicle(world, cid);
      }
      for (const v of [...world.vehicles]) {
        if (v.isPlayerVehicle) {
          removePlayerVehicle(world, v.ownerClientId || '');
        }
      }
      world.vehicles = world.vehicles.filter((v) => !v.isPlayerVehicle);
      if (world.phase === 'break') {
        compactFacilityIfNeeded(world);
      }
    } else {
      world = createWorld({
        siteId,
        seed: options.seed ?? 20261015,
        agents: options.initialAgents,
      });
    }
  } else {
    world = createWorld({
      siteId,
      seed: options.seed ?? 20261015,
      agents: options.initialAgents,
    });
  }

  if (options.enableIntervals) {
    while (world.orders.filter((o) => o.state === 'open').length < 8) {
      postOrder(world);
    }
  }

  const app = Fastify({ logger: false });
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<ConnectedClient>();
  const pendingEvents: SimEvent[] = [];
  const relocationCooldownUntil = new Map<string, number>();
  const persistedFinishedRuns = new Set<string>();

  async function persistVehicleStats(
    cid: string,
    playerName: string,
    isBotFlag: boolean,
    v: Vehicle,
    extraPts: number = 0,
    nowMs: number = Date.now(),
  ): Promise<void> {
    const runKey = `${cid}:${v.runStartedAt ?? 0}`;
    if (persistedFinishedRuns.has(runKey) && extraPts === 0) {
      return;
    }
    if (v.runFinished) {
      persistedFinishedRuns.add(runKey);
    }
    const score = Math.round(v.sPts) + extraPts;
    const runPts = Math.round(v.runPts ?? v.sPts) + extraPts;
    const existing = await persistence.getPlayerStats(cid);
    const prevBestBlitz = existing?.bestBlitzPts ?? 0;
    const nextBestBlitz =
      (v.runMode ?? 'blitz') === 'blitz'
        ? Math.max(prevBestBlitz, runPts)
        : prevBestBlitz;
    await persistence.upsertPlayerStats({
      clientId: cid,
      name: playerName,
      isBot: isBotFlag,
      totalDeliveries: (existing?.totalDeliveries ?? 0) + v.deliveries,
      totalScore: (existing?.totalScore ?? 0) + score,
      ...(nextBestBlitz > 0 ? { bestBlitzPts: nextBestBlitz } : {}),
      shiftsPlayed: (existing?.shiftsPlayed ?? 0) + 1,
      lastSiteId: siteId,
      updatedAt: nowMs,
    });
  }

  const gcpProjectId =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCP_PROJECT_ID ||
    'davenport-boutique';
  const vertexLocation =
    process.env.VERTEX_LOCATION ||
    process.env.GEMINI_LOCATION ||
    'global';

  const armorClient =
    options.armorClient ??
    new CloudModelArmorClient({
      projectId: gcpProjectId,
      location: process.env.MODEL_ARMOR_LOCATION || 'us-central1',
      templatePath: process.env.MODEL_ARMOR_TEMPLATE || 'warehouse-orders',
    });

  const nlParser =
    options.nlParser ??
    new VertexNlOrderParser({
      projectId: gcpProjectId,
      location: vertexLocation,
      model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    });

  const nlPipeline =
    options.nlPipeline ??
    new NlOrderPipeline({
      armorClient,
      parserClient: nlParser,
      governor,
      persistence,
      guard,
    });

  const brainClient =
    options.brainClient ??
    new VertexGeminiBrainClient({
      projectId: gcpProjectId,
      location: vertexLocation,
      model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    });

  const brainScheduler =
    options.brainScheduler ??
    new AgentBrainScheduler({
      siteId,
      client: brainClient,
      persistence,
      getArmorBlocks1h: (t) => nlPipeline.getArmorBlocks1h(t),
      onDecisionBroadcast: (msg) => broadcast(msg as unknown as ServerMessage),
      onHealthBroadcast: (h) => broadcast(h),
    });

  world.listeners.push((ev) => {
    pendingEvents.push(ev);
  });

  let lastHumanActiveAtMs = Date.now();
  let windingDownStartedAtMs: number | null = null;
  let lastBroadcastPhase = world.phase;
  let shuttingDown = false;

  function sendTo(socket: WebSocket, msg: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  function broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const c of clients) {
      if (c.authenticated && c.socket.readyState === WebSocket.OPEN) {
        c.socket.send(payload);
      }
    }
  }

  function countActiveDrivers(): number {
    const driverClientIds = new Set<string>();
    for (const c of clients) {
      if (c.authenticated && c.role === 'driver' && c.vid) {
        driverClientIds.add(c.clientId);
      }
    }
    return driverClientIds.size;
  }

  function countClientDrivers(clientId: string): number {
    let count = 0;
    for (const c of clients) {
      if (
        c.authenticated &&
        c.clientId === clientId &&
        c.role === 'driver' &&
        c.vid
      ) {
        count++;
      }
    }
    return count;
  }

  function countConnectedSockets(): number {
    let count = 0;
    for (const c of clients) {
      if (c.authenticated) count++;
    }
    return count;
  }

  function countUniqueAuthenticatedClients(): number {
    const clientIds = new Set<string>();
    for (const c of clients) {
      if (c.authenticated) {
        clientIds.add(c.clientId);
      }
    }
    return clientIds.size;
  }

  let lastPresenceScoreSig = '';

  function computeDriverScoreSig(): string {
    let sig = '';
    for (const v of world.vehicles) {
      if (v.human) {
        sig += `${v.id}:${Math.round(v.sPts)}|`;
      }
    }
    return sig;
  }

  function buildPresenceMessage(): PresenceMessage {
    const byClient = new Map<string, ConnectedClient>();
    for (const c of clients) {
      if (!c.authenticated) continue;
      const existing = byClient.get(c.clientId);
      if (!existing) {
        byClient.set(c.clientId, c);
      } else {
        const existingIsDriver = existing.role === 'driver' && Boolean(existing.vid);
        const currentIsDriver = c.role === 'driver' && Boolean(c.vid);
        if (currentIsDriver || !existingIsDriver) {
          byClient.set(c.clientId, c);
        }
      }
    }
    const players = Array.from(byClient.values()).map((c) => {
      const v = c.vid ? world.vehicles.find((x) => x.id === c.vid) : null;
      const pts = v ? Math.round(v.sPts) : 0;
      const role: 'driver' | 'spectator' =
        c.role === 'driver' && c.vid ? 'driver' : 'spectator';
      return {
        clientId: c.clientId,
        playerId: c.playerId,
        name: c.name,
        vid: role === 'driver' ? c.vid : null,
        points: pts,
        score: pts,
        role,
        isBot: c.isBot,
      };
    });
    lastPresenceScoreSig = computeDriverScoreSig();
    return {
      type: 'presence',
      players,
    };
  }

  /**
   * Builds the delta shared by every connection. Per-connection extras (own hand,
   * seriesAppend, history, hall, heat) are spliced in by `broadcastDelta`.
   */
  function buildDeltaMessage(
    events: SimEvent[],
    includeFullState: boolean = true,
    nowMs: number = Date.now(),
  ): DeltaMessage {
    const pendingByAgent = new Set(
      world.pendingDecisions.map((r) => r.agentId),
    );
    const vehicles: QuantisedVehicleDelta[] = world.vehicles.map((v) => {
      if (!includeFullState) {
        if (!v.human || v.isBot) {
          return {
            id: v.id,
            qx: quantiseCoord(v.px),
            qy: quantiseCoord(v.py),
            angle: Math.round(v.angle * 100) / 100,
            speedNow: Math.round(v.speedNow * 10) / 10,
            cargoCount: v.cargo.length,
            sShipped: v.sShipped,
            sPts: Math.round(v.sPts),
            inRange: v.human ? Boolean(interactAt(world, v).hit) : false,
          };
        }
        const g = guide(world, v);
        return {
          id: v.id,
          qx: quantiseCoord(v.px),
          qy: quantiseCoord(v.py),
          angle: Math.round(v.angle * 100) / 100,
          speedNow: Math.round(v.speedNow * 10) / 10,
          battery: Math.round(v.battery * 10) / 10,
          humanCharging: Boolean(v.humanCharging),
          autopilot: Boolean(v.autopilot),
          cargoCount: v.cargo.length,
          sShipped: Math.max(v.sShipped, v.deliveries),
          sPts: Math.round(v.sPts),
          ...(v.runMode ? { runMode: v.runMode } : {}),
          ...(v.runStartedAt !== undefined
            ? { runStartedAt: v.runStartedAt === null ? null : round2(v.runStartedAt) }
            : {}),
          ...(v.runEndsAt !== undefined
            ? { runEndsAt: v.runEndsAt === null ? null : round2(v.runEndsAt) }
            : {}),
          ...(v.runGraceUntil !== undefined
            ? { runGraceUntil: v.runGraceUntil === null ? null : round2(v.runGraceUntil) }
            : {}),
          ...(v.runPts !== undefined ? { runPts: Math.round(v.runPts) } : {}),
          ...(v.runDeliveries !== undefined ? { runDeliveries: v.runDeliveries } : {}),
          ...(v.runOnTime !== undefined ? { runOnTime: v.runOnTime } : {}),
          ...(v.runIncidents !== undefined ? { runIncidents: v.runIncidents } : {}),
          ...(v.streak !== undefined ? { streak: v.streak } : {}),
          ...(v.bestStreak !== undefined ? { bestStreak: v.bestStreak } : {}),
          ...fareStats(v),
          ...(v.runFinished !== undefined ? { runFinished: Boolean(v.runFinished) } : {}),
          inRange: Boolean(g?.inRange),
          guide: g
            ? {
                kind: g.kind,
                x: g.x,
                y: g.y,
                inRange: g.inRange,
              }
            : null,
        };
      }

      const needGuide = v.human && (!v.isBot || clients.size <= 8);
      const g = needGuide ? guide(world, v) : null;
      const inRange = g
        ? Boolean(g.inRange)
        : v.human
          ? Boolean(interactAt(world, v).hit)
          : false;
      return {
        id: v.id,
        qx: quantiseCoord(v.px),
        qy: quantiseCoord(v.py),
        px: Math.round(v.px * 100) / 100,
        py: Math.round(v.py * 100) / 100,
        angle: Math.round(v.angle * 1000) / 1000,
        speedNow: Math.round(v.speedNow * 100) / 100,
        state: v.state,
        battery: Math.round(v.battery * 10) / 10,
        fork: Math.round(v.fork * 100) / 100,
        cargoCount: v.cargo.length,
        cargo: v.cargo.map((o) => ({
          id: o.id,
          bay: o.bay,
          p0: o.p0,
          value: o.value,
          due: o.due,
          sku: o.sku,
        })),
        orders: v.orders.map((o) => ({
          id: o.id,
          bay: o.bay,
          p0: o.p0,
          value: o.value,
          due: o.due,
          state: o.state,
          slot: o.slot,
        })),
        driver: v.driver,
        human: v.human,
        humanCharging: Boolean(v.humanCharging),
        strategy: v.strategy,
        type: v.type,
        braking: v.braking,
        stunnedUntil: v.stunnedUntil,
        sPts: Math.round(v.sPts),
        sShipped: Math.max(v.sShipped, v.deliveries),
        msg: v.msg,
        brainThinking: pendingByAgent.has(v.id),
        brainError: v.brainError,
        lastReason: v.lastDecision?.reason ?? null,
        inRange,
        guide: g
          ? {
              kind: g.kind,
              x: g.x,
              y: g.y,
              text: g.text,
              inRange: g.inRange,
            }
          : null,
        ...vehicleDetail(v),
      };
    });

    if (!includeFullState) {
      return {
        type: 'delta',
        t: world.t,
        vehicles,
        events,
      };
    }

    return {
      type: 'delta',
      t: world.t,
      vehicles,
      orders: world.orders,
      hazards: world.spills,
      cones: [...world.cones],
      bays: world.bays,
      markers: world.markers,
      events,
      votes: world.difficultyVotes,
      difficulty: world.difficulty,
      tier: world.tier,
      stats: {
        totals: world.totals,
        day: world.day,
        shift: world.shift,
        shiftTime: world.shiftTime,
        rushUntil: world.rushUntil,
        board: currentBoard(nowMs),
      },
    };
  }

  // ---- Strategy Board cache (recomputed at most once per BOARD_INTERVAL_MS) ----
  let boardCache: BoardRow[] | null = null;
  let boardComputedAtMs = Number.NEGATIVE_INFINITY;
  function currentBoard(nowMs: number): BoardRow[] {
    if (!boardCache || nowMs - boardComputedAtMs >= BOARD_INTERVAL_MS || nowMs < boardComputedAtMs) {
      boardCache = board(world);
      boardComputedAtMs = nowMs;
    }
    return boardCache;
  }

  const HISTORY_WIRE_CAP = 60; // matches serialize(world).history

  function historyKey(): string {
    const h = world.history;
    return `${h.length}:${h.length ? h[h.length - 1].day : ''}`;
  }

  function hallKey(): string {
    return JSON.stringify(world.hallOfFame);
  }

  function latestSampleT(): number | null {
    const s = world.valueSeries;
    return s.length ? s[s.length - 1].t : null;
  }

  /** Marks everything carried by a welcome snapshot as already delivered to `conn`. */
  function resetIncrementalTrackers(conn: ConnectedClient): void {
    conn.seriesSentT = latestSampleT();
    conn.historySentKey = historyKey();
    conn.hallSentKey = hallKey();
    conn.lastHeatSentAtMs = undefined;
  }

  function buildWelcome(conn: ConnectedClient): WelcomeMessage {
    resetIncrementalTrackers(conn);
    const leanBot = conn.isBot;
    return {
      type: 'welcome',
      you: {
        clientId: conn.clientId,
        playerId: conn.playerId,
        name: conn.name,
        vid: conn.vid,
        role: conn.role,
        siteId,
        isBot: conn.isBot,
      },
      snapshot: snapshotForRecipient(world, conn.clientId, { leanBot }),
      limits: { ...SITE_LIMITS },
    };
  }

  /**
   * Light deltas: one shared payload. Full deltas: shared JSON head + shared stats,
   * with per-connection fields appended inside `stats` and a recipient-only `hands`.
   */
  function broadcastDelta(
    events: SimEvent[],
    includeFullState: boolean,
    nowMs: number,
  ): void {
    const msg = buildDeltaMessage(events, includeFullState, nowMs);
    if (!includeFullState) {
      broadcast(msg);
      return;
    }

    let head: string | null = null;
    let statsCore: string | null = null;
    let botHead: string | null = null;
    const useLeanBotDelta = clients.size > 8;

    const hKey = historyKey();
    let historyJson: string | null = null;
    const hlKey = hallKey();
    let heatJson: string | null = null;
    const seriesJsonBySentT = new Map<number | null, string>();

    for (const c of clients) {
      if (!c.authenticated || c.socket.readyState !== WebSocket.OPEN) continue;

      // Recipient's own hand only (hands are keyed by clientId in the sim).
      const own = c.clientId ? world.cards[c.clientId] : undefined;
      const handsJson = own ? `{${JSON.stringify(c.clientId)}:${JSON.stringify(own)}}` : '{}';

      if (useLeanBotDelta && c.isBot) {
        if (botHead === null) {
          const compactVehicles = msg.vehicles.map((v) => ({
            id: v.id,
            qx: v.qx,
            qy: v.qy,
            angle: v.angle,
            speedNow: v.speedNow,
            battery: v.battery,
            cargoCount: v.cargoCount,
            sShipped: v.sShipped,
            sPts: v.sPts,
            inRange: v.inRange,
          }));
          botHead = JSON.stringify({
            type: 'delta',
            t: msg.t,
            vehicles: compactVehicles,
            orders: world.orders,
            events: msg.events,
            difficulty: world.difficulty,
          }).slice(0, -1);
        }
        c.socket.send(`${botHead},"hands":${handsJson}}`);
        continue;
      }

      if (head === null || statsCore === null) {
        const { stats, ...rest } = msg;
        head = JSON.stringify(rest).slice(0, -1); // drop trailing '}'
        statsCore = JSON.stringify(stats as DeltaStats).slice(1, -1); // inner of {...}
      }

      let extras = '';

      // seriesAppend: samples newer than the newest one this connection holds.
      const sentT = c.seriesSentT ?? null;
      const newestT = latestSampleT();
      if (newestT !== null && (sentT === null || newestT > sentT)) {
        let json = seriesJsonBySentT.get(sentT);
        if (json === undefined) {
          const fresh = world.valueSeries.filter((s) => sentT === null || s.t > sentT);
          json = JSON.stringify(fresh);
          seriesJsonBySentT.set(sentT, json);
        }
        extras += `,"seriesAppend":${json}`;
        c.seriesSentT = newestT;
      }

      if (c.historySentKey !== hKey) {
        historyJson ??= JSON.stringify(world.history.slice(-HISTORY_WIRE_CAP));
        extras += `,"history":${historyJson}`;
        c.historySentKey = hKey;
      }

      if (c.hallSentKey !== hlKey) {
        extras += `,"hall":${hlKey}`;
        c.hallSentKey = hlKey;
      }

      if (
        c.trafficLayer &&
        (c.lastHeatSentAtMs === undefined || nowMs - c.lastHeatSentAtMs >= HEAT_INTERVAL_MS)
      ) {
        heatJson ??= JSON.stringify(sparseHeat(world));
        extras += `,"heat":${heatJson}`;
        c.lastHeatSentAtMs = nowMs;
      }

      c.socket.send(`${head},"stats":{${statsCore}${extras}},"hands":${handsJson}}`);
    }
  }

  function difficultyNumber(diff: World['difficulty']): number {
    if (diff === 'calm' || diff === 'easy') return 1;
    if (diff === 'normal' || diff === 'medium') return 2;
    if (diff === 'surge' || diff === 'hard') return 3;
    return 4;
  }

  async function flushSnapshot(nowMs: number = Date.now()): Promise<void> {
    const activeClientIds = new Set(
      Array.from(clients)
        .filter((c) => c.authenticated && c.clientId)
        .map((c) => c.clientId),
    );
    for (const cid of [...world.players.keys()]) {
      if (!activeClientIds.has(cid)) {
        removePlayerVehicle(world, cid);
      }
    }
    const snap = serialize(world);
    snap.vehicles = snap.vehicles.filter((v) => !v.isPlayerVehicle);
    snap.players = [];
    await persistence.saveSnapshot(siteId, snap, nowMs);
    for (const hof of world.hallOfFame) {
      const shiftNum =
        Number.parseInt(String(hof.shift).replace(/\D+/g, ''), 10) || 1;
      await persistence.recordHallOfFame({
        id: `${siteId}-shift-${hof.shift}-${hof.id}`,
        siteId,
        shift: shiftNum,
        revenue: Math.round(world.humanValue + world.agentValue),
        shipped: world.totals.shipped,
        L0: hof.scored,
        streak: world.totals.wins,
        difficulty: difficultyNumber(hof.diff ?? world.difficulty),
        topDriverName: hof.driver,
        topDriverScore: Math.round(hof.pts),
        createdAt: nowMs,
      });
    }
  }

  async function flushHeartbeat(nowMs: number = Date.now()): Promise<void> {
    const drivers = countActiveDrivers();
    const totalAuth = countUniqueAuthenticatedClients();
    const spectators = Math.max(0, totalAuth - drivers);
    const openOrders = world.orders.filter((o) => o.state !== 'done').length;
    const agentCount = world.vehicles.filter(
      (v) => !v.human && !v.isPlayerVehicle,
    ).length;
    const driverClientIds = Array.from(
      new Set(
        Array.from(clients)
          .filter((c) => c.authenticated && c.role === 'driver' && c.vid)
          .map((c) => c.clientId),
      ),
    );
    const region =
      siteId === 'den-1'
        ? 'us-central1'
        : siteId === 'slc-2'
          ? 'us-west3'
          : siteId === 'phx-3'
            ? 'us-west4'
            : 'us-south1';

    await persistence.writeHeartbeat({
      siteId,
      url: options.wsPublicUrl || 'http://localhost:8080',
      region,
      phase: shuttingDown ? 'break' : world.phase,
      players: drivers,
      spectators,
      agents: agentCount,
      maxDrivers: MAX_DRIVERS,
      backlog: openOrders,
      revenue: Math.round(world.humanValue + world.agentValue),
      shipped: world.totals.shipped,
      streak: world.totals.wins,
      difficulty: difficultyNumber(world.difficulty),
      tier: world.tier,
      driverClientIds,
      brainHealth: brainScheduler.getBrainHealth(nowMs),
      updatedAt: nowMs,
    });
  }

  let pendingHeartbeatFlushTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleHeartbeatFlush(): void {
    if (shuttingDown || pendingHeartbeatFlushTimer) return;
    pendingHeartbeatFlushTimer = setTimeout(() => {
      pendingHeartbeatFlushTimer = null;
      if (!shuttingDown) {
        void flushHeartbeat(Date.now());
      }
    }, 150);
    pendingHeartbeatFlushTimer.unref?.();
  }

  async function checkFactoryBreakPhase(nowMs: number = Date.now()): Promise<void> {
    const connectedCount = countConnectedSockets();
    const keepAlwaysWarm = process.env.IDLE_POLICY === 'warm';
    if (connectedCount > 0) {
      lastHumanActiveAtMs = nowMs;
      windingDownStartedAtMs = null;
      if (world.phase === 'break' || world.phase === 'winding_down') {
        setPhase(world, 'running');
      }
    } else if (!keepAlwaysWarm) {
      const idleDuration = nowMs - lastHumanActiveAtMs;
      if (world.phase === 'running' && idleDuration >= idleBreakThresholdMs) {
        setPhase(world, 'winding_down');
        windingDownStartedAtMs = nowMs;
      } else if (world.phase === 'winding_down') {
        const allParkedOrCharging = world.vehicles
          .filter((v) => !v.human)
          .every((v) => v.state === 'parked' || v.state === 'charging');
        const windDownElapsed =
          windingDownStartedAtMs !== null
            ? nowMs - windingDownStartedAtMs
            : windDownMaxMs;
        if (allParkedOrCharging || windDownElapsed >= windDownMaxMs) {
          setPhase(world, 'break');
          windingDownStartedAtMs = null;
          await flushSnapshot(nowMs);
        }
      }
    }

    if (world.phase !== lastBroadcastPhase) {
      lastBroadcastPhase = world.phase;
      broadcast({
        type: 'phase',
        phase: world.phase,
        resumesAt:
          world.phase === 'resuming'
            ? nowMs + Math.round(world.resumeCountdown * 1000)
            : undefined,
      });
    }
  }

  async function selectRelocationTargetSite(nowMs: number): Promise<SiteId> {
    const heartbeats = await persistence.getHeartbeats();
    const byId = new Map<SiteId, (typeof heartbeats)[number]>();
    for (const hb of heartbeats) {
      byId.set(hb.siteId, hb);
    }

    // 1. Warmest live site with 0 < players < FREE_RANGE_SOFT_CAP
    const warmLive: SiteId[] = [];
    for (const id of SITE_IDS) {
      if (id === siteId) continue;
      const hb = byId.get(id);
      if (
        hb &&
        hb.phase !== 'break' &&
        nowMs - hb.updatedAt <= 15_000 &&
        hb.players > 0 &&
        hb.players < FREE_RANGE_SOFT_CAP
      ) {
        warmLive.push(id);
      }
    }
    if (warmLive.length > 0) {
      warmLive.sort(
        (a, b) => (byId.get(b)?.players ?? 0) - (byId.get(a)?.players ?? 0),
      );
      return warmLive[0]!;
    }

    // 2. First empty live or break site
    for (const id of SITE_IDS) {
      if (id === siteId) continue;
      const hb = byId.get(id);
      if (!hb || hb.players < FREE_RANGE_SOFT_CAP) {
        return id;
      }
    }

    return SITE_IDS.find((id) => id !== siteId) ?? 'slc-2';
  }

  async function checkSurgeRelocation(nowMs: number = Date.now()): Promise<void> {
    const activeDrivers = countActiveDrivers();
    if (activeDrivers < FREE_RANGE_SOFT_CAP) return;

    const targetSite = await selectRelocationTargetSite(nowMs);
    const needed = Math.max(1, activeDrivers - 24);
    let sent = 0;

    for (const c of clients) {
      if (sent >= needed) break;
      if (!c.authenticated || c.role !== 'driver' || c.isBot || !c.vid) continue;
      const cooldownExp = relocationCooldownUntil.get(c.clientId) ?? 0;
      if (cooldownExp > nowMs) continue;
      const v = world.vehicles.find((x) => x.id === c.vid);
      if (!v || (v.runMode ?? 'blitz') !== 'freerange') continue;

      relocationCooldownUntil.set(c.clientId, nowMs + RELOCATION_COOLDOWN_MS);
      sendTo(c.socket, {
        type: 'relocationOffer',
        fromSite: siteId,
        toSite: targetSite,
        targetSite,
        bonusPts: RELOCATION_BONUS_PTS,
        expiresAt: nowMs + 30_000,
        reason: `Surge capacity (${activeDrivers}/${MAX_DRIVERS} drivers) — volunteer to transfer to ${targetSite.toUpperCase()} with full score & streak carry-over!`,
      });
      sent++;
    }
  }

  function checkInputLeases(nowMs: number): void {
    let releasedAny = false;
    for (const c of clients) {
      if (!c.authenticated || !c.vid) continue;
      if (nowMs - c.lastInputAtMs > inputLeaseMs) {
        const v = world.vehicles.find((x) => x.id === c.vid);
        if (!v) continue;
        // Co-Pilot autopilot vehicles continue operating autonomously for the player
        // without requiring constant keyboard heartbeats.
        if (v.autopilot) continue;
        if (v.isPlayerVehicle) {
          v.input = { up: false, down: false, left: false, right: false, boost: false };
        } else if (v.human) {
          release(world, v.id);
          const session = world.players.get(c.clientId);
          c.vid = session?.dedicatedVehicleId ?? null;
          c.role = c.vid ? 'driver' : 'spectator';
          releasedAny = true;
        }
      }
    }
    if (releasedAny) {
      broadcast(buildPresenceMessage());
      scheduleHeartbeatFlush();
    }
  }

  let backgroundDrainInFlight = false;
  let bgTickCount = Math.max(0, SITE_IDS.indexOf(siteId)) * 3;
  let pendingPresenceTimer: ReturnType<typeof setTimeout> | null = null;

  function schedulePresenceBroadcast(): void {
    if (pendingPresenceTimer) return;
    pendingPresenceTimer = setTimeout(() => {
      pendingPresenceTimer = null;
      if (!shuttingDown) {
        broadcast(buildPresenceMessage());
      }
    }, 25);
    pendingPresenceTimer.unref?.();
  }

  async function stepTick(
    nowMs: number = Date.now(),
    background: boolean = false,
  ): Promise<void> {
    await checkFactoryBreakPhase(nowMs);

    if (world.phase === 'break') {
      return;
    }

    checkInputLeases(nowMs);
    governor.expireCones(world, nowMs);

    // When active human drivers are on the floor, ensure open orders are available for pickup
    if (world.phase === 'running' && options.enableIntervals) {
      const activeDrivers = countActiveDrivers();
      if (activeDrivers > 0) {
        const openCount = world.orders.filter((o) => o.state === 'open').length;
        const targetMinOpen = Math.min(28, Math.max(8, activeDrivers));
        if (openCount < targetMinOpen) {
          const toPost = Math.min(4, targetMinOpen - openCount);
          for (let i = 0; i < toPost; i++) {
            postOrder(world);
          }
        }
      }
    }

    const prevPhase = world.phase;
    tick(world);

    // Persist newly finished Blitz runs immediately so bestBlitzPts is recorded right away
    for (const v of world.vehicles) {
      if (!v.human || !v.runFinished) continue;
      const cid = v.ownerClientId || v.controlledByClientId;
      if (!cid) continue;
      const runKey = `${cid}:${v.runStartedAt ?? 0}`;
      if (!persistedFinishedRuns.has(runKey)) {
        void persistVehicleStats(cid, v.driver || cid, Boolean(v.isBot), v, 0, nowMs);
      }
    }

    if (world.phase !== prevPhase) {
      lastBroadcastPhase = world.phase;
      broadcast({
        type: 'phase',
        phase: world.phase,
      });
    }

    const connectedCount = countConnectedSockets();

    // Drain emitted events and broadcast quantised delta immediately on the 10 Hz tick
    const rawEvents = pendingEvents.splice(0);
    const eventsToBroadcast =
      connectedCount > 4
        ? rawEvents.filter((e) => e.kind !== 'hint' && e.kind !== 'nearmiss')
        : rawEvents;
    if (connectedCount > 0) {
      bgTickCount++;
      const includeFullState =
        (!background && connectedCount <= 8) ||
        bgTickCount % 10 === 0 ||
        (connectedCount <= 8 && eventsToBroadcast.some((e) => e.kind === 'incident'));
      broadcastDelta(eventsToBroadcast, includeFullState, nowMs);

      if (computeDriverScoreSig() !== lastPresenceScoreSig) {
        if (connectedCount > 8) {
          schedulePresenceBroadcast();
        } else {
          broadcast(buildPresenceMessage());
        }
      }
    }

    const runAsyncWork = async () => {
      // Drain any outbound cross-site transfers produced during this tick
      if (world.outboundTransfers.length > 0) {
        const transfers = world.outboundTransfers.splice(0);
        for (const xfer of transfers) {
          const wireTransfer: Transfer = {
            id: xfer.id,
            fromSite: xfer.fromSite as SiteId,
            toSite: xfer.toSite as SiteId,
            orderRef: String(xfer.orderRef),
            sku: xfer.sku,
            value: xfer.value,
            shippedAt: Math.max(0, Math.round(xfer.shippedAt * 1000)),
            carrier: xfer.carrier || 'F-01',
          };
          await persistence.publishTransfer(wireTransfer);
        }
      }

      // Schedule Gemini brain decisions if running (pause Gemini calls when warm-idle with 0 sockets for >= idleBreakThresholdMs)
      const idlePauseGemini =
        connectedCount === 0 && nowMs - lastHumanActiveAtMs >= idleBreakThresholdMs;
      if (
        world.phase === 'running' &&
        world.pendingDecisions.length > 0 &&
        !idlePauseGemini
      ) {
        const untrustedNames = Array.from(clients)
          .filter((c) => c.authenticated && c.name)
          .map((c) => c.name);
        await brainScheduler.drainQueue(world, nowMs, untrustedNames);
      }
    };

    if (background) {
      if (!backgroundDrainInFlight) {
        backgroundDrainInFlight = true;
        void runAsyncWork().finally(() => {
          backgroundDrainInFlight = false;
        });
      }
    } else {
      await runAsyncWork();
    }
  }

  function applyCarryOverToVehicle(
    conn: ConnectedClient,
    vehicle: Vehicle,
    payload: {
      runMode?: RunMode;
      carryPts?: number;
      carryDeliveries?: number;
      carryStreak?: number;
      carryCards?: string[];
      relocationBonus?: number;
    },
  ): void {
    if (payload.runMode) {
      setDriverRunMode(world, conn.clientId, payload.runMode);
      vehicle.runMode = payload.runMode;
      conn.runMode = payload.runMode;
    }
    const bonus = payload.relocationBonus ?? 0;
    const totalCarryPts = (payload.carryPts ?? 0) + bonus;
    if (totalCarryPts > 0) {
      vehicle.sPts += totalCarryPts;
      vehicle.runPts = (vehicle.runPts ?? 0) + totalCarryPts;
    }
    if (payload.carryDeliveries && payload.carryDeliveries > 0) {
      vehicle.deliveries += payload.carryDeliveries;
      vehicle.sShipped += payload.carryDeliveries;
      vehicle.runDeliveries = (vehicle.runDeliveries ?? 0) + payload.carryDeliveries;
      vehicle.runOnTime = (vehicle.runOnTime ?? 0) + payload.carryDeliveries;
    }
    if (payload.carryStreak && payload.carryStreak > 0) {
      vehicle.streak = payload.carryStreak;
      vehicle.bestStreak = Math.max(vehicle.bestStreak ?? 0, payload.carryStreak);
    }
    if (payload.carryCards && payload.carryCards.length > 0) {
      const hand = world.cards[conn.clientId];
      if (hand) {
        const restoredCards: Card[] = [];
        for (const encodedEntry of payload.carryCards) {
          const isDone = encodedEntry.startsWith('done:');
          const rawTitle = isDone ? encodedEntry.slice(5) : encodedEntry;
          const skill = SKILLS.find((s) => s.title === rawTitle);
          if (!skill) continue;
          const perk = skill.perk ? { ...skill.perk } : {};
          restoredCards.push({
            id: `c${++world.cardSeq}`,
            title: skill.title,
            desc: skill.desc,
            rarity: skill.rarity ?? 'common',
            type: skill.type,
            goal: skill.goal,
            pts: skill.pts,
            perk,
            modifiers: { ...perk },
            progress: isDone ? skill.goal : 0,
            status: isDone ? 'done' : 'active',
            ...(isDone ? { completedAt: world.t } : {}),
          });
        }
        if (restoredCards.length > 0) {
          hand.cards = restoredCards;
          const activeCount = restoredCards.filter((c) => c.status === 'active').length;
          if (activeCount >= 2) {
            hand.offer = null;
          }
        }
      }
    }
    if (bonus > 0) {
      vehicle.msg = `Relocated to ${siteId.toUpperCase()} (+${bonus} surge bonus!)`;
    }
  }

  function authenticateConnection(
    conn: ConnectedClient,
    ticket: string,
    spectateOnly: boolean,
    nowMs: number = Date.now(),
  ): boolean {
    const verified = verifyTicket(ticket, ticketSecret, nowMs);
    if (!verified.ok) {
      sendTo(conn.socket, {
        type: 'error',
        code: 'unauthorized',
        message: `Invalid ticket: ${verified.error}`,
      });
      conn.socket.close(4003, `Invalid ticket: ${verified.error}`);
      return false;
    }

    const { payload } = verified;
    if (payload.siteId !== siteId) {
      sendTo(conn.socket, {
        type: 'error',
        code: 'wrong_site',
        message: `Ticket issued for ${payload.siteId}, not ${siteId}`,
      });
      conn.socket.close(4003, 'Wrong siteId in ticket');
      return false;
    }

    const nameCheck = validateDisplayName(payload.name, {
      allowBotPrefix: payload.isBot,
    });
    if (!nameCheck.ok) {
      sendTo(conn.socket, {
        type: 'error',
        code: nameCheck.code,
        message: nameCheck.message,
      });
      conn.socket.close(4003, nameCheck.message);
      return false;
    }

    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = undefined;
    }

    conn.authenticated = true;
    conn.clientId = payload.clientId;
    conn.name = nameCheck.name;
    conn.isBot = payload.isBot;
    conn.lastInputAtMs = nowMs;
    lastHumanActiveAtMs = nowMs;

    if (world.phase === 'break' || world.phase === 'winding_down') {
      setPhase(world, 'running');
      lastBroadcastPhase = world.phase;
    }

    const existingSession = world.players.get(conn.clientId);
    if (existingSession?.dedicatedVehicleId) {
      const ev = world.vehicles.find((x) => x.id === existingSession.dedicatedVehicleId);
      if (ev) {
        const nextRun = extractRunNumber(conn.name);
        const prevRun = extractRunNumber(existingSession.name);
        const isNewRun = nextRun !== null && nextRun !== prevRun;
        if (ev.battery <= 0 || ev.runFinished || isNewRun) {
          for (const other of Array.from(clients)) {
            if (other !== conn && other.authenticated && other.clientId === conn.clientId) {
              clients.delete(other);
              try {
                other.socket.close(4000, 'Replaced by new run');
              } catch {
                // ignore close errors
              }
            }
          }
          if (ev.sPts > 0 || ev.deliveries > 0) {
            const prevName = existingSession.name;
            const prevIsBot = conn.isBot;
            const cid = conn.clientId;
            void persistVehicleStats(cid, prevName, prevIsBot, ev, 0, nowMs);
          }
          if (spectateOnly) {
            removePlayerVehicle(world, conn.clientId);
          }
        }
      }
    }

    const canDrive =
      !spectateOnly &&
      countActiveDrivers() < MAX_DRIVERS &&
      countClientDrivers(conn.clientId) < MAX_DRIVERS_PER_CLIENT;

    if (canDrive) {
      const vehicle = spawnPlayerVehicle(world, {
        clientId: conn.clientId,
        name: conn.name,
        isBot: conn.isBot,
        ...(payload.runMode ? { runMode: payload.runMode } : {}),
      });
      if (vehicle) {
        applyCarryOverToVehicle(conn, vehicle, payload);
        conn.vid = vehicle.id;
        conn.role = 'driver';
        conn.playerId = vehicle.playerOpaqueId || `P${world.nextPlayerSeq}`;
      } else {
        conn.vid = null;
        conn.role = 'spectator';
        conn.playerId = `P${++world.nextPlayerSeq}`;
      }
    } else {
      conn.vid = null;
      conn.role = 'spectator';
      conn.playerId = `P${++world.nextPlayerSeq}`;
    }

    conn.trafficLayer = false;
    sendTo(conn.socket, buildWelcome(conn));

    sendTo(conn.socket, {
      type: 'phase',
      phase: world.phase,
      resumesAt:
        world.phase === 'resuming'
          ? nowMs + Math.round(world.resumeCountdown * 1000)
          : undefined,
    });

    const healthMsg = brainScheduler.getBrainHealthMessage(
      nowMs,
      nlPipeline.getArmorBlocks1h(nowMs),
    );
    sendTo(conn.socket, healthMsg);

    if (conn.isBot && clients.size > 4) {
      schedulePresenceBroadcast();
    } else {
      broadcast(buildPresenceMessage());
    }
    scheduleHeartbeatFlush();
    return true;
  }

  async function handleClientMessage(
    conn: ConnectedClient,
    rawData: RawData,
  ): Promise<void> {
    const nowMs = Date.now();
    const buf = Buffer.isBuffer(rawData)
      ? rawData
      : Array.isArray(rawData)
        ? Buffer.concat(rawData)
        : Buffer.from(rawData);

    const sizeCheck = checkFrameSize(buf, MAX_WS_FRAME_BYTES);
    if (!sizeCheck.ok) {
      clients.delete(conn);
      sendTo(conn.socket, {
        type: 'error',
        code: sizeCheck.code,
        message: sizeCheck.message,
      });
      conn.socket.close(1009, sizeCheck.message);
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(buf.toString('utf8'));
    } catch {
      sendTo(conn.socket, {
        type: 'error',
        code: 'bad_json',
        message: 'WebSocket frame must be valid JSON.',
      });
      return;
    }

    const candidate = parsedJson as Record<string, unknown> | null;
    let msg: ReturnType<typeof ClientMessageSchema.parse>;
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      candidate.type === 'input' &&
      typeof candidate.seq === 'number' &&
      Number.isInteger(candidate.seq) &&
      candidate.seq >= 0 &&
      typeof candidate.up === 'boolean' &&
      typeof candidate.down === 'boolean' &&
      typeof candidate.left === 'boolean' &&
      typeof candidate.right === 'boolean' &&
      (candidate.boost === undefined || typeof candidate.boost === 'boolean')
    ) {
      msg = {
        type: 'input',
        seq: candidate.seq,
        up: candidate.up,
        down: candidate.down,
        left: candidate.left,
        right: candidate.right,
        ...(candidate.boost !== undefined ? { boost: candidate.boost } : {}),
      };
    } else {
      const validated = ClientMessageSchema.safeParse(parsedJson);
      if (!validated.success) {
        sendTo(conn.socket, {
          type: 'error',
          code: 'invalid_message',
          message: validated.error.issues[0]?.message || 'Invalid message schema',
        });
        return;
      }
      msg = validated.data;
    }

    if (msg.type === 'hello') {
      if (!conn.authenticated) {
        authenticateConnection(conn, msg.ticket, false, nowMs);
      } else {
        const verified = verifyTicket(msg.ticket, ticketSecret, nowMs);
        if (verified.ok && verified.payload.siteId === siteId && verified.payload.clientId === conn.clientId) {
          const nameCheck = validateDisplayName(verified.payload.name);
          if (nameCheck.ok) {
            conn.name = nameCheck.name;
            for (const c of clients) {
              if (c.authenticated && c.clientId === conn.clientId) {
                c.name = nameCheck.name;
              }
            }
            const session = world.players.get(conn.clientId);
            if (session) session.name = nameCheck.name;
            for (const v of world.vehicles) {
              if (v.controlledByClientId === conn.clientId || v.ownerClientId === conn.clientId || (conn.vid && v.id === conn.vid)) {
                v.driver = nameCheck.name;
              }
            }
          }
          if (verified.payload.runMode) {
            setDriverRunMode(world, conn.clientId, verified.payload.runMode);
          }
        }
        sendTo(conn.socket, buildWelcome(conn));
        broadcast(buildPresenceMessage());
      }
      return;
    }

    if (!conn.authenticated) {
      clients.delete(conn);
      sendTo(conn.socket, {
        type: 'error',
        code: 'unauthorized',
        message: 'Authenticate with a valid ticket before sending commands.',
      });
      conn.socket.close(4003, 'Unauthenticated');
      return;
    }

    lastHumanActiveAtMs = nowMs;

    switch (msg.type) {
      case 'input': {
        conn.lastInputAtMs = nowMs;
        conn.lastInputSeq = msg.seq;
        const v = conn.vid
          ? world.vehicles.find((x) => x.id === conn.vid && x.human)
          : null;
        if (v) {
          const anyKeyPressed = Boolean(
            msg.up || msg.down || msg.left || msg.right || msg.boost,
          );
          if (v.autopilot && anyKeyPressed) {
            setVehicleAutopilot(
              world,
              v,
              false,
              'Manual WASD override — Co-Pilot paused',
            );
          }
          if (!v.autopilot) {
            v.input = {
              up: msg.up,
              down: msg.down,
              left: msg.left,
              right: msg.right,
              boost: Boolean(msg.boost),
            };
          }
        }
        sendTo(conn.socket, {
          type: 'ack',
          seq: msg.seq,
          t: Math.round(world.t * 100) / 100,
          x: v ? Math.round(v.px * 10000) / 10000 : undefined,
          y: v ? Math.round(v.py * 10000) / 10000 : undefined,
          angle: v ? Math.round(v.angle * 10000) / 10000 : undefined,
          speedNow: v ? Math.round(v.speedNow * 10000) / 10000 : undefined,
        });
        break;
      }

      case 'layers': {
        conn.trafficLayer = msg.traffic;
        if (msg.traffic) conn.lastHeatSentAtMs = undefined;
        break;
      }

      case 'interact': {
        conn.lastInputAtMs = nowMs;
        if (conn.vid) {
          humanInteract(world, conn.vid);
        }
        break;
      }

      case 'takeWheel': {
        if (
          conn.role !== 'driver' &&
          (countActiveDrivers() >= MAX_DRIVERS ||
            countClientDrivers(conn.clientId) >= MAX_DRIVERS_PER_CLIENT)
        ) {
          sendTo(conn.socket, {
            type: 'error',
            code: 'driver_cap_reached',
            message: 'Driver cap reached (max 32 per site, 2 per client).',
          });
          return;
        }
        const err = takeWheel(world, conn.clientId, conn.name, msg.vid);
        if (err) {
          sendTo(conn.socket, {
            type: 'error',
            code: 'take_wheel_failed',
            message: err,
          });
          return;
        }
        conn.vid = msg.vid;
        conn.role = 'driver';
        conn.lastInputAtMs = nowMs;
        broadcast(buildPresenceMessage());
        scheduleHeartbeatFlush();
        break;
      }

      case 'release': {
        releaseWheel(world, conn.clientId);
        const session = world.players.get(conn.clientId);
        conn.vid = session?.dedicatedVehicleId ?? null;
        conn.role = conn.vid ? 'driver' : 'spectator';
        broadcast(buildPresenceMessage());
        scheduleHeartbeatFlush();
        break;
      }

      case 'manager': {
        const res = governor.executeManagerOp(
          world,
          conn.clientId,
          msg.op,
          { x: msg.x, y: msg.y, dispatch: msg.dispatch },
          nowMs,
        );
        if (!res.ok) {
          sendTo(conn.socket, {
            type: 'error',
            code: res.code,
            message: res.message,
          });
        } else if (msg.op === 'dispatch') {
          const disp = msg.dispatch ?? {
            sourceZone: 'haz',
            targetBay: 'RET',
            priority: 'rush',
            mode: 'nearest',
            count: 2,
          };
          sendTo(conn.socket, {
            type: 'commandEcho',
            text: `Dispatch ${disp.sourceZone.toUpperCase()} → ${disp.targetBay}`,
            parsed: {
              action: 'dispatch',
              dispatch: disp,
              echo: res.message,
            },
            executed: true,
          });
        }
        break;
      }

      case 'keepCards': {
        const err = keepCards(world, conn.clientId, msg.ids);
        if (err) {
          sendTo(conn.socket, {
            type: 'error',
            code: 'keep_cards_failed',
            message: err,
          });
        }
        break;
      }

      case 'setRunMode': {
        setDriverRunMode(world, conn.clientId, msg.mode);
        broadcastDelta(pendingEvents.splice(0), true, nowMs);
        break;
      }

      case 'acceptRelocation': {
        const toSite = msg.toSite ?? msg.targetSite;
        if (!toSite || toSite === siteId) {
          sendTo(conn.socket, {
            type: 'error',
            code: 'same_site',
            message: `Already connected to ${siteId}.`,
          });
          break;
        }
        const v = conn.vid
          ? world.vehicles.find((x) => x.id === conn.vid)
          : world.vehicles.find(
              (x) =>
                x.ownerClientId === conn.clientId ||
                x.controlledByClientId === conn.clientId,
            );
        const carryPts = Math.round(v ? v.sPts : 0);
        const carryDeliveries = v ? v.deliveries : 0;
        const carryStreak = v ? (v.streak ?? 0) : 0;
        const hand = world.cards[conn.clientId];
        const carryCards: string[] = [];
        if (hand?.cards) {
          for (const c of hand.cards) {
            if (c.status !== 'active' && c.status !== 'done') continue;
            carryCards.push(c.status === 'done' ? `done:${c.title}` : c.title);
          }
        }

        if (v) {
          await persistVehicleStats(
            conn.clientId,
            conn.name,
            conn.isBot,
            v,
            RELOCATION_BONUS_PTS,
            nowMs,
          );
        }

        const ticket = signTicket(
          {
            clientId: conn.clientId,
            name: conn.name,
            siteId: toSite,
            exp: nowMs + 60_000,
            isBot: conn.isBot,
            runMode: 'freerange',
            carryPts,
            carryDeliveries,
            carryStreak,
            carryCards,
            relocationBonus: RELOCATION_BONUS_PTS,
          },
          ticketSecret,
        );

        removePlayerVehicle(world, conn.clientId);
        for (const c of clients) {
          if (c.authenticated && c.clientId === conn.clientId) {
            c.vid = null;
            c.role = 'spectator';
          }
        }

        sendTo(conn.socket, {
          type: 'relocateShard',
          toSite,
          siteId: toSite,
          wsUrl: `/ws?site=${toSite}`,
          ticket,
          bonusPts: RELOCATION_BONUS_PTS,
        });
        broadcast(buildPresenceMessage());
        scheduleHeartbeatFlush();
        break;
      }

      case 'voteDifficulty': {
        const res = governor.executeVoteDifficulty(
          world,
          conn.clientId,
          msg.level,
          nowMs,
        );
        if (!res.ok) {
          sendTo(conn.socket, {
            type: 'error',
            code: res.code,
            message: res.message,
          });
        }
        break;
      }

      case 'nlCommand': {
        const res = await nlPipeline.executeNlCommand({
          world,
          clientId: conn.clientId,
          ip: conn.ip,
          rawText: msg.text,
          nowMs,
        });
        sendTo(conn.socket, res.echo);
        if (res.a2ui) {
          sendTo(conn.socket, res.a2ui);
        }
        broadcast(
          brainScheduler.getBrainHealthMessage(
            nowMs,
            nlPipeline.getArmorBlocks1h(nowMs),
          ),
        );
        break;
      }

      case 'agentCommand': {
        conn.lastInputAtMs = nowMs;
        let v: Vehicle | undefined;
        if (msg.vid) {
          const candidate = world.vehicles.find((x) => x.id === msg.vid);
          if (!candidate) {
            sendTo(conn.socket, {
              type: 'error',
              code: 'vehicle_not_found',
              message: `Vehicle ${msg.vid} not found.`,
            });
            return;
          }
          const isOwnedOrControlled =
            candidate.ownerClientId === conn.clientId ||
            candidate.controlledByClientId === conn.clientId ||
            conn.vid === candidate.id;
          if (!isOwnedOrControlled) {
            if (!candidate.human && !candidate.isPlayerVehicle) {
              const err = takeWheel(world, conn.clientId, conn.name, candidate.id);
              if (err) {
                sendTo(conn.socket, {
                  type: 'error',
                  code: 'take_wheel_failed',
                  message: err,
                });
                return;
              }
              conn.vid = candidate.id;
              conn.role = 'driver';
              broadcast(buildPresenceMessage());
            } else {
              sendTo(conn.socket, {
                type: 'error',
                code: 'not_your_vehicle',
                message: `Vehicle ${candidate.id} is controlled by another driver.`,
              });
              return;
            }
          }
          v = candidate;
        } else {
          const session = world.players.get(conn.clientId);
          const targetId = conn.vid ?? session?.dedicatedVehicleId ?? null;
          v = targetId
            ? world.vehicles.find((x) => x.id === targetId)
            : world.vehicles.find(
                (x) =>
                  x.ownerClientId === conn.clientId ||
                  x.controlledByClientId === conn.clientId,
              );
        }

        if (!v) {
          sendTo(conn.socket, {
            type: 'error',
            code: 'no_active_vehicle',
            message: 'Take the wheel of a vehicle before sending Co-Pilot commands.',
          });
          return;
        }

        // Natural-language Co-Pilot instruction routed through 7-layer Prompt Armor + Gemini 3.5 Flash-Lite
        if (msg.text && msg.text.trim().length > 0) {
          const res = await nlPipeline.executeAgentCommand({
            world,
            vehicle: v,
            clientId: conn.clientId,
            ip: conn.ip,
            rawText: msg.text,
            nowMs,
          });
          if (res.ok && res.executed) {
            if (res.directive) {
              applyAgentDirective(world, v, res.directive);
            }
            if (res.mode === 'manual') {
              setVehicleAutopilot(
                world,
                v,
                false,
                res.message || 'Manual WASD control engaged',
              );
            } else if (res.mode === 'autopilot' && !res.directive) {
              setVehicleAutopilot(
                world,
                v,
                true,
                res.message || 'Co-Pilot autopilot engaged',
              );
            }
            res.echo.directive = v.directive ?? res.directive;
          }
          sendTo(conn.socket, res.echo);
          broadcastDelta(pendingEvents.splice(0), true, nowMs);
          broadcast(
            brainScheduler.getBrainHealthMessage(
              nowMs,
              nlPipeline.getArmorBlocks1h(nowMs),
            ),
          );
          break;
        }

        // Structured Agent Designer directive update and/or mode toggle
        if (msg.directive) {
          const applied = applyAgentDirective(world, v, msg.directive);
          if (msg.mode === 'manual') {
            setVehicleAutopilot(world, v, false, 'Manual WASD control engaged');
          }
          sendTo(conn.socket, {
            type: 'commandEcho',
            text:
              applied?.summary ||
              `Agent Designer [${v.id}]: ${v.strategy}${applied?.priority ? ` · ${applied.priority}` : ''}`,
            parsed: {
              action: msg.mode === 'manual' ? 'manual' : 'apply',
              vid: v.id,
              autopilot: Boolean(v.autopilot),
              echo: v.msg || `Applied Agent Designer config to ${v.id}`,
            },
            executed: true,
            directive: applied ?? undefined,
          });
          broadcastDelta(pendingEvents.splice(0), true, nowMs);
          break;
        }

        if (msg.mode) {
          const enable = msg.mode === 'autopilot';
          setVehicleAutopilot(world, v, enable);
          sendTo(conn.socket, {
            type: 'commandEcho',
            text: enable
              ? `Co-Pilot Autopilot ON (${v.id})`
              : `Manual WASD Control (${v.id})`,
            parsed: {
              action: msg.mode,
              vid: v.id,
              autopilot: Boolean(v.autopilot),
              echo:
                v.msg ||
                (enable
                  ? `Co-Pilot engaged on ${v.id}`
                  : `Manual control engaged on ${v.id}`),
            },
            executed: true,
            directive: v.directive ?? undefined,
          });
          broadcastDelta(pendingEvents.splice(0), true, nowMs);
          break;
        }

        break;
      }

      case 'a2uiAction': {
        if (msg.actionId === 'dismiss') {
          break;
        }
        if (msg.dispatch) {
          const res = governor.tryDispatch(
            world,
            conn.clientId,
            msg.dispatch,
            nowMs,
          );
          sendTo(conn.socket, {
            type: 'commandEcho',
            text: `A2UI Dispatch ${msg.dispatch.sourceZone.toUpperCase()} → ${msg.dispatch.targetBay}`,
            parsed: {
              action: 'dispatch',
              dispatch: msg.dispatch,
              echo: res.message,
            },
            executed: res.ok,
            reason: res.ok ? undefined : res.code,
          });
          break;
        }
        if (msg.managerOp) {
          const res = governor.executeManagerOp(
            world,
            conn.clientId,
            msg.managerOp,
            { dispatch: msg.dispatch },
            nowMs,
          );
          sendTo(conn.socket, {
            type: 'commandEcho',
            text: `A2UI ${msg.managerOp.toUpperCase()}`,
            parsed: {
              action: msg.managerOp as
                | 'rush'
                | 'reroute'
                | 'hold'
                | 'vip'
                | 'expand'
                | 'dispatch',
              echo: res.message,
            },
            executed: res.ok,
            reason: res.ok ? undefined : res.code,
          });
          break;
        }
        const screen = buildA2uiScreen(world, governor, conn.clientId, { nowMs });
        const matchedPreset = screen.presets.find((p) => p.id === msg.actionId);
        if (matchedPreset?.dispatch) {
          const res = governor.tryDispatch(
            world,
            conn.clientId,
            matchedPreset.dispatch,
            nowMs,
          );
          sendTo(conn.socket, {
            type: 'commandEcho',
            text: `A2UI ${matchedPreset.label}`,
            parsed: {
              action: 'dispatch',
              dispatch: matchedPreset.dispatch,
              echo: res.message,
            },
            executed: res.ok,
            reason: res.ok ? undefined : res.code,
          });
          break;
        }
        sendTo(conn.socket, screen);
        break;
      }

      case 'transferSite': {
        removePlayerVehicle(world, conn.clientId);
        for (const c of clients) {
          if (c.authenticated && c.clientId === conn.clientId) {
            c.vid = null;
            c.role = 'spectator';
          }
        }
        broadcast(buildPresenceMessage());
        scheduleHeartbeatFlush();
        break;
      }
    }
  }

  wss.on('connection', (socket: WebSocket, req) => {
    if (clients.size >= MAX_SOCKETS) {
      sendTo(socket, {
        type: 'error',
        code: 'site_full',
        message: `Site ${siteId} has reached the maximum of ${MAX_SOCKETS} connections.`,
      });
      socket.close(4008, 'Site full');
      return;
    }

    const url = new URL(req.url || '/ws', 'http://localhost');
    const ticketFromQuery = url.searchParams.get('ticket');
    const spectateOnly = url.searchParams.get('spectate') === '1';
    const forwardedFor = req.headers['x-forwarded-for'];
    const clientIp =
      (Array.isArray(forwardedFor)
        ? forwardedFor[0]
        : typeof forwardedFor === 'string'
          ? forwardedFor.split(',')[0]?.trim()
          : undefined) ||
      req.socket?.remoteAddress ||
      '127.0.0.1';

    const conn: ConnectedClient = {
      socket,
      authenticated: false,
      clientId: '',
      playerId: '',
      name: '',
      ip: clientIp,
      isBot: false,
      vid: null,
      role: 'spectator',
      connectedAtMs: Date.now(),
      lastInputAtMs: Date.now(),
      lastInputSeq: 0,
    };
    clients.add(conn);

    if (ticketFromQuery) {
      const ok = authenticateConnection(
        conn,
        ticketFromQuery,
        spectateOnly,
        Date.now(),
      );
      if (!ok) {
        clients.delete(conn);
        return;
      }
    } else {
      conn.authTimer = setTimeout(() => {
        if (!conn.authenticated) {
          sendTo(socket, {
            type: 'error',
            code: 'auth_timeout',
            message: 'Authentication timed out waiting for hello ticket.',
          });
          socket.close(4003, 'Auth timeout');
        }
      }, 5_000);
      conn.authTimer.unref?.();
    }

    socket.on('message', (data) => {
      void handleClientMessage(conn, data);
    });

    socket.on('close', () => {
      if (conn.authTimer) {
        clearTimeout(conn.authTimer);
      }
      const wasTracked = clients.delete(conn);
      if (!wasTracked) return;
      if (conn.authenticated && conn.clientId) {
        // Check if this client still has any other active driver socket
        const stillConnected = Array.from(clients).some(
          (c) => c.authenticated && c.clientId === conn.clientId,
        );
        if (!stillConnected) {
          const v = world.vehicles.find(
            (x) =>
              x.ownerClientId === conn.clientId ||
              x.controlledByClientId === conn.clientId,
          );
          if (v && (v.sPts > 0 || v.deliveries > 0)) {
            void persistVehicleStats(
              conn.clientId,
              conn.name,
              conn.isBot,
              v,
              0,
              Date.now(),
            );
          }
          removePlayerVehicle(world, conn.clientId);
        }
        broadcast(buildPresenceMessage());
        scheduleHeartbeatFlush();
      }
    });
  });

  function hasValidProxyHeader(
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    const raw = headers[PROXY_HEADER_NAME];
    const token = Array.isArray(raw) ? raw[0] : raw;
    return verifyProxyHeader(token, siteId, ticketSecret);
  }

  // Attach HTTP Upgrade handler for /ws
  app.server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/ws') {
      if (requireProxyAuth && !hasValidProxyHeader(request.headers)) {
        socket.write(
          'HTTP/1.1 403 Forbidden\r\n' +
            'Content-Type: application/json\r\n' +
            'Connection: close\r\n\r\n' +
            '{"ok":false,"error":"Direct backend access is forbidden; connect via warehouse-lobby gateway"}\r\n',
        );
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // ============================================================================
  // HTTP Routes
  // ============================================================================

  app.get('/healthz', async () => {
    const nowMs = Date.now();
    const drivers = countActiveDrivers();
    const totalAuth = countConnectedSockets();
    return {
      ok: true,
      siteId,
      t: world.t,
      phase: world.phase,
      tier: world.tier,
      drivers,
      spectators: Math.max(0, totalAuth - drivers),
      shipped: world.totals.shipped,
      brainHealth: brainScheduler.getBrainHealthMessage(
        nowMs,
        nlPipeline.getArmorBlocks1h(nowMs),
      ),
    };
  });

  app.get('/api/state', async (req, reply) => {
    if (requireProxyAuth && !hasValidProxyHeader(req.headers)) {
      return reply.code(403).send({
        ok: false,
        error: 'Direct backend access is forbidden; use warehouse-lobby gateway',
      });
    }
    const nowMs = Date.now();
    return {
      ok: true,
      siteId,
      snapshot: snapshotForRecipient(world, null),
      presence: buildPresenceMessage().players,
      brainHealth: brainScheduler.getBrainHealthMessage(
        nowMs,
        nlPipeline.getArmorBlocks1h(nowMs),
      ),
    };
  });

  app.get('/api/status', async (req, reply) => {
    if (requireProxyAuth && !hasValidProxyHeader(req.headers)) {
      return reply.code(403).send({
        ok: false,
        error: 'Direct backend access is forbidden; use warehouse-lobby gateway',
      });
    }
    const nowMs = Date.now();
    const drivers = countActiveDrivers();
    const totalAuth = countConnectedSockets();
    return {
      ok: true,
      siteId,
      phase: world.phase,
      drivers,
      spectators: Math.max(0, totalAuth - drivers),
      snapshot: snapshotForRecipient(world, null),
      brainHealth: brainScheduler.getBrainHealthMessage(
        nowMs,
        nlPipeline.getArmorBlocks1h(nowMs),
      ),
    };
  });

  app.post('/api/ticket', async (req, reply) => {
    if (
      (requireProxyAuth ||
        process.env.NODE_ENV === 'production' ||
        Boolean(process.env.K_SERVICE)) &&
      !hasValidProxyHeader(req.headers)
    ) {
      return reply.code(403).send({
        ok: false,
        error: 'Direct ticket minting is disabled in production; use POST /api/join on warehouse-lobby',
      });
    }
    const body = (req.body || {}) as {
      clientId?: string;
      name?: string;
      isBot?: boolean;
    };
    const clientId = String(body.clientId || '').trim();
    const rawName = String(body.name || '').trim();
    const isBot = Boolean(body.isBot);
    if (!clientId) {
      return reply.code(400).send({ ok: false, error: 'Missing clientId' });
    }
    const nameCheck = validateDisplayName(rawName, { allowBotPrefix: isBot });
    if (!nameCheck.ok) {
      return reply.code(400).send({
        ok: false,
        code: nameCheck.code,
        error: nameCheck.message,
      });
    }
    const nowMs = Date.now();
    const ticket = signTicket(
      {
        clientId,
        name: nameCheck.name,
        siteId,
        exp: nowMs + 60_000,
        isBot,
      },
      ticketSecret,
    );
    return {
      ok: true,
      ticket,
      siteId,
      name: nameCheck.name,
    };
  });

  app.get('/api/journal', async (req, reply) => {
    if (requireProxyAuth && !hasValidProxyHeader(req.headers)) {
      return reply.code(403).send({
        ok: false,
        error: 'Direct backend access is forbidden; use warehouse-lobby gateway',
      });
    }
    const query = (req.query || {}) as { limit?: string };
    const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
    const persisted = await persistence.getJournal(siteId, limit);
    return {
      ok: true,
      siteId,
      journal: world.decisionJournal.slice(-limit),
      persisted,
    };
  });

  app.post('/internal/transfer', async (req, reply) => {
    const hasBearerToken =
      typeof req.headers.authorization === 'string' &&
      req.headers.authorization.startsWith('Bearer ');
    if (requireProxyAuth && !hasValidProxyHeader(req.headers) && !hasBearerToken) {
      return reply.code(403).send({
        ok: false,
        error: 'Unauthorized internal transfer request',
      });
    }
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ ok: false, error: 'Invalid request body' });
    }

    let rawTransfer: unknown = body;
    // Unwrap Pub/Sub push envelope if present: { message: { data: "<base64>" } }
    if (
      'message' in body &&
      body.message &&
      typeof body.message === 'object' &&
      'data' in body.message &&
      typeof (body.message as { data?: unknown }).data === 'string'
    ) {
      try {
        const decoded = Buffer.from(
          (body.message as { data: string }).data,
          'base64',
        ).toString('utf8');
        rawTransfer = JSON.parse(decoded);
      } catch {
        return reply
          .code(400)
          .send({ ok: false, error: 'Malformed base64 Pub/Sub message.data' });
      }
    }

    if (rawTransfer && typeof rawTransfer === 'object') {
      const candidate = rawTransfer as Record<string, unknown>;
      if (typeof candidate.orderRef === 'number') {
        candidate.orderRef = String(candidate.orderRef);
      }
    }

    const parsed = TransferSchema.safeParse(rawTransfer);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: 'Invalid Transfer payload',
        issues: parsed.error.issues,
      });
    }

    const transfer = parsed.data;
    if (transfer.toSite !== siteId) {
      return reply.code(202).send({
        ok: true,
        ignored: true,
        reason: `Transfer is addressed to ${transfer.toSite}, not ${siteId}`,
      });
    }

    const createdOrder = receiveTransfer(world, transfer);
    return reply.code(200).send({
      ok: true,
      duplicate: createdOrder === null,
      orderId: createdOrder?.id ?? null,
      transfersIn: world.totals.transfersIn,
    });
  });

  app.post('/internal/wake', async (req, reply) => {
    if (requireProxyAuth && !hasValidProxyHeader(req.headers)) {
      return reply.code(403).send({
        ok: false,
        error: 'Unauthorized internal wake request',
      });
    }
    const body = (req.body || {}) as { immediate?: boolean };
    lastHumanActiveAtMs = Date.now();
    windingDownStartedAtMs = null;

    if (body.immediate) {
      setPhase(world, 'running');
    } else if (world.phase === 'break' || world.phase === 'winding_down') {
      setPhase(world, 'resuming');
    }

    lastBroadcastPhase = world.phase;
    broadcast({
      type: 'phase',
      phase: world.phase,
      resumesAt:
        world.phase === 'resuming'
          ? Date.now() + Math.round(world.resumeCountdown * 1000)
          : undefined,
    });
    await flushHeartbeat();

    return {
      ok: true,
      siteId,
      phase: world.phase,
      resumeCountdown: world.resumeCountdown,
    };
  });

  // ============================================================================
  // Background Intervals (10 Hz Tick, 5s Heartbeat, 10s Relocation Sweep, 30s Snapshot)
  // ============================================================================

  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let relocationSweepTimer: ReturnType<typeof setInterval> | null = null;
  let snapshotTimer: ReturnType<typeof setInterval> | null = null;

  let tickInFlight = false;
  if (options.enableIntervals) {
    void flushHeartbeat(Date.now());
    void flushSnapshot(Date.now());

    let lastTickWallMs = Date.now();
    tickTimer = setInterval(() => {
      if (tickInFlight) return;
      const now = Date.now();
      const elapsedMs = now - lastTickWallMs;
      const dueTicks = Math.min(3, Math.max(1, Math.floor(elapsedMs / 100)));
      lastTickWallMs = elapsedMs >= 100 ? lastTickWallMs + dueTicks * 100 : now;
      if (now - lastTickWallMs > 300) {
        lastTickWallMs = now;
      }
      tickInFlight = true;
      void (async () => {
        for (let i = 0; i < dueTicks; i++) {
          await stepTick(Date.now(), true);
        }
      })().finally(() => {
        tickInFlight = false;
      });
    }, 100);
    tickTimer.unref?.();

    heartbeatTimer = setInterval(() => {
      void flushHeartbeat(Date.now());
      broadcast(
        brainScheduler.getBrainHealthMessage(
          Date.now(),
          nlPipeline.getArmorBlocks1h(),
        ),
      );
    }, 5_000);
    heartbeatTimer.unref?.();

    relocationSweepTimer = setInterval(() => {
      if (world.phase === 'running') {
        void checkSurgeRelocation(Date.now());
      }
    }, 10_000);
    relocationSweepTimer.unref?.();

    snapshotTimer = setInterval(() => {
      if (world.phase === 'running') {
        void flushSnapshot(Date.now());
      }
    }, 30_000);
    snapshotTimer.unref?.();
  }

  async function gracefulShutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    if (tickTimer) clearInterval(tickTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (relocationSweepTimer) clearInterval(relocationSweepTimer);
    if (snapshotTimer) clearInterval(snapshotTimer);
    if (pendingHeartbeatFlushTimer) {
      clearTimeout(pendingHeartbeatFlushTimer);
      pendingHeartbeatFlushTimer = null;
    }
    if (pendingPresenceTimer) {
      clearTimeout(pendingPresenceTimer);
      pendingPresenceTimer = null;
    }

    await flushSnapshot(Date.now());
    await flushHeartbeat(Date.now());

    for (const c of clients) {
      if (c.authTimer) clearTimeout(c.authTimer);
      try {
        c.socket.close(4001, 'Server shutting down; reconnect');
      } catch {
        // Ignore socket close errors on shutdown
      }
    }
    clients.clear();

    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await app.close();
  }

  return {
    app,
    wss,
    world,
    siteId,
    persistence,
    governor,
    guard,
    strikes: guard,
    brainScheduler,
    nlPipeline,
    clients,
    stepTick,
    checkFactoryBreakPhase,
    checkSurgeRelocation,
    flushSnapshot,
    flushHeartbeat,
    broadcast,
    gracefulShutdown,
    close: gracefulShutdown,
  };
}
