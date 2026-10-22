import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const MAX_WS_FRAME_BYTES = 4096;
export const TILE_QUANT_SCALE = 32;

// ============================================================================
// 1. Site IDs, Phases, Difficulty & Constants
// ============================================================================

export const BASE_SITE_IDS = ['den-1', 'slc-2', 'phx-3', 'abq-4'] as const;
export const SITE_IDS: readonly string[] = BASE_SITE_IDS;
export type BaseSiteId = (typeof BASE_SITE_IDS)[number];

export const OVERFLOW_SITE_IDS = [
  'den-2', 'den-3', 'den-4', 'den-5',
  'slc-3', 'slc-4', 'slc-5',
  'phx-4', 'phx-5',
  'abq-5', 'abq-6',
] as const;

export function getOverflowSiteIds(maxPerRegion = 6): string[] {
  const baseNums: Record<'den' | 'slc' | 'phx' | 'abq', number> = {
    den: 1,
    slc: 2,
    phx: 3,
    abq: 4,
  };
  const result: string[] = [];
  for (const prefix of ['den', 'slc', 'phx', 'abq'] as const) {
    const start = baseNums[prefix] + 1;
    for (let n = start; n <= maxPerRegion; n++) {
      result.push(`${prefix}-${n}`);
    }
  }
  return result;
}

export const SiteIdSchema = z
  .string()
  .regex(/^(den|slc|phx|abq)-[1-9]\d*$/, 'Invalid regional site ID');
export type SiteId = z.infer<typeof SiteIdSchema>;

export function getRegionPrefix(siteId: string): 'den' | 'slc' | 'phx' | 'abq' {
  const prefix = siteId.split('-')[0]?.toLowerCase();
  if (prefix === 'den' || prefix === 'slc' || prefix === 'phx' || prefix === 'abq') {
    return prefix;
  }
  return 'den';
}

export function getCanonicalBaseSiteId(siteId: string): BaseSiteId {
  const prefix = getRegionPrefix(siteId);
  switch (prefix) {
    case 'slc':
      return 'slc-2';
    case 'phx':
      return 'phx-3';
    case 'abq':
      return 'abq-4';
    case 'den':
    default:
      return 'den-1';
  }
}

export function isValidSiteId(id: string): id is SiteId {
  return SiteIdSchema.safeParse(id).success;
}

export const PHASES = ['running', 'winding_down', 'break', 'resuming'] as const;
export const PhaseSchema = z.enum(PHASES);
export type Phase = z.infer<typeof PhaseSchema>;

export const DIFFICULTY_NAMES = [
  'easy',
  'normal',
  'medium',
  'hard',
  'turbo',
  'calm',
  'surge',
  'crisis',
] as const;
export const DifficultyNameSchema = z.enum(DIFFICULTY_NAMES);
export type DifficultyName = z.infer<typeof DifficultyNameSchema>;

export const DifficultyLevelSchema = z.union([
  DifficultyNameSchema,
  z.number().int().min(1).max(5),
]);
export type DifficultyLevel = z.infer<typeof DifficultyLevelSchema>;

export const MANAGER_OPS = ['rush', 'p0', 'cone', 'fleetAdd', 'fleetRemove', 'dispatch'] as const;
export const ManagerOpSchema = z.enum(MANAGER_OPS);
export type ManagerOp = z.infer<typeof ManagerOpSchema>;

export const DISPATCH_SOURCE_ZONES = [
  'haz',
  'cold',
  'bulk',
  'high',
  'general',
  'any',
  'A',
  'B',
  'C',
  'D',
  'E',
  'U',
  'W',
  'X',
  'Z',
] as const;
export const DispatchSourceZoneSchema = z.enum(DISPATCH_SOURCE_ZONES);
export type DispatchSourceZone = z.infer<typeof DispatchSourceZoneSchema>;

export const DISPATCH_TARGET_BAYS = [
  'RET',
  'E1',
  'E2',
  'E3',
  'E4',
  'E5',
  'E6',
  'E7',
  'E8',
  'auto',
] as const;
export const DispatchTargetBaySchema = z.enum(DISPATCH_TARGET_BAYS);
export type DispatchTargetBay = z.infer<typeof DispatchTargetBaySchema>;

export const DISPATCH_PRIORITIES = ['p0', 'urgent', 'standard'] as const;
export const DispatchPrioritySchema = z.enum(DISPATCH_PRIORITIES);
export type DispatchPriority = z.infer<typeof DispatchPrioritySchema>;

export const DISPATCH_MODES = ['reroute_and_spawn', 'reroute_only', 'spawn_only'] as const;
export const DispatchModeSchema = z.enum(DISPATCH_MODES);
export type DispatchMode = z.infer<typeof DispatchModeSchema>;

/** Max orders one `dispatch` Floor order may reroute/spawn (schema cap + sim clamp). */
export const DISPATCH_MAX_COUNT = 8;

