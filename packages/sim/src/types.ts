export const SIM_VERSION = 5;

export const MAP_W = 60;
export const BASE_H = 43;
export const TIER_ROWS = 9;
export const BASE_FLEET = 24;
export const TIER_STEP = 6;
export const MAX_TIER = 6;
export const BASE_AI = 20;
export const FLEET_CAP = BASE_FLEET + TIER_STEP * MAX_TIER; // 60 vehicles at Tier 6
export const TICK_MIN = 0.1; // game-minutes per tick at 1x (10 Hz => 1 real s = 1 game min)
export const MAX_HUMAN_STEP_DT = 0.02; // fixed Euler sub-step ceiling for client/server stepHuman parity
export const DAY_START = 6 * 60; // 06:00
export const BACKLOG_CAP = 60;
export const KWH_PER_PCT = 0.24;
export const INCIDENT_PENALTY = 15;
export const INTERACT_REACH = 1.6;
export const REACH = INTERACT_REACH;

export const SITES = ['den-1', 'slc-2', 'phx-3', 'abq-4'] as const;
export type SiteId = (typeof SITES)[number] | string;

export interface SiteTheme {
  id: SiteId;
  code?: string;
  title?: string;
  name: string;
  shortName: string;
  city: string;
  cargoStyle: 'boxes' | 'plants' | 'tech' | 'artisan';
  cargoLabel: string;
  skuPrefix: string;
  skuItems: string[];
  accentColor: string;
}

export const SITE_THEMES: Record<'den-1' | 'slc-2' | 'phx-3' | 'abq-4', SiteTheme> = {
  'den-1': {
    id: 'den-1',
    name: 'Denver Fulfillment Hub',
    shortName: 'Logistics Hub',
    city: 'Denver, CO',
    cargoStyle: 'boxes',
    cargoLabel: 'Cardboard & Cold Pallets',
    skuPrefix: 'SKU',
    skuItems: ['CARTON', 'CRATE', 'PALLET', 'PARCEL', 'TOTE', 'CASE'],
    accentColor: '#d97706',
  },
  'slc-2': {
    id: 'slc-2',
    name: 'Salt Lake Botanical Conservatory',
    shortName: 'Botanical Nursery',
    city: 'Salt Lake City, UT',
    cargoStyle: 'plants',
    cargoLabel: 'Potted Trees & Terrariums',
    skuPrefix: 'PLT',
    skuItems: ['MONSTERA', 'FICUS', 'ORCHID', 'BONSAI', 'SUCCULENT', 'FERN'],
    accentColor: '#16a34a',
  },
  'phx-3': {
    id: 'phx-3',
    name: 'Phoenix Silicon Cleanroom',
    shortName: 'Silicon Fab',
    city: 'Phoenix, AZ',
    cargoStyle: 'tech',
    cargoLabel: 'Wafer FOUPs & Server Blades',
    skuPrefix: 'FAB',
    skuItems: ['FOUP-300', 'WAFER-5N', 'GPU-RACK', 'CRYO-CELL', 'OPTIC-MOD', 'LITHO-KIT'],
    accentColor: '#0284c7',
  },
  'abq-4': {
    id: 'abq-4',
    name: 'Albuquerque Artisan Roastery',
    shortName: 'Artisan Roastery',
    city: 'Albuquerque, NM',
    cargoStyle: 'artisan',
    cargoLabel: 'Oak Barrels & Burlap Sacks',
    skuPrefix: 'ART',
    skuItems: ['CASK-OAK', 'BURLAP-60', 'COPPER-URN', 'CLAY-AMPH', 'ROAST-LOT', 'SPICE-BAL'],
    accentColor: '#c2410c',
  },
};

const REGION_BASE_THEME_KEY: Record<string, keyof typeof SITE_THEMES> = {
  den: 'den-1',
  slc: 'slc-2',
  phx: 'phx-3',
  abq: 'abq-4',
};

export function getSiteTheme(siteId?: string): SiteTheme {
  if (siteId && siteId in SITE_THEMES) {
    return SITE_THEMES[siteId as keyof typeof SITE_THEMES];
  }
  if (siteId) {
    const match = /^(den|slc|phx|abq)-(\d+)$/i.exec(siteId.trim());
    if (match) {
      const prefix = match[1].toLowerCase();
      const num = match[2];
      const baseKey = REGION_BASE_THEME_KEY[prefix] ?? 'den-1';
      const base = SITE_THEMES[baseKey];
      const normalizedId = `${prefix}-${num}`;
      return {
        ...base,
        id: normalizedId,
        code: normalizedId.toUpperCase(),
        name: `${base.city} #${num}`,
        title: `${base.city} Annex #${num}`,
      };
    }
  }
  return SITE_THEMES['den-1'];
}

