/**
 * Floor Trials: short single-player precision levels built on the real
 * warehouse map and the authoritative human driving model (`stepHuman`).
 *
 * A trial owns a private `World` (no AI, no spawns; `tick()` is never called) plus one
 * player vehicle. On top of the stock physics it adds:
 * - **Load sway**: a damped lateral oscillator driven by speed × yaw rate, hard braking,
 *   wet floor and wall hits. The gain grows with the stack (up to 3 pallets). When the
 *   sway saturates the top pallet falls to the floor beside the truck.
 * - **Falling racks**: hard rack strikes wobble a rack; one strike too many topples it
 *   and leaves debris (temporary cones) in the aisle.
 * - **Strikes**: every topple, boost crash or fallen rack is a strike. 3 strikes fails the
 *   level; any strike caps the star rating.
 *
 * Levels 7–18 ("Challenges") layer opt-in mechanics on top (see trialMechanics.ts): inbound
 * putaway and cross-dock flows, glass and heavy pallets, pre-placed cones, a battery budget with
 * chargers, timed dock windows, scripted traffic and a client-side visibility radius. A level
 * that sets none of the optional fields plays exactly like levels 1–6.
 *
 * Everything here is deterministic and pure TypeScript so the client can run it locally at
 * a fixed 10 Hz and the same rules stay unit-testable.
 */
import { createWorld, spawnPlayerVehicle, stepHuman } from './engine.js';
import { findPath, isBlocked } from './map.js';
import {
  BATTERY_LOW,
  CHARGE_MAX_SPEED,
  CHARGE_RATE,
  FRAGILE_SWAY_LIMIT,
  TRAFFIC_COOLDOWN,
  TRAFFIC_HIT,
  TRAFFIC_KICK,
  stackWeightFactor,
  trafficPose,
  windowState,
  windowWait,
  type TrialBattery,
  type TrialTraffic,
  type TrialWindow,
} from './trialMechanics.js';
import { CHALLENGE_LEVELS } from './trialChallenges.js';
import type { DriverInput, Order, Point, Slot, Vehicle, World } from './types.js';

export * from './trialMechanics.js';

/**
 * One pallet to move. Exactly one source (`rack` or `from`) and one destination (`bay` or `to`):
 * - outbound pick: `{ rack, bay }` (levels 1–6)
 * - inbound putaway: `{ from, to }`, from a dock to a marked rack slot
 * - cross-dock: `{ from, bay }`, from an inbound dock straight to an outbound bay
 */
export interface TrialPallet {
  /** Source rack tile id (`map.racks[].id`, e.g. `H2-3`); the pallet waits on its access tile. */
  rack?: string;
  /** Inbound source: a west receiving dock (`W1`–`W4`) or bay id; the pallet waits on the dock apron. */
  from?: string;
  /** Outbound bay id the pallet must reach (e.g. `E2`). */
  bay?: string;
  /** Putaway destination rack id: stow the pallet at that rack's access tile. */
  to?: string;
  /** Glass: the stack tips at FRAGILE_SWAY_LIMIT and a fallen glass pallet fails the level. */
  fragile?: boolean;
  /** Heavy: steadies the stack from the bottom, tips it sooner from the top. */
  heavy?: boolean;
}

export interface TrialLevel {
  id: string;
  num: number;
  name: string;
  /** One-line objective shown on the level card. */
  blurb: string;
  /** Teaching hint shown when the level starts. */
  tip: string;
  start: { x: number; y: number; angle: number };
  pallets: TrialPallet[];
  /** Max pallets the forks may carry at once (1–3). */
  stackMax: 1 | 2 | 3;
  /** Hard strikes a rack survives before it falls (default 2: warn, then fall). */
  rackHp?: number;
  /** Wet-floor tiles placed at level start. */
  spills?: Point[];
  /**
   * Par multiplier (default 1): above 1 for hazards that force slower or longer lines, below 1
   * to tighten par where long straights or window waits make the reference route generous.
   */
  parScale?: number;
  /** Pre-placed cones (blocked tiles) that narrow the aisles. */
  cones?: Point[];
  /** Battery budget; without it the truck never runs flat. */
  battery?: TrialBattery;
  /** Timed acceptance windows per bay id; unlisted bays are always open. */
  windows?: Record<string, TrialWindow>;
  /** Scripted AI forklifts on deterministic loops; touching one is a strike. */
  traffic?: TrialTraffic[];
  /** Client-only: visibility radius in tiles (Lights Out fog). The sim ignores it. */
  visibility?: number;
}

/** Level-select section: 1–6 teach the basics, 7–18 add one twist at a time. */
export type TrialSection = 'start' | 'challenge';
export const TRIAL_SECTIONS: ReadonlyArray<{ id: TrialSection; title: string }> = [
  { id: 'start', title: 'Getting started' },
  { id: 'challenge', title: 'Challenges' },
];
export const trialSection = (level: Pick<TrialLevel, 'num'>): TrialSection => (level.num <= 6 ? 'start' : 'challenge');

export type TrialStatus = 'ready' | 'running' | 'won' | 'failed';

export type TrialEventKind =
  | 'pick'
  | 'drop'
  | 'stow'
  | 'topple'
  | 'crash'
  | 'rack_warn'
  | 'rack_fall'
  | 'traffic'
  | 'shatter'
  | 'closed'
  | 'charge'
  | 'battery_low'
  | 'hint'
  | 'won'
  | 'failed';

export interface TrialEvent {
  /** Monotonic per-trial sequence number (the event log keeps only the last 40). */
  seq: number;
  t: number;
  kind: TrialEventKind;
  text: string;
  x?: number;
  y?: number;
}

