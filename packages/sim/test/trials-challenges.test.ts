import { describe, expect, it } from 'vitest';
import {
  CHARGE_RATE,
  FRAGILE_SWAY_LIMIT,
  HEAVY_BASE_GAIN,
  HEAVY_TOP_GAIN,
  STAR_2,
  TRAFFIC_COOLDOWN,
  TRIAL_BAY_REACH,
  TRIAL_LEVELS,
  TRIAL_REACH,
  createTrial,
  findPath,
  isBlocked,
  stackWeightFactor,
  stepTrial,
  trafficPose,
  trafficTiles,
  trialGuide,
  trialInteract,
  trialDropTargets,
  trialPar,
  trialSection,
  windowState,
  windowWait,
  type DriverInput,
  type Point,
  type Trial,
} from '../src/index.js';
import { guidedDrive } from './trialDriver.js';

const IDLE: DriverInput = { up: false, down: false, left: false, right: false };
const FWD: DriverInput = { up: true, down: false, left: false, right: false };
const FWD_LEFT: DriverInput = { ...FWD, left: true };
const CHALLENGES = TRIAL_LEVELS.filter((l) => trialSection(l) === 'challenge');
const NEW_FIELDS = ['cones', 'battery', 'windows', 'traffic', 'visibility'] as const;

function run(tr: Trial, input: DriverInput, steps: number): void {
  for (let i = 0; i < steps; i++) stepTrial(tr, input);
}

/** Loads the given level orders (by index) onto the forks, bottom first (test setup only). */
function loadIdx(tr: Trial, idx: number[]): void {
  for (const i of idx) {
    const o = tr.world.orders[i];
    o.state = 'picked';
    tr.vehicle.cargo.push(o);
    tr.vehicle.orders.push(o);
  }
}

function place(tr: Trial, x: number, y: number, angle = 0): void {
  const v = tr.vehicle;
  v.px = x + 0.5;
  v.py = y + 0.5;
  v.tile = { x, y };
  v.angle = angle;
  v.speedNow = 0;
}

/** Full-throttle run east on the y=21 highway, then a full-lock left turn; returns peak |sway|. */
function hardTurn(tr: Trial): number {
  place(tr, 25, 21);
  let peak = 0;
  for (const [inp, n] of [
    [FWD, 10],
    [FWD_LEFT, 8],
  ] as const) {
    for (let i = 0; i < n; i++) {
      stepTrial(tr, inp);
      peak = Math.max(peak, Math.abs(tr.state.sway));
    }
  }
  return peak;
}

const key = (p: Point): string => `${p.x},${p.y}`;

