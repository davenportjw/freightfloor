import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const MAX_WS_FRAME_BYTES = 4096;
export const TILE_QUANT_SCALE = 32;

// ============================================================================
// 1. Site IDs, Phases, Difficulty & Constants
// ============================================================================

export const SITE_IDS = ['den-1', 'slc-2', 'phx-3', 'abq-4'] as const;
export const SiteIdSchema = z.enum(SITE_IDS);
export type SiteId = z.infer<typeof SiteIdSchema>;

export const PHASES = ['running', 'winding_down', 'break', 'resuming'] as const;
export const PhaseSchema = z.enum(PHASES);
export type Phase = z.infer<typeof PhaseSchema>;

export const DIFFICULTY_NAMES = ['easy', 'normal', 'hard', 'calm', 'surge', 'crisis'] as const;
export const DifficultyNameSchema = z.enum(DIFFICULTY_NAMES);
export type DifficultyName = z.infer<typeof DifficultyNameSchema>;

export const DifficultyLevelSchema = z.union([
  DifficultyNameSchema,
  z.number().int().min(1).max(5),
]);
export type DifficultyLevel = z.infer<typeof DifficultyLevelSchema>;

export const MANAGER_OPS = ['rush', 'p0', 'cone', 'fleetAdd', 'fleetRemove'] as const;
export const ManagerOpSchema = z.enum(MANAGER_OPS);
export type ManagerOp = z.infer<typeof ManagerOpSchema>;

export const DECISION_KINDS = ['contract', 'hazard', 'tactics', 'cards'] as const;
export const DecisionKindSchema = z.enum(DECISION_KINDS);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

export const ALLOWED_GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-4-argon',
] as const;
export type AllowedGeminiModel = (typeof ALLOWED_GEMINI_MODELS)[number];

/**
 * Normalizes a numeric (1..5) or named difficulty vote into canonical sim difficulty keys.
 */
export function normaliseDifficultyKey(level: DifficultyLevel): 'easy' | 'normal' | 'hard' {
  if (typeof level === 'number') {
    if (level <= 1) return 'easy';
    if (level === 2) return 'normal';
    return 'hard';
  }
  switch (level) {
    case 'easy':
    case 'calm':
      return 'easy';
    case 'normal':
      return 'normal';
    case 'hard':
    case 'surge':
    case 'crisis':
      return 'hard';
  }
}

// ============================================================================
// 2. Quantisation Helpers (1/32 tile precision)
// ============================================================================

export function quantiseCoord(v: number): number {
  return Math.round(v * TILE_QUANT_SCALE);
}

export function dequantiseCoord(q: number): number {
  return q / TILE_QUANT_SCALE;
}

export const quantizeCoord = quantiseCoord;
export const dequantizeCoord = dequantiseCoord;

// ============================================================================
// 3. Lobby HTTP Schemas & HMAC Ticket Helpers
// ============================================================================

export const JoinRequestSchema = z.object({
  name: z.string().min(1).max(64),
  clientId: z.string().min(1).max(128),
  prefer: SiteIdSchema.optional(),
});
export type JoinRequest = z.infer<typeof JoinRequestSchema>;

export const JoinResponseSchema = z.object({
  siteId: SiteIdSchema,
  wsUrl: z.string().min(1),
  ticket: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
});
export type JoinResponse = z.infer<typeof JoinResponseSchema>;

export const SiteStateSchema = z.enum(['live', 'online', 'break', 'offline']);
export type SiteState = z.infer<typeof SiteStateSchema>;

export const SiteStatusSchema = z.object({
  id: SiteIdSchema,
  state: SiteStateSchema,
  drivers: z.number().int().nonnegative(),
  spectators: z.number().int().nonnegative(),
  tier: z.number().int().nonnegative(),
  shipped: z.number().int().nonnegative(),
  phase: PhaseSchema,
  wsUrl: z.string().optional(),
  updatedAt: z.number().optional(),
  /** Per-site human driver cap, as reported by the site heartbeat (site `MAX_DRIVERS`). */
  maxDrivers: z.number().int().positive().optional(),
});
export const SiteSummarySchema = SiteStatusSchema;
export type SiteStatus = z.infer<typeof SiteStatusSchema>;
export type SiteSummary = SiteStatus;