export type Phase = 'running' | 'winding_down' | 'break' | 'resuming';

export type Archetype = 'Sprinter' | 'Steady' | 'Batcher' | 'Opportunist' | 'Strategist';
export type StrategyName = Archetype | 'Human';

export type VehicleType =
  | 'reach'
  | 'counterbalance'
  | 'turret'
  | 'pallet_jack'
  | 'forklift'
  | 'agv';

export type DistrictKind =
  | 'ambient'
  | 'cold'
  | 'fast'
  | 'bulk'
  | 'haz'
  | 'returns'
  | 'staging'
  | 'office'
  | 'charging';

export type DifficultyKey =
  | 'calm'
  | 'normal'
  | 'medium'
  | 'surge'
  | 'crisis'
  | 'easy'
  | 'hard'
  | 'turbo';
export type DifficultyInput = DifficultyKey | 1 | 2 | 3 | 4 | 5;

export interface DifficultyConfig {
  key: DifficultyKey;
  level: 1 | 2 | 3 | 4 | 5;
  label: string;
  demand: number;
  due: number;
  hazardPerHr: number;
  hazardTtl: [number, number];
  crash: number;
  score: number;
  speed?: number;
}

export interface Tactics {
  speed: number;
  respect: number;
  buffer: number;
  chargeAt: number;
  batch: number;
  flatPath: boolean;
  preemptForP0: boolean;
  poach: boolean;
  note?: string;
}

