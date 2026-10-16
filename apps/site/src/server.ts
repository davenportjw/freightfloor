import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  ClientMessageSchema,
  MAX_WS_FRAME_BYTES,
  TransferSchema,
  signTicket,
  verifyTicket,
  quantiseCoord,
  type SiteId,
  type ServerMessage,
  type DeltaMessage,
  type PresenceMessage,
  type QuantisedVehicleDelta,
  type Transfer,
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
  takeWheel,
  release,
  releaseWheel,
  humanInteract,
  keepCards,
  receiveTransfer,
  setPhase,
  compactFacilityIfNeeded,
  guide,
  interactAt,
  postOrder,
  type World,
  type SimEvent,
} from '@warehouse/sim';
import {
  InMemoryPersistenceStore,
  type PersistenceStore,
} from './persistence.js';
import { FacilityGovernor } from './governance.js';
import {
  AgentBrainScheduler,
  VertexGeminiBrainClient,
  type GeminiBrainClient,
} from './brain.js';
import {
  NlOrderPipeline,
  CloudModelArmorClient,
  VertexNlOrderParser,
  type ModelArmorClient,
  type NlOrderParserClient,
} from './armor-pipeline.js';

export const MAX_SOCKETS = 300;
export const MAX_DRIVERS = 32;
export const MAX_DRIVERS_PER_CLIENT = 2;
export const DEFAULT_INPUT_LEASE_MS = 5_000;
export const DEFAULT_IDLE_BREAK_MS = 5 * 60 * 1000;
export const DEFAULT_WIND_DOWN_MAX_MS = 60_000;
export const DEFAULT_TICKET_SECRET =
  process.env.TICKET_SECRET ||
  process.env.TICKET_HMAC_KEY ||
  process.env.TICKET_HMAC_SECRET ||
  'dev-local-warehouse-hmac-secret-key-2026';

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
  connectedAtMs: number;
  lastInputAtMs: number;
  lastInputSeq: number;
  authTimer?: ReturnType<typeof setTimeout>;
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
  stepTick: (nowMs?: number) => Promise<void>;
  checkFactoryBreakPhase: (nowMs?: number) => Promise<void>;
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
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
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
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
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
    let count = 0;
    for (const c of clients) {
      if (c.authenticated && c.role === 'driver' && c.vid) {
        count++;
      }
    }
    return count;
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

  function buildPresenceMessage(): PresenceMessage {
    const players = Array.from(clients)
      .filter((c) => c.authenticated)
      .map((c) => {
        const v = c.vid ? world.vehicles.find((x) => x.id === c.vid) : null;
        const pts = v ? Math.round(v.bank + v.sPts) : 0;
        return {
          clientId: c.clientId,
          playerId: c.playerId,
          name: c.name,
          vid: c.vid,
          points: pts,
          score: pts,
          role: c.role,
          isBot: c.isBot,
        };
      });
    return {
      type: 'presence',
      players,
    };
  }

  function buildDeltaMessage(
    events: SimEvent[],
    includeFullState: boolean = true,
    includeHands: boolean = true,
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
          cargoCount: v.cargo.length,
          sShipped: Math.max(v.sShipped, v.deliveries),
          sPts: Math.round(v.sPts),
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

      const needGuide = v.human && (!v.isBot || clients.size <= 8 || bgTickCount % 10 === 0);
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
      stats: {
        totals: world.totals,
        day: world.day,
        shift: world.shift,
        shiftTime: world.shiftTime,
        rushUntil: world.rushUntil,
      },
      votes: world.difficultyVotes,
      ...(includeHands ? { hands: world.cards } : {}),
      difficulty: world.difficulty,
      tier: world.tier,
    };
  }

  function difficultyNumber(diff: World['difficulty']): number {
    if (diff === 'calm' || diff === 'easy') return 1;
    if (diff === 'normal') return 2;
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
    const totalAuth = countConnectedSockets();
    const spectators = Math.max(0, totalAuth - drivers);
    const openOrders = world.orders.filter((o) => o.state !== 'done').length;
    const agentCount = world.vehicles.filter(
      (v) => !v.human && !v.isPlayerVehicle,
    ).length;
    const driverClientIds = Array.from(clients)
      .filter((c) => c.authenticated && c.role === 'driver' && c.vid)
      .map((c) => c.clientId);
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

  function checkInputLeases(nowMs: number): void {
    let releasedAny = false;
    for (const c of clients) {
      if (!c.authenticated || !c.vid) continue;
      if (nowMs - c.lastInputAtMs > inputLeaseMs) {
        const v = world.vehicles.find((x) => x.id === c.vid);
        if (!v) continue;
        if (v.isPlayerVehicle) {
          v.input = { up: false, down: false, left: false, right: false };
        } else if (v.human) {
          release(world, v.id);
          const session = world.players.get(c.clientId);
          c.vid = session?.dedicatedVehicleId ?? null;
          releasedAny = true;
        }
      }
    }
    if (releasedAny) {
      broadcast(buildPresenceMessage());
    }
  }

  let backgroundDrainInFlight = false;
  let bgTickCount = 0;

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
      if (background) bgTickCount++;
      const includeFullState = !background || bgTickCount % 10 === 0;
      const includeHands = !background || connectedCount <= 8 || bgTickCount % 50 === 0;
      broadcast(buildDeltaMessage(eventsToBroadcast, includeFullState, includeHands));
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

    const canDrive =
      !spectateOnly &&
      countActiveDrivers() < MAX_DRIVERS &&
      countClientDrivers(conn.clientId) < MAX_DRIVERS_PER_CLIENT;

    if (canDrive) {
      const vehicle = spawnPlayerVehicle(world, {
        clientId: conn.clientId,
        name: conn.name,
        isBot: conn.isBot,
      });
      if (vehicle) {
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

    sendTo(conn.socket, {
      type: 'welcome',
      you: {
        clientId: conn.clientId,
        playerId: conn.playerId,
        name: conn.name,
        vid: conn.vid,
        siteId,
        isBot: conn.isBot,
      },
      snapshot: serialize(world),
    });

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

    broadcast(buildPresenceMessage());
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

    const validated = ClientMessageSchema.safeParse(parsedJson);
    if (!validated.success) {
      sendTo(conn.socket, {
        type: 'error',
        code: 'invalid_message',
        message: validated.error.issues[0]?.message || 'Invalid message schema',
      });
      return;
    }

    const msg = validated.data;

    if (msg.type === 'hello') {
      if (!conn.authenticated) {
        authenticateConnection(conn, msg.ticket, false, nowMs);
      } else {
        sendTo(conn.socket, {
          type: 'welcome',
          you: {
            clientId: conn.clientId,
            playerId: conn.playerId,
            name: conn.name,
            vid: conn.vid,
            siteId,
            isBot: conn.isBot,
          },
          snapshot: serialize(world),
        });
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
          v.input = {
            up: msg.up,
            down: msg.down,
            left: msg.left,
            right: msg.right,
          };
        }
        sendTo(conn.socket, {
          type: 'ack',
          seq: msg.seq,
          x: v ? Math.round(v.px * 100) / 100 : undefined,
          y: v ? Math.round(v.py * 100) / 100 : undefined,
          angle: v ? Math.round(v.angle * 1000) / 1000 : undefined,
          speedNow: v ? Math.round(v.speedNow * 100) / 100 : undefined,
        });
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
        break;
      }

      case 'release': {
        releaseWheel(world, conn.clientId);
        const session = world.players.get(conn.clientId);
        conn.vid = session?.dedicatedVehicleId ?? null;
        broadcast(buildPresenceMessage());
        break;
      }

      case 'manager': {
        const res = governor.executeManagerOp(
          world,
          conn.clientId,
          msg.op,
          { x: msg.x, y: msg.y },
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
        if (!res.ok) {
          sendTo(conn.socket, {
            type: 'error',
            code: res.code ?? 'parse_invalid',
            message: res.message ?? 'Order could not be executed.',
          });
        }
        broadcast(
          brainScheduler.getBrainHealthMessage(
            nowMs,
            nlPipeline.getArmorBlocks1h(nowMs),
          ),
        );
        break;
      }

      case 'transferSite': {
        removePlayerVehicle(world, conn.clientId);
        conn.vid = null;
        conn.role = 'spectator';
        broadcast(buildPresenceMessage());
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
      clients.delete(conn);
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
            void (async () => {
              const existing = await persistence.getPlayerStats(conn.clientId);
              await persistence.upsertPlayerStats({
                clientId: conn.clientId,
                name: conn.name,
                isBot: conn.isBot,
                totalDeliveries: (existing?.totalDeliveries ?? 0) + v.deliveries,
                totalScore: (existing?.totalScore ?? 0) + Math.round(v.sPts),
                shiftsPlayed: (existing?.shiftsPlayed ?? 0) + 1,
                lastSiteId: siteId,
                updatedAt: Date.now(),
              });
            })();
          }
          removePlayerVehicle(world, conn.clientId);
        }
        broadcast(buildPresenceMessage());
        scheduleHeartbeatFlush();
      }
    });
  });

  // Attach HTTP Upgrade handler for /ws
  app.server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/ws') {
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

  app.get('/api/state', async () => {
    const nowMs = Date.now();
    return {
      ok: true,
      siteId,
      snapshot: serialize(world),
      presence: buildPresenceMessage().players,
      brainHealth: brainScheduler.getBrainHealthMessage(
        nowMs,
        nlPipeline.getArmorBlocks1h(nowMs),
      ),
    };
  });

  app.get('/api/status', async () => {
    const nowMs = Date.now();
    const drivers = countActiveDrivers();
    const totalAuth = countConnectedSockets();
    return {
      ok: true,
      siteId,
      phase: world.phase,
      drivers,
      spectators: Math.max(0, totalAuth - drivers),
      snapshot: serialize(world),
      brainHealth: brainScheduler.getBrainHealthMessage(
        nowMs,
        nlPipeline.getArmorBlocks1h(nowMs),
      ),
    };
  });

  app.post('/api/ticket', async (req, reply) => {
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

  app.get('/api/journal', async (req) => {
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

  app.post('/internal/wake', async (req) => {
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
  // Background Intervals (10 Hz Tick, 5s Heartbeat, 30s Snapshot)
  // ============================================================================

  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let snapshotTimer: ReturnType<typeof setInterval> | null = null;

  let tickInFlight = false;
  if (options.enableIntervals) {
    void flushHeartbeat(Date.now());
    void flushSnapshot(Date.now());

    tickTimer = setInterval(() => {
      if (tickInFlight) return;
      tickInFlight = true;
      void stepTick(Date.now(), true).finally(() => {
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
    if (snapshotTimer) clearInterval(snapshotTimer);
    if (pendingHeartbeatFlushTimer) {
      clearTimeout(pendingHeartbeatFlushTimer);
      pendingHeartbeatFlushTimer = null;
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
    flushSnapshot,
    flushHeartbeat,
    broadcast,
    gracefulShutdown,
    close: gracefulShutdown,
  };
}
