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
  contractReserveMin,
  inLastCall,
  lastCallMin,
  Order,
  PERK_CAPS,
  postOrder,
  runWindowMin,
  SimEvent,
  SKILLS,
  spawnPlayerVehicle,
  stepHuman,
  Vehicle,
  WILD_CHANCE,
  World,
} from '../src/index.js';
import { BASE_HWY_Y, isBlocked } from '../src/map.js';

const META = { model: 'gemini-3.8-flash', latencyMs: 1, inputTokens: 1, outputTokens: 1 };
/** User-added cards, now perk cards (unlock on completion). */
const USER_CARD_TITLES = ['Turbo Courier', 'Tele-Fork Extension', 'Regen Capacitor', 'Priority Broker'];

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

function human(
  seed: number,
  id = 'card-pilot',
  mode: 'blitz' | 'freerange' = 'blitz',
): { w: World; v: Vehicle } {
  const w = createWorld({ seed, agents: 0 });
  const v = spawnPlayerVehicle(w, id, 'CardPilot', mode)!;
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
  it('SKILLS covers the dealable types, including the Phase-3 cards', () => {
    const types = new Set(SKILLS.map((s) => s.type));
    for (const t of types) expect(CARD_TYPE_IDS).toContain(t);
    for (const t of ['long_haul', 'local_hero', 'poacher', 'rival_grudge', 'ghost_hunter']) {
      expect(CARD_TYPE_IDS).toContain(t);
      expect(types.has(t as Card['type'])).toBe(true);
    }
    expect(SKILLS.filter((s) => s.rarity === 'wild').map((s) => s.type).sort()).toEqual([
      'double_nothing',
      'ghost_hunter',
      'high_roller',
      'last_call',
      'rival_grudge',
    ]);
    expect(SKILLS.filter((s) => s.humanOnly).map((s) => s.type).sort()).toEqual([
      'beat_planner',
      'combo_king',
      'crazy_stop',
      'ghost_hunter',
      'poacher',
      'rival_grudge',
    ]);
    expect(WILD_CHANCE).toBe(0.2);
  });

  it('user-added cards are perk cards (no payout keys) that unlock only once done', () => {
    const expected: Record<string, object> = {
      'Turbo Courier': { speedMul: 1.18 },
      'Tele-Fork Extension': { reachBonus: 0.5, chargeBonus: 2 },
      'Regen Capacitor': { drainMul: 0.65, chargeBonus: 4 },
      'Priority Broker': { reachBonus: 0.15 },
    };
    for (const title of USER_CARD_TITLES) {
      const s = SKILLS.find((x) => x.title === title)!;
      expect(s).toBeDefined();
      expect(s.perk).toEqual(expected[title]);
      expect(s.modifiers).toBeUndefined();
      for (const k of ['payoutBonus', 'ptsBonus', 'p0Bonus']) expect(s.perk).not.toHaveProperty(k);
    }

    const { w, v } = human(5010);
    const h = w.cards['card-pilot']!;
    const card = (title: string, status: Card['status']): Card => {
      const s = SKILLS.find((x) => x.title === title)!;
      return {
        id: `${title}-${status}`, type: s.type, goal: s.goal, progress: 0, status, pts: s.pts,
        title: s.title, desc: s.desc, rarity: 'common', perk: { ...s.perk }, modifiers: { ...s.perk },
      };
    };
    h.cards = USER_CARD_TITLES.map((t) => card(t, 'active'));
    let m = getCardModifiers(w, v);
    expect(m.speedMul).toBe(1);
    expect(m.reachBonus).toBe(0);
    expect(m.chargeBonus).toBe(0);
    expect(m.drainMul).toBe(1);
    h.cards = USER_CARD_TITLES.map((t) => card(t, 'done'));
    m = getCardModifiers(w, v);
    expect(m.speedMul).toBeCloseTo(1.18, 6);
    expect(m.reachBonus).toBe(PERK_CAPS.reachBonus); // 0.5 + 0.15, capped
    expect(m.chargeBonus).toBe(PERK_CAPS.chargeBonus); // 2 + 4
    expect(m.drainMul).toBeCloseTo(0.65, 6); // boost drain only
    expect(m.batteryDrainMul).toBe(1);
    expect(m.ptsBonus).toBe(0);
    expect(m.p0Bonus).toBe(0);
  });

  it('Regen Capacitor perk cuts boost drain only', () => {
    /** Battery used driving 10 ticks along an open highway row, with or without boost/perk. */
    const drained = (withPerk: boolean, boost: boolean): number => {
      const { w, v } = human(5011);
      const s = SKILLS.find((x) => x.title === 'Regen Capacitor')!;
      if (withPerk) {
        w.cards['card-pilot']!.cards = [
          { id: 'regen', type: s.type, goal: 1, progress: 1, status: 'done', pts: s.pts, title: s.title, desc: s.desc, perk: { ...s.perk } },
        ];
      }
      const y = BASE_HWY_Y[1];
      let x0 = -1;
      for (let x = 0; x < w.map.w - 16 && x0 < 0; x++) {
        let open = true;
        for (let k = 0; k < 16; k++) if (isBlocked(w, x + k, y)) open = false;
        if (open) x0 = x;
      }
      expect(x0).toBeGreaterThanOrEqual(0);
      v.px = x0 + 0.5;
      v.py = y + 0.5;
      v.tile = { x: x0, y };
      v.angle = 0;
      v.speedNow = 0;
      v.battery = 100;
      for (let i = 0; i < 10; i++) {
        stepHuman(w, v, { up: true, down: false, left: false, right: false, boost }, 0.1);
      }
      return 100 - v.battery;
    };
    // Without boost the perk changes nothing; with boost it drains less.
    expect(drained(true, false)).toBeCloseTo(drained(false, false), 9);
    expect(drained(true, true)).toBeLessThan(drained(false, true));
    expect(drained(true, true)).toBeGreaterThan(drained(false, false));
  });

  it('Turbo Courier counts trips ≤ 6 min; Priority Broker counts on-time pallets cumulatively', () => {
    const { w, v } = human(5013);
    const h = w.cards['card-pilot']!;
    const mk = (title: string): Card => {
      const s = SKILLS.find((x) => x.title === title)!;
      return { id: title, type: s.type, goal: s.goal, progress: 0, status: 'active', pts: s.pts, title, desc: s.desc, perk: { ...s.perk } };
    };
    h.cards = [mk('Turbo Courier'), mk('Priority Broker')];
    load(w, v, 5, 3); // 5-min trip vs par 3 → Slow, but within 6 min
    deliver(w, v, 'E1');
    expect(h.cards[0].progress).toBe(1);
    expect(h.cards[1].progress).toBe(1); // on time (Slow doesn't reset it)
    load(w, v, 7, 20); // 7-min trip: Speedy-ish but over 6 min
    deliver(w, v, 'E1');
    expect(h.cards[0].progress).toBe(1);
    expect(h.cards[1].progress).toBe(2);
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
        expect(opts.every((o) => o.perk !== undefined)).toBe(true);
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

  it('completing a card triggers a 1-of-2 replacement offer (Free Range)', () => {
    const { w, v } = human(5005, 'card-pilot', 'freerange');
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

  it('Last Call pays +10 per Speedy fare inside the final (blitz-clamped) window only', () => {
    const { w, v } = human(5008);
    const h = w.cards['card-pilot']!;
    h.cards = [skillCard('last_call', 'active', 'lc')];
    // 30-min blitz run → window = min(90, 30/3) = 10 min.
    v.runStartedAt = w.t;
    v.runEndsAt = w.t + 30;
    expect(lastCallMin(v)).toBeCloseTo(10, 6);
    v.runStartedAt = w.t - 19;
    v.runEndsAt = w.t + 11; // 11 min left: outside the 10-min window
    expect(inLastCall(w, v)).toBe(false);
    load(w, v, 1);
    deliver(w, v, 'E1');
    expect(h.cards[0].progress).toBe(0);

    v.runStartedAt = w.t - 25;
    v.runEndsAt = w.t + 5; // 5 min left: inside
    expect(inLastCall(w, v)).toBe(true);
    const before = v.runPts ?? 0;
    const combo = v.combo ?? 1;
    load(w, v, 1);
    deliver(w, v, 'E1');
    expect(h.cards[0].progress).toBe(1);
    expect(h.cards[0].status).toBe('active');
    expect((v.runPts ?? 0) - before).toBeCloseTo(20 * 1.5 * combo + LAST_CALL_PTS, 4);
  });

  it('run windows clamp to a third of a blitz run but stay 90 min in shift mode', () => {
    const { w, v } = human(5010);
    // Blitz before the run starts uses BLITZ_DURATION_MIN (180) → min(90, 60) = 60.
    expect(lastCallMin(v)).toBe(60);
    expect(contractReserveMin(v)).toBe(60);
    // Short live blitz run → clamp.
    v.runStartedAt = w.t;
    v.runEndsAt = w.t + 60;
    expect(lastCallMin(v)).toBeCloseTo(20, 6);
    expect(contractReserveMin(v)).toBeCloseTo(20, 6);
    expect(runWindowMin(90, null)).toBe(90);

    // Shift (freerange) driver: never clamped, Last Call = final 90 min of the 480-min shift.
    const s = spawnPlayerVehicle(w, 'shift-pilot', 'Shift', 'freerange')!;
    expect(s.runMode).not.toBe('blitz');
    expect(lastCallMin(s)).toBe(LAST_CALL_MIN);
    expect(contractReserveMin(s)).toBe(CONTRACT_RESERVE_MIN);
    w.t = 480 - LAST_CALL_MIN - 1;
    expect(inLastCall(w, s)).toBe(false);
    w.t = 480 - 30;
    expect(inLastCall(w, s)).toBe(true);
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
    v.sPts = 100; // penalties clamp at 0 (addPts), so start with points to lose
    v.runPts = 100;
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
    // Route contracts are only dealt from the full (Free Range) deck.
    const owner = spawnPlayerVehicle(w, 'owner', 'Owner', 'freerange')!;
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

  it('reservation window clamps to a third of a short live blitz run', () => {
    const w = createWorld({ seed: 5100 });
    // Dealt from the Free Range deck, then held in a short live blitz run.
    const owner = spawnPlayerVehicle(w, 'owner', 'Owner', 'freerange')!;
    owner.runMode = 'blitz';
    owner.runStartedAt = w.t;
    owner.runEndsAt = w.t + 30;
    const h = w.cards['owner']!;
    h.cards = [];
    const route = h.offer!.find((c) => c.type === 'route')!;
    h.offer = [route];
    expect(keepCards(w, 'owner', [route.id])).toBeNull();
    const orders = w.orders.filter((o) => o.card === route.id);
    expect(orders.length).toBeGreaterThan(0);
    for (const o of orders) expect(o.reservedUntil).toBeCloseTo(w.t + 10, 6);
  });

  it('reserved pallets are hidden from AI candidates, rejected by applyDecision and unpickable by rivals', () => {
    const { w, owner, rival, orders } = routeSetup();
    const o = orders[0];
    expect(o.reservedFor).toBe('owner');
    expect(CONTRACT_RESERVE_MIN).toBe(90);
    expect(o.reservedUntil).toBeCloseTo(w.t + contractReserveMin(owner), 6);

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