export const LeaderboardEntrySchema = z.object({
  clientId: z.string().min(1),
  name: z.string().min(1),
  siteId: SiteIdSchema.optional(),
  points: z.number().optional(),
  lifetimePoints: z.number().optional(),
  deliveries: z.number().int().nonnegative(),
  isBot: z.boolean().optional(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

export const NetworkResponseSchema = z.object({
  sites: z.array(SiteStatusSchema),
  leaderboard: z.array(LeaderboardEntrySchema),
});
export type NetworkResponse = z.infer<typeof NetworkResponseSchema>;

export const TicketPayloadSchema = z.object({
  clientId: z.string().min(1),
  name: z.string().min(1),
  siteId: SiteIdSchema,
  isBot: z.boolean(),
  exp: z.number().int().nonnegative(),
});
export type TicketPayload = z.infer<typeof TicketPayloadSchema>;

export function signTicket(payload: TicketPayload, secret: string): string {
  const validated = TicketPayloadSchema.parse(payload);
  const body = Buffer.from(JSON.stringify(validated), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyTicket(
  ticket: string,
  secret: string,
  nowMs: number = Date.now(),
): { ok: true; payload: TicketPayload } | { ok: false; error: 'malformed' | 'bad_signature' | 'expired' } {
  const parts = ticket.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, error: 'malformed' };
  }
  const [body, sig] = parts;
  const expectedSig = createHmac('sha256', secret).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, error: 'bad_signature' };
  }
  try {
    const raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const parsed = TicketPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: 'malformed' };
    }
    if (parsed.data.exp <= nowMs) {
      return { ok: false, error: 'expired' };
    }
    return { ok: true, payload: parsed.data };
  } catch {
    return { ok: false, error: 'malformed' };
  }
}

// ============================================================================
// 4. Client -> Site WebSocket Schemas
// ============================================================================

export const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  ticket: z.string().min(1),
});
export type HelloMessage = z.infer<typeof HelloMessageSchema>;

export const InputMessageSchema = z.object({
  type: z.literal('input'),
  up: z.boolean(),
  down: z.boolean(),
  left: z.boolean(),
  right: z.boolean(),
  seq: z.number().int().nonnegative(),
});
export type InputMessage = z.infer<typeof InputMessageSchema>;

export const InteractMessageSchema = z.object({
  type: z.literal('interact'),
});
export type InteractMessage = z.infer<typeof InteractMessageSchema>;

export const TakeWheelMessageSchema = z.object({
  type: z.literal('takeWheel'),
  vid: z.string().min(1),
});
export type TakeWheelMessage = z.infer<typeof TakeWheelMessageSchema>;

export const ReleaseMessageSchema = z.object({
  type: z.literal('release'),
});
export type ReleaseMessage = z.infer<typeof ReleaseMessageSchema>;

export const ManagerMessageSchema = z.object({
  type: z.literal('manager'),
  op: ManagerOpSchema,
  x: z.number().int().optional(),
  y: z.number().int().optional(),
});
export type ManagerMessage = z.infer<typeof ManagerMessageSchema>;

export const KeepCardsMessageSchema = z.object({
  type: z.literal('keepCards'),
  ids: z.array(z.string()),
});
export type KeepCardsMessage = z.infer<typeof KeepCardsMessageSchema>;

export const VoteDifficultyMessageSchema = z.object({
  type: z.literal('voteDifficulty'),
  level: DifficultyLevelSchema,
});
export type VoteDifficultyMessage = z.infer<typeof VoteDifficultyMessageSchema>;

export const NlCommandMessageSchema = z.object({
  type: z.literal('nlCommand'),
  text: z.string(),
});
export type NlCommandMessage = z.infer<typeof NlCommandMessageSchema>;

export const TransferSiteMessageSchema = z.object({
  type: z.literal('transferSite'),
  siteId: SiteIdSchema,
});
export type TransferSiteMessage = z.infer<typeof TransferSiteMessageSchema>;

/**
 * Subscribe (`traffic: true`) or unsubscribe (`traffic: false`) this connection
 * from the sparse `stats.heat` traffic layer carried on full deltas.
 */
export const LayersMessageSchema = z.object({
  type: z.literal('layers'),
  traffic: z.boolean(),
});
export type LayersMessage = z.infer<typeof LayersMessageSchema>;