export const DispatchParamsSchema = z.object({
  sourceZone: DispatchSourceZoneSchema,
  targetBay: DispatchTargetBaySchema,
  priority: DispatchPrioritySchema.optional(),
  count: z.number().int().min(1).max(DISPATCH_MAX_COUNT).optional(),
  mode: DispatchModeSchema.optional(),
});
export type DispatchParams = z.infer<typeof DispatchParamsSchema>;

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
export function normaliseDifficultyKey(
  level: DifficultyLevel,
): 'easy' | 'normal' | 'hard' | 'turbo' {
  if (typeof level === 'number') {
    if (level <= 1) return 'easy';
    if (level === 2) return 'normal';
    if (level === 3 || level === 4) return 'hard';
    return 'turbo';
  }
  switch (level) {
    case 'easy':
    case 'calm':
      return 'easy';
    case 'normal':
    case 'medium':
      return 'normal';
    case 'hard':
    case 'surge':
    case 'crisis':
      return 'hard';
    case 'turbo':
      return 'turbo';
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

export const RUN_MODES = ['blitz', 'freerange'] as const;
export const RunModeSchema = z.enum(RUN_MODES);
export type RunMode = z.infer<typeof RunModeSchema>;

export const FREE_RANGE_SOFT_CAP = 26;
export const FREE_RANGE_HARD_CAP = 30;
export const RELOCATION_BONUS_PTS = 75;

export const QueueStateSchema = z.enum(['none', 'queued', 'ready', 'claimed', 'expired']);
export type QueueState = z.infer<typeof QueueStateSchema>;

export const QueueStatusSchema = z.object({
  state: QueueStateSchema,
  position: z.number().int().nonnegative(),
  totalQueued: z.number().int().nonnegative(),
  queueSize: z.number().int().nonnegative().optional(),
  estimatedWaitSec: z.number().int().nonnegative(),
  preferredSite: SiteIdSchema.optional(),
  seatLeaseId: z.string().min(4).max(96).optional(),
  claimExpiresAt: z.number().int().nonnegative().optional(),
  leaseExpiresAt: z.number().int().nonnegative().optional(),
  claimSiteId: SiteIdSchema.optional(),
  assignedSiteId: SiteIdSchema.optional(),
  claimTicket: z.string().optional(),
  claimWsUrl: z.string().optional(),
});
export type QueueStatus = z.infer<typeof QueueStatusSchema>;

export const JoinRequestSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  clientId: z.string().min(1).max(128),
  prefer: SiteIdSchema.optional(),
  resume: z.string().min(2).max(64).optional(),
  mode: RunModeSchema.optional(),
  runMode: RunModeSchema.optional(),
  requeue: z.boolean().optional(),
  seatLeaseId: z.string().min(4).max(96).optional(),
  spectateOnly: z.boolean().optional(),
});
export type JoinRequest = z.infer<typeof JoinRequestSchema>;

/** Lobby-issued resume code (`JoinResponse.resumeToken`; sent back in `JoinRequest.resume`). */
export const RESUME_TOKEN_PATTERN = /^wr1_[A-Za-z0-9_-]{32}$/;
export const ResumeTokenSchema = z.string().regex(RESUME_TOKEN_PATTERN);

/**
 * Opaque public player id (`p1_` + 22 base64url chars), derived by the lobby/site from the raw
 * clientId. Every player id the site or the leaderboard sends is a publicId; the raw clientId is a
 * bearer credential that stays with its owner (localStorage + lobby calls) and is never displayed.
 */
export const PUBLIC_ID_PATTERN = /^p1_[A-Za-z0-9_-]{22}$/;
export const PublicIdSchema = z.string().regex(PUBLIC_ID_PATTERN);

export const JoinResponseSchema = z.object({
  siteId: SiteIdSchema,
  wsUrl: z.string().min(1),
  ticket: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
  name: z.string().min(2).max(20).optional(),
  clientId: z.string().min(1).max(128).optional(),
  role: z.enum(['driver', 'spectator']).optional(),
  isBot: z.boolean().optional(),
  queue: QueueStatusSchema.optional(),
  /** Human joins only: the player's resume code (store it; show it as the "resume code"). */
  resumeToken: ResumeTokenSchema.optional(),
  /** The caller's own publicId; matches its `/api/network` leaderboard row and every id the site sends. */
  publicId: PublicIdSchema.optional(),
});
export type JoinResponse = z.infer<typeof JoinResponseSchema>;
export const ExtendedJoinResponseSchema = JoinResponseSchema;
export type ExtendedJoinResponse = JoinResponse;

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
  /** Always equal to `publicId` on the wire (never the raw clientId); kept for compatibility. */
  clientId: z.string().min(1),
  /** Opaque public id (optional during rollout); match your own row with `JoinResponse.publicId`. */
  publicId: PublicIdSchema.optional(),
  name: z.string().min(1),
  siteId: SiteIdSchema.optional(),
  points: z.number().optional(),
  lifetimePoints: z.number().optional(),
  bestBlitzPts: z.number().int().min(0).optional(),
  deliveries: z.number().int().nonnegative(),
  /** Optional pallets-per-minute; rendered only when a server supplies it (not populated yet). */
  ppm: z.number().nonnegative().optional(),
  isBot: z.boolean().optional(),
});
export const PlayerLeaderboardEntrySchema = LeaderboardEntrySchema;
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;
export type PlayerLeaderboardEntry = LeaderboardEntry;

export const NetworkResponseSchema = z.object({
  sites: z.array(SiteStatusSchema),
  leaderboard: z.array(LeaderboardEntrySchema),
  queueSize: z.number().int().min(0).optional(),
  totalQueued: z.number().int().min(0).optional(),
  maxTotalDrivers: z.number().int().positive().optional(),
  maxWarehouses: z.number().int().positive().optional(),
});
export type NetworkResponse = z.infer<typeof NetworkResponseSchema>;

export const TicketPayloadSchema = z.object({
  clientId: z.string().min(1),
  name: z.string().min(1),
  siteId: SiteIdSchema,
  isBot: z.boolean(),
  exp: z.number().int().nonnegative(),
  runMode: RunModeSchema.optional(),
  carryPts: z.number().int().min(0).optional(),
  carryDeliveries: z.number().int().min(0).optional(),
  carryStreak: z.number().int().min(0).optional(),
  carryCards: z.array(z.string()).max(6).optional(),
  relocationBonus: z.number().int().min(0).optional(),
  role: z.enum(['driver', 'spectator']).optional(),
  jti: z.string().min(4).max(64).optional(),
  seatLeaseId: z.string().min(4).max(64).optional(),
});
export const JoinTicketPayloadSchema = TicketPayloadSchema;
export type TicketPayload = z.infer<typeof TicketPayloadSchema>;
export type JoinTicketPayload = TicketPayload;

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

