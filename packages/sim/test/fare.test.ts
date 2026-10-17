import { describe, expect, it } from 'vitest';
import {
  applyDecision,
  BATTERY_TIP,
  COMBO_STEPS,
  ContractOption,
  createWorld,
  diffOf,
  deliver,
  dropPalletOnCollision,
  humanInteract,
  Order,
  PAR_OVERHEAD,
  parLoadedFor,
  parFor,
  postOrder,
  PRECISION_FROM_SPEED,
  rateFare,
  resetCombo,
  SimEvent,
  SKILLS,
  spawnPlayerVehicle,
  stepHuman,
  tick,
  TRAILER_CLOSER_PTS,
  Vehicle,
  World,
} from '../src/index.js';
import { BASE_HWY_Y, isBlocked } from '../src/map.js';

const META = { model: 'gemini-3.8-flash', latencyMs: 1, inputTokens: 1, outputTokens: 1 };

/** Drive pending Brain decisions through the real `applyDecision` API (first valid option). */
function drivePendingDecisions(w: World): void {
  for (const req of [...w.pendingDecisions]) {
    if (req.kind === 'contract' && req.options.length) {
      const first = req.options[0] as ContractOption;
      applyDecision(w, req.id, { orderIds: [first.orderId], reason: 'first' }, META);
    } else if (req.kind === 'hazard') {
      applyDecision(w, req.id, { choice: 'reroute', reason: 'reroute' }, META);
    } else if (req.kind === 'tactics') {
      applyDecision(
        w,
        req.id,
        { speed: 1.15, buffer: 2, respect: 0.85, chargeAt: 25, batch: 2, reason: 'balanced' },
        META,
      );
    } else if (req.kind === 'cards' && req.options.length) {
      applyDecision(w, req.id, { keep: req.options.slice(0, 2).map((o) => o.id), reason: 'keep' }, META);
    }
  }
}

function collect(w: World, type: string): SimEvent[] {
  const out: SimEvent[] = [];
  w.listeners.push((e) => {
    if (e.type === type) out.push(e);
  });
  return out;
}

/** A human driver with an empty hand so card perks don't confound fare maths. */
function freshHuman(seed: number, id = 'fare-driver'): { w: World; v: Vehicle } {
  const w = createWorld({ seed, agents: 0 });
  const v = spawnPlayerVehicle(w, id, 'FarePilot', 'blitz')!;
  w.cards[id]!.cards = [];
  w.cards[id]!.offer = null;
  w.bays.forEach((b) => (b.load = 0));
  return { w, v };
}

/** Put an order on the forks with a given loaded-leg time vs. par. */
function load(w: World, v: Vehicle, opts: { actual: number; par: number | null; value?: number; late?: boolean }): Order {
  const o = postOrder(w, { bayId: 'E1', force: true })!;
  o.value = opts.value ?? 20;
  o.state = 'picked';
  o.claimant = v.id;
  o.pickedAt = w.t - opts.actual;
  o.parLoaded = opts.par ?? undefined;
  o.due = opts.late ? w.t - 1 : w.t + 50;
  v.cargo.push(o);
  if (!v.orders.includes(o)) v.orders.push(o);
  return o;
}

