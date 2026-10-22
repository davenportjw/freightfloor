import { describe, expect, it } from 'vitest';
import {
  addPts,
  BLITZ_DEAL_SIZE,
  BLITZ_DECK,
  buildOccupancy,
  CHOSEN_ORDER_TTL_MIN,
  createWorld,
  deliver,
  DIFFICULTY,
  diffOf,
  dispatchOrderRoute,
  dropPalletOnCollision,
  getCardModifiers,
  humanInteract,
  INCIDENT_PENALTY,
  keepCards,
  ORDER_VALUE,
  postOrder,
  ratedParLoaded,
  release,
  removePlayerVehicle,
  setDifficulty,
  shiftIndex,
  SKILLS,
  spawnPlayerVehicle,
  startBlitzClock,
  stepHuman,
  takeWheel,
  tick,
  type Card,
  type DifficultyKey,
  type Order,
  type Vehicle,
  type World,
} from '../src/index.js';

function card(type: Card['type'], status: Card['status'], id: string): Card {
  // Route cards are built by mkRoute, not listed in SKILLS; give them a minimal shape.
  const s = SKILLS.find((x) => x.type === type) ?? {
    goal: 2,
    pts: 20,
    title: 'Route',
    desc: 'Route contract',
  };
  return {
    id,
    type,
    goal: s.goal,
    progress: status === 'done' ? s.goal : 0,
    status,
    pts: s.pts,
    title: s.title,
    desc: s.desc,
    ...(s.perk ? { perk: { ...s.perk } } : {}),
    ...(s.rarity ? { rarity: s.rarity } : {}),
    ...(status === 'done' ? { completedAt: 0 } : {}),
  } as Card;
}

function loadedOrder(w: World, v: Vehicle, bayId = 'E1'): Order {
  const o = postOrder(w, { bayId, force: true })!;
  o.state = 'picked';
  o.claimant = v.id;
  o.pickedAt = w.t;
  o.due = w.t + 100;
  v.cargo.push(o);
  v.orders.push(o);
  return o;
}

/** Advance across the next shift boundary with one tick (onShiftEnd runs inside tick). */
function crossShift(w: World): void {
  const next = (shiftIndex(w.t) + 1) * 480;
  w.t = Math.round((next - 0.1) * 10) / 10;
  tick(w);
}

describe('#1 run end / despawn releases everything the driver held', () => {
  it('Blitz run end expires unresolved cards and releases claims, cargo, reservations and card tags', () => {
    const w = createWorld({ seed: 7001, agents: 0 });
    const v = spawnPlayerVehicle(w, 'c1', 'RunEnd')!;
    const h = w.cards['c1']!;
    h.offer = null;
    h.cards = [card('overdrive', 'active', 'od-1'), card('route', 'active', 'route-1')];
    const claimed = postOrder(w, { force: true })!;
    claimed.state = 'claimed';
    claimed.claimant = v.id;
    claimed.chosenAt = w.t;
    v.orders.push(claimed);
    const carried = loadedOrder(w, v);
    const routePallet = postOrder(w, { force: true, card: 'route-1' })!;
    routePallet.reservedFor = 'c1';
    routePallet.reservedUntil = w.t + 90;

    v.runStartedAt = w.t;
    v.runEndsAt = Math.round((w.t + 0.1) * 10) / 10;
    tick(w);

    expect(v.runFinished).toBe(true);
    expect(h.cards.every((c) => c.status !== 'active')).toBe(true);
    expect(h.cards.find((c) => c.id === 'od-1')!.status).toBe('expired');
    expect(claimed.state).toBe('open');
    expect(claimed.claimant).toBeNull();
    expect(claimed.chosenAt).toBeUndefined();
    expect(carried.state).toBe('open');
    expect(carried.claimant).toBeNull();
    expect(v.cargo).toEqual([]);
    expect(v.orders).toEqual([]);
    expect(routePallet.reservedFor).toBeNull();
    expect(routePallet.card).toBeNull();
    expect(routePallet.reservedUntil).toBeUndefined();
  });

  it('removePlayerVehicle clears reservedFor and card on the player route orders', () => {
    const w = createWorld({ seed: 7002, agents: 0 });
    const v = spawnPlayerVehicle(w, 'c1b', 'Leaver')!;
    w.cards['c1b']!.cards = [card('route', 'active', 'route-x')];
    const p = postOrder(w, { force: true, card: 'route-x' })!;
    p.reservedFor = 'c1b';
    p.reservedUntil = w.t + 90;
    const chosen = postOrder(w, { force: true })!;
    chosen.state = 'claimed';
    chosen.claimant = v.id;
    chosen.chosenAt = w.t;
    v.orders.push(chosen);
    removePlayerVehicle(w, 'c1b');
    expect(p.reservedFor).toBeNull();
    expect(p.card).toBeNull();
    expect(chosen.claimant).toBeNull();
    expect(chosen.state).toBe('open');
    expect(w.cards['c1b']).toBeUndefined();
  });
});