export const PROXY_HEADER_NAME = 'x-warehouse-proxy';

export const ProxyHeaderPayloadSchema = z.object({
  siteId: SiteIdSchema,
  exp: z.number().int().nonnegative(),
});
export type ProxyHeaderPayload = z.infer<typeof ProxyHeaderPayloadSchema>;

/**
 * Signs a short-lived, domain-separated HMAC token proving a WebSocket upgrade
 * or internal HTTP request was forwarded by the trusted frontend lobby gateway.
 */
export function signProxyHeader(
  siteId: SiteId,
  secret: string,
  nowMs: number = Date.now(),
  ttlMs: number = 60_000,
): string {
  const payload: ProxyHeaderPayload = ProxyHeaderPayloadSchema.parse({
    siteId,
    exp: nowMs + ttlMs,
  });
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(`proxy:${body}`).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Verifies the `x-warehouse-proxy` HMAC token attached by the lobby gateway.
 */
export function verifyProxyHeader(
  headerValue: string | undefined,
  expectedSiteId: SiteId,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  if (!headerValue || typeof headerValue !== 'string') return false;
  const parts = headerValue.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [body, sig] = parts;
  const expectedSig = createHmac('sha256', secret).update(`proxy:${body}`).digest('base64url');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }
  try {
    const raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const parsed = ProxyHeaderPayloadSchema.safeParse(raw);
    if (!parsed.success) return false;
    if (parsed.data.siteId !== expectedSiteId) return false;
    if (parsed.data.exp <= nowMs) return false;
    return true;
  } catch {
    return false;
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
  boost: z.boolean().optional(),
  moveAngle: z.number().finite().nullable().optional(),
  seq: z.number().int().nonnegative(),
  dt: z.number().min(0).max(2).optional(),
});
export type InputMessage = z.infer<typeof InputMessageSchema>;

export const InteractMessageSchema = z.object({
  type: z.literal('interact'),
  forkHeight: z.number().finite().min(0).max(1).optional(),
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
  dispatch: DispatchParamsSchema.optional(),
});
export type ManagerMessage = z.infer<typeof ManagerMessageSchema>;

export const A2uiActionMessageSchema = z.object({
  type: z.literal('a2uiAction'),
  screenId: z.string().min(1),
  actionId: z.string().min(1),
  dispatch: DispatchParamsSchema.optional(),
  managerOp: ManagerOpSchema.optional(),
});
export type A2uiActionMessage = z.infer<typeof A2uiActionMessageSchema>;

export const KeepCardsMessageSchema = z.object({
  type: z.literal('keepCards'),
  ids: z.array(z.string()),
});
export type KeepCardsMessage = z.infer<typeof KeepCardsMessageSchema>;

/**
 * Reserve one of the driver's current order options (`QuantisedVehicleDelta.fareOffer`).
 * Rate-limited by site governance; a rejected pick returns an `error` (`governance_limit` / `choose_order_failed`).
 */
export const ChooseOrderMessageSchema = z.object({
  type: z.literal('chooseOrder'),
  orderId: z.number().int().nonnegative(),
});
export type ChooseOrderMessage = z.infer<typeof ChooseOrderMessageSchema>;

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

export const VehicleIdSchema = z.string().min(1).max(32);
export type VehicleId = z.infer<typeof VehicleIdSchema>;

export const AgentPrioritySchema = z.enum([
  'balanced',
  'normal',
  'p0_first',
  'high_value',
  'nearest',
  'transfers',
  'transfers_first',
  'zone_focus',
  'bay_focus',
]);
export type AgentPriority = z.infer<typeof AgentPrioritySchema>;

export const ImmediateTaskKindSchema = z.enum([
  'auto',
  'charge',
  'charge_now',
  'return_home',
  'deliver_cargo',
  'pick_p0',
  'pick_hazmat',
  'clear_spill',
  'zone',
  'bay',
  'order',
]);
export type ImmediateTaskKind = z.infer<typeof ImmediateTaskKindSchema>;

export const PartialVehicleTacticsSchema = z.object({
  speed: z.number().min(0.6).max(1.4).optional(),
  respect: z.number().min(0.3).max(1.0).optional(),
  buffer: z.number().int().min(1).max(4).optional(),
  chargeAt: z.number().min(8).max(40).optional(),
  batch: z.number().int().min(1).max(3).optional(),
  flatPath: z.union([z.number().min(0.4).max(1.5), z.boolean()]).optional(),
  preemptForP0: z.boolean().optional(),
  poach: z.boolean().optional(),
  note: z.string().max(120).optional(),
});
export type PartialVehicleTactics = z.infer<typeof PartialVehicleTacticsSchema>;

export const AgentDirectiveSchema = z.object({
  autopilot: z.boolean().optional(),
  strategy: z.enum(['Sprinter', 'Batcher', 'Steady', 'Opportunist', 'Strategist']).optional(),
  persona: z.enum(['Sprinter', 'Batcher', 'Steady', 'Opportunist', 'Strategist']).optional(),
  tactics: PartialVehicleTacticsSchema.optional(),
  focusZones: z.array(z.string().regex(/^[A-Z]$/)).max(6).optional(),
  focusBays: z.array(z.string().regex(/^(?:B\d+|E\d+|RET)$/)).max(12).optional(),
  preferredZone: z.string().regex(/^[A-Z]$/).optional(),
  preferredBay: z.string().regex(/^(?:B\d+|E\d+|RET)$/).optional(),
  preferredZones: z.array(z.string()).max(6).optional(),
  preferredBays: z.array(z.string()).max(12).optional(),
  avoidZones: z.array(z.string()).max(6).optional(),
  priority: AgentPrioritySchema.optional(),
  immediateTask: z
    .union([
      ImmediateTaskKindSchema,
      z.object({
        kind: ImmediateTaskKindSchema,
        target: z.string().max(24).optional(),
        orderId: z.number().int().nullable().optional(),
        zone: z.string().nullable().optional(),
        bay: z.string().nullable().optional(),
      }),
    ])
    .nullable()
    .optional(),
  summary: z.string().max(120).optional(),
  updatedAt: z.number().optional(),
});
export type AgentDirective = z.infer<typeof AgentDirectiveSchema>;