export interface TrialState {
  levelId: string;
  status: TrialStatus;
  /** Elapsed level time (game-min ≈ seconds); runs from the first input. */
  t: number;
  strikes: number;
  /** Signed sway; |sway| ≥ 1 drops the top pallet. */
  sway: number;
  swayVel: number;
  delivered: number;
  total: number;
  /** Reference time (game-min) for an efficient clean run; star thresholds scale it. */
  par: number;
  stars: 0 | 1 | 2 | 3;
  rackHits: Record<string, number>;
  fallenRacks: string[];
  debris: Array<{ key: string; until: number }>;
  events: TrialEvent[];
  /** Last spill tile that kicked the load (one kick per tile entry). */
  lastSpill: string | null;
  /** Sequence number of the last emitted event. */
  eventSeq: number;
  /** Battery charge (%) on battery levels, otherwise null. */
  battery: number | null;
  /** True while parked on a working charger and gaining charge. */
  charging: boolean;
  /** Low-battery warning already shown (re-arms after charging back up). */
  lowWarned: boolean;
  /** Per traffic forklift: level time until it can strike again. */
  trafficCool: number[];
}

export interface Trial {
  level: TrialLevel;
  world: World;
  vehicle: Vehicle;
  state: TrialState;
  /** Level pallet spec per order id (weight, glass, flow). */
  specs: ReadonlyMap<number, TrialPallet>;
}

export const TRIAL_MAX_STRIKES = 3;
/** Sway spring stiffness and damping (θ'' = −kθ − cθ' + F). */
export const SWAY_K = 18;
export const SWAY_C = 3.5;
/** Sway gain by stack height (index = pallets on the forks). */
export const SWAY_GAIN = [0, 0.55, 1.0, 1.55] as const;
/** Hard-braking deceleration (tiles/min²) above which braking feeds the sway. */
export const SWAY_BRAKE_FREE = 7;
/** Braking lean is capped at this deceleration (the hardest pedal brake, boost brake = 14). */
export const SWAY_BRAKE_MAX = 14;
/**
 * Lurch gain for speed shed faster than SWAY_BRAKE_MAX in one tick. Letting go of boost
 * snaps the truck back to cruise; that whips the stack but never counts as an impact.
 */
export const SWAY_LURCH = 0.5;
/** Cruise top speed (highway). Above it, extra boost speed only partly feeds turning sway. */
export const SWAY_BOOST_KNEE = 4.25;
/** Fraction of speed above SWAY_BOOST_KNEE that feeds turning sway. */
export const SWAY_BOOST_SLOPE = 0.5;
/** Minimum pre-impact speed for a rack strike. */
export const RACK_HIT_SPEED = 2.0;
/** Wall-hit speed that kicks the load (matches the engine's COLLISION_SPEED). */
export const SWAY_WALL_SPEED = 1.65;
/**
 * Single-tick speed loss (per 0.1-min tick) that counts as an impact. Hardest braking (boost
 * brake, 14/min²) sheds at most 1.4 per tick, so a bigger loss means the truck hit something,
 * unless it is still rolling faster than IMPACT_REST (letting go of boost).
 */
export const IMPACT_DROP = 1.5;
/** An impact leaves the truck below this speed; the slowest cruise (hazmat) is 1.89. */
export const IMPACT_REST = 1.0;
/** Game-min that fallen-rack debris blocks the aisle. */
export const DEBRIS_TTL = 20;
/** Pick / drop reach from the truck centre, in tiles. */
export const TRIAL_REACH = 1.6;
/** Drop reach to the nearest bay tile (bays sit behind a dock edge, so it is looser). */
export const TRIAL_BAY_REACH = 2.1;
/** Max |speed| for a pick or drop. */
export const TRIAL_LIFT_SPEED = 1.0;
/** Seconds credited per pick / drop in the par time. */
export const TRIAL_HANDLE_TIME = 0.6;
/** Forward cruise speed used for par (tiles / game-min). */
export const TRIAL_PAR_SPEED = 3.15;
/** Star thresholds as multiples of par. */
export const STAR_3 = 1.25;
export const STAR_2 = 1.7;
/** Guide: another inbound pallet from the same dock tops up the stack only within this range (tiles). */
export const DOCK_STACK_RANGE = 4;

const E = 0;
const W = Math.PI;
const N = -Math.PI / 2;

export const TRIAL_LEVELS: readonly TrialLevel[] = [
  {
    id: 'first-lift',
    num: 1,
    name: 'First Lift',
    blurb: 'One pallet, one bay. Learn the lift.',
    tip: 'Stop beside the glowing pallet, press E, then drop it at Bay E2.',
    start: { x: 50, y: 11, angle: W },
    pallets: [{ rack: 'H2-3', bay: 'E2' }],
    stackMax: 1,
  },
  {
    id: 'double-stack',
    num: 2,
    name: 'Double Stack',
    blurb: 'Stack two pallets and run them together.',
    tip: 'Two pallets sway more. Ease off before corners.',
    start: { x: 47, y: 2, angle: W },
    pallets: [
      { rack: 'G2-2', bay: 'E1' },
      { rack: 'H1-4', bay: 'E1' },
    ],
    stackMax: 2,
  },
  {
    id: 'tower-of-three',
    num: 3,
    name: 'Tower of Three',
    blurb: 'Three high. Watch the stability meter.',
    tip: 'Full speed in a full turn tips a 3-stack. Brake early, turn slow.',
    start: { x: 20, y: 11, angle: E },
    pallets: [
      { rack: 'K2-1', bay: 'E4' },
      { rack: 'L1-3', bay: 'E4' },
      { rack: 'L2-5', bay: 'E4' },
    ],
    stackMax: 3,
  },
  {
    id: 'wet-floor',
    num: 4,
    name: 'Wet Floor',
    blurb: 'Spills on the main road kick the load.',
    tip: 'Crossing a puddle fast jolts the stack. Slow down or go around.',
    start: { x: 35, y: 20, angle: E },
    pallets: [
      { rack: 'V1-2', bay: 'E5' },
      { rack: 'V2-4', bay: 'E5' },
      { rack: 'W2-1', bay: 'E5' },
    ],
    stackMax: 3,
    parScale: 1.25,
    spills: [
      { x: 45, y: 21 },
      { x: 46, y: 20 },
      { x: 50, y: 21 },
      { x: 52, y: 20 },
      { x: 55, y: 23 },
      { x: 40, y: 25 },
    ],
  },
  {
    id: 'wobbly-racks',
    num: 5,
    name: 'Wobbly Racks',
    blurb: 'These racks fall on the first hard hit.',
    tip: 'Hit a rack at speed and it comes down, blocking the aisle.',
    start: { x: 14, y: 2, angle: E },
    pallets: [
      { rack: 'C1-5', bay: 'E2' },
      { rack: 'D1-1', bay: 'E2' },
      { rack: 'D2-3', bay: 'E2' },
    ],
    stackMax: 3,
    rackHp: 1,
  },
  {
    id: 'rush-hour',
    num: 6,
    name: 'Rush Hour',
    blurb: 'Six pallets, two bays, two trips.',
    tip: 'Sort by bay: stack E7 pallets together, then E8.',
    start: { x: 30, y: 38, angle: N },
    pallets: [
      { rack: 'X1-2', bay: 'E7' },
      { rack: 'X2-1', bay: 'E7' },
      { rack: 'Y2-3', bay: 'E7' },
      { rack: 'Y1-5', bay: 'E8' },
      { rack: 'Z1-4', bay: 'E8' },
      { rack: 'Z2-2', bay: 'E8' },
    ],
    stackMax: 3,
  },
  ...CHALLENGE_LEVELS,
];

