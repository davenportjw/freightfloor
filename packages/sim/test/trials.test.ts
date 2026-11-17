import { describe, expect, it } from 'vitest';
import {
  SWAY_BOOST_KNEE,
  TRIAL_LEVELS,
  createTrial,
  findPath,
  starsFor,
  stepSway,
  stepTrial,
  swaySpeed,
  trialGuide,
  trialInteract,
  type DriverInput,
  type Trial,
} from '../src/index.js';

const IDLE: DriverInput = { up: false, down: false, left: false, right: false };
const FWD: DriverInput = { up: true, down: false, left: false, right: false };
const FWD_LEFT: DriverInput = { up: true, down: false, left: true, right: false };

/** Loads `n` of the level's pallets straight onto the forks (test setup only). */
function load(tr: Trial, n: number): void {
  for (const o of tr.world.orders.slice(0, n)) {
    o.state = 'picked';
    tr.vehicle.cargo.push(o);
  }
}

function run(tr: Trial, input: DriverInput, steps: number): void {
  for (let i = 0; i < steps; i++) stepTrial(tr, input);
}

/** Puts the truck on an open stretch of the y=21 highway heading east. */
function onHighway(tr: Trial, x = 25): void {
  const v = tr.vehicle;
  v.px = x + 0.5;
  v.py = 21.5;
  v.tile = { x, y: 21 };
  v.angle = 0;
}

describe('Floor Trials levels', () => {
  it.each(TRIAL_LEVELS.map((l) => [l.id]))('%s has routable pallets and bays', (id) => {
    const tr = createTrial(id);
    const { level, world } = tr;
    expect(world.orders).toHaveLength(level.pallets.length);
    for (const o of world.orders) {
      expect(findPath(world, level.start.x, level.start.y, o.slot.ax, o.slot.ay)).not.toBeNull();
      expect(world.map.bays.some((b) => b.id === o.bay)).toBe(true);
    }
    expect(tr.state.par).toBeGreaterThan(5);
    expect(tr.state.status).toBe('ready');
  });

  it('is deterministic for identical inputs', () => {
    const a = createTrial('tower-of-three');
    const b = createTrial('tower-of-three');
    for (const tr of [a, b]) {
      load(tr, 2);
      run(tr, FWD, 15);
      run(tr, FWD_LEFT, 8);
    }
    expect(a.vehicle.px).toBe(b.vehicle.px);
    expect(a.state.sway).toBe(b.state.sway);
    expect(a.state.t).toBe(b.state.t);
  });

  it('clock waits for the first input', () => {
    const tr = createTrial('first-lift');
    run(tr, IDLE, 10);
    expect(tr.state.t).toBe(0);
    run(tr, FWD, 3);
    expect(tr.state.status).toBe('running');
    expect(tr.state.t).toBeCloseTo(0.3, 5);
  });
});

describe('load sway', () => {
  it('pure oscillator decays back to rest', () => {
    let s = { sway: 0.6, swayVel: 0 };
    for (let i = 0; i < 100; i++) s = stepSway(s.sway, s.swayVel, 0, 0, 0.1);
    expect(Math.abs(s.sway)).toBeLessThan(0.01);
  });

  it('a full-speed turn tips a 3-stack but not a single pallet', () => {
    const tall = createTrial('tower-of-three');
    onHighway(tall);
    load(tall, 3);
    run(tall, FWD, 12);
    run(tall, FWD_LEFT, 8);
    expect(tall.vehicle.cargo.length).toBeLessThan(3);
    expect(tall.state.strikes).toBeGreaterThanOrEqual(1);
    const fallen = tall.world.orders.find((o) => o.state === 'open' && o.slot.rackId !== undefined && o.slot.key.includes(','));
    expect(fallen).toBeDefined();

    const single = createTrial('tower-of-three');
    onHighway(single);
    load(single, 1);
    run(single, FWD, 12);
    run(single, FWD_LEFT, 8);
    expect(single.vehicle.cargo).toHaveLength(1);
    expect(single.state.strikes).toBe(0);
  });

  it('a fallen pallet can be lifted again from the floor', () => {
    const tr = createTrial('tower-of-three');
    onHighway(tr);
    load(tr, 3);
    run(tr, FWD, 12);
    run(tr, FWD_LEFT, 8);
    const fallen = tr.world.orders.find((o) => o.state === 'open' && o.slot.key === `${o.slot.ax},${o.slot.ay}`);
    expect(fallen).toBeDefined();
    const v = tr.vehicle;
    v.speedNow = 0;
    v.px = fallen!.slot.ax + 0.5;
    v.py = fallen!.slot.ay + 0.5;
    const ev = trialInteract(tr);
    expect(ev?.kind).toBe('pick');
    expect(fallen!.state).toBe('picked');
  });

  it('three strikes fail the level', () => {
    const tr = createTrial('tower-of-three');
    for (let i = 0; i < 3; i++) {
      onHighway(tr, 25);
      tr.vehicle.speedNow = 0;
      tr.state.sway = 0;
      tr.state.swayVel = 0;
      for (const o of tr.world.orders) o.state = 'open';
      tr.vehicle.cargo = [];
      load(tr, 3);
      run(tr, FWD, 12);
      run(tr, FWD_LEFT, 10);
      if (tr.state.status === 'failed') break;
    }
    expect(tr.state.strikes).toBeGreaterThanOrEqual(3);
    expect(tr.state.status).toBe('failed');
    const t = tr.state.t;
    run(tr, FWD, 5);
    expect(tr.state.t).toBe(t);
  });
});

