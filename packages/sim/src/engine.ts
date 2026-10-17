import {
  AgentContext,
  AgentDirective,
  AgentPriority,
  Archetype,
  BACKLOG_CAP,
  BASE_AI,
  BASE_FLEET,
  BLITZ_DURATION_MIN,
  BoardRow,
  Card,
  CARD_TYPE_IDS,
  CardHand,
  CardModifiers,
  CardOption,
  CardPerk,
  CardRarity,
  ContractDecision,
  ContractOption,
  CardsDecision,
  DAY_START,
  DayHistoryEntry,
  Decision,
  DecisionJournalEntry,
  DecisionMeta,
  DecisionOption,
  DecisionRequest,
  DifficultyConfig,
  DifficultyInput,
  DifficultyKey,
  DispatchParams,
  DispatchResult,
  DispatchSourceZone,
  DistrictKind,
  DriverInput,
  FareRating,
  FareResult,
  FLEET_CAP,
  getSiteTheme,
  HallEntry,
  Hazard,
  HazardDecision,
  HazardOption,
  ImmediateTaskKind,
  INCIDENT_PENALTY,
  INTERACT_REACH,
  KWH_PER_PCT,
  MAX_TIER,
  Order,
  PartialVehicleTactics,
  PeriodStats,
  Phase,
  PlayerSession,
  Point,
  RUN_CARD_GRACE_MIN,
  RunMode,
  SITES,
  SIM_VERSION,
  SimEvent,
  Slot,
  StrategyConfig,
  StrategyName,
  StratMetrics,
  Tactics,
  TacticsDecision,
  TacticsOption,
  TICK_MIN,
  TIER_STEP,
  Transfer,
  TransferOut,
  ValueSample,
  Vehicle,
  VehicleType,
  World,
  WorldSnapshotV5,
} from './types.js';
import {
  bayAt,
  buildMap,
  chargerAt,
  dropTile,
  findPath,
  floorKind,
  HWY_E,
  isBlocked,
  isHighway,
  K_DRAIN,
  K_PICK,
  K_SPEED,
  KINDS,
  kindAtTile,
  parkY,
  tierCap,
  tierFor,
} from './map.js';

export const STRATEGIES: Record<Archetype, StrategyConfig> = {
  Sprinter: {
    color: '#EA580C',
    speed: 1.3,
    respect: 0.35,
    buffer: 1,
    chargeAt: 12,
    flatPath: true,
    preemptForP0: true,
    poach: false,
    batch: 1,
    blurb: 'Fast, short buffer, cuts through picking aisles, ignores soft claims.',
  },
  Steady: {
    color: '#2563EB',
    speed: 0.9,
    respect: 1.0,
    buffer: 3,
    chargeAt: 30,
    flatPath: false,
    preemptForP0: false,
    poach: false,
    batch: 1,
    blurb: 'Respects every claim, wide buffer, finishes current work before P0.',
  },
  Batcher: {
    color: '#7C3AED',
    speed: 1.0,
    respect: 0.9,
    buffer: 2,
    chargeAt: 22,
    flatPath: false,
    preemptForP0: false,
    poach: false,
    batch: 2,
    blurb: 'Waits to carry two orders bound for the same bay.',
  },
  Opportunist: {
    color: '#CA8A04',
    speed: 1.1,
    respect: 0.7,
    buffer: 2,
    chargeAt: 20,
    flatPath: false,
    preemptForP0: true,
    poach: true,
    batch: 1,
    blurb: 'Grabs the best contract, even one another agent already claimed.',
  },
  Strategist: {
    color: '#059669',
    speed: 1.0,
    respect: 0.9,
    buffer: 2,
    chargeAt: 22,
    flatPath: false,
    preemptForP0: false,
    poach: false,
    batch: 1,
    tunable: true,
    blurb: 'Retunes its own parameters at each shift change from its metrics.',
  },
};

export const HUMAN = { color: '#0D9488', speed: 1.0 };
export const STRAT_ORDER: StrategyName[] = [
  'Sprinter',
  'Steady',
  'Batcher',
  'Opportunist',
  'Strategist',
  'Human',
];

export const BASE_SPEED: Record<VehicleType, number> = {
  counterbalance: 4.2,
  forklift: 4.2,
  reach: 3.7,
  turret: 4.6,
  pallet_jack: 4.6,
  agv: 4.6,
};

export const DIFFICULTY: Record<DifficultyKey, DifficultyConfig> = {
  calm: {
    key: 'calm',
    level: 1,
    label: 'Calm',
    demand: 1.0,
    due: 1.0,
    hazardPerHr: 3,
    hazardTtl: [2, 30],
    crash: 1.0,
    score: 1.0,
    speed: 1.15,
  },
  easy: {
    key: 'easy',
    level: 1,
    label: 'Easy',
    demand: 1.0,
    due: 1.0,
    hazardPerHr: 3,
    hazardTtl: [2, 30],
    crash: 1.0,
    score: 1.0,
    speed: 1.15,
  },
  normal: {
    key: 'normal',
    level: 2,
    label: 'Medium',
    demand: 1.3,
    due: 0.85,
    hazardPerHr: 7,
    hazardTtl: [2, 40],
    crash: 1.3,
    score: 1.35,
    speed: 1.35,
  },
  medium: {
    key: 'medium',
    level: 2,
    label: 'Medium',
    demand: 1.3,
    due: 0.85,
    hazardPerHr: 7,
    hazardTtl: [2, 40],
    crash: 1.3,
    score: 1.35,
    speed: 1.35,
  },
  surge: {
    key: 'surge',
    level: 3,
    label: 'Surge',
    demand: 1.65,
    due: 0.7,
    hazardPerHr: 12,
    hazardTtl: [3, 50],
    crash: 1.7,
    score: 1.75,
    speed: 1.6,
  },
  hard: {
    key: 'hard',
    level: 3,
    label: 'Hard',
    demand: 1.65,
    due: 0.7,
    hazardPerHr: 12,
    hazardTtl: [3, 50],
    crash: 1.7,
    score: 1.75,
    speed: 1.6,
  },
  crisis: {
    key: 'crisis',
    level: 4,
    label: 'Crisis',
    demand: 2.1,
    due: 0.6,
    hazardPerHr: 16,
    hazardTtl: [3, 55],
    crash: 2.0,
    score: 2.2,
    speed: 2.0,
  },
  turbo: {
    key: 'turbo',
    level: 4,
    label: 'Turbo',
    demand: 2.1,
    due: 0.6,
    hazardPerHr: 16,
    hazardTtl: [3, 55],
    crash: 2.0,
    score: 2.2,
    speed: 2.0,
  },
};

const LEVEL_TO_DIFF: Record<number, DifficultyKey> = {
  1: 'calm',
  2: 'normal',
  3: 'surge',
  4: 'turbo',
  5: 'turbo',
};

export function normalizeDifficulty(input: DifficultyInput | string): DifficultyKey | null {
  if (typeof input === 'number') {
    return LEVEL_TO_DIFF[input] ?? null;
  }
  if (input in DIFFICULTY) {
    return input as DifficultyKey;
  }
  return null;
}

export function diffOf(w: World): DifficultyConfig {
  return DIFFICULTY[w.difficulty] || DIFFICULTY.normal;
}

