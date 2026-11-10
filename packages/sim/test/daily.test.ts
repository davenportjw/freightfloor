import { describe, expect, it } from 'vitest';
import {
  addDays,
  DAILY_DEAL_SIZE,
  DAILY_DECK,
  DAILY_EPOCH_DAY,
  dailyModifierFor,
  dayKeyToMs,
  type DailyModifierId,
} from '@warehouse/protocol';
import {
  BLITZ_DEAL_SIZE,
  BLITZ_DECK,
  BLITZ_DURATION_MIN,
  COMBO_STEPS,
  createWorld,
  DAILY_EFFECTS,
  dailyFor,
  dailyInfo,
  deliver,
  dropPalletOnCollision,
  INCIDENT_PENALTY,
  Order,
  postOrder,
  RUN_TAPE_MAX,
  recordCompletedRun,
  SimEvent,
  spawnPlayerVehicle,
  startBlitzClock,
  startDriverRun,
  stepHuman,
  tick,
  Vehicle,
  World,
} from '../src/index.js';

const HOUR_MS = 3600e3;

/** First day key (from the epoch) whose rotation lands on `mod`. */
function keyWith(mod: DailyModifierId): string {
  for (let i = 0; i < 60; i++) {
    const k = addDays(DAILY_EPOCH_DAY, i);
    if (dailyModifierFor(k).id === mod) return k;
  }
  throw new Error(`no day with ${mod} in 60 days`);
}

function collect(w: World, type: string): SimEvent[] {
  const out: SimEvent[] = [];
  w.listeners.push((e) => {
    if (e.type === type) out.push(e);
  });
  return out;
}

/**
 * One world with a daily driver (on a day with `mod`) and a Blitz control driver, both
 * with empty hands so card perks don't confound the maths.
 */
function dailyWorld(
  mod: DailyModifierId,
  opts: { keepHands?: boolean; seed?: number } = {},
): { w: World; v: Vehicle; c: Vehicle; key: string } {
  const w = createWorld({ seed: opts.seed ?? 5151, agents: 0 });
  const key = keyWith(mod);
  w.wallMs = dayKeyToMs(key) + HOUR_MS;
  const v = spawnPlayerVehicle(w, 'daily-driver', 'DailyPilot', 'daily')!;
  const c = spawnPlayerVehicle(w, 'blitz-driver', 'BlitzPilot', 'blitz')!;
  if (!opts.keepHands) {
    for (const id of ['daily-driver', 'blitz-driver']) {
      w.cards[id]!.cards = [];
      w.cards[id]!.offer = null;
    }
  }
  w.bays.forEach((b) => (b.load = 0));
  return { w, v, c, key };
}

/** Put an order on the forks with a given loaded-leg time vs. par. */
function load(
  w: World,
  v: Vehicle,
  opts: {
    actual: number;
    par: number | null;
    zone?: string;
    farClass?: Order['farClass'];
    created?: number;
    due?: number;
  },
): Order {
  const o = postOrder(w, { bayId: 'E1', force: true, ...(opts.zone ? { zone: opts.zone } : {}) })!;
  o.value = 20;
  o.state = 'picked';
  o.claimant = v.id;
  o.pickedAt = w.t - opts.actual;
  o.parLoaded = opts.par ?? undefined;
  o.farClass = opts.farClass ?? 'short';
  o.created = opts.created ?? w.t - 5;
  o.due = opts.due ?? w.t + 50;
  v.cargo.push(o);
  if (!v.orders.includes(o)) v.orders.push(o);
  return o;
}

/** Points paid for the last delivery (fare log keeps 0.1 precision). */
const lastPts = (v: Vehicle): number => v.fareLog!.at(-1)!.pts;

/** End a started run on the next tick. */
function finishRun(w: World, v: Vehicle): void {
  v.runStartedAt = w.t;
  v.runEndsAt = w.t;
  tick(w, 0.1);
}

