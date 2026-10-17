import { describe, expect, it } from 'vitest';
import {
  applyDecision,
  Card,
  CARD_TYPE_IDS,
  ContractOption,
  createWorld,
  dealCards,
  dealShiftCards,
  deliver,
  emitContractRequestIfNeeded,
  getCardModifiers,
  HAND_LIMIT,
  HIGH_ROLLER_BONUS,
  INCIDENT_PENALTY,
  interactAt,
  keepCards,
  LAST_CALL_PTS,
  LAST_CALL_MIN,
  CONTRACT_RESERVE_MIN,
  Order,
  PERK_CAPS,
  postOrder,
  SimEvent,
  SKILLS,
  spawnPlayerVehicle,
  stepHuman,
  Vehicle,
  WILD_CHANCE,
  World,
} from '../src/index.js';

const META = { model: 'gemini-3.8-flash', latencyMs: 1, inputTokens: 1, outputTokens: 1 };
/** User-added cards kept on the legacy active-modifier path (no perk). */
const LEGACY_TITLES = ['Turbo Courier', 'Tele-Fork Extension', 'Regen Capacitor', 'Priority Broker'];

function collect(w: World, type: string): SimEvent[] {
  const out: SimEvent[] = [];
  w.listeners.push((e) => {
    if (e.type === type) out.push(e);
  });
  return out;
}

function skillCard(type: Card['type'], status: Card['status'], id = `${type}-${status}`): Card {
  const s = SKILLS.find((x) => x.type === type)!;
  return {
    id,
    type,
    goal: s.goal,
    progress: status === 'done' ? s.goal : 0,
    status,
    pts: s.pts,
    title: s.title,
    desc: s.desc,
    rarity: s.rarity ?? 'common',
    perk: { ...s.perk },
    modifiers: { ...s.perk },
  };
}

function human(seed: number, id = 'card-pilot'): { w: World; v: Vehicle } {
  const w = createWorld({ seed, agents: 0 });
  const v = spawnPlayerVehicle(w, id, 'CardPilot', 'blitz')!;
  w.cards[id]!.cards = [];
  w.cards[id]!.offer = null;
  w.bays.forEach((b) => (b.load = 0));
  return { w, v };
}

function load(w: World, v: Vehicle, actual: number, par = 10): Order {
  const o = postOrder(w, { bayId: 'E1', force: true })!;
  o.value = 20;
  o.state = 'picked';
  o.claimant = v.id;
  o.pickedAt = w.t - actual;
  o.parLoaded = par;
  o.due = w.t + 50;
  v.cargo.push(o);
  v.orders.push(o);
  return o;
}

describe('cards: perks are rewards', () => {
  it('perk cards apply only once done; legacy modifier cards (no perk) keep the active path', () => {
    const { w, v } = human(5001);
    const h = w.cards['card-pilot']!;
    h.cards = [skillCard('overdrive', 'active')];
    expect(getCardModifiers(w, v).speedMul).toBe(1);
    h.cards[0].status = 'done';
    expect(getCardModifiers(w, v).speedMul).toBeCloseTo(1.15, 6);

    // Legacy (restored snapshot) card: modifiers but no perk → applies while active.
    h.cards = [
      {
        id: 'legacy',
        type: 'count' as Card['type'],
        goal: 1,
        progress: 0,
        status: 'active',
        pts: 10,
        title: 'Old Card',
        desc: '',
        modifiers: { speedMul: 1.1, ptsBonus: 4, reachBonus: 0.9 },
      },
    ];
    const m = getCardModifiers(w, v);
    expect(m.speedMul).toBeCloseTo(1.1, 6);
    expect(m.ptsBonus).toBe(4);
    expect(m.reachBonus).toBeCloseTo(0.55, 6); // legacy reach cap
  });

  it('combined perks are capped (speed 1.25×, reach +0.5, drain 0.7×, forks 1.5×)', () => {
    const { w, v } = human(5002);
    w.cards['card-pilot']!.cards = [
      skillCard('overdrive', 'done', 'a'),
      skillCard('quick', 'done', 'b'),
      skillCard('ontime', 'done', 'c'),
      skillCard('long_reach', 'done', 'd'),
      skillCard('batch', 'done', 'e'),
      skillCard('eco_cell', 'done', 'f'),
      skillCard('clean', 'done', 'g'),
      skillCard('crazy_stop', 'done', 'h'),
    ];
    const m = getCardModifiers(w, v);
    expect(m.speedMul).toBe(PERK_CAPS.speedMul);
    expect(m.reachBonus).toBe(PERK_CAPS.reachBonus);
    expect(m.batteryDrainMul).toBe(PERK_CAPS.batteryDrainMul);
    expect(m.forkLiftMul).toBe(PERK_CAPS.forkLiftMul);
  });

  it('High Roller is the only payout multiplier, and only while active', () => {
    const { w, v } = human(5003);
    const h = w.cards['card-pilot']!;
    h.cards = [skillCard('high_roller', 'active')];
    expect(getCardModifiers(w, v).payoutBonus).toBe(HIGH_ROLLER_BONUS);
    h.cards[0].status = 'done';
    expect(getCardModifiers(w, v).payoutBonus).toBe(0);
  });
});