export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  InputMessageSchema,
  InteractMessageSchema,
  TakeWheelMessageSchema,
  ReleaseMessageSchema,
  ManagerMessageSchema,
  KeepCardsMessageSchema,
  VoteDifficultyMessageSchema,
  NlCommandMessageSchema,
  TransferSiteMessageSchema,
  LayersMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const CLIENT_MESSAGE_TYPES = [
  'hello',
  'input',
  'interact',
  'takeWheel',
  'release',
  'manager',
  'keepCards',
  'voteDifficulty',
  'nlCommand',
  'transferSite',
  'layers',
] as const;

// ============================================================================
// 5. Site -> Client WebSocket Schemas
// ============================================================================

export const PlayerSessionInfoSchema = z.object({
  clientId: z.string().min(1),
  playerId: z.string().optional(),
  name: z.string().min(1),
  vid: z.string().nullable(),
  siteId: SiteIdSchema,
  isBot: z.boolean().optional(),
});
export type PlayerSessionInfo = z.infer<typeof PlayerSessionInfoSchema>;

/** Max planned waypoints carried in `QuantisedVehicleDelta.path`. */
export const MAX_PATH_WAYPOINTS = 12;
/** Heat tiles with a value below this are omitted from `stats.heat.cells`. */
export const HEAT_MIN_VALUE = 0.5;
/** Minimum interval between heat layers sent to one subscribed connection. */
export const HEAT_INTERVAL_MS = 2_000;
/** Minimum interval between Strategy Board recomputations. */
export const BOARD_INTERVAL_MS = 1_000;

/** The sim's per-vehicle `Tactics` object, as stored on the vehicle. */
export const VehicleTacticsSchema = z
  .object({
    speed: z.number(),
    respect: z.number(),
    buffer: z.number(),
    chargeAt: z.number(),
    batch: z.number(),
    flatPath: z.boolean(),
    preemptForP0: z.boolean(),
    poach: z.boolean(),
    note: z.string().optional(),
  })
  .passthrough();
export type VehicleTactics = z.infer<typeof VehicleTacticsSchema>;

/**
 * Metadata recorded from the vehicle's last REAL, successfully applied brain call
 * (sim `Vehicle.lastDecision`): model id reported by the call, measured wall-clock
 * latency in ms, decision kind, the decision's reason, and game time `t` it was applied.
 */
export const VehicleDecisionSchema = z.object({
  kind: DecisionKindSchema,
  model: z.string().min(1),
  latencyMs: z.number().nonnegative(),
  reason: z.string(),
  t: z.number(),
});
export type VehicleDecision = z.infer<typeof VehicleDecisionSchema>;

export const QuantisedVehicleDeltaSchema = z.object({
  id: z.string().min(1),
  qx: z.number().int().optional(),
  qy: z.number().int().optional(),
  px: z.number().optional(),
  py: z.number().optional(),
  angle: z.number().optional(),
  speedNow: z.number().optional(),
  state: z.string().optional(),
  battery: z.number().optional(),
  fork: z.number().optional(),
  cargoCount: z.number().int().optional(),
  cargo: z.array(z.any()).optional(),
  orders: z.array(z.any()).optional(),
  driver: z.string().nullable().optional(),
  human: z.boolean().optional(),
  strategy: z.string().optional(),
  type: z.string().optional(),
  braking: z.boolean().optional(),
  stunnedUntil: z.number().optional(),
  sPts: z.number().optional(),
  sShipped: z.number().optional(),
  msg: z.string().optional(),
  brainThinking: z.boolean().optional(),
  brainError: z.string().nullable().optional(),
  lastReason: z.string().nullable().optional(),
  inRange: z.boolean().optional(),
  guide: z.any().optional(),
  // ---- Inspector detail (FULL deltas only) ----
  /** Lifetime incident count for this vehicle (sim `Vehicle.incidents`). */
  incidents: z.number().int().nonnegative().optional(),
  /** Lifetime near-miss count for this vehicle (sim `Vehicle.nearMisses`). */
  nearMisses: z.number().int().nonnegative().optional(),
  /** The sim's per-vehicle `Tactics` object as stored (numbers rounded to 2 dp). */
  tactics: VehicleTacticsSchema.optional(),
  /** Next <= 12 planned waypoints flattened `[x0, y0, x1, y1, ...]` in integer tile units. Empty for human-driven vehicles. */
  path: z.array(z.number().int()).max(MAX_PATH_WAYPOINTS * 2).optional(),
  /** True when the vehicle was added beyond the base fleet (removable via `fleetRemove`), or is a player vehicle. */
  extra: z.boolean().optional(),
  /** Metadata of the vehicle's last REAL applied brain decision. Omitted until one exists. */
  decision: VehicleDecisionSchema.optional(),
});
export const VehicleDeltaSchema = QuantisedVehicleDeltaSchema;
export type QuantisedVehicleDelta = z.infer<typeof QuantisedVehicleDeltaSchema>;
export type VehicleDelta = QuantisedVehicleDelta;