describe('Daily Shift: seeded hand and day attribution', () => {
  it('dailyFor is pure, deterministic, deals 3 distinct Blitz-deck titles, and varies by day', () => {
    const w = createWorld({ seed: 99, agents: 0 });
    const rng = w.rngState;
    const a = dailyFor('2026-11-12');
    expect(dailyFor('2026-11-12')).toEqual(a);
    expect(a.cards).toHaveLength(3);
    expect(new Set(a.cards).size).toBe(3);
    for (const t of a.cards) expect(BLITZ_DECK as readonly string[]).toContain(t);
    expect(a.modifier).toBe(dailyModifierFor('2026-11-12').id);

    const hands = new Set<string>();
    for (let i = 0; i < 30; i++) hands.add(dailyFor(addDays(DAILY_EPOCH_DAY, i)).cards.join('|'));
    expect(hands.size).toBeGreaterThan(3);

    const info = dailyInfo('2026-11-12');
    expect(info.number).toBe(3);
    expect(info.cards).toEqual(a.cards);
    expect(info.resetsAt).toBe(dayKeyToMs('2026-11-13'));
    expect(w.rngState).toBe(rng);
  });

  it('deals the day\u2019s titles and stamps dailyKey / dailyMod; Blitz drivers are untouched', () => {
    const { w, v, c, key } = dailyWorld('cold_chain', { keepHands: true });
    expect(v.runMode).toBe('daily');
    expect(v.dailyKey).toBe(key);
    expect(v.dailyMod).toBe('cold_chain');
    expect(w.cards['daily-driver']!.offer!.map((x) => x.title)).toEqual(dailyFor(key).cards);
    expect(c.dailyKey ?? null).toBeNull();
    expect(c.dailyMod ?? null).toBeNull();
    // Same day, different world seed: identical hand.
    const other = dailyWorld('cold_chain', { keepHands: true, seed: 8 });
    expect(other.w.cards['daily-driver']!.offer!.map((x) => x.title)).toEqual(dailyFor(key).cards);
  });

  it('runs on the timed clock: drive-first start, ends at runEndsAt, no redraws', () => {
    const { w, v } = dailyWorld('express', { keepHands: true });
    const shift = collect(w, 'shift');
    expect(v.runStartedAt).toBeNull();
    startBlitzClock(w, v);
    expect(v.runStartedAt).toBe(w.t);
    expect(v.runEndsAt).toBeCloseTo(w.t + BLITZ_DURATION_MIN, 4);
    const dealt = w.totals.cardDeals;
    w.t = v.runEndsAt!;
    tick(w, 0.1);
    expect(v.runFinished).toBe(true);
    expect(w.totals.cardDeals).toBe(dealt);
    expect(shift.some((e) => /the Daily Shift/.test(e.text))).toBe(true);
  });

  it('re-deals the new day\u2019s hand if UTC midnight passes before the clock starts', () => {
    const { w, v, key } = dailyWorld('long_haul', { keepHands: true });
    const next = addDays(key, 1);
    w.wallMs = dayKeyToMs(next) + 60e3;
    startBlitzClock(w, v);
    expect(v.dailyKey).toBe(next);
    expect(v.dailyMod).toBe(dailyModifierFor(next).id);
    expect(w.cards['daily-driver']!.offer!.map((x) => x.title)).toEqual(dailyFor(next).cards);
    // After the clock starts the run stays on its start day.
    w.wallMs = dayKeyToMs(addDays(next, 1)) + 60e3;
    startBlitzClock(w, v);
    expect(v.dailyKey).toBe(next);
  });

  it('records dailyKey and the run tape on the completed run', () => {
    const { w, v, c, key } = dailyWorld('heavy_load');
    load(w, v, { actual: 10, par: 10 });
    deliver(w, v, 'E1');
    const rec = recordCompletedRun(w, v)!;
    expect(rec.runMode).toBe('daily');
    expect(rec.dailyKey).toBe(key);
    expect(rec.tape).toBe('O');
    const crec = recordCompletedRun(w, c)!;
    expect(crec.runMode).toBe('blitz');
    expect('dailyKey' in crec).toBe(false);
  });
});

describe('Daily Shift: run tape', () => {
  it('records O / L / X in order, caps at RUN_TAPE_MAX, and resets on a new run', () => {
    const { w, v, c } = dailyWorld('heavy_load');
    load(w, v, { actual: 10, par: 10 });
    deliver(w, v, 'E1');
    load(w, v, { actual: 10, par: 10, created: w.t - 20, due: w.t - 1 });
    deliver(w, v, 'E1');
    load(w, v, { actual: 1, par: 10 });
    dropPalletOnCollision(w, v, 'a rack');
    expect(v.runTape).toBe('OLX');
    // Blitz runs keep a tape too (it feeds the share card).
    load(w, c, { actual: 10, par: 10 });
    deliver(w, c, 'E1');
    expect(c.runTape).toBe('O');

    for (let i = 0; i < RUN_TAPE_MAX + 5; i++) {
      load(w, v, { actual: 10, par: 10 });
      deliver(w, v, 'E1');
    }
    expect(v.runTape!.length).toBe(RUN_TAPE_MAX);
    expect(v.runTape!.startsWith('OLX')).toBe(true);

    startDriverRun(w, v, 'daily');
    expect(v.runTape).toBe('');
    expect(v.runCharged).toBe(false);
  });
});