describe('cards: catalogue and dealing', () => {
  it('SKILLS covers the dealable types; Phase-3 types are typed but dormant', () => {
    const types = new Set(SKILLS.map((s) => s.type));
    for (const t of types) expect(CARD_TYPE_IDS).toContain(t);
    for (const t of ['long_haul', 'local_hero', 'poacher', 'rival_grudge', 'ghost_hunter']) {
      expect(CARD_TYPE_IDS).toContain(t);
      expect(types.has(t as Card['type'])).toBe(false);
    }
    expect(SKILLS.filter((s) => s.rarity === 'wild').map((s) => s.type).sort()).toEqual([
      'double_nothing',
      'high_roller',
      'last_call',
    ]);
    expect(SKILLS.filter((s) => s.humanOnly).map((s) => s.type).sort()).toEqual([
      'beat_planner',
      'combo_king',
      'crazy_stop',
    ]);
    expect(WILD_CHANCE).toBe(0.2);
  });

  it('user-added cards are kept as legacy modifier cards (active path, no perk)', () => {
    const expected: Record<string, object> = {
      'Turbo Courier': { speedMul: 1.18, ptsBonus: 4 },
      'Tele-Fork Extension': { reachBonus: 0.55, chargeBonus: 2 },
      'Regen Capacitor': { drainMul: 0.65, chargeBonus: 4 },
      'Priority Broker': { p0Bonus: 12, ptsBonus: 3 },
    };
    for (const title of LEGACY_TITLES) {
      const s = SKILLS.find((x) => x.title === title)!;
      expect(s).toBeDefined();
      expect(s.perk).toBeUndefined();
      expect(s.modifiers).toEqual(expected[title]);
    }
  });

  it('AI shift deals never include humanOnly cards and hold at most one wild', () => {
    let wildDeals = 0;
    let deals = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const w = createWorld({ seed: 7000 + seed, agents: 4 });
      const reqs = dealShiftCards(w);
      for (const r of reqs) {
        deals++;
        const opts = r.options as Array<{ cardType: string; title?: string; rarity?: string; perk?: object }>;
        const humanOnly = new Set(SKILLS.filter((s) => s.humanOnly).map((s) => s.type as string));
        expect(opts.some((o) => humanOnly.has(o.cardType))).toBe(false);
        const wilds = opts.filter((o) => o.rarity === 'wild').length;
        expect(wilds).toBeLessThanOrEqual(1);
        if (wilds) wildDeals++;
        expect(opts.every((o) => o.perk !== undefined || LEGACY_TITLES.includes(o.title ?? ''))).toBe(true);
      }
    }
    expect(deals).toBeGreaterThan(50);
    expect(wildDeals).toBeGreaterThan(0);
    expect(wildDeals / deals).toBeLessThan(0.45);
  });

  it(`keepCards enforces the ${HAND_LIMIT}-card hand limit and one wild max`, () => {
    const { w } = human(5004);
    const h = w.cards['card-pilot']!;
    h.cards = [skillCard('overdrive', 'active', 'x1'), skillCard('eco_cell', 'active', 'x2')];
    h.offer = [skillCard('quick', 'offer', 'o1'), skillCard('long_reach', 'offer', 'o2')];
    expect(keepCards(w, 'card-pilot', ['o1', 'o2'])).toMatch(/Hand limit/);

    h.cards = [skillCard('high_roller', 'active', 'w1')];
    h.offer = [skillCard('double_nothing', 'offer', 'w2'), skillCard('quick', 'offer', 'o3')];
    expect(keepCards(w, 'card-pilot', ['w2'])).toMatch(/one wild/);
    expect(keepCards(w, 'card-pilot', ['o3'])).toBeNull();
    expect(h.cards.filter((c) => c.status === 'active')).toHaveLength(2);
  });

  it('completing a card triggers a 1-of-2 replacement offer', () => {
    const { w, v } = human(5005);
    const h = w.cards['card-pilot']!;
    h.cards = [
      { ...skillCard('overdrive', 'active', 'od'), goal: 1 },
      skillCard('eco_cell', 'active', 'ec'),
      skillCard('clean', 'active', 'cl'),
    ];
    load(w, v, 10);
    deliver(w, v, 'E1');
    expect(h.cards.find((c) => c.id === 'od')!.status).toBe('done');
    expect(h.offer).toHaveLength(2);
    expect(h.pick).toBe(1);
    expect(keepCards(w, 'card-pilot', h.offer!.map((c) => c.id))).toMatch(/Pick at most 1/);
    expect(keepCards(w, 'card-pilot', [h.offer![0].id])).toBeNull();
    expect(h.pick).toBeUndefined();

    // Manual redraw path, too.
    h.offer = null;
    dealCards(w, 'card-pilot', true);
    expect(h.offer).toHaveLength(2);
  });
});