export interface StrategyConfig extends Tactics {
  color: string;
  blurb: string;
  tunable?: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rack {
  id: string;
  zone: string;
  kind: DistrictKind;
  x: number;
  y: number;
  tone: number;
}

export interface Slot {
  key: string;
  rackId: string;
  zone: string;
  rx: number;
  ry: number;
  ax: number;
  ay: number;
  level?: 0 | 1 | 2;
}

export type RackLiftGrade = 'perfect' | 'clean' | 'scrape';

export interface RackLiftEvaluation {
  grade: RackLiftGrade;
  targetLevel: 0 | 1 | 2;
  targetFork: number;
  forkHeight: number;
  error: number;
  perfectWindow: number;
  cleanWindow: number;
  bonusDelta: number;
}

export interface ZoneInfo {
  id: string;
  kind: DistrictKind;
  x: number;
  y: number;
}

export interface AreaInfo {
  kind: DistrictKind;
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
}

export interface StructInfo {
  type: 'bench' | 'office' | 'break';
  x: number;
  y: number;
  w: number;
  h: number;
  name?: string;
}

export interface BayConfig {
  id: string;
  y: number;
  dropX: number;
  tiles: Point[];
  isTransferBay: boolean;
  label: string;
}

export interface DockConfig {
  id: string;
  y: number;
  x: number;
}

export interface WorldMap {
  siteId?: SiteId;
  tier: number;
  w: number;
  h: number;
  hwyY: number[];
  hwyX: number[];
  racks: Rack[];
  slots: Slot[];
  zones: ZoneInfo[];
  areas: AreaInfo[];
  structs: StructInfo[];
  zoneFar: Record<string, number>;
  zoneKind: Record<string, DistrictKind>;
  conveyors: Point[];
  bays: BayConfig[];
  westDocks: DockConfig[];
  chargers: Point[];
  floorK: Uint8Array;
  staticBlock: Uint8Array;
}

export interface BayState {
  id: string;
  load: number;
  cap: number;
  departUntil: number;
  isTransferBay: boolean;
  label: string;
}

export interface Order {
  id: number;
  sku: string;
  slot: Slot;
  bay: string;
  p0: boolean;
  value: number;
  created: number;
  due: number;
  state: 'open' | 'claimed' | 'picked' | 'done';
  claimant: string | null;
  card: string | null;
  pickedAt?: number;
  isTransfer?: boolean;
  destSite?: string | null;
  fromSite?: string | null;
  transferId?: string | null;
  zone?: string;
  special?: string;
  /** Par time (game-min) for the loaded leg, set at pickup from the planner's route. */
  parLoaded?: number;
  /**
   * Difficulty speed (`DifficultyConfig.speed`) in force when `parLoaded` was stamped.
   * Rating rescales par by `stamp / current` so a mid-leg difficulty change is fair.
   */
  parDiffSpeed?: number;
  /** Hand key (player / agent id) that owns this route-card pallet during the reservation window. */
  reservedFor?: string | null;
  /** Game time when the contract reservation opens to other drivers. */
  reservedUntil?: number;
  /** Par time (game-min) for the empty leg, set when a driver chooses this order. */
  parEmpty?: number;
  /** Game time the order was chosen (`chooseOrder` or Co-Pilot auto-pick). */
  chosenAt?: number;
  /** Fare colour class, fixed when chosen (or at delivery from the loaded-leg par). */
  farClass?: FareClass;
  /**
   * Inbound putaway: the rack slot this west-dock pallet must be stowed into.
   * `slot` is the dock pickup tile; `bay` mirrors `xdockBay` (the cross-dock bay).
   */
  putaway?: Slot | null;
  /** Outbound bay that accepts this inbound pallet as a cross-dock (human drivers only). */
  xdockBay?: string | null;
  /** Game time the cross-dock window closes; after this the pallet must be stowed. */
  xdockDue?: number | null;
  /** Dispatcher's Call challenge id whose executed dispatch moved / created this order. */
  dispatchCallId?: string | null;
}

/** Fare colour class: 🟢 short hop, 🟡 cross-floor, 🔴 long haul / P0, 🟣 contract. */
export type FareClass = 'short' | 'cross' | 'long' | 'contract';

/** One candidate order offered to a manual driver by `fareOptions`. */
export interface FareOption {
  orderId: number;
  farClass: FareClass;
  /** Same-bay add-on while carrying one pallet on a 2-slot vehicle. */
  carpool: boolean;
  p0: boolean;
  bay: string;
  value: number;
  /** Manhattan tiles from the vehicle to the pickup (the guide() distance term). */
  tiles: number;
  /** Empty-leg par (vehicle → pickup), game-min; null when no route. */
  parEmpty: number | null;
  /** Loaded-leg par (pickup → bay), game-min; null when no route. */
  parLoaded: number | null;
  /** Inbound west-dock pallet to stow (putaway). */
  putaway?: boolean;
  /** Rack id the inbound pallet stows into. */
  putawayRack?: string | null;
  /** Cross-dock bay for an inbound pallet (null when not inbound). */
  xdockBay?: string | null;
  /** Game-min left in the cross-dock window, or null when closed / not inbound. */
  xdockLeft?: number | null;
}

/** The order choice currently open for a manual driver. */
export interface FareOffer {
  /** Game time the offer opened (timeout counts from here). */
  since: number;
  options: FareOption[];
  /** The Co-Pilot's recommended order (auto-reserved on timeout). */
  copilotId: number;
  /** Why the Co-Pilot recommends it, built from the guide() scoring terms. */
  reason: string;
  carpool: boolean;
}

/** Speed rating for one fare (delivered pallet). */
export type FareRating = 'speedy' | 'normal' | 'slow';

/** One rated trip, kept in `Vehicle.fareLog` and emitted as a `fare` SimEvent. */
export interface FareResult {
  t: number;
  orderId: number;
  rating: FareRating;
  /** Loaded-leg time in game-min (pickup → delivery). */
  actual: number;
  /** Par time in game-min, or null when the pallet had no par (e.g. injected cargo). */
  par: number | null;
  /** Combo multiplier applied to this trip. */
  combo: number;
  /** Trip points awarded (value × rating × combo, plus flat bonuses). */
  pts: number;
}

export interface Hazard {
  id: number;
  x: number;
  y: number;
  born: number;
  until: number;
}

export interface Marker {
  x: number;
  y: number;
  until: number;
  kind: 'incident' | 'near';
}

export interface DriverInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  boost?: boolean;
  moveAngle?: number | null;
  seq?: number;
}

export interface VehicleTarget {
  kind: 'pick' | 'drop' | 'stow' | 'charge' | 'park' | 'break';
  x: number;
  y: number;
  order?: Order;
  bay?: string;
}

export type RunMode = 'blitz' | 'freerange';
export const BLITZ_DURATION_MIN = 180; // 180 sim-min = 180 real seconds (3 real min) at 10 Hz (0.1 sim-min/tick)
export const RUN_CARD_GRACE_MIN = 15; // informational card-pick window (runGraceUntil); the Blitz clock itself starts only on first input, keepCards, or Co-Pilot