describe('Daily Shift: personal modifiers (daily driver only)', () => {
  it('Cold Chain: Cold Storage (W) pallets pay double', () => {
    const { w, v, c } = dailyWorld('cold_chain');
    load(w, v, { actual: 10, par: 10, zone: 'W' });
    deliver(w, v, 'E1');
    load(w, c, { actual: 10, par: 10, zone: 'W' });
    deliver(w, c, 'E1');
    expect(lastPts(v)).toBeCloseTo(20 * DAILY_EFFECTS.cold_chain.coldMul, 1);
    expect(lastPts(c)).toBeCloseTo(20, 1);
    // Other zones pay normally (combo now ×1.2 for both).
    load(w, v, { actual: 10, par: 10, zone: 'A' });
    deliver(w, v, 'E1');
    load(w, c, { actual: 10, par: 10, zone: 'A' });
    deliver(w, c, 'E1');
    expect(lastPts(v)).toBeCloseTo(24, 1);
    expect(lastPts(c)).toBeCloseTo(24, 1);
  });

  it('Long Haul: long-haul (or par ≥ LONG_PAR_MIN) pays 1.5×', () => {
    const { w, v, c } = dailyWorld('long_haul');
    load(w, v, { actual: 16, par: 16 });
    deliver(w, v, 'E1');
    load(w, c, { actual: 16, par: 16 });
    deliver(w, c, 'E1');
    expect(lastPts(v)).toBeCloseTo(30, 1);
    expect(lastPts(c)).toBeCloseTo(20, 1);
    load(w, v, { actual: 5, par: 5, farClass: 'long' });
    deliver(w, v, 'E1');
    expect(lastPts(v)).toBeCloseTo(20 * 1.2 * 1.5, 1);
    load(w, v, { actual: 5, par: 5 });
    deliver(w, v, 'E1');
    expect(lastPts(v)).toBeCloseTo(20 * 1.5, 1);
  });

  it('Express: the deadline window is 25% shorter and Speedy pays 2×', () => {
    const { w, v, c } = dailyWorld('express');
    // Window 11 min, 2 left: on time normally; at 0.75× the deadline passed 0.75 min ago.
    load(w, v, { actual: 10, par: 10, created: w.t - 9, due: w.t + 2 });
    deliver(w, v, 'E1');
    load(w, c, { actual: 10, par: 10, created: w.t - 9, due: w.t + 2 });
    deliver(w, c, 'E1');
    expect(v.runOnTime).toBe(0);
    expect(v.runTape).toBe('L');
    expect(c.runOnTime).toBe(1);

    const fresh = dailyWorld('express');
    load(fresh.w, fresh.v, { actual: 1, par: 10, created: fresh.w.t - 1 });
    deliver(fresh.w, fresh.v, 'E1');
    load(fresh.w, fresh.c, { actual: 1, par: 10, created: fresh.w.t - 1 });
    deliver(fresh.w, fresh.c, 'E1');
    expect(lastPts(fresh.v)).toBeCloseTo(20 * DAILY_EFFECTS.express.speedyMul, 1);
    expect(lastPts(fresh.c)).toBeCloseTo(30, 1);
  });

  it('Clean Shift: +150 for a zero-incident run, −50 per incident', () => {
    const { w, v, c } = dailyWorld('clean_shift');
    load(w, v, { actual: 10, par: 10 });
    deliver(w, v, 'E1');
    load(w, c, { actual: 10, par: 10 });
    deliver(w, c, 'E1');
    const vb = v.runPts!;
    const cb = c.runPts!;
    finishRun(w, v);
    finishRun(w, c);
    expect(v.runPts! - vb).toBeCloseTo(DAILY_EFFECTS.clean_shift.cleanBonus, 4);
    expect(c.runPts! - cb).toBeCloseTo(0, 4);

    const s = dailyWorld('clean_shift');
    for (let i = 0; i < 4; i++) {
      load(s.w, s.v, { actual: 10, par: 10 });
      deliver(s.w, s.v, 'E1');
    }
    const before = s.v.runPts!;
    expect(before).toBeGreaterThan(INCIDENT_PENALTY + 50);
    load(s.w, s.v, { actual: 1, par: 10 });
    dropPalletOnCollision(s.w, s.v, 'a rack');
    expect(s.v.runPts!).toBeCloseTo(before - INCIDENT_PENALTY - DAILY_EFFECTS.clean_shift.incidentPenalty, 4);
    const afterIncident = s.v.runPts!;
    finishRun(s.w, s.v);
    expect(s.v.runPts!).toBeCloseTo(afterIncident, 4); // no clean bonus
  });

  it('Clean Shift / Eco Run bonuses need at least one delivery', () => {
    for (const mod of ['clean_shift', 'eco_run'] as const) {
      const { w, v } = dailyWorld(mod);
      finishRun(w, v);
      expect(v.runPts ?? 0).toBe(0);
    }
  });

  it('Heavy Load: top speed −15%, deliveries pay +25%', () => {
    const { w, v, c } = dailyWorld('heavy_load');
    load(w, v, { actual: 10, par: 10 });
    deliver(w, v, 'E1');
    load(w, c, { actual: 10, par: 10 });
    deliver(w, c, 'E1');
    expect(lastPts(v)).toBeCloseTo(20 * DAILY_EFFECTS.heavy_load.deliveryMul, 1);
    expect(lastPts(c)).toBeCloseTo(20, 1);

    // Same vehicle and tile, with and without the modifier: the top-speed clamp scales.
    const top = (mod: DailyModifierId | null): number => {
      const { w: w2, v: v2 } = dailyWorld('heavy_load');
      v2.dailyMod = mod;
      v2.speedNow = 10; // above any cap → clamped to maxF
      stepHuman(w2, v2, { up: true, down: false, left: false, right: false }, 0.001);
      return v2.speedNow;
    };
    expect(top('heavy_load') / top(null)).toBeCloseTo(DAILY_EFFECTS.heavy_load.speedMul, 2);
  });

  it('Combo Day: combo climbs one step past ×2 to ×2.5 (Blitz stays capped at ×2)', () => {
    const { w, v, c } = dailyWorld('combo_day');
    for (let i = 0; i < 6; i++) {
      load(w, v, { actual: 10, par: 10 });
      deliver(w, v, 'E1');
      load(w, c, { actual: 10, par: 10 });
      deliver(w, c, 'E1');
    }
    expect(v.combo).toBe(DAILY_EFFECTS.combo_day.extraStep);
    expect(v.comboBest).toBe(2.5);
    expect(c.combo).toBe(COMBO_STEPS[COMBO_STEPS.length - 1]);
    expect(v.fareLog!.map((f) => f.combo).slice(-6)).toEqual([1.0, 1.2, 1.5, 2.0, 2.5, 2.5]);
  });

  it('Eco Run: battery drains 1.5× faster; +100 at the end only without charging', () => {
    const used = (mod: DailyModifierId | null): number => {
      const { w: w2, v: v2 } = dailyWorld('eco_run');
      v2.dailyMod = mod;
      v2.battery = 100;
      v2.speedNow = 0;
      stepHuman(w2, v2, { up: true, down: false, left: false, right: false, boost: true }, 0.1);
      return 100 - v2.battery;
    };
    const base = used(null);
    expect(base).toBeGreaterThan(0);
    expect(used('eco_run') / base).toBeCloseTo(DAILY_EFFECTS.eco_run.drainMul, 2);

    const { w, v, c } = dailyWorld('eco_run');
    load(w, v, { actual: 10, par: 10 });
    deliver(w, v, 'E1');
    load(w, c, { actual: 10, par: 10 });
    deliver(w, c, 'E1');
    const vb = v.runPts!;
    const cb = c.runPts!;
    finishRun(w, v);
    finishRun(w, c);
    expect(v.runPts! - vb).toBeCloseTo(DAILY_EFFECTS.eco_run.noChargeBonus, 4);
    expect(c.runPts! - cb).toBeCloseTo(0, 4);

    // Charging on a pad sets runCharged and forfeits the bonus.
    const s = dailyWorld('eco_run');
    load(s.w, s.v, { actual: 10, par: 10 });
    deliver(s.w, s.v, 'E1');
    startBlitzClock(s.w, s.v);
    const pad = s.w.map.chargers[0]!;
    s.v.tile = { x: pad.x, y: pad.y };
    s.v.px = pad.x + 0.5;
    s.v.py = pad.y + 0.5;
    s.v.speedNow = 0;
    s.v.battery = 50;
    stepHuman(s.w, s.v, { up: false, down: false, left: false, right: false }, 1.0);
    expect(s.v.runCharged).toBe(true);
    const sb = s.v.runPts!;
    finishRun(s.w, s.v);
    expect(s.v.runPts!).toBeCloseTo(sb, 4);
  });

  it('protocol DAILY_DECK mirrors BLITZ_DECK so the lobby deals the same hand', () => {
    expect([...DAILY_DECK]).toEqual([...BLITZ_DECK]);
    expect(DAILY_DEAL_SIZE).toBe(BLITZ_DEAL_SIZE);
  });
});