describe('#2 takeWheel / release keep the AI intact', () => {
  it('restores the AI sPts and stats, and resets the human run state on release', () => {
    const w = createWorld({ seed: 7003, agents: 4 });
    const ai = w.vehicles.find((x) => x.id === 'FL-01')!;
    ai.sPts = 77;
    ai.sShipped = 5;
    ai.streak = 3;
    const aiEnds = ai.runEndsAt;
    expect(takeWheel(w, 'c2', 'Wheel', 'FL-01')).toBeNull();
    expect(ai.sPts).toBe(0);
    // The human's run on the AI truck finishes.
    ai.runPts = 40;
    ai.runFinished = true;
    ai.runMode = 'freerange';
    release(w, 'FL-01');
    expect(ai.human).toBe(false);
    expect(ai.sPts).toBe(77);
    expect(ai.sShipped).toBe(5);
    expect(ai.streak).toBe(3);
    expect(ai.runFinished).toBe(false);
    expect(ai.runMode).toBe('blitz');
    expect(ai.runEndsAt).toBe(aiEnds);
    expect(ai.runPts).toBe(0);
    expect(ai.aiStash).toBeNull();
    // Not frozen: the AI drains battery again.
    ai.battery = 80;
    ai.state = 'idle';
    tick(w);
    expect(ai.battery).toBeLessThan(80);
  });
});

describe('#3 parked DRV clock pauses while driving an AI truck', () => {
  it('the parked run never finishes (no run_complete eviction) and resumes with its time left', () => {
    const w = createWorld({ seed: 7004, agents: 4 });
    const dv = spawnPlayerVehicle(w, 'c3', 'Parker')!;
    startBlitzClock(w, dv);
    const left = dv.runEndsAt! - w.t;
    expect(takeWheel(w, 'c3', 'Parker', 'FL-01')).toBeNull();
    expect(dv.wheelPaused).toBe(true);
    // Way past the parked vehicle's original end time.
    w.t = Math.round((dv.runEndsAt! + 20) * 10) / 10;
    tick(w);
    expect(dv.runFinished).toBe(false);
    release(w, 'FL-01');
    expect(dv.wheelPaused).toBe(false);
    expect(dv.runEndsAt! - w.t).toBeCloseTo(left, 1);
    expect(w.players.get('c3')!.controlledVehicleId).toBe(dv.id);
  });

  it('two vehicles sharing one hand key: only the driven vehicle gets perks', () => {
    const w = createWorld({ seed: 7005, agents: 4 });
    const dv = spawnPlayerVehicle(w, 'c3b', 'Perky')!;
    w.cards['c3b']!.offer = null;
    w.cards['c3b']!.cards = [card('overdrive', 'done', 'sd-1')];
    const perkMul = getCardModifiers(w, dv).speedMul;
    expect(perkMul).toBeGreaterThan(1);
    takeWheel(w, 'c3b', 'Perky', 'FL-01');
    const ai = w.vehicles.find((x) => x.id === 'FL-01')!;
    expect(getCardModifiers(w, ai).speedMul).toBe(perkMul);
    expect(getCardModifiers(w, dv).speedMul).toBe(1);
    release(w, 'FL-01');
    expect(getCardModifiers(w, dv).speedMul).toBe(perkMul);
  });
});