export interface CardModifiers {
  speedMul: number;
  reachBonus: number;
  batteryDrainMul: number;
  payoutBonus: number;
  ptsBonus?: number;
  p0Bonus?: number;
  chargeBonus?: number;
  drainMul?: number;
  /** Fork lift/lower speed multiplier (Crazy Stop perk), capped at 1.5×. */
  forkLiftMul?: number;
  /** Combo step that a reset falls back to (Combo King perk: 1 = 1.2×). */
  comboFloor?: number;
}

/** Perk granted by a card once it is completed (`status === 'done'`). */
export type CardPerk = Partial<CardModifiers>;

export interface LastDecisionRecord {
  id: string;
  kind: 'contract' | 'hazard' | 'tactics' | 'cards';
  reason: string;
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  t: number;
}

export type AgentPriority =
  | 'balanced'
  | 'normal'
  | 'p0_first'
  | 'high_value'
  | 'nearest'
  | 'transfers'
  | 'transfers_first'
  | 'zone_focus'
  | 'bay_focus';
export type ImmediateTaskKind =
  | 'auto'
  | 'charge'
  | 'charge_now'
  | 'return_home'
  | 'deliver_cargo'
  | 'pick_p0'
  | 'pick_hazmat'
  | 'clear_spill'
  | 'zone'
  | 'bay'
  | 'order';

export interface PartialVehicleTactics {
  speed?: number;
  respect?: number;
  buffer?: number;
  chargeAt?: number;
  batch?: number;
  flatPath?: number | boolean;
  preemptForP0?: boolean;
  poach?: boolean;
  note?: string;
}

export interface AgentDirective {
  autopilot?: boolean;
  strategy?: Archetype;
  persona?: Archetype;
  tactics?: PartialVehicleTactics;
  focusZones?: string[];
  focusBays?: string[];
  preferredZone?: string;
  preferredBay?: string;
  preferredZones?: string[];
  preferredBays?: string[];
  avoidZones?: string[];
  priority?: AgentPriority;
  immediateTask?:
    | ImmediateTaskKind
    | {
        kind: ImmediateTaskKind;
        target?: string;
        orderId?: number | null;
        zone?: string | null;
        bay?: string | null;
      }
    | null;
  summary?: string;
  updatedAt?: number;
}

