/**
 * Client store: the single source of truth that every HUD module reads.
 *
 * All data here comes from real server messages (welcome snapshot, deltas,
 * presence, brainHealth, phase, /api/network). Nothing is invented: values that
 * have not arrived yet stay `null` and the UI renders "—".
 */
import {
  dequantiseCoord,
  type A2uiScreenMessage,
  type AgentDirective,
  type BoardRow,
  type BrainHealthMessage,
  type CommandEchoMessage,
  type DeltaMessage,
  type DispatchSourceZone,
  type DispatchTargetBay,
  type EvictionReason,
  type FloorOrdersStatus,
  type HeatLayer,
  type LeaderboardEntry,
  type Phase,
  type PlayerSessionInfo,
  type PresenceEntry,
  type QuantisedVehicleDelta,
  type QueueStatus,
  type RelocationOfferMessage,
  type RunEvictedMessage,
  type RunMode,
  type SiteId,
  type SiteLimits,
  type SiteStatus,
  type ValueSample,
  type VehicleDecision,
  type WelcomeMessage,
} from '@warehouse/protocol';
import {
  dcVisible,
  readDispatchersCallOverride,
  saveDispatchersCallPref,
  type DispatchersCallCard,
} from './ui/dispatchersCall.js';
import {
  blitzLeaderboard,
  board as simBoard,
  buildMap,
  createWorld,
  dayIndex,
  defaultTacticsFor,
  DIFFICULTY,
  flatPathFlag,
  parseDriverRunInfo,
  restore,
  shiftIndex,
  type Archetype,
  type CardHand,
  type CompletedRunRecord,
  type DayHistoryEntry,
  type FareOffer,
  type FareOption,
  type HallEntry,
  type Point,
  type SimEvent,
  type Vehicle,
  type VehicleType,
  type World,
  type WorldSnapshotV5,
} from '@warehouse/sim';
import type { RenderLayers, RenderVehicleOverlay } from './renderer.js';
import { fareOfferKey } from './ui/fareChoice.js';
import { activeOverlay, hudMode, type ActiveOverlay, type HudMode } from './ui/mode.js';
import { topLayer, type TopLayer } from './ui/modal.js';
import type { AlertState, FeedNote } from './ui/notify.js';
import type { AiRecap, RivalDecision, RunAiLog, ShieldCard } from './ui/aiInsight.js';

export const EVENT_CAP = 120;
export const BRAIN_LOG_CAP = 120;

const RUN_SUFFIX_RE = /^(.*?)\s+Run\s+(\d+)$/i;

/**
 * Parse a display name into its base screen name and run number (e.g. `"Alex Run 2"` -> `{ baseName: "Alex", runNumber: 2 }`).
 * If no `Run N` suffix is present, `runNumber` defaults to 1.
 */
export function parseRunDisplayName(raw: string): { baseName: string; runNumber: number } {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  const m = RUN_SUFFIX_RE.exec(trimmed);
  if (m) {
    const base = m[1].trim();
    const num = Math.max(1, Number.parseInt(m[2], 10) || 1);
    return { baseName: base || 'Driver', runNumber: num };
  }
  return { baseName: trimmed || 'Driver', runNumber: 1 };
}

/**
 * Format a base screen name and run number so the combined name fits within the 18-char display name limit
 * (e.g. `"Alex"`, `1` -> `"Alex Run 1"`).
 */
export function formatRunDisplayName(rawBase: string, runNumber: number): string {
  const { baseName } = parseRunDisplayName(rawBase);
  const runNum = Math.max(1, Math.floor(runNumber));
  const suffix = ` Run ${runNum}`;
  const maxBaseLen = Math.max(2, 18 - suffix.length);
  const clippedBase = baseName.slice(0, maxBaseLen).trim() || 'Dr';
  return `${clippedBase}${suffix}`;
}

/** Advance a screen name to its next run number (e.g. `"Alex Run 1"` -> `"Alex Run 2"`). */
export function nextRunDisplayName(currentName: string): string {
  const { baseName, runNumber } = parseRunDisplayName(currentName);
  return formatRunDisplayName(baseName, runNumber + 1);
}

/** Check whether an eviction reason represents a contention or session lease expiration. */
export function isLeaseEvictionReason(reason: string | null | undefined): boolean {
  return (
    reason === 'session_lease_expired' ||
    reason === 'hard_cap_timeout' ||
    reason === 'zero_deliveries_timeout'
  );
}

export interface GuideInfo {
  kind: string;
  x?: number;
  y?: number;
  text?: string;
  inRange?: boolean;
  stow?: boolean;
  order?: {
    id: number;
    bay?: string;
    slot?: { rackId: string; level?: 0 | 1 | 2; key?: string; rx?: number; ry?: number; ax?: number; ay?: number };
    putaway?: { rackId: string; level?: 0 | 1 | 2; key?: string; rx?: number; ry?: number; ax?: number; ay?: number } | null;
  };
}

/** Per-vehicle data that the sim Vehicle type has no slot for. */
export interface VehicleSideState {
  /** Latest brain reason text (lastReason) — shown without model/latency unless a real decision matches. */
  reasons: Map<string, string>;
  /** Server-computed guidance for human-driven vehicles. */
  guides: Map<string, GuideInfo>;
  /** Real brain-call metadata (delta.decision or `decision` events). */
  decisions: Map<string, VehicleDecision>;
  /** Last real `cards` (contract draft) decision per vehicle; survives later contract/tactics calls. */
  cardDecisions: Map<string, VehicleDecision>;
}

export function createSideState(): VehicleSideState {
  return { reasons: new Map(), guides: new Map(), decisions: new Map(), cardDecisions: new Map() };
}

export interface ApplyDeltaOptions {
  /** Accept the server pose for our own vehicle (no input in flight, so nothing to predict). */
  acceptMyPose?: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** `[x0,y0,x1,y1,...]` → `[{x,y},...]` (drops a trailing odd value). */
export function unflattenPath(flat: readonly number[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i], y: flat[i + 1] });
  return out;
}

/**
 * Merge incoming server events (emit order = oldest-first) into a newest-first
 * list capped at `cap`.
 */
export function mergeEvents<T>(existingNewestFirst: readonly T[], incomingOldestFirst: readonly T[], cap = EVENT_CAP): T[] {
  const merged = [...incomingOldestFirst].reverse().concat(existingNewestFirst);
  if (merged.length > cap) merged.length = cap;
  return merged;
}

/** Client-side cap on the value series (the sim keeps 300 too). */
export const SERIES_CAP = 300;

/** Append value samples strictly newer than the last one we hold, then trim to `cap` (in place). */
export function appendSeries(
  series: ValueSample[],
  samples: readonly ValueSample[],
  cap = SERIES_CAP,
): ValueSample[] {
  let lastT = series.length ? series[series.length - 1].t : -Infinity;
  for (const s of samples) {
    if (s.t > lastT) {
      series.push(s);
      lastT = s.t;
    }
  }
  if (series.length > cap) series.splice(0, series.length - cap);
  return series;
}

/**
 * `delta.hands` carries ONLY the recipient's own hand (`{}` when it has none). Merge it into
 * the client's card map so the agent hands from the welcome snapshot survive (in place).
 */
export function mergeOwnHand(
  cards: Record<string, CardHand>,
  incoming: Record<string, CardHand>,
  myClientId: string | null | undefined,
): Record<string, CardHand> {
  for (const [k, hand] of Object.entries(incoming)) cards[k] = hand;
  if (myClientId && !(myClientId in incoming)) delete cards[myClientId];
  return cards;
}

/** Rebuild a dense `w*h` heat array from the sparse server layer. */
export function denseHeat(layer: HeatLayer): Float32Array {
  const dense = new Float32Array(layer.w * layer.h);
  for (const [idx, value] of layer.cells) {
    if (idx >= 0 && idx < dense.length) dense[idx] = value;
  }
  return dense;
}