export function trialLevel(id: string): TrialLevel | null {
  return TRIAL_LEVELS.find((l) => l.id === id) ?? null;
}

const wrapAngle = (a: number): number => {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
};

const distTo = (v: Vehicle, tx: number, ty: number): number =>
  Math.hypot(v.px - (tx + 0.5), v.py - (ty + 0.5));

/**
 * Speed that drives turning sway: full speed up to cruise, then SWAY_BOOST_SLOPE of the
 * boost surplus, so boosting through a bend is risky without being instantly fatal.
 */
export function swaySpeed(speed: number): number {
  const s = Math.abs(speed);
  const eff = s <= SWAY_BOOST_KNEE ? s : SWAY_BOOST_KNEE + (s - SWAY_BOOST_KNEE) * SWAY_BOOST_SLOPE;
  return Math.sign(speed) * eff;
}

/**
 * One sway integration step. Pure: returns the new `{sway, swayVel}`.
 * `force` is the external drive; `kick` an instantaneous velocity impulse.
 */
export function stepSway(
  sway: number,
  swayVel: number,
  force: number,
  kick: number,
  dt: number,
): { sway: number; swayVel: number } {
  let th = sway;
  let om = swayVel + kick;
  const n = 4;
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    om += (-SWAY_K * th - SWAY_C * om + force) * h;
    th += om * h;
  }
  return { sway: th, swayVel: om };
}

/** Stars for a finished run: time vs par, capped by strikes (0 → 3★, 1 → 2★, 2 → 1★). */
export function starsFor(time: number, par: number, strikes: number): 0 | 1 | 2 | 3 {
  if (strikes >= TRIAL_MAX_STRIKES) return 0;
  const byTime = time <= par * STAR_3 ? 3 : time <= par * STAR_2 ? 2 : 1;
  const cap = 3 - strikes;
  return Math.max(1, Math.min(byTime, cap)) as 1 | 2 | 3;
}

function bayTiles(w: World, bayId: string): Point[] {
  return w.map.bays.find((b) => b.id === bayId)?.tiles ?? [];
}

/** Nearest reachable tile of a bay (the drop column is a wall; drivers stop beside it). */
function bayApproach(w: World, bayId: string): Point | null {
  const tiles = bayTiles(w, bayId);
  for (const t of tiles) {
    for (const [dx, dy] of [
      [-1, 0],
      [0, -1],
      [0, 1],
      [1, 0],
    ]) {
      if (!isBlocked(w, t.x + dx, t.y + dy)) return { x: t.x + dx, y: t.y + dy };
    }
  }
  return null;
}

function pathLen(w: World, a: Point, b: Point): number {
  if (a.x === b.x && a.y === b.y) return 0;
  const p = findPath(w, a.x, a.y, b.x, b.y);
  if (!p) throw new Error(`Floor Trials: no route ${a.x},${a.y} → ${b.x},${b.y}`);
  return p.length;
}

/** Centre tile of an inbound dock: a west receiving dock (`W1`–`W4`) or a bay's middle tile. */
function dockCentre(w: World, id: string): Point | null {
  const west = w.map.westDocks.find((d) => d.id === id);
  if (west) return { x: west.x, y: west.y };
  const bay = w.map.bays.find((b) => b.id === id);
  return bay ? (bay.tiles[1] ?? bay.tiles[0]) : null;
}

/**
 * Pickup slot for every level pallet, in level order. Rack pallets wait on the rack's access
 * tile; inbound pallets fill free apron tiles around their dock, nearest first.
 */
function palletPickups(w: World, level: TrialLevel): Slot[] {
  const used = new Map<string, number>();
  return level.pallets.map((p) => {
    if (p.rack) {
      const slot = w.map.slots.find((s) => s.rackId === p.rack);
      if (!slot) throw new Error(`Floor Trials: unknown rack ${p.rack}`);
      return { ...slot };
    }
    if (!p.from) throw new Error('Floor Trials: pallet needs a rack or a from dock');
    const c = dockCentre(w, p.from);
    if (!c) throw new Error(`Floor Trials: unknown dock ${p.from}`);
    const apron: Point[] = [];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = c.x + dx;
        const y = c.y + dy;
        if (Math.hypot(dx, dy) > 2.3 || isBlocked(w, x, y)) continue;
        if (w.map.bays.some((b) => b.tiles.some((t) => t.x === x && t.y === y))) continue;
        apron.push({ x, y });
      }
    }
    apron.sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y) || a.y - b.y || a.x - b.x);
    const n = used.get(p.from) ?? 0;
    used.set(p.from, n + 1);
    const t = apron[n];
    if (!t) throw new Error(`Floor Trials: dock ${p.from} apron is full`);
    return { key: `${t.x},${t.y}`, rackId: p.from, zone: 'dock', rx: t.x, ry: t.y, ax: t.x, ay: t.y, level: 0 };
  });
}