describe('cards: narrowed progress rules', () => {
  it('Speed Demon counts only Speedy fares; Overdrive counts any delivery; No Slowpokes resets on Slow', () => {
    const { w, v } = human(5006);
    const h = w.cards['card-pilot']!;
    h.cards = [
      skillCard('quick', 'active', 'q'),
      { ...skillCard('overdrive', 'active', 'o'), goal: 10 },
      skillCard('ontime', 'active', 't'),
    ];
    load(w, v, 10); // Normal
    deliver(w, v, 'E1');
    const q = h.cards.find((c) => c.id === 'q')!;
    const o = h.cards.find((c) => c.id === 'o')!;
    const t = h.cards.find((c) => c.id === 't')!;
    expect(q.progress).toBe(0);
    expect(o.progress).toBe(1);
    expect(t.progress).toBe(1);

    load(w, v, 1); // Speedy
    deliver(w, v, 'E1');
    expect(q.progress).toBe(1);
    expect(t.progress).toBe(2);

    load(w, v, 14); // Slow
    deliver(w, v, 'E1');
    expect(t.progress).toBe(0);
    expect(o.progress).toBe(3);
  });

  it('Double or Nothing burns on a non-Speedy fare and pays on 3 Speedy in a row', () => {
    const { w, v } = human(5007);
    const h = w.cards['card-pilot']!;
    h.cards = [skillCard('double_nothing', 'active', 'dn')];
    load(w, v, 1);
    deliver(w, v, 'E1');
    load(w, v, 10);
    deliver(w, v, 'E1');
    expect(h.cards[0].status).toBe('lost');

    h.offer = null;
    h.cards = [skillCard('double_nothing', 'active', 'dn2')];
    const before = v.runPts ?? 0;
    for (let i = 0; i < 3; i++) {
      load(w, v, 1);
      deliver(w, v, 'E1');
    }
    expect(h.cards[0].status).toBe('done');
    expect((v.runPts ?? 0) - before).toBeGreaterThanOrEqual(40);
  });

  it('Last Call pays +10 per Speedy fare inside the final window only', () => {
    const { w, v } = human(5008);
    const h = w.cards['card-pilot']!;
    h.cards = [skillCard('last_call', 'active', 'lc')];
    v.runStartedAt = w.t;
    v.runEndsAt = w.t + LAST_CALL_MIN + 10;
    load(w, v, 1);
    deliver(w, v, 'E1');
    expect(h.cards[0].progress).toBe(0);

    v.runEndsAt = w.t + LAST_CALL_MIN - 1;
    const before = v.runPts ?? 0;
    const combo = v.combo ?? 1;
    load(w, v, 1);
    deliver(w, v, 'E1');
    expect(h.cards[0].progress).toBe(1);
    expect(h.cards[0].status).toBe('active');
    expect((v.runPts ?? 0) - before).toBeCloseTo(20 * 1.5 * combo + LAST_CALL_PTS, 4);
  });

  it('High Roller: a crash costs an extra incident penalty and burns the card', () => {
    const { w, v } = human(5009);
    const h = w.cards['card-pilot']!;
    h.cards = [skillCard('high_roller', 'active', 'hr')];
    const v2 = spawnPlayerVehicle(w, 'parked-hr', 'Parked')!;
    v.tile = { x: 10, y: 13 };
    v.px = 10.5;
    v.py = 13.5;
    v.angle = 0;
    v2.tile = { x: 11, y: 13 };
    v2.px = 11.5;
    v2.py = 13.5;
    const ptsBefore = v.sPts;
    for (let i = 0; i < 10 && w.t >= v.stunnedUntil; i++) {
      stepHuman(w, v, { up: true, down: false, left: false, right: false, boost: true }, 0.05);
    }
    expect(h.cards[0].status).toBe('lost');
    expect(ptsBefore - v.sPts).toBeGreaterThanOrEqual(INCIDENT_PENALTY * 2);
  });
});

