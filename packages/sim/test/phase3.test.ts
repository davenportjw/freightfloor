import { describe, expect, it } from 'vitest';
import {
  assignRival,
  Card,
  chooseOrder,
  createWorld,
  dealCards,
  dealShiftCards,
  deliver,
  FARE_CHOICE_TIMEOUT_MIN,
  FARE_OPTION_COUNT,
  farClassFor,
  fareOptions,
  GHOST_RATIO,
  guide,
  keepCards,
  LONG_PAR_MIN,
  Order,
  postOrder,
  SHORT_PAR_MAX,
  SimEvent,
  SKILLS,
  spawnPlayerVehicle,
  startBlitzClock,
  tick,
  Vehicle,
  World,
} from '../src/index.js';

function collect(w: World, type: string): SimEvent[] {
  const out: SimEvent[] = [];
  w.listeners.push((e) => {
    if (e.type === type) out.push(e);
  });
  return out;
}

function driver(
  seed: number,
  agents = 0,
  id = 'p3-pilot',
  mode: 'blitz' | 'freerange' = 'blitz',
): { w: World; v: Vehicle } {
  const w = createWorld({ seed, agents });
  const v = spawnPlayerVehicle(w, id, 'P3Pilot', mode)!;
  w.cards[id]!.cards = [];
  w.cards[id]!.offer = null;
  w.bays.forEach((b) => (b.load = 0));
  v.battery = 100;
  return { w, v };
}

function postSome(w: World, n: number): Order[] {
  const out: Order[] = [];
  for (let i = 0; i < n; i++) {
    const o = postOrder(w, { force: true });
    if (o) out.push(o);
  }
  return out;
}

function skillCard(type: Card['type'], id = `${type}-1`): Card {
  const s = SKILLS.find((x) => x.type === type)!;
  return {
    id,
    type,
    goal: s.goal,
    progress: 0,
    status: 'active',
    pts: s.pts,
    title: s.title,
    desc: s.desc,
    rarity: s.rarity ?? 'common',
    humanOnly: s.humanOnly,
    perk: { ...s.perk },
    modifiers: { ...s.perk },
  };
}

/** Put a picked pallet in the driver's forks with a known loaded-leg par / trip time. */
function loaded(w: World, v: Vehicle, par: number, actual: number, p0 = false): Order {
  const o = postOrder(w, { bayId: 'E1', force: true })!;
  o.value = 20;
  o.p0 = p0;
  o.state = 'picked';
  o.claimant = v.id;
  o.pickedAt = w.t - actual;
  o.parLoaded = par;
  o.due = w.t + 50;
  v.cargo.push(o);
  v.orders.push(o);
  return o;
}

describe('order choice: fareOptions', () => {
  it('is deterministic for the same seed, Co-Pilot pick first, ≤ FARE_OPTION_COUNT options', () => {
    const run = () => {
      const { w, v } = driver(7101);
      postSome(w, 10);
      return fareOptions(w, v);
    };
    const a = run();
    const b = run();
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    expect(a!.options.length).toBeGreaterThan(0);
    expect(a!.options.length).toBeLessThanOrEqual(FARE_OPTION_COUNT);
    expect(a!.options[0].orderId).toBe(a!.copilotId);
    expect(a!.reason).toMatch(new RegExp(`^Recommended #${a!.copilotId}: `));
    expect(a!.carpool).toBe(false);
    expect(new Set(a!.options.map((o) => o.orderId)).size).toBe(a!.options.length);
  });

  it('classifies by loaded par: P0/long ≥ LONG_PAR_MIN, short ≤ SHORT_PAR_MAX, contracts first', () => {
    expect(farClassFor(true, 5, false)).toBe('long');
    expect(farClassFor(false, LONG_PAR_MIN, false)).toBe('long');
    expect(farClassFor(false, SHORT_PAR_MAX, false)).toBe('short');
    expect(farClassFor(false, (SHORT_PAR_MAX + LONG_PAR_MIN) / 2, false)).toBe('cross');
    expect(farClassFor(false, null, false)).toBe('cross');
    expect(farClassFor(true, 20, true)).toBe('contract');
  });

  it('excludes orders claimed by someone else', () => {
    const { w, v } = driver(7102);
    const orders = postSome(w, 6);
    orders[0].claimant = 'someone-else';
    orders[0].state = 'claimed';
    const f = fareOptions(w, v)!;
    expect(f.options.some((o) => o.orderId === orders[0].id)).toBe(false);
  });

  it('Carpool: while carrying one pallet, only same-bay orders are offered', () => {
    const { w, v } = driver(7103);
    const first = loaded(w, v, 10, 2);
    postSome(w, 12);
    const f = fareOptions(w, v);
    if (f) {
      expect(f.carpool).toBe(true);
      for (const o of f.options) {
        expect(o.bay).toBe(first.bay);
        expect(o.carpool).toBe(true);
      }
    }
    // Full forks → no offer at all.
    loaded(w, v, 10, 2);
    expect(fareOptions(w, v)).toBeNull();
  });
});