// ---------- Seeded RNG (mulberry32) ----------
export function rng(w: World): number {
  w.rngState = (w.rngState + 0x6d2b79f5) | 0;
  let t = w.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------- Time helpers ----------
export const dayIndex = (t: number): number => Math.floor(t / 1440);
export const minuteOfDay = (t: number): number => (DAY_START + Math.floor(t)) % 1440;
export const shiftIndex = (t: number): number => Math.floor(t / 480);
export const shiftName = (t: number): string => ['A', 'B', 'C'][shiftIndex(t) % 3];

export function clockText(t: number): string {
  const m = minuteOfDay(t);
  return `Day ${dayIndex(t) + 1} · ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const FLOW = 1.0;
export const HOURLY_RATE = [
  6, 6, 6, 6, 6, 6, 14, 18, 40, 42, 40, 22, 20, 22, 40, 42, 40, 20, 18, 14, 10, 8, 8, 6,
].map((r) => Math.round(r * FLOW));

export const isRushHour = (mod: number): boolean =>
  HOURLY_RATE[Math.floor(mod / 60) % 24] >= Math.round(40 * FLOW);

export function phaseText(w: World): string {
  if (w.phase === 'break') return 'Factory break';
  if (w.phase === 'winding_down') return 'Winding down for break';
  if (w.phase === 'resuming') return `Resuming in ${Math.ceil(w.resumeCountdown)}s`;
  const mod = minuteOfDay(w.t);
  if (w.t < w.rushUntil) return 'Manual rush wave';
  if (isRushHour(mod)) return 'Rush wave';
  return HOURLY_RATE[Math.floor(mod / 60) % 24] <= Math.round(10 * FLOW)
    ? 'Night lull'
    : 'Steady flow';
}

// ---------- Stats containers ----------
const emptyStrat = (): StratMetrics => ({
  shipped: 0,
  onTime: 0,
  incidents: 0,
  nearMisses: 0,
  kwh: 0,
});

const emptyStats = (): PeriodStats => ({
  shipped: 0,
  onTime: 0,
  incidents: 0,
  nearMisses: 0,
  lost: 0,
  damaged: 0,
  poaches: 0,
  byStrat: Object.fromEntries(STRAT_ORDER.map((s) => [s, emptyStrat()])) as Record<
    StrategyName,
    StratMetrics
  >,
});

// ---------- Events ----------
export function emit(
  w: World,
  type: string,
  text: string,
  extra: Record<string, unknown> = {},
): SimEvent {
  const ev: SimEvent = { t: w.t, type, text, ...extra };
  w.events.push(ev);
  if (w.events.length > 300) w.events.shift();
  w.listeners.forEach((fn) => fn(ev));
  return ev;
}

export function defaultTacticsFor(strategy: Archetype): Tactics {
  const s = STRATEGIES[strategy];
  return {
    speed: s.speed,
    respect: s.respect,
    buffer: s.buffer,
    chargeAt: s.chargeAt,
    batch: s.batch,
    flatPath: s.flatPath,
    preemptForP0: s.preemptForP0,
    poach: s.poach,
  };
}

/** Combined perk caps across all completed cards. */
export const PERK_CAPS = {
  speedMul: 1.25,
  reachBonus: 0.5,
  batteryDrainMul: 0.7,
  forkLiftMul: 1.5,
  comboFloor: 1,
} as const;
/** Trip-point bonus while a `high_roller` wild card is active (the only payout multiplier). */
export const HIGH_ROLLER_BONUS = 0.25;

/**
 * Perks from the vehicle's hand. Perks are rewards: only cards with
 * `status === 'done'` count (reading `perk`, falling back to legacy `modifiers`).
 * In Free Range (no run end) a perk lasts 180 game-min after completion.
 * Combined caps: speed ≤ 1.25×, reach ≤ +0.5, drain ≥ 0.7×. The only payout
 * multiplier is an ACTIVE `high_roller` gamble (+25%).
 */
export function getCardModifiers(w: World, v: Vehicle): CardModifiers {
  const mods: CardModifiers = {
    speedMul: 1.0,
    reachBonus: 0,
    batteryDrainMul: 1.0,
    payoutBonus: 0,
    ptsBonus: 0,
    p0Bonus: 0,
    chargeBonus: 0,
    drainMul: 1.0,
    forkLiftMul: 1.0,
    comboFloor: 0,
  };
  const key = handKey(v);
  const hand = w.cards[key] || (v.controlledByClientId ? w.cards[v.controlledByClientId] : undefined);
  if (!hand) return mods;
  let hasLegacyReach = false;
  for (const c of hand.cards) {
    if (c.type === 'high_roller') {
      if (c.status === 'active') mods.payoutBonus += HIGH_ROLLER_BONUS;
      continue;
    }
    // Legacy compatibility: cards with `modifiers` but no `perk` come from restored
    // pre-fare Firestore snapshots (and older tests). They keep their old semantics:
    // the modifier applies while active, including retired payout/pts/charge bonuses,
    // and a 0.55 reach cap. Cards with `perk` count only once done, under PERK_CAPS.
    const isLegacyModifierCard = !c.perk && Boolean(c.modifiers);
    if (c.status !== 'done' && !(isLegacyModifierCard && c.status === 'active')) continue;
    if (
      c.status === 'done' &&
      v.runMode === 'freerange' &&
      c.completedAt != null &&
      w.t - c.completedAt > 180
    ) {
      continue;
    }
    const p = c.perk ?? c.modifiers;
    if (!p) continue;
    if (p.speedMul) mods.speedMul *= p.speedMul;
    if (p.reachBonus) {
      mods.reachBonus += p.reachBonus;
      if (isLegacyModifierCard && p.reachBonus > PERK_CAPS.reachBonus) hasLegacyReach = true;
    }
    if (p.batteryDrainMul) mods.batteryDrainMul *= p.batteryDrainMul;
    if (p.drainMul) {
      mods.drainMul = (mods.drainMul ?? 1.0) * p.drainMul;
      if (!p.batteryDrainMul) mods.batteryDrainMul *= p.drainMul;
    }
    if (p.forkLiftMul) mods.forkLiftMul = (mods.forkLiftMul ?? 1) * p.forkLiftMul;
    if (p.comboFloor) mods.comboFloor = Math.max(mods.comboFloor ?? 0, p.comboFloor);
    if (isLegacyModifierCard) {
      if (p.payoutBonus) mods.payoutBonus += p.payoutBonus;
      if (p.ptsBonus) mods.ptsBonus = (mods.ptsBonus ?? 0) + p.ptsBonus;
      if (p.p0Bonus) mods.p0Bonus = (mods.p0Bonus ?? 0) + p.p0Bonus;
      if (p.chargeBonus) mods.chargeBonus = (mods.chargeBonus ?? 0) + p.chargeBonus;
    }
  }
  mods.speedMul = Math.min(PERK_CAPS.speedMul, mods.speedMul);
  mods.reachBonus = Math.min(hasLegacyReach ? 0.55 : PERK_CAPS.reachBonus, mods.reachBonus);
  mods.batteryDrainMul = Math.max(PERK_CAPS.batteryDrainMul, mods.batteryDrainMul);
  mods.drainMul = Math.max(PERK_CAPS.batteryDrainMul, mods.drainMul ?? 1);
  mods.forkLiftMul = Math.min(PERK_CAPS.forkLiftMul, mods.forkLiftMul ?? 1);
  mods.comboFloor = Math.min(PERK_CAPS.comboFloor, mods.comboFloor ?? 0);
  return mods;
}

export const getVehicleCardModifiers = getCardModifiers;

export function streakMultiplier(streak: number): number {
  if (streak >= 8) return 1.5;
  if (streak >= 5) return 1.3;
  if (streak >= 3) return 1.15;
  return 1.0;
}

// ---------- Fare core: par, rating, combo ----------
/** Combo multipliers: +1 step per Speedy/Normal trip, reset on Slow/crash/drop/skid. */
export const COMBO_STEPS = [1.0, 1.2, 1.5, 2.0] as const;
export const RATING_MUL = { speedy: 1.5, normal: 1.0, slow: 0.5 } as const;
/** actual ≤ SPEEDY_RATIO × par → Speedy; actual > SLOW_RATIO × par (or late) → Slow. */
export const SPEEDY_RATIO = 0.8;
export const SLOW_RATIO = 1.3;
/** Reference straight-line speed used for par (human forklift top speed, tiles/game-min). */
export const PAR_BASE_SPEED = 4.2;
/**
 * Overhead factor on the planner's pure travel time (acceleration, turns, yielding,
 * waits). Calibrated by `packages/sim/test/fare.test.ts` so AI agents land mostly
 * Normal with some Speedy.
 */
export const PAR_OVERHEAD = 1.35;
/** Fork lower/drop time added to the loaded-leg par (AI `dropping` timer). */
export const PAR_DROP_TIME = 0.75;
/** Battery tip for HUMAN vehicles: Speedy +3%, Normal +1%, +1% extra on a batch delivery. */
export const BATTERY_TIP = { speedy: 3, normal: 1, batch: 1 } as const;
export const TRAILER_CLOSER_PTS = 5;
/** Precision stop: brake from above this speed … */
export const PRECISION_FROM_SPEED = 4.0;
/** … to below this speed inside the reach ring, then interact. */
export const PRECISION_TO_SPEED = 0.8;
/**
 * Contract (route card) pallets are reserved for the card owner for this long
 * (game-min; 1 game-min = 1 real second at 10 Hz, so 90 = 90 real seconds).
 */
export const CONTRACT_RESERVE_MIN = 90;
/** Last Call window at the end of a run / shift (game-min; 90 real seconds). */
export const LAST_CALL_MIN = 90;
/** Active card hand limit. */
export const HAND_LIMIT = 3;
/** Chance that one offered card is a wild card. */
export const WILD_CHANCE = 0.2;

/** Bay tile nearest (Manhattan, ties by tile order) to a point; ignores live traffic so par is stable. */
function parDropTile(w: World, bayId: string, fx: number, fy: number): Point | null {
  const bay = w.map.bays.find((b) => b.id === bayId);
  if (!bay || !bay.tiles.length) return null;
  let best = bay.tiles[0];
  let bd = Infinity;
  for (const t of bay.tiles) {
    const d = Math.abs(t.x - fx) + Math.abs(t.y - fy);
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  return best;
}

/**
 * Par time (game-min) for a leg: the planner's `findPath` route timed tile by tile at
 * `PAR_BASE_SPEED × K_SPEED[floor kind]` (× difficulty speed), times `PAR_OVERHEAD`,
 * plus the fork time. Deterministic for a given map, cones and heat field.
 * Returns null when no route exists.
 */
export function parFor(
  w: World,
  from: Point,
  to: Point,
  forkTime: number = PAR_DROP_TIME,
): number | null {
  const path = findPath(w, from.x, from.y, to.x, to.y);
  if (path === null) return null;
  const diffSpeed = diffOf(w).speed ?? 1;
  let travel = 0;
  for (const p of path) {
    travel += 1 / (PAR_BASE_SPEED * diffSpeed * K_SPEED[kindAtTile(w.map, p.x, p.y)]);
  }
  return Math.round((travel * PAR_OVERHEAD + forkTime / diffSpeed) * 100) / 100;
}

/** Par for an order's loaded leg: pickup access tile → nearest tile of its bay. */
export function parLoadedFor(w: World, o: Order): number | null {
  const to = parDropTile(w, o.bay, o.slot.ax, o.slot.ay);
  if (!to) return null;
  return parFor(w, { x: o.slot.ax, y: o.slot.ay }, to, PAR_DROP_TIME);
}

/** Speed rating for a delivered pallet. Late is always Slow; no par → Normal. */
export function rateFare(actual: number, par: number | null | undefined, onTime: boolean): FareRating {
  if (!onTime) return 'slow';
  if (par == null || !(par > 0)) return 'normal';
  if (actual <= par * SPEEDY_RATIO) return 'speedy';
  if (actual > par * SLOW_RATIO) return 'slow';
  return 'normal';
}

export function comboOf(v: Vehicle): number {
  return COMBO_STEPS[Math.max(0, Math.min(COMBO_STEPS.length - 1, v.comboStep ?? 0))];
}

function setComboStep(v: Vehicle, step: number): void {
  v.comboStep = Math.max(0, Math.min(COMBO_STEPS.length - 1, step));
  v.combo = COMBO_STEPS[v.comboStep];
  v.comboBest = Math.max(v.comboBest ?? 1, v.combo);
}

function stepCombo(w: World, v: Vehicle): void {
  setComboStep(v, (v.comboStep ?? 0) + 1);
  if (v.combo === COMBO_STEPS[COMBO_STEPS.length - 1]) cardsOnComboMax(w, v);
}

/** Reset combo (Slow, crash, pallet drop, skid). Combo King perk floors the reset at 1.2×. */
export function resetCombo(w: World, v: Vehicle, reason: string): void {
  const floor = getCardModifiers(w, v).comboFloor ?? 0;
  const prev = v.comboStep ?? 0;
  if (prev <= floor) {
    setComboStep(v, prev);
    return;
  }
  setComboStep(v, floor);
  emit(w, 'combo_reset', `${v.id} combo reset (${reason}), back to ×${v.combo}`, {
    vid: v.id,
    reason,
    combo: v.combo,
  });
}

function resetFareStats(v: Vehicle): void {
  v.comboStep = 0;
  v.combo = 1;
  v.comboBest = 1;
  v.fareTrips = 0;
  v.speedyTrips = 0;
  v.fareLog = [];
  v.brakeFrom = null;
  v.precisionArmed = null;
}

export function startDriverRun(w: World, v: Vehicle, mode: RunMode = 'blitz'): void {
  v.runMode = mode;
  v.runStartedAt = mode === 'blitz' ? null : w.t;
  v.runGraceUntil = mode === 'blitz' ? Math.round((w.t + RUN_CARD_GRACE_MIN) * 10) / 10 : null;
  v.runEndsAt = null;
  v.runPts = 0;
  v.runDeliveries = 0;
  v.runOnTime = 0;
  v.runIncidents = 0;
  v.streak = 0;
  v.bestStreak = 0;
  v.runFinished = false;
  v.sPts = 0;
  v.sShipped = 0;
  resetFareStats(v);
}

export function setDriverRunMode(w: World, vOrId: Vehicle | string, mode: RunMode): void {
  const v =
    typeof vOrId === 'string'
      ? w.vehicles.find(
          (x) =>
            x.id === vOrId ||
            x.controlledByClientId === vOrId ||
            x.ownerClientId === vOrId ||
            x.driver === vOrId,
        )
      : vOrId;
  if (!v) return;
  if (v.runMode === mode && !v.runFinished) return;
  v.runMode = mode;
  if (mode === 'freerange') {
    v.runEndsAt = null;
    v.runGraceUntil = null;
    v.runFinished = false;
  } else {
    v.runStartedAt = null;
    v.runGraceUntil = Math.round((w.t + RUN_CARD_GRACE_MIN) * 10) / 10;
    v.runEndsAt = null;
    v.runFinished = false;
  }
}

export function computeDriverPpm(
  wOrV: Pick<World, 't'> | Vehicle,
  vOrT: Vehicle | number,
): number {
  const isVFirst = typeof vOrT === 'number';
  const v = (isVFirst ? wOrV : vOrT) as Vehicle;
  const nowT = isVFirst ? (vOrT as number) : (wOrV as Pick<World, 't'>).t;
  const start = v.runStartedAt ?? 0;
  const end = v.runFinished && (v.runEndsAt ?? 0) > start ? (v.runEndsAt ?? nowT) : nowT;
  const elapsedSimMin = Math.max(1.0, end - start);
  const realMinutes = elapsedSimMin / 60.0;
  const shipped = v.runDeliveries ?? v.sShipped ?? 0;
  return Math.round((shipped / Math.max(0.25, realMinutes)) * 10) / 10;
}

export function computeDriverOnTimePct(v: Vehicle): number {
  const total = v.runDeliveries ?? 0;
  if (total <= 0) return 100;
  return Math.round(((v.runOnTime ?? 0) / total) * 100);
}

export function isManualHuman(v: Vehicle): boolean {
  return Boolean(v.human && !v.autopilot);
}

export function isAutopilotDriven(v: Vehicle): boolean {
  return Boolean(!v.human || v.autopilot);
}

export function policy(w: World, v: Vehicle): Tactics & { color: string } {
  const mods = getCardModifiers(w, v);
  if (isManualHuman(v)) {
    return {
      color: HUMAN.color,
      speed: HUMAN.speed * mods.speedMul,
      respect: 1,
      buffer: 2,
      chargeAt: 0,
      batch: 2,
      flatPath: true,
      preemptForP0: false,
      poach: false,
    };
  }
  const base = v.tactics || defaultTacticsFor(v.strategy);
  return {
    ...base,
    color: v.human ? HUMAN.color : STRATEGIES[v.strategy].color,
    speed: base.speed * mods.speedMul,
  };
}

export const stratOf = (v: Vehicle): StrategyName => (v.human ? 'Human' : v.strategy);
export const capacity = (v: Vehicle): number =>
  isManualHuman(v) ? 2 : v.tactics?.batch || STRATEGIES[v.strategy].batch || 1;

export function vehicleReach(w: World, v: Vehicle): number {
  return INTERACT_REACH + getCardModifiers(w, v).reachBonus;
}

// ---------- Vehicles ----------
function vehicleObj(
  w: World,
  id: string,
  type: VehicleType,
  strategy: Archetype,
  tx: number,
  ty: number,
): Vehicle {
  return {
    id,
    type,
    strategy,
    human: false,
    autopilot: false,
    directive: null,
    lastBrainDecision: null,
    extra: false,
    isPlayerVehicle: false,
    ownerClientId: null,
    controlledByClientId: null,
    playerOpaqueId: null,
    isBot: false,
    px: tx + 0.5,
    py: ty + 0.5,
    angle: 0,
    tile: { x: tx, y: ty },
    moveTo: null,
    path: [],
    state: 'idle',
    orders: [],
    cargo: [],
    battery: 55 + rng(w) * 40,
    fork: 0.15,
    forkTarget: 0.15,
    timer: 0,
    wait: 0,
    stuck: 0,
    waitKey: null,
    waitRespect: true,
    stunnedUntil: 0,
    idleSince: 0,
    energySince: 0,
    deliveries: 0,
    incidents: 0,
    nearMisses: 0,
    skids: 0,
    palletDrops: 0,
    chargerIdx: -1,
    speedNow: 0,
    braking: false,
    humanCharging: false,
    msg: '',
    driver: null,
    input: { up: false, down: false, left: false, right: false, boost: false },
    sPts: 0,
    sShipped: 0,
    runMode: 'blitz',
    runStartedAt: w.t,
    runEndsAt: Math.round((w.t + RUN_CARD_GRACE_MIN + BLITZ_DURATION_MIN) * 10) / 10,
    runGraceUntil: Math.round((w.t + RUN_CARD_GRACE_MIN) * 10) / 10,
    runPts: 0,
    runDeliveries: 0,
    runOnTime: 0,
    runIncidents: 0,
    streak: 0,
    bestStreak: 0,
    comboStep: 0,
    combo: 1,
    comboBest: 1,
    fareTrips: 0,
    speedyTrips: 0,
    fareLog: [],
    brakeFrom: null,
    precisionArmed: null,
    runFinished: false,
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
  };
}

function makeVehicles(w: World, count = BASE_AI): Vehicle[] {
  const spec: Array<[string, VehicleType, Archetype]> = [
    ['FL-01', 'counterbalance', 'Sprinter'],
    ['FL-02', 'counterbalance', 'Sprinter'],
    ['FL-03', 'counterbalance', 'Steady'],
    ['FL-04', 'counterbalance', 'Steady'],
    ['RT-05', 'reach', 'Batcher'],
    ['RT-06', 'reach', 'Batcher'],
    ['TU-07', 'turret', 'Opportunist'],
    ['TU-08', 'turret', 'Opportunist'],
    ['FL-09', 'counterbalance', 'Strategist'],
    ['FL-10', 'counterbalance', 'Strategist'],
    ['FL-11', 'counterbalance', 'Sprinter'],
    ['FL-12', 'counterbalance', 'Sprinter'],
    ['FL-13', 'counterbalance', 'Steady'],
    ['FL-14', 'counterbalance', 'Steady'],
    ['RT-15', 'reach', 'Batcher'],
    ['RT-16', 'reach', 'Batcher'],
    ['TU-17', 'turret', 'Opportunist'],
    ['TU-18', 'turret', 'Opportunist'],
    ['FL-19', 'counterbalance', 'Strategist'],
    ['FL-20', 'counterbalance', 'Strategist'],
  ];
  const SPAWN_Y = [2, 3, 11, 12, 20, 21, 29, 30, 38, 39];
  const slice = spec.slice(0, Math.min(count, spec.length));
  return slice.map(([id, type, strategy], i) =>
    vehicleObj(w, id, type, strategy, 6 + Math.floor(i * 2.6), SPAWN_Y[i % 10]),
  );
}

const ADD_TYPES: VehicleType[] = [
  'counterbalance',
  'counterbalance',
  'reach',
  'turret',
  'counterbalance',
];
const ADD_STRATS: Archetype[] = ['Sprinter', 'Steady', 'Batcher', 'Opportunist', 'Strategist'];
const TYPE_PREFIX: Record<VehicleType, string> = {
  counterbalance: 'FL',
  forklift: 'FL',
  reach: 'RT',
  turret: 'TU',
  pallet_jack: 'PJ',
  agv: 'AGV',
};

function findFreeHighwaySpot(w: World, seedOffset = 0): Point | null {
  const taken = new Set(
    w.vehicles.flatMap((q) => {
      const keys = [`${q.tile.x},${q.tile.y}`];
      if (q.moveTo) keys.push(`${q.moveTo.x},${q.moveTo.y}`);
      return keys;
    }),
  );
  const candidateY: number[] = [];
  for (const h of w.map.hwyY) {
    candidateY.push(h, h + 1);
  }
  for (const y of candidateY) {
    if (y < 1 || y > w.map.h - 2) continue;
    for (let x = 6 + (seedOffset % 7); x < w.map.w - 6; x += 2) {
      if (!taken.has(`${x},${y}`) && !isBlocked(w, x, y) && !hazardAt(w, x, y)) {
        return { x, y };
      }
    }
    for (let x = 6; x < w.map.w - 6; x++) {
      if (!taken.has(`${x},${y}`) && !isBlocked(w, x, y) && !hazardAt(w, x, y)) {
        return { x, y };
      }
    }
  }
  for (let y = 2; y < w.map.h - 2; y++) {
    for (let x = 6; x < w.map.w - 6; x++) {
      if (!isBlocked(w, x, y)) {
        return { x, y };
      }
    }
  }
  return null;
}

export function checkFacilityExpansion(w: World): boolean {
  const t = tierFor(w.vehicles.length);
  if (t <= w.tier) return false;
  w.tier = t;
  w.map = buildMap(t, w.siteId);
  const heat = new Float32Array(w.map.w * w.map.h);
  heat.set(w.heat.subarray(0, Math.min(w.heat.length, heat.length)));
  w.heat = heat;
  w.map.bays.forEach((b) => {
    if (!w.bays.some((x) => x.id === b.id)) {
      w.bays.push({
        id: b.id,
        load: 0,
        cap: 8,
        departUntil: 0,
        isTransferBay: b.isTransferBay,
        label: b.label,
      });
    }
  });
  emit(
    w,
    'expand',
    `Facility expanded to tier ${t}: ${w.map.h} rows, ${w.map.bays.length} bays, ${w.map.chargers.length} chargers for ${w.vehicles.length} vehicles.`,
    { tier: t },
  );
  return true;
}

export const growCheck = checkFacilityExpansion;

export function compactFacilityIfNeeded(w: World): boolean {
  if (w.phase !== 'break') return false;
  const needed = tierFor(w.vehicles.length);
  if (needed >= w.tier) return false;
  const nextMap = buildMap(needed, w.siteId);
  const maxY = nextMap.h - 2;

  // Relocate any orders or vehicles that were in southern expanded wings
  w.orders = w.orders.filter((o) => o.slot.ay <= maxY && nextMap.bays.some((b) => b.id === o.bay));
  w.cones.forEach((k) => {
    const [, y] = k.split(',').map(Number);
    if (y > maxY) w.cones.delete(k);
  });
  w.spills.splice(0, w.spills.length, ...w.spills.filter((h) => h.y <= maxY));

  w.tier = needed;
  w.map = nextMap;
  w.bays = w.bays.filter((b) => nextMap.bays.some((nb) => nb.id === b.id));
  const heat = new Float32Array(nextMap.w * nextMap.h);
  heat.set(w.heat.subarray(0, heat.length));
  w.heat = heat;

  const validOrderSet = new Set(w.orders);
  for (const v of w.vehicles) {
    v.orders = v.orders.filter((o) => validOrderSet.has(o) || v.cargo.includes(o));
    if (v.target?.order && !validOrderSet.has(v.target.order)) {
      v.target = null;
      v.path = [];
    }
    if (v.tile.y > maxY) {
      const spot = findFreeHighwaySpot(w, 1) || { x: 6, y: 2 };
      v.tile = { ...spot };
      v.px = spot.x + 0.5;
      v.py = spot.y + 0.5;
      v.moveTo = null;
      v.path = [];
      v.target = null;
    }
  }

  emit(
    w,
    'compact',
    `Facility compacted to tier ${needed} during factory break (${w.vehicles.length} vehicles).`,
    { tier: needed },
  );
  return true;
}

export function addVehicle(
  w: World,
  opts: { silent?: boolean; type?: VehicleType; strategy?: Archetype } = {},
): Vehicle | null {
  if (w.vehicles.length >= FLEET_CAP) return null;
  // Pre-expand if adding this vehicle crosses a tier boundary and current floor is tight
  const nextTier = tierFor(w.vehicles.length + 1);
  if (nextTier > w.tier) {
    w.tier = nextTier;
    w.map = buildMap(nextTier, w.siteId);
    const heat = new Float32Array(w.map.w * w.map.h);
    heat.set(w.heat.subarray(0, Math.min(w.heat.length, heat.length)));
    w.heat = heat;
    w.map.bays.forEach((b) => {
      if (!w.bays.some((x) => x.id === b.id)) {
        w.bays.push({
          id: b.id,
          load: 0,
          cap: 8,
          departUntil: 0,
          isTransferBay: b.isTransferBay,
          label: b.label,
        });
      }
    });
    if (!opts.silent) {
      emit(
        w,
        'expand',
        `Facility expanded to tier ${nextTier}: ${w.map.h} rows, ${w.map.bays.length} bays, ${w.map.chargers.length} chargers for ${w.vehicles.length + 1} vehicles.`,
        { tier: nextTier },
      );
    }
  }

  const k = w.vehicleSeq;
  const type = opts.type || ADD_TYPES[k % ADD_TYPES.length];
  const strategy = opts.strategy || ADD_STRATS[k % ADD_STRATS.length];
  const spot = findFreeHighwaySpot(w, k);
  if (!spot) return null;
  w.vehicleSeq++;
  const prefix = TYPE_PREFIX[type] || 'FL';
  const v = vehicleObj(
    w,
    `${prefix}-${String(w.vehicleSeq).padStart(2, '0')}`,
    type,
    strategy,
    spot.x,
    spot.y,
  );
  v.extra = true;
  w.vehicles.push(v);
  if (!opts.silent) {
    emit(w, 'fleet', `${v.id} (${strategy}) joined the fleet: ${w.vehicles.length} vehicles.`, {
      vid: v.id,
    });
    checkFacilityExpansion(w);
  }
  return v;
}

export function removeVehicle(w: World): Vehicle | null {
  for (let i = w.vehicles.length - 1; i >= 0; i--) {
    const v = w.vehicles[i];
    if (
      !v.extra ||
      v.isPlayerVehicle ||
      v.human ||
      v.cargo.length ||
      v.orders.length ||
      v.moveTo ||
      v.state === 'charging'
    ) {
      continue;
    }
    w.vehicles.splice(i, 1);
    w.pendingDecisions = w.pendingDecisions.filter((r) => r.agentId !== v.id);
    emit(w, 'fleet', `${v.id} left the fleet: ${w.vehicles.length} vehicles.`);
    return v;
  }
  return null;
}

export function extractRunNumber(name: string): number | null {
  const m = /\bRun\s+(\d+)$/i.exec(name.trim());
  return m ? Number.parseInt(m[1], 10) : null;
}

// ---------- Multiplayer Player Vehicles & Take-the-Wheel ----------
export function spawnPlayerVehicle(
  w: World,
  playerOrClientId:
    | { clientId: string; name: string; isBot?: boolean; type?: VehicleType; mode?: RunMode }
    | string,
  maybeName?: string,
  maybeOpts?: { isBot?: boolean; type?: VehicleType; mode?: RunMode } | RunMode,
): Vehicle | null {
  const optsObj = typeof maybeOpts === 'string' ? { mode: maybeOpts } : maybeOpts;
  const player =
    typeof playerOrClientId === 'string'
      ? {
          clientId: playerOrClientId,
          name: maybeName || playerOrClientId,
          isBot: optsObj?.isBot,
          type: optsObj?.type,
          mode: optsObj?.mode,
        }
      : playerOrClientId;

  const existing = w.players.get(player.clientId);
  const previousOpaqueId = existing?.opaqueId;
  const previousDedicatedVid = existing?.dedicatedVehicleId;
  if (existing && existing.dedicatedVehicleId) {
    const ev = w.vehicles.find((x) => x.id === existing.dedicatedVehicleId);
    if (ev) {
      const nextRun = extractRunNumber(player.name);
      const prevRun = extractRunNumber(existing.name);
      const isNewRun = nextRun !== null && nextRun !== prevRun;
      if (ev.battery <= 0 || ev.runFinished || isNewRun) {
        removePlayerVehicle(w, player.clientId);
      } else {
        ev.driver = player.name;
        existing.name = player.name;
        if (player.mode) {
          setDriverRunMode(w, ev, player.mode);
        }
        return ev;
      }
    }
  }
  if (w.vehicles.length >= FLEET_CAP) return null;

  const nextTier = tierFor(w.vehicles.length + 1);
  if (nextTier > w.tier) {
    w.tier = nextTier;
    w.map = buildMap(nextTier, w.siteId);
    const heat = new Float32Array(w.map.w * w.map.h);
    heat.set(w.heat.subarray(0, Math.min(w.heat.length, heat.length)));
    w.heat = heat;
    w.map.bays.forEach((b) => {
      if (!w.bays.some((x) => x.id === b.id)) {
        w.bays.push({
          id: b.id,
          load: 0,
          cap: 8,
          departUntil: 0,
          isTransferBay: b.isTransferBay,
          label: b.label,
        });
      }
    });
    emit(
      w,
      'expand',
      `Facility expanded to tier ${nextTier}: ${w.map.h} rows, ${w.map.bays.length} bays, ${w.map.chargers.length} chargers for ${w.vehicles.length + 1} vehicles.`,
      { tier: nextTier },
    );
  }

  const opaqueId = previousOpaqueId || `P${++w.nextPlayerSeq}`;
  const seqNum =
    previousOpaqueId ? Number.parseInt(previousOpaqueId.slice(1), 10) || w.nextPlayerSeq : w.nextPlayerSeq;
  const spot = findFreeHighwaySpot(w, seqNum);
  if (!spot) return null;

  w.vehicleSeq++;
  const type: VehicleType = player.type || 'counterbalance';
  const id = previousDedicatedVid || `DRV-${String(seqNum).padStart(2, '0')}`;
  const v = vehicleObj(w, id, type, 'Steady', spot.x, spot.y);
  v.battery = 100;
  v.human = true;
  v.extra = true;
  v.isPlayerVehicle = true;
  v.ownerClientId = player.clientId;
  v.controlledByClientId = player.clientId;
  v.playerOpaqueId = opaqueId;
  v.isBot = !!player.isBot;
  v.driver = player.name;
  v.state = 'driven';
  startDriverRun(w, v, player.mode ?? 'blitz');
  w.vehicles.push(v);

  w.players.set(player.clientId, {
    clientId: player.clientId,
    name: player.name,
    opaqueId,
    dedicatedVehicleId: v.id,
    controlledVehicleId: v.id,
    isBot: !!player.isBot,
  });

  checkFacilityExpansion(w);
  dealCards(w, player.clientId);
  emit(w, 'drive', `${player.name} joined in ${v.id}.`, {
    vid: v.id,
    clientId: player.clientId,
  });
  return v;
}

export function removePlayerVehicle(w: World, clientId: string): void {
  const session = w.players.get(clientId);
  if (session && session.controlledVehicleId && session.controlledVehicleId !== session.dedicatedVehicleId) {
    releaseWheel(w, clientId);
  }
  const idx = w.vehicles.findIndex(
    (v) => v.ownerClientId === clientId || (session && v.id === session.dedicatedVehicleId),
  );
  if (idx >= 0) {
    const v = w.vehicles[idx];
    for (const o of [...v.cargo, ...v.orders]) {
      if (o.state !== 'done') {
        o.state = 'open';
        o.claimant = null;
      }
    }
    w.vehicles.splice(idx, 1);
    emit(w, 'fleet', `${v.id} removed as driver disconnected (${w.vehicles.length} vehicles).`, {
      vid: v.id,
      clientId,
    });
  }
  delete w.difficultyVotes[clientId];
  delete w.cards[clientId];
  w.players.delete(clientId);
}

/**
 * Supports:
 * - `takeWheel(w, clientId, name, vid)`
 * - `takeWheel(w, vid, clientId, name)`
 * - `takeWheel(w, vid, player = 'you')`
 */
export function takeWheel(
  w: World,
  arg1: string,
  arg2 = 'you',
  arg3?: string,
): string | null {
  const isFourArg = typeof arg3 === 'string';
  const arg1IsVid = isFourArg && w.vehicles.some((x) => x.id === arg1);
  const clientId = isFourArg ? (arg1IsVid ? arg2 : arg1) : arg2;
  const name = isFourArg ? (arg1IsVid ? arg3 : arg2) : arg2;
  const vid = isFourArg ? (arg1IsVid ? arg1 : arg3) : arg1;

  const v = w.vehicles.find((x) => x.id === vid);
  if (!v) return 'Unknown vehicle.';
  if (v.human) {
    if (v.controlledByClientId === clientId || v.driver === name) return null;
    return `${v.id} is being driven by ${v.driver}.`;
  }

  let session = w.players.get(clientId);
  if (!session) {
    session = {
      clientId,
      name,
      opaqueId: `P${++w.nextPlayerSeq}`,
      dedicatedVehicleId: null,
      controlledVehicleId: null,
      isBot: false,
    };
    w.players.set(clientId, session);
  } else {
    session.name = name;
  }

  // Release any other AI vehicle currently driven by this player
  w.vehicles
    .filter(
      (x) =>
        x.human &&
        !x.isPlayerVehicle &&
        (x.controlledByClientId === clientId || x.driver === name),
    )
    .forEach((x) => release(w, x.id));

  // If the player has a dedicated vehicle, stop its movement while they drive the AI vehicle
  let inheritedMode: RunMode = 'blitz';
  if (session.dedicatedVehicleId && session.dedicatedVehicleId !== v.id) {
    const dv = w.vehicles.find((x) => x.id === session!.dedicatedVehicleId);
    if (dv) {
      dv.input = { up: false, down: false, left: false, right: false, boost: false };
      dv.speedNow = 0;
      if (dv.runMode) inheritedMode = dv.runMode;
    }
  }

  if (v.chargerIdx >= 0) v.chargerIdx = -1;
  v.human = true;
  v.autopilot = false;
  v.directive = null;
  v.driver = name;
  v.controlledByClientId = clientId;
  v.playerOpaqueId = session.opaqueId;
  v.input = { up: false, down: false, left: false, right: false, boost: false };
  v.state = 'driven';
  v.path = [];
  v.target = null;
  v.speedNow = 0;
  v.msg = '';
  if (!v.runMode) {
    startDriverRun(w, v, inheritedMode);
  } else {
    setDriverRunMode(w, v, inheritedMode);
  }
  if (v.moveTo) {
    v.tile = { x: Math.floor(v.px), y: Math.floor(v.py) };
    v.moveTo = null;
  }
  // Pause AI brain requests for this vehicle while manually driven
  w.pendingDecisions = w.pendingDecisions.filter((r) => r.agentId !== v.id);
  session.controlledVehicleId = v.id;

  emit(
    w,
    'drive',
    `${name === 'you' ? 'You' : name} took the wheel of ${v.id}. Its ${v.orders.length} order(s) are now yours.`,
    { vid: v.id, clientId },
  );
  // Hands are keyed by clientId only (never by display name, which is not unique).
  dealCards(w, clientId);
  return null;
}

export function release(w: World, vid: string): void {
  const v = w.vehicles.find((x) => x.id === vid);
  if (!v || !v.human) return;
  if (v.isPlayerVehicle) {
    v.autopilot = false;
    v.directive = null;
    v.input = { up: false, down: false, left: false, right: false, boost: false };
    v.speedNow = 0;
    return;
  }
  const clientId = v.controlledByClientId;
  v.human = false;
  v.autopilot = false;
  v.directive = null;
  v.driver = null;
  v.controlledByClientId = null;
  v.playerOpaqueId = null;
  v.input = { up: false, down: false, left: false, right: false, boost: false };
  v.speedNow = 0;
  v.humanCharging = false;
  v.tile = { x: Math.floor(v.px), y: Math.floor(v.py) };
  v.moveTo = { ...v.tile };
  v.orders.forEach((o) => {
    if (o.state !== 'picked') o.state = 'claimed';
  });
  if (clientId) {
    const session = w.players.get(clientId);
    if (session) {
      session.controlledVehicleId = session.dedicatedVehicleId;
    }
  }
  nextLeg(w, v);
  emit(w, 'drive', `${v.id} handed back to its ${v.strategy} AI.`, { vid: v.id });
}

export function releaseWheel(w: World, clientIdOrVid: string): void {
  const session = w.players.get(clientIdOrVid);
  if (session && session.controlledVehicleId) {
    release(w, session.controlledVehicleId);
    return;
  }
  const byClient = w.vehicles.find(
    (v) => v.human && !v.isPlayerVehicle && (v.controlledByClientId === clientIdOrVid || v.driver === clientIdOrVid),
  );
  if (byClient) {
    release(w, byClient.id);
    return;
  }
  release(w, clientIdOrVid);
}

export function setVehicleAutopilot(
  w: World,
  vehicleOrId: Vehicle | string,
  enabled: boolean,
  reason?: string,
): boolean {
  const v =
    typeof vehicleOrId === 'string'
      ? w.vehicles.find((x) => x.id === vehicleOrId)
      : vehicleOrId;
  if (!v) return false;
  const next = Boolean(enabled);
  const changed = Boolean(v.autopilot) !== next;
  v.autopilot = next;
  v.input = { up: false, down: false, left: false, right: false, boost: false };
  v.speedNow = 0;
  v.humanCharging = false;

  if (next) {
    v.tile = { x: Math.floor(v.px), y: Math.floor(v.py) };
    v.moveTo = null;
    v.wait = 0;
    v.waitKey = null;
    v.hold = null;
    v.orders.forEach((o) => {
      if (o.state !== 'picked' && o.state !== 'done') {
        o.state = 'claimed';
        o.claimant = v.id;
      }
    });
    if (v.state === 'driven' || v.state === 'idle' || !v.path.length) {
      nextLeg(w, v);
    }
    if (changed) {
      emit(
        w,
        'copilot',
        reason || `${v.driver || v.id} engaged Co-Pilot (${v.strategy}) on ${v.id}.`,
        { vid: v.id, autopilot: true },
      );
    }
  } else {
    v.tile = { x: Math.floor(v.px), y: Math.floor(v.py) };
    v.moveTo = null;
    v.path = [];
    v.target = null;
    v.hold = null;
    if (v.human) {
      v.state = 'driven';
    }
    w.pendingDecisions = w.pendingDecisions.filter((r) => r.agentId !== v.id);
    if (changed) {
      emit(
        w,
        'drive',
        reason || `${v.driver || v.id} resumed manual control of ${v.id}.`,
        { vid: v.id, autopilot: false },
      );
    }
  }
  return true;
}

// ---------- Orders, Transfers & Market ----------
export const manhattan = (ax: number, ay: number, bx: number, by: number): number =>
  Math.abs(ax - bx) + Math.abs(ay - by);

export const etaTo = (w: World, v: Vehicle, x: number, y: number): number =>
  manhattan(v.tile.x, v.tile.y, x, y) / (BASE_SPEED[v.type] * policy(w, v).speed);

function siblingSites(siteId: string): string[] {
  const list = SITES.filter((s) => s !== siteId);
  return list.length ? list : ['slc-2', 'phx-3', 'abq-4'];
}

export interface PostOrderOptions {
  p0?: boolean;
  card?: string | null;
  zone?: string;
  bayId?: string;
  isTransfer?: boolean;
  destSite?: string;
  value?: number;
  sku?: string;
  force?: boolean;
}

export function postOrder(w: World, opts: PostOrderOptions = {}): Order | null {
  if (w.phase !== 'running' && !opts.p0 && !opts.card && !opts.isTransfer && !opts.force) return null;
  const active = w.orders.filter((o) => o.state === 'open' || o.state === 'claimed').length;
  if (
    active >= BACKLOG_CAP * Math.max(1, w.vehicles.length / BASE_AI) &&
    !opts.p0 &&
    !opts.card &&
    !opts.isTransfer &&
    !opts.force
  ) {
    w.day.lost++;
    w.totals.lost++;
    return null;
  }
  const used = new Set(w.orders.map((o) => o.slot.key));
  const free = w.map.slots.filter(
    (s) => !used.has(s.key) && !w.cones.has(s.key) && (!opts.zone || s.zone === opts.zone),
  );
  if (!free.length) {
    w.day.lost++;
    w.totals.lost++;
    return null;
  }
  const slot = free[Math.floor(rng(w) * free.length)];

  // ~20% of normal outbound orders become cross-site transfers targeting an East transfer bay ('→ NET')
  const rollTransfer =
    opts.bayId === 'RET'
      ? false
      : opts.isTransfer !== undefined
        ? opts.isTransfer
        : !opts.bayId && !opts.card && rng(w) < 0.2;

  const transferBays = w.map.bays.filter((b) => b.isTransferBay);
  const regularBays = w.map.bays.filter((b) => !b.isTransferBay && b.id !== 'RET');

  let bay = opts.bayId ? w.map.bays.find((b) => b.id === opts.bayId) : undefined;
  let destSite: string | null = opts.destSite || null;
  let isTransfer = false;

  if (!bay) {
    if (rollTransfer && transferBays.length) {
      bay = transferBays[Math.floor(rng(w) * transferBays.length)];
      const siblings = siblingSites(w.siteId);
      destSite = destSite || siblings[Math.floor(rng(w) * siblings.length)];
      isTransfer = true;
    } else {
      const pool = regularBays.length ? regularBays : w.map.bays;
      bay = pool[Math.floor(rng(w) * pool.length)];
    }
  } else if (bay.id === 'RET') {
    isTransfer = false;
    destSite = null;
  } else if (bay.isTransferBay || opts.destSite || opts.isTransfer) {
    isTransfer = true;
    const siblings = siblingSites(w.siteId);
    destSite = destSite || siblings[Math.floor(rng(w) * siblings.length)];
  }

  const rush = isRushHour(minuteOfDay(w.t)) || w.t < w.rushUntil;
  const id = ++w.nextOrderId;
  const prefix = getSiteTheme(w.siteId).skuPrefix;
  const sku = opts.sku || `${prefix}-${slot.zone}-${String(id).slice(-3)}`;
  const o: Order = {
    id,
    sku,
    slot,
    bay: bay.id,
    p0: !!opts.p0,
    value: opts.value ?? (opts.p0 ? 40 : 10),
    created: w.t,
    due:
      w.t +
      (opts.p0 ? 30 : opts.card ? 100 : (rush ? 80 : 120) * diffOf(w).due),
    state: 'open',
    claimant: null,
    card: opts.card || null,
    isTransfer,
    destSite,
    fromSite: null,
    transferId: null,
  };
  w.orders.push(o);
  if (o.p0) {
    emit(w, 'p0', `P0 #${o.id} posted: rack ${slot.rackId} → bay ${o.bay}, due in 30 min`);
    w.vehicles.forEach((v) => {
      if (isManualHuman(v) || v.cargo.length || v.state !== 'toPick' || !policy(w, v).preemptForP0) return;
      v.orders.forEach((x) => {
        x.state = 'open';
        x.claimant = null;
      });
      v.orders = [];
      v.state = 'idle';
      v.path = [];
      v.idleSince = w.t;
      emit(w, 'preempt', `${v.id} (${v.strategy}) dropped its contract to chase P0 #${o.id}`, {
        vid: v.id,
      });
    });
  }
  return o;
}