describe('fare core: par, rating, combo', () => {
  it('par is deterministic per map and set at pickup', () => {
    const w1 = createWorld({ seed: 31337, agents: 0 });
    const w2 = createWorld({ seed: 31337, agents: 0 });
    const o1 = postOrder(w1, { bayId: 'E1', force: true })!;
    const o2 = postOrder(w2, { bayId: 'E1', force: true })!;
    const p1 = parLoadedFor(w1, o1);
    expect(p1).not.toBeNull();
    expect(p1!).toBeGreaterThan(0);
    expect(parLoadedFor(w2, o2)).toBe(p1);
    expect(PAR_OVERHEAD).toBeGreaterThan(1);

    // Human pick stamps par on the order.
    const v = spawnPlayerVehicle(w1, 'par-picker', 'Picker')!;
    v.px = o1.slot.ax + 0.5;
    v.py = o1.slot.ay + 0.5;
    v.tile = { x: o1.slot.ax, y: o1.slot.ay };
    humanInteract(w1, v.id);
    expect(v.cargo).toContain(o1);
    expect(o1.parLoaded).toBe(p1);
  });

  it('rates Speedy ≤ 0.8×par, Slow > 1.3×par or late, else Normal', () => {
    expect(rateFare(8, 10, true)).toBe('speedy');
    expect(rateFare(8.01, 10, true)).toBe('normal');
    expect(rateFare(13, 10, true)).toBe('normal');
    expect(rateFare(13.01, 10, true)).toBe('slow');
    expect(rateFare(1, 10, false)).toBe('slow');
    expect(rateFare(99, null, true)).toBe('normal');
  });

  it('pays value × rating × combo, steps combo 1.0→1.2→1.5→2.0 and emits a fare event per pallet', () => {
    const { w, v } = freshHuman(4101);
    const fares = collect(w, 'fare');
    expect(COMBO_STEPS).toEqual([1.0, 1.2, 1.5, 2.0]);

    load(w, v, { actual: 1, par: 10 });
    deliver(w, v, 'E1');
    expect(v.runPts).toBeCloseTo(20 * 1.5 * 1.0, 4);
    expect(v.combo).toBe(1.2);

    load(w, v, { actual: 10, par: 10 });
    deliver(w, v, 'E1');
    expect(v.runPts).toBeCloseTo(30 + 20 * 1.0 * 1.2, 4);
    expect(v.combo).toBe(1.5);

    load(w, v, { actual: 1, par: 10 });
    deliver(w, v, 'E1');
    expect(v.combo).toBe(2.0);
    load(w, v, { actual: 1, par: 10 });
    deliver(w, v, 'E1');
    expect(v.combo).toBe(2.0); // capped
    expect(v.comboBest).toBe(2.0);

    expect(fares).toHaveLength(4);
    const f = fares[1] as unknown as Record<string, unknown>;
    expect(f).toMatchObject({ vid: v.id, rating: 'normal', actual: 10, par: 10, combo: 1.2, pts: 24 });
    expect(typeof f.orderId).toBe('number');
    expect(v.fareTrips).toBe(4);
    expect(v.speedyTrips).toBe(3);
    expect(v.fareLog).toHaveLength(4);
  });

  it('Slow and late fares pay 0.5× and reset the combo', () => {
    const { w, v } = freshHuman(4102);
    const resets = collect(w, 'combo_reset');
    load(w, v, { actual: 1, par: 10 });
    deliver(w, v, 'E1');
    load(w, v, { actual: 1, par: 10 });
    deliver(w, v, 'E1');
    expect(v.combo).toBe(1.5);
    const before = v.runPts!;
    load(w, v, { actual: 14, par: 10 });
    deliver(w, v, 'E1');
    expect(v.runPts! - before).toBeCloseTo(20 * 0.5 * 1.5, 4);
    expect(v.combo).toBe(1.0);
    expect(resets.at(-1)).toMatchObject({ vid: v.id, reason: 'slow', combo: 1 });

    load(w, v, { actual: 1, par: 10 });
    deliver(w, v, 'E1');
    load(w, v, { actual: 1, par: 10, late: true });
    deliver(w, v, 'E1');
    expect(v.combo).toBe(1.0);
  });

  it('pallet drop, crash and skid reset the combo; Combo King perk floors it at ×1.2', () => {
    const { w, v } = freshHuman(4103);
    const resets = collect(w, 'combo_reset');
    v.comboStep = 3;
    v.combo = 2.0;
    load(w, v, { actual: 1, par: 10 });
    dropPalletOnCollision(w, v, 'a rack');
    expect(v.combo).toBe(1.0);
    expect(resets.at(-1)).toMatchObject({ reason: 'drop' });

    v.comboStep = 2;
    v.combo = 1.5;
    resetCombo(w, v, 'skid');
    expect(v.combo).toBe(1.0);
    expect(resets.at(-1)).toMatchObject({ reason: 'skid' });

    // Crash: boost into another vehicle triggers an incident.
    const v2 = spawnPlayerVehicle(w, 'parked', 'Parked')!;
    v.tile = { x: 10, y: 13 };
    v.px = 10.5;
    v.py = 13.5;
    v.angle = 0;
    v2.tile = { x: 11, y: 13 };
    v2.px = 11.5;
    v2.py = 13.5;
    v.comboStep = 2;
    v.combo = 1.5;
    for (let i = 0; i < 10 && w.t >= v.stunnedUntil; i++) {
      stepHuman(w, v, { up: true, down: false, left: false, right: false, boost: true }, 0.05);
    }
    expect(v.combo).toBe(1.0);
    expect(resets.some((e) => (e as unknown as { reason: string }).reason === 'crash')).toBe(true);

    // Combo King done → perk comboFloor 1 (×1.2).
    const king = SKILLS.find((s) => s.type === 'combo_king')!;
    w.cards['fare-driver']!.cards = [
      {
        id: 'king',
        type: 'combo_king',
        goal: king.goal,
        progress: king.goal,
        status: 'done',
        pts: king.pts,
        title: king.title,
        desc: king.desc,
        perk: { ...king.perk },
      },
    ];
    v.comboStep = 3;
    v.combo = 2.0;
    resetCombo(w, v, 'skid');
    expect(v.combo).toBe(1.2);
  });

  it('battery tip for humans only: +3 Speedy, +1 Normal, +1 batch; none for AI', () => {
    const { w, v } = freshHuman(4104);
    v.battery = 50;
    load(w, v, { actual: 1, par: 10 });
    deliver(w, v, 'E1');
    expect(v.battery).toBe(50 + BATTERY_TIP.speedy);

    v.battery = 50;
    load(w, v, { actual: 1, par: 10 });
    load(w, v, { actual: 10, par: 10 });
    deliver(w, v, 'E1');
    expect(v.battery).toBe(50 + BATTERY_TIP.speedy + BATTERY_TIP.normal + BATTERY_TIP.batch);

    v.battery = 50;
    load(w, v, { actual: 14, par: 10 });
    deliver(w, v, 'E1');
    expect(v.battery).toBe(50);

    const wa = createWorld({ seed: 4105 });
    const ai = wa.vehicles.find((x) => !x.human)!;
    ai.battery = 50;
    load(wa, ai, { actual: 1, par: 10 });
    deliver(wa, ai, 'E1');
    expect(ai.battery).toBe(50);
    expect(ai.speedyTrips).toBe(1);
  });

  it('Trailer Closer: the pallet that fills a regular trailer pays +5 and steps the combo', () => {
    const { w, v } = freshHuman(4106);
    const closers = collect(w, 'trailer_closer');
    const bay = w.bays.find((b) => b.id === 'E1')!;
    bay.load = bay.cap - 1;
    load(w, v, { actual: 10, par: 10 });
    deliver(w, v, 'E1');
    expect(v.runPts).toBeCloseTo(20 + TRAILER_CLOSER_PTS, 4);
    expect(v.combo).toBe(1.5); // fare step + closer step
    expect(closers).toHaveLength(1);
    expect(closers[0]).toMatchObject({ vid: v.id, bay: 'E1', pts: TRAILER_CLOSER_PTS });
    expect(bay.load).toBe(0);
  });

  it('precision stop: hard brake from top speed then a drop emits precision_stop and advances Crazy Stop', () => {
    const { w, v } = freshHuman(4107);
    const stops = collect(w, 'precision_stop');
    const crazy = SKILLS.find((s) => s.type === 'crazy_stop')!;
    expect(crazy.humanOnly).toBe(true);
    w.cards['fare-driver']!.cards = [
      {
        id: 'cs',
        type: 'crazy_stop',
        goal: crazy.goal,
        progress: 0,
        status: 'active',
        pts: crazy.pts,
        title: crazy.title,
        desc: crazy.desc,
        perk: { ...crazy.perk },
      },
    ];
    const bayCfg = w.map.bays.find((b) => b.id === 'E1')!;
    const t0 = bayCfg.tiles[0];
    // Face along open floor so the 4-5 braking steps don't hit a wall.
    const dirs = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    const open = dirs.find((a) =>
      [1, 2].every((k) => !isBlocked(w, t0.x + Math.round(Math.cos(a)) * k, t0.y + Math.round(Math.sin(a)) * k)),
    );
    expect(open).toBeDefined();
    const brakeAtBay = (from: number) => {
      v.px = t0.x + 0.5;
      v.py = t0.y + 0.5;
      v.tile = { ...t0 };
      v.angle = open!;
      v.speedNow = from;
      for (let i = 0; i < 8 && Math.abs(v.speedNow) > 0.05; i++) {
        stepHuman(w, v, { up: false, down: true, left: false, right: false }, 0.1);
      }
      v.speedNow = 0;
      v.px = t0.x + 0.5;
      v.py = t0.y + 0.5;
      v.tile = { ...t0 };
    };

    // Gentle stop from low speed doesn't arm.
    brakeAtBay(2.0);
    expect(v.precisionArmed).toBeNull();
    load(w, v, { actual: 10, par: 10 });
    humanInteract(w, v.id);
    expect(stops).toHaveLength(0);

    // Thresholds scale with the difficulty speed multiplier (like top speed itself).
    brakeAtBay(PRECISION_FROM_SPEED * (diffOf(w).speed ?? 1) + 0.2);
    expect(v.precisionArmed).not.toBeNull();
    load(w, v, { actual: 10, par: 10 });
    humanInteract(w, v.id);
    expect(v.cargo).toHaveLength(0);
    expect(stops).toHaveLength(1);
    expect(v.precisionArmed).toBeNull();
    expect(w.cards['fare-driver']!.cards[0].progress).toBe(1);
  });
});