/** Where a pallet is delivered: the bay approach tile, or the putaway rack's access tile. */
function destPoint(w: World, p: TrialPallet): Point {
  if (p.to) {
    const slot = w.map.slots.find((s) => s.rackId === p.to);
    if (!slot) throw new Error(`Floor Trials: unknown rack ${p.to}`);
    return { x: slot.ax, y: slot.ay };
  }
  if (!p.bay) throw new Error('Floor Trials: pallet needs a bay or a to rack');
  const drop = bayApproach(w, p.bay);
  if (!drop) throw new Error(`Floor Trials: bay ${p.bay} unreachable`);
  return drop;
}

const destKey = (p: TrialPallet): string => (p.to ? `r:${p.to}` : `b:${p.bay}`);
/** Par trip grouping: outbound pallets share a trip per bay; inbound pallets per source dock. */
const tripKey = (p: TrialPallet): string => (p.from ? `s:${p.from}` : destKey(p));

interface ParStop {
  at: Point;
  kind: 'pick' | 'drop' | 'charge';
  bay?: string;
  dwell: number;
}

/**
 * Par time: trips in level order (grouped by `tripKey`, limited by `stackMax`) at cruise speed,
 * plus a fixed handling time per pick and per drop stop. Challenge levels add the cheapest
 * single charger detour (with just enough charge) on battery levels and the wait for each
 * closed dock window on the way.
 */
export function trialPar(w: World, level: TrialLevel): number {
  const pickups = palletPickups(w, level);
  const trips: number[][] = [];
  level.pallets.forEach((p, i) => {
    const last = trips[trips.length - 1];
    if (last && last.length < level.stackMax && tripKey(level.pallets[last[0]]) === tripKey(p)) last.push(i);
    else trips.push([i]);
  });
  const stops: ParStop[] = [];
  for (const trip of trips) {
    for (const i of trip) stops.push({ at: { x: pickups[i].ax, y: pickups[i].ay }, kind: 'pick', dwell: TRIAL_HANDLE_TIME });
    const seen = new Set<string>();
    for (const i of trip) {
      const p = level.pallets[i];
      if (seen.has(destKey(p))) continue;
      seen.add(destKey(p));
      stops.push({ at: destPoint(w, p), kind: 'drop', bay: p.to ? undefined : p.bay, dwell: TRIAL_HANDLE_TIME });
    }
  }
  const start: Point = { x: level.start.x, y: level.start.y };
  const legs: number[] = [];
  let at = start;
  for (const s of stops) {
    legs.push(pathLen(w, at, s.at));
    at = s.at;
  }
  if (level.battery) insertChargeStop(w, level.battery, start, stops, legs);

  let tiles = 0;
  for (const n of legs) tiles += n;
  const handles = stops.filter((s) => s.kind !== 'charge').length;
  let extra = 0;
  if (level.battery || level.windows) {
    let t = 0;
    stops.forEach((s, i) => {
      t += legs[i] / TRIAL_PAR_SPEED;
      if (s.kind === 'drop' && s.bay) {
        const wait = windowWait(level.windows, s.bay, t);
        t += wait;
        extra += wait;
      }
      if (s.kind === 'charge') extra += s.dwell;
      t += s.dwell;
    });
  }
  const base = tiles / TRIAL_PAR_SPEED + handles * TRIAL_HANDLE_TIME + extra;
  return Math.round(base * (level.parScale ?? 1) * 10) / 10;
}

/**
 * Inserts the cheapest feasible charger visit into a battery level's par route (in place). The
 * truck may charge only as much as the rest of the route needs; no detour if the start charge
 * already covers it.
 */
function insertChargeStop(w: World, bat: TrialBattery, start: Point, stops: ParStop[], legs: number[]): void {
  const total = legs.reduce((a, b) => a + b, 0) * bat.perTile;
  if (total <= bat.start) return;
  let best: { k: number; c: Point; toC: number; fromC: number; need: number; cost: number } | null = null;
  let before = 0;
  for (let k = 0; k < stops.length; k++) {
    const from = k === 0 ? start : stops[k - 1].at;
    let after = 0;
    for (let j = k + 1; j < legs.length; j++) after += legs[j];
    for (const c of bat.chargers) {
      const toC = pathLen(w, from, c);
      const used = (before + toC) * bat.perTile;
      if (used > bat.start) continue;
      const fromC = pathLen(w, c, stops[k].at);
      const arrive = bat.start - used;
      const need = Math.max(0, (fromC + after) * bat.perTile - arrive);
      if (arrive + need > 100) continue;
      const cost = (toC + fromC - legs[k]) / TRIAL_PAR_SPEED + need / CHARGE_RATE;
      if (!best || cost < best.cost) best = { k, c, toC, fromC, need, cost };
    }
    before += legs[k];
  }
  if (!best) throw new Error('Floor Trials: battery level cannot be finished with one charge');
  stops.splice(best.k, 0, { at: best.c, kind: 'charge', dwell: best.need / CHARGE_RATE });
  legs.splice(best.k, 1, best.toC, best.fromC);
}

