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
export const DAY_START = 6 * 60; // 06:00
export const BACKLOG_CAP = 60;
export const KWH_PER_PCT = 0.24;
export const INCIDENT_PENALTY = 15;
export const INTERACT_REACH = 1.6;
export const REACH = INTERACT_REACH;

export const SITES = ['den-1', 'slc-2', 'phx-3', 'abq-4'] as const;
export type SiteId = (typeof SITES)[number] | string;

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

export type DifficultyKey = 'calm' | 'normal' | 'surge' | 'crisis' | 'easy' | 'hard';
export type DifficultyInput = DifficultyKey | 1 | 2 | 3 | 4;

export interface DifficultyConfig {
  key: DifficultyKey;
  level: 1 | 2 | 3 | 4;
  label: string;
  demand: number;
  due: number;
  hazardPerHr: number;
  hazardTtl: [number, number];
  crash: number;
  score: number;
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
  seq?: number;
}

export interface VehicleTarget {
  kind: 'pick' | 'drop' | 'charge' | 'park' | 'break';
  x: number;
  y: number;
  order?: Order;
  bay?: string;
}

export interface CardModifiers {
  speedMul: number;
  reachBonus: number;
  batteryDrainMul: number;
  payoutBonus: number;
}

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

export interface Vehicle {
  id: string;
  type: VehicleType;
  strategy: Archetype;
  human: boolean;
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
  chargerIdx: number;
  speedNow: number;
  braking: boolean;
  humanCharging: boolean;
  msg: string;
  driver: string | null;
  input: DriverInput;
  sPts: number;
  sShipped: number;
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
  lastTacticsReqAt: number;
  target: VehicleTarget | null;
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

export interface Card {
  id: string;
  type: 'route' | 'batch' | 'clean' | 'ontime' | 'quick' | 'charge' | 'overdrive' | 'long_reach' | 'eco_cell' | 'high_roller';
  zone?: string;
  bay?: string;
  goal: number;
  progress: number;
  status: 'offer' | 'active' | 'done' | 'lost' | 'expired';
  starter?: boolean;
  pts: number;
  title: string;
  desc: string;
  modifiers?: Partial<CardModifiers>;
}

export interface CardHand {
  shift: number;
  offer: Card[] | null;
  cards: Card[];
  ai?: boolean;
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

export interface PlayerSession {
  clientId: string;
  name: string;
  opaqueId: string;
  dedicatedVehicleId: string | null;
  controlledVehicleId: string | null;
  isBot: boolean;
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
    transfersOut: number;
    transfersIn: number;
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
  outboundTransfers: TransferOut[];
  pendingDecisions: DecisionRequest[];
  decisionJournal: DecisionJournalEntry[];
  decisions: DecisionJournalEntry[]; // Alias to decisionJournal
  players: Map<string, PlayerSession>;
}

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
  outboundTransfers: TransferOut[];
  pendingDecisions: DecisionRequest[];
  decisionJournal: DecisionJournalEntry[];
  players: Array<[string, PlayerSession]>;
  heat: number[];
}