/** The player's own card hand. Human hands are keyed by clientId on the server (sim takeWheel/dealCards). */
export function findMyHand(
  cards: Record<string, CardHand> | null | undefined,
  you: Pick<PlayerSessionInfo, 'clientId'> | null | undefined,
): CardHand | null {
  if (!cards || !you) return null;
  return cards[you.clientId] ?? null;
}

const VEHICLE_TYPES: VehicleType[] = ['reach', 'counterbalance', 'turret', 'pallet_jack', 'forklift', 'agv'];
const ARCHETYPES: Archetype[] = ['Sprinter', 'Steady', 'Batcher', 'Opportunist', 'Strategist'];

/**
 * Build a client-side Vehicle for an id that first appears in a delta (a vehicle that
 * joined after our welcome snapshot). Only structural defaults are used; every visible
 * field is overwritten from the delta immediately afterwards.
 */
export function makeClientVehicle(d: QuantisedVehicleDelta): Vehicle {
  const x = typeof d.qx === 'number' ? dequantiseCoord(d.qx) : (d.px ?? 0);
  const y = typeof d.qy === 'number' ? dequantiseCoord(d.qy) : (d.py ?? 0);
  const strategy = (ARCHETYPES as string[]).includes(d.strategy ?? '') ? (d.strategy as Archetype) : 'Steady';
  const type = (VEHICLE_TYPES as string[]).includes(d.type ?? '') ? (d.type as VehicleType) : 'forklift';
  return {
    id: d.id,
    type,
    strategy,
    human: Boolean(d.human),
    extra: Boolean(d.extra),
    isPlayerVehicle: d.id.startsWith('DRV-'),
    ownerClientId: null,
    controlledByClientId: null,
    playerOpaqueId: null,
    isBot: false,
    px: x,
    py: y,
    angle: d.angle ?? 0,
    tile: { x: Math.floor(x), y: Math.floor(y) },
    moveTo: null,
    path: [],
    state: (d.state as Vehicle['state']) ?? 'idle',
    orders: [],
    cargo: [],
    battery: d.battery ?? 0,
    fork: d.fork ?? 0,
    forkTarget: d.fork ?? 0,
    timer: 0,
    wait: 0,
    stuck: 0,
    waitKey: null,
    waitRespect: true,
    stunnedUntil: d.stunnedUntil ?? 0,
    idleSince: 0,
    energySince: 0,
    deliveries: d.deliveries ?? 0,
    incidents: d.incidents ?? 0,
    nearMisses: d.nearMisses ?? 0,
    skids: d.skids ?? 0,
    palletDrops: d.palletDrops ?? 0,
    chargerIdx: -1,
    speedNow: d.speedNow ?? 0,
    braking: false,
    humanCharging: false,
    msg: '',
    driver: d.driver ?? null,
    input: { up: false, down: false, left: false, right: false },
    sPts: d.sPts ?? 0,
    sShipped: d.sShipped ?? 0,
    hzSeen: new Set<number>(),
    hold: null,
    pushing: null,
    skidRolled: false,
    bank: 0,
    aiValue: 0,
    lastTot: 0,
    tactics: defaultTacticsFor(strategy),
    brainError: null,
    lastDecision: null,
    lastTacticsReqAt: 0,
    target: null,
    autopilot: Boolean(d.autopilot),
    directive: d.directive ? ({ ...d.directive } as Vehicle['directive']) : null,
    runMode: d.runMode ?? 'blitz',
    runStartedAt: d.runStartedAt ?? null,
    runEndsAt: d.runEndsAt ?? null,
    runGraceUntil: null,
    runPts: d.runPts ?? d.sPts ?? 0,
    runDeliveries: d.runDeliveries ?? d.deliveries ?? 0,
    runOnTime: d.runOnTime ?? d.deliveries ?? 0,
    runIncidents: d.runIncidents ?? d.incidents ?? 0,
    streak: d.streak ?? 0,
    bestStreak: d.bestStreak ?? 0,
    runFinished: Boolean(d.runFinished),
    combo: d.combo,
    comboBest: d.comboBest,
    fareTrips: d.fareTrips,
    speedyTrips: d.speedyTrips,
  };
}

/**
 * Applies quantised vehicle deltas (`qx, qy` in 1/32 tile units) to the client World.
 * Vehicles missing from the delta are removed; new ids are created.
 */