/** Builds a fresh, deterministic trial for `levelId`. */
export function createTrial(levelId: string): Trial {
  const level = trialLevel(levelId);
  if (!level) throw new Error(`Floor Trials: unknown level ${levelId}`);
  const w = createWorld({ agents: 0, siteId: 'den-1' });
  w.orders.length = 0;
  w.spills.length = 0;
  w.markers.length = 0;
  w.events.length = 0;
  w.cones.clear();
  const v = spawnPlayerVehicle(w, 'trial', 'You', { mode: 'freerange' });
  if (!v) throw new Error('Floor Trials: could not spawn the player truck');
  // Trials are pure driving: no card perks or battery management.
  for (const k of Object.keys(w.cards)) delete w.cards[k];
  v.px = level.start.x + 0.5;
  v.py = level.start.y + 0.5;
  v.tile = { x: level.start.x, y: level.start.y };
  v.angle = level.start.angle;
  v.speedNow = 0;
  v.battery = 100;
  v.state = 'driven';
  for (const c of level.cones ?? []) w.cones.add(`${c.x},${c.y}`);
  const pickups = palletPickups(w, level);
  const specs = new Map<number, TrialPallet>();
  level.pallets.forEach((p, i) => {
    if (p.bay && !w.map.bays.some((b) => b.id === p.bay)) throw new Error(`Floor Trials: unknown bay ${p.bay}`);
    const stow = p.to ? w.map.slots.find((s) => s.rackId === p.to) : undefined;
    if (p.to && !stow) throw new Error(`Floor Trials: unknown rack ${p.to}`);
    const dest = p.bay ?? p.to;
    if (!dest) throw new Error('Floor Trials: pallet needs a bay or a to rack');
    const o: Order = {
      id: w.nextOrderId++,
      sku: `TRL-${p.rack ?? p.from}`,
      slot: pickups[i],
      // Putaway pallets carry their rack id here so labels read "Pallet → H2-3".
      bay: dest,
      p0: false,
      value: 1,
      created: 0,
      due: 1e9,
      state: 'open',
      claimant: null,
      card: null,
    };
    if (stow) o.putaway = { ...stow };
    w.orders.push(o);
    specs.set(o.id, p);
  });
  for (const s of level.spills ?? []) {
    w.spills.push({ id: w.nextHazardId++, x: s.x, y: s.y, born: 0, until: 1e9 });
  }
  const state: TrialState = {
    levelId: level.id,
    status: 'ready',
    t: 0,
    strikes: 0,
    sway: 0,
    swayVel: 0,
    delivered: 0,
    total: level.pallets.length,
    par: trialPar(w, level),
    stars: 0,
    rackHits: {},
    fallenRacks: [],
    debris: [],
    events: [],
    lastSpill: null,
    eventSeq: 0,
    battery: level.battery ? level.battery.start : null,
    charging: false,
    lowWarned: false,
    trafficCool: (level.traffic ?? []).map(() => 0),
  };
  return { level, world: w, vehicle: v, state, specs };
}

const hasInput = (i: DriverInput): boolean => Boolean(i.up || i.down || i.left || i.right);

function emit(tr: Trial, kind: TrialEventKind, text: string, x?: number, y?: number): TrialEvent {
  const ev: TrialEvent = { seq: ++tr.state.eventSeq, t: tr.state.t, kind, text, x, y };
  tr.state.events.push(ev);
  if (tr.state.events.length > 40) tr.state.events.shift();
  return ev;
}

function strike(tr: Trial, kind: TrialEventKind, text: string, x: number, y: number): void {
  const st = tr.state;
  st.strikes++;
  tr.world.markers.push({ x, y, until: tr.world.t + 6, kind: 'incident' });
  emit(tr, kind, text, x, y);
  if (st.strikes >= TRIAL_MAX_STRIKES && st.status === 'running') {
    st.status = 'failed';
    tr.vehicle.speedNow = 0;
    emit(tr, 'failed', 'Three strikes. Level failed.');
  }
}

/** Drops the top pallet to the floor on the side the load leans. */
function toppleTop(tr: Trial): void {
  const v = tr.vehicle;
  const w = tr.world;
  const o = v.cargo.pop();
  if (!o) return;
  const side = Math.sign(tr.state.sway) || 1;
  const px = -Math.sin(v.angle) * side;
  const py = Math.cos(v.angle) * side;
  let tx = Math.floor(v.px + px);
  let ty = Math.floor(v.py + py);
  if (isBlocked(w, tx, ty)) {
    tx = v.tile.x;
    ty = v.tile.y;
  }
  o.state = 'open';
  o.claimant = null;
  o.slot = { ...o.slot, key: `${tx},${ty}`, ax: tx, ay: ty, rx: tx, ry: ty, level: 0 };
  v.orders = v.orders.filter((x) => x.id !== o.id);
  tr.state.sway *= 0.3;
  tr.state.swayVel = 0;
  if (tr.specs.get(o.id)?.fragile) shatter(tr, tx, ty);
  else strike(tr, 'topple', 'Load tipped! Top pallet fell.', tx, ty);
}

/** A glass pallet hit the floor: instant fail (not a strike). */
function shatter(tr: Trial, x: number, y: number): void {
  const st = tr.state;
  tr.world.markers.push({ x, y, until: tr.world.t + 6, kind: 'incident' });
  emit(tr, 'shatter', 'Glass pallet shattered!', x, y);
  if (st.status === 'running' || st.status === 'ready') {
    st.status = 'failed';
    tr.vehicle.speedNow = 0;
    emit(tr, 'failed', 'Broken glass. Level failed.');
  }
}

const isFragile = (tr: Trial, o: Order): boolean => Boolean(tr.specs.get(o.id)?.fragile);
const isHeavy = (tr: Trial, o: Order): boolean => Boolean(tr.specs.get(o.id)?.heavy);

function rackAt(w: World, x: number, y: number) {
  return w.map.racks.find((r) => r.x === x && r.y === y) ?? null;
}

function rackStrike(tr: Trial, prevSpeed: number): void {
  const v = tr.vehicle;
  const w = tr.world;
  const st = tr.state;
  let rack = null;
  for (const reach of [0.82, 1.2]) {
    const nx = Math.floor(v.px + Math.cos(v.angle) * reach * Math.sign(prevSpeed));
    const ny = Math.floor(v.py + Math.sin(v.angle) * reach * Math.sign(prevSpeed));
    rack = rackAt(w, nx, ny);
    if (rack) break;
  }
  if (!rack || st.fallenRacks.includes(rack.id)) return;
  const hp = tr.level.rackHp ?? 2;
  const hits = (st.rackHits[rack.id] ?? 0) + 1;
  st.rackHits[rack.id] = hits;
  if (hits < hp) {
    w.markers.push({ x: rack.x, y: rack.y, until: w.t + 5, kind: 'near' });
    emit(tr, 'rack_warn', `Rack ${rack.id} is wobbling. One more hit brings it down.`, rack.x, rack.y);
    return;
  }
  st.fallenRacks.push(rack.id);
  const reserved = new Set<string>();
  for (const o of w.orders) if (o.state === 'open') reserved.add(`${o.slot.ax},${o.slot.ay}`);
  let placed = 0;
  // Boxes spill into the aisle around the rack (8-neighbourhood), never onto the truck.
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ]) {
    if (placed >= 2) break;
    const x = rack.x + dx;
    const y = rack.y + dy;
    const key = `${x},${y}`;
    if (isBlocked(w, x, y) || reserved.has(key)) continue;
    if (x === v.tile.x && y === v.tile.y) continue;
    if (Math.hypot(v.px - (x + 0.5), v.py - (y + 0.5)) <= 0.9) continue;
    w.cones.add(key);
    st.debris.push({ key, until: w.t + DEBRIS_TTL });
    placed++;
  }
  strike(tr, 'rack_fall', `Rack ${rack.id} came down! Debris in the aisle.`, rack.x, rack.y);
}