describe('#5 addPts: one clamp policy for every penalty', () => {
  it('never takes sPts or runPts below 0', () => {
    const w = createWorld({ seed: 7006, agents: 0 });
    const v = spawnPlayerVehicle(w, 'c5', 'Clamp')!;
    v.sPts = 3;
    v.runPts = 3;
    expect(addPts(v, -30)).toBe(-3);
    expect(v.sPts).toBe(0);
    expect(v.runPts).toBe(0);
    loadedOrder(w, v);
    dropPalletOnCollision(w, v, 'a rack');
    expect(v.sPts).toBe(0);
    expect(v.runPts).toBe(0);
    v.sPts = 50;
    v.runPts = 50;
    loadedOrder(w, v);
    dropPalletOnCollision(w, v, 'a rack');
    expect(v.sPts).toBe(50 - INCIDENT_PENALTY);
    expect(v.runPts).toBe(50 - INCIDENT_PENALTY);
  });
});

describe('#6 0% battery', () => {
  it('E on a charger still works at 0% (pickups are refused)', () => {
    const w = createWorld({ seed: 7007, agents: 0 });
    const v = spawnPlayerVehicle(w, 'c6', 'Flat')!;
    const c = w.map.chargers[0];
    v.px = c.x + 0.5;
    v.py = c.y + 0.5;
    v.tile = { x: c.x, y: c.y };
    v.battery = 0;
    expect(humanInteract(w, v.id)).toBe(true);
    expect(v.humanCharging).toBe(true);
  });

  it('refuses a pickup at 0% but allows the drop', () => {
    const w = createWorld({ seed: 7008, agents: 0 });
    const v = spawnPlayerVehicle(w, 'c6b', 'Flat2')!;
    const o = postOrder(w, { force: true, bayId: 'E1' })!;
    v.px = o.slot.ax + 0.5;
    v.py = o.slot.ay + 0.5;
    v.tile = { x: o.slot.ax, y: o.slot.ay };
    v.battery = 0;
    expect(humanInteract(w, v.id)).toBe(false);
    expect(v.cargo.length).toBe(0);
    const carried = loadedOrder(w, v, 'E1');
    const bay = w.map.bays.find((b) => b.id === 'E1')!;
    const t = bay.tiles[0];
    v.px = t.x + 0.5;
    v.py = t.y + 0.5;
    v.tile = { x: t.x, y: t.y };
    expect(humanInteract(w, v.id)).toBe(true);
    expect(carried.state).toBe('done');
  });

  it('rejoining at 0% during a live Blitz keeps the vehicle and the run', () => {
    const w = createWorld({ seed: 7009, agents: 0 });
    const v = spawnPlayerVehicle(w, 'c6c', 'Rejoin')!;
    startBlitzClock(w, v);
    v.battery = 0;
    v.runPts = 30;
    const again = spawnPlayerVehicle(w, 'c6c', 'Rejoin');
    expect(again).toBe(v);
    expect(v.runPts).toBe(30);
    expect(w.completedRuns ?? []).toHaveLength(0);
  });
});

describe('#7 shift rollover banks only the delta', () => {
  it('active Blitz humans are not double-counted and the value series does not jump', () => {
    const w = createWorld({ seed: 7010, agents: 0 });
    const v = spawnPlayerVehicle(w, 'c7', 'Banker')!;
    v.sPts = 50;
    v.lastTot = 50;
    const hv = w.humanValue;
    crossShift(w);
    expect(v.bank).toBe(50);
    expect(v.sPts).toBe(50);
    expect(v.bankedPts).toBe(50);
    for (let i = 0; i < 60; i++) tick(w); // at least one more sampleValue
    expect(w.humanValue).toBe(hv);
    crossShift(w);
    expect(v.bank).toBe(50);
    // Finished but not evicted: banked once, then zeroed.
    v.sPts = 70;
    v.runFinished = true;
    crossShift(w);
    expect(v.bank).toBe(70);
    expect(v.sPts).toBe(0);
    crossShift(w);
    expect(v.bank).toBe(70);
  });
});