describe('boost with a load', () => {
  const BOOST: DriverInput = { up: true, down: false, left: false, right: false, boost: true };
  const BOOST_LEFT: DriverInput = { ...BOOST, left: true };
  const BOOST_BRAKE: DriverInput = { up: false, down: true, left: false, right: false, boost: true };
  const CRUISE: DriverInput = { ...BOOST, boost: false };

  function boosted(n: number): Trial {
    const tr = createTrial('tower-of-three');
    onHighway(tr, 10);
    load(tr, n);
    run(tr, BOOST, 8);
    expect(tr.vehicle.speedNow).toBeGreaterThan(SWAY_BOOST_KNEE * 1.5);
    return tr;
  }

  it('swaySpeed is full up to cruise and damped above it', () => {
    expect(swaySpeed(3)).toBe(3);
    expect(swaySpeed(-3)).toBe(-3);
    expect(swaySpeed(SWAY_BOOST_KNEE + 2)).toBeCloseTo(SWAY_BOOST_KNEE + 1);
  });

  it.each([1, 2, 3])('letting go of boost on a straight lurches %i pallet(s) without a topple', (n) => {
    const tr = boosted(n);
    let peak = 0;
    for (let i = 0; i < 12; i++) {
      stepTrial(tr, CRUISE);
      peak = Math.max(peak, Math.abs(tr.state.sway));
    }
    expect(peak).toBeGreaterThan(0.1);
    expect(tr.state.strikes).toBe(0);
    expect(tr.vehicle.cargo).toHaveLength(n);
  });

  it.each([1, 2, 3])('braking hard from boost keeps %i pallet(s) on a straight', (n) => {
    const tr = boosted(n);
    run(tr, BOOST_BRAKE, 10);
    expect(tr.state.strikes).toBe(0);
    expect(tr.vehicle.cargo).toHaveLength(n);
  });

  it('a steering tap at boost speed is survivable with a full stack', () => {
    const tr = boosted(3);
    run(tr, BOOST_LEFT, 1);
    run(tr, BOOST, 6);
    expect(tr.state.strikes).toBe(0);
  });

  it('a boosted bend with a full stack still tips it', () => {
    const tr = createTrial('tower-of-three');
    onHighway(tr, 25);
    load(tr, 3);
    run(tr, BOOST, 8);
    run(tr, BOOST_LEFT, 6);
    expect(tr.state.strikes).toBeGreaterThanOrEqual(1);
    expect(tr.vehicle.cargo.length).toBeLessThan(3);
  });
});

describe('pick, deliver and stars', () => {
  it('first-lift completes via E at the pallet and the bay', () => {
    const tr = createTrial('first-lift');
    const v = tr.vehicle;
    const o = tr.world.orders[0];
    expect(trialGuide(tr)?.kind).toBe('pick');
    v.px = o.slot.ax + 0.5;
    v.py = o.slot.ay + 0.5;
    expect(trialInteract(tr)?.kind).toBe('pick');
    expect(trialGuide(tr)).toMatchObject({ kind: 'drop', order: { bay: 'E2' } });
    expect(trialInteract(tr)?.kind).not.toBe('pick'); // forks full on a 1-stack level
    v.px = 57.5;
    v.py = 9.5;
    tr.state.t = 9;
    expect(trialInteract(tr)?.kind).toBe('drop');
    expect(tr.state.status).toBe('won');
    expect(tr.state.stars).toBe(3);
    expect(tr.world.bays.find((b) => b.id === 'E2')?.load).toBe(1);
  });

  it('refuses to lift while moving', () => {
    const tr = createTrial('first-lift');
    tr.vehicle.speedNow = 2;
    expect(trialInteract(tr)?.kind).toBe('hint');
  });

  it('starsFor applies time thresholds and the strike cap', () => {
    expect(starsFor(10, 10, 0)).toBe(3);
    expect(starsFor(15, 10, 0)).toBe(2);
    expect(starsFor(30, 10, 0)).toBe(1);
    expect(starsFor(10, 10, 1)).toBe(2);
    expect(starsFor(10, 10, 2)).toBe(1);
    expect(starsFor(10, 10, 3)).toBe(0);
  });
});