/**
 * Advances the trial by `dt` game-min with the given driver input. The clock starts on the
 * first steering / throttle input. No-op once the level is won or failed.
 */
export function stepTrial(tr: Trial, input: DriverInput, dt = 0.1): void {
  const st = tr.state;
  const w = tr.world;
  const v = tr.vehicle;
  if (st.status === 'won' || st.status === 'failed') return;
  if (st.status === 'ready') {
    if (!hasInput(input)) return;
    st.status = 'running';
  }
  v.battery = 100;
  const prevSpeed = v.speedNow;
  const prevAngle = v.angle;
  const prevCargo = v.cargo.length;
  const prevLoad = tr.specs.size && v.cargo.some((o) => isFragile(tr, o)) ? v.cargo.slice() : null;
  const prevPx = v.px;
  const prevPy = v.py;
  stepHuman(w, v, input, dt);
  w.t += dt;
  st.t = Math.round((st.t + dt) * 1000) / 1000;

  // Boost crash: the engine already dumped the whole stack on the floor.
  if (v.cargo.length < prevCargo) {
    st.sway = 0;
    st.swayVel = 0;
    strike(tr, 'crash', 'Boost crash! The stack hit the floor.', v.tile.x, v.tile.y);
    if (prevLoad?.some((o) => isFragile(tr, o) && !v.cargo.includes(o))) shatter(tr, v.tile.x, v.tile.y);
  }

  // Walls, racks and trucks stop the truck (near) dead. Letting go of boost also sheds a lot
  // of speed in one tick, but leaves the truck rolling at cruise, so it is never an impact.
  const impact =
    Math.abs(prevSpeed) - Math.abs(v.speedNow) > IMPACT_DROP * (dt / 0.1) && Math.abs(v.speedNow) < IMPACT_REST;
  const n = Math.min(3, v.cargo.length);
  if (n === 0) {
    st.sway = 0;
    st.swayVel = 0;
  } else {
    let g: number = SWAY_GAIN[n];
    if (tr.specs.size) g *= stackWeightFactor(v.cargo.slice(0, 3).map((o) => isHeavy(tr, o)));
    const yaw = Math.max(-4, Math.min(4, wrapAngle(v.angle - prevAngle) / dt));
    const speed = v.speedNow;
    const lean = Math.sign(st.sway) || 1;
    let force = -g * swaySpeed(speed) * yaw;
    let kick = 0;
    const drop = Math.abs(prevSpeed) - Math.abs(speed);
    if (!impact && drop > 0) {
      // Braking leans the stack (capped at the hardest pedal brake). Shedding boost speed
      // faster than that (letting go of boost snaps the truck back to cruise) is a lurch.
      const decel = drop / dt;
      if (decel > SWAY_BRAKE_FREE) force += (Math.min(decel, SWAY_BRAKE_MAX) - SWAY_BRAKE_FREE) * 0.8 * g * lean;
      const excess = drop - SWAY_BRAKE_MAX * dt;
      if (excess > 0) kick += excess * SWAY_LURCH * g * lean;
    }
    const key = `${v.tile.x},${v.tile.y}`;
    const onSpill = w.spills.some((h) => h.x === v.tile.x && h.y === v.tile.y && h.until > w.t);
    if (onSpill && Math.abs(speed) > 1.2 && st.lastSpill !== key) {
      kick += ((v.tile.x + v.tile.y) % 2 === 0 ? 1 : -1) * 3 * g;
      st.lastSpill = key;
    }
    if (!onSpill) st.lastSpill = null;
    if (impact && Math.abs(prevSpeed) > SWAY_WALL_SPEED) {
      kick += Math.abs(prevSpeed) * 0.9 * g * lean;
    }
    const next = stepSway(st.sway, st.swayVel, force, kick, dt);
    st.sway = next.sway;
    st.swayVel = next.swayVel;
    const limit = tr.specs.size && v.cargo.some((o) => isFragile(tr, o)) ? FRAGILE_SWAY_LIMIT : 1;
    if (Math.abs(st.sway) >= limit) toppleTop(tr);
  }

  if (Math.abs(prevSpeed) >= RACK_HIT_SPEED && impact && st.status === 'running') {
    rackStrike(tr, prevSpeed);
  }

  if (tr.level.traffic && st.status === 'running') stepTraffic(tr, prevSpeed);
  if (st.battery !== null && tr.level.battery && st.status === 'running') {
    stepBattery(tr, tr.level.battery, Math.hypot(v.px - prevPx, v.py - prevPy), dt);
  }

  if (st.debris.length) {
    st.debris = st.debris.filter((d) => {
      if (d.until > w.t) return true;
      w.cones.delete(d.key);
      return false;
    });
  }
  if (w.markers.length) {
    const keep = w.markers.filter((m) => m.until > w.t);
    w.markers.length = 0;
    w.markers.push(...keep);
  }
}

/** Scripted forklifts: touching one stops the truck, kicks the load and costs a strike. */
function stepTraffic(tr: Trial, prevSpeed: number): void {
  const st = tr.state;
  const v = tr.vehicle;
  (tr.level.traffic ?? []).forEach((tk, i) => {
    if (st.status !== 'running' || st.t < (st.trafficCool[i] ?? 0)) return;
    const p = trafficPose(tk, st.t);
    if (Math.hypot(v.px - p.x, v.py - p.y) >= TRAFFIC_HIT) return;
    st.trafficCool[i] = st.t + TRAFFIC_COOLDOWN;
    v.speedNow = 0;
    const n = Math.min(3, v.cargo.length);
    if (n) st.swayVel += (Math.sign(st.sway) || 1) * TRAFFIC_KICK * SWAY_GAIN[n] * Math.max(1, Math.abs(prevSpeed));
    strike(tr, 'traffic', 'Traffic! You clipped a forklift.', v.tile.x, v.tile.y);
  });
}