const AgentCommandBaseSchema = z.object({
  type: z.literal('agentCommand'),
  vid: VehicleIdSchema.optional(),
  text: z.string().min(1).max(200).optional(),
  mode: z.enum(['autopilot', 'manual']).optional(),
  directive: AgentDirectiveSchema.optional(),
});

export const AgentCommandMessageSchema = AgentCommandBaseSchema.refine(
  (m) => Boolean(m.text && m.text.trim().length > 0) || Boolean(m.directive) || Boolean(m.mode),
  {
    message: 'agentCommand requires text, directive, or mode',
  },
);
export type AgentCommandMessage = z.infer<typeof AgentCommandMessageSchema>;

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

export const SetRunModeMessageSchema = z.object({
  type: z.literal('setRunMode'),
  mode: RunModeSchema,
});
export type SetRunModeMessage = z.infer<typeof SetRunModeMessageSchema>;

export const AcceptRelocationMessageSchema = z.object({
  type: z.literal('acceptRelocation'),
  toSite: SiteIdSchema.optional(),
  targetSite: SiteIdSchema.optional(),
});
export type AcceptRelocationMessage = z.infer<typeof AcceptRelocationMessageSchema>;

/** Per-connection Dispatcher's Call opt-in/out (client `?dispatch=` / localStorage override). */
export const DispatchersCallPrefMessageSchema = z.object({
  type: z.literal('dispatchersCallPref'),
  enabled: z.boolean(),
});
export type DispatchersCallPrefMessage = z.infer<typeof DispatchersCallPrefMessageSchema>;

export const ClientMessageSchema = z
  .discriminatedUnion('type', [
    HelloMessageSchema,
    InputMessageSchema,
    InteractMessageSchema,
    TakeWheelMessageSchema,
    ReleaseMessageSchema,
    ManagerMessageSchema,
    KeepCardsMessageSchema,
    ChooseOrderMessageSchema,
    VoteDifficultyMessageSchema,
    NlCommandMessageSchema,
    AgentCommandBaseSchema,
    TransferSiteMessageSchema,
    LayersMessageSchema,
    A2uiActionMessageSchema,
    SetRunModeMessageSchema,
    AcceptRelocationMessageSchema,
    DispatchersCallPrefMessageSchema,
  ])
  .superRefine((m, ctx) => {
    if (
      m.type === 'agentCommand' &&
      !(Boolean(m.text && m.text.trim().length > 0) || Boolean(m.directive) || Boolean(m.mode))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'agentCommand requires text, directive, or mode',
      });
    }
  });
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const CLIENT_MESSAGE_TYPES = [
  'hello',
  'input',
  'interact',
  'takeWheel',
  'release',
  'manager',
  'keepCards',
  'chooseOrder',
  'voteDifficulty',
  'nlCommand',
  'agentCommand',
  'transferSite',
  'layers',
  'a2uiAction',
  'setRunMode',
  'acceptRelocation',
  'dispatchersCallPref',
] as const;

// ============================================================================
// 5. Site -> Client WebSocket Schemas
// ============================================================================