describe('#8 incident() pallet drop', () => {
  it('boosting into a vehicle drops ALL cargo at floor level 0', () => {
    const w = createWorld({ seed: 7011, agents: 0 });
    const v = spawnPlayerVehicle(w, 'c8', 'Rammer')!;
    const v2 = spawnPlayerVehicle(w, 'c8b', 'Parked')!;
    v.tile = { x: 10, y: 13 };
    v.px = 10.5;
    v.py = 13.5;
    v.angle = 0;
    v2.tile = { x: 11, y: 13 };
    v2.px = 11.5;
    v2.py = 13.5;
    const a = loadedOrder(w, v);
    const b = loadedOrder(w, v);
    a.slot = { ...a.slot, level: 2 };
    b.slot = { ...b.slot, level: 1 };
    for (let i = 0; i < 10 && v.cargo.length; i++) {
      stepHuman(w, v, { up: true, down: false, left: false, right: false, boost: true }, 0.05);
    }
    expect(v.cargo.length).toBe(0);
    expect(a.state).toBe('open');
    expect(b.state).toBe('open');
    expect(a.slot.level).toBe(0);
    expect(b.slot.level).toBe(0);
  });
});

describe('#9 trailer overflow', () => {
  it('a 2-pallet drop that closes a trailer carries the overflow into the next load', () => {
    const w = createWorld({ seed: 7012, agents: 0 });
    const v = spawnPlayerVehicle(w, 'c9', 'Closer')!;
    const bay = w.bays.find((b) => b.id === 'E1')!;
    bay.load = bay.cap - 1;
    loadedOrder(w, v, 'E1');
    loadedOrder(w, v, 'E1');
    expect(deliver(w, v, 'E1')).toBe(2);
    expect(bay.load).toBe(1);
    expect(bay.departUntil).toBeGreaterThan(w.t);
  });
});

describe('#10 ghost occupancy', () => {
  it('moving a human removes its old tile key from occ', () => {
    const w = createWorld({ seed: 7013, agents: 0 });
    const v = spawnPlayerVehicle(w, 'c10', 'Ghost')!;
    v.angle = 0;
    v.px = v.tile.x + 0.5;
    v.py = v.tile.y + 0.5;
    const occ = buildOccupancy(w).occ;
    const start = { ...v.tile };
    for (let i = 0; i < 40 && v.tile.x === start.x && v.tile.y === start.y; i++) {
      stepHuman(w, v, { up: true, down: false, left: false, right: false }, 0.1, occ);
    }
    expect(v.tile).not.toEqual(start);
    expect(occ.get(`${start.x},${start.y}`)).not.toBe(v);
    expect(occ.get(`${v.tile.x},${v.tile.y}`)).toBe(v);
  });
});

describe('#11 mid-leg difficulty change', () => {
  it('rates against par rescaled by the stamped vs current difficulty speed', () => {
    const w = createWorld({ seed: 7014, agents: 0 });
    const keys = Object.keys(DIFFICULTY) as DifficultyKey[];
    const slow = keys.reduce((a, b) => ((DIFFICULTY[a].speed ?? 1) <= (DIFFICULTY[b].speed ?? 1) ? a : b));
    const fast = keys.reduce((a, b) => ((DIFFICULTY[a].speed ?? 1) >= (DIFFICULTY[b].speed ?? 1) ? a : b));
    setDifficulty(w, slow);
    const v = spawnPlayerVehicle(w, 'c11', 'Par')!;
    const o = loadedOrder(w, v, 'E1');
    o.parLoaded = 10;
    o.parDiffSpeed = diffOf(w).speed ?? 1;
    expect(ratedParLoaded(w, o)).toBe(10);
    setDifficulty(w, fast);
    const expected = Math.round(((10 * (DIFFICULTY[slow].speed ?? 1)) / (DIFFICULTY[fast].speed ?? 1)) * 100) / 100;
    expect(ratedParLoaded(w, o)).toBe(expected);
    deliver(w, v, 'E1');
    expect(v.fareLog!.at(-1)!.par).toBe(expected);
  });
});