export function applyQuantisedDelta(
  w: World,
  deltas: QuantisedVehicleDelta[],
  myVid: string | null,
  overlays: Map<string, RenderVehicleOverlay>,
  side: VehicleSideState = createSideState(),
  opts: ApplyDeltaOptions = {},
): void {
  const byId = new Map<string, Vehicle>();
  for (const v of w.vehicles) byId.set(v.id, v);

  const seen = new Set<string>();
  const ordered: Vehicle[] = [];
  for (const d of deltas) {
    let v = byId.get(d.id);
    if (!v) {
      v = makeClientVehicle(d);
      byId.set(d.id, v);
    }
    seen.add(v.id);
    ordered.push(v);

    const targetX = typeof d.qx === 'number' ? dequantiseCoord(d.qx) : typeof d.px === 'number' ? d.px : v.px;
    const targetY = typeof d.qy === 'number' ? dequantiseCoord(d.qy) : typeof d.py === 'number' ? d.py : v.py;

    const isAutopilot = typeof d.autopilot === 'boolean' ? d.autopilot : Boolean(v.autopilot);

    // Our own driven vehicle is predicted locally and corrected by `ack`, unless no input is in flight or Co-Pilot autopilot is steering.
    if (v.id !== myVid || opts.acceptMyPose || isAutopilot) {
      v.px = targetX;
      v.py = targetY;
      v.tile = { x: Math.floor(targetX), y: Math.floor(targetY) };
      if (typeof d.angle === 'number') v.angle = d.angle;
      if (typeof d.speedNow === 'number') v.speedNow = d.speedNow;
    }

    if (typeof d.state === 'string') v.state = d.state as Vehicle['state'];
    if (typeof d.battery === 'number') v.battery = d.battery;
    if (typeof d.fork === 'number') {
      // Server-authoritative: sync the target too, so local stepHuman prediction
      // doesn't lerp toward a stale forkTarget and fight the next snapshot.
      v.fork = d.fork;
      v.forkTarget = d.fork;
    }
    if (Array.isArray(d.cargo)) v.cargo = d.cargo;
    if (Array.isArray(d.orders)) v.orders = d.orders;
    if (typeof d.human === 'boolean') {
      v.human = d.human;
      if (!d.human && d.driver === undefined) v.driver = null;
    }
    if (d.driver !== undefined) v.driver = d.driver;
    if (typeof d.humanCharging === 'boolean') v.humanCharging = d.humanCharging;
    if (typeof d.autopilot === 'boolean') v.autopilot = d.autopilot;
    if (d.directive !== undefined) {
      v.directive = d.directive ? ({ ...d.directive } as Vehicle['directive']) : null;
    }
    if (typeof d.strategy === 'string' && (ARCHETYPES as string[]).includes(d.strategy)) {
      v.strategy = d.strategy as Archetype;
    }
    if (typeof d.type === 'string' && (VEHICLE_TYPES as string[]).includes(d.type)) v.type = d.type as VehicleType;
    if (typeof d.braking === 'boolean') v.braking = d.braking;
    if (typeof d.stunnedUntil === 'number') v.stunnedUntil = d.stunnedUntil;
    if (typeof d.sPts === 'number') v.sPts = d.sPts;
    if (typeof d.sShipped === 'number') v.sShipped = d.sShipped;
    if (typeof d.msg === 'string') v.msg = d.msg;
    if (typeof d.incidents === 'number') v.incidents = d.incidents;
    if (typeof d.nearMisses === 'number') v.nearMisses = d.nearMisses;
    if (typeof d.skids === 'number') v.skids = d.skids;
    if (typeof d.palletDrops === 'number') v.palletDrops = d.palletDrops;
    if (typeof d.deliveries === 'number') v.deliveries = d.deliveries;
    if (d.runMode === 'blitz' || d.runMode === 'freerange') v.runMode = d.runMode;
    if (d.runStartedAt !== undefined) {
      if (!(v.id === myVid && v.runMode === 'blitz' && v.runStartedAt !== null && d.runStartedAt === null)) {
        v.runStartedAt = d.runStartedAt;
      }
    }
    if (d.runEndsAt !== undefined) {
      if (!(v.id === myVid && v.runMode === 'blitz' && v.runEndsAt !== null && d.runEndsAt === null)) {
        v.runEndsAt = d.runEndsAt;
      }
    }
    if (typeof d.runPts === 'number') v.runPts = d.runPts;
    if (typeof d.runDeliveries === 'number') v.runDeliveries = d.runDeliveries;
    if (typeof d.runOnTime === 'number') v.runOnTime = d.runOnTime;
    if (typeof d.runIncidents === 'number') v.runIncidents = d.runIncidents;
    if (typeof d.streak === 'number') v.streak = d.streak;
    if (typeof d.bestStreak === 'number') v.bestStreak = d.bestStreak;
    if (typeof d.runFinished === 'boolean') {
      if (
        !(
          v.id === myVid &&
          v.runMode === 'blitz' &&
          v.runFinished &&
          !d.runFinished &&
          v.runEndsAt != null &&
          w.t >= v.runEndsAt
        )
      ) {
        v.runFinished = d.runFinished;
      }
    }
    if (typeof d.combo === 'number') v.combo = d.combo;
    if (typeof d.comboBest === 'number') v.comboBest = d.comboBest;
    if (typeof d.fareTrips === 'number') v.fareTrips = d.fareTrips;
    if (typeof d.speedyTrips === 'number') v.speedyTrips = d.speedyTrips;
    if (typeof d.extra === 'boolean') v.extra = d.extra;
    if (d.tactics && typeof d.tactics === 'object') v.tactics = { ...v.tactics, ...d.tactics };
    if (Array.isArray(d.path)) v.path = unflattenPath(d.path);
    if (d.brainError !== undefined) v.brainError = d.brainError;
    // Order choice for manual drivers: undefined = unchanged, null = cleared (choice made / lapsed).
    if (d.fareOffer !== undefined) {
      v.fareOffer = d.fareOffer ? { ...d.fareOffer, options: d.fareOffer.options.map((o) => ({ ...o })) } : null;
    }
    if (d.rivalId !== undefined) v.rivalId = d.rivalId;
    if (d.human === false) v.fareOffer = null;

    if (typeof d.lastReason === 'string' && d.lastReason) side.reasons.set(v.id, d.lastReason);
    if (d.decision) {
      side.decisions.set(v.id, d.decision);
      if (d.decision.kind === 'cards') side.cardDecisions.set(v.id, d.decision);
      v.lastDecision = {
        id: `${v.id}-${d.decision.kind}-${d.decision.t}`,
        kind: d.decision.kind,
        reason: d.decision.reason,
        model: d.decision.model,
        latencyMs: d.decision.latencyMs,
        t: d.decision.t,
      };
    }

    if (d.guide && typeof d.guide === 'object') {
      const g = d.guide as GuideInfo;
      const prev = side.guides.get(v.id);
      // Light deltas omit the text; keep the last text while the target kind is unchanged.
      const text = typeof g.text === 'string' ? g.text : prev && prev.kind === g.kind ? prev.text : undefined;
      side.guides.set(v.id, {
        kind: g.kind,
        x: g.x,
        y: g.y,
        inRange: g.inRange,
        text,
        ...(g.stow !== undefined ? { stow: g.stow } : {}),
        ...(g.order !== undefined ? { order: g.order } : {}),
      });
    } else if (d.guide === null) {
      side.guides.delete(v.id);
    }

    const prevOv = overlays.get(v.id) ?? {};
    overlays.set(v.id, {
      ...prevOv,
      // Light deltas omit brainThinking: keep the last known value instead of flickering to false.
      brainThinking: typeof d.brainThinking === 'boolean' ? d.brainThinking : prevOv.brainThinking,
      brainError: d.brainError !== undefined ? d.brainError : prevOv.brainError,
    });
  }

  if (deltas.length > 0) {
    // Server deltas always list every vehicle on the floor: drop the ones that left.
    w.vehicles = ordered;
    for (const id of [...overlays.keys()]) if (!seen.has(id)) overlays.delete(id);
    for (const id of [...side.guides.keys()]) if (!seen.has(id)) side.guides.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface BrainLogEntry {
  t: number;
  vid: string | null;
  kind: string;
  text: string;
  model?: string;
  latencyMs?: number;
  error?: boolean;
}

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'error';

export interface NetworkState {
  status: 'idle' | 'loading' | 'ok' | 'error';
  error: string | null;
  sites: SiteStatus[];
  leaderboard: LeaderboardEntry[];
  updatedAt: number | null;
  switching: { siteId: SiteId; status: 'pending' | 'error' | 'done'; message: string } | null;
}

export interface PhaseInfo {
  phase: Phase;
  resumesAt?: number;
  reason?: string;
}

export type DrawerTab = 'leaderboard' | 'value' | 'days' | 'events' | 'brain';
export const DRAWER_TABS: DrawerTab[] = ['leaderboard', 'value', 'days', 'events', 'brain'];

export type LeaderboardModalTab = 'all' | 'standings' | 'hall' | 'network' | 'silly';

export interface RunEndLeaderboardRow {
  rank: number;
  id: string;
  driver: string;
  baseName: string;
  runNumber: number;
  score: number;
  deliveries: number;
  ppm: number;
  onTimePct: number;
  bestStreak: number;
  incidents: number;
  isYou: boolean;
  isYourPastRun: boolean;
  isHuman: boolean;
  isArchived: boolean;
  runMode?: RunMode;
}

export interface RunEndSummary {
  playerName: string;
  basePlayerName?: string;
  runNumber: number;
  nextRunName: string;
  vehicleId: string;
  score: number;
  deliveries: number;
  incidents: number;
  nearMisses: number;
  rank: number;
  totalVehicles: number;
  humanRank?: number;
  totalHumanRuns?: number;
  shift: number;
  day: number;
  runMode?: RunMode;
  /** Why the run-over modal opened: the blitz clock expired, battery depleted, or server evicted the slot. */
  reason?: 'timer' | 'battery' | EvictionReason;
  bestStreak: number;
  ppm: number;
  onTimePct: number;
  /** Best fare combo multiplier reached this run (1.0 / 1.2 / 1.5 / 2.0). */
  comboBest?: number;
  /** Rated trips this run and how many were SPEEDY. */
  fareTrips?: number;
  speedyTrips?: number;
  /** Hand cards completed (`status === 'done'`). */
  cardsDone?: number;
  /** Full Blitz-paced leaderboard rows (humans + AI + archived runs in this shift). */
  leaderboardRows?: RunEndLeaderboardRow[];
  /** Previous run points by this same player in this shift (for delta comparison). */
  previousRunPts?: number;
  previousRunNumber?: number;
  bestRunPts?: number;
  /** Next rival directly ahead in Blitz pace. */
  rivalNext?: {
    driver: string;
    ptsAhead: number;
    rank: number;
    isAi: boolean;
  };
  /** Top AI vehicle pace benchmark for comparison. */
  aiBenchmark?: {
    topAiDriver: string;
    topAiPts: number;
    topAiPpm: number;
    topAiOnTimePct: number;
  };
  /** Points of the last run this browser finished (localStorage), for "▲/▼ N vs last run". */
  lastRunPts?: number | null;
  /** "You vs Gemini" recap from real `brainDecision` / `commandEcho` messages; absent = no data. */
  recap?: AiRecap | null;
}

export interface UiState {
  drawerOpen: boolean;
  drawerTab: DrawerTab;
  helpOpen: boolean;
  /** Full-screen Leaderboard & Silly Superlatives modal (#leaderboardModal). */
  leaderboardModalOpen: boolean;
  leaderboardModalTab: LeaderboardModalTab;
  /** Co-Pilot & Agent Designer modal (#agent-designer-modal). */
  agentDesignerOpen: boolean;
  /** True while waiting for an `agentCommand` response / `commandEcho` from the server. */
  agentCommandPending: boolean;
  /** Last `commandEcho` resulting from an `agentCommand` or directive update. */
  lastAgentEcho: CommandEchoMessage | null;
  /** Explicit HUD overlay (chat bar, held-Tab standings sheet, ☰ menu); null = none. */
  overlay: UiOverlay | null;
  /** Menu flyout currently open (one at a time); null = none. */
  flyout: FlyoutId | null;
  /** Floor orders → 📦 Dispatch popover open. */
  dispatchOpen: boolean;
  /** Dispatch draft (From zone / To bay / count / P0). */
  dispatchDraft: { sourceZone: DispatchSourceZone; targetBay: DispatchTargetBay; count: number; p0: boolean };
  /** Chat target: Co-Pilot (`agentCommand`) or the Floor (`nlCommand`). */
  chatTarget: 'copilot' | 'floor';
  /** HUD Full (false) / Minimal (true): minimal hides dash hints and the contracts card. Persisted. */
  hudMinimal: boolean;
  /** Opt-in Rack Lift Minigame (3D vertical shelf lifting + Hold-E height gauge); default false. */
  rackLiftMinigame: boolean;
  /**
   * Player's Dispatcher's Call preference (`?dispatch=` / localStorage; default true). The
   * site must also enable it (`welcome.limits.dispatchersCall`).
   */
  dispatchersCall: boolean;
  /** Contracts card collapsed to its header. */
  contractsCollapsed: boolean;
  /** Vehicle the floor camera follows (Floor view inspector → Follow); null = free camera. */
  followVid: string | null;
  /** Rank when the current run started (for "▲ n from start" on the results sheet). */
  runStartRank: { vid: string; rank: number } | null;
  /** Value chart window in game-minutes (240 / 480 / 1440). */
  valueWindow: number;
  /** Card ids selected in the current deal offer. */
  offerSel: Set<string>;
  /** Identity of the offer the selection belongs to (reset when a new offer arrives). */
  offerKey: string | null;
  /** Highlighted option index in the driver's open order choice (Q cycles, F confirms). */
  fareSel: number;
  /** Identity of the order choice `fareSel` belongs to (reset to the Co-Pilot pick on change). */
  fareKey: string | null;
  /** Populated when the player's 3-Minute Blitz run finishes (`runFinished === true`). */
  runEnd: RunEndSummary | null;
  /** Selected driver play mode ('blitz' | 'freerange'). */
  runMode: RunMode;
  /** Active cross-site surge relocation offer (+75 pts) when current shard is crowded. */
  relocationOffer: RelocationOfferMessage | null;
  /** Offer key the player tucked away with Esc (the contracts card shows an "offer waiting" row instead). */
  dealMinimizedKey: string | null;
  /** Vehicle id whose run-over summary the player dismissed (keeps it from re-popping every delta). */
  runEndDismissedVid: string | null;
  /** DRIVE alert line (`#alert`): one at a time, newest wins, auto-clears (see ui/notify.ts). */
  alert: AlertState | null;
  /** Client notices merged into the FLOOR feed (newest first, deduped, ≤3). */
  feedNotes: FeedNote[];
  /** FLOOR: transient Floor-order refusal line above the orders bar (`#orderNote`). */
  orderNote: { text: string; until: number } | null;
  /** "Start driving" pressed before the welcome arrived: drive as soon as it does ("Connecting…"). */
  pendingDrive: boolean;
  /** My last real `fare` event this run (Run 1 coach "Nice! +N"). */
  coachFare: { pts: number; at: number } | null;
  /** 🛡 card for the last Model-Armor-blocked command (auto-clears at `until`). */
  shield: (ShieldCard & { until: number }) | null;
}

/** Explicit HUD overlays (results / contract pick are derived from game state, see ui/mode.ts). */
export type UiOverlay = 'chat' | 'standings' | 'menu';

/** Menu flyouts: each hosts one existing panel module (or the Layers / Settings list). */
export type FlyoutId = 'board' | 'fleet' | 'drivers' | 'value' | 'network' | 'layers' | 'settings';
export const FLYOUT_IDS: FlyoutId[] = ['board', 'fleet', 'drivers', 'value', 'network', 'layers', 'settings'];

const HUD_MINIMAL_KEY = 'warehouse.hud.minimal';
export const RACK_LIFT_KEY = 'warehouse.feature.rackLift';

function readHudMinimal(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(HUD_MINIMAL_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persist the HUD Full / Minimal choice (best effort; private mode may refuse storage). */
export function saveHudMinimal(on: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(HUD_MINIMAL_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable: the choice lasts for this tab only */
  }
}

export function readRackLiftOverride(): boolean | null {
  try {
    if (typeof window !== 'undefined' && window.location?.search) {
      const q = new URLSearchParams(window.location.search).get('rackLift');
      if (q === '1' || q === 'true') return true;
      if (q === '0' || q === 'false') return false;
    }
  } catch {
    /* ignore URL parsing errors */
  }
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem(RACK_LIFT_KEY);
      if (v === '1') return true;
      if (v === '0') return false;
    }
  } catch {
    /* storage unavailable */
  }
  return null;
}

export function saveRackLiftPref(on: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(RACK_LIFT_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

function eventVid(ev: SimEvent): string | null {
  return typeof ev.vid === 'string' ? ev.vid : null;
}

export function brainEntryFromEvent(ev: SimEvent): BrainLogEntry | null {
  if (ev.type !== 'decision' && ev.type !== 'retune' && ev.type !== 'brain_error') return null;
  return {
    t: ev.t,
    vid: eventVid(ev),
    kind: typeof ev.kind === 'string' ? ev.kind : ev.type,
    text: ev.text,
    model: typeof ev.model === 'string' ? ev.model : undefined,
    latencyMs: typeof ev.latencyMs === 'number' ? ev.latencyMs : undefined,
    error: ev.type === 'brain_error',
  };
}

export function defaultContractsCollapsed(
  viewport?: { width: number; height: number } | null,
): boolean {
  if (viewport) {
    return viewport.width <= 900 || viewport.height <= 500;
  }
  try {
    if (typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth > 0) {
      if (window.innerWidth <= 900 || window.innerHeight <= 500) return true;
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(max-width: 900px), (max-height: 500px), (pointer: coarse)').matches;
    }
  } catch {
    /* non-DOM environment */
  }
  return false;
}

/** An `agentCommand` with no `commandEcho` / `error` after this long stops showing as pending. */
export const AGENT_COMMAND_TIMEOUT_MS = 10_000;

/** Fresh Floor dispatch draft (also restored by `resetForNewSession`). */
export function defaultDispatchDraft(): UiState['dispatchDraft'] {
  return { sourceZone: 'any', targetBay: 'auto', count: 1, p0: false };
}

export class ClientStore {
  world: World;
  you: PlayerSessionInfo | null = null;
  /** Current driver vehicle ID (null when spectating or after eviction). */
  myVid: string | null = null;
  /** The vehicle spawned for us at join (a player vehicle, cannot be "handed back"). */
  dedicatedVid: string | null = null;
  siteId: SiteId | null = null;
  welcomed = false;
  /** Active FIFO queue status when all driver slots are full (or null when not queued). */
  queue: QueueStatus | null = null;
  /** Whether to automatically claim the seat as soon as our queue lease becomes 'ready'. */
  autoClaimSeat = true;
  /** Reason the server evicted our driver slot at run end / idle / contention lease expiry. */
  evictedReason: EvictionReason | null = null;
  /** The player's lobby-issued resume code (`JoinResponse.resumeToken`), shown as "resume code". */
  resumeCode: string | null = null;
  /** Last `/api/queue*` failure (e.g. 503 queue_unavailable); null once a queue call succeeds. */
  queueError: string | null = null;
  /**
   * Our own opaque publicId from the lobby (`JoinResponse.publicId`). Used to find our row in the
   * `/api/network` leaderboard. Display-safe, but never persisted as the raw clientId.
   */
  publicId: string | null = null;

  /** Our id as the site / leaderboard see it: the lobby publicId, else `welcome.you.clientId`. */
  selfPublicId(): string | null {
    return this.publicId ?? this.you?.clientId ?? null;
  }

  selectedVid: string | null = null;
  highlightStrategy: string | null = null;
  layers: RenderLayers = { routes: true, traffic: false, labels: true, ghost: true };
  coneMode = false;

  readonly overlays = new Map<string, RenderVehicleOverlay>();
  side: VehicleSideState = createSideState();
  events: SimEvent[] = [];
  brainLog: BrainLogEntry[] = [];
  presence: PresenceEntry[] = [];
  brainHealth: BrainHealthMessage | null = null;
  phaseInfo: PhaseInfo | null = null;
  limits: SiteLimits | null = null;
  /** Per-recipient Floor-order state from welcome/delta (null until the server sends it). */
  floorOrders: FloorOrdersStatus | null = null;
  /** `Date.now()` when `floorOrders` arrived: its *InMs fields count down locally from here. */
  floorOrdersAt = 0;
  board: BoardRow[] | null = null;
  activeA2ui: A2uiScreenMessage | null = null;
  /** Open Dispatcher's Call minigame card (with its reveal once it arrives). */
  dispatchersCall: DispatchersCallCard | null = null;
  conn: { status: ConnStatus; text: string } = { status: 'idle', text: '' };
  network: NetworkState = {
    status: 'idle',
    error: null,
    sites: [],
    leaderboard: [],
    updatedAt: null,
    switching: null,
  };

  /** Bumped when the floor map is rebuilt (welcome / tier change) so the renderer can re-fit. */
  mapVersion = 0;
  /** Bumped on every applied change; UI modules use it as a cheap dirty flag. */
  version = 0;

  /** Pure view state shared by panels and hotkeys (never sent to the server except via actions). */
  ui: UiState = {
    drawerOpen: false,
    drawerTab: 'leaderboard',
    helpOpen: false,
    leaderboardModalOpen: false,
    leaderboardModalTab: 'all',
    agentDesignerOpen: false,
    agentCommandPending: false,
    lastAgentEcho: null,
    overlay: null,
    flyout: null,
    dispatchOpen: false,
    dispatchDraft: defaultDispatchDraft(),
    chatTarget: 'copilot',
    hudMinimal: readHudMinimal(),
    rackLiftMinigame: readRackLiftOverride() ?? false,
    dispatchersCall: readDispatchersCallOverride() ?? true,
    contractsCollapsed: defaultContractsCollapsed(),
    followVid: null,
    runStartRank: null,
    valueWindow: 480,
    offerSel: new Set<string>(),
    offerKey: null,
    fareSel: 0,
    fareKey: null,
    runEnd: null,
    runMode: 'blitz',
    relocationOffer: null,
    dealMinimizedKey: null,
    runEndDismissedVid: null,
    alert: null,
    feedNotes: [],
    orderNote: null,
    pendingDrive: false,
    coachFare: null,
    shield: null,
  };

  /** Run 1 drive-first onboarding active (pick sheet skipped, Blitz only, coach on the objective). */
  driveFirst = false;
  /** Latest real `brainDecision` per AI vehicle id. */
  readonly brainDecisions = new Map<string, RivalDecision>();
  /** Per-run log for the results "You vs Gemini" recap (null until a run starts). */
  runAiLog: RunAiLog | null = null;
  /** Model-Armor blocks of my commands this session (shield card strike counter). */
  shieldStrikes = 0;
  /** `Date.now()` when the pending `agentCommand` was sent (null when nothing is pending). */
  agentCommandPendingAt: number | null = null;

  private listeners = new Set<() => void>();

  constructor() {
    // Empty local container until the welcome snapshot replaces it. Nothing from it is displayed
    // as data: every panel waits for `welcomed` before rendering numbers.
    this.world = createWorld({ seed: 1, siteId: 'den-1' });
    this.world.vehicles = [];
    this.world.orders = [];
    this.world.events = [];
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  emit(): void {
    this.changed();
  }

  isRackLiftEnabled(): boolean {
    return Boolean(this.ui.rackLiftMinigame);
  }

  setRackLiftMinigame(on: boolean): void {
    const next = Boolean(on);
    this.ui.rackLiftMinigame = next;
    saveRackLiftPref(next);
    this.changed();
  }

  /** Dispatcher's Call on for this player: site flag AND the player's preference. */
  isDispatchersCallEnabled(): boolean {
    return Boolean(this.limits?.dispatchersCall) && this.ui.dispatchersCall;
  }

  setDispatchersCallPref(on: boolean): void {
    this.ui.dispatchersCall = Boolean(on);
    saveDispatchersCallPref(this.ui.dispatchersCall);
    if (!this.ui.dispatchersCall) this.dispatchersCall = null;
    this.changed();
  }

  vehicle(id: string | null | undefined): Vehicle | null {
    if (!id) return null;
    return this.world.vehicles.find((v) => v.id === id) ?? null;
  }

  myVehicle(): Vehicle | null {
    return this.vehicle(this.you?.vid ?? this.myVid ?? null);
  }

  /** True while we hold the wheel of a human-driven vehicle (manual or Co-Pilot autopilot). */
  isDriving(): boolean {
    const v = this.myVehicle();
    return Boolean(v && v.human);
  }

  /** True while our own leased vehicle is currently being steered by Co-Pilot / AI Autopilot. */
  isMyVehicleAutopilot(): boolean {
    const v = this.myVehicle();
    return Boolean(v && v.human && v.autopilot);
  }

  /** An `agentCommand` was sent: show it as pending until its echo, an error or the timeout. */
  markAgentCommandPending(now: number): void {
    this.ui.agentCommandPending = true;
    this.agentCommandPendingAt = now;
  }

  /** Clear the pending `agentCommand` flag; returns true when it was set. */
  clearAgentCommandPending(): boolean {
    const was = this.ui.agentCommandPending;
    this.ui.agentCommandPending = false;
    this.agentCommandPendingAt = null;
    return was;
  }

  /** Clear a pending `agentCommand` older than AGENT_COMMAND_TIMEOUT_MS; returns true when it expired. */
  expireAgentCommandPending(now: number): boolean {
    if (!this.ui.agentCommandPending) return false;
    const at = this.agentCommandPendingAt;
    if (at !== null && now - at < AGENT_COMMAND_TIMEOUT_MS) return false;
    return this.clearAgentCommandPending();
  }

  /**
   * A welcome landed on a different site or vehicle: drop view state that belonged to the old
   * session (notices, follow target, offers, drafts, open cards, rival/AI logs). Per-site data
   * (brain health, phase) is cleared only when the site changed.
   */
  resetForNewSession(siteChanged: boolean): void {
    const ui = this.ui;
    ui.feedNotes = [];
    ui.alert = null;
    ui.orderNote = null;
    ui.followVid = null;
    ui.relocationOffer = null;
    ui.dispatchDraft = defaultDispatchDraft();
    ui.dispatchOpen = false;
    ui.coachFare = null;
    ui.shield = null;
    ui.runStartRank = null;
    ui.dealMinimizedKey = null;
    ui.fareSel = 0;
    ui.fareKey = null;
    this.activeA2ui = null;
    this.dispatchersCall = null;
    this.coneMode = false;
    this.clearAgentCommandPending();
    // Rival pill + per-run AI recap log belong to the old vehicle.
    this.brainDecisions.clear();
    this.runAiLog = null;
    if (siteChanged) {
      this.brainHealth = null;
      this.phaseInfo = null;
    }
    this.changed();
  }

  /** Apply an incoming commandEcho that carries an AgentDirective immediately to our vehicle. */
  applyAgentEcho(msg: CommandEchoMessage): void {
    this.clearAgentCommandPending();
    this.ui.lastAgentEcho = msg;
    const v = this.myVehicle();
    if (v && msg.directive) {
      const dir = msg.directive as AgentDirective;
      v.directive = { ...(v.directive ?? {}), ...dir } as Vehicle['directive'];
      if (typeof dir.autopilot === 'boolean') v.autopilot = dir.autopilot;
      const persona = dir.persona ?? dir.strategy;
      if (persona && (ARCHETYPES as string[]).includes(persona)) {
        v.strategy = persona as Archetype;
      }
      if (dir.tactics && typeof dir.tactics === 'object') {
        v.tactics = {
          ...v.tactics,
          ...dir.tactics,
          flatPath: dir.tactics.flatPath === undefined ? v.tactics.flatPath : flatPathFlag(dir.tactics.flatPath),
        };
      }
    }
    this.changed();
  }

  /** Driving a vehicle that belongs to an AI (Esc / Hand back returns it). */
  canHandBack(): boolean {
    const v = this.myVehicle();
    return Boolean(v && v.human && !v.isPlayerVehicle && v.id !== this.dedicatedVid);
  }

  /** Vehicle id the renderer should follow (only our own driven vehicle). */
  renderMyVid(): string | null {
    return this.isDriving() ? (this.you?.vid ?? this.myVid ?? null) : null;
  }

  /** HUD v3 mode: DRIVE while holding a wheel (until "Watch the floor" after a run), else FLOOR. */
  hudMode(): HudMode {
    const me = this.myVehicle();
    return hudMode({
      driving: this.isDriving(),
      myVid: me?.id ?? null,
      runFinished: Boolean(me?.runFinished),
      runEndDismissedVid: this.ui.runEndDismissedVid,
    });
  }

  /** The overlay currently covering the HUD (results > contract pick > chat / standings / menu). */
  activeOverlay(): ActiveOverlay {
    return activeOverlay({
      mode: this.hudMode(),
      runEndOpen: this.ui.runEnd !== null,
      hand: this.welcomed ? this.myHand() : null,
      dealMinimizedKey: this.ui.dealMinimizedKey,
      overlay: this.ui.overlay,
      modalOpen: this.ui.helpOpen || this.ui.agentDesignerOpen || this.ui.leaderboardModalOpen,
    });
  }

  /** A Dispatcher's Call card is on screen (an expired card lingers until the next UI tick). */
  dispatchersCallVisible(now = Date.now()): boolean {
    return this.dispatchersCall !== null && dcVisible(this.dispatchersCall, now);
  }

  /** The single top layer (ui/modal.ts): gates every hotkey and the driving keys. */
  topLayer(now = Date.now()): TopLayer {
    return topLayer({
      helpOpen: this.ui.helpOpen,
      overlay: this.activeOverlay(),
      agentDesignerOpen: this.ui.agentDesignerOpen,
      leaderboardModalOpen: this.ui.leaderboardModalOpen,
      dispatchersCallOpen: this.dispatchersCallVisible(now),
      a2uiOpen: this.activeA2ui !== null,
    });
  }

  /** `floorOrders` with every *InMs counted down to `now` (null until the server sends it). */
  floorOrdersNow(now = Date.now()): FloorOrdersStatus | null {
    const f = this.floorOrders;
    if (!f) return null;
    const dt = Math.max(0, now - this.floorOrdersAt);
    const left = (ms: number): number => Math.max(0, ms - dt);
    return {
      rush: { readyInMs: left(f.rush.readyInMs) },
      p0: { open: f.p0.open, readyInMs: left(f.p0.readyInMs) },
      cones: { mine: f.cones.mine },
      dispatch: { readyInMs: left(f.dispatch.readyInMs) },
      fleet: { addReadyInMs: left(f.fleet.addReadyInMs), removable: f.fleet.removable },
      nl: { left: f.nl.left, resetInMs: left(f.nl.resetInMs) },
    };
  }

  botVids(): Set<string> {
    const s = new Set<string>();
    for (const p of this.presence) if (p.isBot && p.vid) s.add(p.vid);
    return s;
  }

  myHand(): CardHand | null {
    return findMyHand(this.world.cards, this.you);
  }

  /** Server guidance for our driven vehicle; null (never undefined) when there is none. */
  myGuide(): GuideInfo | null {
    const vid = this.renderMyVid();
    return vid ? (this.side.guides.get(vid) ?? null) : null;
  }

  /** The open order choice on our driven vehicle (server `fareOffer`), or null. */
  myFareOffer(): FareOffer | null {
    const v = this.isDriving() ? this.myVehicle() : null;
    const off = v?.fareOffer ?? null;
    return off && off.options.length ? off : null;
  }

  /** Keep the highlight on the Co-Pilot pick (index 0) whenever a different offer arrives. */
  syncFareSel(): void {
    const off = this.myFareOffer();
    const key = fareOfferKey(off);
    if (key !== this.ui.fareKey) {
      this.ui.fareKey = key;
      this.ui.fareSel = 0;
    } else if (off && this.ui.fareSel >= off.options.length) {
      this.ui.fareSel = 0;
    }
  }

  /** Option currently highlighted in the open choice. */
  highlightedFareOption(): FareOption | null {
    const off = this.myFareOffer();
    if (!off) return null;
    return off.options[Math.min(Math.max(0, this.ui.fareSel), off.options.length - 1)] ?? null;
  }

  /** Our assigned AI rival (server `rivalId`) when it is still on the floor. */
  myRival(): Vehicle | null {
    const v = this.isDriving() ? this.myVehicle() : null;
    return v?.rivalId ? this.vehicle(v.rivalId) : null;
  }

  /**
   * Synchronize `this.presence` and `this.world.vehicles` so that:
   * - Vehicle `isBot`, `isPlayerVehicle`, `human`, and `driver` reflect active `presence` entries
   *   even if `presence` arrived before the vehicle's first light `delta`.
   * - `presence[i].points` and `presence[i].score` stay synced with live `v.sPts` from 10 Hz deltas.
   */
  private syncPresenceWithVehicles(): void {
    const byVid = new Map<string, PresenceEntry>();
    for (const p of this.presence) {
      if (p.vid && (p.role ? p.role === 'driver' : true)) {
        byVid.set(p.vid, p);
      }
    }
    for (const v of this.world.vehicles) {
      if (v.id.startsWith('DRV-')) v.isPlayerVehicle = true;
      const p = byVid.get(v.id);
      if (p) {
        v.isBot = Boolean(p.isBot);
        v.human = true;
        if (p.name) v.driver = p.name;
      } else {
        v.isBot = false;
      }
      const ov = this.overlays.get(v.id);
      if (ov) {
        ov.isBot = Boolean(v.isBot);
        ov.human = v.human;
      }
    }
    for (const p of this.presence) {
      if (p.vid) {
        const v = this.world.vehicles.find((x) => x.id === p.vid);
        if (v) {
          const pts = Math.round(v.sPts);
          p.points = pts;
          p.score = pts;
        }
      }
    }
  }

  // ---- message application -------------------------------------------------

  /** Returns an error string when the snapshot could not be restored (nothing is applied then). */
  applyWelcome(msg: WelcomeMessage): string | null {
    let restored: World | null = null;
    if (msg.snapshot) {
      try {
        restored = restore(msg.snapshot as WorldSnapshotV5);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    if (!restored) return 'Welcome message carried no world snapshot.';

    const siteChanged = this.siteId !== null && this.siteId !== msg.you.siteId;
    this.world = restored;
    this.you = msg.you;
    this.myVid = msg.you.vid;
    this.dedicatedVid = msg.you.vid;
    this.siteId = msg.you.siteId;
    this.limits = msg.limits ?? null;
    if (readRackLiftOverride() === null) {
      this.ui.rackLiftMinigame = Boolean(msg.limits?.rackLiftMinigame ?? false);
    }
    this.floorOrders = msg.floorOrders ?? null;
    this.floorOrdersAt = Date.now();
    this.welcomed = true;
    if (msg.you.role === 'driver' && msg.you.vid) {
      this.evictedReason = null;
      this.queue = null;
    }

    this.overlays.clear();
    this.side = createSideState();
    for (const v of restored.vehicles) {
      if (v.lastDecision) {
        const dec: VehicleDecision = {
          kind: v.lastDecision.kind,
          model: v.lastDecision.model,
          latencyMs: v.lastDecision.latencyMs,
          reason: v.lastDecision.reason,
          t: v.lastDecision.t,
        };
        this.side.decisions.set(v.id, dec);
        if (dec.kind === 'cards') this.side.cardDecisions.set(v.id, dec);
        this.side.reasons.set(v.id, v.lastDecision.reason);
      }
    }
    this.events = mergeEvents([], restored.events ?? [], EVENT_CAP);
    this.brainLog = (restored.decisionJournal ?? [])
      .slice(-BRAIN_LOG_CAP)
      .reverse()
      .map((j) => ({
        t: j.tApplied,
        vid: j.agentId,
        kind: j.kind,
        text: `${j.agentId} (${j.persona}) [${j.kind}]: ${j.reason}`,
        model: j.model,
        latencyMs: j.latencyMs,
      }));
    // The snapshot carries the real deliveries/incident log, so the board computed from it is genuine
    // until the server's periodic stats.board arrives.
    this.board = simBoard(restored);
    appendSeries(restored.valueSeries, [], SERIES_CAP);
    restored.series = restored.valueSeries;
    this.ui.offerSel = new Set();
    this.ui.offerKey = null;

    if (siteChanged || !this.vehicle(this.selectedVid)) this.selectedVid = null;
    if (!this.selectedVid && this.isDriving()) this.selectedVid = msg.you.vid;
    if (siteChanged) {
      this.highlightStrategy = null;
      this.presence = [];
    }
    this.syncPresenceWithVehicles();
    this.syncFareSel();
    this.mapVersion++;
    this.changed();
    return null;
  }

  /** Applies a delta; returns the new events (oldest-first) for notification routing. */
  applyDelta(msg: DeltaMessage, opts: ApplyDeltaOptions = {}): SimEvent[] {
    const w = this.world;
    w.t = msg.t;

    if (typeof msg.tier === 'number' && msg.tier !== w.tier) {
      w.tier = msg.tier;
      w.map = buildMap(msg.tier, w.siteId);
      const heat = new Float32Array(w.map.w * w.map.h);
      heat.set(w.heat.subarray(0, Math.min(w.heat.length, heat.length)));
      w.heat = heat;
      this.mapVersion++;
    }

    const prevMyVid = this.you?.vid ?? this.myVid ?? null;
    applyQuantisedDelta(w, msg.vehicles, prevMyVid, this.overlays, this.side, opts);
    this.syncPresenceWithVehicles();
    this.syncFareSel();

    if (Array.isArray(msg.orders)) w.orders = msg.orders;
    if (Array.isArray(msg.hazards)) {
      w.spills = msg.hazards;
      w.hazards = msg.hazards;
    }
    if (Array.isArray(msg.cones)) w.cones = new Set(msg.cones);
    if (Array.isArray(msg.bays)) w.bays = msg.bays;
    if (Array.isArray(msg.markers)) w.markers = msg.markers;

    const st = msg.stats;
    if (st) {
      if (st.shift) w.shift = st.shift;
      if (st.day) w.day = st.day;
      if (st.totals) w.totals = st.totals;
      if (typeof st.shiftTime === 'number') w.shiftTime = st.shiftTime;
      if (typeof st.rushUntil === 'number') w.rushUntil = st.rushUntil;
      if (Array.isArray(st.board)) this.board = st.board;
      if (Array.isArray(st.seriesAppend)) {
        appendSeries(w.valueSeries, st.seriesAppend);
        w.series = w.valueSeries;
      }
      if (Array.isArray(st.history)) w.history = st.history as unknown as DayHistoryEntry[];
      if (Array.isArray(st.hall)) {
        w.hallOfFame = st.hall as unknown as HallEntry[];
        w.hall = w.hallOfFame;
      }
      if (st.heat) w.heat = denseHeat(st.heat);
      if (Array.isArray(st.completedRuns)) {
        w.completedRuns = st.completedRuns as unknown as CompletedRunRecord[];
      }
    }
    if (msg.votes && typeof msg.votes === 'object') w.difficultyVotes = msg.votes;
    if (msg.floorOrders) {
      this.floorOrders = msg.floorOrders;
      this.floorOrdersAt = Date.now();
    }
    if (msg.hands && typeof msg.hands === 'object') {
      w.cards = mergeOwnHand(w.cards ?? {}, msg.hands as unknown as World['cards'], this.you?.clientId);
      w.hands = w.cards;
    }
    if (typeof msg.difficulty === 'string' && msg.difficulty in DIFFICULTY) {
      w.difficulty = msg.difficulty as World['difficulty'];
    }

    const incoming = (Array.isArray(msg.events) ? msg.events : []) as SimEvent[];
    if (incoming.length) {
      this.events = mergeEvents(this.events, incoming, EVENT_CAP);
      const brain = incoming.map(brainEntryFromEvent).filter((e): e is BrainLogEntry => !!e);
      if (brain.length) this.brainLog = mergeEvents(this.brainLog, brain, BRAIN_LOG_CAP);
      for (const ev of incoming) {
        if (ev.type === 'decision' && typeof ev.vid === 'string' && typeof ev.model === 'string') {
          const kind = (typeof ev.kind === 'string' ? ev.kind : 'contract') as VehicleDecision['kind'];
          const reason = ev.text.includes(']: ') ? ev.text.slice(ev.text.indexOf(']: ') + 3) : ev.text;
          const dec: VehicleDecision = {
            kind,
            model: ev.model,
            latencyMs: typeof ev.latencyMs === 'number' ? ev.latencyMs : 0,
            reason,
            t: ev.t,
          };
          this.side.decisions.set(ev.vid, dec);
          if (kind === 'cards') this.side.cardDecisions.set(ev.vid, dec);
          this.side.reasons.set(ev.vid, reason);
        }
      }
    }
    if (this.selectedVid && !this.vehicle(this.selectedVid)) this.selectedVid = null;
    this.changed();
    return incoming;
  }

  applyPresence(players: PresenceEntry[]): void {
    this.presence = players;
    if (this.you) {
      const me = players.find((p) => p.clientId === this.you!.clientId);
      if (me) {
        const nextName = me.name || this.you.name;
        const nextRole = me.role ?? this.you.role;
        if (me.vid !== this.you.vid || nextName !== this.you.name || nextRole !== this.you.role) {
          this.you = { ...this.you, vid: me.vid, name: nextName, role: nextRole };
          this.myVid = me.vid;
          if (me.vid && !this.selectedVid) this.selectedVid = me.vid;
        }
      }
    }
    this.syncPresenceWithVehicles();
    this.changed();
  }

  setQueue(queue: QueueStatus | null | undefined): void {
    if (!queue || queue.state === 'none' || queue.state === 'claimed') {
      this.queue = null;
    } else {
      this.queue = queue;
    }
    this.changed();
  }

  /**
   * Apply a server `runEvicted` broadcast:
   * - Record `evictedReason = msg.reason`
   * - Populate or update `ui.runEnd` with final stats from `msg`
   * - Transition local state to spectator (`you.role = 'spectator'`, `you.vid = null`, `myVid = null`, `dedicatedVid = null`)
   */
  applyRunEvicted(msg: RunEvictedMessage, fallbackDisplayName?: string | null): void {
    const vidStr = String(msg.vid);
    const me = this.vehicle(vidStr) ?? this.myVehicle();
    const currentName = fallbackDisplayName || this.you?.name || me?.driver || 'Swift-Pallet';
    const { baseName, runNumber } = parseRunDisplayName(currentName);
    const nextName = nextRunDisplayName(currentName);

    const deliveries = Math.round(msg.shipped);
    const finalScore = Math.round(msg.pts);
    const finalIncidents = Math.round(msg.incidents);
    const finalBestStreak = Math.round(msg.bestStreak);

    if (me && me.id === vidStr) {
      me.runPts = finalScore;
      me.sPts = Math.max(me.sPts ?? 0, finalScore);
      me.runDeliveries = deliveries;
      me.deliveries = Math.max(me.deliveries ?? 0, deliveries);
      me.sShipped = Math.max(me.sShipped ?? 0, deliveries);
      me.bestStreak = Math.max(me.bestStreak ?? 0, finalBestStreak);
      me.runIncidents = finalIncidents;
      me.runMode = msg.runMode;
      me.runFinished = true;
    }

    const rows = blitzLeaderboard(this.world);
    const rankIdx = rows.findIndex((v) => v.id === vidStr);
    const rank = rankIdx >= 0 ? rankIdx + 1 : Math.max(1, rows.length);
    const onTime = me?.runOnTime ?? deliveries;
    const onTimePct = deliveries > 0 ? Math.min(100, Math.round((onTime / deliveries) * 100)) : 100;
    const elapsedMin = Math.max(1, (me?.runEndsAt ?? this.world.t) - (me?.runStartedAt ?? 0));
    const realMinutes = elapsedMin / 60;
    const ppm = Math.round((deliveries / Math.max(0.25, realMinutes)) * 10) / 10;

    const activeVehicleIds = new Set(this.world.vehicles.map((v) => v.id));
    const leaderboardRows: RunEndLeaderboardRow[] = rows.map((v, i) => {
      const driverLabel = v.driver || `${v.id} (${v.strat})`;
      const parsed = parseDriverRunInfo(driverLabel);
      const isHuman = Boolean(v.human);
      const isArchived = !activeVehicleIds.has(v.id);
      const vScore = v.id === vidStr ? finalScore : Math.round(v.blitzPts ?? v.pts ?? 0);
      return {
        rank: i + 1,
        id: v.id,
        driver: driverLabel,
        baseName: v.baseName || parsed.baseName,
        runNumber: v.runNumber || parsed.runNumber,
        score: vScore,
        deliveries: v.id === vidStr ? deliveries : (v.shipped ?? 0),
        ppm: v.id === vidStr ? ppm : (v.ppm ?? 0),
        onTimePct: v.id === vidStr ? onTimePct : (v.onTimePct ?? 100),
        bestStreak: v.id === vidStr ? finalBestStreak : (v.bestStreak ?? v.streak ?? 0),
        incidents: v.id === vidStr ? finalIncidents : (v.incidents ?? 0),
        isYou: v.id === vidStr,
        isYourPastRun:
          v.id !== vidStr &&
          isHuman &&
          (v.baseName || parsed.baseName).toLowerCase() === baseName.toLowerCase(),
        isHuman,
        isArchived,
        runMode: v.id === vidStr ? msg.runMode : v.runMode,
      };
    });

    if (!leaderboardRows.some((r) => r.isYou)) {
      leaderboardRows.push({
        rank,
        id: vidStr,
        driver: currentName,
        baseName,
        runNumber,
        score: finalScore,
        deliveries,
        ppm,
        onTimePct,
        bestStreak: finalBestStreak,
        incidents: finalIncidents,
        isYou: true,
        isYourPastRun: false,
        isHuman: true,
        isArchived: true,
        runMode: msg.runMode,
      });
      leaderboardRows.sort((a, b) => b.score - a.score);
      leaderboardRows.forEach((r, idx) => {
        r.rank = idx + 1;
      });
    }

    const myRowIdx = leaderboardRows.findIndex((r) => r.isYou);
    const resolvedRank = myRowIdx >= 0 ? myRowIdx + 1 : rank;
    const humanRows = leaderboardRows.filter((r) => r.isHuman);
    const humanIdx = humanRows.findIndex((r) => r.isYou);
    const humanRank = humanIdx >= 0 ? humanIdx + 1 : Math.max(1, humanRows.length);

    const yourPastRuns = leaderboardRows
      .filter((r) => r.isYourPastRun)
      .sort((a, b) => b.runNumber - a.runNumber);
    const previousRun = yourPastRuns[0];
    const allYourRuns = leaderboardRows.filter((r) => r.isYou || r.isYourPastRun);
    const bestRunPts = allYourRuns.reduce((max, r) => Math.max(max, r.score), finalScore);

    const rivalAbove = myRowIdx > 0 ? leaderboardRows[myRowIdx - 1] : undefined;
    const rivalNext = rivalAbove
      ? {
          driver: rivalAbove.driver,
          ptsAhead: Math.max(1, rivalAbove.score - finalScore),
          rank: rivalAbove.rank,
          isAi: !rivalAbove.isHuman,
        }
      : undefined;

    const topAi = leaderboardRows.find((r) => !r.isHuman);
    const aiBenchmark = topAi
      ? {
          topAiDriver: topAi.driver,
          topAiPts: topAi.score,
          topAiPpm: topAi.ppm,
          topAiOnTimePct: topAi.onTimePct,
        }
      : undefined;

    const hand =
      (this.you?.clientId ? this.world.cards?.[this.you.clientId] : undefined) ??
      (me?.controlledByClientId ? this.world.cards?.[me.controlledByClientId] : undefined) ??
      this.world.cards?.[vidStr] ??
      (me?.driver ? this.world.cards?.[me.driver] : undefined) ??
      this.myHand();
    const cardsDone = (hand?.cards ?? []).filter((c) => c.status === 'done').length;

    this.evictedReason = msg.reason;
    this.ui.helpOpen = false;

    const baseSummary: RunEndSummary = {
      playerName: currentName,
      basePlayerName: baseName,
      runNumber,
      nextRunName: nextName,
      vehicleId: vidStr,
      score: finalScore,
      deliveries,
      incidents: finalIncidents,
      nearMisses: me?.nearMisses ?? 0,
      rank: resolvedRank,
      totalVehicles: Math.max(1, leaderboardRows.length),
      humanRank,
      totalHumanRuns: Math.max(1, humanRows.length),
      shift: shiftIndex(this.world.t) + 1,
      day: dayIndex(this.world.t) + 1,
      bestStreak: finalBestStreak,
      onTimePct,
      ppm,
      runMode: msg.runMode,
      reason: msg.reason,
      comboBest: me?.comboBest,
      fareTrips: me?.fareTrips,
      speedyTrips: me?.speedyTrips,
      cardsDone,
      previousRunPts: previousRun?.score,
      previousRunNumber: previousRun?.runNumber,
      bestRunPts,
      rivalNext,
      aiBenchmark,
      leaderboardRows,
    };

    if (this.ui.runEnd) {
      this.ui.runEnd = {
        ...baseSummary,
        ...this.ui.runEnd,
        score: finalScore,
        deliveries,
        incidents: finalIncidents,
        bestStreak: finalBestStreak,
        runMode: msg.runMode,
        reason: msg.reason,
        cardsDone: this.ui.runEnd.cardsDone ?? cardsDone,
        leaderboardRows: this.ui.runEnd.leaderboardRows ?? leaderboardRows,
        humanRank: this.ui.runEnd.humanRank ?? humanRank,
        totalHumanRuns: this.ui.runEnd.totalHumanRuns ?? Math.max(1, humanRows.length),
        rivalNext: this.ui.runEnd.rivalNext ?? rivalNext,
        aiBenchmark: this.ui.runEnd.aiBenchmark ?? aiBenchmark,
        bestRunPts: Math.max(this.ui.runEnd.bestRunPts ?? 0, bestRunPts),
      };
    } else {
      this.ui.runEnd = baseSummary;
    }

    this.ui.runEndDismissedVid = null;
    if (vidStr.startsWith('DRV-') || me?.isPlayerVehicle) {
      this.world.vehicles = this.world.vehicles.filter((v) => v.id !== vidStr);
    }
    if (this.you) {
      this.you = { ...this.you, role: 'spectator', vid: null };
    }
    this.myVid = null;
    this.dedicatedVid = null;
    this.changed();
  }

  setBrainHealth(msg: BrainHealthMessage): void {
    this.brainHealth = msg;
    this.changed();
  }

  setPhase(info: PhaseInfo): void {
    this.phaseInfo = info;
    this.world.phase = info.phase;
    this.changed();
  }

  setConn(status: ConnStatus, text = ''): void {
    this.conn = { status, text };
    this.changed();
  }

  select(vid: string | null): void {
    this.selectedVid = vid;
    this.changed();
  }

  setA2ui(msg: A2uiScreenMessage | null): void {
    this.activeA2ui = msg;
    this.changed();
  }
}