export const PlayerSessionInfoSchema = z.object({
  /** The recipient's publicId on the wire (not its raw clientId); never persist it as the raw id. */
  clientId: z.string().min(1),
  playerId: z.string().optional(),
  name: z.string().min(1),
  vid: z.string().nullable(),
  role: z.enum(['driver', 'spectator']).optional(),
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

/** Warehouse rack or dock slot (sim `Slot`). `level` is shelf height `0 | 1 | 2` (L1 Low, L2 Mid, L3 High). */
export const SlotSchema = z.object({
  key: z.string(),
  rackId: z.string(),
  zone: z.string(),
  rx: z.number().int(),
  ry: z.number().int(),
  ax: z.number().int(),
  ay: z.number().int(),
  level: z.number().int().min(0).max(2).optional(),
});
export type ProtocolSlot = z.infer<typeof SlotSchema>;

/** Order colour class: 🟢 short hop, 🟡 cross-floor, 🔴 long haul / P0, 🟣 own contract. */
export const FareClassSchema = z.enum(['short', 'cross', 'long', 'contract']);
export type FareClass = z.infer<typeof FareClassSchema>;

/** One order option (sim `FareOption`). Pars are game-minutes; tiles is Manhattan distance. */
export const FareOptionSchema = z.object({
  orderId: z.number().int().nonnegative(),
  farClass: FareClassSchema,
  carpool: z.boolean(),
  p0: z.boolean(),
  bay: z.string(),
  value: z.number(),
  tiles: z.number().nonnegative(),
  parEmpty: z.number().nullable(),
  parLoaded: z.number().nullable(),
  /** Inbound pallet bound for a rack (stow) rather than an outbound bay. */
  putaway: z.boolean().optional(),
  /** Rack id the inbound pallet stows into. */
  putawayRack: z.string().nullable().optional(),
  /** Outbound bay that accepts this inbound pallet as a cross-dock (human drivers only). */
  xdockBay: z.string().nullable().optional(),
  /** Game-minutes left in the cross-dock window; null once closed. */
  xdockLeft: z.number().nullable().optional(),
});
export type FareOption = z.infer<typeof FareOptionSchema>;

/**
 * Open order choice (sim `FareOffer`): Co-Pilot pick first. After 5 game-min the
 * Co-Pilot reserves `copilotId` (a Carpool offer lapses instead).
 */
export const FareOfferSchema = z.object({
  since: z.number(),
  options: z.array(FareOptionSchema).max(3),
  copilotId: z.number().int().nonnegative(),
  reason: z.string(),
  carpool: z.boolean(),
});
export type FareOffer = z.infer<typeof FareOfferSchema>;

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
  humanCharging: z.boolean().optional(),
  strategy: z.string().optional(),
  type: z.string().optional(),
  braking: z.boolean().optional(),
  stunnedUntil: z.number().optional(),
  sPts: z.number().optional(),
  sShipped: z.number().optional(),
  runMode: RunModeSchema.optional(),
  runStartedAt: z.number().nullable().optional(),
  runEndsAt: z.number().nullable().optional(),
  runGraceUntil: z.number().nullable().optional(),
  runTimeLeft: z.number().optional(),
  runPts: z.number().optional(),
  runDeliveries: z.number().int().optional(),
  runOnTime: z.number().int().optional(),
  runIncidents: z.number().int().optional(),
  streak: z.number().int().optional(),
  bestStreak: z.number().int().optional(),
  /** Current fare combo multiplier (1.0 / 1.2 / 1.5 / 2.0). */
  combo: z.number().optional(),
  /** Best combo reached this run. */
  comboBest: z.number().optional(),
  /** Fares (delivered pallets) rated this run. */
  fareTrips: z.number().int().nonnegative().optional(),
  /** Speedy-rated fares this run. */
  speedyTrips: z.number().int().nonnegative().optional(),
  ppm: z.number().optional(),
  /** Open order choice for this driver (own vehicle only). null = no choice open. */
  fareOffer: FareOfferSchema.nullable().optional(),
  /** AI rival assigned to this human driver (closest shift score). */
  rivalId: z.string().nullable().optional(),
  onTimePct: z.number().nullable().optional(),
  runFinished: z.boolean().optional(),
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
  /** Lifetime spill skid count for this vehicle (sim `Vehicle.skids`). */
  skids: z.number().int().nonnegative().optional(),
  /** Lifetime dropped pallet count on collision for this vehicle (sim `Vehicle.palletDrops`). */
  palletDrops: z.number().int().nonnegative().optional(),
  /** Lifetime delivered pallet count for this vehicle (sim `Vehicle.deliveries`). */
  deliveries: z.number().int().nonnegative().optional(),
  /** The sim's per-vehicle `Tactics` object as stored (numbers rounded to 2 dp). */
  tactics: VehicleTacticsSchema.optional(),
  /** Next <= 12 planned waypoints flattened `[x0, y0, x1, y1, ...]` in integer tile units. Empty for human-driven vehicles. */
  path: z.array(z.number().int()).max(MAX_PATH_WAYPOINTS * 2).optional(),
  /** True when the vehicle was added beyond the base fleet (removable via `fleetRemove`), or is a player vehicle. */
  extra: z.boolean().optional(),
  /** Metadata of the vehicle's last REAL applied brain decision. Omitted until one exists. */
  decision: VehicleDecisionSchema.optional(),
  /** True when a human-owned vehicle is actively executing under Co-Pilot autopilot. */
  autopilot: z.boolean().optional(),
  /** Active Co-Pilot / Agent Designer directive on this vehicle. */
  directive: AgentDirectiveSchema.nullable().optional(),
});
export const VehicleDeltaSchema = QuantisedVehicleDeltaSchema;
export const WireVehicleSchema = QuantisedVehicleDeltaSchema;
export type QuantisedVehicleDelta = z.infer<typeof QuantisedVehicleDeltaSchema>;
export type VehicleDelta = QuantisedVehicleDelta;
export type WireVehicle = QuantisedVehicleDelta;

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
  /** Site-wide cap on open P0 orders for the `p0` Floor order (site `MAX_OPEN_P0_ON_FLOOR`). */
  maxOpenP0: z.number().int().positive().optional(),
  /** Live cones one player may own (site `MAX_CONES_PER_PLAYER`). */
  conesPerPlayer: z.number().int().positive().optional(),
  /** Cone lifetime in game-minutes before auto-expiry (site `CONE_EXPIRY_SEC`, 1 game-min = 1 real s). */
  coneTtlGameMin: z.number().int().positive().optional(),
  /** Max orders one `dispatch` may move (protocol `DISPATCH_MAX_COUNT`). */
  dispatchMaxCount: z.number().int().positive().optional(),
  /** `nlCommand` budget per player per real minute (armor `PLAYER_RATE_LIMIT_PER_MIN`). */
  nlPerMinute: z.number().int().positive().optional(),
  /** Opt-in feature flag for the Rack Height Fork-Lift Minigame (site `FEATURE_RACK_LIFT_MINIGAME`). */
  rackLiftMinigame: z.boolean().optional(),
  /** Dispatcher's Call minigame enabled on this site (site `ENABLE_DISPATCHERS_CALL`, default on). */
  dispatchersCall: z.boolean().optional(),
});
export type SiteLimits = z.infer<typeof SiteLimitsSchema>;

/** Per-recipient Floor-order state (real server enforcement). All *InMs are REAL milliseconds until this player may issue it again; 0 = ready. */
export const FloorOrdersStatusSchema = z.object({
  rush: z.object({ readyInMs: z.number().int().nonnegative() }),
  p0: z.object({ open: z.number().int().nonnegative(), readyInMs: z.number().int().nonnegative() }),
  cones: z.object({ mine: z.array(z.string()) }), // "x,y" keys of cones THIS player owns
  dispatch: z.object({ readyInMs: z.number().int().nonnegative() }),
  fleet: z.object({
    addReadyInMs: z.number().int().nonnegative(),
    removable: z.number().int().nonnegative(),
  }), // removable = vehicles the governor would currently let fleetRemove take
  nl: z.object({
    left: z.number().int().nonnegative(),
    resetInMs: z.number().int().nonnegative(),
  }), // nlCommand budget (6/min)
});
export type FloorOrdersStatus = z.infer<typeof FloorOrdersStatusSchema>;