describe('#12 claim TTL', () => {
  it('a chosen order lapses back to open if not picked within CHOSEN_ORDER_TTL_MIN', () => {
    const w = createWorld({ seed: 7015, agents: 0 });
    const v = spawnPlayerVehicle(w, 'c12', 'Holder')!;
    const o = postOrder(w, { force: true })!;
    o.state = 'claimed';
    o.claimant = v.id;
    o.chosenAt = w.t;
    v.orders = [o];
    w.t = Math.round((w.t + CHOSEN_ORDER_TTL_MIN - 1) * 10) / 10;
    tick(w);
    expect(o.claimant).toBe(v.id);
    w.t = Math.round((o.chosenAt! + CHOSEN_ORDER_TTL_MIN) * 10) / 10;
    tick(w);
    expect(o.claimant).toBeNull();
    expect(o.state).toBe('open');
    expect(v.orders.includes(o)).toBe(false);
  });
});

describe('#13 same-mode rejoin deals a fresh Blitz hand', () => {
  it('Run N+1 gets a fresh Blitz deal even if a stale hand survived', () => {
    const w = createWorld({ seed: 7016, agents: 0 });
    const v1 = spawnPlayerVehicle(w, 'c13', 'Dee · Run 1')!;
    const h1 = w.cards['c13']!;
    expect(keepCards(w, 'c13', [h1.offer![0].id])).toBeNull();
    v1.runFinished = true;
    const v2 = spawnPlayerVehicle(w, 'c13', 'Dee · Run 2')!;
    expect(v2.runFinished).toBe(false);
    let h = w.cards['c13']!;
    expect(h.cards).toEqual([]);
    expect(h.offer!.length).toBe(BLITZ_DEAL_SIZE);
    expect(h.offer!.every((c) => (BLITZ_DECK as readonly string[]).includes(c.title))).toBe(true);

    // A stale same-shift hand with no session (e.g. left behind by a previous run).
    removePlayerVehicle(w, 'c13');
    w.cards['c13'] = { shift: shiftIndex(w.t), offer: null, cards: [card('overdrive', 'active', 'stale')] };
    spawnPlayerVehicle(w, 'c13', 'Dee · Run 3');
    h = w.cards['c13']!;
    expect(h.cards).toEqual([]);
    expect(h.offer!.length).toBe(BLITZ_DEAL_SIZE);
  });
});

describe('#14 Floor Dispatch score pump', () => {
  it('urgent dispatch never mints orders worth more than a standard order', () => {
    const w = createWorld({ seed: 7017, agents: 0 });
    const existing = postOrder(w, { force: true })!;
    expect(existing.value).toBe(ORDER_VALUE);
    const res = dispatchOrderRoute(w, {
      sourceZone: 'any',
      targetBay: 'auto',
      priority: 'urgent',
      count: 4,
      mode: 'reroute_and_spawn',
    });
    expect(res.orderIds.length).toBeGreaterThan(0);
    for (const id of res.orderIds) {
      const o = w.orders.find((x) => x.id === id)!;
      expect(o.value).toBeLessThanOrEqual(ORDER_VALUE);
    }
    const spawned = dispatchOrderRoute(w, {
      sourceZone: 'any',
      targetBay: 'auto',
      priority: 'urgent',
      count: 3,
      mode: 'spawn_only',
    });
    expect(spawned.spawned).toBeGreaterThan(0);
    for (const id of spawned.orderIds) {
      expect(w.orders.find((x) => x.id === id)!.value).toBeLessThanOrEqual(ORDER_VALUE);
    }
  });
});