describe('fare calibration', () => {
  it(`AI fleet with PAR_OVERHEAD=${PAR_OVERHEAD} rates mostly Normal, Speedy rare (beat-the-planner is a human skill)`, () => {
    const w = createWorld({ seed: 424242, siteId: 'den-1', tier: 0 });
    const fares = collect(w, 'fare') as unknown as Array<{ rating: string; par: number | null }>;
    for (let i = 0; i < 3000; i++) {
      tick(w);
      drivePendingDecisions(w);
    }
    expect(fares.length).toBeGreaterThan(50);
    const share = (r: string) => fares.filter((f) => f.rating === r).length / fares.length;
    expect(fares.every((f) => f.par != null && f.par > 0)).toBe(true);
    expect(share('normal')).toBeGreaterThanOrEqual(0.5);
    expect(share('speedy')).toBeLessThanOrEqual(0.15);
    expect(share('slow')).toBeLessThan(share('normal'));
  }, 30000);

  /**
   * Drive a real human forklift with `stepHuman` along the longest open straight
   * stretch of a highway row and rate the leg against `parFor` for the same tiles.
   */
  function straightHighwayLeg(boost: boolean): { actual: number; par: number; rating: string } {
    const { w, v } = freshHuman(2468, boost ? 'boost-driver' : 'cruise-driver');
    // Longest run of open tiles on a highway row, kept clear of highway crossings' ends.
    let best = { y: 0, x0: 0, x1: -1 };
    for (const y of BASE_HWY_Y) {
      if (y >= w.map.h) continue;
      let start = -1;
      for (let x = 0; x <= w.map.w; x++) {
        const open = x < w.map.w && !isBlocked(w, x, y);
        if (open && start < 0) start = x;
        if (!open && start >= 0) {
          if (x - 1 - start > best.x1 - best.x0) best = { y, x0: start, x1: x - 1 };
          start = -1;
        }
      }
    }
    const x0 = best.x0 + 1;
    const x1 = Math.min(best.x1 - 1, x0 + 20);
    expect(x1 - x0).toBeGreaterThanOrEqual(12);
    const par = parFor(w, { x: x0, y: best.y }, { x: x1, y: best.y })!;
    expect(par).not.toBeNull();
    v.px = x0 + 0.5;
    v.py = best.y + 0.5;
    v.tile = { x: x0, y: best.y };
    v.angle = 0;
    v.speedNow = 0;
    v.battery = 100;
    v.cargo = [];
    let steps = 0;
    while (v.tile.x < x1 && steps < 400) {
      stepHuman(w, v, { up: true, down: false, left: false, right: false, boost }, 0.1);
      w.t = Math.round((w.t + 0.1) * 10) / 10;
      steps++;
    }
    expect(v.tile.x).toBe(x1); // reached the drop tile without hitting anything
    const actual = Math.round(steps * 0.1 * 100) / 100;
    return { actual, par, rating: rateFare(actual, par, true) };
  }

  it('a human at full boost on a straight highway leg earns Speedy', () => {
    const r = straightHighwayLeg(true);
    expect(r.rating).toBe('speedy');
    expect(r.actual).toBeLessThanOrEqual(0.8 * r.par);
  });

  it('a human at unboosted top speed on the same leg earns at least Normal', () => {
    const r = straightHighwayLeg(false);
    expect(['speedy', 'normal']).toContain(r.rating);
    expect(r.actual).toBeLessThanOrEqual(1.3 * r.par);
    // Boosting is strictly faster than cruising.
    expect(straightHighwayLeg(true).actual).toBeLessThan(r.actual);
  });
});