export function receiveTransfer(w: World, t: Transfer): Order | null {
  if (!t || !t.id) return null;
  if (w.receivedTransferIds.has(t.id)) return null;
  w.receivedTransferIds.add(t.id);

  // Pick a West dock with a free pickup tile
  const usedKeys = new Set(w.orders.map((o) => o.slot.key));
  const dock =
    w.map.westDocks.find((dk) => !usedKeys.has(`2,${dk.y}`)) || w.map.westDocks[0];
  const slot: Slot = {
    key: `2,${dock.y}`,
    rackId: dock.id,
    zone: 'A',
    rx: dock.x,
    ry: dock.y,
    ax: 2,
    ay: dock.y,
  };
  const regularBays = w.map.bays.filter((b) => !b.isTransferBay && b.id !== 'RET');
  const bayPool = regularBays.length ? regularBays : w.map.bays;
  const bay = bayPool[Math.floor(rng(w) * bayPool.length)];
  const id = ++w.nextOrderId;
  const order: Order = {
    id,
    sku: t.sku || `XFER-${t.fromSite.toUpperCase()}-${t.orderRef}`,
    slot,
    bay: bay.id,
    p0: false,
    value: (t.value || 10) + 5, // +5 network transfer bonus
    created: w.t,
    due: w.t + 120 * diffOf(w).due,
    state: 'open',
    claimant: null,
    card: null,
    isTransfer: false,
    destSite: null,
    fromSite: t.fromSite,
    transferId: t.id,
  };
  w.orders.push(order);
  w.totals.transfersIn++;
  emit(
    w,
    'transfer_in',
    `Inbound transfer ${t.id} from ${t.fromSite.toUpperCase()} docked at ${dock.id} (#${order.id}, worth ${order.value} pts).`,
    { transferId: t.id, fromSite: t.fromSite, orderId: order.id },
  );
  return order;
}

export function assign(w: World, v: Vehicle, orders: Order[]): void {
  orders.forEach((o) => {
    o.state = 'claimed';
    o.claimant = v.id;
    if (!v.orders.includes(o)) v.orders.push(o);
  });
  if (v.state === 'idle' || (!v.cargo.length && v.state !== 'picking')) {
    nextLeg(w, v);
  }
}

export function scoreOrder(w: World, v: Vehicle, o: Order, refPoint: Point = v.tile): number {
  const dist = manhattan(refPoint.x, refPoint.y, o.slot.ax, o.slot.ay);
  const slack = Math.round((o.due - w.t) * 10) / 10;
  let urg = o.p0 ? 3 : slack < 30 ? 1.6 : 1;
  let bonus = 0;

  if (v.human) {
    const mine = new Set([
      ...activeCardIds(w, v.controlledByClientId || null),
      ...activeCardIds(w, v.driver),
    ]);
    if (o.card && mine.has(o.card)) bonus += 30;
  }

  const dir = v.directive;
  if (dir) {
    const oZone = o.slot.zone.toUpperCase();
    const oBay = o.bay.toUpperCase();
    const matchesZoneToken = (token: string): boolean => {
      const z = token.toUpperCase();
      if (z === oZone) return true;
      if (z === 'HAZ' && oZone === 'Z') return true;
      if (z === 'COLD' && oZone === 'W') return true;
      if (z === 'BULK' && oZone === 'X') return true;
      if (z === 'HIGH' && oZone === 'U') return true;
      return false;
    };

    if (dir.preferredZones?.length && dir.preferredZones.some(matchesZoneToken)) {
      bonus += 45;
    }
    if (dir.avoidZones?.length && dir.avoidZones.some(matchesZoneToken)) {
      bonus -= 60;
    }
    if (dir.preferredBays?.length && dir.preferredBays.some((b) => b.toUpperCase() === oBay)) {
      bonus += 40;
    }
    if (dir.priority === 'p0_first' && o.p0) {
      urg *= 2.2;
      bonus += 35;
    } else if (dir.priority === 'high_value') {
      bonus += o.value * 1.4;
    } else if (dir.priority === 'nearest') {
      bonus += Math.max(0, 40 - dist * 1.6);
    } else if (dir.priority === 'transfers' && (o.isTransfer || o.fromSite || o.destSite)) {
      bonus += 45;
    } else if (dir.priority === 'zone_focus' && dir.preferredZones?.some(matchesZoneToken)) {
      bonus += 30;
    } else if (dir.priority === 'bay_focus' && dir.preferredBays?.some((b) => b.toUpperCase() === oBay)) {
      bonus += 30;
    }
  }

  return (o.value * urg + bonus) / (dist / BASE_SPEED[v.type] + 2);
}