/** Crude path-following driver: proves every level is solvable with real physics. */
function autoplay(tr: Trial): void {
  const v = tr.vehicle;
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const driveTo = (tx: number, ty: number): boolean => {
    let path = findPath(tr.world, v.tile.x, v.tile.y, tx, ty) ?? [];
    let i = 0;
    for (let n = 0; n < 900; n++) {
      if (tr.state.status === 'failed') return false;
      while (i < path.length && Math.hypot(v.px - (path[i].x + 0.5), v.py - (path[i].y + 0.5)) < 0.45) i++;
      const endD = Math.hypot(v.px - (tx + 0.5), v.py - (ty + 0.5));
      if (endD < 0.9 && Math.abs(v.speedNow) < 0.6) return true;
      const wp = path[Math.min(i, path.length - 1)] ?? { x: tx, y: ty };
      const diff = wrap(Math.atan2(wp.y + 0.5 - v.py, wp.x + 0.5 - v.px) - v.angle);
      const nxt = path[i + 1];
      const turnAhead = nxt ? Math.abs(wrap(Math.atan2(nxt.y - wp.y, nxt.x - wp.x) - v.angle)) > 0.5 : false;
      const corner = [3, 2.6, 1.9, 1.4][v.cargo.length];
      const slow = endD < 1.8 || (turnAhead && Math.abs(v.speedNow) > corner) || Math.abs(diff) > 0.6;
      const creep = endD < 1.8 && endD > 0.8 && Math.abs(diff) < 0.6 && v.speedNow < 0.7;
      stepTrial(tr, {
        up: !slow || creep,
        down: slow && !creep && v.speedNow > (endD < 1.8 ? 0.2 : corner * 0.8),
        left: diff < -0.08,
        right: diff > 0.08,
      });
      if (n % 60 === 59 && (i >= path.length || Math.abs(v.speedNow) < 0.05)) {
        path = findPath(tr.world, v.tile.x, v.tile.y, tx, ty) ?? [];
        i = 0;
      }
    }
    return false;
  };
  for (let guard = 0; guard < 30 && tr.state.status !== 'won' && tr.state.status !== 'failed'; guard++) {
    const g = trialGuide(tr);
    if (!g) return;
    const bay = g.kind === 'drop' ? tr.world.map.bays.find((b) => b.id === g.order.bay)! : null;
    const target = bay ? { x: bay.tiles[1].x - 1, y: bay.tiles[1].y } : { x: g.x, y: g.y };
    if (!driveTo(target.x, target.y)) return;
    for (let k = 0; k < 8 && v.speedNow > 0; k++) stepTrial(tr, { ...IDLE, down: true });
    trialInteract(tr);
  }
}

describe('solvability', () => {
  it.each(TRIAL_LEVELS.map((l) => [l.id]))('%s can be cleared cleanly by a cautious driver', (id) => {
    const tr = createTrial(id);
    autoplay(tr);
    expect(tr.state.status).toBe('won');
    expect(tr.state.strikes).toBe(0);
    expect(tr.state.stars).toBeGreaterThanOrEqual(1);
    expect(tr.state.t).toBeLessThan(tr.state.par * 2.5);
  });
});

describe('falling racks', () => {
  /** Rams the H2-3 rack face from the aisle at x=40 heading east (rack tiles at x=42/43). */
  function ram(tr: Trial): void {
    const v = tr.vehicle;
    v.px = 40.5;
    v.py = 6.5;
    v.tile = { x: 40, y: 6 };
    v.angle = 0;
    v.speedNow = 2.6;
    v.stunnedUntil = 0;
    stepTrial(tr, FWD);
    for (let i = 0; i < 4 && v.speedNow !== 0; i++) stepTrial(tr, FWD);
  }

  it('first hard hit warns, second hit drops the rack and leaves expiring debris', () => {
    const tr = createTrial('double-stack');
    tr.state.status = 'running';
    ram(tr);
    const hitId = Object.keys(tr.state.rackHits)[0];
    expect(hitId).toBeDefined();
    expect(tr.state.events.some((e) => e.kind === 'rack_warn')).toBe(true);
    expect(tr.state.strikes).toBe(0);
    ram(tr);
    expect(tr.state.fallenRacks).toContain(hitId);
    expect(tr.state.strikes).toBe(1);
    expect(tr.state.debris.length).toBeGreaterThan(0);
    const key = tr.state.debris[0].key;
    expect(tr.world.cones.has(key)).toBe(true);
    tr.vehicle.stunnedUntil = 0;
    run(tr, { up: false, down: false, left: true, right: false }, 210);
    expect(tr.world.cones.has(key)).toBe(false);
    expect(tr.state.debris).toHaveLength(0);
  });

  it('wobbly racks fall on the first hit', () => {
    const tr = createTrial('wobbly-racks');
    tr.state.status = 'running';
    ram(tr);
    expect(tr.state.fallenRacks).toHaveLength(1);
    expect(tr.state.strikes).toBe(1);
  });
});