/** Real server-side limits, so clients never hardcode caps. */
export const SiteLimitsSchema = z.object({
  /** Max concurrent human drivers per site (site `MAX_DRIVERS`). */
  maxDrivers: z.number().int().positive(),
  /** Max concurrent driving sockets per clientId (site `MAX_DRIVERS_PER_CLIENT`). */
  maxDriversPerClient: z.number().int().positive(),
  /** Absolute fleet cap (sim `FLEET_CAP` = BASE_FLEET + TIER_STEP * MAX_TIER). */
  fleetCap: z.number().int().positive(),
  /** Highest facility expansion tier (sim `MAX_TIER`). */
  maxTier: z.number().int().nonnegative(),
  /** Fleet size at tier 0 (sim `BASE_FLEET`). */
  baseFleet: z.number().int().positive(),
  /** Vehicles per tier step (sim `TIER_STEP`). */
  tierStep: z.number().int().positive(),
  /** Governor floor for `fleetRemove` (site `MIN_AUTONOMOUS_AGENTS`). */
  minAutonomousAgents: z.number().int().nonnegative().optional(),
  /** Governor ceiling for `fleetAdd` (site `MAX_AUTONOMOUS_AGENTS`). */
  maxAutonomousAgents: z.number().int().positive().optional(),
});
export type SiteLimits = z.infer<typeof SiteLimitsSchema>;

export const WelcomeMessageSchema = z.object({
  type: z.literal('welcome'),
  you: PlayerSessionInfoSchema,
  snapshot: z.any(),
  limits: SiteLimitsSchema.optional(),
});
export type WelcomeMessage = z.infer<typeof WelcomeMessageSchema>;

// ---- Mirrors of @warehouse/sim stats types (kept structurally identical) ----

/** One Strategy Board row = sim `board(world)` output element (trailing 60 game-minutes). */
export const BoardRowSchema = z.object({
  strat: z.string(),
  vehicles: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  perHr: z.number(),
  onTimePct: z.number().nullable(),
  incidents: z.number().int().nonnegative(),
  kwhPerOrder: z.number().nullable(),
});
export type BoardRow = z.infer<typeof BoardRowSchema>;

/** sim `ValueSample` (sampled every 5 game-minutes). */
export const ValueSampleSchema = z.object({
  t: z.number(),
  you: z.number(),
  avg: z.number(),
  best: z.number(),
});
export type ValueSample = z.infer<typeof ValueSampleSchema>;

/** sim `DayHistoryEntry` (exported from the sim as `DayRecord`). */
export const DayRecordSchema = z
  .object({
    day: z.number(),
    shipped: z.number(),
    onTimePct: z.number().nullable(),
    incidents: z.number(),
    nearMisses: z.number(),
    lost: z.number(),
    damaged: z.number(),
    poaches: z.number(),
    per: z.record(
      z
        .object({
          shipped: z.number(),
          onTimePct: z.number().nullable(),
          incidents: z.number(),
          kwhPerOrder: z.number().nullable(),
        })
        .passthrough(),
    ),
    winner: z.string(),
    tuned: z.record(z.unknown()),
  })
  .passthrough();
export type DayRecord = z.infer<typeof DayRecordSchema>;

/** sim `HallEntry` (one per closed shift). */
export const HallEntrySchema = z.object({
  shift: z.string(),
  id: z.string(),
  strat: z.string(),
  human: z.boolean(),
  driver: z.string().nullable(),
  pts: z.number(),
  scored: z.number(),
  diff: z.string(),
});
export type HallEntry = z.infer<typeof HallEntrySchema>;