describe('order choice: chooseOrder + Co-Pilot timeout', () => {
  it('reserves the chosen option and rejects bad picks with a reason', () => {
    const { w, v } = driver(7201);
    postSome(w, 8);
    expect(chooseOrder(w, v.id, 1)).toBe('No order choice is open.');
    const f = fareOptions(w, v)!;
    v.fareOffer = { ...f, since: w.t };
    expect(chooseOrder(w, v.id, 99999)).toBe('Order #99999 is not one of your options.');
    expect(chooseOrder(w, 'nobody', f.copilotId)).toBe('Unknown vehicle.');
    const evs = collect(w, 'fare_choice');
    const pick = f.options[f.options.length - 1];
    expect(chooseOrder(w, v.id, pick.orderId)).toBeNull();
    const o = w.orders.find((x) => x.id === pick.orderId)!;
    expect(o.state).toBe('claimed');
    expect(o.claimant).toBe(v.id);
    expect(o.chosenAt).toBe(w.t);
    expect(o.farClass).toBe(pick.farClass);
    expect(v.fareOffer).toBeNull();
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ vid: v.id, orderId: pick.orderId, auto: false, reason: null });
    // The guide arrow now follows the chosen order.
    const g = guide(w, v)!;
    expect(g.kind).toBe('pick');
  });

  it('refuses while the Co-Pilot (autopilot) is driving', () => {
    const { w, v } = driver(7202);
    postSome(w, 4);
    const f = fareOptions(w, v)!;
    v.fareOffer = { ...f, since: w.t };
    v.autopilot = true;
    expect(chooseOrder(w, v.id, f.copilotId)).toMatch(/Co-Pilot is driving/);
  });

  it(`auto-reserves the Co-Pilot pick after ${FARE_CHOICE_TIMEOUT_MIN} game-min with its reason`, () => {
    const { w, v } = driver(7203);
    postSome(w, 8);
    w.phase = 'running';
    startBlitzClock(w, v); // the auto-pick never fires before the Blitz clock starts
    const evs = collect(w, 'fare_choice');
    tick(w);
    expect(v.fareOffer).toBeTruthy();
    const since = v.fareOffer!.since;
    for (let i = 0; i < 200 && evs.length === 0; i++) tick(w);
    expect(evs.length).toBeGreaterThanOrEqual(1);
    const e = evs[0] as SimEvent & { auto: boolean; reason: string; orderId: number };
    expect(e.auto).toBe(true);
    expect(e.reason).toMatch(/^Recommended #\d+: /);
    expect(w.t - since).toBeGreaterThanOrEqual(FARE_CHOICE_TIMEOUT_MIN - 1e-6);
    const o = w.orders.find((x) => x.id === e.orderId);
    if (o) expect([v.id]).toContain(o.claimant);
  });
});

describe('rival assignment', () => {
  it('picks the AI with the closest shift score; ties go to the lower id', () => {
    const { w, v } = driver(7301, 3);
    const ai = w.vehicles.filter((x) => !x.human);
    expect(ai.length).toBeGreaterThanOrEqual(2);
    v.sPts = 100;
    ai.forEach((x) => (x.sPts = 0));
    ai[ai.length - 1].sPts = 90;
    expect(assignRival(w, v)).toBe(ai[ai.length - 1].id);
    ai.forEach((x) => (x.sPts = 50));
    const lowest = [...ai].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    expect(assignRival(w, v)).toBe(lowest.id);
    expect(v.rivalId).toBe(lowest.id);
  });

  it('is null with no AI on the floor', () => {
    const { w, v } = driver(7302, 0);
    expect(assignRival(w, v)).toBeNull();
  });
});