describe('level catalogue', () => {
  it('has 6 getting-started and 12 challenge levels, numbered 1–18 with unique ids', () => {
    expect(TRIAL_LEVELS.map((l) => l.num)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(new Set(TRIAL_LEVELS.map((l) => l.id)).size).toBe(18);
    expect(TRIAL_LEVELS.filter((l) => trialSection(l) === 'start')).toHaveLength(6);
    expect(CHALLENGES).toHaveLength(12);
  });

  it('getting-started levels use none of the challenge mechanics', () => {
    for (const l of TRIAL_LEVELS.filter((x) => trialSection(x) === 'start')) {
      for (const f of NEW_FIELDS) expect(l[f], `${l.id}.${f}`).toBeUndefined();
      for (const p of l.pallets) expect(Object.keys(p).sort()).toEqual(['bay', 'rack']);
    }
  });

  it('challenge pars match the docs/gameplay.md § 8 level table', () => {
    const pars = Object.fromEntries(CHALLENGES.map((l) => [l.id, createTrial(l.id).state.par]));
    expect(pars).toEqual({
      putaway: 29.6,
      fragile: 37.3,
      'heavy-bottom': 40.7,
      'cone-maze': 27.2,
      'low-battery': 70.5,
      'dock-windows': 50.9,
      traffic: 51.1,
      'lights-out': 26,
      'wet-and-wobbly': 58.5,
      'cross-dock': 77,
      'rush-hour-ii': 90.7,
      'night-shift': 63.1,
    });
  });

  it('every challenge level adds at least one mechanic', () => {
    for (const l of CHALLENGES) {
      const twist =
        NEW_FIELDS.some((f) => l[f] !== undefined) ||
        l.rackHp !== undefined ||
        (l.spills?.length ?? 0) > 0 ||
        l.pallets.some((p) => p.from || p.to || p.fragile || p.heavy);
      expect(twist, l.id).toBe(true);
    }
  });
});

describe.each(TRIAL_LEVELS.map((l) => [l.id, l] as const))('%s is valid on the Denver map', (id, level) => {
  const tr = createTrial(id);
  const w = tr.world;
  const m = w.map;
  const start = { x: level.start.x, y: level.start.y };
  const bayDrop = (bayId: string): Point => {
    const b = m.bays.find((x) => x.id === bayId)!;
    for (const t of b.tiles) {
      for (const [dx, dy] of [
        [-1, 0],
        [0, -1],
        [0, 1],
        [1, 0],
      ]) {
        if (!isBlocked(w, t.x + dx, t.y + dy)) return { x: t.x + dx, y: t.y + dy };
      }
    }
    throw new Error(`no drop tile for ${bayId}`);
  };
  const pickups = w.orders.map((o) => ({ x: o.slot.ax, y: o.slot.ay }));
  const drops = w.orders.map((o) => (o.putaway ? { x: o.putaway.ax, y: o.putaway.ay } : bayDrop(o.bay)));

  it('pallets name real racks, docks and bays with exactly one source and destination', () => {
    for (const p of level.pallets) {
      expect(Boolean(p.rack) !== Boolean(p.from), JSON.stringify(p)).toBe(true);
      expect(Boolean(p.bay) !== Boolean(p.to), JSON.stringify(p)).toBe(true);
      if (p.rack) expect(m.racks.some((r) => r.id === p.rack)).toBe(true);
      if (p.to) expect(m.racks.some((r) => r.id === p.to)).toBe(true);
      if (p.bay) expect(m.bays.some((b) => b.id === p.bay)).toBe(true);
      if (p.from) expect(m.westDocks.some((d) => d.id === p.from) || m.bays.some((b) => b.id === p.from)).toBe(true);
    }
    expect(w.orders).toHaveLength(level.pallets.length);
    expect(new Set(pickups.map(key)).size).toBe(pickups.length);
  });

  it('start is free and every pickup and drop is reachable', () => {
    expect(isBlocked(w, start.x, start.y)).toBe(false);
    w.orders.forEach((_, i) => {
      expect(isBlocked(w, pickups[i].x, pickups[i].y)).toBe(false);
      expect(findPath(w, start.x, start.y, pickups[i].x, pickups[i].y), `pickup ${i}`).not.toBeNull();
      expect(findPath(w, pickups[i].x, pickups[i].y, drops[i].x, drops[i].y), `drop ${i}`).not.toBeNull();
    });
    expect(tr.state.par).toBeGreaterThan(5);
  });

  it('cones, spills, chargers, windows and traffic never make it impossible', () => {
    const keep = new Set([key(start), ...pickups.map(key), ...drops.map(key)]);
    for (const c of level.cones ?? []) {
      expect(m.staticBlock[c.y * m.w + c.x], `cone on a wall ${key(c)}`).toBe(0);
      expect(keep.has(key(c)), `cone on a key tile ${key(c)}`).toBe(false);
      expect(w.cones.has(key(c))).toBe(true);
    }
    for (const s of level.spills ?? []) expect(isBlocked(w, s.x, s.y), `spill ${key(s)}`).toBe(false);
    if (level.battery) {
      expect(level.battery.chargers.length).toBeGreaterThan(0);
      for (const c of level.battery.chargers) {
        expect(m.chargers.some((x) => x.x === c.x && x.y === c.y), `charger ${key(c)}`).toBe(true);
        expect(findPath(w, start.x, start.y, c.x, c.y)).not.toBeNull();
      }
    }
    for (const [bay, win] of Object.entries(level.windows ?? {})) {
      expect(m.bays.some((b) => b.id === bay)).toBe(true);
      expect(win.open).toBeGreaterThan(0);
      expect(win.open).toBeLessThan(win.period);
    }
    for (const tk of level.traffic ?? []) {
      expect(tk.path.length).toBeGreaterThanOrEqual(2);
      expect(tk.speed).toBeGreaterThan(0);
      tk.path.forEach((a, i) => {
        const b = tk.path[(i + 1) % tk.path.length];
        expect(a.x === b.x || a.y === b.y, 'axis-aligned legs').toBe(true);
      });
      for (const t of trafficTiles(tk)) {
        expect(isBlocked(w, t.x, t.y), `traffic over a blocked tile ${key(t)}`).toBe(false);
        expect(keep.has(key(t)), `traffic over a pickup/drop/start tile ${key(t)}`).toBe(false);
      }
    }
    if (level.visibility !== undefined) {
      expect(level.visibility).toBeGreaterThanOrEqual(3);
      expect(level.visibility).toBeLessThanOrEqual(10);
    }
  });
});

describe('dock windows', () => {
  const wins = { E3: { period: 16, open: 6 }, E4: { period: 16, open: 6, offset: 8 } };

  it('windowState cycles open → closed with the time left', () => {
    expect(windowState(wins, 'E3', 0)).toEqual({ open: true, left: 6 });
    expect(windowState(wins, 'E3', 7)).toEqual({ open: false, left: 9 });
    expect(windowState(wins, 'E3', 16.5)).toEqual({ open: true, left: 5.5 });
    expect(windowState(wins, 'E4', 0)).toEqual({ open: false, left: 8 });
    expect(windowState(wins, 'E4', 8)).toEqual({ open: true, left: 6 });
    expect(windowState(wins, 'E1', 3)).toBeNull();
    expect(windowWait(wins, 'E4', 2)).toBe(6);
    expect(windowWait(wins, 'E3', 2)).toBe(0);
    expect(windowWait(undefined, 'E3', 2)).toBe(0);
  });

  it('a closed bay refuses the drop and an open one takes it', () => {
    const tr = createTrial('dock-windows');
    const e4 = tr.world.orders.findIndex((o) => o.bay === 'E4');
    loadIdx(tr, [e4]);
    place(tr, 57, 18);
    tr.state.status = 'running';
    tr.state.t = 1;
    const ev = trialInteract(tr);
    expect(ev?.kind).toBe('closed');
    expect(ev?.text).toMatch(/Opens in 7\.0s/);
    expect(tr.vehicle.cargo).toHaveLength(1);
    tr.state.t = 9;
    expect(trialInteract(tr)?.kind).toBe('drop');
    expect(tr.state.delivered).toBe(1);
  });

  it('par includes the wait for closed doors', () => {
    const tr = createTrial('dock-windows');
    const noWin = { ...tr.level, windows: undefined };
    expect(tr.state.par).toBeGreaterThan(trialPar(tr.world, noWin));
  });
});

describe('scripted traffic', () => {
  const shuttle = { path: [{ x: 40, y: 19 }, { x: 40, y: 31 }], speed: 2.4 };

  it('trafficPose is a pure function of level time along the loop', () => {
    expect(trafficPose(shuttle, 0)).toEqual({ x: 40.5, y: 19.5, a: Math.PI / 2 });
    expect(trafficPose(shuttle, 5).y).toBeCloseTo(31.5, 6);
    expect(trafficPose(shuttle, 7.5)).toMatchObject({ x: 40.5, y: 25.5, a: -Math.PI / 2 });
    expect(trafficPose(shuttle, 10)).toEqual(trafficPose(shuttle, 0));
    expect(trafficPose({ ...shuttle, phase: 12 }, 0).y).toBeCloseTo(31.5, 6);
    expect(trafficTiles(shuttle)).toHaveLength(24);
  });

  it('a forklift that reaches the truck is a strike, then cools down', () => {
    const tr = createTrial('traffic');
    place(tr, 40, 21);
    tr.state.status = 'running';
    let hitAt = -1;
    for (let i = 0; i < 30 && hitAt < 0; i++) {
      stepTrial(tr, IDLE);
      if (tr.state.strikes) hitAt = tr.state.t;
    }
    expect(hitAt).toBeGreaterThan(0);
    expect(tr.state.events.some((e) => e.kind === 'traffic')).toBe(true);
    expect(tr.state.trafficCool[0]).toBeCloseTo(hitAt + TRAFFIC_COOLDOWN, 6);
    run(tr, IDLE, 5);
    expect(tr.state.strikes).toBe(1);
  });

  it('traffic is identical across replays', () => {
    const a = createTrial('rush-hour-ii');
    const b = createTrial('rush-hour-ii');
    for (const tr of [a, b]) run(tr, FWD, 40);
    expect(a.state.t).toBe(b.state.t);
    a.level.traffic!.forEach((tk) => expect(trafficPose(tk, a.state.t)).toEqual(trafficPose(tk, b.state.t)));
    expect(a.state.strikes).toBe(b.state.strikes);
  });
});

describe('weight and glass', () => {
  it('stackWeightFactor rewards heavy-bottom and punishes heavy-on-light', () => {
    expect(stackWeightFactor([false, false, false])).toBe(1);
    expect(stackWeightFactor([])).toBe(1);
    expect(stackWeightFactor([true, false])).toBe(HEAVY_BASE_GAIN);
    expect(stackWeightFactor([false, true])).toBe(HEAVY_TOP_GAIN);
    expect(stackWeightFactor([true, true, false])).toBe(HEAVY_BASE_GAIN);
    expect(stackWeightFactor([false, true, true])).toBeCloseTo(HEAVY_TOP_GAIN ** 2, 9);
  });

  it('the same hard turn keeps heavy-bottom but tips heavy-on-top', () => {
    // heavy-bottom orders: [0] G1-2 heavy, [1] G2-4 light.
    const bottom = createTrial('heavy-bottom');
    loadIdx(bottom, [0, 1]);
    hardTurn(bottom);
    expect(bottom.vehicle.cargo).toHaveLength(2);
    expect(bottom.state.strikes).toBe(0);

    const top = createTrial('heavy-bottom');
    loadIdx(top, [1, 0]);
    hardTurn(top);
    expect(top.vehicle.cargo).toHaveLength(1);
    expect(top.state.strikes).toBe(1);
  });

  it('glass tips at FRAGILE_SWAY_LIMIT where a plain stack rides it out', () => {
    // fragile orders: [0] V2-2 glass, [1] W1-4 plain, [2] W2-1 glass, [3] U2-5 plain.
    const plain = createTrial('fragile');
    loadIdx(plain, [1, 3]);
    const peak = hardTurn(plain);
    expect(peak).toBeGreaterThan(FRAGILE_SWAY_LIMIT);
    expect(peak).toBeLessThan(1);
    expect(plain.state.status).toBe('running');
    expect(plain.state.strikes).toBe(0);

    const glass = createTrial('fragile');
    loadIdx(glass, [1, 0]);
    hardTurn(glass);
    expect(glass.state.status).toBe('failed');
    expect(glass.state.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['shatter', 'failed']));
    expect(glass.state.strikes).toBe(0);
  });

  it('a plain pallet falling off a glass base is only a strike', () => {
    const tr = createTrial('fragile');
    loadIdx(tr, [0, 1]);
    hardTurn(tr);
    expect(tr.state.strikes).toBe(1);
    expect(tr.vehicle.cargo.map((o) => o.id)).toEqual([tr.world.orders[0].id]);
    expect(tr.state.status).toBe('running');
  });

  it('the guide lifts heavy pallets first', () => {
    const tr = createTrial('heavy-bottom');
    const g = trialGuide(tr)!;
    expect(tr.specs.get(g.order.id)?.heavy).toBe(true);
  });
});