/**
 * Sparse traffic heat layer. `cells` are `[tileIndex, value]` with
 * `tileIndex = y * w + x` and `value` = raw sim heat (decayed vehicle-minutes
 * spent on the tile), rounded to 0.1; tiles below HEAT_MIN_VALUE are omitted.
 */
export const HeatLayerSchema = z.object({
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  cells: z.array(z.tuple([z.number().int().nonnegative(), z.number().nonnegative()])),
});
export type HeatLayer = z.infer<typeof HeatLayerSchema>;

export const DeltaStatsSchema = z
  .object({
    totals: z.any().optional(),
    day: z.any().optional(),
    shift: z.any().optional(),
    shiftTime: z.number().optional(),
    rushUntil: z.number().optional(),
    /** sim `board(world)`, recomputed at most once per second. */
    board: z.array(BoardRowSchema).optional(),
    /** Value samples newer than the last one sent to THIS connection (append-only). */
    seriesAppend: z.array(ValueSampleSchema).optional(),
    /** Last 60 `world.history` entries, only when history changed since last sent to THIS connection. */
    history: z.array(DayRecordSchema).optional(),
    /** Full `world.hallOfFame`, only when changed since last sent to THIS connection. */
    hall: z.array(HallEntrySchema).optional(),
    /** Sparse heat, ~every 2 s, only to connections that sent `{type:'layers',traffic:true}`. */
    heat: HeatLayerSchema.optional(),
  })
  .passthrough();
export type DeltaStats = z.infer<typeof DeltaStatsSchema>;

/** Mirrors sim `Card['type']`. */
export const CARD_TYPES = [
  'route',
  'batch',
  'clean',
  'ontime',
  'quick',
  'charge',
  'overdrive',
  'long_reach',
  'eco_cell',
  'high_roller',
] as const;

export const CardSchema = z
  .object({
    id: z.string(),
    type: z.enum(CARD_TYPES),
    zone: z.string().optional(),
    bay: z.string().optional(),
    goal: z.number(),
    progress: z.number(),
    status: z.enum(['offer', 'active', 'done', 'lost', 'expired']),
    starter: z.boolean().optional(),
    pts: z.number(),
    title: z.string(),
    desc: z.string(),
    modifiers: z.record(z.number()).optional(),
  })
  .passthrough();
export type Card = z.infer<typeof CardSchema>;

export const CardHandSchema = z
  .object({
    shift: z.number(),
    offer: z.array(CardSchema).nullable(),
    cards: z.array(CardSchema),
    ai: z.boolean().optional(),
  })
  .passthrough();
export type CardHand = z.infer<typeof CardHandSchema>;

export const DeltaMessageSchema = z.object({
  type: z.literal('delta'),
  t: z.number(),
  vehicles: z.array(QuantisedVehicleDeltaSchema),
  orders: z.array(z.any()).optional(),
  hazards: z.array(z.any()).optional(),
  cones: z.array(z.string()).optional(),
  bays: z.array(z.any()).optional(),
  markers: z.array(z.any()).optional(),
  events: z.array(z.any()),
  stats: DeltaStatsSchema.optional(),
  votes: z.any().optional(),
  /** ONLY the recipient's own hand: `{ [recipientClientId]: CardHand }` (empty object when they hold none). */
  hands: z.record(CardHandSchema).optional(),
  difficulty: z.any().optional(),
  tier: z.number().optional(),
});
export type DeltaMessage = z.infer<typeof DeltaMessageSchema>;

export const AckMessageSchema = z.object({
  type: z.literal('ack'),
  seq: z.number().int().nonnegative(),
  x: z.number().optional(),
  y: z.number().optional(),
  vx: z.number().optional(),
  vy: z.number().optional(),
  angle: z.number().optional(),
  speedNow: z.number().optional(),
});
export type AckMessage = z.infer<typeof AckMessageSchema>;

export const PresenceEntrySchema = z.object({
  clientId: z.string().optional(),
  playerId: z.string().optional(),
  name: z.string().min(1),
  vid: z.string().nullable(),
  points: z.number().optional(),
  score: z.number().optional(),
  role: z.enum(['driver', 'spectator']).optional(),
  isBot: z.boolean().optional(),
});
export type PresenceEntry = z.infer<typeof PresenceEntrySchema>;