export const WelcomeMessageSchema = z.object({
  type: z.literal('welcome'),
  role: z.enum(['driver', 'spectator']).optional(),
  you: PlayerSessionInfoSchema,
  snapshot: z.any(),
  limits: SiteLimitsSchema.optional(),
  /** Recipient's own Floor-order state at join time. */
  floorOrders: FloorOrdersStatusSchema.optional(),
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

export const CompletedRunRecordSchema = z
  .object({
    id: z.string(),
    vehicleId: z.string(),
    /** The driver's publicId on the wire (never a raw clientId). */
    clientId: z.string().nullable(),
    driver: z.string(),
    baseName: z.string(),
    runNumber: z.number().int().positive(),
    type: z.enum([
      'reach',
      'counterbalance',
      'tug',
      'turret',
      'pallet_jack',
      'forklift',
      'agv',
    ]),
    runMode: z.enum(['blitz', 'freerange']),
    pts: z.number(),
    shipped: z.number(),
    onTime: z.number(),
    incidents: z.number(),
    streak: z.number(),
    bestStreak: z.number(),
    comboBest: z.number(),
    speedyTrips: z.number(),
    fareTrips: z.number(),
    ppm: z.number(),
    startedAt: z.number(),
    endedAt: z.number(),
  });

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
    /** Archived completed human runs in the current shift. */
    completedRuns: z.array(CompletedRunRecordSchema).optional(),
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
  'long_haul',
  'local_hero',
  'beat_planner',
  'poacher',
  'trailer_closer',
  'crazy_stop',
  'combo_king',
  'double_nothing',
  'rival_grudge',
  'ghost_hunter',
  'last_call',
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
    /** 'wild' cards are rare gambles (at most one held); default 'common'. */
    rarity: z.enum(['common', 'wild']).optional(),
    /** Never dealt to AI agents. */
    humanOnly: z.boolean().optional(),
    /** Perk granted once the card is completed (status 'done'). */
    perk: z.record(z.number()).optional(),
    completedAt: z.number().optional(),
    /** Rival Grudge: game time the window closes. */
    until: z.number().optional(),
    /** Rival Grudge: rival id and both delivery counts when the window opened. */
    rivalBase: z.object({ rivalId: z.string(), self: z.number(), rival: z.number() }).optional(),
  })
  .passthrough();
export type Card = z.infer<typeof CardSchema>;

export const CardHandSchema = z
  .object({
    shift: z.number(),
    offer: z.array(CardSchema).nullable(),
    cards: z.array(CardSchema),
    ai: z.boolean().optional(),
    /** Max cards keepable from the current offer (1 on replacement draws). */
    pick: z.number().int().positive().optional(),
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
  /** ONLY the recipient's own Floor-order state; on full deltas, when changed (timers refreshed ≤ 1/s). */
  floorOrders: FloorOrdersStatusSchema.optional(),
  difficulty: z.any().optional(),
  tier: z.number().optional(),
});
export type DeltaMessage = z.infer<typeof DeltaMessageSchema>;

export const AckMessageSchema = z.object({
  type: z.literal('ack'),
  seq: z.number().int().nonnegative(),
  t: z.number().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  vx: z.number().optional(),
  vy: z.number().optional(),
  angle: z.number().optional(),
  speedNow: z.number().optional(),
});
export type AckMessage = z.infer<typeof AckMessageSchema>;

export const PresenceEntrySchema = z.object({
  /** The player's publicId on the wire (never a raw clientId). */
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

/** Model Armor pipeline stages that can block a typed command (7-layer pipeline numbering). */
export const ARMOR_BLOCK_STAGES = ['sanitizeUserPrompt', 'sanitizeModelResponse'] as const;
export const ArmorBlockStageSchema = z.enum(ARMOR_BLOCK_STAGES);
export type ArmorBlockStage = z.infer<typeof ArmorBlockStageSchema>;

/**
 * Which armor layer blocked a typed command (`commandEcho.armor`), copied from the real
 * Model Armor verdict: `layer` is the pipeline layer number (2 = input screen, 6 = output screen),
 * `filter` the verdict filter (`pi_and_jailbreak`, `malicious_uri`, `rai`, `unknown`), and
 * `strikes` the server-side strike count for the sender after this block.
 */
export const CommandEchoArmorSchema = z.object({
  layer: z.number().int().min(1).max(7),
  stage: ArmorBlockStageSchema,
  filter: z.string().min(1).max(40),
  strikes: z.number().int().nonnegative().optional(),
  muted: z.boolean().optional(),
});
export type CommandEchoArmor = z.infer<typeof CommandEchoArmorSchema>;

export const CommandEchoMessageSchema = z.object({
  type: z.literal('commandEcho'),
  text: z.string(),
  parsed: z.any().optional(),
  executed: z.boolean().optional(),
  reason: z.string().optional(),
  status: z.enum(['executed', 'rejected']).optional(),
  summary: z.string().optional(),
  directive: AgentDirectiveSchema.optional(),
  /** Present only when Model Armor blocked the command (`reason: 'armor_blocked'`). */
  armor: CommandEchoArmorSchema.optional(),
});
export type CommandEchoMessage = z.infer<typeof CommandEchoMessageSchema>;

/**
 * A completed Gemini decision for an AI vehicle, broadcast to every socket by the site brain
 * scheduler. `agentId` is the numeric part of the vehicle id (`FL-03` → 3); `vid` is the full
 * vehicle id when the server includes it. `note` is the model's own ≤200-char reason.
 */
export const BrainDecisionMessageSchema = z.object({
  type: z.literal('brainDecision'),
  reqId: z.number().int().nonnegative(),
  agentId: z.number().int().nonnegative(),
  vid: z.string().min(1).optional(),
  kind: DecisionKindSchema,
  decision: z.record(z.unknown()),
  note: z.string(),
  latencyMs: z.number().nonnegative(),
  tokensIn: z.number().nonnegative(),
  tokensOut: z.number().nonnegative(),
  model: z.string(),
});
export type BrainDecisionMessage = z.infer<typeof BrainDecisionMessageSchema>;

export const A2uiTelemetryPillSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().min(1),
  tone: z.enum(['neutral', 'amber', 'red', 'green', 'blue', 'purple']).optional(),
});
export type A2uiTelemetryPill = z.infer<typeof A2uiTelemetryPillSchema>;