export interface Vehicle {
  id: string;
  type: VehicleType;
  strategy: Archetype;
  human: boolean;
  autopilot?: boolean;
  directive?: AgentDirective | null;
  extra: boolean;
  isPlayerVehicle?: boolean;
  ownerClientId?: string | null;
  controlledByClientId?: string | null;
  playerOpaqueId?: string | null;
  isBot?: boolean;
  px: number;
  py: number;
  angle: number;
  tile: Point;
  moveTo: Point | null;
  path: Point[];
  state: 'idle' | 'toPick' | 'picking' | 'toDrop' | 'dropping' | 'toCharge' | 'charging' | 'driven' | 'parked';
  orders: Order[];
  cargo: Order[];
  battery: number;
  fork: number;
  forkTarget: number;
  timer: number;
  wait: number;
  stuck?: number;
  waitKey: string | null;
  waitRespect: boolean;
  stunnedUntil: number;
  idleSince: number;
  energySince: number;
  deliveries: number;
  incidents: number;
  nearMisses: number;
  skids?: number;
  palletDrops?: number;
  chargerIdx: number;
  speedNow: number;
  braking: boolean;
  humanCharging: boolean;
  msg: string;
  driver: string | null;
  input: DriverInput;
  inputQueue?: Array<{ input: DriverInput; dt: number }>;
  inputCarriedDt?: number;
  sPts: number;
  sShipped: number;
  runMode: RunMode;
  runStartedAt: number | null;
  runEndsAt: number | null;
  runGraceUntil: number | null;
  runPts: number;
  runDeliveries: number;
  runOnTime: number;
  runIncidents: number;
  streak: number;
  bestStreak: number;
  runFinished: boolean;
  hzSeen: Set<number>;
  hold: number | null;
  pushing: number | null;
  skidRolled: boolean;
  bank: number;
  aiValue: number;
  lastTot: number;
  tactics: Tactics;
  brainError: string | null;
  lastDecision: LastDecisionRecord | null;
  lastBrainDecision?: {
    kind: string;
    reason: string;
    model: string;
    latencyMs: number;
    at: number;
  } | null;
  lastTacticsReqAt: number;
  target: VehicleTarget | null;
  /** Combo step index into COMBO_STEPS (0 = 1.0×, 3 = 2.0× cap). Optional for old snapshots. */
  comboStep?: number;
  /** Current combo multiplier (mirrors COMBO_STEPS[comboStep]). */
  combo?: number;
  /** Best combo multiplier reached this run. */
  comboBest?: number;
  /** Rated trips this run. */
  fareTrips?: number;
  /** Speedy-rated trips this run. */
  speedyTrips?: number;
  /** Last ≤ 10 rated trips (newest last). */
  fareLog?: FareResult[];
  /** Speed when the driver started braking (precision-stop detection). */
  brakeFrom?: number | null;
  /** Set when the driver braked from > 4.0 to < 0.8; consumed by the next interact. */
  precisionArmed?:
    | { x: number; y: number; t: number; until?: number; tiles?: Point[] }
    | { until: number; tiles: Point[]; x?: number; y?: number; t?: number }
    | null;
  /** Hydraulic Exit Surge boost expiration game time from a Perfect Lift. */
  liftBoostUntil?: number;
  /** Rack Scrape speed wobble expiration game time from a missed lift window. */
  liftScrapeUntil?: number;
  /** Open order choice for a manual driver (see `fareOptions` / `chooseOrder`). */
  fareOffer?: FareOffer | null;
  /** Cargo order id whose Carpool offer timed out (not re-offered for that load). */
  carpoolDeclined?: number | null;
  /** AI agent assigned as this driver's rival (closest score at run start). */
  rivalId?: string | null;
  /**
   * Orders this human was heading to on the previous tick (claimed order + open fare
   * options, which include the guide target), with the claimant seen then. Used to emit
   * `rival_snipe` when an AI vehicle claims or picks one of them.
   */
  snipeWatch?: Array<{ orderId: number; claimant: string | null; anyAi?: boolean }>;
  /** Game time of the last `rival_snipe` bubble for this human (throttle). */
  lastSnipeAt?: number | null;
  /**
   * Dispatcher's Call minigame state for the current Blitz run (at most one per run;
   * cleared by `startDriverRun`). Persisted with the vehicle in snapshots.
   */
  dispatchersCall?: DispatchersCallState | null;
  /**
   * Portion of the current `sPts` already moved into `bank` at a shift rollover (Blitz
   * humans keep `sPts` across the rollover). Only the delta since the last bank is banked.
   */
  bankedPts?: number;
  /**
   * True while this dedicated player vehicle is parked because its owner took the wheel of
   * an AI truck. A paused vehicle does not move, drain, burn its Blitz clock or get perks.
   */
  wheelPaused?: boolean;
  /** Blitz time (game-min) left on the paused vehicle's clock; restored on release. */
  runPausedLeft?: number | null;
  /** AI run/score stats saved by `takeWheel` and restored by `release`. */
  aiStash?: AiRunStash | null;
}

/** AI vehicle stats snapshotted when a human takes the wheel (restored on release). */
export interface AiRunStash {
  sPts: number;
  sShipped: number;
  bankedPts: number;
  runMode: RunMode;
  runStartedAt: number | null;
  runEndsAt: number | null;
  runGraceUntil: number | null;
  runPts: number;
  runDeliveries: number;
  runOnTime: number;
  runIncidents: number;
  streak: number;
  bestStreak: number;
  comboStep: number;
  combo: number;
  comboBest: number;
  fareTrips: number;
  speedyTrips: number;
  fareLog: FareResult[];
  rivalId: string | null;
}

/** Real floor situation that can trigger a Dispatcher's Call (never fabricated). */
export type DispatchersCallSituationKind =
  | 'spill'
  | 'p0_surge'
  | 'trailer_near_cap'
  | 'hazmat_backlog'
  | 'dock_backlog';

/** Numeric snapshot of the live situation that qualified a Dispatcher's Call. */
export interface DispatchersCallSituation {
  kind: DispatchersCallSituationKind;
  /** Open spills on the floor. */
  spills: number;
  /** Not-yet-delivered P0 orders. */
  openP0: number;
  /** Not-yet-delivered orders in hazmat zone Z or bound for RET. */
  hazmatOpen: number;
  /** Open inbound putaway pallets waiting at the west docks. */
  dockOpen: number;
  /** Fullest loading (non-transfer, not departing) outbound bay, if any. */
  bayId: string | null;
  bayLoad: number;
  bayCap: number;
  /** Game time the situation was detected. */
  t: number;
}

export type DispatchersCallStatus = 'offered' | 'evaluating' | 'done' | 'skipped';