describe('cards: route contract reservation and poaching', () => {
  function routeSetup() {
    const w = createWorld({ seed: 5100 });
    const owner = spawnPlayerVehicle(w, 'owner', 'Owner', 'blitz')!;
    const rival = spawnPlayerVehicle(w, 'rival', 'Rival', 'blitz')!;
    const h = w.cards['owner']!;
    h.cards = [];
    const route = h.offer!.find((c) => c.type === 'route');
    expect(route).toBeDefined();
    h.offer = [route!];
    expect(keepCards(w, 'owner', [route!.id])).toBeNull();
    const orders = w.orders.filter((o) => o.card === route!.id);
    expect(orders.length).toBeGreaterThan(0);
    return { w, owner, rival, route: route!, orders };
  }

  it('reserved pallets are hidden from AI candidates, rejected by applyDecision and unpickable by rivals', () => {
    const { w, owner, rival, orders } = routeSetup();
    const o = orders[0];
    expect(o.reservedFor).toBe('owner');
    expect(CONTRACT_RESERVE_MIN).toBe(90);
    expect(o.reservedUntil).toBeCloseTo(w.t + CONTRACT_RESERVE_MIN, 6);

    // Rival human standing on the pickup can't pick it; the owner can.
    for (const v of [rival, owner]) {
      v.px = o.slot.ax + 0.5;
      v.py = o.slot.ay + 0.5;
      v.tile = { x: o.slot.ax, y: o.slot.ay };
    }
    expect(interactAt(w, rival).order).not.toBe(o);
    expect(interactAt(w, owner).order).toBe(o);

    // AI: find an idle agent and check its contract candidates.
    const ai = w.vehicles.find((x) => !x.human && x.state === 'idle' && !x.cargo.length)!;
    expect(ai).toBeDefined();
    w.pendingDecisions = [];
    w.phase = 'running';
    ai.state = 'idle';
    ai.orders = [];
    ai.cargo = [];
    ai.battery = 100;
    ai.stunnedUntil = 0;
    ai.brainError = null;
    const free = postOrder(w, { bayId: 'E1', force: true })!; // an unreserved alternative
    expect(free.reservedFor).toBeUndefined();
    const req = emitContractRequestIfNeeded(w, ai);
    expect(req).not.toBeNull();
    const opts = req!.options as ContractOption[];
    expect(opts.length).toBeGreaterThan(0);
    expect(opts.some((c) => c.orderId === o.id)).toBe(false);
    // Forge a stale offer that includes the reserved pallet: applyDecision rejects it.
    opts.push({ ...opts[0], orderId: o.id });
    const res = applyDecision(w, req!.id, { orderIds: [o.id], reason: 'grab' }, META);
    expect(res).toMatchObject({ ok: false, error: 'stale' });
  });

  it('after the window a rival delivery is a poach: event emitted and the card is lost', () => {
    const { w, rival, route, orders } = routeSetup();
    const poaches = collect(w, 'poach');
    const o = orders[0];
    w.t = o.reservedUntil! + 0.1;
    rival.px = o.slot.ax + 0.5;
    rival.py = o.slot.ay + 0.5;
    rival.tile = { x: o.slot.ax, y: o.slot.ay };
    expect(interactAt(w, rival).order).toBe(o); // window over: rivals may take it
    o.state = 'picked';
    o.claimant = rival.id;
    o.pickedAt = w.t - 1;
    rival.cargo = [o];
    rival.orders = [o];
    deliver(w, rival, o.bay);
    const card = w.cards['owner']!.cards.find((c) => c.id === route.id)!;
    expect(card.status).toBe('lost');
    expect(poaches.at(-1)).toMatchObject({ vid: rival.id, owner: 'owner', cardId: route.id, orderId: o.id });
    // Owner gets a replacement offer.
    expect(w.cards['owner']!.offer).not.toBeNull();
  });
});