export const A2uiOptionChipSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  badge: z.string().optional(),
});
export type A2uiOptionChip = z.infer<typeof A2uiOptionChipSchema>;

export const A2uiSelectorGroupSchema = z.object({
  field: z.enum(['sourceZone', 'targetBay', 'priority', 'count']),
  label: z.string().min(1),
  selected: z.string().min(1),
  options: z.array(A2uiOptionChipSchema).min(1),
});
export type A2uiSelectorGroup = z.infer<typeof A2uiSelectorGroupSchema>;

export const A2uiPresetButtonSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  desc: z.string().min(1),
  dispatch: DispatchParamsSchema.optional(),
  managerOp: ManagerOpSchema.optional(),
});
export type A2uiPresetButton = z.infer<typeof A2uiPresetButtonSchema>;

export const DISPATCHERS_CALL_SITUATIONS = [
  'spill',
  'p0_surge',
  'trailer_near_cap',
  'hazmat_backlog',
  'dock_backlog',
] as const;
export const DispatchersCallSituationSchema = z.enum(DISPATCHERS_CALL_SITUATIONS);

/** Full dispatch action of one Dispatcher's Call option (all fields resolved). */
export const DispatchersCallActionSchema = z.object({
  sourceZone: DispatchSourceZoneSchema,
  targetBay: DispatchTargetBaySchema,
  priority: DispatchPrioritySchema,
  count: z.number().int().min(1).max(DISPATCH_MAX_COUNT),
  mode: DispatchModeSchema,
});

/**
 * Dispatcher's Call minigame attached to an `a2uiScreen` (sent only to the driver it is
 * for). Pick with `a2uiAction { screenId: id, actionId: 'dc-opt-<idx>' }`; the server
 * executes its stored action for that option (client `dispatch` is ignored).
 */
export const DispatchersCallMinigameSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('dispatchers_call'),
  /** Real ms the player has to pick, from receipt. */
  deadlineMs: z.number().int().positive(),
  /** Game time the sim times the pick out. */
  deadlineT: z.number(),
  situation: DispatchersCallSituationSchema,
  question: z.string().min(1).max(90),
  options: z
    .array(
      z.object({
        idx: z.number().int().nonnegative(),
        label: z.string().min(1).max(48),
        desc: z.string().min(1),
        action: DispatchersCallActionSchema,
      }),
    )
    .min(2)
    .max(3),
});
export type DispatchersCallMinigame = z.infer<typeof DispatchersCallMinigameSchema>;

export const A2uiScreenMessageSchema = z.object({
  type: z.literal('a2uiScreen'),
  screenId: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().min(1),
  rawText: z.string().optional(),
  clarifyQuestion: z.string().optional(),
  telemetry: z.array(A2uiTelemetryPillSchema),
  selectors: z.array(A2uiSelectorGroupSchema),
  presets: z.array(A2uiPresetButtonSchema),
  recommendedDispatch: DispatchParamsSchema,
  /**
   * Who pre-filled `recommendedDispatch`: `model` = Gemini proposed it, `heuristic` = keyword
   * match on the player's words. Absent = no AI attribution (e.g. a plain default).
   */
  recommendedSource: z.enum(['model', 'heuristic']).optional(),
  cooldownLeftMs: z.number().int().nonnegative().optional(),
  /** Present only on a Dispatcher's Call screen (render the minigame card, not the builder). */
  minigame: DispatchersCallMinigameSchema.optional(),
});
export type A2uiScreenMessage = z.infer<typeof A2uiScreenMessageSchema>;

/**
 * Dispatcher's Call reveal (after the pick, or on timeout): Gemini's hidden pick and
 * reason. The scored outcome arrives later as the `dispatchers_call_result` sim event.
 */
export const DispatchersCallRevealMessageSchema = z.object({
  type: z.literal('dispatchersCallReveal'),
  id: z.string().min(1),
  playerIdx: z.number().int().nonnegative().nullable(),
  geminiIdx: z.number().int().nonnegative(),
  geminiLabel: z.string().min(1),
  geminiReason: z.string().min(1).max(90),
  agreed: z.boolean(),
  timedOut: z.boolean(),
  summary: z.string().nullable(),
  orderIds: z.array(z.number().int()),
  evalUntil: z.number().nullable(),
});
export type DispatchersCallRevealMessage = z.infer<typeof DispatchersCallRevealMessageSchema>;

export const RelocationOfferMessageSchema = z.object({
  type: z.literal('relocationOffer'),
  fromSite: SiteIdSchema,
  toSite: SiteIdSchema.optional(),
  targetSite: SiteIdSchema.optional(),
  targetDrivers: z.number().int().min(0).optional(),
  bonusPts: z.number().int().min(1),
  expiresAt: z.number(),
  reason: z.string(),
});
export type RelocationOfferMessage = z.infer<typeof RelocationOfferMessageSchema>;

export const RelocateShardMessageSchema = z.object({
  type: z.literal('relocateShard'),
  toSite: SiteIdSchema.optional(),
  siteId: SiteIdSchema.optional(),
  wsUrl: z.string(),
  ticket: z.string(),
  /** Ticket expiry (epoch ms), same as the signed ticket's `exp`. */
  expiresAt: z.number().int().nonnegative(),
  bonusPts: z.number().int().min(0),
});
export type RelocateShardMessage = z.infer<typeof RelocateShardMessageSchema>;