export interface DispatchersCallState {
  id: string;
  status: DispatchersCallStatus;
  situation: DispatchersCallSituation | null;
  /** Game time the challenge was offered (or skipped). */
  offeredAt: number;
  /** Number of options shown to the player. */
  optionCount: number;
  /** Gemini's hidden pick (option index), revealed after the player's pick. */
  geminiIdx: number | null;
  /** Player's pick, or null on timeout / skip. */
  optionIdx: number | null;
  pickedAt: number | null;
  /** Order ids moved or created by the executed dispatch (tagged `dispatchCallId`). */
  orderIds: number[];
  /** Game time the outcome is scored (or run end if sooner). */
  evalUntil: number | null;
  /** Tracked orders delivered by anyone / delivered on time. */
  delivered: number;
  onTime: number;
  /** Points paid into runPts / sPts when scored. */
  pts: number;
  /** Why the challenge was skipped (no qualifying situation, model error, …). */
  skipReason?: string;
}

export interface ContractOption {
  id: string;
  orderId: number;
  distance: number;
  slack: number;
  value: number;
  district: DistrictKind;
  claimant: string | null; // Opaque ID only (never player display name)
  congestion: number;
  isTransfer: boolean;
  destSite: string | null;
  p0: boolean;
  bay: string;
}

export interface HazardOption {
  id: 'reroute' | 'wait' | 'push';
  choice: 'reroute' | 'wait' | 'push';
  detourLen: number | null;
  timeLeft: number;
  skidRisk: number;
}

export interface TacticsOption {
  id: string;
  param: 'speed' | 'buffer' | 'respect' | 'chargeAt' | 'batch';
  min: number;
  max: number;
  current: number;
}

export interface CardOption {
  id: string;
  cardType: string;
  pts: number;
  goal: number;
  title: string;
  desc: string;
  modifiers?: Partial<CardModifiers>;
  rarity?: CardRarity;
  perk?: CardPerk;
}

export type DecisionOption = ContractOption | HazardOption | TacticsOption | CardOption;

export interface AgentContext {
  agentId: string;
  persona: Archetype;
  vehicleType: VehicleType;
  tile: Point;
  battery: number;
  cargoCount: number;
  capacity: number;
  shiftPts: number;
  shiftShipped: number;
  incidents: number;
  nearMisses: number;
  slack: number | null;
  difficulty: DifficultyKey;
  tactics: Tactics;
  hazardId?: number;
  hazardTile?: Point;
  standings?: { rank: number; totalVehicles: number; leaderPts: number; medianShipped: number };
}

export interface DecisionRequest {
  id: string;
  agentId: string;
  kind: 'contract' | 'hazard' | 'tactics' | 'cards';
  tIssued: number;
  deadline: number;
  persona: Archetype;
  context: AgentContext;
  options: DecisionOption[];
}

