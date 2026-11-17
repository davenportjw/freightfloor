/**
 * Floor Trials (prototype): short single-player precision levels built on the real
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
 * Everything here is deterministic and pure TypeScript so the client can run it locally at
 * a fixed 10 Hz and the same rules stay unit-testable.
 */
import { createWorld, spawnPlayerVehicle, stepHuman } from './engine.js';
import { findPath, isBlocked } from './map.js';
import type { DriverInput, Order, Point, Vehicle, World } from './types.js';

export interface TrialPallet {
  /** Rack tile id (`map.racks[].id`, e.g. `H2-3`); the pallet waits on its access tile. */
  rack: string;
  /** Outbound bay id the pallet must reach (e.g. `E2`). */
  bay: string;
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
  /** Par multiplier for levels whose hazards force slower or longer lines (default 1). */
  parScale?: number;
}

export type TrialStatus = 'ready' | 'running' | 'won' | 'failed';

export type TrialEventKind =
  | 'pick'
  | 'drop'
  | 'topple'
  | 'crash'
  | 'rack_warn'
  | 'rack_fall'
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
}

export interface Trial {
  level: TrialLevel;
  world: World;
  vehicle: Vehicle;
  state: TrialState;
}

export const TRIAL_MAX_STRIKES = 3;
/** Sway spring stiffness and damping (θ'' = −kθ − cθ' + F). */
export const SWAY_K = 18;
export const SWAY_C = 3.5;
/** Sway gain by stack height (index = pallets on the forks). */
export const SWAY_GAIN = [0, 0.55, 1.0, 1.55] as const;
/** Hard-braking deceleration (tiles/min²) above which braking feeds the sway. */
export const SWAY_BRAKE_FREE = 7;
/** Minimum pre-impact speed for a rack strike. */
export const RACK_HIT_SPEED = 2.0;
/** Wall-hit speed that kicks the load (matches the engine's COLLISION_SPEED). */
export const SWAY_WALL_SPEED = 1.65;
/**
 * Single-tick speed loss that counts as an impact. Hardest braking (boost brake, 14/min²)
 * sheds at most 1.4 per 0.1-min tick, so anything larger means the truck hit something.
 */
export const IMPACT_DROP = 1.5;
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

/**
 * Par time: trips in level order, grouped by bay and limited by `stackMax`, at cruise speed
 * plus a fixed handling time per pick and drop.
 */