describe('putaway and cross-dock', () => {
  it('inbound pallets wait on the dock apron and stow at their marked slot', () => {
    const tr = createTrial('putaway');
    const o = tr.world.orders[0];
    expect(o.slot.rackId).toBe('W2');
    expect(Math.abs(o.slot.ax - 1) + Math.abs(o.slot.ay - 16)).toBeLessThanOrEqual(3);
    expect(o.putaway?.rackId).toBe('I1-2');
    place(tr, o.slot.ax, o.slot.ay);
    tr.state.status = 'running';
    // Lift every pallet within reach until the forks are full.
    expect(trialInteract(tr)?.kind).toBe('pick');
    const carried = tr.vehicle.cargo[0];
    const g = trialGuide(tr)!;
    if (g.kind === 'pick') trialInteract(tr);
    const drop = trialGuide(tr)!;
    expect(drop).toMatchObject({ kind: 'drop', stow: true });
    expect(drop.order.putaway?.rackId).toMatch(/^[IJK][12]-\d$/);
    // A bay never accepts a putaway pallet.
    place(tr, 57, 9);
    expect(trialInteract(tr)?.kind).not.toBe('stow');
    place(tr, carried.putaway!.ax, carried.putaway!.ay);
    const ev = trialInteract(tr);
    expect(ev?.kind).toBe('stow');
    expect(carried.state).toBe('done');
    expect(tr.state.delivered).toBeGreaterThanOrEqual(1);
  });

  it('a mixed cross-dock stack drops only the pallets each bay takes', () => {
    const tr = createTrial('cross-dock');
    // orders: E3, E5, E7, E7, E5, E3
    loadIdx(tr, [0, 1, 2]);
    place(tr, 57, 24);
    tr.state.status = 'running';
    const ev = trialInteract(tr);
    expect(ev?.text).toBe('Delivered 1 to Bay E5.');
    expect(tr.vehicle.cargo.map((o) => o.bay)).toEqual(['E3', 'E7']);
    expect(trialGuide(tr)?.kind).toBe('drop');
  });
});