export interface DecisionMeta {
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ContractDecision {
  kind?: 'contract';
  orderIds: (number | string)[];
  reason?: string;
}

export interface HazardDecision {
  kind?: 'hazard';
  choice: 'reroute' | 'wait' | 'push';
  reason?: string;
}

export interface TacticsDecision {
  kind?: 'tactics';
  speed: number;
  buffer: number;
  respect: number;
  chargeAt: number;
  batch: number;
  note?: string;
  reason?: string;
}

export interface CardsDecision {
  kind?: 'cards';
  keep: string[];
  reason?: string;
}

export type Decision =
  | ContractDecision
  | HazardDecision
  | TacticsDecision
  | CardsDecision;

export interface DecisionJournalEntry {
  reqId: string;
  agentId: string;
  persona: Archetype;
  kind: 'contract' | 'hazard' | 'tactics' | 'cards';
  tIssued: number;
  tApplied: number;
  decision: Decision;
  reason: string;
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface Transfer {
  id: string;
  fromSite: string;
  toSite: string;
  orderRef: number | string;
  sku?: string;
  value: number;
  shippedAt: number;
  carrier?: string;
}

export type TransferOut = Transfer;

/** Every card type (all dealable; `humanOnly` cards are never dealt to AI agents). */
export const CARD_TYPE_IDS = [
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
export type CardType = (typeof CARD_TYPE_IDS)[number];
export type CardRarity = 'common' | 'wild';

export interface Card {
  id: string;
  type: CardType;
  zone?: string;
  bay?: string;
  goal: number;
  progress: number;
  status: 'offer' | 'active' | 'done' | 'lost' | 'expired';
  completedAt?: number;
  starter?: boolean;
  pts: number;
  title: string;
  desc: string;
  /** Legacy mirror of `perk` (kept for older clients/snapshots). */
  modifiers?: Partial<CardModifiers>;
  rarity?: CardRarity;
  /** Never dealt to AI agents (cards built around beating the planner). */
  humanOnly?: boolean;
  /** Perk granted once the card is completed. */
  perk?: CardPerk;
  /** Timed goals (Rival Grudge): game time the window closes. */
  until?: number;
  /** Rival Grudge baseline: delivery counts when the card was kept. */
  rivalBase?: { rivalId: string; self: number; rival: number };
}

export interface CardHand {
  shift: number;
  offer: Card[] | null;
  cards: Card[];
  ai?: boolean;
  /** Max cards that may be kept from the current offer (1 for replacement draws). */
  pick?: number;
}

export interface ValueSample {
  t: number;
  you: number;
  avg: number;
  best: number;
}

export interface HallEntry {
  shift: string;
  id: string;
  strat: StrategyName;
  human: boolean;
  driver: string | null;
  pts: number;
  scored: number;
  diff: DifficultyKey;
}

export interface SimEvent {
  t: number;
  type: string;
  text: string;
  [key: string]: unknown;
}

export interface StratMetrics {
  shipped: number;
  onTime: number;
  incidents: number;
  nearMisses: number;
  kwh: number;
}

export interface PeriodStats {
  shipped: number;
  onTime: number;
  incidents: number;
  nearMisses: number;
  lost: number;
  damaged: number;
  poaches: number;
  byStrat: Record<StrategyName, StratMetrics>;
}

export interface DeliveryRecord {
  t: number;
  strat: StrategyName;
  vid: string;
  onTime: boolean;
  kwh: number;
  p0: boolean;
}

export interface IncidentRecord {
  t: number;
  strat: StrategyName;
}

export interface DayHistoryEntry {
  day: number;
  shipped: number;
  onTimePct: number | null;
  incidents: number;
  nearMisses: number;
  lost: number;
  damaged: number;
  poaches: number;
  per: Record<StrategyName, {
    shipped: number;
    onTimePct: number | null;
    incidents: number;
    kwhPerOrder: number | null;
  }>;
  winner: StrategyName;
  tuned: Tactics;
}

/** Alias used by the wire protocol (`stats.history`). */
export type DayRecord = DayHistoryEntry;

/** One Strategy Board row as returned by `board(world)` (trailing 60 game-minutes). */
export interface BoardRow {
  strat: StrategyName;
  vehicles: number;
  count: number;
  perHr: number;
  onTimePct: number | null;
  incidents: number;
  kwhPerOrder: number | null;
}

export interface PlayerSession {
  clientId: string;
  name: string;
  opaqueId: string;
  dedicatedVehicleId: string | null;
  controlledVehicleId: string | null;
  isBot: boolean;
}

export interface CompletedRunRecord {
  id: string; // e.g., `${vehicleId}:run-${runNumber}`
  vehicleId: string;
  clientId: string | null;
  driver: string; // e.g., 'Jason Run 1'
  baseName: string; // e.g., 'Jason'
  runNumber: number; // e.g., 1
  type: VehicleType;
  runMode: RunMode;
  pts: number;
  shipped: number;
  onTime: number;
  incidents: number;
  streak: number;
  bestStreak: number;
  comboBest: number;
  speedyTrips: number;
  fareTrips: number;
  ppm: number;
  startedAt: number;
  endedAt: number;
}

export interface World {
  version: 5;
  siteId: string;
  seed: number;
  rngState: number;
  t: number;
  shiftTime: number;
  tier: number;
  phase: Phase;
  resumeCountdown: number;
  map: WorldMap;
  vehicleSeq: number;
  nextOrderId: number;
  nextHazardId: number;
  nextDecisionSeq: number;
  nextTransferSeq: number;
  nextPlayerSeq: number;
  cardSeq: number;
  cones: Set<string>;
  orders: Order[];
  vehicles: Vehicle[];
  bays: BayState[];
  spills: Hazard[];
  hazards: Hazard[]; // Alias to same array as spills
  markers: Marker[];
  rushUntil: number;
  deliveries: DeliveryRecord[];
  incidentLog: IncidentRecord[];
  events: SimEvent[];
  log: SimEvent[]; // Alias to same array as events
  history: DayHistoryEntry[];
  difficulty: DifficultyKey;
  difficultyVotes: Record<string, DifficultyKey>;
  cards: Record<string, CardHand>;
  hands: Record<string, CardHand>; // Alias to same object as cards
  valueSeries: ValueSample[];
  series: ValueSample[]; // Alias to same array as valueSeries
  hallOfFame: HallEntry[];
  hall: HallEntry[]; // Alias to same array as hallOfFame
  humanValue: number;
  agentValue: number;
  aiShift: number;
  totals: {
    shipped: number;
    onTime: number;
    incidents: number;
    lost: number;
    days: number;
    wins: number;
    humanShifts: number;
    cardDeals: number;
    cardsDone: number;
    aiCardsDone: number;
    hazards: number;
    skids?: number;
    palletDrops?: number;
    nearMisses?: number;
    transfersOut: number;
    transfersIn: number;
    /** Inbound pallets stowed into racks. */
    putaways?: number;
    /** Inbound pallets cross-docked straight to an outbound bay. */
    crossDocks?: number;
    decisions: { reroute: number; wait: number; push: number };
  };
  day: PeriodStats;
  shift: PeriodStats;
  tuned: Tactics;
  heat: Float32Array;
  listeners: Array<(ev: SimEvent) => void>;
  marketTimer: number;
  resumed: boolean;
  receivedTransferIds: Set<string>;
  /** Game time the next inbound trailer arrives at a west dock. */
  nextInboundAt: number;
  outboundTransfers: TransferOut[];
  pendingDecisions: DecisionRequest[];
  decisionJournal: DecisionJournalEntry[];
  decisions: DecisionJournalEntry[]; // Alias to decisionJournal
  players: Map<string, PlayerSession>;
  completedRuns?: CompletedRunRecord[];
  /** Opt-in feature flag for the Rack Height Fork-Lift Minigame (default false). */
  rackLiftMinigame?: boolean;
  /** Emergency kill-switch to ignore client-supplied forkHeight even when sent. */
  rackLiftMinigameKillSwitch?: boolean;
  /** Optional convenience RNG method bound to this world. */
  rng?: () => number;
}

export type WorldState = World;

export interface WorldSnapshotV5 {
  version: 5;
  v: 5;
  siteId: string;
  seed: number;
  rngState: number;
  t: number;
  shiftTime: number;
  tier: number;
  phase: Phase;
  resumeCountdown: number;
  vehicleSeq: number;
  nextOrderId: number;
  nextHazardId: number;
  nextDecisionSeq: number;
  nextTransferSeq: number;
  nextPlayerSeq: number;
  cardSeq: number;
  difficulty: DifficultyKey;
  difficultyVotes: Record<string, DifficultyKey>;
  rushUntil: number;
  humanValue: number;
  agentValue: number;
  aiShift: number;
  totals: World['totals'];
  day: PeriodStats;
  shift: PeriodStats;
  tuned: Tactics;
  cones: string[];
  bays: BayState[];
  orders: Order[];
  spills: Hazard[];
  vehicles: Array<Omit<Vehicle, 'hzSeen'> & { hzSeen: number[] }>;
  cards: Record<string, CardHand>;
  valueSeries: ValueSample[];
  hallOfFame: HallEntry[];
  history: DayHistoryEntry[];
  events: SimEvent[];
  deliveries: DeliveryRecord[];
  incidentLog: IncidentRecord[];
  receivedTransferIds: string[];
  nextInboundAt?: number;
  outboundTransfers: TransferOut[];
  pendingDecisions: DecisionRequest[];
  decisionJournal: DecisionJournalEntry[];
  players: Array<[string, PlayerSession]>;
  heat: number[];
  completedRuns?: CompletedRunRecord[];
}

export type DispatchSourceZone =
  | 'haz'
  | 'cold'
  | 'bulk'
  | 'high'
  | 'general'
  | 'any'
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'U'
  | 'W'
  | 'X'
  | 'Z';

export type DispatchTargetBay =
  | 'RET'
  | 'E1'
  | 'E2'
  | 'E3'
  | 'E4'
  | 'E5'
  | 'E6'
  | 'E7'
  | 'E8'
  | 'auto';

export type DispatchPriority = 'p0' | 'urgent' | 'standard';
export type DispatchMode = 'reroute_and_spawn' | 'reroute_only' | 'spawn_only';

export interface DispatchParams {
  sourceZone: DispatchSourceZone;
  targetBay: DispatchTargetBay;
  priority?: DispatchPriority;
  count?: number;
  mode?: DispatchMode;
}

export interface DispatchResult {
  sourceZone: DispatchSourceZone;
  targetBay: string;
  priority: DispatchPriority;
  rerouted: number;
  spawned: number;
  orderIds: number[];
  summary: string;
}