export const PresenceMessageSchema = z.object({
  type: z.literal('presence'),
  players: z.array(PresenceEntrySchema),
});
export type PresenceMessage = z.infer<typeof PresenceMessageSchema>;

export const BrainHealthMessageSchema = z.object({
  type: z.literal('brainHealth'),
  ok: z.boolean(),
  model: z.string().optional(),
  errors1m: z.number().nonnegative(),
  p50ms: z.number().nonnegative(),
  budgetLeftUsd: z.number(),
  armorBlocks1h: z.number().nonnegative().optional(),
});
export type BrainHealthMessage = z.infer<typeof BrainHealthMessageSchema>;

export const PhaseMessageSchema = z.object({
  type: z.literal('phase'),
  phase: PhaseSchema,
  resumesAt: z.number().optional(),
  reason: z.string().optional(),
});
export type PhaseMessage = z.infer<typeof PhaseMessageSchema>;

export const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string().min(1),
});
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

export const CommandEchoMessageSchema = z.object({
  type: z.literal('commandEcho'),
  text: z.string(),
  parsed: z.any(),
  executed: z.boolean(),
  reason: z.string().optional(),
});
export type CommandEchoMessage = z.infer<typeof CommandEchoMessageSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  WelcomeMessageSchema,
  DeltaMessageSchema,
  AckMessageSchema,
  PresenceMessageSchema,
  BrainHealthMessageSchema,
  PhaseMessageSchema,
  ErrorMessageSchema,
  CommandEchoMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export const SERVER_MESSAGE_TYPES = [
  'welcome',
  'delta',
  'ack',
  'presence',
  'brainHealth',
  'phase',
  'error',
  'commandEcho',
] as const;

// ============================================================================
// 6. Brain Decision Schemas & Gemini responseSchema Definitions
// ============================================================================

// DECISION_KINDS / DecisionKindSchema are declared in section 1 (used by vehicle deltas).

export const ContractDecisionSchema = z.object({
  orderIds: z.array(z.string()),
  reason: z.string().min(1).max(200),
});
export type ContractDecision = z.infer<typeof ContractDecisionSchema>;

export const HAZARD_CHOICES = ['reroute', 'wait', 'push'] as const;
export const HazardChoiceSchema = z.enum(HAZARD_CHOICES);
export type HazardChoice = z.infer<typeof HazardChoiceSchema>;

export const HazardDecisionSchema = z.object({
  choice: HazardChoiceSchema,
  reason: z.string().min(1).max(200),
});
export type HazardDecision = z.infer<typeof HazardDecisionSchema>;

export const TacticsDecisionSchema = z.object({
  speed: z.number().min(0.5).max(1.5),
  buffer: z.number().int().min(1).max(4),
  respect: z.number().min(0).max(1),
  chargeAt: z.number().min(5).max(50),
  batch: z.number().int().min(1).max(2),
  note: z.string().min(1).max(200),
});
export type TacticsDecision = z.infer<typeof TacticsDecisionSchema>;

export const CardsDecisionSchema = z.object({
  keep: z.array(z.string()).min(1).max(3),
  reason: z.string().max(200).optional(),
});
export type CardsDecision = z.infer<typeof CardsDecisionSchema>;

export const BrainDecisionSchema = z.union([
  ContractDecisionSchema,
  HazardDecisionSchema,
  TacticsDecisionSchema,
  CardsDecisionSchema,
]);
export type BrainDecision = z.infer<typeof BrainDecisionSchema>;

export const NlOrderActionSchema = z
  .object({
    action: ManagerOpSchema,
    x: z.number().int().min(0).max(59).optional(),
    y: z.number().int().min(0).max(120).optional(),
    echo: z.string().optional(),
  })
  .strict()
  .refine((val) => val.action !== 'cone' || (typeof val.x === 'number' && typeof val.y === 'number'), {
    message: 'cone action requires integer x and y coordinates',
  });
export type NlOrderAction = z.infer<typeof NlOrderActionSchema>;

export const NlOrderRefusalSchema = z
  .object({
    action: z.literal('refuse'),
    refuse: z.string().min(1),
    echo: z.string().optional(),
  })
  .strict();
export type NlOrderRefusal = z.infer<typeof NlOrderRefusalSchema>;