describe('drop targets', () => {
  it('trialDropTargets lists every bay tile and putaway slot a level delivers to', () => {
    for (const level of TRIAL_LEVELS) {
      const targets = trialDropTargets(level);
      const tr = createTrial(level.id);
      for (const o of tr.world.orders) {
        if (o.putaway) {
          expect(targets).toContainEqual({ x: o.putaway.ax, y: o.putaway.ay, kind: 'stow', id: o.putaway.rackId, reach: TRIAL_REACH });
        } else {
          const bay = tr.world.map.bays.find((b) => b.id === o.bay)!;
          for (const t of bay.tiles) expect(targets).toContainEqual({ x: t.x, y: t.y, kind: 'bay', id: o.bay, reach: TRIAL_BAY_REACH });
        }
      }
      expect(targets.every((t) => t.reach > 0)).toBe(true);
    }
  });
});

describe('cones', () => {

  it('cone-maze cones block their tiles but leave every target routable', () => {
    const tr = createTrial('cone-maze');
    for (const c of tr.level.cones!) expect(isBlocked(tr.world, c.x, c.y)).toBe(true);
    expect(findPath(tr.world, 8, 12, 57, 18)).not.toBeNull();
  });
});

describe('battery', () => {
  it('drains with distance driven', () => {
    const tr = createTrial('low-battery');
    place(tr, 10, 21);
    run(tr, FWD, 20);
    const driven = tr.vehicle.px - 10.5;
    expect(driven).toBeGreaterThan(3);
    expect(tr.state.battery!).toBeCloseTo(55 - driven * 0.6, 1);
  });

  it('charges while parked on a working charger only', () => {
    const tr = createTrial('low-battery');
    tr.state.status = 'running';
    tr.state.battery = 20;
    place(tr, 20, 40); // a real charger, but not one of this level's
    run(tr, IDLE, 10);
    expect(tr.state.battery).toBe(20);
    place(tr, 25, 40);
    run(tr, IDLE, 10);
    expect(tr.state.battery!).toBeCloseTo(20 + CHARGE_RATE, 6);
    expect(tr.state.events.some((e) => e.kind === 'charge')).toBe(true);
  });

  it('a flat battery fails the level', () => {
    const tr = createTrial('low-battery');
    place(tr, 10, 21);
    tr.state.battery = 0.5;
    run(tr, FWD, 20);
    expect(tr.state.status).toBe('failed');
    expect(tr.state.battery).toBe(0);
    expect(tr.state.events.at(-1)?.text).toMatch(/Battery flat/);
  });

  it('the guide detours to a charger when the charge runs short', () => {
    const tr = createTrial('low-battery');
    expect(trialGuide(tr)?.kind).toBe('pick');
    tr.state.battery = 8;
    const g = trialGuide(tr)!;
    expect(g.kind).toBe('charge');
    expect(tr.level.battery!.chargers.some((c) => c.x === g.x && c.y === g.y)).toBe(true);
  });

  it('par includes the cheapest charger detour', () => {
    for (const id of ['low-battery', 'night-shift']) {
      const tr = createTrial(id);
      expect(tr.state.par, id).toBeGreaterThan(trialPar(tr.world, { ...tr.level, battery: undefined }));
    }
  });
});

describe('challenge solvability', () => {
  it.each(CHALLENGES.map((l) => [l.num, l.id] as const))('%i %s is cleared cleanly by the guided driver', (_n, id) => {
    const tr = createTrial(id);
    const log = guidedDrive(tr);
    expect(tr.state.status).toBe('won');
    expect(tr.state.strikes).toBe(0);
    expect(tr.state.stars).toBeGreaterThanOrEqual(2);
    // Par is fair (a careful driver makes 2★) but not loose (the bot can't lap it).
    expect(tr.state.t).toBeLessThanOrEqual(tr.state.par * STAR_2);
    expect(tr.state.t).toBeGreaterThan(tr.state.par * 0.9);
    if (tr.level.battery) expect(log.charges).toBeGreaterThanOrEqual(1);
    if (tr.level.traffic) expect(log.trafficYields).toBeGreaterThan(0);
  });
});