/** Battery levels: drain by distance, charge while parked on a working charger, fail when flat. */
function stepBattery(tr: Trial, bat: TrialBattery, dist: number, dt: number): void {
  const st = tr.state;
  const v = tr.vehicle;
  let b = (st.battery ?? 0) - dist * bat.perTile;
  const onCharger =
    Math.abs(v.speedNow) < CHARGE_MAX_SPEED && bat.chargers.some((c) => c.x === v.tile.x && c.y === v.tile.y);
  if (onCharger && b < 100) {
    b = Math.min(100, b + CHARGE_RATE * dt);
    if (!st.charging) emit(tr, 'charge', 'Charging…', v.tile.x, v.tile.y);
    st.charging = true;
  } else if (st.charging) {
    st.charging = false;
    emit(tr, 'charge', `Charged to ${Math.floor(b)}%.`, v.tile.x, v.tile.y);
  }
  if (b > BATTERY_LOW + 10) st.lowWarned = false;
  if (b <= BATTERY_LOW && !st.lowWarned && b > 0) {
    st.lowWarned = true;
    emit(tr, 'battery_low', 'Battery low! Head for a charger.', v.tile.x, v.tile.y);
  }
  st.battery = Math.max(0, b);
  if (b <= 0) {
    st.status = 'failed';
    v.speedNow = 0;
    emit(tr, 'failed', 'Battery flat. Level failed.');
  }
}

/** Marks `load` delivered, emits the drop / stow event and settles the win. */
function deliver(tr: Trial, load: Order[], kind: 'drop' | 'stow', text: string, x?: number, y?: number): TrialEvent {
  const st = tr.state;
  const v = tr.vehicle;
  if (st.status === 'ready') st.status = 'running';
  v.cargo = v.cargo.filter((o) => !load.includes(o));
  for (const o of load) {
    o.state = 'done';
    st.delivered++;
  }
  v.orders = v.orders.filter((x) => !load.includes(x));
  if (!v.cargo.length) {
    st.sway = 0;
    st.swayVel = 0;
  }
  const ev = emit(tr, kind, text, x, y);
  if (st.delivered >= st.total) {
    st.status = 'won';
    v.speedNow = 0;
    st.stars = starsFor(st.t, st.par, st.strikes);
    emit(tr, 'won', `Level clear in ${st.t.toFixed(1)}s.`);
  }
  return ev;
}

/** The E key: deliver at a matching bay or stow slot, otherwise lift the nearest floor pallet. */
export function trialInteract(tr: Trial): TrialEvent | null {
  const st = tr.state;
  const w = tr.world;
  const v = tr.vehicle;
  if (st.status === 'won' || st.status === 'failed') return null;
  if (Math.abs(v.speedNow) >= TRIAL_LIFT_SPEED) return emit(tr, 'hint', 'Slow down to lift.');
  if (v.cargo.length) {
    for (const b of w.map.bays) {
      if (!b.tiles.some((t) => distTo(v, t.x, t.y) <= TRIAL_BAY_REACH)) continue;
      const load = v.cargo.filter((o) => o.bay === b.id && !o.putaway);
      if (!load.length) continue;
      const win = windowState(tr.level.windows, b.id, st.t);
      if (win && !win.open) {
        return emit(tr, 'closed', `Bay ${b.id} is closed. Opens in ${win.left.toFixed(1)}s.`, b.tiles[1]?.x, b.tiles[1]?.y);
      }
      const bs = w.bays.find((x) => x.id === b.id);
      if (bs) bs.load += load.length;
      return deliver(tr, load, 'drop', `Delivered ${load.length} to Bay ${b.id}.`, b.tiles[1]?.x, b.tiles[1]?.y);
    }
    const stow = v.cargo.filter((o) => o.putaway && distTo(v, o.putaway.ax, o.putaway.ay) <= TRIAL_REACH);
    if (stow.length) {
      const ids = stow.map((o) => o.putaway!.rackId).join(', ');
      return deliver(tr, stow, 'stow', `Stowed in ${ids}.`, stow[0].putaway!.rx, stow[0].putaway!.ry);
    }
  }
  if (v.cargo.length >= tr.level.stackMax) {
    return emit(tr, 'hint', `Forks full (${tr.level.stackMax}). Deliver first.`);
  }
  let best: Order | null = null;
  let bd = Infinity;
  for (const o of w.orders) {
    if (o.state !== 'open') continue;
    const d = distTo(v, o.slot.ax, o.slot.ay);
    if (d <= TRIAL_REACH && d < bd) {
      bd = d;
      best = o;
    }
  }
  if (!best) return null;
  if (st.status === 'ready') st.status = 'running';
  best.state = 'picked';
  best.claimant = v.id;
  best.pickedAt = w.t;
  v.cargo.push(best);
  v.orders.push(best);
  const spec = tr.specs.get(best.id);
  const what = best.putaway ? `for ${best.putaway.rackId}` : `for Bay ${best.bay}`;
  const tag = spec?.fragile ? 'glass pallet' : spec?.heavy ? 'heavy pallet' : 'pallet';
  return emit(tr, 'pick', `Lifted ${tag} ${what} (${v.cargo.length}/${tr.level.stackMax}).`);
}

/** Guide pill target: next pallet to lift, where to drop / stow, or a charger detour. */
export interface TrialGuide {
  kind: 'pick' | 'drop' | 'charge';
  x: number;
  y: number;
  inRange: boolean;
  /** The pallet this step is about (for a charge detour: the next pallet target after it). */
  order: { id: number; bay: string; putaway?: { rackId: string; ax: number; ay: number } };
  /** Drop into a rack slot (putaway) rather than a bay. */
  stow?: boolean;
}