export const EvictionReasonSchema = z.enum([
  'run_complete',
  'idle_timeout',
  'session_lease_expired',
  'hard_cap_timeout',
  'zero_deliveries_timeout',
]);
export type EvictionReason = z.infer<typeof EvictionReasonSchema>;

export const RunEvictedMessageSchema = z.object({
  type: z.literal('runEvicted'),
  vid: z.union([z.string().min(1), z.number().int().nonnegative()]),
  reason: EvictionReasonSchema,
  pts: z.number().int(),
  shipped: z.number().int().nonnegative(),
  incidents: z.number().int().nonnegative(),
  bestStreak: z.number().int().nonnegative(),
  runMode: RunModeSchema,
});
export type RunEvictedMessage = z.infer<typeof RunEvictedMessageSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  WelcomeMessageSchema,
  DeltaMessageSchema,
  AckMessageSchema,
  PresenceMessageSchema,
  BrainHealthMessageSchema,
  PhaseMessageSchema,
  ErrorMessageSchema,
  CommandEchoMessageSchema,
  A2uiScreenMessageSchema,
  RelocationOfferMessageSchema,
  RelocateShardMessageSchema,
  RunEvictedMessageSchema,
  BrainDecisionMessageSchema,
  DispatchersCallRevealMessageSchema,
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
  'a2uiScreen',
  'relocationOffer',
  'relocateShard',
  'runEvicted',
  'brainDecision',
  'dispatchersCallReveal',
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
    dispatch: DispatchParamsSchema.optional(),
    echo: z.string().optional(),
  })
  .strict()
  .refine((val) => val.action !== 'cone' || (typeof val.x === 'number' && typeof val.y === 'number'), {
    message: 'cone action requires integer x and y coordinates',
  });
export type NlOrderAction = z.infer<typeof NlOrderActionSchema>;

export const NlOrderClarifySchema = z
  .object({
    action: z.literal('clarify'),
    clarifyQuestion: z.string().min(1).max(200),
    dispatch: DispatchParamsSchema.optional(),
    echo: z.string().optional(),
  })
  .strict();
export type NlOrderClarify = z.infer<typeof NlOrderClarifySchema>;

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
  NlOrderClarifySchema,
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
      enum: ['rush', 'p0', 'cone', 'fleetAdd', 'fleetRemove', 'dispatch', 'clarify', 'refuse'],
      description: 'Translated manager command, clarify (interactive A2UI screen), or refuse.',
    },
    x: {
      type: 'INTEGER',
      description: 'Tile X coordinate (0..59), required only when action is cone.',
    },
    y: {
      type: 'INTEGER',
      description: 'Tile Y coordinate (0..120), required only when action is cone.',
    },
    dispatch: {
      type: 'OBJECT',
      description: 'Zone-to-bay routing parameters when action is dispatch or clarify.',
      properties: {
        sourceZone: {
          type: 'STRING',
          enum: DISPATCH_SOURCE_ZONES,
          description: 'Source district or rack zone (haz, cold, bulk, high, general, any, A..Z).',
        },
        targetBay: {
          type: 'STRING',
          enum: DISPATCH_TARGET_BAYS,
          description: 'Destination bay (RET for Returns & QA, E1..E8, or auto).',
        },
        priority: {
          type: 'STRING',
          enum: DISPATCH_PRIORITIES,
          description: 'Order priority tier (p0, urgent, standard).',
        },
        count: {
          type: 'INTEGER',
          description: 'Number of pallets to route/spawn (1..8).',
        },
        mode: {
          type: 'STRING',
          enum: DISPATCH_MODES,
          description: 'Whether to reroute existing orders and/or spawn new ones.',
        },
      },
      required: ['sourceZone', 'targetBay'],
    },
    clarifyQuestion: {
      type: 'STRING',
      description: 'Interactive clarification prompt when action is clarify (<= 160 chars).',
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

export const AGENT_COMMAND_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    refuse: {
      type: 'STRING',
      description: 'Set only if the request is out-of-scope, unsafe, or unintelligible.',
    },
    autopilot: {
      type: 'BOOLEAN',
      description:
        'True to engage/keep autonomous driving; false if the user explicitly asks to stop/park/manual.',
    },
    strategy: {
      type: 'STRING',
      enum: ['Sprinter', 'Batcher', 'Steady', 'Opportunist', 'Strategist'],
    },
    tactics: {
      type: 'OBJECT',
      properties: {
        speed: { type: 'NUMBER' },
        respect: { type: 'NUMBER' },
        buffer: { type: 'INTEGER' },
        chargeAt: { type: 'NUMBER' },
        batch: { type: 'INTEGER' },
        flatPath: { type: 'NUMBER' },
        preemptForP0: { type: 'BOOLEAN' },
        poach: { type: 'BOOLEAN' },
        note: { type: 'STRING' },
      },
    },
    focusZones: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Up to 6 single-letter warehouse zones (e.g. ["A", "C"]).',
    },
    focusBays: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Up to 12 shipping bays (e.g. ["B1", "B4", "E1", "RET"]).',
    },
    priority: {
      type: 'STRING',
      enum: ['normal', 'p0_first', 'transfers_first', 'nearest'],
    },
    immediateTask: {
      type: 'OBJECT',
      properties: {
        kind: { type: 'STRING', enum: ['auto', 'charge', 'zone', 'bay', 'order'] },
        target: { type: 'STRING' },
      },
      required: ['kind'],
    },
    summary: {
      type: 'STRING',
      description: 'Concise confirmation of what the forklift will do (max 120 chars).',
    },
  },
  required: ['summary'],
} as const;

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