export const NlOrderSimpleRefusalSchema = z
  .object({
    refuse: z.string().min(1),
    reason: z.string().optional(),
  })
  .strict()
  .transform((v) => ({
    action: 'refuse' as const,
    refuse: v.refuse,
  }));

export const NlOrderParseSchema = z.union([
  NlOrderActionSchema,
  NlOrderRefusalSchema,
  NlOrderSimpleRefusalSchema,
]);
export type NlOrderParse = z.infer<typeof NlOrderParseSchema>;

export interface JsonSchemaObject {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: Record<string, unknown>;
  enum?: readonly string[];
  description?: string;
}

export const GEMINI_RESPONSE_SCHEMAS: Record<DecisionKind, JsonSchemaObject> = {
  contract: {
    type: 'OBJECT',
    properties: {
      orderIds: {
        type: 'ARRAY',
        items: { type: 'STRING' },
        description: 'IDs of 1 or 2 open orders selected by this vehicle.',
      },
      reason: {
        type: 'STRING',
        description: 'Concise explanation (<= 120 chars) of why these orders fit the persona.',
      },
    },
    required: ['orderIds', 'reason'],
  },
  hazard: {
    type: 'OBJECT',
    properties: {
      choice: {
        type: 'STRING',
        enum: HAZARD_CHOICES,
        description: 'Whether to reroute around the spill, wait for it to clear, or push through.',
      },
      reason: {
        type: 'STRING',
        description: 'Concise explanation (<= 120 chars) for the hazard decision.',
      },
    },
    required: ['choice', 'reason'],
  },
  tactics: {
    type: 'OBJECT',
    properties: {
      speed: { type: 'NUMBER', description: 'Speed multiplier between 0.8 and 1.35.' },
      buffer: { type: 'INTEGER', description: 'Reservation lookahead buffer tiles (1..3).' },
      respect: { type: 'NUMBER', description: 'Lane reservation yield probability (0.3..1.0).' },
      chargeAt: { type: 'NUMBER', description: 'Battery threshold percentage to seek a charger (10..35).' },
      batch: { type: 'INTEGER', description: 'Pallets per trip (1 or 2).' },
      note: { type: 'STRING', description: 'Concise explanation (<= 120 chars) of the retuned tactics.' },
    },
    required: ['speed', 'buffer', 'respect', 'chargeAt', 'batch', 'note'],
  },
  cards: {
    type: 'OBJECT',
    properties: {
      keep: {
        type: 'ARRAY',
        items: { type: 'STRING' },
        description: '1 to 3 dealt card IDs to keep for this shift.',
      },
      reason: {
        type: 'STRING',
        description: 'Optional brief reason for keeping these cards.',
      },
    },
    required: ['keep'],
  },
};

export const NL_ORDER_RESPONSE_SCHEMA: JsonSchemaObject = {
  type: 'OBJECT',
  properties: {
    action: {
      type: 'STRING',
      enum: ['rush', 'p0', 'cone', 'fleetAdd', 'fleetRemove', 'refuse'],
      description: 'Translated manager command or refuse.',
    },
    x: {
      type: 'INTEGER',
      description: 'Tile X coordinate (0..59), required only when action is cone.',
    },
    y: {
      type: 'INTEGER',
      description: 'Tile Y coordinate (0..120), required only when action is cone.',
    },
    echo: {
      type: 'STRING',
      description: 'Short human-readable summary of the parsed command (<= 120 chars).',
    },
    refuse: {
      type: 'STRING',
      description: 'Short explanation when action is refuse (<= 120 chars).',
    },
  },
  required: ['action'],
};

export function schemaForDecisionKind(kind: DecisionKind): JsonSchemaObject {
  return GEMINI_RESPONSE_SCHEMAS[kind];
}

// ============================================================================
// 7. Site <-> Site Transfer Schema (Pub/Sub site-transfers)
// ============================================================================

export const TransferSchema = z.object({
  id: z.string().min(1),
  fromSite: SiteIdSchema,
  toSite: SiteIdSchema,
  orderRef: z.string().min(1),
  sku: z.string().optional(),
  value: z.number().positive(),
  shippedAt: z.number().int().nonnegative(),
  carrier: z.string().min(1),
});
export type Transfer = z.infer<typeof TransferSchema>;