const guideOrder = (o: Order): TrialGuide['order'] =>
  o.putaway ? { id: o.id, bay: o.bay, putaway: { rackId: o.putaway.rackId, ax: o.putaway.ax, ay: o.putaway.ay } } : { id: o.id, bay: o.bay };

/** Renderer guide pill: next pallet to lift, the bay (or slot) for the load, or a charger. */
export function trialGuide(tr: Trial): TrialGuide | null {
  const st = tr.state;
  const w = tr.world;
  const v = tr.vehicle;
  if (st.status === 'won' || st.status === 'failed') return null;
  const target = palletGuide(tr);
  if (!target || !tr.level.battery || st.battery === null) return target;
  const c = chargeDetour(tr, tr.level.battery, target);
  if (!c) return target;
  return { kind: 'charge', x: c.x, y: c.y, inRange: v.tile.x === c.x && v.tile.y === c.y, order: target.order };

  function palletGuide(tr: Trial): TrialGuide | null {
    const open = w.orders.filter((o) => o.state === 'open');
    const top = v.cargo[v.cargo.length - 1];
    const full = v.cargo.length >= tr.level.stackMax;
    const topFrom = top ? tr.specs.get(top.id)?.from : undefined;
    // Outbound: same bay stacks. Inbound: pallets from the same dock stack while still at it.
    const sameDock = (o: Order): boolean =>
      !!topFrom && tr.specs.get(o.id)?.from === topFrom && distTo(v, o.slot.ax, o.slot.ay) <= DOCK_STACK_RANGE;
    let cands = top ? open.filter((o) => (topFrom ? sameDock(o) : o.bay === top.bay)) : open;
    if (top && (full || !cands.length)) return dropGuide(tr);
    // Heavy pallets first: while the stack is all heavy (or empty), prefer another heavy one.
    if (tr.specs.size && v.cargo.every((o) => isHeavy(tr, o)) && cands.some((o) => isHeavy(tr, o))) {
      cands = cands.filter((o) => isHeavy(tr, o));
    }
    let best: Order | null = null;
    let bd = Infinity;
    for (const o of cands) {
      const d = distTo(v, o.slot.ax, o.slot.ay);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    if (!best) return null;
    return { kind: 'pick', x: best.slot.ax, y: best.slot.ay, inRange: bd <= TRIAL_REACH, order: guideOrder(best) };
  }

  function dropGuide(tr: Trial): TrialGuide | null {
    // One destination: go there. Mixed loads (cross-dock, putaway): soonest reachable first,
    // counting the wait for a closed dock window.
    let pick = v.cargo[v.cargo.length - 1];
    if (v.cargo.some((o) => o.bay !== pick.bay)) {
      let bestScore = Infinity;
      for (const o of v.cargo) {
        const p = o.putaway ? { x: o.putaway.ax, y: o.putaway.ay } : bayTiles(w, o.bay)[1];
        if (!p) continue;
        const travel = distTo(v, p.x, p.y) / TRIAL_PAR_SPEED;
        const score = travel + (o.putaway ? 0 : windowWait(tr.level.windows, o.bay, st.t + travel));
        if (score < bestScore) {
          bestScore = score;
          pick = o;
        }
      }
    }
    if (pick.putaway) {
      const d = distTo(v, pick.putaway.ax, pick.putaway.ay);
      return {
        kind: 'drop',
        x: pick.putaway.ax,
        y: pick.putaway.ay,
        inRange: d <= TRIAL_REACH,
        order: guideOrder(pick),
        stow: true,
      };
    }
    const tiles = bayTiles(w, pick.bay);
    let bt = tiles[0];
    let bd = Infinity;
    for (const t of tiles) {
      const d = distTo(v, t.x, t.y);
      if (d < bd) {
        bd = d;
        bt = t;
      }
    }
    if (!bt) return null;
    return { kind: 'drop', x: bt.x, y: bt.y, inRange: bd <= TRIAL_BAY_REACH, order: guideOrder(pick) };
  }
}

const detourCache = new WeakMap<Trial, { key: string; charger: Point | null }>();

/**
 * Battery levels: the charger to visit before `target`, or null. Keeps guiding to the charger
 * while charging until full; otherwise detours when, after reaching the target, the truck could
 * no longer make it to a charger (unless the target finishes the level within the charge).
 */
function chargeDetour(tr: Trial, bat: TrialBattery, target: TrialGuide): Point | null {
  const st = tr.state;
  const v = tr.vehicle;
  const w = tr.world;
  const battery = st.battery ?? 0;
  if (st.charging && battery < 99.5) return { x: v.tile.x, y: v.tile.y };
  if (!bat.chargers.length) return null;
  const tgt: Point = target.kind === 'drop' && !target.stow ? (bayApproach(w, target.order.bay) ?? target) : target;
  const key = `${v.tile.x},${v.tile.y}|${tgt.x},${tgt.y}|${Math.floor(battery)}|${v.cargo.length}|${st.delivered}`;
  const hit = detourCache.get(tr);
  if (hit?.key === key) return hit.charger;
  const len = (a: Point, b: Point): number => {
    if (a.x === b.x && a.y === b.y) return 0;
    return findPath(w, a.x, a.y, b.x, b.y)?.length ?? Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  };
  const toTarget = len(v.tile, tgt);
  const lastDrop =
    target.kind === 'drop' && w.orders.every((o) => o.state === 'done' || (v.cargo.includes(o) && o.bay === target.order.bay));
  let charger: Point | null = null;
  if (!(lastDrop && toTarget * bat.perTile * 1.1 < battery)) {
    let near = bat.chargers[0];
    for (const c of bat.chargers) {
      if (Math.hypot(c.x - tgt.x, c.y - tgt.y) < Math.hypot(near.x - tgt.x, near.y - tgt.y)) near = c;
    }
    const need = (toTarget + len(tgt, near)) * bat.perTile * 1.1 + 2;
    if (battery < need) {
      charger = bat.chargers[0];
      for (const c of bat.chargers) {
        if (Math.hypot(c.x - v.px, c.y - v.py) < Math.hypot(charger.x - v.px, charger.y - v.py)) charger = c;
      }
    }
  }
  detourCache.set(tr, { key, charger });
  return charger;
}