describe('Phase-3 cards', () => {
  it('Long Haul counts long-haul / P0 deliveries only', () => {
    const { w, v } = driver(7401);
    const c = skillCard('long_haul');
    w.cards['p3-pilot']!.cards = [c];
    loaded(w, v, SHORT_PAR_MAX - 1, 5);
    deliver(w, v, 'E1');
    expect(c.progress).toBe(0);
    loaded(w, v, LONG_PAR_MIN + 1, 12);
    deliver(w, v, 'E1');
    loaded(w, v, 5, 3, true);
    deliver(w, v, 'E1');
    expect(c.status).toBe('done');
  });

  it('Local Hero needs consecutive short hops; anything else resets it', () => {
    const { w, v } = driver(7402);
    const c = skillCard('local_hero');
    w.cards['p3-pilot']!.cards = [c];
    loaded(w, v, SHORT_PAR_MAX - 1, 5);
    deliver(w, v, 'E1');
    loaded(w, v, SHORT_PAR_MAX - 1, 5);
    deliver(w, v, 'E1');
    expect(c.progress).toBe(2);
    loaded(w, v, LONG_PAR_MIN + 2, 12);
    deliver(w, v, 'E1');
    expect(c.progress).toBe(0);
    for (let i = 0; i < c.goal; i++) {
      loaded(w, v, SHORT_PAR_MAX - 1, 5);
      deliver(w, v, 'E1');
    }
    expect(c.status).toBe('done');
  });

  it('Ghost Hunter counts deliveries at ≤ GHOST_RATIO × par', () => {
    const { w, v } = driver(7403);
    const c = skillCard('ghost_hunter');
    w.cards['p3-pilot']!.cards = [c];
    loaded(w, v, 10, 10 * GHOST_RATIO + 0.5);
    deliver(w, v, 'E1');
    expect(c.progress).toBe(0);
    loaded(w, v, 10, 10 * GHOST_RATIO - 0.5);
    deliver(w, v, 'E1');
    expect(c.status).toBe('done');
  });

  it('Poacher progresses when the driver reserves a P0 order via chooseOrder', () => {
    const { w, v } = driver(7404);
    const c = skillCard('poacher');
    c.goal = 1;
    w.cards['p3-pilot']!.cards = [c];
    postSome(w, 6);
    const p0 = postOrder(w, { force: true, p0: true })!;
    expect(p0.p0).toBe(true);
    const f = fareOptions(w, v)!;
    const opt = f.options.find((o) => o.orderId === p0.id) ?? {
      orderId: p0.id,
      farClass: 'long' as const,
      carpool: false,
      p0: true,
      bay: p0.bay,
      value: p0.value,
      tiles: 0,
      parEmpty: null,
      parLoaded: null,
    };
    v.fareOffer = { ...f, options: [opt, ...f.options.filter((o) => o.orderId !== p0.id)], since: w.t };
    expect(chooseOrder(w, v.id, p0.id)).toBeNull();
    expect(c.status).toBe('done');
  });

  it('Rival Grudge: win by out-delivering the rival; lose with a rival_taunt', () => {
    const { w, v } = driver(7405, 2);
    const h = w.cards['p3-pilot']!;
    const c = skillCard('rival_grudge', 'rg-win');
    h.offer = [c];
    expect(keepCards(w, 'p3-pilot', ['rg-win'])).toBeNull();
    expect(c.rivalBase?.rivalId).toBeTruthy();
    expect(c.until).toBeGreaterThan(w.t);
    v.deliveries += 2;
    w.t = c.until!;
    w.phase = 'running';
    // cardsTick runs once per game-minute.
    for (let i = 0; i < 12 && c.status === 'active'; i++) tick(w);
    expect(c.status).toBe('done');

    const c2 = skillCard('rival_grudge', 'rg-lose');
    h.cards = [];
    h.offer = [c2];
    expect(keepCards(w, 'p3-pilot', ['rg-lose'])).toBeNull();
    const rival = w.vehicles.find((x) => x.id === c2.rivalBase!.rivalId)!;
    const taunts = collect(w, 'rival_taunt');
    rival.deliveries += 1;
    w.t = c2.until!;
    for (let i = 0; i < 12 && c2.status === 'active'; i++) tick(w);
    expect(c2.status).toBe('lost');
    expect(taunts).toHaveLength(1);
    expect(taunts[0]).toMatchObject({ vid: v.id, rival: rival.id, cardId: 'rg-lose' });
  });

  it('Rival Grudge is voided when no AI rival is on the floor', () => {
    const { w } = driver(7406, 0);
    const h = w.cards['p3-pilot']!;
    const c = skillCard('rival_grudge', 'rg-void');
    h.offer = [c];
    expect(keepCards(w, 'p3-pilot', ['rg-void'])).toBeNull();
    expect(h.cards.some((x) => x.id === 'rg-void')).toBe(false);
  });

  it('humanOnly cards are never dealt to AI', () => {
    const humanOnly = new Set(SKILLS.filter((s) => s.humanOnly).map((s) => s.type));
    expect(humanOnly.has('poacher')).toBe(true);
    for (let seed = 7500; seed < 7530; seed++) {
      const w = createWorld({ seed, agents: 4 });
      dealShiftCards(w);
      for (const v of w.vehicles.filter((x) => !x.human)) {
        for (const c of w.cards[v.id]?.offer ?? []) expect(humanOnly.has(c.type)).toBe(false);
      }
    }
  });

  it('humans can be dealt the new cards', () => {
    const seen = new Set<string>();
    for (let seed = 7600; seed < 7700; seed++) {
      const { w } = driver(seed, 0, 'p3-pilot', 'freerange');
      w.totals.cardDeals = 1;
      const h = dealCards(w, 'p3-pilot');
      (h.offer ?? []).forEach((c) => seen.add(c.type));
    }
    for (const t of ['long_haul', 'local_hero', 'poacher']) expect(seen.has(t)).toBe(true);
  });
});