export function trialPar(w: World, level: TrialLevel): number {
  const trips: TrialPallet[][] = [];
  for (const p of level.pallets) {
    const last = trips[trips.length - 1];
    if (last && last.length < level.stackMax && last[0].bay === p.bay) last.push(p);
    else trips.push([p]);
  }
  let at: Point = { x: level.start.x, y: level.start.y };
  let tiles = 0;
  for (const trip of trips) {
    for (const p of trip) {
      const slot = w.map.slots.find((s) => s.rackId === p.rack);
      if (!slot) throw new Error(`Floor Trials: unknown rack ${p.rack}`);
      const to = { x: slot.ax, y: slot.ay };
      tiles += pathLen(w, at, to);
      at = to;
    }
    const drop = bayApproach(w, trip[0].bay);
    if (!drop) throw new Error(`Floor Trials: bay ${trip[0].bay} unreachable`);
    tiles += pathLen(w, at, drop);
    at = drop;
  }
  const handles = level.pallets.length + trips.length;
  const base = tiles / TRIAL_PAR_SPEED + handles * TRIAL_HANDLE_TIME;
  return Math.round(base * (level.parScale ?? 1) * 10) / 10;
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
  for (const p of level.pallets) {
    const slot = w.map.slots.find((s) => s.rackId === p.rack);
    if (!slot) throw new Error(`Floor Trials: unknown rack ${p.rack}`);
    if (!w.map.bays.some((b) => b.id === p.bay)) throw new Error(`Floor Trials: unknown bay ${p.bay}`);
    const o: Order = {
      id: w.nextOrderId++,
      sku: `TRL-${p.rack}`,
      slot: { ...slot },
      bay: p.bay,
      p0: false,
      value: 1,
      created: 0,
      due: 1e9,
      state: 'open',
      claimant: null,
      card: null,
    };
    w.orders.push(o);
  }
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
  };
  return { level, world: w, vehicle: v, state };
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
  strike(tr, 'topple', 'Load tipped! Top pallet fell.', tx, ty);
}

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
  stepHuman(w, v, input, dt);
  w.t += dt;
  st.t = Math.round((st.t + dt) * 1000) / 1000;

  // Boost crash: the engine already dumped the whole stack on the floor.
  if (v.cargo.length < prevCargo) {
    st.sway = 0;
    st.swayVel = 0;
    strike(tr, 'crash', 'Boost crash! The stack hit the floor.', v.tile.x, v.tile.y);
  }

  const n = Math.min(3, v.cargo.length);
  if (n === 0) {
    st.sway = 0;
    st.swayVel = 0;
  } else {
    const g = SWAY_GAIN[n];
    const yaw = Math.max(-4, Math.min(4, wrapAngle(v.angle - prevAngle) / dt));
    const speed = v.speedNow;
    let force = -g * speed * yaw;
    const decel = (Math.abs(prevSpeed) - Math.abs(speed)) / dt;
    if (speed !== 0 && decel > SWAY_BRAKE_FREE && decel * dt <= IMPACT_DROP) {
      force += (decel - SWAY_BRAKE_FREE) * 0.8 * g * (Math.sign(st.sway) || 1);
    }
    let kick = 0;
    const key = `${v.tile.x},${v.tile.y}`;
    const onSpill = w.spills.some((h) => h.x === v.tile.x && h.y === v.tile.y && h.until > w.t);
    if (onSpill && Math.abs(speed) > 1.2 && st.lastSpill !== key) {
      kick += ((v.tile.x + v.tile.y) % 2 === 0 ? 1 : -1) * 3 * g;
      st.lastSpill = key;
    }
    if (!onSpill) st.lastSpill = null;
    if (Math.abs(prevSpeed) > SWAY_WALL_SPEED && Math.abs(prevSpeed) - Math.abs(speed) > IMPACT_DROP * (dt / 0.1)) {
      kick += Math.abs(prevSpeed) * 0.9 * g * (Math.sign(st.sway) || 1);
    }
    const next = stepSway(st.sway, st.swayVel, force, kick, dt);
    st.sway = next.sway;
    st.swayVel = next.swayVel;
    if (Math.abs(st.sway) >= 1) toppleTop(tr);
  }

  const impact = Math.abs(prevSpeed) - Math.abs(v.speedNow) > IMPACT_DROP * (dt / 0.1);
  if (Math.abs(prevSpeed) >= RACK_HIT_SPEED && impact && st.status === 'running') {
    rackStrike(tr, prevSpeed);
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

/** The E key: deliver at a matching bay, otherwise lift the nearest floor pallet. */
export function trialInteract(tr: Trial): TrialEvent | null {
  const st = tr.state;
  const w = tr.world;
  const v = tr.vehicle;
  if (st.status === 'won' || st.status === 'failed') return null;
  if (Math.abs(v.speedNow) >= TRIAL_LIFT_SPEED) return emit(tr, 'hint', 'Slow down to lift.');
  if (v.cargo.length) {
    for (const b of w.map.bays) {
      if (!b.tiles.some((t) => distTo(v, t.x, t.y) <= TRIAL_BAY_REACH)) continue;
      const load = v.cargo.filter((o) => o.bay === b.id);
      if (!load.length) continue;
      if (st.status === 'ready') st.status = 'running';
      v.cargo = v.cargo.filter((o) => o.bay !== b.id);
      for (const o of load) {
        o.state = 'done';
        st.delivered++;
      }
      v.orders = v.orders.filter((x) => !load.includes(x));
      const bs = w.bays.find((x) => x.id === b.id);
      if (bs) bs.load += load.length;
      if (!v.cargo.length) {
        st.sway = 0;
        st.swayVel = 0;
      }
      const ev = emit(tr, 'drop', `Delivered ${load.length} to Bay ${b.id}.`, b.tiles[1]?.x, b.tiles[1]?.y);
      if (st.delivered >= st.total) {
        st.status = 'won';
        v.speedNow = 0;
        st.stars = starsFor(st.t, st.par, st.strikes);
        emit(tr, 'won', `Level clear in ${st.t.toFixed(1)}s.`);
      }
      return ev;
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
  return emit(tr, 'pick', `Lifted pallet for Bay ${best.bay} (${v.cargo.length}/${tr.level.stackMax}).`);
}

/** Renderer guide pill: next pallet to lift, or the bay for the top pallet. */
export function trialGuide(tr: Trial): {
  kind: 'pick' | 'drop';
  x: number;
  y: number;
  inRange: boolean;
  order: { id: number; bay: string };
} | null {
  const st = tr.state;
  const w = tr.world;
  const v = tr.vehicle;
  if (st.status === 'won' || st.status === 'failed') return null;
  const open = w.orders.filter((o) => o.state === 'open');
  const top = v.cargo[v.cargo.length - 1];
  const full = v.cargo.length >= tr.level.stackMax;
  const sameBayOpen = top ? open.filter((o) => o.bay === top.bay) : open;
  if (top && (full || !sameBayOpen.length)) {
    const tiles = bayTiles(w, top.bay);
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
    return { kind: 'drop', x: bt.x, y: bt.y, inRange: bd <= TRIAL_BAY_REACH, order: { id: top.id, bay: top.bay } };
  }
  let best: Order | null = null;
  let bd = Infinity;
  for (const o of sameBayOpen) {
    const d = distTo(v, o.slot.ax, o.slot.ay);
    if (d < bd) {
      bd = d;
      best = o;
    }
  }
  if (!best) return null;
  return {
    kind: 'pick',
    x: best.slot.ax,
    y: best.slot.ay,
    inRange: bd <= TRIAL_REACH,
    order: { id: best.id, bay: best.bay },
  };
}