export interface RawAgentDirectiveInput {
  autopilot?: boolean;
  strategy?: Archetype;
  persona?: Archetype;
  priority?: AgentPriority;
  focusZones?: string[];
  focusBays?: string[];
  preferredZone?: string;
  preferredBay?: string;
  preferredZones?: string[];
  preferredBays?: string[];
  avoidZones?: string[];
  tactics?: PartialVehicleTactics;
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

export function applyAgentDirective(
  w: World,
  vehicleOrId: Vehicle | string,
  rawDirective: RawAgentDirectiveInput,
): AgentDirective | null {
  const v =
    typeof vehicleOrId === 'string'
      ? w.vehicles.find((x) => x.id === vehicleOrId)
      : vehicleOrId;
  if (!v) return null;

  if (rawDirective.autopilot === false) {
    setVehicleAutopilot(w, v, false, `Manual control engaged on ${v.id}`);
  } else if (v.human && !v.autopilot) {
    setVehicleAutopilot(w, v, true, `Co-Pilot engaged on ${v.id}`);
  }

  const chosenStrategy = rawDirective.strategy ?? rawDirective.persona;
  if (chosenStrategy && STRATEGIES[chosenStrategy]) {
    v.strategy = chosenStrategy;
    v.tactics = {
      ...defaultTacticsFor(v.strategy),
      ...v.tactics,
      speed: STRATEGIES[v.strategy].speed,
      respect: STRATEGIES[v.strategy].respect,
      buffer: STRATEGIES[v.strategy].buffer,
      chargeAt: STRATEGIES[v.strategy].chargeAt,
      batch: STRATEGIES[v.strategy].batch,
      flatPath: STRATEGIES[v.strategy].flatPath,
      preemptForP0: STRATEGIES[v.strategy].preemptForP0,
      poach: STRATEGIES[v.strategy].poach,
    };
  }

  const prev = v.directive;
  const directiveTactics: PartialVehicleTactics = { ...(prev?.tactics ?? {}) };

  if (rawDirective.tactics) {
    const t = rawDirective.tactics;
    if (typeof t.speed === 'number' && Number.isFinite(t.speed)) {
      v.tactics.speed = clamp(t.speed, 0.6, 1.4);
      directiveTactics.speed = v.tactics.speed;
    }
    if (typeof t.respect === 'number' && Number.isFinite(t.respect)) {
      v.tactics.respect = clamp(t.respect, 0.3, 1.0);
      directiveTactics.respect = v.tactics.respect;
    }
    if (typeof t.buffer === 'number' && Number.isFinite(t.buffer)) {
      v.tactics.buffer = Math.round(clamp(t.buffer, 1, 4));
      directiveTactics.buffer = v.tactics.buffer;
    }
    if (typeof t.chargeAt === 'number' && Number.isFinite(t.chargeAt)) {
      v.tactics.chargeAt = Math.round(clamp(t.chargeAt, 8, 40));
      directiveTactics.chargeAt = v.tactics.chargeAt;
    }
    if (typeof t.batch === 'number' && Number.isFinite(t.batch)) {
      v.tactics.batch = Math.round(clamp(t.batch, 1, 3));
      directiveTactics.batch = v.tactics.batch;
    }
    if (t.flatPath !== undefined) {
      v.tactics.flatPath =
        typeof t.flatPath === 'boolean' ? t.flatPath : Number(t.flatPath) <= 0.9;
      directiveTactics.flatPath = v.tactics.flatPath;
    }
    if (typeof t.preemptForP0 === 'boolean') {
      v.tactics.preemptForP0 = t.preemptForP0;
      directiveTactics.preemptForP0 = v.tactics.preemptForP0;
    }
    if (typeof t.poach === 'boolean') {
      v.tactics.poach = t.poach;
      directiveTactics.poach = v.tactics.poach;
    }
  }

  const summaryText = (
    rawDirective.summary ||
    prev?.summary ||
    `Co-Pilot (${v.strategy}) directive active`
  ).slice(0, 120);

  const rawZones =
    rawDirective.preferredZones ??
    rawDirective.focusZones ??
    (rawDirective.preferredZone ? [rawDirective.preferredZone] : undefined);
  const preferredZones = rawZones
    ? rawZones.map((z) => z.toUpperCase()).slice(0, 4)
    : prev?.preferredZones ?? prev?.focusZones ?? (prev?.preferredZone ? [prev.preferredZone] : []);

  const rawBays =
    rawDirective.preferredBays ??
    rawDirective.focusBays ??
    (rawDirective.preferredBay ? [rawDirective.preferredBay] : undefined);
  const preferredBays = rawBays
    ? rawBays.map((b) => b.toUpperCase()).slice(0, 4)
    : prev?.preferredBays ?? prev?.focusBays ?? (prev?.preferredBay ? [prev.preferredBay] : []);

  const avoidZones = rawDirective.avoidZones
    ? rawDirective.avoidZones.map((z) => z.toUpperCase()).slice(0, 4)
    : prev?.avoidZones ?? [];

  const normalizedTask =
    typeof rawDirective.immediateTask === 'string'
      ? { kind: rawDirective.immediateTask }
      : rawDirective.immediateTask ?? null;

  const directive: AgentDirective = {
    autopilot: Boolean(v.autopilot),
    strategy: v.strategy,
    persona: v.strategy,
    priority: rawDirective.priority ?? prev?.priority ?? 'balanced',
    focusZones: preferredZones,
    focusBays: preferredBays,
    preferredZone: preferredZones[0],
    preferredBay: preferredBays[0],
    preferredZones,
    preferredBays,
    avoidZones,
    tactics: Object.keys(directiveTactics).length > 0 ? directiveTactics : undefined,
    immediateTask: normalizedTask,
    summary: summaryText,
    updatedAt: w.t,
  };

  v.directive = directive;
  v.tactics.note = summaryText;
  v.lastDecision = {
    id: `dir-${++w.nextDecisionSeq}`,
    kind: 'tactics',
    reason: summaryText,
    model: 'gemini-3.5-flash-lite',
    latencyMs: 0,
    t: w.t,
  };
  v.lastBrainDecision = {
    kind: 'directive',
    reason: summaryText,
    model: 'gemini-3.5-flash-lite',
    latencyMs: 0,
    at: w.t,
  };

  // Clear stale pending decisions for this vehicle so new directive takes effect immediately
  w.pendingDecisions = w.pendingDecisions.filter((r) => r.agentId !== v.id);

  const releaseUnpicked = (): void => {
    v.orders.forEach((o) => {
      if (!v.cargo.includes(o) && o.state === 'claimed' && o.claimant === v.id) {
        o.state = 'open';
        o.claimant = null;
      }
    });
    v.orders = v.orders.filter((o) => v.cargo.includes(o));
  };

  const isAvailableForDirective = (o: Order): boolean => {
    if (o.state !== 'open') return false;
    if (o.claimant && o.claimant !== v.id) {
      const owner = w.vehicles.find((x) => x.id === o.claimant);
      if (owner && owner.human && !owner.isBot) return false;
    }
    return true;
  };

  const task = normalizedTask;
  if (task?.kind === 'charge' || task?.kind === 'charge_now') {
    releaseUnpicked();
    goCharge(w, v);
  } else if (!v.cargo.length && v.state !== 'picking') {
    if (
      task &&
      (task.kind === 'order' ||
        task.kind === 'zone' ||
        task.kind === 'bay' ||
        task.kind === 'pick_hazmat' ||
        task.kind === 'pick_p0')
    ) {
      releaseUnpicked();
      let matching: Order[] = [];
      const targetVal = task.target;
      if (task.kind === 'order') {
        const oid =
          task.orderId ??
          (targetVal ? Number(String(targetVal).replace(/^#/, '')) : null);
        if (oid != null && Number.isFinite(oid)) {
          matching = w.orders.filter((o) => o.id === oid && isAvailableForDirective(o));
        }
      } else if (task.kind === 'zone' || task.kind === 'pick_hazmat') {
        const rawZ = (task.kind === 'pick_hazmat' ? 'Z' : task.zone || targetVal || '').toUpperCase();
        const targetZone =
          rawZ === 'HAZ'
            ? 'Z'
            : rawZ === 'COLD'
              ? 'W'
              : rawZ === 'BULK'
                ? 'X'
                : rawZ === 'HIGH'
                  ? 'U'
                  : rawZ;
        matching = w.orders.filter(
          (o) => o.slot.zone.toUpperCase() === targetZone && isAvailableForDirective(o),
        );
      } else if (task.kind === 'bay') {
        const b = (task.bay || targetVal || '').toUpperCase();
        matching = w.orders.filter(
          (o) => o.bay.toUpperCase() === b && isAvailableForDirective(o),
        );
      } else if (task.kind === 'pick_p0') {
        matching = w.orders.filter((o) => o.p0 && isAvailableForDirective(o));
      }
      if (!matching.length) {
        matching = w.orders.filter(isAvailableForDirective);
      }
      matching.sort((a, b) => scoreOrder(w, v, b) - scoreOrder(w, v, a));
      const chosen = matching.slice(0, capacity(v));
      if (chosen.length) {
        assign(w, v, chosen);
      } else {
        nextLeg(w, v);
      }
    } else {
      // 'auto' or no explicit immediateTask: re-evaluate unpicked orders against new directive
      releaseUnpicked();
      const candidates = w.orders
        .filter(isAvailableForDirective)
        .sort((a, b) => scoreOrder(w, v, b) - scoreOrder(w, v, a));
      if (candidates.length && v.battery >= v.tactics.chargeAt) {
        assign(w, v, candidates.slice(0, capacity(v)));
      } else {
        nextLeg(w, v);
      }
    }
  } else if (v.target) {
    plan(w, v);
  }

  emit(w, 'copilot', `${v.id}: ${summaryText}`, { vid: v.id, directive });
  return directive;
}

// ---------- Brain Seams: DecisionRequest Emission & applyDecision ----------
function opaqueClaimant(w: World, o: Order): string | null {
  if (!o.claimant) return null;
  const owner = w.vehicles.find((v) => v.id === o.claimant);
  if (!owner) return 'P0';
  if (owner.human || owner.isPlayerVehicle) {
    return owner.playerOpaqueId || 'P1';
  }
  return owner.id;
}

function buildAgentContext(
  w: World,
  v: Vehicle,
  extra: Partial<AgentContext> = {},
): AgentContext {
  const sortedByPts = w.vehicles.slice().sort((a, b) => b.sPts - a.sPts);
  const rank = sortedByPts.findIndex((x) => x.id === v.id) + 1;
  const shippedSorted = w.vehicles
    .filter((x) => !isManualHuman(x))
    .map((x) => x.sShipped)
    .sort((a, b) => a - b);
  const medianShipped = shippedSorted.length
    ? shippedSorted[Math.floor(shippedSorted.length / 2)]
    : 0;

  return {
    agentId: v.id,
    persona: v.strategy,
    vehicleType: v.type,
    tile: { x: v.tile.x, y: v.tile.y },
    battery: Math.round(v.battery * 10) / 10,
    cargoCount: v.cargo.length,
    capacity: capacity(v),
    shiftPts: Math.round(v.sPts * 10) / 10,
    shiftShipped: v.sShipped,
    incidents: v.incidents,
    nearMisses: v.nearMisses,
    slack: slackOf(w, v),
    difficulty: w.difficulty,
    tactics: { ...v.tactics },
    standings: {
      rank: rank || 1,
      totalVehicles: w.vehicles.length,
      leaderPts: sortedByPts[0] ? Math.round(sortedByPts[0].sPts) : 0,
      medianShipped,
    },
    ...extra,
  };
}

function hasPendingRequest(
  w: World,
  agentId: string,
  kind: DecisionRequest['kind'],
): boolean {
  return w.pendingDecisions.some((r) => r.agentId === agentId && r.kind === kind);
}

export function emitContractRequestIfNeeded(w: World, v: Vehicle): DecisionRequest | null {
  if (w.phase !== 'running') return null;
  if (isManualHuman(v) || v.brainError) return null;
  if (w.t < v.stunnedUntil) return null;
  if (hasPendingRequest(w, v.id, 'contract')) return null;

  const unpicked = v.orders.filter((o) => o.state === 'claimed' && o.claimant === v.id);
  const nearDrop =
    v.state === 'toDrop' &&
    v.target !== null &&
    unpicked.length === 0 &&
    manhattan(v.tile.x, v.tile.y, v.target.x, v.target.y) <= 6;
  const isIdleReady =
    v.state === 'idle' &&
    v.cargo.length === 0 &&
    unpicked.length === 0 &&
    v.battery > v.tactics.chargeAt + 4;

  if (!isIdleReady && !nearDrop) return null;

  // Candidate orders: open orders + poachable claimed orders if Opportunist / poach=true
  const candidates = w.orders.filter((o) => {
    if (reservedAgainst(w, o, v)) return false;
    if (o.state === 'open') {
      if (o.claimant && o.claimant !== v.id) {
        const owner = w.vehicles.find((x) => x.id === o.claimant);
        if (owner && owner.human && !owner.isBot) return false;
      }
      return true;
    }
    if (v.tactics.poach && o.state === 'claimed' && o.claimant !== v.id) {
      const owner = w.vehicles.find((x) => x.id === o.claimant);
      if (!owner || owner.human || owner.cargo.length) return false;
      const mine = etaTo(w, v, o.slot.ax, o.slot.ay);
      const theirs = etaTo(w, owner, o.slot.ax, o.slot.ay);
      return mine < theirs * 0.6 && (o.p0 || theirs > 3);
    }
    return false;
  });

  if (!candidates.length) return null;

  const refPoint = nearDrop && v.target ? v.target : v.tile;
  const scored = candidates
    .map((o) => {
      const dist = manhattan(refPoint.x, refPoint.y, o.slot.ax, o.slot.ay);
      const slack = Math.round((o.due - w.t) * 10) / 10;
      const score = scoreOrder(w, v, o, refPoint);
      return { o, dist, slack, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const options: ContractOption[] = scored.map(({ o, dist, slack }) => {
    const district: DistrictKind =
      w.map.zoneKind[o.slot.zone] || floorKind(w.map, o.slot.ax, o.slot.ay);
    const congestion = Number(
      (w.heat[o.slot.ay * w.map.w + o.slot.ax] || 0).toFixed(2),
    );
    return {
      id: String(o.id),
      orderId: o.id,
      distance: dist,
      slack,
      value: o.value,
      district,
      claimant: opaqueClaimant(w, o),
      congestion,
      isTransfer: !!o.isTransfer,
      destSite: o.destSite || null,
      p0: o.p0,
      bay: o.bay,
    };
  });

  const req: DecisionRequest = {
    id: `req-${++w.nextDecisionSeq}`,
    agentId: v.id,
    kind: 'contract',
    tIssued: w.t,
    deadline: Math.round((w.t + 15) * 10) / 10,
    persona: v.strategy,
    context: buildAgentContext(w, v),
    options,
  };
  w.pendingDecisions.push(req);
  return req;
}

export function emitHazardRequestIfNeeded(
  w: World,
  v: Vehicle,
  h: Hazard,
): DecisionRequest | null {
  if (w.phase !== 'running') return null;
  if (isManualHuman(v) || v.brainError) return null;
  if (v.hzSeen.has(h.id)) return null;
  const existing = w.pendingDecisions.find(
    (r) => r.agentId === v.id && r.kind === 'hazard' && r.context.hazardId === h.id,
  );
  if (existing) return existing;

  const hk = `${h.x},${h.y}`;
  let detourLen: number | null = null;
  const dest = v.target || (v.path.length ? v.path[v.path.length - 1] : null);
  if (dest) {
    const alt = findPath(w, v.tile.x, v.tile.y, dest.x, dest.y, {
      flat: v.tactics.flatPath,
      avoid: new Set([hk]),
    });
    if (alt) {
      detourLen = Math.max(0, alt.length - v.path.length);
    }
  }
  const timeLeft = Math.max(0, Math.round((h.until - w.t) * 10) / 10);
  const skidRisk = 0.3;

  const options: HazardOption[] = [
    { id: 'reroute', choice: 'reroute', detourLen, timeLeft, skidRisk: 0 },
    { id: 'wait', choice: 'wait', detourLen: 0, timeLeft, skidRisk: 0 },
    { id: 'push', choice: 'push', detourLen: 0, timeLeft, skidRisk },
  ];

  v.hold = h.id;
  const req: DecisionRequest = {
    id: `req-${++w.nextDecisionSeq}`,
    agentId: v.id,
    kind: 'hazard',
    tIssued: w.t,
    deadline: Math.round((w.t + 10) * 10) / 10,
    persona: v.strategy,
    context: buildAgentContext(w, v, {
      hazardId: h.id,
      hazardTile: { x: h.x, y: h.y },
    }),
    options,
  };
  w.pendingDecisions.push(req);
  return req;
}

export function emitTacticsRequest(w: World, v: Vehicle): DecisionRequest | null {
  if (w.phase !== 'running') return null;
  if (isManualHuman(v) || v.brainError) return null;
  if (hasPendingRequest(w, v.id, 'tactics')) return null;

  const options: TacticsOption[] = [
    { id: 'speed', param: 'speed', min: 0.6, max: 1.6, current: v.tactics.speed },
    { id: 'buffer', param: 'buffer', min: 1, max: 4, current: v.tactics.buffer },
    { id: 'respect', param: 'respect', min: 0.2, max: 1.0, current: v.tactics.respect },
    { id: 'chargeAt', param: 'chargeAt', min: 10, max: 45, current: v.tactics.chargeAt },
    { id: 'batch', param: 'batch', min: 1, max: 2, current: v.tactics.batch },
  ];

  v.lastTacticsReqAt = w.t;
  const req: DecisionRequest = {
    id: `req-${++w.nextDecisionSeq}`,
    agentId: v.id,
    kind: 'tactics',
    tIssued: w.t,
    deadline: Math.round((w.t + 30) * 10) / 10,
    persona: v.strategy,
    context: buildAgentContext(w, v),
    options,
  };
  w.pendingDecisions.push(req);
  return req;
}

export function applyDecision(
  w: World,
  reqId: string,
  d: Decision,
  meta: DecisionMeta,
): { ok: true } | { ok: false; error: 'stale' | 'illegal' | 'expired'; detail: string } {
  const idx = w.pendingDecisions.findIndex((r) => r.id === reqId);
  if (idx === -1) {
    return {
      ok: false,
      error: 'stale',
      detail: `Decision request ${reqId} not found or already resolved`,
    };
  }
  const req = w.pendingDecisions[idx];
  if (w.t > req.deadline) {
    w.pendingDecisions.splice(idx, 1);
    return {
      ok: false,
      error: 'expired',
      detail: `Decision request ${reqId} expired at t=${req.deadline} (now t=${w.t})`,
    };
  }

  const v = w.vehicles.find((x) => x.id === req.agentId);
  if (!v || isManualHuman(v)) {
    w.pendingDecisions.splice(idx, 1);
    return {
      ok: false,
      error: 'stale',
      detail: `Agent ${req.agentId} is no longer available for AI decisions`,
    };
  }

  let reasonText = '';

  if (req.kind === 'contract') {
    const cd = d as ContractDecision;
    if (!cd || !Array.isArray(cd.orderIds) || cd.orderIds.length === 0) {
      return { ok: false, error: 'illegal', detail: 'Contract decision must specify non-empty orderIds' };
    }
    const maxBatch = Math.max(2, capacity(v));
    if (cd.orderIds.length > maxBatch) {
      return {
        ok: false,
        error: 'illegal',
        detail: `Requested ${cd.orderIds.length} orders, exceeding capacity ${maxBatch}`,
      };
    }
    const offeredSet = new Set(
      (req.options as ContractOption[]).map((o) => o.orderId),
    );
    const chosenOrders: Order[] = [];
    for (const rawId of cd.orderIds) {
      const oid = typeof rawId === 'string' ? Number(rawId.replace(/^#/, '')) : rawId;
      if (!Number.isFinite(oid) || !offeredSet.has(oid)) {
        return {
          ok: false,
          error: 'illegal',
          detail: `Order ${String(rawId)} was not part of the offered contract options`,
        };
      }
      const order = w.orders.find((o) => o.id === oid);
      if (!order) {
        w.pendingDecisions.splice(idx, 1);
        return {
          ok: false,
          error: 'stale',
          detail: `Order #${oid} was already completed or removed`,
        };
      }
      if (reservedAgainst(w, order, v)) {
        w.pendingDecisions.splice(idx, 1);
        return {
          ok: false,
          error: 'stale',
          detail: `Order #${oid} is a contract pallet reserved for ${order.reservedFor}`,
        };
      }
      if (order.state === 'open') {
        if (order.claimant && order.claimant !== v.id) {
          const owner = w.vehicles.find((x) => x.id === order.claimant);
          if (owner && owner.human && !owner.isBot) {
            w.pendingDecisions.splice(idx, 1);
            return {
              ok: false,
              error: 'stale',
              detail: `Order #${oid} is reserved by a human pilot`,
            };
          }
        }
        chosenOrders.push(order);
      } else if (
        order.state === 'claimed' &&
        v.tactics.poach &&
        order.claimant !== v.id
      ) {
        const owner = w.vehicles.find((x) => x.id === order.claimant);
        if (!owner || owner.human || owner.cargo.length) {
          w.pendingDecisions.splice(idx, 1);
          return {
            ok: false,
            error: 'stale',
            detail: `Order #${oid} is no longer poachable`,
          };
        }
        chosenOrders.push(order);
      } else {
        w.pendingDecisions.splice(idx, 1);
        return {
          ok: false,
          error: 'stale',
          detail: `Order #${oid} was already claimed or picked`,
        };
      }
    }

    // Apply any poach and assign orders
    for (const order of chosenOrders) {
      if (order.state === 'claimed' && order.claimant && order.claimant !== v.id) {
        const loser = w.vehicles.find((x) => x.id === order.claimant);
        if (loser) {
          loser.orders = loser.orders.filter((x) => x !== order);
          if (!loser.orders.length && !loser.cargo.length) {
            loser.state = 'idle';
            loser.path = [];
            loser.idleSince = w.t;
          } else {
            nextLeg(w, loser);
          }
          w.day.poaches++;
          emit(
            w,
            'poach',
            `${v.id} (${v.strategy}) poached #${order.id} from ${loser.id} (${stratOf(loser)})`,
            { vid: v.id },
          );
        }
      }
    }
    assign(w, v, chosenOrders);
    reasonText = cd.reason || `Claimed #${chosenOrders.map((o) => o.id).join(', #')}`;
  } else if (req.kind === 'hazard') {
    const hd = d as HazardDecision;
    if (!hd || !['reroute', 'wait', 'push'].includes(hd.choice)) {
      return {
        ok: false,
        error: 'illegal',
        detail: `Invalid hazard choice "${String((hd as { choice?: unknown })?.choice)}"`,
      };
    }
    const hid = req.context.hazardId;
    const h = w.spills.find((s) => s.id === hid);
    if (!h || h.until <= w.t) {
      w.pendingDecisions.splice(idx, 1);
      return { ok: false, error: 'stale', detail: `Hazard ${hid} already cleared` };
    }
    if (hd.choice === 'reroute') {
      const opt = (req.options as HazardOption[]).find((o) => o.choice === 'reroute');
      if (opt && opt.detourLen === null) {
        return { ok: false, error: 'illegal', detail: 'Reroute option has no valid detour' };
      }
      const dest = v.target || (v.path.length ? v.path[v.path.length - 1] : null);
      if (dest) {
        const alt = findPath(w, v.tile.x, v.tile.y, dest.x, dest.y, {
          flat: v.tactics.flatPath,
          avoid: new Set([`${h.x},${h.y}`]),
        });
        if (!alt) {
          return { ok: false, error: 'illegal', detail: 'No detour path available around spill' };
        }
        v.path = alt;
      }
      v.hold = null;
      v.msg = '';
      v.waitKey = null;
    } else if (hd.choice === 'wait') {
      v.hold = h.id;
      v.msg = 'Waiting for the spill to clear';
    } else {
      v.pushing = h.id;
      v.hold = null;
      v.msg = '';
    }
    v.hzSeen.add(h.id);
    w.totals.decisions[hd.choice]++;
    reasonText = hd.reason || `Hazard choice: ${hd.choice}`;
  } else if (req.kind === 'tactics') {
    const td = d as TacticsDecision;
    if (
      !td ||
      typeof td.speed !== 'number' ||
      typeof td.buffer !== 'number' ||
      typeof td.respect !== 'number' ||
      typeof td.chargeAt !== 'number' ||
      typeof td.batch !== 'number' ||
      !Number.isFinite(td.speed) ||
      !Number.isFinite(td.buffer) ||
      !Number.isFinite(td.respect) ||
      !Number.isFinite(td.chargeAt) ||
      !Number.isFinite(td.batch)
    ) {
      return { ok: false, error: 'illegal', detail: 'Tactics reply missing numeric fields' };
    }
    if (
      td.speed < 0.5 ||
      td.speed > 2.0 ||
      td.buffer < 0 ||
      td.buffer > 6 ||
      td.respect < 0 ||
      td.respect > 1 ||
      td.chargeAt < 5 ||
      td.chargeAt > 80 ||
      td.batch < 1 ||
      td.batch > 4
    ) {
      return { ok: false, error: 'illegal', detail: 'Tactics parameters outside allowed bounds' };
    }
    const before = { ...v.tactics };
    v.tactics = {
      ...v.tactics,
      speed: clamp(td.speed, 0.6, 1.6),
      buffer: Math.round(clamp(td.buffer, 1, 4)),
      respect: clamp(td.respect, 0.2, 1.0),
      chargeAt: Math.round(clamp(td.chargeAt, 10, 45)),
      batch: Math.round(clamp(td.batch, 1, 2)),
      note: td.note || td.reason || '',
    };
    if (v.strategy === 'Strategist') {
      w.tuned = { ...v.tactics };
    }
    reasonText = td.note || td.reason || 'Retuned tactics';
    emit(
      w,
      'retune',
      `${v.id} (${v.strategy}): ${reasonText}. Speed ${before.speed.toFixed(2)}→${v.tactics.speed.toFixed(2)}, yield ${before.respect.toFixed(2)}→${v.tactics.respect.toFixed(2)}, charge at ${before.chargeAt}%→${v.tactics.chargeAt}%.`,
      { vid: v.id },
    );
  } else if (req.kind === 'cards') {
    const kd = d as CardsDecision;
    if (!kd || !Array.isArray(kd.keep) || kd.keep.length === 0) {
      return { ok: false, error: 'illegal', detail: 'Cards decision must keep at least one card' };
    }
    const hand = w.cards[v.id];
    if (!hand || !hand.offer) {
      w.pendingDecisions.splice(idx, 1);
      return { ok: false, error: 'stale', detail: `No active card offer for ${v.id}` };
    }
    const offerIds = new Set(hand.offer.map((c) => c.id));
    for (const cid of kd.keep) {
      if (!offerIds.has(cid)) {
        return { ok: false, error: 'illegal', detail: `Card ${cid} is not in ${v.id}'s offer` };
      }
    }
    const kept = hand.offer.filter((c) => kd.keep.includes(c.id));
    hand.offer = null;
    kept.forEach((c) => {
      c.status = 'active';
      hand.cards.push(c);
    });
    reasonText = kd.reason || `Kept ${kept.map((c) => c.title).join(', ')}`;
  }

  w.pendingDecisions.splice(idx, 1);
  v.brainError = null;
  v.lastDecision = {
    id: req.id,
    kind: req.kind,
    reason: reasonText,
    model: meta.model,
    latencyMs: meta.latencyMs,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
    t: w.t,
  };
  const journalEntry: DecisionJournalEntry = {
    reqId: req.id,
    agentId: v.id,
    persona: v.strategy,
    kind: req.kind,
    tIssued: req.tIssued,
    tApplied: w.t,
    decision: d,
    reason: reasonText,
    model: meta.model,
    latencyMs: meta.latencyMs,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
  };
  w.decisionJournal.push(journalEntry);
  if (w.decisionJournal.length > 200) w.decisionJournal.shift();
  emit(w, 'decision', `${v.id} (${v.strategy}) [${req.kind}]: ${reasonText}`, {
    vid: v.id,
    reqId: req.id,
    kind: req.kind,
    model: meta.model,
    latencyMs: meta.latencyMs,
  });

  return { ok: true };
}

export function markBrainError(
  w: World,
  agentId: string,
  reqIdOrErrorMsg: string,
  maybeErrorMsg?: string,
): void {
  const isFourArg = typeof maybeErrorMsg === 'string';
  const reqId = isFourArg ? reqIdOrErrorMsg : '';
  const errorMsg = isFourArg ? maybeErrorMsg : reqIdOrErrorMsg;

  w.pendingDecisions = w.pendingDecisions.filter(
    (r) => r.id !== reqId && !(r.agentId === agentId && !reqId),
  );
  const v = w.vehicles.find((x) => x.id === agentId);
  if (!v) return;
  v.brainError = errorMsg;
  v.msg = `Brain error: ${errorMsg}`;
  emit(w, 'brain_error', `${v.id} (${v.strategy}) brain error: ${errorMsg}`, {
    vid: v.id,
    reqId: reqId || undefined,
    error: errorMsg,
  });
}

export function clearBrainError(w: World, agentId: string): void {
  const v = w.vehicles.find((x) => x.id === agentId);
  if (!v) return;
  v.brainError = null;
  if (v.msg.startsWith('Brain error:')) v.msg = '';
}

// ---------- Legs, planning, parking, charging ----------
const keyOf = (p: Point): string => `${p.x},${p.y}`;

export function plan(w: World, v: Vehicle, avoid?: Set<string>): boolean {
  if (!v.target) {
    v.path = [];
    return false;
  }
  const p = findPath(w, v.tile.x, v.tile.y, v.target.x, v.target.y, {
    flat: policy(w, v).flatPath,
    avoid,
  });
  if (p === null) {
    v.path = [];
    v.msg = 'No route — waiting';
    return false;
  }
  v.path = p;
  v.msg = '';
  return true;
}

export function nextLeg(w: World, v: Vehicle): void {
  v.path = [];
  v.wait = 0;
  v.waitKey = null;

  if (w.phase === 'winding_down') {
    // During winding_down, unpicked orders are released and only pallets already on forks are delivered
    v.orders.forEach((o) => {
      if (o.state === 'claimed' && o.claimant === v.id) {
        o.state = 'open';
        o.claimant = null;
      }
    });
    v.orders = v.orders.filter((o) => v.cargo.includes(o));
    if (v.cargo.length) {
      const bay = w.map.bays.find((b) => b.id === v.cargo[0].bay) || w.map.bays[0];
      const dt = dropTile(w, bay, v.tile.x, v.tile.y);
      v.target = { kind: 'drop', bay: bay.id, x: dt.x, y: dt.y };
      v.state = 'toDrop';
      plan(w, v);
      return;
    }
    parkForBreak(w, v);
    return;
  }

  const unpicked = v.orders.filter((o) => o.state === 'claimed' && o.claimant === v.id);
  if (unpicked.length && v.cargo.length < capacity(v)) {
    unpicked.sort(
      (a, b) => etaTo(w, v, a.slot.ax, a.slot.ay) - etaTo(w, v, b.slot.ax, b.slot.ay),
    );
    const o = unpicked[0];
    v.target = { kind: 'pick', order: o, x: o.slot.ax, y: o.slot.ay };
    v.state = 'toPick';
  } else if (v.cargo.length) {
    const bay = w.map.bays.find((b) => b.id === v.cargo[0].bay) || w.map.bays[0];
    const dt = dropTile(w, bay, v.tile.x, v.tile.y);
    v.target = { kind: 'drop', bay: bay.id, x: dt.x, y: dt.y };
    v.state = 'toDrop';
  } else {
    v.state = 'idle';
    v.target = null;
    v.idleSince = w.t;
    return;
  }
  plan(w, v);
}

export function park(w: World, v: Vehicle): void {
  const bay = bayAt(w.map, v.tile.x, v.tile.y);
  if (bay) {
    v.target =
      bay.id === 'RET'
        ? { kind: 'park', x: bay.dropX, y: 30 }
        : { kind: 'park', x: HWY_E, y: bay.y };
    plan(w, v);
    return;
  }
  if (chargerAt(w.map, v.tile.x, v.tile.y) >= 0) {
    v.target = { kind: 'park', x: v.tile.x, y: parkY(w.map, v.tile.y) };
    plan(w, v);
  }
}

function parkForBreak(w: World, v: Vehicle): void {
  if (v.state === 'charging' || v.state === 'parked') return;
  const takenChargers = new Set(
    w.vehicles.filter((x) => x !== v && x.chargerIdx >= 0).map((x) => x.chargerIdx),
  );
  let bestCharger = -1;
  let bestDist = 1e9;
  w.map.chargers.forEach((c, i) => {
    if (takenChargers.has(i)) return;
    const d = manhattan(v.tile.x, v.tile.y, c.x, c.y);
    if (d < bestDist) {
      bestDist = d;
      bestCharger = i;
    }
  });
  if (bestCharger >= 0) {
    v.chargerIdx = bestCharger;
    v.state = 'toCharge';
    v.target = {
      kind: 'charge',
      x: w.map.chargers[bestCharger].x,
      y: w.map.chargers[bestCharger].y,
    };
    plan(w, v);
    return;
  }
  // Otherwise head to the Break room apron (around x=41..44, y=19..20)
  const breakX = 41 + (w.vehicles.indexOf(v) % 4);
  const breakY = 20;
  v.state = 'idle';
  v.target = { kind: 'break', x: breakX, y: breakY };
  plan(w, v);
}

function nudge(w: World, v: Vehicle, avoidKey: string, occ: Map<string, Vehicle>): boolean {
  const D: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const off = Math.floor(rng(w) * 4);
  for (let i = 0; i < 4; i++) {
    const [dx, dy] = D[(i + off) % 4];
    const nx = v.tile.x + dx;
    const ny = v.tile.y + dy;
    const k = `${nx},${ny}`;
    if (isBlocked(w, nx, ny) || k === avoidKey || occ.has(k) || bayAt(w.map, nx, ny)) continue;
    v.target = { kind: 'park', x: nx, y: ny };
    v.path = [{ x: nx, y: ny }];
    return true;
  }
  return false;
}

export function goCharge(w: World, v: Vehicle): void {
  const taken = new Set(
    w.vehicles.filter((x) => x !== v && x.chargerIdx >= 0).map((x) => x.chargerIdx),
  );
  let best = -1;
  let bd = 1e9;
  w.map.chargers.forEach((c, i) => {
    if (taken.has(i)) return;
    const d = manhattan(v.tile.x, v.tile.y, c.x, c.y);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  if (best < 0) {
    v.msg = 'Waiting for a free charger';
    return;
  }
  v.chargerIdx = best;
  v.state = 'toCharge';
  v.target = { kind: 'charge', x: w.map.chargers[best].x, y: w.map.chargers[best].y };
  plan(w, v);
}

function drain(w: World, v: Vehicle, pct: number): void {
  const mul = getCardModifiers(w, v).batteryDrainMul;
  const actual = pct * mul;
  v.battery = Math.max(0, v.battery - actual);
  if (v.battery < 0.05) v.battery = 0;
  v.energySince += actual;
}

function turnToward(v: Vehicle, target: number, dt: number): void {
  let d = target - v.angle;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const max = 12 * dt;
  v.angle += Math.abs(d) <= max ? d : Math.sign(d) * max;
}

// ---------- Space reservations ----------
export function buildOccupancy(w: World): {
  occ: Map<string, Vehicle>;
  res: Map<string, Vehicle>;
} {
  const occ = new Map<string, Vehicle>();
  const res = new Map<string, Vehicle>();
  for (const v of w.vehicles) {
    occ.set(keyOf(v.tile), v);
  }
  for (const v of w.vehicles) {
    if (v.moveTo && !occ.has(keyOf(v.moveTo))) occ.set(keyOf(v.moveTo), v);
    if (isManualHuman(v)) {
      const fx = Math.floor(v.px + Math.cos(v.angle) * 0.4);
      const fy = Math.floor(v.py + Math.sin(v.angle) * 0.4);
      if (!occ.has(`${fx},${fy}`)) occ.set(`${fx},${fy}`, v);
    }
  }
  for (const v of w.vehicles) {
    if (isManualHuman(v)) {
      for (let k = 1; k <= 2; k++) {
        const kk = `${Math.floor(v.px + Math.cos(v.angle) * k * 0.9)},${Math.floor(v.py + Math.sin(v.angle) * k * 0.9)}`;
        if (!res.has(kk)) res.set(kk, v);
      }
      continue;
    }
    const b = policy(w, v).buffer;
    for (let i = 0; i < Math.min(b, v.path.length); i++) {
      const kk = keyOf(v.path[i]);
      if (!res.has(kk)) res.set(kk, v);
    }
  }
  return { occ, res };
}

// ---------- Incidents ----------
function bump(
  w: World,
  field: 'shipped' | 'onTime' | 'incidents' | 'nearMisses',
  s: StrategyName,
  n = 1,
): void {
  [w.day, w.shift].forEach((st) => {
    st[field] += n;
    if (s && st.byStrat[s]) st.byStrat[s][field] += n;
  });
}

export const BOOST_SPEED_MUL = 1.65;
export const BOOST_COLLISION_SPEED = 4.35;

export function dropPalletOnCollision(
  w: World,
  v: Vehicle,
  obstacleLabel = 'an obstacle',
): Order[] {
  if (!v.cargo || v.cargo.length === 0) return [];
  const dropped: Order[] = [];
  const items = v.cargo.splice(0, v.cargo.length);
  for (const item of items) {
    const o =
      typeof item === 'object' && item !== null
        ? (item as Order)
        : w.orders.find((x) => x.id === (item as unknown as number));
    if (!o) continue;
    o.state = 'open';
    o.claimant = null;
    o.slot = {
      ...o.slot,
      key: `${v.tile.x},${v.tile.y}`,
      ax: v.tile.x,
      ay: v.tile.y,
      rx: v.tile.x,
      ry: v.tile.y,
    };
    v.orders = v.orders.filter(
      (x) => x !== o && (x as unknown as number) !== o.id && x?.id !== o.id,
    );
    w.day.damaged++;
    dropped.push(o);
  }
  if (dropped.length > 0) {
    const sv = stratOf(v);
    v.forkTarget = 0.15;
    v.incidents++;
    v.runIncidents = (v.runIncidents ?? 0) + 1;
    v.streak = 0;
    resetCombo(w, v, 'drop');
    v.palletDrops = (v.palletDrops ?? 0) + dropped.length;
    bump(w, 'incidents', sv);
    w.totals.incidents++;
    w.totals.palletDrops = (w.totals.palletDrops ?? 0) + dropped.length;
    v.sPts -= INCIDENT_PENALTY;
    v.runPts = Math.max(0, (v.runPts ?? 0) - INCIDENT_PENALTY);
    cardsOnCrash(w, v);
    w.incidentLog.push({ t: w.t, strat: sv });
    w.markers.push({ x: v.tile.x, y: v.tile.y, until: w.t + 10, kind: 'incident' });
    const skuLabels = dropped
      .map((o) => {
        const rawSku = (o as unknown as { sku?: { code?: string } | string }).sku;
        const skuCode =
          typeof rawSku === 'object' && rawSku?.code ? rawSku.code : String(o.sku);
        return `${skuCode} (#${o.id})`;
      })
      .join(', ');
    const vLabel = (v as unknown as { name?: string }).name || v.driver || v.id;
    emit(
      w,
      'incident',
      `${vLabel} (${v.id}) collided with ${obstacleLabel} while boosting — dropped pallet ${skuLabels} at (${v.tile.x},${v.tile.y})!`,
      { vid: v.id, x: v.tile.x, y: v.tile.y },
    );
  }
  return dropped;
}

function incident(
  w: World,
  a: Vehicle,
  b: Vehicle,
  x: number,
  y: number,
  forceDrop = false,
): void {
  const sa = stratOf(a);
  const damaged: string[] = [];
  const diffSpeed = diffOf(w).speed ?? 1;
  [a, b].forEach((v) => {
    const wasBoosting =
      Boolean(v.input?.boost) ||
      (v === a && forceDrop) ||
      (isManualHuman(v) && Math.abs(v.speedNow) > BOOST_COLLISION_SPEED * diffSpeed);
    v.stunnedUntil = w.t + 4;
    v.speedNow = 0;
    v.incidents++;
    v.runIncidents = (v.runIncidents ?? 0) + 1;
    v.streak = 0;
    resetCombo(w, v, 'crash');
    if (v.cargo.length && (wasBoosting || rng(w) < 0.5)) {
      const raw = v.cargo.shift()!;
      const o =
        typeof raw === 'object' && raw !== null
          ? (raw as Order)
          : w.orders.find((ord) => ord.id === (raw as unknown as number));
      if (o) {
        o.state = 'open';
        o.claimant = null;
        o.slot = {
          ...o.slot,
          key: `${v.tile.x},${v.tile.y}`,
          ax: v.tile.x,
          ay: v.tile.y,
          rx: v.tile.x,
          ry: v.tile.y,
        };
        v.orders = v.orders.filter(
          (ord) => ord !== o && (ord as unknown as number) !== o.id && ord?.id !== o.id,
        );
        v.forkTarget = 0.15;
        const rawSku = (o as unknown as { sku?: { code?: string } | string }).sku;
        const skuCode =
          typeof rawSku === 'object' && rawSku?.code ? rawSku.code : String(o.sku);
        damaged.push(`${skuCode} (#${o.id})`);
        w.day.damaged++;
        v.palletDrops = (v.palletDrops ?? 0) + 1;
        w.totals.palletDrops = (w.totals.palletDrops ?? 0) + 1;
      }
    }
    if (!isManualHuman(v)) nextLeg(w, v);
  });
  bump(w, 'incidents', sa);
  w.totals.incidents++;
  a.sPts -= INCIDENT_PENALTY;
  a.runPts = Math.max(0, (a.runPts ?? 0) - INCIDENT_PENALTY);
  cardsOnCrash(w, a);
  w.incidentLog.push({ t: w.t, strat: sa });
  w.markers.push({ x, y, until: w.t + 10, kind: 'incident' });
  emit(
    w,
    'incident',
    `${a.id} (${sa}) hit ${b.id} (${stratOf(b)}). Both stopped 4 min` +
      (damaged.length ? `; pallet damaged, ${damaged.join(', ')} back in the queue` : ''),
    { vid: a.id, x, y },
  );
}

function intrude(w: World, v: Vehicle, other: Vehicle, n: Point): void {
  const dist = manhattan(other.tile.x, other.tile.y, n.x, n.y);
  if (dist > 2) return;
  v.nearMisses++;
  bump(w, 'nearMisses', stratOf(v));
  const moving = other.moveTo || Math.abs(other.speedNow) > 0.2;
  const p =
    0.12 *
    diffOf(w).crash *
    policy(w, v).speed *
    (moving ? 1.4 : 0.6) *
    (dist <= 1 ? 1.5 : 1);
  w.markers.push({ x: n.x, y: n.y, until: w.t + 2, kind: 'near' });
  if (rng(w) < p) incident(w, v, other, n.x, n.y);
  else {
    emit(w, 'nearmiss', `${v.id} (${stratOf(v)}) cut into ${other.id}'s claimed lane`, {
      vid: v.id,
      x: n.x,
      y: n.y,
    });
  }
}

// ---------- AI movement ----------
function backOff(
  w: World,
  v: Vehicle,
  occ: Map<string, Vehicle>,
  res: Map<string, Vehicle>,
): boolean {
  const D: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const off = Math.floor(rng(w) * 4);
  for (let i = 0; i < 4; i++) {
    const [dx, dy] = D[(i + off) % 4];
    const nx = v.tile.x + dx;
    const ny = v.tile.y + dy;
    const k = `${nx},${ny}`;
    if (isBlocked(w, nx, ny) || occ.has(k) || (res.get(k) && res.get(k) !== v)) continue;
    v.moveTo = { x: nx, y: ny };
    occ.set(k, v);
    v.path = [];
    v.wait = 2;
    v.stuck = 0;
    v.waitKey = null;
    return true;
  }
  return false;
}

function waitFor(
  w: World,
  v: Vehicle,
  dt: number,
  n: Point,
  other: Vehicle,
  hard: boolean,
  occ: Map<string, Vehicle>,
  res: Map<string, Vehicle>,
): void {
  v.braking = true;
  v.speedNow = 0;
  v.wait += dt;
  v.stuck = (v.stuck || 0) + dt;
  if (
    hard &&
    !isManualHuman(other) &&
    other.state === 'idle' &&
    !other.path.length &&
    !other.moveTo
  ) {
    nudge(w, other, keyOf(v.tile), occ);
  }
  if (v.stuck > 6 + rng(w) * 3 && backOff(w, v, occ, res)) return;
  if (v.wait > (hard ? 2.5 : 4)) {
    v.wait = 0;
    v.waitKey = null;
    const isTarget = v.target && n.x === v.target.x && n.y === v.target.y;
    if (!isTarget) plan(w, v, new Set([keyOf(n)]));
  }
}

function stepAI(
  w: World,
  v: Vehicle,
  dt: number,
  occ: Map<string, Vehicle>,
  res: Map<string, Vehicle>,
): void {
  v.braking = false;
  if (w.t < v.stunnedUntil) {
    v.speedNow = 0;
    return;
  }
  // If agent is idle and has a brainError, it holds visibly and does not move
  if (v.brainError && v.state === 'idle' && !v.moveTo && !v.cargo.length) {
    v.speedNow = 0;
    v.braking = true;
    return;
  }

  const pol = policy(w, v);
  if (!v.moveTo) {
    if (!v.path.length) {
      v.speedNow = 0;
      if (v.target && (v.tile.x !== v.target.x || v.tile.y !== v.target.y)) {
        v.wait += dt;
        if (v.wait > 2) {
          v.wait = 0;
          plan(w, v);
        }
      }
      return;
    }
    const n = v.path[0];
    const nk = keyOf(n);

    // If next tile has an unresolved spill, hold until the brain decision arrives
    const nextHaz = hazardAt(w, n.x, n.y);
    if (nextHaz && !v.hzSeen.has(nextHaz.id)) {
      emitHazardRequestIfNeeded(w, v, nextHaz);
      v.braking = true;
      v.speedNow = 0;
      return;
    }

    if (isBlocked(w, n.x, n.y)) {
      plan(w, v);
      return;
    }
    const occupant = occ.get(nk);
    if (occupant && occupant !== v) {
      waitFor(w, v, dt, n, occupant, true, occ, res);
      return;
    }
    const claimer = res.get(nk);
    if (claimer && claimer !== v) {
      if (v.waitKey !== nk) {
        let respect = pol.respect;
        if (isManualHuman(claimer)) respect = Math.min(1, respect + 0.35);
        else if (claimer.strategy === 'Opportunist') respect -= 0.15;
        v.waitKey = nk;
        v.wait = 0;
        v.waitRespect = rng(w) < respect;
        if (!v.waitRespect) {
          intrude(w, v, claimer, n);
          if (w.t < v.stunnedUntil) return;
        }
      }
      if (v.waitRespect) {
        waitFor(w, v, dt, n, claimer, false, occ, res);
        return;
      }
    }
    v.moveTo = { x: n.x, y: n.y };
    v.path.shift();
    occ.set(nk, v);
    v.wait = 0;
    v.waitKey = null;
  } else {
    const destOcc = occ.get(keyOf(v.moveTo));
    if (
      destOcc &&
      destOcc !== v &&
      isManualHuman(destOcc) &&
      destOcc.tile.x === v.moveTo.x &&
      destOcc.tile.y === v.moveTo.y
    ) {
      v.path.unshift(v.moveTo);
      v.moveTo = null;
      waitFor(w, v, dt, v.path[0], destOcc, true, occ, res);
      return;
    }
  }

  const tx = v.moveTo.x + 0.5;
  const ty = v.moveTo.y + 0.5;
  const dx = tx - v.px;
  const dy = ty - v.py;
  const d = Math.hypot(dx, dy);
  const onSpill =
    hazardAt(w, v.tile.x, v.tile.y) || hazardAt(w, v.moveTo.x, v.moveTo.y);
  const spd =
    BASE_SPEED[v.type] *
    (v.human && v.autopilot ? 2.2 * getCardModifiers(w, v).speedMul : 1) *
    pol.speed *
    (diffOf(w).speed ?? 1) *
    (v.cargo.length ? 0.92 : 1) *
    (v.battery <= 0 ? 0.3 : 1) *
    K_SPEED[kindAtTile(w.map, v.tile.x, v.tile.y)] *
    (onSpill ? 0.45 : 1);
  v.speedNow = spd;
  if (d > 1e-4) turnToward(v, Math.atan2(dy, dx), dt);
  const step = spd * dt;
  if (step >= d) {
    v.px = tx;
    v.py = ty;
    v.tile = v.moveTo;
    v.moveTo = null;
    v.stuck = 0;
    drain(w, v, 0.11 * pol.speed * pol.speed * K_DRAIN[kindAtTile(w.map, v.tile.x, v.tile.y)]);
  } else {
    v.px += (dx / d) * step;
    v.py += (dy / d) * step;
  }
}

// ---------- AI task state machine ----------
export function deliver(w: World, v: Vehicle, bayId: string): number {
  const here = v.cargo.filter((o) => o.bay === bayId);
  if (!here.length) return 0;
  const bay = w.bays.find((b) => b.id === bayId) || w.bays[0];
  const s = stratOf(v);
  const kwhEach = (v.energySince * KWH_PER_PCT) / here.length;
  v.energySince = 0;
  const mods = getCardModifiers(w, v);
  const payoutMul = 1 + mods.payoutBonus;
  const recs: DeliverRec[] = [];
  const poachedOwners: string[] = [];
  let tip = 0;

  here.forEach((o) => {
    o.state = 'done';
    const onTime = w.t <= o.due;
    if (onTime) {
      v.streak = (v.streak ?? 0) + 1;
      v.bestStreak = Math.max(v.bestStreak ?? 0, v.streak);
      v.runOnTime = (v.runOnTime ?? 0) + 1;
    } else {
      v.streak = 0;
    }
    // Fare: rate the loaded leg against the par set at pickup.
    const actual = Math.round((w.t - (o.pickedAt ?? w.t)) * 100) / 100;
    const par = o.parLoaded ?? null;
    const rating = rateFare(actual, par, onTime);
    const combo = comboOf(v);
    const bonus =
      (bay.id === 'RET' ? 6 : 0) +
      (mods.ptsBonus ?? 0) +
      (o.p0 ? (mods.p0Bonus ?? 0) : 0);
    const pts = (o.value + bonus) * RATING_MUL[rating] * combo * payoutMul;
    v.sPts += pts;
    v.runPts = (v.runPts ?? 0) + pts;
    v.sShipped++;
    v.runDeliveries = (v.runDeliveries ?? 0) + 1;
    if (rating === 'slow') resetCombo(w, v, 'slow');
    else stepCombo(w, v);
    v.fareTrips = (v.fareTrips ?? 0) + 1;
    if (rating === 'speedy') v.speedyTrips = (v.speedyTrips ?? 0) + 1;
    const fare: FareResult = {
      t: w.t,
      orderId: o.id,
      rating,
      actual,
      par,
      combo,
      pts: Math.round(pts * 10) / 10,
    };
    (v.fareLog ??= []).push(fare);
    if (v.fareLog.length > 10) v.fareLog.shift();
    emit(
      w,
      'fare',
      `${v.id} #${o.id} ${rating.toUpperCase()} ${actual.toFixed(1)}/${par ?? '—'} min ×${combo} → +${fare.pts}`,
      { vid: v.id, ...fare },
    );
    if (v.human && rating !== 'slow') tip += BATTERY_TIP[rating];
    recs.push({
      o,
      onTime,
      trip: w.t - (o.pickedAt ?? w.t),
      rating,
      beatPar: par != null && par > 0 && actual <= par * SPEEDY_RATIO,
      closer: false,
    });
    // Contract pallet delivered by someone other than the card owner → poached.
    if (o.card) {
      const owner = cardOwnerOf(w, o.card);
      if (owner && owner.card.status === 'active' && !ownsHandKey(v, owner.key)) {
        owner.card.status = 'lost';
        poachedOwners.push(owner.key);
        emit(w, 'poach', `${v.id} poached contract pallet #${o.id}; "${owner.card.title}" is lost.`, {
          vid: v.id,
          owner: owner.key,
          cardId: owner.card.id,
          orderId: o.id,
        });
      }
    }
    w.deliveries.push({ t: w.t, strat: s, vid: v.id, onTime, kwh: kwhEach, p0: o.p0 });
    [w.day, w.shift].forEach((st) => {
      st.shipped++;
      if (onTime) st.onTime++;
      st.byStrat[s].shipped++;
      if (onTime) st.byStrat[s].onTime++;
      st.byStrat[s].kwh += kwhEach;
    });
    w.totals.shipped++;
    if (onTime) w.totals.onTime++;
    v.deliveries++;
    bay.load++;
    if (
      bay.load === bay.cap &&
      bay.id !== 'RET' &&
      !bay.isTransferBay &&
      !o.isTransfer &&
      !o.destSite
    ) {
      v.sPts += TRAILER_CLOSER_PTS;
      v.runPts = (v.runPts ?? 0) + TRAILER_CLOSER_PTS;
      stepCombo(w, v);
      recs[recs.length - 1].closer = true;
      emit(w, 'trailer_closer', `${v.id} closed the trailer at bay ${bay.id}: +${TRAILER_CLOSER_PTS}`, {
        vid: v.id,
        bay: bay.id,
        pts: TRAILER_CLOSER_PTS,
        combo: v.combo,
      });
    }
    if (o.p0) {
      emit(
        w,
        'p0done',
        `P0 #${o.id} delivered by ${v.id} (${s}), ${onTime ? 'on time' : 'late'}`,
        { vid: v.id },
      );
    }

    // Check if this order is a cross-site transfer delivered to a transfer bay
    if (o.destSite || bay.isTransferBay || o.isTransfer) {
      const siblings = siblingSites(w.siteId);
      const toSite = o.destSite || siblings[Math.floor(rng(w) * siblings.length)];
      const xfer: TransferOut = {
        id: `xfer-${w.siteId}-${++w.nextTransferSeq}`,
        fromSite: w.siteId,
        toSite,
        orderRef: o.id,
        sku: o.sku,
        value: o.value,
        shippedAt: w.t,
        carrier: v.id,
      };
      w.outboundTransfers.push(xfer);
      w.totals.transfersOut++;
      emit(
        w,
        'transfer_out',
        `Transfer ${xfer.id} (#${o.id}) shipped via ${bay.id} (→ NET) to ${toSite.toUpperCase()} by ${v.id}.`,
        { transfer: xfer, vid: v.id },
      );
    }
  });

  v.cargo = v.cargo.filter((o) => o.state !== 'done');
  v.orders = v.orders.filter((o) => o.state !== 'done');
  w.orders = w.orders.filter((o) => o.state !== 'done');
  if (bay.load >= bay.cap) {
    bay.load = 0;
    if (bay.id === 'RET') {
      emit(w, 'truck', 'Returns & QA batch cleared (8/8 inspected); bench ready');
    } else {
      bay.departUntil = w.t + 3;
      emit(w, 'truck', `Trailer at bay ${bay.id} left full; next one docks in 3 min`);
    }
  }
  if (v.human && recs.length >= 2 && tip > 0) tip += BATTERY_TIP.batch;
  if (tip > 0) v.battery = Math.min(100, v.battery + tip);
  cardsOnDeliver(w, v, recs);
  for (const key of poachedOwners) {
    const ov = w.vehicles.find((x) => x.human && ownsHandKey(x, key));
    autoRedrawIfNeeded(w, ov);
  }
  return here.length;
}

function stepTask(w: World, v: Vehicle, dt: number): void {
  v.fork += (v.forkTarget - v.fork) * Math.min(1, dt * 7);
  if (w.t < v.stunnedUntil || v.moveTo || v.path.length) return;
  const at = (x: number, y: number) => v.tile.x === x && v.tile.y === y;
  const diffSpeed = diffOf(w).speed ?? 1;

  switch (v.state) {
    case 'idle':
      if (v.target && (v.target.kind === 'park' || v.target.kind === 'break') && at(v.target.x, v.target.y)) {
        v.target = null;
        if (w.phase === 'winding_down') {
          v.state = 'parked';
          break;
        }
      }
      if (w.phase === 'winding_down') {
        parkForBreak(w, v);
        break;
      }
      if (!v.cargo.length && !v.orders.length && v.battery < policy(w, v).chargeAt) {
        goCharge(w, v);
      }
      break;
    case 'parked':
      if (w.phase === 'running') {
        v.state = 'idle';
        v.idleSince = w.t;
      }
      break;
    case 'toPick': {
      const tgt = v.target;
      const o = tgt && tgt.order;
      if (!tgt || !o || o.claimant !== v.id || o.state !== 'claimed') {
        nextLeg(w, v);
        break;
      }
      if (at(tgt.x, tgt.y)) {
        v.state = 'picking';
        v.timer = K_PICK[kindAtTile(w.map, o.slot.rx, o.slot.ry)];
        v.forkTarget = 0.95;
        v.angle = Math.atan2(o.slot.ry - o.slot.ay, o.slot.rx - o.slot.ax);
      }
      break;
    }
    case 'picking':
      v.timer -= dt * diffSpeed * (getCardModifiers(w, v).forkLiftMul ?? 1);
      if (v.timer <= 0) {
        const o = v.target?.order;
        if (o && o.claimant === v.id && o.state === 'claimed') {
          o.state = 'picked';
          o.pickedAt = w.t;
          o.parLoaded = parLoadedFor(w, o) ?? undefined;
          v.cargo.push(o);
        }
        v.forkTarget = 0.3;
        nextLeg(w, v);
      }
      break;
    case 'toDrop':
      if (v.target && at(v.target.x, v.target.y)) {
        const bay = w.bays.find((b) => b.id === v.target!.bay) || w.bays[0];
        if (w.t < bay.departUntil) {
          v.braking = true;
          v.msg = 'Waiting for the next trailer';
          break;
        }
        v.state = 'dropping';
        v.timer = 0.75;
        v.forkTarget = 0.55;
        v.angle = 0;
        v.msg = '';
      }
      break;
    case 'dropping':
      v.timer -= dt * diffSpeed * (getCardModifiers(w, v).forkLiftMul ?? 1);
      if (v.timer <= 0) {
        if (v.target?.bay) deliver(w, v, v.target.bay);
        v.forkTarget = 0.15;
        nextLeg(w, v);
        if ((v.state as Vehicle['state']) === 'idle' && w.phase === 'running') park(w, v);
      }
      break;
    case 'toCharge':
      if (v.target && at(v.target.x, v.target.y)) {
        v.state = 'charging';
        v.msg = '';
      }
      break;
    case 'charging':
      v.battery = Math.min(100, v.battery + 5 * dt);
      if (v.battery >= 95 && w.phase === 'running') {
        v.chargerIdx = -1;
        v.state = 'idle';
        v.idleSince = w.t;
        v.target = null;
        park(w, v);
      }
      break;
  }
}

// ---------- Human driving (shared between server tick and client prediction) ----------
/**
 * Supports both:
 * - `stepHuman(w, v, input, dt, occ?)` (M1 shared prediction signature)
 * - `stepHuman(w, v, dt, occ?)` (Mock v4 signature using `v.input`)
 */
export function stepHuman(
  w: World,
  v: Vehicle,
  inputOrDt: DriverInput | number,
  dtOrOcc?: number | Map<string, Vehicle>,
  maybeOcc?: Map<string, Vehicle>,
): void {
  let inp: DriverInput;
  let dt: number;
  let occ: Map<string, Vehicle> | undefined;

  if (typeof inputOrDt === 'number') {
    inp = v.input;
    dt = inputOrDt;
    occ = dtOrOcc as Map<string, Vehicle> | undefined;
  } else {
    inp = inputOrDt;
    v.input = { ...v.input, ...inp };
    dt = typeof dtOrOcc === 'number' ? dtOrOcc : TICK_MIN;
    occ = maybeOcc;
  }

  v.fork += (v.forkTarget - v.fork) * Math.min(1, dt * 7);
  if (v.runFinished) {
    v.speedNow = 0;
    return;
  }
  if (w.t < v.stunnedUntil) {
    v.speedNow = 0;
    return;
  }
  if (
    v.runMode === 'blitz' &&
    v.runStartedAt === null &&
    (inp.up || inp.down || inp.left || inp.right)
  ) {
    v.runStartedAt = w.t;
    v.runEndsAt = Math.round((w.t + BLITZ_DURATION_MIN) * 10) / 10;
    v.runGraceUntil = null;
  }

  const diffSpeed = diffOf(w).speed ?? 1;
  const mods = getCardModifiers(w, v);
  const isBoosting = Boolean(inp.boost) && v.battery > 0;
  const speedMul =
    mods.speedMul * diffSpeed * (isBoosting ? BOOST_SPEED_MUL : 1);
  const batFactor = v.battery <= 0 ? 0.55 : v.battery < 10 ? 0.72 : 1;
  const maxF =
    4.2 *
    speedMul *
    batFactor *
    K_SPEED[kindAtTile(w.map, v.tile.x, v.tile.y)];
  const maxR = 1.8 * speedMul * batFactor;

  const speedBefore = v.speedNow;
  if (inp.up) v.speedNow = Math.min(maxF, v.speedNow + (isBoosting ? 13 : 7.5) * diffSpeed * dt);
  else if (inp.down)
    v.speedNow = Math.max(-maxR, v.speedNow - (isBoosting ? 14 : 9.5) * diffSpeed * dt);
  else {
    v.speedNow *= Math.max(0, 1 - 4 * dt);
    if (Math.abs(v.speedNow) < 0.03) v.speedNow = 0;
  }
  if (v.speedNow > maxF) v.speedNow = Math.max(maxF, v.speedNow - 11 * diffSpeed * dt);
  // Precision stop (Crazy Stop card): brake hard from top speed to a near-stop.
  if (inp.up) v.brakeFrom = null;
  else if (inp.down && speedBefore > 0) v.brakeFrom = Math.max(v.brakeFrom ?? 0, speedBefore);
  if (v.brakeFrom != null && v.speedNow < PRECISION_TO_SPEED * diffSpeed) {
    if (v.brakeFrom > PRECISION_FROM_SPEED * diffSpeed) {
      v.precisionArmed = { x: v.px, y: v.py, t: w.t };
    }
    v.brakeFrom = null;
  }
  if (inp.up || inp.down) v.humanCharging = false;
  v.braking = inp.down && v.speedNow > 0;
  const steer = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
  if (steer) {
    v.angle += steer * dt * (Math.abs(v.speedNow) > 0.05 ? 3.2 * Math.sign(v.speedNow) : 2.0);
  }
  const onCharger = chargerAt(w.map, v.tile.x, v.tile.y) >= 0;
  if (onCharger && v.speedNow === 0 && !inp.up && !inp.down && v.battery < 100) {
    v.humanCharging = true;
  }
  if (v.humanCharging) {
    if (onCharger && v.speedNow === 0) {
      const chargeRate = 15 + (mods.chargeBonus ?? 0);
      v.battery = Math.min(100, v.battery + chargeRate * dt);
      if (v.battery >= 100) v.humanCharging = false;
    } else {
      v.humanCharging = false;
    }
  }
  if (v.speedNow === 0) return;
  const nx = v.px + Math.cos(v.angle) * v.speedNow * dt;
  const ny = v.py + Math.sin(v.angle) * v.speedNow * dt;
  const dir = Math.sign(v.speedNow);
  const ftx = Math.floor(nx + Math.cos(v.angle) * 0.32 * dir);
  const fty = Math.floor(ny + Math.sin(v.angle) * 0.32 * dir);
  const atBoostRisk = Boolean(inp.boost) || Math.abs(v.speedNow) > BOOST_COLLISION_SPEED * diffSpeed;
  if (isBlocked(w, ftx, fty) || isBlocked(w, Math.floor(nx), Math.floor(ny))) {
    if (atBoostRisk) {
      if (v.cargo.length > 0) {
        dropPalletOnCollision(w, v, 'an obstacle');
      }
      v.stunnedUntil = Math.max(v.stunnedUntil, w.t + 2.0);
    }
    v.brakeFrom = null; // stopping against a wall is not a Crazy Stop
    v.speedNow = 0;
    return;
  }
  const ntx = Math.floor(nx);
  const nty = Math.floor(ny);
  const isCandidateBlocking = (u: Vehicle | undefined): u is Vehicle => {
    if (!u || u === v || u.id === v.id) return false;
    const curDist = Math.hypot(v.px - u.px, v.py - u.py);
    const nextDist = Math.hypot(nx - u.px, ny - u.py);
    if (nextDist > curDist + 1e-6 && (ftx !== u.tile.x || fty !== u.tile.y)) {
      return false;
    }
    return true;
  };
  let other: Vehicle | undefined;
  if (occ) {
    const oFront = occ.get(`${ftx},${fty}`);
    const oCenter = occ.get(`${ntx},${nty}`);
    if (isCandidateBlocking(oFront)) other = oFront;
    else if (isCandidateBlocking(oCenter)) other = oCenter;
  }
  if (!other) {
    for (const u of w.vehicles) {
      if (!isCandidateBlocking(u)) continue;
      const ufx = isManualHuman(u) ? Math.floor(u.px + Math.cos(u.angle) * 0.4) : -1;
      const ufy = isManualHuman(u) ? Math.floor(u.py + Math.sin(u.angle) * 0.4) : -1;
      if (
        (u.tile.x === ftx && u.tile.y === fty) ||
        (u.tile.x === ntx && u.tile.y === nty) ||
        (u.moveTo &&
          ((u.moveTo.x === ftx && u.moveTo.y === fty) ||
            (u.moveTo.x === ntx && u.moveTo.y === nty))) ||
        (isManualHuman(u) && ((ufx === ftx && ufy === fty) || (ufx === ntx && ufy === nty))) ||
        Math.hypot(u.px - nx, u.py - ny) < 0.65
      ) {
        other = u;
        break;
      }
    }
  }
  if (other) {
    if (atBoostRisk || Math.abs(v.speedNow) > 1.65) {
      incident(w, v, other, ftx, fty, atBoostRisk);
    }
    v.speedNow = 0;
    return;
  }
  const s = Math.abs(v.speedNow);
  v.px = nx;
  v.py = ny;
  v.tile = { x: ntx, y: nty };
  if (occ) {
    occ.set(`${ntx},${nty}`, v);
    const fx = Math.floor(v.px + Math.cos(v.angle) * 0.4);
    const fy = Math.floor(v.py + Math.sin(v.angle) * 0.4);
    if (!occ.has(`${fx},${fy}`)) occ.set(`${fx},${fy}`, v);
  }
  const kDrain = K_DRAIN[kindAtTile(w.map, v.tile.x, v.tile.y)];
  const baseDrain = s * dt * 0.032 * kDrain;
  const boostDrain = isBoosting ? dt * 1.15 * kDrain : 0;
  drain(w, v, baseDrain + boostDrain);
}

const dist2 = (v: Vehicle, tx: number, ty: number): number =>
  Math.hypot(v.px - (tx + 0.5), v.py - (ty + 0.5));

export function interactAt(w: World, v: Vehicle) {
  const reach = vehicleReach(w, v);
  let bay: World['map']['bays'][number] | null = null;
  let bd = 1e9;
  for (const b of w.map.bays) {
    for (const t of b.tiles) {
      if (Math.abs(v.px - (t.x + 0.5)) > reach || Math.abs(v.py - (t.y + 0.5)) > reach) continue;
      const d = dist2(v, t.x, t.y);
      if (d < bd) {
        bd = d;
        bay = b;
      }
    }
  }
  let ci = -1;
  let cd = 1e9;
  if (!(bd <= reach && bay)) {
    for (let i = 0; i < w.map.chargers.length; i++) {
      const c = w.map.chargers[i];
      if (Math.abs(v.px - (c.x + 0.5)) > 1.0 || Math.abs(v.py - (c.y + 0.5)) > 1.0) continue;
      const d = dist2(v, c.x, c.y);
      if (d < cd) {
        cd = d;
        ci = i;
      }
    }
  }
  let order: Order | null = null;
  let od = 1e9;
  if (!(bd <= reach && bay) && !(cd <= 1.0 && ci >= 0)) {
    for (const o of w.orders) {
      if (o.state === 'picked' || o.state === 'done') continue;
      if (Math.abs(v.px - (o.slot.ax + 0.5)) > reach || Math.abs(v.py - (o.slot.ay + 0.5)) > reach) continue;
      const d = dist2(v, o.slot.ax, o.slot.ay);
      if (d > reach || d >= od) continue;
      if (reservedAgainst(w, o, v)) continue;
      if (v.isBot && o.claimant && o.claimant !== v.id) {
        const owner = w.vehicles.find((x) => x.id === o.claimant);
        if (owner && isManualHuman(owner) && !owner.isBot) continue;
      }
      od = d;
      order = o;
    }
  }
  const hit =
    bd <= reach && bay
      ? ({ kind: 'drop' as const, bay })
      : cd <= 1.0 && ci >= 0
        ? ({ kind: 'charge' as const, charger: ci })
        : od <= reach && order
          ? ({ kind: 'pick' as const, order })
          : null;
  return { hit, bay, bd, ci, cd, order, od };
}

/** Max game-min between the precision stop and the pick/drop that cashes it in. */
export const PRECISION_WINDOW_MIN = 2.0;

/**
 * Cash in an armed precision stop on a successful pick/drop: the stop point must be
 * inside the reach ring of one of `targets` and within PRECISION_WINDOW_MIN.
 */
function consumePrecisionStop(w: World, v: Vehicle, targets: Point[]): void {
  const a = v.precisionArmed;
  if (!a) return;
  v.precisionArmed = null;
  if (w.t - a.t > PRECISION_WINDOW_MIN) return;
  const reach = vehicleReach(w, v);
  const inRing = targets.some((t) => Math.hypot(a.x - (t.x + 0.5), a.y - (t.y + 0.5)) <= reach);
  if (!inRing) return;
  emit(w, 'precision_stop', `${v.driver || v.id} nailed a Crazy Stop!`, { vid: v.id });
  cardsOnPrecisionStop(w, v);
}

export function humanInteract(w: World, vid: string): void {
  const v = w.vehicles.find((x) => x.id === vid && x.human);
  if (!v || w.t < v.stunnedUntil) return;
  const hint = (text: string) => emit(w, 'hint', text, { vid: v.id });
  const near = interactAt(w, v);
  const bay = near.hit && near.hit.kind === 'drop' ? near.hit.bay : null;
  if (bay) {
    if (!v.cargo.length) {
      hint('Nothing on the forks to drop.');
      return;
    }
    const bayState = w.bays.find((b) => b.id === bay.id);
    if (bayState && w.t < bayState.departUntil) {
      hint('Trailer is away. Wait for the next one to dock.');
      return;
    }
    if (!deliver(w, v, bay.id)) {
      hint(`Wrong bay. Your load goes to ${[...new Set(v.cargo.map((o) => o.bay))].join(', ')}.`);
      return;
    }
    v.fork = 0.55;
    v.forkTarget = 0.15;
    consumePrecisionStop(w, v, bay.tiles);
    return;
  }
  if (near.hit && near.hit.kind === 'charge') {
    v.humanCharging = true;
    v.speedNow = 0;
    const c = w.map.chargers[near.hit.charger];
    v.px = c.x + 0.5;
    v.py = c.y + 0.5;
    v.tile = { x: c.x, y: c.y };
    hint('Charging. Any throttle input stops it.');
    return;
  }
  const o = near.hit && near.hit.kind === 'pick' ? near.hit.order : null;
  if (o) {
    if (v.cargo.length >= capacity(v)) {
      hint('Forks are full (2 pallets max).');
      return;
    }
    if (o.claimant && o.claimant !== v.id) {
      const owner = w.vehicles.find((q) => q.id === o.claimant);
      if (owner) {
        owner.orders = owner.orders.filter((q) => q !== o);
        nextLeg(w, owner);
      }
      emit(w, 'poach', `You took #${o.id} from ${o.claimant} (${owner ? owner.strategy : '?'})`, {
        vid: v.id,
      });
    }
    if (!v.orders.includes(o)) v.orders.push(o);
    o.claimant = v.id;
    o.state = 'picked';
    o.pickedAt = w.t;
    o.parLoaded = parLoadedFor(w, o) ?? undefined;
    v.cargo.push(o);
    v.fork = 0.95;
    v.forkTarget = 0.3;
    consumePrecisionStop(w, v, [{ x: o.slot.ax, y: o.slot.ay }]);
    hint(
      `Picked #${o.id} → bay ${o.bay}${o.p0 ? ' (P0)' : ''}. Due in ${Math.max(0, Math.round(o.due - w.t))} min.`,
    );
    return;
  }
  if (v.isBot) return;
  const g = guide(w, v);
  if (g && g.kind !== 'wait' && g.x != null && g.y != null) {
    const d = Math.hypot(v.px - (g.x + 0.5), v.py - (g.y + 0.5));
    hint(
      `Too far: ${g.kind === 'pick' ? 'the pickup' : g.kind === 'drop' ? `bay ${g.order?.bay}` : 'the charger'} is ${d.toFixed(1)} tiles away. Get within ${vehicleReach(w, v).toFixed(1)} tiles of the glowing ring, then press E.`,
    );
    return;
  }
  hint('Nothing in range. Open pickups appear as amber rings once you have free forks.');
}

// ---------- Difficulty & Voting ----------
export function setDifficulty(w: World, keyOrLevel: DifficultyInput | string): string | null {
  const norm = normalizeDifficulty(keyOrLevel);
  if (!norm) return `Unknown difficulty "${String(keyOrLevel)}"`;
  if (w.difficulty === norm) return null;
  w.difficulty = norm;
  const cfg = DIFFICULTY[norm];
  emit(
    w,
    'difficulty',
    `Difficulty set to ${cfg.label}: demand x${cfg.demand}, deadlines x${cfg.due}, ~${cfg.hazardPerHr} spills/hr.`,
    { difficulty: norm, level: cfg.level },
  );
  return null;
}

export function voteDifficulty(
  w: World,
  clientId: string,
  keyOrLevel: DifficultyInput | string,
): string | null {
  const norm = normalizeDifficulty(keyOrLevel);
  if (!norm) return `Unknown difficulty "${String(keyOrLevel)}"`;
  w.difficultyVotes[clientId] = norm;
  emit(w, 'vote_difficulty', `Vote cast for ${DIFFICULTY[norm].label}.`, {
    clientId,
    difficulty: norm,
  });
  return null;
}

export function resolveDifficultyVotes(w: World): DifficultyKey {
  const entries = Object.entries(w.difficultyVotes);
  if (!entries.length) return w.difficulty;
  const counts: Record<string, number> = {};
  for (const [cid, vote] of entries) {
    if (w.players.size > 0 && !w.players.has(cid)) continue;
    counts[vote] = (counts[vote] || 0) + 1;
  }
  w.difficultyVotes = {};
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return w.difficulty;
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) {
    // Ties keep the current difficulty level
    return w.difficulty;
  }
  const winner = sorted[0][0] as DifficultyKey;
  setDifficulty(w, winner);
  return w.difficulty;
}

// ---------- Spills / Hazards ----------
export const hazardAt = (w: World, x: number, y: number): Hazard | null =>
  w.spills.find((h) => h.x === x && h.y === y) || null;

export function slackOf(w: World, v: Vehicle): number | null {
  const all = [...v.cargo, ...v.orders.filter((o) => !v.cargo.includes(o))];
  if (!all.length) return null;
  return Math.round(Math.min(...all.map((o) => o.due - w.t)) * 10) / 10;
}

export function spawnHazard(w: World, pos?: Point): Hazard | null {
  let tile: Point | null = pos || null;
  if (!tile) {
    const cands = w.vehicles.filter((v) => !isManualHuman(v) && v.path.length >= 4);
    if (cands.length) {
      const v = cands[Math.floor(rng(w) * cands.length)];
      tile = v.path[2] || v.path[0];
    }
  }
  if (!tile) return null;
  const k = keyOf(tile);
  if (
    isBlocked(w, tile.x, tile.y) ||
    bayAt(w.map, tile.x, tile.y) ||
    chargerAt(w.map, tile.x, tile.y) >= 0 ||
    w.cones.has(k) ||
    hazardAt(w, tile.x, tile.y)
  ) {
    return null;
  }
  const [lo, hi] = diffOf(w).hazardTtl;
  const h: Hazard = {
    id: ++w.nextHazardId,
    x: tile.x,
    y: tile.y,
    born: w.t,
    until: w.t + lo + rng(w) * (hi - lo),
  };
  w.spills.push(h);
  w.totals.hazards++;
  emit(
    w,
    'hazard',
    `Spill on aisle tile (${h.x}, ${h.y}); clears in about ${Math.round(h.until - w.t)} min.`,
    { x: h.x, y: h.y, hazardId: h.id },
  );
  return h;
}

export const spawnSpill = spawnHazard;

export function hazardStep(w: World, dt: number): void {
  const D = diffOf(w);
  if (w.phase === 'running' && rng(w) < (D.hazardPerHr / 60) * dt) {
    spawnHazard(w);
  }
  const expiredIds = new Set(w.spills.filter((h) => h.until <= w.t).map((h) => h.id));
  if (expiredIds.size) {
    for (let i = w.spills.length - 1; i >= 0; i--) {
      if (w.spills[i].until <= w.t) w.spills.splice(i, 1);
    }
    w.pendingDecisions = w.pendingDecisions.filter(
      (r) => !(r.kind === 'hazard' && r.context.hazardId && expiredIds.has(r.context.hazardId)),
    );
  }

  if (!w.spills.length) {
    w.vehicles.forEach((v) => {
      v.hold = null;
    });
    return;
  }

  for (const v of w.vehicles) {
    const here = hazardAt(w, v.tile.x, v.tile.y);
    if (v.hold && !w.spills.some((h) => h.id === v.hold)) {
      v.hold = null;
      v.msg = '';
    }
    if (here && !v.hzSeen.has(here.id) && isManualHuman(v)) {
      v.hzSeen.add(here.id);
      if (Math.abs(v.speedNow) > 1.2) {
        v.stunnedUntil = w.t + 3;
        v.speedNow = 0;
        v.sPts -= 5;
        v.skids = (v.skids ?? 0) + 1;
        w.totals.skids = (w.totals.skids ?? 0) + 1;
        resetCombo(w, v, 'skid');
        emit(
          w,
          'hazard',
          `${v.id} skidded on a spill and lost 5 pts. Slow down near yellow patches.`,
          { vid: v.id },
        );
      }
    }
    if (isManualHuman(v)) continue;
    if (here && v.pushing === here.id && !v.skidRolled) {
      v.skidRolled = true;
      if (rng(w) < 0.3) {
        v.stunnedUntil = w.t + 3;
        v.speedNow = 0;
        v.sPts -= 5;
        v.skids = (v.skids ?? 0) + 1;
        w.totals.skids = (w.totals.skids ?? 0) + 1;
        resetCombo(w, v, 'skid');
        if (v.cargo.length && rng(w) < 0.5) {
          const o = v.cargo.shift()!;
          o.state = 'open';
          o.claimant = null;
          v.orders = v.orders.filter((x) => x !== o);
          w.day.damaged++;
          v.palletDrops = (v.palletDrops ?? 0) + 1;
          w.totals.palletDrops = (w.totals.palletDrops ?? 0) + 1;
          nextLeg(w, v);
        }
        emit(w, 'hazard', `${v.id} (${stratOf(v)}) skidded pushing through the spill.`, {
          vid: v.id,
        });
      }
    }
    if (!here && v.pushing) {
      v.pushing = null;
      v.skidRolled = false;
    }
    if (w.t < v.stunnedUntil || !v.path.length) continue;

    // Look up to 3 tiles ahead along the agent's path for spills and emit a hazard DecisionRequest
    for (let i = 0; i < Math.min(3, v.path.length); i++) {
      const step = v.path[i];
      const h = hazardAt(w, step.x, step.y);
      if (h && !v.hzSeen.has(h.id)) {
        emitHazardRequestIfNeeded(w, v, h);
        break;
      }
    }
  }

  if (Math.round(w.t * 10) % 300 === 0) {
    w.vehicles.forEach((v) =>
      v.hzSeen.forEach((id) => {
        if (!w.spills.some((h) => h.id === id)) v.hzSeen.delete(id);
      }),
    );
  }
}

// ---------- Shift / day rollover ----------
const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));

export function leaderboard(w: World) {
  return w.vehicles
    .filter((v) => !v.isBot)
    .map((v) => ({
      id: v.id,
      strat: stratOf(v),
      pts: v.sPts,
      shipped: v.sShipped,
      human: v.human,
      driver: v.driver,
      type: v.type,
    }))
    .sort((a, b) => b.pts - a.pts);
}

function onShiftEnd(w: World): void {
  cardsResolveShift(w);
  const lb = leaderboard(w);
  const lbl = shiftName(w.t - 1);
  emit(
    w,
    'shift',
    `Shift ${lbl} final: ${lb
      .slice(0, 3)
      .map((r) => `${r.id} ${Math.round(r.pts)}`)
      .join(', ')}.`,
  );
  lb.forEach((r, i) => {
    if (!r.human) return;
    w.totals.humanShifts++;
    if (i === 0) w.totals.wins++;
    emit(
      w,
      'shift',
      `${r.driver === 'you' ? 'You' : r.driver} finished #${i + 1} of ${lb.length} in ${r.id} with ${Math.round(r.pts)} pts${i === 0 ? '. Shift win!' : '.'}`,
      { vid: r.id },
    );
  });
  const D = diffOf(w);
  const shiftLabel = `Day ${dayIndex(w.t - 1) + 1} · Shift ${lbl}`;
  const hallRows = [lb[0], lb.find((r) => r.human)].filter(
    (r, i, a): r is NonNullable<typeof r> => !!r && r.pts > 0 && a.indexOf(r) === i,
  );
  hallRows.forEach((r) =>
    w.hallOfFame.push({
      shift: shiftLabel,
      id: r.id,
      strat: r.strat,
      human: r.human,
      driver: r.driver,
      pts: Math.round(r.pts),
      scored: Math.round(r.pts * D.score),
      diff: w.difficulty,
    }),
  );
  w.hallOfFame.sort((a, b) => b.scored - a.scored);
  if (w.hallOfFame.length > 10) w.hallOfFame.length = 10;

  w.vehicles.forEach((v) => {
    v.bank += v.sPts;
    if (v.human && v.runMode === 'blitz' && !v.runFinished) return;
    v.sPts = 0;
    v.sShipped = 0;
  });

  // Apply difficulty votes at shift change
  resolveDifficultyVotes(w);

  // Emit tactics DecisionRequests for Strategist / tunable AI agents instead of rule-based retune
  w.vehicles.forEach((v) => {
    if (!isManualHuman(v) && v.strategy === 'Strategist') {
      emitTacticsRequest(w, v);
    }
  });

  w.shift = emptyStats();
  w.shiftTime = 0;
}

function onDayEnd(w: World, idx: number): void {
  const d = w.day;
  const per = {} as DayHistoryEntry['per'];
  STRAT_ORDER.forEach((s) => {
    const b = d.byStrat[s];
    per[s] = {
      shipped: b.shipped,
      onTimePct: b.shipped ? Math.round((100 * b.onTime) / b.shipped) : null,
      incidents: b.incidents,
      kwhPerOrder: b.shipped ? +(b.kwh / b.shipped).toFixed(2) : null,
    };
  });
  const ai = (STRAT_ORDER.slice(0, 5) as Archetype[]).sort(
    (a, b) =>
      per[b].shipped - 2 * per[b].incidents - (per[a].shipped - 2 * per[a].incidents),
  );
  const onTimePct = d.shipped ? Math.round((100 * d.onTime) / d.shipped) : null;
  w.history.push({
    day: idx + 1,
    shipped: d.shipped,
    onTimePct,
    incidents: d.incidents,
    nearMisses: d.nearMisses,
    lost: d.lost,
    damaged: d.damaged,
    poaches: d.poaches,
    per,
    winner: ai[0],
    tuned: { ...w.tuned },
  });
  w.totals.days++;
  emit(
    w,
    'day',
    `Day ${idx + 1} closed: ${d.shipped} shipped, ${onTimePct ?? '—'}% on time, ${d.incidents} incidents. Best strategy: ${ai[0]}.`,
  );
  w.day = emptyStats();
}

// ---------- Factory Break Phases ----------
export function setPhase(w: World, p: Phase): void {
  if (w.phase === p) return;
  const prev = w.phase;
  w.phase = p;
  if (p === 'winding_down') {
    w.pendingDecisions = [];
    for (const v of w.vehicles) {
      if (isManualHuman(v)) continue;
      nextLeg(w, v);
    }
    emit(w, 'phase', `Factory winding down for break at ${clockText(w.t)}.`, {
      from: prev,
      phase: p,
    });
  } else if (p === 'break') {
    w.pendingDecisions = [];
    compactFacilityIfNeeded(w);
    emit(w, 'phase', `Factory break started at ${clockText(w.t)}.`, {
      from: prev,
      phase: p,
    });
  } else if (p === 'resuming') {
    w.resumeCountdown = 10;
    emit(w, 'phase', `Shift resumes in 10 s.`, { from: prev, phase: p, resumesIn: 10 });
  } else if (p === 'running') {
    w.resumeCountdown = 0;
    for (const v of w.vehicles) {
      if (!isManualHuman(v) && v.state === 'parked') {
        v.state = 'idle';
        v.idleSince = w.t;
      }
    }
    emit(w, 'phase', `Factory shift running at ${clockText(w.t)}.`, {
      from: prev,
      phase: p,
    });
  }
}

// ---------- Contract & Skill Cards ----------
function mkRoute(
  w: World,
  zone: string,
  bayId: string,
  n: number,
  starter?: boolean,
): Card {
  const far = w.map.zoneFar[zone] ?? 20;
  const kind = w.map.zoneKind[zone] ?? 'ambient';
  const dist = w.map.w - 2 - far;
  return {
    id: `c${++w.cardSeq}`,
    type: 'route',
    zone,
    bay: bayId,
    goal: n,
    progress: 0,
    status: 'offer',
    starter: !!starter,
    pts: starter ? 10 : 10 + Math.round(dist / 3) + KINDS[kind].bonus,
    title: `${n > 1 ? n + ' pallets' : '1 pallet'}: Zone ${zone} (${KINDS[kind].short}) → Bay ${bayId}`,
    desc: `${starter ? 'Starter. ' : ''}Purple pallets are reserved for you for ${CONTRACT_RESERVE_MIN} min, then rivals can poach them.`,
    rarity: 'common',
    perk: { reachBonus: 0.1 },
    modifiers: { reachBonus: 0.1 },
  };
}

interface SkillTemplate {
  type: Card['type'];
  goal: number;
  pts: number;
  title: string;
  desc: string;
  /** Perk granted once the card is completed (wild cards have none). */
  perk?: CardPerk;
  /**
   * Legacy active modifiers (no perk): apply while the card is active, as before
   * the fare/perk rework. Used by the user-added cards below.
   */
  modifiers?: Partial<CardModifiers>;
  rarity?: CardRarity;
  /** Never dealt to AI agents. */
  humanOnly?: boolean;
  feasible?: (w: World) => boolean;
}

/** Flat bonus per Speedy trip inside the Last Call window. */
export const LAST_CALL_PTS = 10;

const batchFeasible = (w: World): boolean => {
  const c: Record<string, number> = {};
  w.orders.forEach((o) => {
    if (o.state !== 'picked') c[o.bay] = (c[o.bay] || 0) + 1;
  });
  return Object.values(c).some((n) => n >= 2);
};

/**
 * Dealable skill cards. Goals are about how you drive; the perk is the reward and
 * only applies once the card is done. Phase-3 types (long_haul, local_hero, poacher,
 * rival_grudge, ghost_hunter) are typed but intentionally not in this pool.
 */
export const SKILLS: SkillTemplate[] = [
  {
    type: 'quick',
    goal: 2,
    pts: 20,
    title: 'Speed Demon',
    desc: 'Land 2 Speedy deliveries (≤ 0.8× par). Perk: +8% speed.',
    perk: { speedMul: 1.08 },
  },
  {
    type: 'ontime',
    goal: 5,
    pts: 25,
    title: 'No Slowpokes',
    desc: '5 deliveries in a row without a Slow rating (a Slow resets progress). Perk: +5% speed, +0.1 reach.',
    perk: { speedMul: 1.05, reachBonus: 0.1 },
  },
  {
    type: 'batch',
    goal: 1,
    pts: 20,
    title: 'Carpool',
    desc: 'Deliver 2+ pallets to the same bay in one drop. Perk: +0.2 reach.',
    perk: { reachBonus: 0.2 },
    feasible: batchFeasible,
  },
  {
    type: 'clean',
    goal: 1,
    pts: 20,
    title: 'Clean Shift',
    desc: 'Finish the run without causing a crash. Perk: −15% battery drain.',
    perk: { batteryDrainMul: 0.85 },
  },
  {
    type: 'charge',
    goal: 1,
    pts: 15,
    title: 'Juice Saver',
    desc: 'Finish the run above 40% battery. Perk: −15% battery drain.',
    perk: { batteryDrainMul: 0.85 },
  },
  {
    type: 'overdrive',
    goal: 2,
    pts: 10,
    title: 'Overdrive',
    desc: 'Deliver 2 pallets. Perk: +15% speed.',
    perk: { speedMul: 1.15 },
  },
  {
    type: 'long_reach',
    goal: 2,
    pts: 10,
    title: 'Long Reach',
    desc: 'Deliver 2 pallets. Perk: +0.35 tile pick/drop reach.',
    perk: { reachBonus: 0.35 },
  },
  {
    type: 'eco_cell',
    goal: 2,
    pts: 10,
    title: 'Eco Cell',
    desc: 'Deliver 2 pallets. Perk: −25% battery drain.',
    perk: { batteryDrainMul: 0.75 },
  },
  {
    type: 'trailer_closer',
    goal: 2,
    pts: 25,
    title: 'Trailer Closer',
    desc: `Drop the pallet that fills a trailer, twice (+${TRAILER_CLOSER_PTS} pts and a combo step each time). Perk: +0.1 reach.`,
    perk: { reachBonus: 0.1 },
  },
  {
    type: 'crazy_stop',
    goal: 3,
    pts: 15,
    title: 'Crazy Stop',
    desc: `Brake hard from top speed (>${PRECISION_FROM_SPEED}) to a stop (<${PRECISION_TO_SPEED}) inside the reach ring, then pick or drop. 3 times. Perk: forks work 1.5× faster.`,
    perk: { forkLiftMul: 1.5 },
    humanOnly: true,
  },
  {
    type: 'combo_king',
    goal: 1,
    pts: 30,
    title: 'Combo King',
    desc: 'Reach a ×2.0 combo. Perk: your combo never resets below ×1.2.',
    perk: { comboFloor: 1 },
    humanOnly: true,
  },
  {
    type: 'beat_planner',
    goal: 3,
    pts: 30,
    title: 'Beat the Planner',
    desc: 'Finish 3 loaded legs in ≤ 0.8× the planner’s par time. Perk: +0.15 reach.',
    perk: { reachBonus: 0.15 },
    humanOnly: true,
  },
  {
    type: 'high_roller',
    goal: 4,
    pts: 20,
    title: 'High Roller',
    desc: `Wild. +${Math.round(HIGH_ROLLER_BONUS * 100)}% trip points while active; 4 deliveries without a crash pays +20. A crash costs an extra ${INCIDENT_PENALTY} pts and burns the card.`,
    perk: {},
    rarity: 'wild',
  },
  {
    type: 'double_nothing',
    goal: 3,
    pts: 40,
    title: 'Double or Nothing',
    desc: 'Wild. 3 Speedy deliveries in a row pays +40. Any non-Speedy delivery burns the card.',
    perk: {},
    rarity: 'wild',
  },
  {
    type: 'last_call',
    goal: 1,
    pts: 0,
    title: 'Last Call',
    desc: `Wild. +${LAST_CALL_PTS} pts per Speedy delivery in the final ${LAST_CALL_MIN} min of the run. Burns if you land none.`,
    perk: {},
    rarity: 'wild',
  },
  // User-added cards: legacy active `modifiers` (no perk), restored as originally written.
  {
    type: 'quick',
    goal: 2,
    pts: 25,
    title: 'Turbo Courier',
    desc: 'Deliver 2 pallets within 6 min of pickup (+18% speed, +4 pts/order).',
    modifiers: { speedMul: 1.18, ptsBonus: 4 },
  },
  {
    type: 'batch',
    goal: 1,
    pts: 20,
    title: 'Tele-Fork Extension',
    desc: 'Deliver a 2-pallet batch (+0.55 tile pickup/drop reach, +2%/s charge).',
    modifiers: { reachBonus: 0.55, chargeBonus: 2 },
    feasible: batchFeasible,
  },
  {
    type: 'charge',
    goal: 1,
    pts: 15,
    title: 'Regen Capacitor',
    desc: 'Stay above 40% battery (-35% boost drain, +4%/s charger speed).',
    modifiers: { drainMul: 0.65, chargeBonus: 4 },
  },
  {
    type: 'ontime',
    goal: 3,
    pts: 30,
    title: 'Priority Broker',
    desc: 'Deliver 3 on-time pallets (+12 pts on P0 orders, +3 pts on all orders).',
    modifiers: { p0Bonus: 12, ptsBonus: 3 },
  },
];

const mkSkill = (w: World, s: SkillTemplate): Card => ({
  id: `c${++w.cardSeq}`,
  type: s.type,
  goal: s.goal,
  progress: 0,
  status: 'offer',
  pts: s.pts,
  title: s.title,
  desc: s.desc,
  rarity: s.rarity ?? 'common',
  ...(s.humanOnly ? { humanOnly: true } : {}),
  ...(s.perk
    ? { perk: { ...s.perk }, modifiers: { ...s.perk } }
    : { modifiers: { ...s.modifiers } }),
});

export function dealCards(w: World, player = 'you', isRedraw = false) {
  const h = (w.cards[player] ??= { shift: -1, offer: null, cards: [] });
  const si = shiftIndex(w.t);
  if (!isRedraw) {
    if (h.shift === si && (h.offer || h.cards.length)) return h;
    h.shift = si;
    h.cards = [];
  } else {
    if (h.offer) return h;
    h.shift = si;
  }
  const activeTitles = new Set(
    h.cards.filter((c) => c.status === 'active').map((c) => c.title),
  );
  const offer: Card[] = [];
  const pool: Array<() => Card> = [];
  const zones = Object.keys(w.map.zoneFar);
  if (!isRedraw && w.totals.cardDeals === 0 && zones.includes('U')) {
    offer.push(mkRoute(w, 'U', 'E5', 1, true));
  }
  const regularBays = w.map.bays.filter((b) => !b.isTransferBay && b.id !== 'RET');
  const bayPool = regularBays.length ? regularBays : w.map.bays;
  for (let i = 0; i < 2 && zones.length > 0; i++) {
    pool.push(() => {
      const z = zones.splice(Math.floor(rng(w) * zones.length), 1)[0] || 'A';
      const b = bayPool[Math.floor(rng(w) * bayPool.length)].id;
      return mkRoute(w, z, b, 2);
    });
  }
  SKILLS.forEach((s) => {
    if (s.rarity === 'wild') return;
    if (activeTitles.has(s.title)) return;
    if (!s.feasible || s.feasible(w)) pool.push(() => mkSkill(w, s));
  });
  // Replacement draws (after a card completes / is lost) offer 1-of-2.
  const size = isRedraw ? 2 : 3;
  const holdsWild = h.cards.some((c) => c.status === 'active' && c.rarity === 'wild');
  const wilds = SKILLS.filter((s) => s.rarity === 'wild' && !activeTitles.has(s.title));
  const wildSlot = !holdsWild && wilds.length > 0 && rng(w) < WILD_CHANCE;
  while (offer.length < size - (wildSlot ? 1 : 0) && pool.length) {
    offer.push(pool.splice(Math.floor(rng(w) * pool.length), 1)[0]());
  }
  if (wildSlot) offer.push(mkSkill(w, wilds[Math.floor(rng(w) * wilds.length)]));
  h.offer = offer;
  if (isRedraw) h.pick = 1;
  else delete h.pick;
  w.totals.cardDeals++;
  emit(
    w,
    'card',
    isRedraw
      ? 'Replacement card offer ready: pick 1 of 2.'
      : 'New contract cards dealt. Keep at least one.',
    { player },
  );
  return h;
}

export function keepCards(w: World, player: string, ids: string[]): string | null {
  const h = w.cards[player];
  if (!h || !h.offer) return 'No cards to keep.';
  const keep = h.offer.filter((c) => ids.includes(c.id));
  if (!keep.length) return 'Keep at least one card.';
  if (h.pick != null && keep.length > h.pick) return `Pick at most ${h.pick} card${h.pick === 1 ? '' : 's'}.`;
  const activeNow = h.cards.filter((c) => c.status === 'active');
  if (activeNow.length + keep.length > HAND_LIMIT) {
    return `Hand limit is ${HAND_LIMIT} active cards.`;
  }
  const wildsHeld = activeNow.filter((c) => c.rarity === 'wild').length;
  if (wildsHeld + keep.filter((c) => c.rarity === 'wild').length > 1) {
    return 'You can hold at most one wild card.';
  }
  h.offer = null;
  delete h.pick;
  keep.forEach((c) => {
    c.status = 'active';
    if (c.type === 'route' && c.zone && c.bay) {
      let n = 0;
      for (let i = 0; i < c.goal; i++) {
        const o = postOrder(w, { zone: c.zone, bayId: c.bay, card: c.id });
        if (o) {
          // Reserved for the card owner; rivals may poach after the window.
          o.reservedFor = player;
          o.reservedUntil = Math.round((w.t + CONTRACT_RESERVE_MIN) * 100) / 100;
          n++;
        }
      }
      if (!n) {
        emit(w, 'card', `No free pickup slot in Zone ${c.zone}, so "${c.title}" was voided.`);
        return;
      }
      c.goal = n;
    }
    h.cards.push(c);
  });
  const dv = w.vehicles.find(
    (v) => v.human && (v.controlledByClientId === player || v.driver === player),
  );
  if (dv && dv.runMode === 'blitz' && dv.runStartedAt === null) {
    dv.runStartedAt = w.t;
    dv.runEndsAt = Math.round((w.t + BLITZ_DURATION_MIN) * 10) / 10;
    dv.runGraceUntil = null;
  }
  emit(w, 'card', `Contracts accepted: ${keep.map((c) => c.title).join(' · ')}`, { player });
  return null;
}

export function dealShiftCards(w: World, targetAgentId?: string): DecisionRequest[] {
  const si = shiftIndex(w.t);
  const requests: DecisionRequest[] = [];
  const agents = targetAgentId
    ? w.vehicles.filter((v) => v.id === targetAgentId && !v.human)
    : w.vehicles.filter((v) => !v.human);

  if (!targetAgentId) {
    if (w.aiShift === si) return requests;
    w.aiShift = si;
  }

  for (const v of agents) {
    if (v.brainError) continue;
    const h = (w.cards[v.id] ??= { shift: -1, offer: null, cards: [], ai: true });
    if (!targetAgentId && h.shift === si && (h.offer || h.cards.length)) continue;
    h.shift = si;
    h.cards = [];
    // humanOnly cards (built around beating the planner) are never dealt to AI.
    const pool = SKILLS.filter(
      (s) => !s.humanOnly && s.rarity !== 'wild' && (!s.feasible || s.feasible(w)),
    );
    const wilds = SKILLS.filter((s) => !s.humanOnly && s.rarity === 'wild');
    const wildSlot = wilds.length > 0 && rng(w) < WILD_CHANCE;
    const draw: Card[] = [];
    while (draw.length < 3 - (wildSlot ? 1 : 0) && pool.length) {
      const s = pool.splice(Math.floor(rng(w) * pool.length), 1)[0];
      draw.push(mkSkill(w, s));
    }
    if (wildSlot) draw.push(mkSkill(w, wilds[Math.floor(rng(w) * wilds.length)]));
    if (!draw.length) continue;
    h.offer = draw;

    // Remove any older pending card requests for this agent
    w.pendingDecisions = w.pendingDecisions.filter(
      (r) => !(r.agentId === v.id && r.kind === 'cards'),
    );

    const options: CardOption[] = draw.map((c) => ({
      id: c.id,
      cardType: c.type,
      pts: c.pts,
      goal: c.goal,
      title: c.title,
      desc: c.desc,
      modifiers: c.modifiers,
      rarity: c.rarity,
      perk: c.perk,
    }));

    const req: DecisionRequest = {
      id: `req-${++w.nextDecisionSeq}`,
      agentId: v.id,
      kind: 'cards',
      tIssued: w.t,
      deadline: Math.round((w.t + 60) * 10) / 10,
      persona: v.strategy,
      context: buildAgentContext(w, v),
      options,
    };
    w.pendingDecisions.push(req);
    requests.push(req);
  }
  return requests;
}

export const aiDealCards = dealShiftCards;

const activeCardIds = (w: World, player: string | null): string[] => {
  if (!player) return [];
  return ((w.cards[player] && w.cards[player].cards) || [])
    .filter((c) => c.status === 'active')
    .map((c) => c.id);
};

const handKey = (v: Vehicle): string =>
  v.human ? v.controlledByClientId || v.driver || v.id : v.id;

/** Does this vehicle drive for the given hand key (player / agent id)? */
function ownsHandKey(v: Vehicle, key: string | null | undefined): boolean {
  if (!key) return false;
  return (
    handKey(v) === key ||
    v.controlledByClientId === key ||
    v.driver === key ||
    v.id === key
  );
}

/**
 * True while a route-card pallet is still reserved for someone other than `v`
 * (CONTRACT_RESERVE_MIN after the card was kept). Reserved pallets can't be
 * claimed or picked by rivals; after the window a rival delivery is a poach.
 */
export function reservedAgainst(w: World, o: Order, v: Vehicle): boolean {
  if (!o.reservedFor || o.reservedUntil == null) return false;
  if (w.t >= o.reservedUntil) return false;
  return !ownsHandKey(v, o.reservedFor);
}

/** The active-or-not card (and its hand key) that a route pallet belongs to. */
function cardOwnerOf(w: World, cardId: string): { key: string; card: Card } | null {
  for (const [key, h] of Object.entries(w.cards)) {
    const card = h.cards.find((c) => c.id === cardId);
    if (card) return { key, card };
  }
  return null;
}

/** Per-pallet delivery record handed to card progress. */
interface DeliverRec {
  o: Order;
  onTime: boolean;
  trip: number;
  rating?: FareRating;
  /** Loaded leg finished in ≤ SPEEDY_RATIO × par (ignores lateness). */
  beatPar?: boolean;
  /** This pallet filled (closed) a regular trailer. */
  closer?: boolean;
}

/** Card types whose goal is simply "deliver N pallets". */
const PLAIN_DELIVERY_CARDS = new Set<string>(['overdrive', 'long_reach', 'eco_cell', 'high_roller']);
const KNOWN_CARD_TYPES = new Set<string>(CARD_TYPE_IDS);

/** Inside the Last Call window: final LAST_CALL_MIN of a blitz run, else of the 480-min shift. */
export function inLastCall(w: World, v: Vehicle): boolean {
  if (v.runMode === 'blitz') {
    return v.runEndsAt != null && w.t >= v.runEndsAt - LAST_CALL_MIN && w.t <= v.runEndsAt;
  }
  return w.t - shiftIndex(w.t) * 480 >= 480 - LAST_CALL_MIN;
}

function finishCard(w: World, c: Card, v: Vehicle): void {
  c.status = 'done';
  c.completedAt = w.t;
  v.sPts += c.pts;
  v.runPts = (v.runPts ?? 0) + c.pts;
  if (v.human) {
    w.totals.cardsDone++;
    emit(w, 'card', `Contract done: ${c.title}. +${c.pts} pts (perk unlocked!)`, { vid: v.id });
  } else {
    w.totals.aiCardsDone++;
  }
}

function loseCard(w: World, c: Card, v: Vehicle, why: string): void {
  c.status = 'lost';
  if (v.human) emit(w, 'card', `Contract failed: ${c.title}. ${why}`, { vid: v.id, cardId: c.id });
}

/**
 * Replacement draw: when a human's hand drops below HAND_LIMIT active cards and no
 * offer is pending, offer 1-of-2 (kept through `keepCards`).
 */
function autoRedrawIfNeeded(w: World, v: Vehicle | undefined): void {
  if (!v || !v.human || v.runFinished) return;
  const key = handKey(v);
  const h = w.cards[key] || (v.driver ? w.cards[v.driver] : undefined);
  if (!h || h.offer) return;
  const activeCount = h.cards.filter((c) => c.status === 'active').length;
  if (activeCount < HAND_LIMIT) {
    dealCards(w, w.cards[key] ? key : (v.driver as string), true);
  }
}

function cardsOnDeliver(w: World, v: Vehicle, recs: DeliverRec[]): void {
  const h = w.cards[handKey(v)] || (v.driver ? w.cards[v.driver] : undefined);
  if (!h) return;
  let changedAny = false;
  h.cards.forEach((c) => {
    if (c.status !== 'active') return;
    switch (c.type) {
      case 'route':
        c.progress += recs.filter((r) => r.o.card === c.id).length;
        break;
      case 'batch':
        if (recs.length >= 2) c.progress = c.goal;
        break;
      case 'ontime':
        if (!c.perk) {
          // Legacy card (e.g. Priority Broker): cumulative on-time deliveries.
          c.progress += recs.filter((r) => r.onTime).length;
          break;
        }
        // No Slowpokes: consecutive non-Slow deliveries; a Slow resets progress.
        for (const r of recs) {
          if (r.rating === 'slow' || (!r.rating && !r.onTime)) c.progress = 0;
          else c.progress++;
          if (c.progress >= c.goal) break;
        }
        break;
      case 'quick':
        if (!c.perk) {
          // Legacy card (e.g. Turbo Courier): delivered within N min of pickup.
          const maxTrip = c.title === 'Turbo Courier' ? 6 : 8;
          c.progress += recs.filter((r) => r.trip <= maxTrip).length;
          break;
        }
        c.progress += recs.filter((r) => r.rating === 'speedy').length;
        break;
      case 'trailer_closer':
        c.progress += recs.filter((r) => r.closer).length;
        break;
      case 'beat_planner':
        c.progress += recs.filter((r) => r.beatPar).length;
        break;
      case 'double_nothing':
        for (const r of recs) {
          if (r.rating !== 'speedy') {
            loseCard(w, c, v, 'A non-Speedy delivery burned the gamble.');
            changedAny = true;
            return;
          }
          c.progress++;
          if (c.progress >= c.goal) break;
        }
        break;
      case 'last_call': {
        if (!inLastCall(w, v)) return;
        const n = recs.filter((r) => r.rating === 'speedy').length;
        if (n > 0) {
          c.progress += n;
          const pts = n * LAST_CALL_PTS;
          v.sPts += pts;
          v.runPts = (v.runPts ?? 0) + pts;
          emit(w, 'card', `Last Call: +${pts} pts`, { vid: v.id, cardId: c.id, pts });
        }
        // Resolved at run / shift end, never by goal.
        return;
      }
      default:
        if (PLAIN_DELIVERY_CARDS.has(c.type) || !KNOWN_CARD_TYPES.has(c.type)) {
          // Plain "deliver N" cards (and legacy pre-fare card types from old snapshots).
          c.progress += recs.length;
        }
        // clean / charge / crazy_stop / combo_king progress elsewhere.
        break;
    }
    if (c.status === 'active' && c.progress >= c.goal) {
      finishCard(w, c, v);
      changedAny = true;
    }
  });
  if (changedAny) {
    autoRedrawIfNeeded(w, v);
  }
}

function cardsOnCrash(w: World, v: Vehicle): void {
  const h = w.cards[handKey(v)] || (v.driver ? w.cards[v.driver] : undefined);
  if (!h) return;
  let lostAny = false;
  h.cards.forEach((c) => {
    if (c.status !== 'active') return;
    if (c.type === 'clean') {
      loseCard(w, c, v, 'You caused a crash.');
      lostAny = true;
    } else if (c.type === 'high_roller') {
      // The gamble: a crash costs an extra incident penalty and burns the card.
      v.sPts -= INCIDENT_PENALTY;
      v.runPts = (v.runPts ?? 0) - INCIDENT_PENALTY;
      loseCard(w, c, v, `Crash! High Roller burned (−${INCIDENT_PENALTY} pts).`);
      lostAny = true;
    }
  });
  if (lostAny) {
    autoRedrawIfNeeded(w, v);
  }
}

/** Crazy Stop progress: a precision stop followed by a pick or drop. */
function cardsOnPrecisionStop(w: World, v: Vehicle): void {
  const h = w.cards[handKey(v)] || (v.driver ? w.cards[v.driver] : undefined);
  if (!h) return;
  let completedAny = false;
  h.cards.forEach((c) => {
    if (c.status !== 'active' || c.type !== 'crazy_stop') return;
    c.progress++;
    if (c.progress >= c.goal) {
      finishCard(w, c, v);
      completedAny = true;
    }
  });
  if (completedAny) autoRedrawIfNeeded(w, v);
}

/** Resolve end-of-run gambles: Last Call is done if it paid out at least once. */
function resolveRunEndCard(w: World, c: Card, v: Vehicle): boolean {
  if (c.type !== 'last_call') return false;
  if (c.progress > 0) {
    c.status = 'done';
    c.completedAt = w.t;
    if (v.human) w.totals.cardsDone++;
    else w.totals.aiCardsDone++;
  } else {
    c.status = 'expired';
  }
  return true;
}

function cardsOnComboMax(w: World, v: Vehicle): void {
  const h = w.cards[handKey(v)] || (v.driver ? w.cards[v.driver] : undefined);
  if (!h) return;
  let completedAny = false;
  h.cards.forEach((c) => {
    if (c.status === 'active' && c.type === 'combo_king') {
      c.progress = c.goal;
      finishCard(w, c, v);
      completedAny = true;
    }
  });
  if (completedAny) {
    autoRedrawIfNeeded(w, v);
  }
}

function cardsTick(w: World): void {
  Object.entries(w.cards).forEach(([player, h]) => {
    let lostAny = false;
    h.cards.forEach((c) => {
      if (c.status !== 'active' || c.type !== 'route') return;
      // Fallback only: rival deliveries are handled (with a `poach` event) in deliver().
      // This catches pallets that vanished another way (shift reset, compaction).
      const left = w.orders.filter((o) => o.card === c.id).length;
      if (c.progress + left < c.goal) {
        c.status = 'lost';
        lostAny = true;
        emit(
          w,
          'card',
          `Contract lost: ${c.title}. Its pallets are no longer available.`,
        );
      }
    });
    if (lostAny) {
      const dv = w.vehicles.find(
        (v) => v.human && (v.controlledByClientId === player || v.driver === player),
      );
      autoRedrawIfNeeded(w, dv);
    }
  });
}

function cardsResolveShift(w: World): void {
  Object.entries(w.cards).forEach(([player, h]) => {
    const dv = w.vehicles.find(
      (v) =>
        (v.human && (v.controlledByClientId === player || v.driver === player)) ||
        (!v.human && v.id === player),
    );
    const human = !!(dv && dv.human);
    // Blitz human drivers have personal 5-min timers isolated from global 480-min shift boundaries
    if (human && dv?.runMode === 'blitz') return;
    h.cards.forEach((c) => {
      if (c.status !== 'active') return;
      if (dv && resolveRunEndCard(w, c, dv)) return;
      if (c.type === 'clean' && dv) finishCard(w, c, dv);
      else if (c.type === 'charge' && dv && dv.battery >= 40) finishCard(w, c, dv);
      else {
        c.status = 'expired';
        if (human || !dv) emit(w, 'card', `Contract expired: ${c.title}.`);
      }
    });
    h.offer = null;
  });
  w.orders.forEach((o) => {
    if (!o.card) return;
    // Keep route card tags on orders belonging to active Blitz human drivers
    const belongsToBlitzHuman = Object.entries(w.cards).some(([player, h]) => {
      const dv = w.vehicles.find(
        (v) => v.human && (v.controlledByClientId === player || v.driver === player),
      );
      return dv?.runMode === 'blitz' && h.cards.some((c) => c.id === o.card && c.status === 'active');
    });
    if (!belongsToBlitzHuman) o.card = null;
  });
  Object.keys(w.cards).forEach((p) => {
    const dv = w.vehicles.find(
      (v) => v.human && (v.controlledByClientId === p || v.driver === p),
    );
    if (dv && dv.runMode !== 'blitz') {
      dealCards(w, p);
    }
  });
}

function sampleValue(w: World): void {
  let ai = 0;
  let best = 0;
  for (const v of w.vehicles) {
    const tot = v.bank + v.sPts;
    const d = tot - v.lastTot;
    v.lastTot = tot;
    if (v.human) w.humanValue += d;
    else {
      v.aiValue += d;
      w.agentValue += d;
      ai++;
    }
  }
  w.vehicles.forEach((v) => {
    if (!v.human && v.aiValue > best) best = v.aiValue;
  });
  w.valueSeries.push({
    t: w.t,
    you: Math.round(w.humanValue),
    avg: Math.round(w.agentValue / Math.max(1, ai)),
    best: Math.round(best),
  });
  if (w.valueSeries.length > 300) w.valueSeries.shift();
}

export function guide(w: World, v: Vehicle | null | undefined) {
  if (!v) return null;
  if (v.battery < 20 && !v.cargo.length) {
    const taken = new Set(
      w.vehicles.filter((x) => x !== v && x.chargerIdx >= 0).map((x) => x.chargerIdx),
    );
    let best: Point | null = null;
    let bd = 1e9;
    w.map.chargers.forEach((c, i) => {
      if (taken.has(i)) return;
      const d = manhattan(v.tile.x, v.tile.y, c.x, c.y);
      if (d < bd) {
        bd = d;
        best = c;
      }
    });
    if (best) {
      const nh = interactAt(w, v).hit;
      const ready = !!nh && nh.kind === 'charge';
      return {
        kind: 'charge' as const,
        x: (best as Point).x,
        y: (best as Point).y,
        text: ready
          ? 'On a charger: press E to charge'
          : 'Battery low: park on a charger, press E',
        inRange: ready,
      };
    }
  }
  if (v.cargo.length) {
    const o = v.cargo[0];
    const bay = w.map.bays.find((b) => b.id === o.bay) || w.map.bays[0];
    const dt = dropTile(w, bay, v.tile.x, v.tile.y);
    const nh = interactAt(w, v).hit;
    const ready = !!nh && nh.kind === 'drop' && nh.bay.id === bay.id;
    return {
      kind: 'drop' as const,
      x: dt.x,
      y: dt.y,
      text: ready
        ? `In range of bay ${bay.id}: press E to deliver`
        : `Deliver to bay ${bay.id}, then press E`,
      order: o,
      inRange: ready,
    };
  }
  const mine = new Set([
    ...activeCardIds(w, v.controlledByClientId || null),
    ...activeCardIds(w, v.driver),
  ]);
  let best: Order | null = null;
  if (isManualHuman(v) && !v.isBot && v.orders.length > 0) {
    const cur = v.orders[0];
    if (
      cur &&
      cur.state !== 'picked' &&
      cur.state !== 'done' &&
      (!cur.claimant || cur.claimant === v.id) &&
      w.orders.includes(cur)
    ) {
      best = cur;
    }
  }
  if (!best) {
    let bs = 1e9;
    const otherHumans = w.vehicles.filter(
      (x) => x !== v && isManualHuman(x) && x.cargo.length === 0 && (v.isBot || !x.isBot),
    );
    w.orders.forEach((o) => {
      if (o.state === 'picked' || o.state === 'done') return;
      if (reservedAgainst(w, o, v)) return;
      if (o.claimant && o.claimant !== v.id) {
        const owner = w.vehicles.find((x) => x.id === o.claimant);
        if (owner && isManualHuman(owner) && !owner.isBot) return;
      }
      let humanCrowdPenalty = 0;
      const myDist = manhattan(v.tile.x, v.tile.y, o.slot.ax, o.slot.ay);
      for (const oh of otherHumans) {
        const ohDist = manhattan(oh.tile.x, oh.tile.y, o.slot.ax, o.slot.ay);
        if (ohDist < myDist || (ohDist === myDist && oh.id < v.id)) {
          humanCrowdPenalty += 18;
        }
      }
      const sc =
        myDist -
        (o.p0 ? 20 : 0) -
        (o.card && mine.has(o.card) ? 25 : 0) +
        (o.claimant && o.claimant !== v.id ? 8 : 0) +
        humanCrowdPenalty;
      if (sc < bs) {
        bs = sc;
        best = o;
      }
    });
    if (best && isManualHuman(v) && !v.isBot) {
      const chosenOrder: Order = best;
      v.orders = [chosenOrder];
      chosenOrder.claimant = v.id;
    }
  }
  if (best) {
    const nh = interactAt(w, v).hit;
    const ready = !!nh && nh.kind === 'pick';
    const pickedBest: Order = ready && nh.kind === 'pick' ? nh.order : best;
    return {
      kind: 'pick' as const,
      x: pickedBest.slot.ax,
      y: pickedBest.slot.ay,
      text: `${ready ? 'In range: press E to pick up' : 'Drive to the ring, then press E to pick up'} #${pickedBest.id}${pickedBest.p0 ? ' (P0, 40 pts)' : ''}${pickedBest.card ? ' (contract)' : ''}`,
      order: pickedBest,
      inRange: ready,
    };
  }
  return { kind: 'wait' as const, text: 'No open orders. Wait for the next one.' };
}

export function board(w: World): BoardRow[] {
  const since = w.t - 60;
  const span = Math.max(1, Math.min(60, w.t));
  return STRAT_ORDER.map((s): BoardRow => {
    const ds = w.deliveries.filter((d) => d.t > since && d.strat === s);
    const vehicles =
      s === 'Human'
        ? w.vehicles.filter((v) => v.human).length
        : w.vehicles.filter((v) => v.strategy === s && !v.human).length;
    return {
      strat: s,
      vehicles,
      count: ds.length,
      perHr: (ds.length * 60) / span,
      onTimePct: ds.length ? (100 * ds.filter((d) => d.onTime).length) / ds.length : null,
      incidents: w.incidentLog.filter((d) => d.t > since && d.strat === s).length,
      kwhPerOrder: ds.length ? ds.reduce((a, d) => a + d.kwh, 0) / ds.length : null,
    };
  }).filter((r) => r.strat !== 'Human' || r.count > 0 || r.vehicles > 0);
}

// ---------- Fixed Tick ----------
export function tick(w: World, dt = TICK_MIN): void {
  // During factory break, clock, order due times, and shift timer freeze completely!
  if (w.phase === 'break') {
    return;
  }

  // During resuming, count down 10 seconds (at 10Hz dt=0.1, 1 real sec = 10 ticks = 1.0 dt) before running
  if (w.phase === 'resuming') {
    w.resumeCountdown = Math.max(0, Math.round((w.resumeCountdown - dt * 10) * 100) / 100);
    if (w.resumeCountdown <= 0) {
      setPhase(w, 'running');
    } else {
      return;
    }
  }

  const prevDay = dayIndex(w.t);
  const prevShift = shiftIndex(w.t);
  w.t = Math.round((w.t + dt) * 10) / 10;
  w.shiftTime = Math.round(((w.t % 480) + 480) % 480 * 10) / 10;

  if (w.phase === 'running') {
    const rate =
      (HOURLY_RATE[Math.floor(minuteOfDay(w.t) / 60) % 24] +
        (w.t < w.rushUntil ? Math.round(32 * FLOW) : 0)) *
      diffOf(w).demand *
      Math.max(1, w.vehicles.length / BASE_AI);
    if (rng(w) < (rate / 60) * dt) postOrder(w);
  }

  hazardStep(w, dt);

  // Expire stale pending decisions past their deadline
  for (let i = w.pendingDecisions.length - 1; i >= 0; i--) {
    if (w.t > w.pendingDecisions[i].deadline) {
      w.pendingDecisions.splice(i, 1);
    }
  }

  if (w.phase === 'running') {
    w.marketTimer -= dt;
    if (w.marketTimer <= 0) {
      w.marketTimer = 0.5;
      for (const v of w.vehicles) {
        if (!isManualHuman(v) && !v.brainError) {
          emitContractRequestIfNeeded(w, v);
          if (w.t - v.lastTacticsReqAt >= 60 && v.strategy === 'Strategist') {
            emitTacticsRequest(w, v);
          }
          // For Co-Pilot human vehicles, if still idle after 1.0 sim min (e.g. headless mode or before brain reply),
          // dispatch the highest-scored order using scoreOrder so Co-Pilot drives autonomously without stalling.
          if (
            v.human &&
            v.autopilot &&
            !v.runFinished &&
            v.state === 'idle' &&
            !v.cargo.length &&
            !v.orders.length &&
            v.battery >= policy(w, v).chargeAt &&
            w.t - v.idleSince >= 1.0
          ) {
            const pol = policy(w, v);
            const open = w.orders.filter(
              (o) =>
                !reservedAgainst(w, o, v) &&
                (o.state === 'open' || (pol.poach && o.state === 'claimed' && o.claimant !== v.id)),
            );
            if (open.length) {
              const scored = open
                .map((o) => ({ o, sc: scoreOrder(w, v, o) }))
                .sort((a, b) => b.sc - a.sc);
              const bestOrder = scored[0]?.o;
              if (bestOrder) {
                if (bestOrder.claimant && bestOrder.claimant !== v.id) {
                  const prev = w.vehicles.find((x) => x.id === bestOrder.claimant);
                  if (prev) {
                    prev.orders = prev.orders.filter((x) => x !== bestOrder);
                    nextLeg(w, prev);
                  }
                }
                bestOrder.state = 'claimed';
                bestOrder.claimant = v.id;
                v.orders.push(bestOrder);
                const cap = capacity(v);
                if (v.orders.length + v.cargo.length < cap && rng(w) < pol.batch) {
                  const mate = open
                    .filter((o) => o !== bestOrder && o.state === 'open' && o.bay === bestOrder.bay)
                    .map((o) => ({
                      o,
                      sc: scoreOrder(w, v, o, { x: bestOrder.slot.ax, y: bestOrder.slot.ay }),
                    }))
                    .sort((a, b) => b.sc - a.sc)[0];
                  if (mate && mate.sc > -10) {
                    mate.o.state = 'claimed';
                    mate.o.claimant = v.id;
                    v.orders.push(mate.o);
                  }
                }
                w.pendingDecisions = w.pendingDecisions.filter(
                  (r) => !(r.agentId === v.id && r.kind === 'contract'),
                );
                nextLeg(w, v);
              }
            }
          }
          if (v.human && v.autopilot && !v.runFinished && v.hold != null) {
            const hazReq = w.pendingDecisions.find(
              (r) => r.agentId === v.id && r.kind === 'hazard',
            );
            if (!hazReq || w.t - hazReq.tIssued >= 1.0) {
              const h = w.spills.find((s) => s.id === v.hold);
              if (h) {
                const dest = v.target || (v.path.length ? v.path[v.path.length - 1] : null);
                const alt = dest
                  ? findPath(w, v.tile.x, v.tile.y, dest.x, dest.y, {
                      flat: v.tactics.flatPath,
                      avoid: new Set([`${h.x},${h.y}`]),
                    })
                  : null;
                if (alt) {
                  v.path = alt;
                } else {
                  v.pushing = h.id;
                }
                v.hzSeen.add(h.id);
              }
              v.hold = null;
              v.msg = '';
              v.waitKey = null;
              w.pendingDecisions = w.pendingDecisions.filter(
                (r) => !(r.agentId === v.id && r.kind === 'hazard'),
              );
            }
          }
        }
      }
    }
  }

  // The personal Blitz clock starts when the player actually plays: first steering input
  // (stepHuman), keeping cards (keepCards), or — here — when Co-Pilot autopilot drives for them.
  // Idle players (e.g. still reading the intro) never burn run time.
  for (const v of w.vehicles) {
    if (!v.human || v.runFinished) continue;
    if (v.runMode === 'blitz' && v.runStartedAt === null && v.autopilot) {
      v.runStartedAt = w.t;
      v.runEndsAt = Math.round((w.t + BLITZ_DURATION_MIN) * 10) / 10;
      v.runGraceUntil = null;
    }
  }

  const { occ, res } = buildOccupancy(w);
  const n = w.vehicles.length;
  if (n > 0) {
    const start = Math.round(w.t * 10) % n;
    for (let i = 0; i < n; i++) {
      const v = w.vehicles[(start + i) % n];
      if (v.human && v.runFinished) {
        v.speedNow = 0;
        continue;
      }
      if (isManualHuman(v)) {
        stepHuman(w, v, v.input, dt, occ);
      } else if (v.hold && !v.moveTo) {
        v.braking = true;
        v.speedNow = 0;
        stepTask(w, v, dt);
      } else {
        stepAI(w, v, dt, occ, res);
        stepTask(w, v, dt);
      }
    }
  }

  for (const v of w.vehicles) {
    if (v.state !== 'charging' && !v.humanCharging && v.state !== 'parked' && !v.runFinished) {
      drain(w, v, 0.01 * dt);
    }
    const idx = v.tile.y * w.map.w + v.tile.x;
    if (idx >= 0 && idx < w.heat.length) {
      w.heat[idx] += dt;
    }
    if (
      v.human &&
      !v.runFinished &&
      v.runMode === 'blitz' &&
      v.runStartedAt != null &&
      v.runEndsAt != null &&
      w.t >= v.runEndsAt
    ) {
      const h = w.cards[handKey(v)] || (v.driver ? w.cards[v.driver] : undefined);
      if (h) {
        h.cards.forEach((c) => {
          if (c.status !== 'active') return;
          if (resolveRunEndCard(w, c, v)) return;
          if (c.type === 'clean' && (v.runIncidents ?? 0) === 0) finishCard(w, c, v);
          else if (c.type === 'charge' && v.battery >= 40) finishCard(w, c, v);
        });
      }
      v.runFinished = true;
      v.speedNow = 0;
      emit(
        w,
        'shift',
        `${v.driver || v.id} completed 5-Minute Blitz with ${Math.round(v.runPts ?? 0)} pts (${v.runDeliveries ?? 0} pallets, best streak ×${v.bestStreak ?? 0}).`,
        { vid: v.id },
      );
    }
  }
  for (let i = 0; i < w.heat.length; i++) w.heat[i] *= 0.997;
  w.markers = w.markers.filter((m) => m.until > w.t);

  if (w.phase === 'running') {
    if (Math.round(w.t * 10) % 10 === 0) cardsTick(w);
    dealShiftCards(w);
  }
  if (Math.round(w.t * 10) % 50 === 0) sampleValue(w);
  if (Math.round(w.t * 10) % 600 === 0) {
    w.deliveries = w.deliveries.filter((d) => d.t > w.t - 120);
    w.incidentLog = w.incidentLog.filter((d) => d.t > w.t - 120);
  }
  if (shiftIndex(w.t) !== prevShift) onShiftEnd(w);
  if (dayIndex(w.t) !== prevDay) onDayEnd(w, prevDay);
}

// ---------- Commands ----------
export function rushWave(w: World): number {
  let n = 0;
  for (let i = 0; i < 12; i++) if (postOrder(w)) n++;
  w.rushUntil = w.t + 30;
  emit(
    w,
    'rush',
    `Rush wave: ${n} orders posted now, +45/hr for 30 min${n < 12 ? ` (${12 - n} lost to a full backlog)` : ''}.`,
  );
  return n;
}

export function postP0(w: World): Order | null {
  const o = postOrder(w, { p0: true });
  if (!o) emit(w, 'hint', 'No free rack slot for a P0 right now.');
  return o;
}

export function toggleCone(w: World, x: number, y: number): string | null {
  const k = `${x},${y}`;
  if (w.cones.has(k)) {
    w.cones.delete(k);
    return null;
  }
  if (isBlocked(w, x, y)) return 'Cones go on open floor only.';
  if (bayAt(w.map, x, y) || chargerAt(w.map, x, y) >= 0) return 'Keep bays and chargers clear.';
  if (w.orders.some((o) => o.slot.key === k)) return 'That tile is an active pickup.';
  if (
    w.vehicles.some(
      (v) =>
        (v.tile.x === x && v.tile.y === y) ||
        (v.moveTo && v.moveTo.x === x && v.moveTo.y === y),
    )
  ) {
    return 'A vehicle is on that tile.';
  }
  w.cones.add(k);
  w.vehicles.forEach((v) => {
    if (!isManualHuman(v) && v.path.some((p) => p.x === x && p.y === y)) plan(w, v);
  });
  return null;
}

const SOURCE_ZONE_TO_RACKS: Record<DispatchSourceZone, string[]> = {
  haz: ['Z'],
  cold: ['W'],
  bulk: ['X'],
  high: ['U'],
  general: ['A', 'B', 'C', 'D', 'E'],
  any: ['Z', 'W', 'X', 'U', 'A', 'B', 'C', 'D', 'E'],
  A: ['A'],
  B: ['B'],
  C: ['C'],
  D: ['D'],
  E: ['E'],
  U: ['U'],
  W: ['W'],
  X: ['X'],
  Z: ['Z'],
};

const SOURCE_ZONE_LABELS: Record<DispatchSourceZone, string> = {
  haz: 'Hazmat (Z)',
  cold: 'Cold Storage (W)',
  bulk: 'Bulk (X)',
  high: 'High-Value (U)',
  general: 'General Racks (A–E)',
  any: 'All Zones',
  A: 'Zone A',
  B: 'Zone B',
  C: 'Zone C',
  D: 'Zone D',
  E: 'Zone E',
  U: 'High-Value (U)',
  W: 'Cold Storage (W)',
  X: 'Bulk (X)',
  Z: 'Hazmat (Z)',
};

export function dispatchOrderRoute(w: World, params: DispatchParams): DispatchResult {
  const sourceZone: DispatchSourceZone = params.sourceZone || 'haz';
  const count = Math.max(1, Math.min(8, Math.round(params.count ?? 3)));
  const mode = params.mode ?? 'reroute_and_spawn';

  let resolvedBay = params.targetBay && params.targetBay !== 'auto' ? params.targetBay : '';
  if (!resolvedBay) {
    if (sourceZone === 'haz' || sourceZone === 'Z') resolvedBay = 'RET';
    else if (sourceZone === 'cold' || sourceZone === 'W') resolvedBay = 'E2';
    else if (sourceZone === 'bulk' || sourceZone === 'X') resolvedBay = 'E6';
    else if (sourceZone === 'high' || sourceZone === 'U') resolvedBay = 'E4';
    else {
      const activeBays = w.bays.filter(
        (b) => !b.isTransferBay && b.id !== 'RET' && w.t >= b.departUntil,
      );
      const best =
        activeBays.sort((a, b) => a.load - b.load)[0] ||
        w.bays.find((b) => !b.isTransferBay && b.id !== 'RET') ||
        w.bays[0];
      resolvedBay = best ? best.id : 'E1';
    }
  }

  const bayExists = w.bays.some((b) => b.id === resolvedBay);
  if (!bayExists) {
    resolvedBay = w.bays[0]?.id || 'E1';
  }

  const priority =
    params.priority ??
    (resolvedBay === 'RET' || sourceZone === 'haz' || sourceZone === 'Z' ? 'p0' : 'urgent');
  const isP0 = priority === 'p0';

  const rackZones = SOURCE_ZONE_TO_RACKS[sourceZone] || ['Z'];
  const matchesOrder = (o: Order): boolean => {
    if (o.state === 'done') return false;
    if (sourceZone === 'any') return true;
    const z = o.slot.zone;
    if (sourceZone === 'haz') return z === 'Z';
    if (sourceZone === 'cold') return z === 'W';
    if (sourceZone === 'bulk') return z === 'X';
    if (sourceZone === 'high') return z === 'U';
    return rackZones.includes(z);
  };

  const orderIds: number[] = [];
  let rerouted = 0;
  let spawned = 0;

  if (mode === 'reroute_and_spawn' || mode === 'reroute_only') {
    const candidates = w.orders
      .filter(matchesOrder)
      .sort((a, b) => {
        // Prefer orders not yet at target bay, then open orders, then earliest due
        const aDiff = a.bay !== resolvedBay ? 0 : 1;
        const bDiff = b.bay !== resolvedBay ? 0 : 1;
        if (aDiff !== bDiff) return aDiff - bDiff;
        if (a.state !== b.state) return a.state === 'open' ? -1 : 1;
        return a.due - b.due;
      });

    for (const o of candidates) {
      if (rerouted >= count) break;
      o.bay = resolvedBay;
      if (isP0) {
        o.p0 = true;
        o.value = Math.max(o.value, 28);
        o.due = Math.max(o.due, w.t + 16);
      } else if (priority === 'urgent') {
        o.value = Math.max(o.value, 18);
        o.due = Math.max(o.due, w.t + 18);
      }
      rerouted++;
      orderIds.push(o.id);
    }
  }

  if (mode === 'reroute_and_spawn' || mode === 'spawn_only') {
    const remaining = mode === 'spawn_only' ? count : Math.max(0, count - rerouted);
    for (let i = 0; i < remaining; i++) {
      const z = rackZones[i % rackZones.length];
      const created = postOrder(w, {
        zone: z,
        bayId: resolvedBay,
        p0: isP0,
        force: true,
      });
      if (created) {
        if (priority === 'urgent' && !isP0) {
          created.value = Math.max(created.value, 18);
          created.due = Math.max(created.due, w.t + 18);
        }
        spawned++;
        orderIds.push(created.id);
      }
    }
  }

  // Re-plan AI vehicles carrying rerouted cargo or idle/claiming orders
  for (const v of w.vehicles) {
    if (isManualHuman(v)) continue;
    const touchesDispatched =
      v.cargo.some((o) => orderIds.includes(o.id)) ||
      v.orders.some((o) => orderIds.includes(o.id));
    if (touchesDispatched || v.state === 'idle' || v.state === 'parked') {
      plan(w, v);
    }
  }

  const zoneLabel = SOURCE_ZONE_LABELS[sourceZone] ?? sourceZone;
  const bayLabel = resolvedBay === 'RET' ? 'Returns & QA (RET)' : `Bay ${resolvedBay}`;
  const prioLabel = isP0 ? 'P0' : priority === 'urgent' ? 'Urgent' : 'Standard';
  const parts: string[] = [];
  if (rerouted > 0) parts.push(`${rerouted} rerouted`);
  if (spawned > 0) parts.push(`${spawned} spawned`);
  const countDetail = parts.length ? parts.join(', ') : '0 orders available';
  const summary = `Dispatched ${zoneLabel} → ${bayLabel} [${prioLabel}] (${countDetail})`;

  emit(w, isP0 ? 'p0' : 'mgr', summary);

  return {
    sourceZone,
    targetBay: resolvedBay,
    priority,
    rerouted,
    spawned,
    orderIds,
    summary,
  };
}

// ---------- Create World, v5 Serialize & Restore ----------
export interface CreateWorldOptions {
  siteId?: string;
  seed?: number;
  tier?: number;
  agents?: number;
  difficulty?: DifficultyInput;
  phase?: Phase;
}

export function createWorld(
  optsOrSaved?: CreateWorldOptions | WorldSnapshotV5 | null,
): World {
  if (optsOrSaved && ('version' in optsOrSaved || 'v' in optsOrSaved)) {
    return restore(optsOrSaved as WorldSnapshotV5);
  }
  const opts = (optsOrSaved || {}) as CreateWorldOptions;
  const tier0 = Math.max(0, Math.min(MAX_TIER, opts.tier ?? 0));
  const seed = opts.seed ?? 20261015;
  const siteId = opts.siteId ?? 'den-1';
  const map = buildMap(tier0, siteId);
  const diff = opts.difficulty ? normalizeDifficulty(opts.difficulty) ?? 'normal' : 'normal';

  const events: SimEvent[] = [];
  const spills: Hazard[] = [];
  const cards: Record<string, CardHand> = {};
  const valueSeries: ValueSample[] = [];
  const hallOfFame: HallEntry[] = [];
  const decisionJournal: DecisionJournalEntry[] = [];

  const w: World = {
    version: SIM_VERSION,
    siteId,
    seed,
    rngState: seed,
    t: 0,
    shiftTime: 0,
    tier: tier0,
    phase: opts.phase ?? 'running',
    resumeCountdown: 0,
    map,
    vehicleSeq: BASE_AI,
    nextOrderId: 1000,
    nextHazardId: 0,
    nextDecisionSeq: 0,
    nextTransferSeq: 0,
    nextPlayerSeq: 0,
    cardSeq: 0,
    cones: new Set<string>(),
    orders: [],
    vehicles: [],
    bays: map.bays.map((b) => ({
      id: b.id,
      load: 0,
      cap: 8,
      departUntil: 0,
      isTransferBay: b.isTransferBay,
      label: b.label,
    })),
    spills,
    hazards: spills,
    markers: [],
    rushUntil: 0,
    deliveries: [],
    incidentLog: [],
    events,
    log: events,
    history: [],
    difficulty: diff,
    difficultyVotes: {},
    cards,
    hands: cards,
    valueSeries,
    series: valueSeries,
    hallOfFame,
    hall: hallOfFame,
    humanValue: 0,
    agentValue: 0,
    aiShift: -1,
    totals: {
      shipped: 0,
      onTime: 0,
      incidents: 0,
      lost: 0,
      days: 0,
      wins: 0,
      humanShifts: 0,
      cardDeals: 0,
      cardsDone: 0,
      aiCardsDone: 0,
      hazards: 0,
      skids: 0,
      palletDrops: 0,
      transfersOut: 0,
      transfersIn: 0,
      decisions: { reroute: 0, wait: 0, push: 0 },
    },
    day: emptyStats(),
    shift: emptyStats(),
    tuned: defaultTacticsFor('Strategist'),
    heat: new Float32Array(map.w * map.h),
    listeners: [],
    marketTimer: 0,
    resumed: false,
    receivedTransferIds: new Set<string>(),
    outboundTransfers: [],
    pendingDecisions: [],
    decisionJournal,
    decisions: decisionJournal,
    players: new Map(),
  };

  const agentCount = opts.agents ?? BASE_AI;
  w.vehicles = makeVehicles(w, Math.min(agentCount, BASE_AI));
  for (let i = BASE_AI; i < agentCount; i++) {
    addVehicle(w, { silent: true });
  }
  checkFacilityExpansion(w);
  return w;
}

export function serialize(w: World): WorldSnapshotV5 {
  const cloneOrder = (o: Order): Order => ({
    ...o,
    slot: { ...o.slot },
  });

  return {
    version: 5,
    v: 5,
    siteId: w.siteId,
    seed: w.seed,
    rngState: w.rngState,
    t: w.t,
    shiftTime: w.shiftTime,
    tier: w.tier,
    phase: w.phase,
    resumeCountdown: w.resumeCountdown,
    vehicleSeq: w.vehicleSeq,
    nextOrderId: w.nextOrderId,
    nextHazardId: w.nextHazardId,
    nextDecisionSeq: w.nextDecisionSeq,
    nextTransferSeq: w.nextTransferSeq,
    nextPlayerSeq: w.nextPlayerSeq,
    cardSeq: w.cardSeq,
    difficulty: w.difficulty,
    difficultyVotes: { ...w.difficultyVotes },
    rushUntil: w.rushUntil,
    humanValue: w.humanValue,
    agentValue: w.agentValue,
    aiShift: w.aiShift,
    totals: structuredClone(w.totals),
    day: structuredClone(w.day),
    shift: structuredClone(w.shift),
    tuned: { ...w.tuned },
    cones: [...w.cones],
    bays: w.bays.map((b) => ({ ...b })),
    orders: w.orders.map(cloneOrder),
    spills: w.spills.map((s) => ({ ...s })),
    vehicles: w.vehicles.map((v) => ({
      ...v,
      tile: { ...v.tile },
      moveTo: v.moveTo ? { ...v.moveTo } : null,
      path: v.path.map((p) => ({ ...p })),
      orders: v.orders.map(cloneOrder),
      cargo: v.cargo.map(cloneOrder),
      input: { ...v.input },
      hzSeen: [...v.hzSeen],
      tactics: { ...v.tactics },
      fareLog: (v.fareLog || []).map((f) => ({ ...f })),
      precisionArmed: v.precisionArmed ? { ...v.precisionArmed } : null,
      autopilot: Boolean(v.autopilot),
      directive: v.directive ? structuredClone(v.directive) : null,
      lastDecision: v.lastDecision ? { ...v.lastDecision } : null,
      lastBrainDecision: v.lastBrainDecision ? { ...v.lastBrainDecision } : null,
      target: v.target
        ? {
            ...v.target,
            order: v.target.order ? cloneOrder(v.target.order) : undefined,
          }
        : null,
    })),
    cards: structuredClone(w.cards),
    valueSeries: w.valueSeries.slice(-300).map((s) => ({ ...s })),
    hallOfFame: w.hallOfFame.map((h) => ({ ...h })),
    history: structuredClone(w.history.slice(-60)),
    events: structuredClone(w.events.slice(-200)),
    deliveries: structuredClone(w.deliveries.filter((d) => d.t > w.t - 120)),
    incidentLog: structuredClone(w.incidentLog.filter((d) => d.t > w.t - 120)),
    receivedTransferIds: [...w.receivedTransferIds],
    outboundTransfers: structuredClone(w.outboundTransfers.slice(-100)),
    pendingDecisions: structuredClone(w.pendingDecisions),
    decisionJournal: structuredClone(w.decisionJournal.slice(-200)),
    players: [...w.players.entries()].map(([k, v]) => [k, { ...v }]),
    heat: Array.from(w.heat),
  };
}

export function restore(snap: WorldSnapshotV5): World {
  const tier = Math.max(0, Math.min(MAX_TIER, snap.tier | 0));
  const siteId = snap.siteId || 'den-1';
  const map = buildMap(tier, siteId);
  const theme = getSiteTheme(siteId);
  const slotByRxRy = new Map<string, Slot>();
  for (const s of map.slots) slotByRxRy.set(`${s.rx},${s.ry}`, s);

  const normalizeOrder = (o: Order): Order => {
    const matchedSlot = o.slot ? slotByRxRy.get(`${o.slot.rx},${o.slot.ry}`) : undefined;
    const slot: Slot = matchedSlot
      ? { ...matchedSlot }
      : map.slots.length > 0
        ? { ...map.slots[Math.abs((o.id || 0) * 7) % map.slots.length]! }
        : { ...o.slot };
    let sku = o.sku;
    if (siteId !== 'den-1' && typeof sku === 'string' && sku.startsWith('SKU-') && !o.fromSite) {
      const item = theme.skuItems[Math.abs(o.id || 0) % theme.skuItems.length] ?? 'ITEM';
      const num = String(Math.abs(o.id || 0) % 1000).padStart(3, '0');
      sku = `${theme.skuPrefix}-${item}-${num}`;
    }
    return {
      ...o,
      sku,
      slot,
    };
  };

  const orders: Order[] = (snap.orders || []).map(normalizeOrder);
  const orderById = new Map<number, Order>();
  orders.forEach((o) => orderById.set(o.id, o));

  const resolveOrderRef = (o: Order): Order => {
    const existing = orderById.get(o.id);
    if (existing) return existing;
    const copy = normalizeOrder(o);
    orderById.set(copy.id, copy);
    orders.push(copy);
    return copy;
  };

  const vehicles: Vehicle[] = (snap.vehicles || []).map((sv) => {
    const vOrders = (sv.orders || []).map(resolveOrderRef);
    const vCargo = (sv.cargo || []).map(resolveOrderRef);
    const rawTarget = sv.target;
    return {
      ...sv,
      tile: { ...sv.tile },
      moveTo: sv.moveTo ? { ...sv.moveTo } : null,
      path: (sv.path || []).map((p) => ({ ...p })),
      orders: vOrders,
      cargo: vCargo,
      input: { ...(sv.input || { up: false, down: false, left: false, right: false }) },
      hzSeen: new Set<number>(sv.hzSeen || []),
      tactics: sv.tactics ? { ...sv.tactics } : defaultTacticsFor(sv.strategy),
      autopilot: Boolean(sv.autopilot),
      directive: sv.directive ? structuredClone(sv.directive) : null,
      brainError: sv.brainError ?? null,
      lastDecision: sv.lastDecision ? { ...sv.lastDecision } : null,
      lastBrainDecision: sv.lastBrainDecision ? { ...sv.lastBrainDecision } : null,
      lastTacticsReqAt: sv.lastTacticsReqAt ?? 0,
      runMode: sv.runMode ?? 'blitz',
      runStartedAt: sv.runStartedAt ?? null,
      runEndsAt: sv.runEndsAt ?? null,
      runGraceUntil: sv.runGraceUntil ?? null,
      runPts: sv.runPts ?? 0,
      runDeliveries: sv.runDeliveries ?? 0,
      runOnTime: sv.runOnTime ?? 0,
      runIncidents: sv.runIncidents ?? 0,
      streak: sv.streak ?? 0,
      bestStreak: sv.bestStreak ?? 0,
      comboStep: sv.comboStep ?? 0,
      combo: sv.combo ?? 1,
      comboBest: sv.comboBest ?? 1,
      fareTrips: sv.fareTrips ?? 0,
      speedyTrips: sv.speedyTrips ?? 0,
      fareLog: (sv.fareLog || []).map((f) => ({ ...f })),
      brakeFrom: sv.brakeFrom ?? null,
      precisionArmed: sv.precisionArmed ? { ...sv.precisionArmed } : null,
      runFinished: Boolean(sv.runFinished),
      target: rawTarget
        ? {
            ...rawTarget,
            order: rawTarget.order ? resolveOrderRef(rawTarget.order) : undefined,
          }
        : null,
    } as Vehicle;
  });

  const events: SimEvent[] = structuredClone(snap.events || []);
  const spills: Hazard[] = (snap.spills || []).map((s) => ({ ...s }));
  const cards: Record<string, CardHand> = structuredClone(snap.cards || {});
  const valueSeries: ValueSample[] = (snap.valueSeries || []).map((s) => ({ ...s }));
  const hallOfFame: HallEntry[] = (snap.hallOfFame || []).map((h) => ({ ...h }));
  const decisionJournal: DecisionJournalEntry[] = structuredClone(snap.decisionJournal || []);
  const heat = new Float32Array(map.w * map.h);
  if (Array.isArray(snap.heat)) {
    heat.set(snap.heat.slice(0, heat.length));
  }

  const rawTotals = snap.totals || ({} as Partial<World['totals']>);
  const rawDecisions = rawTotals.decisions || ({} as Partial<World['totals']['decisions']>);

  const w: World = {
    version: 5,
    siteId: snap.siteId || 'den-1',
    seed: snap.seed ?? 20261015,
    rngState: snap.rngState ?? 20261015,
    t: snap.t ?? 0,
    shiftTime: snap.shiftTime ?? ((snap.t ?? 0) % 480),
    tier,
    phase: snap.phase || 'running',
    resumeCountdown: snap.resumeCountdown ?? 0,
    map,
    vehicleSeq: snap.vehicleSeq ?? BASE_AI,
    nextOrderId: snap.nextOrderId ?? 1000,
    nextHazardId: snap.nextHazardId ?? 0,
    nextDecisionSeq: snap.nextDecisionSeq ?? 0,
    nextTransferSeq: snap.nextTransferSeq ?? 0,
    nextPlayerSeq: snap.nextPlayerSeq ?? 0,
    cardSeq: snap.cardSeq ?? 0,
    cones: new Set<string>(snap.cones || []),
    orders,
    vehicles,
    bays: (() => {
      const restored =
        snap.bays && snap.bays.length
          ? snap.bays.map((b) => ({ ...b }))
          : map.bays.map((b) => ({
              id: b.id,
              load: 0,
              cap: 8,
              departUntil: 0,
              isTransferBay: b.isTransferBay,
              label: b.label,
            }));
      for (const mb of map.bays) {
        if (!restored.some((rb) => rb.id === mb.id)) {
          restored.push({
            id: mb.id,
            load: 0,
            cap: 8,
            departUntil: 0,
            isTransferBay: mb.isTransferBay,
            label: mb.label,
          });
        }
      }
      return restored;
    })(),
    spills,
    hazards: spills,
    markers: [],
    rushUntil: snap.rushUntil ?? 0,
    deliveries: structuredClone(snap.deliveries || []),
    incidentLog: structuredClone(snap.incidentLog || []),
    events,
    log: events,
    history: structuredClone(snap.history || []),
    difficulty: normalizeDifficulty(snap.difficulty) ?? 'normal',
    difficultyVotes: { ...(snap.difficultyVotes || {}) },
    cards,
    hands: cards,
    valueSeries,
    series: valueSeries,
    hallOfFame,
    hall: hallOfFame,
    humanValue: snap.humanValue ?? 0,
    agentValue: snap.agentValue ?? 0,
    aiShift: snap.aiShift ?? -1,
    totals: {
      shipped: rawTotals.shipped ?? 0,
      onTime: rawTotals.onTime ?? 0,
      incidents: rawTotals.incidents ?? 0,
      lost: rawTotals.lost ?? 0,
      days: rawTotals.days ?? 0,
      wins: rawTotals.wins ?? 0,
      humanShifts: rawTotals.humanShifts ?? 0,
      cardDeals: rawTotals.cardDeals ?? 0,
      cardsDone: rawTotals.cardsDone ?? 0,
      aiCardsDone: rawTotals.aiCardsDone ?? 0,
      hazards: rawTotals.hazards ?? 0,
      skids: rawTotals.skids ?? 0,
      palletDrops: rawTotals.palletDrops ?? 0,
      transfersOut: rawTotals.transfersOut ?? 0,
      transfersIn: rawTotals.transfersIn ?? 0,
      decisions: {
        reroute: rawDecisions.reroute ?? 0,
        wait: rawDecisions.wait ?? 0,
        push: rawDecisions.push ?? 0,
      },
    },
    day: snap.day ? structuredClone(snap.day) : emptyStats(),
    shift: snap.shift ? structuredClone(snap.shift) : emptyStats(),
    tuned: snap.tuned ? { ...snap.tuned } : defaultTacticsFor('Strategist'),
    heat,
    listeners: [],
    marketTimer: 0,
    resumed: true,
    receivedTransferIds: new Set<string>(snap.receivedTransferIds || []),
    outboundTransfers: structuredClone(snap.outboundTransfers || []),
    pendingDecisions: structuredClone(snap.pendingDecisions || []),
    decisionJournal,
    decisions: decisionJournal,
    players: new Map<string, PlayerSession>(snap.players || []),
  };

  STRAT_ORDER.forEach((s) => {
    w.day.byStrat[s] ??= emptyStrat();
    w.shift.byStrat[s] ??= emptyStrat();
  });

  w.vehicles.forEach((v, idx) => {
    if (isBlocked(w, v.tile.x, v.tile.y)) {
      const safeX = 6 + ((idx * 2) % 44);
      const safeY = 33;
      v.tile = { x: safeX, y: safeY };
      v.px = safeX;
      v.py = safeY;
      v.moveTo = null;
      v.path = [];
    }
  });

  return w;
}

export function on(w: World, fn: (ev: SimEvent) => void): void {
  w.listeners.push(fn);
}
