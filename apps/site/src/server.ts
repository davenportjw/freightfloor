import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ClientMessageSchema,
  MAX_WS_FRAME_BYTES,
  PROXY_HEADER_NAME,
  SITE_IDS,
  TransferSchema,
  isValidSiteId,
  signTicket,
  verifyProxyHeader,
  verifyTicket,
  quantiseCoord,
  MAX_PATH_WAYPOINTS,
  HEAT_MIN_VALUE,
  HEAT_INTERVAL_MS,
  BOARD_INTERVAL_MS,
  DISPATCH_MAX_COUNT,
  type EvictionReason,
  type SiteId,
  type ServerMessage,
  type DeltaMessage,
  type DeltaStats,
  type FloorOrdersStatus,
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
  PLAYER_RATE_LIMIT_PER_MIN,
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
  recordCompletedRun,
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
  chooseOrder,
  computeDriverPpm,
  receiveTransfer,
  setPhase,
  compactFacilityIfNeeded,
  guide,
  interactAt,
  postOrder,
  board,
  BASE_FLEET,
  BLITZ_DURATION_MIN,
  FLEET_CAP,
  MAX_TIER,
  TICK_MIN,
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
  createPublicIdMapper,
  publicizeCompletedRuns,
  publicizeEvents,
  publicizeKeyedRecord,
  publicizeSnapshot,
} from './public-id.js';
import {
  CONE_EXPIRY_SEC,
  FacilityGovernor,
  MAX_AUTONOMOUS_AGENTS,
  MAX_CONES_PER_PLAYER,
  MAX_OPEN_P0_ON_FLOOR,
  MIN_AUTONOMOUS_AGENTS,
  SITE_TICK_MS,
} from './governance.js';
import {
  AgentBrainScheduler,
  VertexGeminiBrainClient,
  resolveGeminiModel,
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
import {
  DispatchersCallCoordinator,
  parseDispatchersCallActionId,
  parseDispatchersCallFlag,
  VertexDispatchersCallClient,
  type DispatchersCallModelClient,
} from './dispatchersCall.js';

export const MAX_SOCKETS = 300;
export const MAX_DRIVERS = 32;
export const FREE_RANGE_SOFT_CAP = 26;
export const RELOCATION_BONUS_PTS = 75;
export const RELOCATION_COOLDOWN_MS = 90_000;
/** One driver seat per clientId: a second tab of the same player joins as a spectator. */
export const MAX_DRIVERS_PER_CLIENT = 1;
/** Received cross-site transfer ids kept for de-duplication (FIFO; bounds the snapshot doc). */
export const MAX_RECEIVED_TRANSFER_IDS = 2_000;
/** Protocol-level WebSocket frame ceiling (memory guard); the app limit is `MAX_WS_FRAME_BYTES`. */
export const WS_MAX_PAYLOAD_BYTES = 64 * 1024;
export const DEFAULT_INPUT_LEASE_MS = 5_000;
export const DEFAULT_IDLE_EVICTION_MS = 60_000;
export const DEFAULT_IDLE_BREAK_MS = 5 * 60 * 1000;
export const DEFAULT_WIND_DOWN_MAX_MS = 60_000;
/** Min real ms between countdown-only `delta.floorOrders` refreshes per connection. */
export const FLOOR_ORDERS_INTERVAL_MS = 1_000;
/**
 * Ticket / proxy HMAC secret. Cloud Run must inject it via Secret Manager (startup refuses to
 * run otherwise, see `index.ts`). Off Cloud Run with no secret configured, a random
 * per-process secret is generated: tickets from any other process (e.g. a separately started
 * lobby) will not verify unless both share `TICKET_SECRET`.
 */
export const DEFAULT_TICKET_SECRET = resolveTicketSecret();

function resolveTicketSecret(): string {
  const configured =
    process.env.TICKET_SECRET || process.env.TICKET_HMAC_KEY || process.env.TICKET_HMAC_SECRET;
  if (configured) return configured;
  if (process.env.K_SERVICE) {
    // Never fall back to a guessable or ephemeral secret in Cloud Run.
    throw new Error(
      'TICKET_SECRET (or TICKET_HMAC_KEY) must be injected via Secret Manager in Cloud Run',
    );
  }
  console.warn(
    '[site] No TICKET_SECRET set: using an ephemeral random per-process dev secret. ' +
      'Set TICKET_SECRET (shared with the lobby) for multi-process local runs.',
  );
  return randomBytes(32).toString('hex');
}

/** Drop the oldest received-transfer ids (Set keeps insertion order) beyond `max`. */
export function pruneReceivedTransferIds(world: World, max: number = MAX_RECEIVED_TRANSFER_IDS): void {
  const ids = world.receivedTransferIds;
  if (ids.size <= max) return;
  let excess = ids.size - max;
  for (const id of ids) {
    if (excess-- <= 0) break;
    ids.delete(id);
  }
}

/**
 * Verifies a Pub/Sub push OIDC bearer token: Google-signed, `aud` = this endpoint's URL and
 * `email` = the push service account (`PUBSUB_PUSH_SERVICE_ACCOUNT`), with `email_verified`.
 */
/**
 * Accepted audiences for `/internal/transfer` push tokens: `TRANSFER_PUSH_AUDIENCE`
 * (comma-separated override) plus `https://<Host>/internal/transfer`.
 */
export function transferPushAudiences(
  host: string | undefined,
  override: string | undefined = process.env.TRANSFER_PUSH_AUDIENCE,
): string[] {
  const out = (override ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  if (host) out.push(`https://${host}/internal/transfer`);
  return [...new Set(out)];
}

export type TransferPushTokenVerifier = (
  token: string,
  audience: string | readonly string[],
) => Promise<boolean>;

/** Marker Cloud Run IAM writes over the JWT signature after it has verified the token itself. */
export const CLOUD_RUN_SIGNATURE_REMOVED = 'SIGNATURE_REMOVED_BY_GOOGLE';

const GOOGLE_ID_TOKEN_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

interface PushTokenClaims {
  email?: string;
  email_verified?: boolean | string;
  aud?: string | string[];
  exp?: number;
  iss?: string;
}

/** Minimal ID-token verifier surface (google-auth-library `OAuth2Client`). */
export interface IdTokenVerifierClient {
  verifyIdToken(opts: {
    idToken: string;
    audience: string | string[];
  }): Promise<{ getPayload(): PushTokenClaims | undefined }>;
}

export interface PubSubPushVerifierOptions {
  /** Clock for the Cloud Run pre-verified path (test seam). */
  now?: () => number;
  /** ID-token verifier for the full-signature path (test seam; default `new OAuth2Client()`). */
  client?: IdTokenVerifierClient;
}

function decodeJwtPayload(segment: string): PushTokenClaims | null {
  try {
    const json = Buffer.from(segment, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as PushTokenClaims) : null;
  } catch {
    return null;
  }
}

function claimsMatch(
  claims: PushTokenClaims,
  expectedEmail: string,
  audiences: readonly string[],
): boolean {
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  const auds = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  return (
    claims.email === expectedEmail && verified && auds.some((a) => audiences.includes(a))
  );
}

/**
 * Verifies the Pub/Sub push OIDC token on `/internal/transfer`.
 *
 * The site services are IAM-protected Cloud Run services: Cloud Run validates the
 * token at the platform layer and may replace its signature segment with
 * `SIGNATURE_REMOVED_BY_GOOGLE` before it reaches the container. In that case the
 * signature cannot be re-checked, so the claims are decoded and still required to
 * match (`email`, `email_verified`, `aud`, unexpired `exp`, Google issuer). Any
 * other token gets full `verifyIdToken` signature verification.
 */
export function createPubSubPushVerifier(
  expectedEmail: string | undefined = process.env.PUBSUB_PUSH_SERVICE_ACCOUNT,
  opts: PubSubPushVerifierOptions = {},
): TransferPushTokenVerifier {
  const now = opts.now ?? Date.now;
  let clientPromise: Promise<IdTokenVerifierClient> | null = opts.client
    ? Promise.resolve(opts.client)
    : null;
  return async (token, audience) => {
    if (!expectedEmail) {
      console.error('[site] PUBSUB_PUSH_SERVICE_ACCOUNT is not set; rejecting push token');
      return false;
    }
    const audiences = (typeof audience === 'string' ? [audience] : [...audience]).filter(Boolean);
    if (audiences.length === 0) return false;
    const parts = token.split('.');
    try {
      if (parts.length === 3 && parts[2] === CLOUD_RUN_SIGNATURE_REMOVED) {
        const claims = decodeJwtPayload(parts[1]);
        if (!claims) return false;
        const expMs = typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
        if (expMs <= now()) return false;
        if (claims.iss !== undefined && !GOOGLE_ID_TOKEN_ISSUERS.has(claims.iss)) return false;
        return claimsMatch(claims, expectedEmail, audiences);
      }
      clientPromise ??= import('google-auth-library').then(
        ({ OAuth2Client }) => new OAuth2Client() as unknown as IdTokenVerifierClient,
      );
      const client = await clientPromise;
      const ticket = await client.verifyIdToken({ idToken: token, audience: audiences });
      const payload = ticket.getPayload();
      return Boolean(payload && claimsMatch(payload, expectedEmail, audiences));
    } catch (err) {
      console.warn(
        `[site] Pub/Sub push token rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };
}

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
  maxOpenP0: MAX_OPEN_P0_ON_FLOOR,
  conesPerPlayer: MAX_CONES_PER_PLAYER,
  coneTtlGameMin: CONE_EXPIRY_SEC,
  dispatchMaxCount: DISPATCH_MAX_COUNT,
  nlPerMinute: PLAYER_RATE_LIMIT_PER_MIN,
  rackLiftMinigame: false,
  /** Default on; the welcome carries the live `ENABLE_DISPATCHERS_CALL` value. */
  dispatchersCall: true,
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

/** Inbound putaway guide extras: `stow` flag and the open cross-dock bay target (`alt`). */
export function guideExtras(g: {
  stow?: boolean;
  alt?: { x: number; y: number; bay: string; left: number } | null;
}): { stow?: true; alt?: { x: number; y: number; bay: string; left: number } } {
  return {
    ...(g.stow ? { stow: true as const } : {}),
    ...(g.alt ? { alt: { ...g.alt } } : {}),
  };
}

/**
 * Order-choice state for human drivers (sim `Vehicle.fareOffer` / `rivalId`). Order
 * options are public floor data; only the driver's own client acts on them.
 */
export function choiceStats(v: Vehicle): Pick<QuantisedVehicleDelta, 'fareOffer' | 'rivalId'> {
  if (!v.human || v.isBot) return {};
  const f = v.fareOffer;
  return {
    fareOffer: f
      ? {
          since: round2(f.since),
          options: f.options.map((o) => ({
            ...o,
            parEmpty: o.parEmpty === null ? null : round2(o.parEmpty),
            parLoaded: o.parLoaded === null ? null : round2(o.parLoaded),
          })),
          copilotId: f.copilotId,
          reason: f.reason,
          carpool: f.carpool,
        }
      : null,
    rivalId: v.rivalId ?? null,
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
  | 'fareOffer'
  | 'rivalId'
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
          ...choiceStats(v),
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
  ticketRole: 'driver' | 'spectator';
  ticketJti: string | null;
  evictedReason: EvictionReason | null;
  lastHumanActivityAt: number;
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
  /** JSON of the last `floorOrders` sent to this connection. */
  floorOrdersSentJson?: string;
  /** Player opted out of Dispatcher's Call via `dispatchersCallPref` (client override). */
  dispatchersCallOptOut?: boolean;
  /** Timer-insensitive signature (ready flags, counts, cone keys) of the last `floorOrders` sent. */
  floorOrdersSentShape?: string;
  /** Wall-clock ms the last `floorOrders` was sent to this connection. */
  floorOrdersSentAtMs?: number;
  /** True when the client sends sub-tick `dt` on `input` messages. */
  subTickClient?: boolean;
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
  idleEvictionMs?: number;
  evictOnRunComplete?: boolean;
  idleBreakThresholdMs?: number;
  windDownMaxMs?: number;
  restoreFromPersistence?: boolean;
  /**
   * When true (default in Cloud Run / production), rejects direct WebSocket upgrades
   * and internal HTTP requests that do not carry a valid `x-warehouse-proxy` HMAC header
   * from the frontend `warehouse-lobby` gateway.
   */
  requireProxyAuth?: boolean;
  /**
   * Opt-in feature flag for the Rack Height Fork-Lift Minigame (ENABLE_RACK_LIFT_MINIGAME).
   */
  enableRackLiftMinigame?: boolean;
  /**
   * Dispatcher's Call minigame (ENABLE_DISPATCHERS_CALL, default on; `0|false|off|no` disables).
   */
  enableDispatchersCall?: boolean;
  /** Gemini client for Dispatcher's Call (default: Vertex AI via ADC). */
  dispatchersCallClient?: DispatchersCallModelClient;
  /**
   * Verifies the Pub/Sub push OIDC bearer token on `/internal/transfer` (test seam).
   * Default: `createPubSubPushVerifier()` (google-auth-library `verifyIdToken`).
   */
  verifyTransferPushToken?: TransferPushTokenVerifier;
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
  annexServers: Map<SiteId, SiteServerInstance>;
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
  // Raw clientIds are bearer credentials at the lobby; every site → client payload carries the
  // opaque publicId instead (see `public-id.ts`). Default-deny: any key/owner that is not a live
  // vehicle id is treated as a possible clientId and hashed.
  const toPublicId = createPublicIdMapper(ticketSecret);
  const mayBeClientId = (key: string): boolean => !world.vehicles.some((v) => v.id === key);
  const requireProxyAuth =
    options.requireProxyAuth ??
    (Boolean(process.env.K_SERVICE) ||
      process.env.REQUIRE_PROXY_AUTH === '1' ||
      process.env.REQUIRE_PROXY_AUTH === 'true');
  const enableRackLiftMinigame =
    options.enableRackLiftMinigame ??
    (process.env.ENABLE_RACK_LIFT_MINIGAME === '1' ||
      process.env.ENABLE_RACK_LIFT_MINIGAME === 'true');
  const enableDispatchersCall = options.enableDispatchersCall ?? parseDispatchersCallFlag();
  // Fail loudly at startup if GEMINI_MODEL is not an allowed model.
  const geminiModel = resolveGeminiModel(process.env.GEMINI_MODEL);
  const verifyTransferPushToken = options.verifyTransferPushToken ?? createPubSubPushVerifier();
  const inputLeaseMs = options.inputLeaseMs ?? DEFAULT_INPUT_LEASE_MS;
  const idleEvictionMs = options.idleEvictionMs ?? DEFAULT_IDLE_EVICTION_MS;
  const evictOnRunComplete = options.evictOnRunComplete ?? true;
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
      const keepAlwaysWarm =
        process.env.IDLE_POLICY === 'warm' || process.env.IDLE_POLICY === 'run';
      if (keepAlwaysWarm && world.phase !== 'running') {
        setPhase(world, 'running');
      } else if (world.phase === 'break') {
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
  world.rackLiftMinigame = enableRackLiftMinigame;
  world.rackLiftMinigameKillSwitch = !enableRackLiftMinigame;

  if (options.enableIntervals && world.phase === 'running') {
    while (world.orders.filter((o) => o.state === 'open').length < 8) {
      if (!postOrder(world)) break;
    }
  }

  const app = Fastify({ logger: false });
  // Frames larger than the protocol cap are rejected by ws itself (close 1009) instead of
  // being buffered up to the 100 MiB default.
  // `maxPayload` is a hard memory guard against huge frames (ws closes those at the protocol
  // level). The 4 KB application limit stays in `checkFrameSize`, which replies with a
  // readable error and a clean 1009 close.
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });
  const clients = new Set<ConnectedClient>();
  const pendingEvents: SimEvent[] = [];
  const relocationCooldownUntil = new Map<string, number>();
  const persistedFinishedRuns = new Set<string>();
  const consumedTicketIds = new Map<string, number>();
  const annexServers = new Map<SiteId, SiteServerInstance>();
  const annexCreationPromises = new Map<SiteId, Promise<SiteServerInstance>>();

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
    // Best pallets per real minute over this player's runs (AI/bots never stored).
    const runPpm = v.human && !isBotFlag && (v.runDeliveries ?? 0) > 0 ? computeDriverPpm(world, v) : 0;
    const nextPpm = Math.max(existing?.ppm ?? 0, Number.isFinite(runPpm) ? runPpm : 0);
    await persistence.upsertPlayerStats({
      clientId: cid,
      name: playerName,
      isBot: isBotFlag,
      totalDeliveries: (existing?.totalDeliveries ?? 0) + v.deliveries,
      totalScore: (existing?.totalScore ?? 0) + score,
      ...(nextBestBlitz > 0 ? { bestBlitzPts: nextBestBlitz } : {}),
      ...(nextPpm > 0 ? { ppm: nextPpm } : {}),
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
      model: geminiModel,
    });

  const nlPipeline =
    options.nlPipeline ??
    new NlOrderPipeline({
      armorClient,
      parserClient: nlParser,
      governor,
      persistence,
      guard,
      // Armor journal stores HMAC-SHA256(ip) keyed by the ticket secret, never the raw IP.
      ipHashSalt: ticketSecret,
    });

  const brainClient =
    options.brainClient ??
    new VertexGeminiBrainClient({
      projectId: gcpProjectId,
      location: vertexLocation,
      model: geminiModel,
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

  /** Send to every authenticated connection driving vehicle `vid`. */
  function sendToVehicleDriver(vid: string, msg: ServerMessage): void {
    for (const c of clients) {
      if (c.authenticated && c.vid === vid) sendTo(c.socket, msg);
    }
  }

  const dispatchersCall = new DispatchersCallCoordinator({
    enabled: enableDispatchersCall,
    client:
      options.dispatchersCallClient ??
      new VertexDispatchersCallClient({
        projectId: gcpProjectId,
        location: vertexLocation,
        model: geminiModel,
      }),
    budget: persistence,
    // Only drivers with a live connection that has not opted out get a call.
    eligible: (v) => {
      let connected = false;
      for (const c of clients) {
        if (!c.authenticated || c.vid !== v.id || c.isBot) continue;
        if (c.dispatchersCallOptOut) return false;
        connected = true;
      }
      return connected;
    },
    onOffer: (offer) => sendToVehicleDriver(offer.vid, offer.screen),
  });
  world.listeners.push((ev) => {
    const reveal = dispatchersCall.onSimEvent(ev);
    if (reveal && typeof ev.vid === 'string') sendToVehicleDriver(ev.vid, reveal);
  });

  let lastHumanActiveAtMs = Date.now();
  let lastTickAtMs = Date.now();
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
        clientId: toPublicId(c.clientId),
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
    events = publicizeEvents(events, toPublicId, mayBeClientId);
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
          fork: Math.round(v.fork * 100) / 100,
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
          ...choiceStats(v),
          ...(v.runFinished !== undefined ? { runFinished: Boolean(v.runFinished) } : {}),
          inRange: Boolean(g?.inRange),
          guide: g
            ? {
                kind: g.kind,
                x: g.x,
                y: g.y,
                inRange: g.inRange,
                ...guideExtras(g),
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
          ...(o.putaway ? { rack: o.putaway.rackId, xdockBay: o.xdockBay ?? null, xdockDue: o.xdockDue ?? null } : {}),
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
              ...guideExtras(g),
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
      votes: publicizeKeyedRecord(world.difficultyVotes, toPublicId) ?? {},
      difficulty: world.difficulty,
      tier: world.tier,
      stats: {
        totals: world.totals,
        day: world.day,
        shift: world.shift,
        shiftTime: world.shiftTime,
        rushUntil: world.rushUntil,
        board: currentBoard(nowMs),
        completedRuns: publicizeCompletedRuns(world.completedRuns, toPublicId),
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

  function floorOrdersFor(conn: ConnectedClient, nowMs: number): FloorOrdersStatus {
    return governor.getFloorOrdersStatus(world, conn.clientId, nlPipeline.guard, conn.ip, nowMs);
  }

  /** Signature that ignores countdown values, so only ready/blocked flips and count changes bypass the 1/s throttle. */
  function floorOrdersShape(s: FloorOrdersStatus): string {
    return JSON.stringify([
      s.rush.readyInMs > 0,
      s.p0.open,
      s.p0.readyInMs > 0,
      s.cones.mine,
      s.dispatch.readyInMs > 0,
      s.fleet.addReadyInMs > 0,
      s.fleet.removable,
      s.nl.left,
    ]);
  }

  function markFloorOrdersSent(
    conn: ConnectedClient,
    status: FloorOrdersStatus,
    json: string,
    nowMs: number,
  ): void {
    conn.floorOrdersSentJson = json;
    conn.floorOrdersSentShape = floorOrdersShape(status);
    conn.floorOrdersSentAtMs = nowMs;
  }

  /** JSON of `conn`'s Floor-order state when it should ride this delta, else null. */
  function floorOrdersDeltaJson(conn: ConnectedClient, nowMs: number): string | null {
    const status = floorOrdersFor(conn, nowMs);
    const json = JSON.stringify(status);
    if (json === conn.floorOrdersSentJson) return null;
    const shapeChanged = floorOrdersShape(status) !== conn.floorOrdersSentShape;
    const due =
      conn.floorOrdersSentAtMs === undefined ||
      nowMs - conn.floorOrdersSentAtMs >= FLOOR_ORDERS_INTERVAL_MS;
    if (!shapeChanged && !due) return null;
    markFloorOrdersSent(conn, status, json, nowMs);
    return json;
  }

  function buildWelcome(conn: ConnectedClient, nowMs: number = Date.now()): WelcomeMessage {
    resetIncrementalTrackers(conn);
    const leanBot = conn.isBot;
    const floorOrders = floorOrdersFor(conn, nowMs);
    markFloorOrdersSent(conn, floorOrders, JSON.stringify(floorOrders), nowMs);
    return {
      type: 'welcome',
      you: {
        clientId: toPublicId(conn.clientId),
        playerId: conn.playerId,
        name: conn.name,
        vid: conn.vid,
        role: conn.role,
        siteId,
        isBot: conn.isBot,
      },
      snapshot: publicizeSnapshot(
        snapshotForRecipient(world, conn.clientId, { leanBot }),
        toPublicId,
        mayBeClientId,
      ),
      limits: {
        ...SITE_LIMITS,
        nlPerMinute: nlPipeline.guard.getPlayerLimitPerMin(),
        rackLiftMinigame: enableRackLiftMinigame,
        dispatchersCall: enableDispatchersCall,
      },
      floorOrders,
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
      const handsJson = own ? `{${JSON.stringify(toPublicId(c.clientId))}:${JSON.stringify(own)}}` : '{}';

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

      // Recipient-only Floor-order state, when it changed (countdowns refreshed ≤ 1/s).
      const floorJson = c.clientId ? floorOrdersDeltaJson(c, nowMs) : null;
      const floorPart = floorJson ? `,"floorOrders":${floorJson}` : '';

      c.socket.send(
        `${head},"stats":{${statsCore}${extras}},"hands":${handsJson}${floorPart}}`,
      );
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
    pruneReceivedTransferIds(world);
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
    const keepAlwaysWarm =
      process.env.IDLE_POLICY === 'warm' || process.env.IDLE_POLICY === 'run';
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
          await flushHeartbeat(nowMs);
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

  function pruneConsumedTickets(nowMs: number): void {
    for (const [jti, exp] of consumedTicketIds) {
      if (exp < nowMs) {
        consumedTicketIds.delete(jti);
      }
    }
  }

  async function getOrCreateAnnex(annexId: SiteId): Promise<SiteServerInstance> {
    const existing = annexServers.get(annexId);
    if (existing) return existing;
    const inflight = annexCreationPromises.get(annexId);
    if (inflight) return inflight;

    const p = createSiteServer({
      ...options,
      siteId: annexId,
      persistence,
      ticketSecret,
      requireProxyAuth,
      enableIntervals: options.enableIntervals ?? true,
      restoreFromPersistence: true,
    }).then((srv) => {
      annexServers.set(annexId, srv);
      annexCreationPromises.delete(annexId);
      return srv;
    });
    annexCreationPromises.set(annexId, p);
    return p;
  }

  function evictDriverToSpectator(
    clientId: string,
    v: Vehicle,
    reason: EvictionReason,
    nowMs: number = Date.now(),
  ): void {
    const evictedVid = v.id;
    const pts = Math.round(v.runPts ?? v.sPts ?? 0);
    const shipped = Math.round(v.runDeliveries ?? v.sShipped ?? v.deliveries ?? 0);
    const incidents = Math.round(v.runIncidents ?? v.incidents ?? 0);
    const bestStreak = Math.round(v.bestStreak ?? v.streak ?? 0);
    const runMode: RunMode = v.runMode ?? 'blitz';

    if (v.isPlayerVehicle) {
      removePlayerVehicle(world, clientId);
    } else if (v.human) {
      release(world, v.id);
    }

    for (const c of clients) {
      if (!c.authenticated || c.clientId !== clientId) continue;
      c.vid = null;
      c.role = 'spectator';
      c.evictedReason = reason;
      sendTo(c.socket, {
        type: 'runEvicted',
        vid: evictedVid,
        reason,
        pts,
        shipped,
        incidents,
        bestStreak,
        runMode,
      });
    }

    broadcast(buildPresenceMessage());
    scheduleHeartbeatFlush();
    void nowMs;
  }

  function checkInputLeases(nowMs: number): void {
    let releasedAny = false;
    for (const c of clients) {
      if (!c.authenticated || !c.vid) continue;
      if (c.role === 'driver' && nowMs - c.lastHumanActivityAt > idleEvictionMs) {
        const v = world.vehicles.find((x) => x.id === c.vid);
        if (v?.autopilot && !v.runFinished) continue;
        // Once a Blitz run clock has started, let the 3-minute Blitz timer finish naturally
        // as 'run_complete' rather than evicting mid-run for 'idle_timeout'.
        if (v && v.runMode === 'blitz' && v.runEndsAt != null && !v.runFinished) continue;
        // If another tab for the same client/vehicle is still active, do not evict the shared vehicle.
        let siblingActive = false;
        for (const other of clients) {
          if (
            other !== c &&
            other.authenticated &&
            (other.vid === c.vid || other.clientId === c.clientId) &&
            nowMs - other.lastHumanActivityAt <= idleEvictionMs
          ) {
            siblingActive = true;
            break;
          }
        }
        if (siblingActive) continue;
        if (v) {
          if (v.sPts > 0 || v.deliveries > 0 || (v.runDeliveries ?? 0) > 0) {
            void persistVehicleStats(c.clientId, c.name, c.isBot, v, 0, nowMs);
          }
          evictDriverToSpectator(c.clientId, v, 'idle_timeout', nowMs);
        }
        continue;
      }
      if (nowMs - c.lastInputAtMs > inputLeaseMs) {
        const v = world.vehicles.find((x) => x.id === c.vid);
        if (!v) continue;
        // Co-Pilot autopilot vehicles continue operating autonomously for the player
        // without requiring constant keyboard heartbeats.
        if (v.autopilot) continue;
        let siblingSendingInput = false;
        for (const other of clients) {
          if (
            other !== c &&
            other.authenticated &&
            other.vid === c.vid &&
            nowMs - other.lastInputAtMs <= inputLeaseMs
          ) {
            siblingSendingInput = true;
            break;
          }
        }
        if (siblingSendingInput) continue;
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

  let transferPublishInFlight = false;
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

    // Free-Range contention lease: when active drivers >= FREE_RANGE_SOFT_CAP (26),
    // start a 5-minute (300s) lease countdown on uncapped Free-Range human vehicles.
    if (countActiveDrivers() >= FREE_RANGE_SOFT_CAP) {
      for (const v of world.vehicles) {
        if (v.human && v.runMode === 'freerange' && v.runEndsAt === null) {
          v.runStartedAt = v.runStartedAt ?? world.t;
          v.runEndsAt = Math.round((world.t + 300) * 10) / 10;
        }
      }
    }

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
    lastTickAtMs = nowMs;

    // Dispatcher's Call: detect real situations in each human's Blitz window and ask
    // Gemini (the coordinator de-duplicates in-flight calls per vehicle). Background
    // ticks never wait on the model; foreground (test) ticks do.
    if (dispatchersCall.enabled && world.phase === 'running') {
      const dcPoll = dispatchersCall.poll(world);
      if (background) void dcPoll;
      else await dcPoll;
    }

    // Check Free-Range contention lease expiry after tick advances world.t
    for (const v of world.vehicles) {
      if (
        v.human &&
        !v.runFinished &&
        v.runMode === 'freerange' &&
        v.runEndsAt !== null &&
        v.runEndsAt !== undefined &&
        world.t >= v.runEndsAt
      ) {
        v.runFinished = true;
        v.speedNow = 0;
        v.input = { up: false, down: false, left: false, right: false, boost: false, moveAngle: null };
        recordCompletedRun(world, v);
      }
    }

    // Send authoritative post-tick ack to active manual human drivers using sub-tick dt so
    // client reconciliation stays synchronized on every 100 ms tick.
    const ackT = Math.round(world.t * 100) / 100;
    for (const c of clients) {
      if (!c.authenticated || !c.subTickClient || !c.vid || typeof c.lastInputSeq !== 'number') {
        continue;
      }
      if (nowMs - c.lastInputAtMs > inputLeaseMs) continue;
      const v = world.vehicles.find((x) => x.id === c.vid && x.human);
      if (!v || v.autopilot) continue;
      sendTo(c.socket, {
        type: 'ack',
        seq: c.lastInputSeq,
        t: ackT,
        x: Math.round(v.px * 10000) / 10000,
        y: Math.round(v.py * 10000) / 10000,
        angle: Math.round(v.angle * 10000) / 10000,
        speedNow: Math.round(v.speedNow * 10000) / 10000,
      });
    }

    // Persist newly finished runs immediately and evict completed drivers to spectator
    for (const v of [...world.vehicles]) {
      if (!v.human || !v.runFinished) continue;
      const cid = v.ownerClientId || v.controlledByClientId;
      if (!cid) continue;
      const runKey = `${cid}:${v.runStartedAt ?? 0}`;
      if (!persistedFinishedRuns.has(runKey)) {
        void persistVehicleStats(cid, v.driver || cid, Boolean(v.isBot), v, 0, nowMs);
      }
      if (evictOnRunComplete) {
        const reason: EvictionReason =
          v.runMode === 'freerange' ? 'session_lease_expired' : 'run_complete';
        evictDriverToSpectator(cid, v, reason, nowMs);
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

    // Cross-site transfers: publish in the background with their own in-flight guard, so a
    // slow Pub/Sub publish never delays brain dispatch (and vice versa).
    if (world.outboundTransfers.length > 0) {
      if (background) {
        if (!transferPublishInFlight) {
          transferPublishInFlight = true;
          void publishOutboundTransfers()
            .catch((err) => logAsyncError('transfer publish', err))
            .finally(() => {
              transferPublishInFlight = false;
            });
        }
      } else {
        await publishOutboundTransfers();
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
      // Each request runs in its own concurrency slot; background ticks dispatch into free
      // slots without waiting, so one hung call never stalls the other agents.
      const drain = brainScheduler.drainQueue(world, nowMs, untrustedNames, { wait: !background });
      if (background) {
        void drain.catch((err) => logAsyncError('brain drain', err));
      } else {
        try {
          await drain;
        } catch (err) {
          logAsyncError('brain drain', err);
        }
      }
    }
  }

  function logAsyncError(what: string, err: unknown): void {
    console.error(
      `[${siteId}] ${what} failed: ${err instanceof Error ? err.stack || err.message : String(err)}`,
    );
  }

  /**
   * Publishes queued outbound transfers in order. Each one leaves `world.outboundTransfers`
   * only after Pub/Sub accepts it; on failure it (and everything behind it) stays queued for
   * the next tick, so a failed publish never loses a pallet.
   */
  async function publishOutboundTransfers(): Promise<void> {
    while (world.outboundTransfers.length > 0) {
      const xfer = world.outboundTransfers[0];
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
      try {
        await persistence.publishTransfer(wireTransfer);
      } catch (err) {
        logAsyncError(`transfer ${xfer.id} publish (re-queued)`, err);
        return;
      }
      const idx = world.outboundTransfers.indexOf(xfer);
      if (idx >= 0) world.outboundTransfers.splice(idx, 1);
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

    pruneConsumedTickets(nowMs);
    if (payload.jti) {
      if (consumedTicketIds.has(payload.jti)) {
        sendTo(conn.socket, {
          type: 'error',
          code: 'REQUEUE_REQUIRED',
          message: 'Ticket has already been used; request a fresh ticket via /api/join.',
        });
        conn.socket.close(4003, 'Ticket already consumed');
        return false;
      }
      consumedTicketIds.set(payload.jti, payload.exp);
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

    const ticketRole: 'driver' | 'spectator' =
      spectateOnly || payload.role === 'spectator' ? 'spectator' : 'driver';

    conn.authenticated = true;
    conn.clientId = payload.clientId;
    conn.name = nameCheck.name;
    conn.isBot = payload.isBot;
    conn.ticketRole = payload.role === 'spectator' ? 'spectator' : 'driver';
    conn.ticketJti = payload.jti ?? null;
    conn.evictedReason = null;
    conn.lastInputAtMs = nowMs;
    conn.lastHumanActivityAt = nowMs;
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
        // A 0% battery mid-Blitz is not a finished run (the sim lets the clock run out), so a
        // reconnect must resume the same vehicle rather than replace it.
        const blitzStillRunning =
          ev.runMode === 'blitz' &&
          ev.runEndsAt != null &&
          !ev.runFinished &&
          world.t < ev.runEndsAt;
        if ((ev.battery <= 0 && !blitzStillRunning) || ev.runFinished || isNewRun) {
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
          if (ticketRole === 'spectator') {
            removePlayerVehicle(world, conn.clientId);
          }
        }
      }
    }

    const canDrive =
      ticketRole === 'driver' &&
      conn.evictedReason === null &&
      countActiveDrivers() < MAX_DRIVERS &&
      countClientDrivers(conn.clientId) < MAX_DRIVERS_PER_CLIENT;

    if (canDrive) {
      const vehicle = spawnPlayerVehicle(world, {
        clientId: conn.clientId,
        name: conn.name,
        isBot: conn.isBot,
        ...(payload.runMode ? { runMode: payload.runMode, mode: payload.runMode } : {}),
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
      // Keep `conn` tracked so the socket 'close' handler releases its vehicle
      // (deleting here made the close handler skip cleanup → ghost vehicles).
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
    let rawHasMovement = false;
    if (candidate !== null && typeof candidate === 'object' && candidate.type === 'input') {
      const hasDx = typeof candidate.dx === 'number' && Number.isFinite(candidate.dx) && candidate.dx !== 0;
      const hasDy = typeof candidate.dy === 'number' && Number.isFinite(candidate.dy) && candidate.dy !== 0;
      const hasBrake = Boolean(candidate.brake);
      const hasTarget = candidate.target !== undefined && candidate.target !== null;
      const hasMoveAngle =
        typeof candidate.moveAngle === 'number' && Number.isFinite(candidate.moveAngle);
      const hasBoolDir = Boolean(
        candidate.up || candidate.down || candidate.left || candidate.right || candidate.boost,
      );
      rawHasMovement = hasDx || hasDy || hasBrake || hasTarget || hasMoveAngle || hasBoolDir;
    }

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
      (candidate.boost === undefined || typeof candidate.boost === 'boolean') &&
      (candidate.moveAngle === undefined ||
        candidate.moveAngle === null ||
        (typeof candidate.moveAngle === 'number' && Number.isFinite(candidate.moveAngle))) &&
      (candidate.dt === undefined ||
        (typeof candidate.dt === 'number' &&
          Number.isFinite(candidate.dt) &&
          candidate.dt >= 0 &&
          candidate.dt <= 2))
    ) {
      msg = {
        type: 'input',
        seq: candidate.seq,
        up: candidate.up,
        down: candidate.down,
        left: candidate.left,
        right: candidate.right,
        ...(candidate.boost !== undefined ? { boost: candidate.boost } : {}),
        ...(candidate.moveAngle !== undefined ? { moveAngle: candidate.moveAngle } : {}),
        ...(candidate.dt !== undefined ? { dt: candidate.dt } : {}),
      };
    } else if (
      candidate !== null &&
      typeof candidate === 'object' &&
      candidate.type === 'input' &&
      (typeof candidate.dx === 'number' || typeof candidate.dy === 'number')
    ) {
      const dx = typeof candidate.dx === 'number' && Number.isFinite(candidate.dx) ? candidate.dx : 0;
      const dy = typeof candidate.dy === 'number' && Number.isFinite(candidate.dy) ? candidate.dy : 0;
      const seq =
        typeof candidate.seq === 'number' && Number.isInteger(candidate.seq) && candidate.seq >= 0
          ? candidate.seq
          : conn.lastInputSeq + 1;
      msg = {
        type: 'input',
        seq,
        up: dy < 0,
        down: dy > 0,
        left: dx < 0,
        right: dx > 0,
        ...(typeof candidate.boost === 'boolean' ? { boost: candidate.boost } : {}),
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
          pruneConsumedTickets(nowMs);
          if (verified.payload.jti) {
            if (consumedTicketIds.has(verified.payload.jti)) {
              sendTo(conn.socket, {
                type: 'error',
                code: 'REQUEUE_REQUIRED',
                message: 'Ticket has already been used; request a fresh ticket via /api/join.',
              });
              return;
            }
            consumedTicketIds.set(verified.payload.jti, verified.payload.exp);
          }
          const nameCheck = validateDisplayName(verified.payload.name, {
            allowBotPrefix: verified.payload.isBot,
          });
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
          if (verified.payload.role !== 'spectator') {
            conn.ticketRole = 'driver';
            conn.ticketJti = verified.payload.jti ?? null;
            conn.evictedReason = null;
            conn.lastHumanActivityAt = nowMs;
            if (
              conn.role !== 'driver' &&
              countActiveDrivers() < MAX_DRIVERS &&
              countClientDrivers(conn.clientId) < MAX_DRIVERS_PER_CLIENT
            ) {
              const vehicle = spawnPlayerVehicle(world, {
                clientId: conn.clientId,
                name: conn.name,
                isBot: conn.isBot,
                ...(verified.payload.runMode
                  ? { runMode: verified.payload.runMode, mode: verified.payload.runMode }
                  : {}),
              });
              if (vehicle) {
                applyCarryOverToVehicle(conn, vehicle, verified.payload);
                conn.vid = vehicle.id;
                conn.role = 'driver';
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
      // Leave cleanup to the socket 'close' handler (see frame-size path).
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
        const hasMoveAngle =
          typeof msg.moveAngle === 'number' && Number.isFinite(msg.moveAngle);
        const anyKeyPressed = Boolean(
          msg.up || msg.down || msg.left || msg.right || msg.boost || hasMoveAngle,
        );
        if (anyKeyPressed || rawHasMovement) {
          conn.lastHumanActivityAt = nowMs;
        }
        const v = conn.vid
          ? world.vehicles.find((x) => x.id === conn.vid && x.human)
          : null;
        if (v) {
          if (v.autopilot && anyKeyPressed) {
            setVehicleAutopilot(
              world,
              v,
              false,
              'Manual WASD override — Co-Pilot paused',
            );
          }
          if (!v.autopilot) {
            const movementPressed = Boolean(
              msg.up || msg.down || msg.left || msg.right || hasMoveAngle,
            );
            if (
              movementPressed &&
              !v.runFinished &&
              v.runMode === 'blitz' &&
              v.runStartedAt === null
            ) {
              if (v.runEndsAt == null) {
                v.runStartedAt = world.t;
                v.runEndsAt = Math.round((world.t + BLITZ_DURATION_MIN) * 10) / 10;
              } else {
                v.runStartedAt = Math.max(0, v.runEndsAt - BLITZ_DURATION_MIN);
              }
              v.runGraceUntil = null;
            }
            const nextInput: Vehicle['input'] = {
              up: msg.up,
              down: msg.down,
              left: msg.left,
              right: msg.right,
              boost: Boolean(msg.boost),
              moveAngle: hasMoveAngle ? msg.moveAngle : null,
            };
            const inputChanged =
              v.input.up !== nextInput.up ||
              v.input.down !== nextInput.down ||
              v.input.left !== nextInput.left ||
              v.input.right !== nextInput.right ||
              Boolean(v.input.boost) !== Boolean(nextInput.boost) ||
              (v.input.moveAngle ?? null) !== (nextInput.moveAngle ?? null);
            if (typeof msg.dt === 'number' && Number.isFinite(msg.dt)) {
              conn.subTickClient = true;
              const sliceDt = Math.max(0, msg.dt);
              if (!v.inputQueue) v.inputQueue = [];
              const queuedTotal = v.inputQueue.reduce((s, x) => s + x.dt, 0);
              const prevActive =
                v.input.up ||
                v.input.down ||
                v.input.left ||
                v.input.right ||
                (typeof v.input.moveAngle === 'number' && Number.isFinite(v.input.moveAngle));
              let remDt: number;
              if (inputChanged && !prevActive) {
                const elapsedInTick = Math.min(
                  TICK_MIN,
                  Math.max(0, (nowMs - lastTickAtMs) * 0.001),
                );
                remDt = Math.max(0, elapsedInTick - queuedTotal);
              } else {
                const carried = v.inputCarriedDt ?? 0;
                remDt = Math.min(TICK_MIN, Math.max(0, sliceDt - carried));
              }
              const allowed = Math.max(0, TICK_MIN * 1.5 - queuedTotal);
              if (remDt > 1e-6 && allowed > 1e-6) {
                v.inputQueue.push({ input: { ...v.input }, dt: Math.min(remDt, allowed) });
              }
              v.inputCarriedDt = inputChanged
                ? 0
                : Math.max(0, (v.inputCarriedDt ?? 0) - sliceDt);
            }
            v.input = nextInput;
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
        conn.lastHumanActivityAt = nowMs;
        if (conn.vid) {
          humanInteract(
            world,
            conn.vid,
            enableRackLiftMinigame && msg.forkHeight !== undefined
              ? { forkHeight: msg.forkHeight }
              : undefined,
          );
        }
        break;
      }

      case 'takeWheel': {
        if (conn.ticketRole === 'spectator' || conn.evictedReason !== null) {
          sendTo(conn.socket, {
            type: 'error',
            code: 'REQUEUE_REQUIRED',
            message:
              'Spectator or completed-run connections must join the driver queue via /api/join to claim a driver seat.',
          });
          return;
        }
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
        conn.lastHumanActivityAt = nowMs;
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
        conn.lastHumanActivityAt = nowMs;
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
        conn.lastHumanActivityAt = nowMs;
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

      case 'chooseOrder': {
        const gov = governor.tryChooseOrder(world, conn.clientId, nowMs);
        if (!gov.ok) {
          sendTo(conn.socket, { type: 'error', code: gov.code, message: gov.message });
          break;
        }
        conn.lastInputAtMs = nowMs;
        conn.lastHumanActivityAt = nowMs;
        const err = conn.vid
          ? chooseOrder(world, conn.vid, msg.orderId)
          : 'Take a vehicle before choosing an order.';
        if (err) {
          sendTo(conn.socket, { type: 'error', code: 'choose_order_failed', message: err });
        }
        break;
      }

      case 'dispatchersCallPref': {
        conn.dispatchersCallOptOut = !msg.enabled;
        break;
      }

      case 'setRunMode': {
        conn.lastHumanActivityAt = nowMs;
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

        const relocationExp = nowMs + 60_000;
        const ticket = signTicket(
          {
            clientId: conn.clientId,
            name: conn.name,
            siteId: toSite,
            exp: relocationExp,
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
          expiresAt: relocationExp,
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
        if (conn.role !== 'driver') {
          // Dispatcher orders spend shared Gemini budget and mutate the floor;
          // spectators must not be able to issue them.
          sendTo(conn.socket, {
            type: 'error',
            code: 'spectator_forbidden',
            message: 'Spectators cannot issue dispatcher orders. Join the driver queue to play.',
          });
          return;
        }
        conn.lastHumanActivityAt = nowMs;
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
        conn.lastHumanActivityAt = nowMs;
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
            if (conn.ticketRole === 'spectator' || conn.evictedReason !== null) {
              sendTo(conn.socket, {
                type: 'error',
                code: 'REQUEUE_REQUIRED',
                message:
                  'Spectator or completed-run connections must join the driver queue via /api/join to claim a driver seat.',
              });
              return;
            }
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
          // The pipeline awaited Gemini/Model Armor; the vehicle may have been
          // removed, replaced, or handed to another driver meanwhile. Re-resolve
          // the live vehicle and re-check ownership before mutating anything.
          const targetVid = v.id;
          const live = world.vehicles.find((x) => x.id === targetVid);
          const stillOwned =
            live !== undefined &&
            (live.ownerClientId === conn.clientId ||
              live.controlledByClientId === conn.clientId ||
              conn.vid === live.id);
          if (res.ok && res.executed && (!live || !stillOwned)) {
            sendTo(conn.socket, {
              type: 'error',
              code: 'vehicle_changed',
              message: `Vehicle ${targetVid} changed while the Co-Pilot command was processing; the command was not applied.`,
            });
            res.echo.executed = false;
            sendTo(conn.socket, res.echo);
            break;
          }
          if (live) v = live;
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
        const dcIdx = parseDispatchersCallActionId(msg.actionId);
        if (dcIdx !== null || (msg.actionId === 'dismiss' && dispatchersCall.isActive(msg.screenId))) {
          // Dispatcher's Call pick: execute the server-stored option (client dispatch ignored).
          // Dismissing the minigame card is a no-pick; the sim deadline resolves it.
          if (dcIdx === null) break;
          const v = conn.vid ? world.vehicles.find((x) => x.id === conn.vid) : undefined;
          const out = v
            ? dispatchersCall.handlePick(world, v, msg.screenId, dcIdx)
            : ({ ok: false, error: 'no_challenge' } as const);
          if (out.ok) {
            sendTo(conn.socket, out.reveal);
          } else {
            sendTo(conn.socket, {
              type: 'commandEcho',
              text: "Dispatcher's Call",
              parsed: { action: 'dispatch', echo: `Pick rejected: ${out.error}` },
              executed: false,
              reason: out.error,
            });
          }
          break;
        }
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
    // Client IP: only trust the lobby-computed `x-warehouse-client-ip` when this upgrade carries a
    // valid `x-warehouse-proxy` token AND the IP's HMAC (bound to that exact token) verifies.
    // Otherwise use the socket peer. Never use the raw (client-controlled) left-most XFF entry.
    const clientIp = ((): string => {
      const socketIp = req.socket?.remoteAddress || '127.0.0.1';
      const first = (v: string | string[] | undefined): string | undefined =>
        Array.isArray(v) ? v[0] : v;
      const proxyToken = first(req.headers[PROXY_HEADER_NAME])?.trim();
      const claimedIp = first(req.headers['x-warehouse-client-ip'])?.trim();
      const claimedSig = first(req.headers['x-warehouse-client-ip-sig'])?.trim();
      if (!proxyToken || !claimedIp || !claimedSig || claimedIp.length > 64) return socketIp;
      const urlSite = url.searchParams.get('site');
      const proxyOk =
        hasValidProxyHeader(req.headers) ||
        (urlSite !== null && isValidSiteId(urlSite) && hasValidProxyHeader(req.headers, urlSite));
      if (!proxyOk) return socketIp;
      const expected = Buffer.from(
        createHmac('sha256', ticketSecret)
          .update(`client-ip:${proxyToken}:${claimedIp}`)
          .digest('base64url'),
        'utf8',
      );
      const actual = Buffer.from(claimedSig, 'utf8');
      return expected.length === actual.length && timingSafeEqual(expected, actual)
        ? claimedIp
        : socketIp;
    })();

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
      ticketRole: 'spectator',
      ticketJti: null,
      evictedReason: null,
      lastHumanActivityAt: Date.now(),
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
      handleClientMessage(conn, data).catch((err: unknown) => {
        logAsyncError('message handler', err);
        sendTo(conn.socket, {
          type: 'error',
          code: 'internal_error',
          message: 'Server failed to process that message.',
        });
      });
    });

    socket.on('error', (err) => {
      // ws only emits 'error' for protocol violations (e.g. a frame above maxPayload); it has
      // already started closing and stopped reading, so drop the TCP socket promptly instead
      // of waiting out the 30s closing-handshake timeout. 'close' then frees the vehicle.
      logAsyncError('socket', err);
      setTimeout(() => socket.terminate(), 1_000).unref?.();
    });

    socket.on('close', () => {
      if (conn.authTimer) {
        clearTimeout(conn.authTimer);
      }
      const wasTracked = clients.delete(conn);
      if (!wasTracked) return;
      if (conn.authenticated && conn.clientId) {
        // Only keep the vehicle if another *driver* socket for this client
        // still holds it; a remaining spectator-only tab must not pin a ghost.
        const stillDriving = Array.from(clients).some(
          (c) =>
            c.authenticated &&
            c.clientId === conn.clientId &&
            c.role === 'driver' &&
            c.vid,
        );
        if (!stillDriving) {
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
    targetSite: SiteId = siteId,
  ): boolean {
    const raw = headers[PROXY_HEADER_NAME];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (verifyProxyHeader(token, targetSite, ticketSecret)) return true;
    if (targetSite !== siteId && verifyProxyHeader(token, siteId, ticketSecret)) {
      return true;
    }
    return false;
  }

  // Attach HTTP Upgrade handler for /ws (routes dynamic annex shards like den-2 to their in-process WSS)
  app.server.on('upgrade', (request, socket, head) => {
    const reqUrl = new URL(request.url || '/', 'http://localhost');
    if (reqUrl.pathname === '/ws') {
      const siteParam = reqUrl.searchParams.get('site');
      let targetSiteId: SiteId | null =
        siteParam && isValidSiteId(siteParam) ? siteParam : null;
      if (!targetSiteId) {
        const ticketParam = reqUrl.searchParams.get('ticket');
        if (ticketParam) {
          const verified = verifyTicket(ticketParam, ticketSecret);
          if (verified.ok && isValidSiteId(verified.payload.siteId)) {
            targetSiteId = verified.payload.siteId;
          }
        }
      }
      const effectiveSite = targetSiteId ?? siteId;
      if (requireProxyAuth && !hasValidProxyHeader(request.headers, effectiveSite)) {
        socket.write(
          'HTTP/1.1 403 Forbidden\r\n' +
            'Content-Type: application/json\r\n' +
            'Connection: close\r\n\r\n' +
            '{"ok":false,"error":"Direct backend access is forbidden; connect via warehouse-lobby gateway"}\r\n',
        );
        socket.destroy();
        return;
      }
      if (effectiveSite !== siteId) {
        void getOrCreateAnnex(effectiveSite)
          .then((annex) => {
            annex.wss.handleUpgrade(request, socket, head, (ws) => {
              annex.wss.emit('connection', ws, request);
            });
          })
          .catch(() => {
            socket.destroy();
          });
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
    const query = (req.query || {}) as { site?: string };
    const requestedSite =
      query.site && isValidSiteId(query.site) ? query.site : siteId;
    if (requireProxyAuth && !hasValidProxyHeader(req.headers, requestedSite)) {
      return reply.code(403).send({
        ok: false,
        error: 'Direct backend access is forbidden; use warehouse-lobby gateway',
      });
    }
    if (requestedSite !== siteId && annexServers.has(requestedSite)) {
      const annex = annexServers.get(requestedSite)!;
      const nowMs = Date.now();
      const annexPlayers = Array.from(annex.clients)
        .filter((c) => c.authenticated)
        .map((c) => ({
          id: c.playerId,
          name: c.name,
          vid: c.vid,
          role: c.role,
          isBot: c.isBot,
          pts: 0,
          shipped: 0,
        }));
      return {
        ok: true,
        siteId: annex.siteId,
        snapshot: publicizeSnapshot(
          snapshotForRecipient(annex.world, null),
          toPublicId,
          (key) => !annex.world.vehicles.some((v) => v.id === key),
        ),
        presence: annexPlayers,
        brainHealth: annex.brainScheduler.getBrainHealthMessage(
          nowMs,
          annex.nlPipeline.getArmorBlocks1h(nowMs),
        ),
      };
    }
    const nowMs = Date.now();
    return {
      ok: true,
      siteId,
      snapshot: publicizeSnapshot(snapshotForRecipient(world, null), toPublicId, mayBeClientId),
      presence: buildPresenceMessage().players,
      brainHealth: brainScheduler.getBrainHealthMessage(
        nowMs,
        nlPipeline.getArmorBlocks1h(nowMs),
      ),
    };
  });

  app.get('/api/status', async (req, reply) => {
    const query = (req.query || {}) as { site?: string };
    const requestedSite =
      query.site && isValidSiteId(query.site) ? query.site : siteId;
    if (requireProxyAuth && !hasValidProxyHeader(req.headers, requestedSite)) {
      return reply.code(403).send({
        ok: false,
        error: 'Direct backend access is forbidden; use warehouse-lobby gateway',
      });
    }
    if (requestedSite !== siteId && annexServers.has(requestedSite)) {
      const annex = annexServers.get(requestedSite)!;
      const nowMs = Date.now();
      const annexDrivers = Array.from(annex.clients).filter(
        (c) => c.authenticated && c.role === 'driver' && Boolean(c.vid),
      ).length;
      const annexTotal = Array.from(annex.clients).filter(
        (c) => c.authenticated,
      ).length;
      return {
        ok: true,
        siteId: annex.siteId,
        phase: annex.world.phase,
        drivers: annexDrivers,
        spectators: Math.max(0, annexTotal - annexDrivers),
        snapshot: publicizeSnapshot(
          snapshotForRecipient(annex.world, null),
          toPublicId,
          (key) => !annex.world.vehicles.some((v) => v.id === key),
        ),
        brainHealth: annex.brainScheduler.getBrainHealthMessage(
          nowMs,
          annex.nlPipeline.getArmorBlocks1h(nowMs),
        ),
      };
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
      snapshot: publicizeSnapshot(snapshotForRecipient(world, null), toPublicId, mayBeClientId),
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
    const authHeader = req.headers.authorization;
    const bearerToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : null;
    if (!hasValidProxyHeader(req.headers)) {
      if (bearerToken) {
        // Pub/Sub push carries a Google-signed OIDC token; merely having a
        // bearer header is not proof of origin, so always verify it.
        // The push subscription sets no explicit audience, so Pub/Sub uses the push
        // endpoint URL (`${site uri}/internal/transfer`), whose host is the Host header.
        const audience = transferPushAudiences(req.headers.host);
        let verified = false;
        try {
          verified = await verifyTransferPushToken(bearerToken, audience);
        } catch (err) {
          logAsyncError('transfer push token verification', err);
          verified = false;
        }
        if (!verified) {
          return reply.code(403).send({
            ok: false,
            error: 'Invalid Pub/Sub push token',
          });
        }
      } else if (requireProxyAuth) {
        return reply.code(403).send({
          ok: false,
          error: 'Unauthorized internal transfer request',
        });
      }
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
    pruneReceivedTransferIds(world);
    return reply.code(200).send({
      ok: true,
      duplicate: createdOrder === null,
      orderId: createdOrder?.id ?? null,
      transfersIn: world.totals.transfersIn,
    });
  });

  app.post('/internal/wake', async (req, reply) => {
    const query = (req.query || {}) as { site?: string };
    const body = (req.body || {}) as { immediate?: boolean; siteId?: string };
    const rawTarget = query.site ?? body.siteId ?? siteId;
    const targetSiteId: SiteId = isValidSiteId(rawTarget) ? rawTarget : siteId;

    if (requireProxyAuth && !hasValidProxyHeader(req.headers, targetSiteId)) {
      return reply.code(403).send({
        ok: false,
        error: 'Unauthorized internal wake request',
      });
    }

    if (targetSiteId !== siteId) {
      const annex = await getOrCreateAnnex(targetSiteId);
      if (body.immediate) {
        setPhase(annex.world, 'running');
      } else if (
        annex.world.phase === 'break' ||
        annex.world.phase === 'winding_down'
      ) {
        setPhase(annex.world, 'resuming');
      }
      annex.broadcast({
        type: 'phase',
        phase: annex.world.phase,
        resumesAt:
          annex.world.phase === 'resuming'
            ? Date.now() + Math.round(annex.world.resumeCountdown * 1000)
            : undefined,
      });
      await annex.flushHeartbeat();
      return {
        ok: true,
        siteId: annex.siteId,
        phase: annex.world.phase,
        resumeCountdown: annex.world.resumeCountdown,
      };
    }

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
    flushHeartbeat(Date.now()).catch((err) => logAsyncError('initial heartbeat', err));
    flushSnapshot(Date.now()).catch((err) => logAsyncError('initial snapshot', err));

    let lastTickWallMs = Date.now();
    tickTimer = setInterval(() => {
      if (tickInFlight) return;
      const now = Date.now();
      const elapsedMs = now - lastTickWallMs;
      const dueTicks = Math.min(3, Math.max(1, Math.floor(elapsedMs / SITE_TICK_MS)));
      lastTickWallMs = elapsedMs >= SITE_TICK_MS ? lastTickWallMs + dueTicks * SITE_TICK_MS : now;
      if (now - lastTickWallMs > 3 * SITE_TICK_MS) {
        lastTickWallMs = now;
      }
      tickInFlight = true;
      (async () => {
        for (let i = 0; i < dueTicks; i++) {
          await stepTick(Date.now(), true);
        }
      })()
        .catch((err) => logAsyncError('tick', err))
        .finally(() => {
        tickInFlight = false;
      });
    }, SITE_TICK_MS);
    tickTimer.unref?.();

    heartbeatTimer = setInterval(() => {
      flushHeartbeat(Date.now()).catch((err) => logAsyncError('heartbeat', err));
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
        checkSurgeRelocation(Date.now()).catch((err) =>
          logAsyncError('surge relocation sweep', err),
        );
      }
    }, 10_000);
    relocationSweepTimer.unref?.();

    snapshotTimer = setInterval(() => {
      if (world.phase === 'running') {
        flushSnapshot(Date.now()).catch((err) => logAsyncError('snapshot', err));
      }
    }, 30_000);
    snapshotTimer.unref?.();
  }

  async function gracefulShutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    for (const annex of annexServers.values()) {
      await annex.close();
    }
    annexServers.clear();

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

    try {
      await flushSnapshot(Date.now());
    } catch (err) {
      logAsyncError('shutdown snapshot', err);
    }
    try {
      await flushHeartbeat(Date.now());
    } catch (err) {
      logAsyncError('shutdown heartbeat', err);
    }
    try {
      // Persist buffered Gemini budget increments before the instance exits.
      await persistence.flushUsage?.();
    } catch (err) {
      logAsyncError('shutdown budget flush', err);
    }

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
    annexServers,
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
