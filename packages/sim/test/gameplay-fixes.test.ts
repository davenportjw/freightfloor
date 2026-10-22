import { describe, expect, it } from 'vitest';
import {
  BLITZ_DEAL_SIZE,
  BLITZ_DECK,
  BLITZ_DURATION_MIN,
  computeDriverPpm,
  createWorld,
  dealCards,
  deliver,
  FARE_CHOICE_TIMEOUT_MIN,
  keepCards,
  postOrder,
  RATING_MUL,
  RIVAL_SNIPE_COOLDOWN_MIN,
  setDriverRunMode,
  spawnPlayerVehicle,
  startBlitzClock,
  stepHuman,
  tick,
  VICTIM_STUN_MIN,
  type Order,
  type SimEvent,
  type Vehicle,
  type World,
} from '../src/index.js';

function collect(w: World, type: string): SimEvent[] {
  const out: SimEvent[] = [];
  const orig = w.events.push.bind(w.events);
  w.events.push = (...evs: SimEvent[]) => {
    for (const e of evs) if (e.type === type) out.push(e);
    return orig(...evs);
  };
  return out;
}

function postSome(w: World, n: number): Order[] {
  const out: Order[] = [];
  for (let i = 0; i < n; i++) {
    const o = postOrder(w, { force: true });
    if (o) out.push(o);
  }
  return out;
}

function loaded(w: World, v: Vehicle, par: number, actual: number): Order {
  const o = postOrder(w, { bayId: 'E1', force: true })!;
  o.value = 8;
  o.state = 'picked';
  o.claimant = v.id;
  o.pickedAt = w.t - actual;
  o.parLoaded = par;
  o.due = w.t + 50;
  v.cargo.push(o);
  v.orders.push(o);
  return o;
}

describe('#1 Blitz exploit: switching run mode starts a fresh run', () => {
  it('freerange → blitz mid-run carries no points into the new Blitz clock', () => {
    const w = createWorld({ seed: 9101, agents: 0 });
    const v = spawnPlayerVehicle(w, 'mode-1', 'ModeOne', 'freerange')!;
    v.runPts = 120;
    v.sPts = 120;
    v.runDeliveries = 9;
    v.runOnTime = 9;
    v.streak = 6;
    v.bestStreak = 6;
    v.comboStep = 3;
    v.combo = 2;
    setDriverRunMode(w, 'mode-1', 'blitz');
    expect(v.runMode).toBe('blitz');
    expect(v.runPts).toBe(0);
    expect(v.sPts).toBe(0);
    expect(v.runDeliveries).toBe(0);
    expect(v.streak).toBe(0);
    expect(v.bestStreak).toBe(0);
    expect(v.combo).toBe(1);
    expect(v.runStartedAt).toBeNull();
    expect(v.runEndsAt).toBeNull();
    // Re-dealt from the Blitz deck.
    const h = w.cards['mode-1']!;
    expect(h.cards).toHaveLength(0);
    expect(h.offer!.every((c) => (BLITZ_DECK as readonly string[]).includes(c.title))).toBe(true);
  });

  it('restarting a finished blitz resets stats too; blitz → freerange measures PPM from the switch', () => {
    const w = createWorld({ seed: 9102, agents: 0 });
    const v = spawnPlayerVehicle(w, 'mode-2', 'ModeTwo', 'blitz')!;
    startBlitzClock(w, v);
    v.runPts = 80;
    v.runDeliveries = 4;
    v.runFinished = true;
    setDriverRunMode(w, v, 'blitz');
    expect(v.runFinished).toBe(false);
    expect(v.runPts).toBe(0);
    expect(v.runDeliveries).toBe(0);
    expect(v.runStartedAt).toBeNull();

    startBlitzClock(w, v);
    w.t += 100;
    v.runPts = 50;
    v.runDeliveries = 5;
    setDriverRunMode(w, v, 'freerange');
    expect(v.runMode).toBe('freerange');
    expect(v.runStartedAt).toBe(w.t);
    expect(v.runEndsAt).toBeNull();
    expect(v.runPts).toBe(0);
    expect(v.runDeliveries).toBe(0);
    expect(computeDriverPpm(w, v)).toBe(0);
  });

  it('a same-mode call on a live run is a no-op', () => {
    const w = createWorld({ seed: 9103, agents: 0 });
    const v = spawnPlayerVehicle(w, 'mode-3', 'ModeThree', 'blitz')!;
    startBlitzClock(w, v);
    v.runPts = 33;
    const started = v.runStartedAt;
    setDriverRunMode(w, v, 'blitz');
    expect(v.runPts).toBe(33);
    expect(v.runStartedAt).toBe(started);
  });
});

describe('#2/#6 Scoring: no streak multiplier; fare event carries the breakdown', () => {
  it('pays (value + bonuses) × rating × combo regardless of streak, and emits base / ratingMul', () => {
    const w = createWorld({ seed: 9201, agents: 0 });
    const v = spawnPlayerVehicle(w, 'fare-1', 'FareOne', 'freerange')!;
    w.cards['fare-1']!.cards = [];
    w.cards['fare-1']!.offer = null;
    w.bays.forEach((b) => (b.load = 0));
    v.streak = 10;
    v.comboStep = 2; // ×1.5
    v.combo = 1.5;
    const evs = collect(w, 'fare');
    loaded(w, v, 10, 7); // 7 ≤ 0.8 × 10 → Speedy
    deliver(w, v, 'E1');
    expect(evs).toHaveLength(1);
    const e = evs[0] as SimEvent & { base: number; ratingMul: number; combo: number; pts: number; rating: string };
    expect(e.rating).toBe('speedy');
    expect(e.base).toBe(8);
    expect(e.ratingMul).toBe(RATING_MUL.speedy);
    expect(e.combo).toBe(1.5);
    expect(e.pts).toBe(18); // 8 × 1.5 × 1.5, no streak multiplier
    expect(v.streak).toBe(11);
  });
});

describe('#3 Ramming fairness', () => {
  function setup() {
    const w = createWorld({ seed: 2026, agents: 0 });
    const p1 = spawnPlayerVehicle(w, 'ram-1', 'Rammer', 'freerange')!;
    const p2 = spawnPlayerVehicle(w, 'ram-2', 'Victim', 'freerange')!;
    const rowY = 1;
    Object.assign(p1, { tile: { x: 9, y: rowY }, px: 9.55, py: rowY + 0.5, angle: 0, speedNow: 0, stunnedUntil: 0 });
    Object.assign(p2, { tile: { x: 10, y: rowY }, px: 10.5, py: rowY + 0.5, angle: Math.PI, speedNow: 0, stunnedUntil: 0 });
    return { w, p1, p2 };
  }
  function ram(w: World, p1: Vehicle): void {
    for (let i = 0; i < 10; i++) {
      if (w.t < p1.stunnedUntil) break;
      p1.speedNow = 2.2;
      stepHuman(w, p1, { up: true, down: false, left: false, right: false }, 0.05);
    }
  }

  it('a parked victim only gets a short stun: no incident, combo/streak/cargo/Clean Shift kept', () => {
    const { w, p1, p2 } = setup();
    p2.comboStep = 2;
    p2.combo = 1.5;
    p2.streak = 4;
    const cargo = loaded(w, p2, 10, 1);
    const evs = collect(w, 'incident');
    ram(w, p1);
    expect(evs).toHaveLength(1);
    const e = evs[0] as SimEvent & { vid: string; victim: string; victimAtFault: boolean };
    expect(e.vid).toBe(p1.id);
    expect(e.victim).toBe(p2.id);
    expect(e.victimAtFault).toBe(false);
    expect(p1.runIncidents).toBe(1);
    expect(p2.runIncidents ?? 0).toBe(0);
    expect(p2.incidents).toBe(0);
    expect(p2.combo).toBe(1.5);
    expect(p2.streak).toBe(4);
    expect(p2.cargo).toContain(cargo);
    expect(p2.stunnedUntil).toBeGreaterThan(w.t);
    expect(p2.stunnedUntil).toBeLessThanOrEqual(w.t + VICTIM_STUN_MIN + 1e-6);
    expect(p1.stunnedUntil).toBeGreaterThan(p2.stunnedUntil);
  });

  it('a victim also driving fast toward the rammer shares the full crash', () => {
    const { w, p1, p2 } = setup();
    p2.speedNow = 2.5; // facing West (toward p1) at speed
    const evs = collect(w, 'incident');
    ram(w, p1);
    expect(evs).toHaveLength(1);
    expect((evs[0] as SimEvent & { victimAtFault: boolean }).victimAtFault).toBe(true);
    expect(p2.runIncidents).toBe(1);
    expect(p2.stunnedUntil).toBeGreaterThan(w.t + VICTIM_STUN_MIN);
  });
});

describe('#4 Simplified Blitz deck', () => {
  it('deals BLITZ_DEAL_SIZE simple cards from BLITZ_DECK only: no wild, route or replacement offers', () => {
    for (let seed = 9400; seed < 9460; seed++) {
      const w = createWorld({ seed, agents: 0 });
      const v = spawnPlayerVehicle(w, 'bz', 'Blitzer', 'blitz')!;
      const h = w.cards['bz']!;
      expect(h.offer).toHaveLength(BLITZ_DEAL_SIZE);
      for (const c of h.offer!) {
        expect(BLITZ_DECK as readonly string[]).toContain(c.title);
        expect(c.rarity).not.toBe('wild');
        expect(c.type).not.toBe('route');
      }
      expect(keepCards(w, 'bz', [h.offer![0].id])).toBeNull();
      // No replacement offer while in blitz.
      dealCards(w, 'bz', true);
      expect(h.offer).toBeNull();
      expect(v.runMode).toBe('blitz');
    }
  });

  it('Free Range keeps the full deck and replacement offers', () => {
    const seen = new Set<string>();
    for (let seed = 9500; seed < 9560; seed++) {
      const w = createWorld({ seed, agents: 0 });
      spawnPlayerVehicle(w, 'fr', 'Ranger', 'freerange')!;
      const h = w.cards['fr']!;
      h.offer!.forEach((c) => seen.add(c.type));
      expect(keepCards(w, 'fr', [h.offer![0].id])).toBeNull();
      dealCards(w, 'fr', true);
      expect(h.offer).toHaveLength(2);
    }
    expect(seen.has('route')).toBe(true);
  });
});

describe('#5 Drive-first Blitz clock', () => {
  it('keeping cards does not start the clock; the first interact does', () => {
    const w = createWorld({ seed: 9601, agents: 0 });
    const v = spawnPlayerVehicle(w, 'df', 'DriveFirst', 'blitz')!;
    const h = w.cards['df']!;
    expect(keepCards(w, 'df', [h.offer![0].id])).toBeNull();
    expect(v.runStartedAt).toBeNull();
    expect(v.runEndsAt).toBeNull();
    startBlitzClock(w, v);
    expect(v.runStartedAt).toBe(w.t);
    expect(v.runEndsAt).toBeCloseTo(w.t + BLITZ_DURATION_MIN, 6);
  });

  it('the Co-Pilot fare auto-pick never fires before the Blitz clock starts', () => {
    const w = createWorld({ seed: 9602, agents: 0 });
    const v = spawnPlayerVehicle(w, 'np', 'NoPick', 'blitz')!;
    w.cards['np']!.offer = null;
    w.phase = 'running';
    v.battery = 100;
    postSome(w, 8);
    const picks = collect(w, 'fare_choice');
    const ticks = Math.ceil((FARE_CHOICE_TIMEOUT_MIN * 3) / 0.1);
    for (let i = 0; i < ticks; i++) tick(w, 0.1);
    expect(v.runStartedAt).toBeNull();
    expect(picks).toHaveLength(0);
    expect(v.fareOffer).toBeTruthy();
    // Once the clock starts, the normal timeout applies again.
    startBlitzClock(w, v);
    for (let i = 0; i < ticks && picks.length === 0; i++) tick(w, 0.1);
    expect(picks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('#7 rival_snipe: any AI taking the order you are heading to', () => {
  function setup(seed: number) {
    const w = createWorld({ seed, agents: 2 });
    const v = spawnPlayerVehicle(w, 'sn', 'Sniped', 'freerange')!;
    w.cards['sn']!.offer = null;
    w.phase = 'running';
    v.battery = 100;
    postSome(w, 8);
    tick(w, 0.1);
    expect(v.fareOffer).toBeTruthy();
    const ai = w.vehicles.find((x) => !x.human && x.id !== v.rivalId) ?? w.vehicles.find((x) => !x.human)!;
    return { w, v, ai };
  }

  it('emits with the AI vid and its real last reason; omits reason when none; throttled', () => {
    const { w, v, ai } = setup(9701);
    const evs = collect(w, 'rival_snipe');
    ai.lastDecision = null;
    ai.lastBrainDecision = null;
    const target = w.orders.find((o) => o.id === v.fareOffer!.copilotId)!;
    target.claimant = ai.id;
    target.state = 'claimed';
    tick(w, 0.1);
    const mine = evs.filter((e) => (e as SimEvent & { vid: string }).vid === v.id);
    expect(mine).toHaveLength(1);
    const e = mine[0] as SimEvent & { rival: string; orderId: number; reason?: string };
    expect(e.rival).toBe(ai.id);
    expect(e.orderId).toBe(target.id);
    expect('reason' in e).toBe(false);

    // Throttled: a second snipe inside the cooldown is silent.
    expect(v.fareOffer).toBeTruthy();
    const next = w.orders.find((o) => o.id === v.fareOffer!.copilotId)!;
    next.claimant = ai.id;
    next.state = 'claimed';
    tick(w, 0.1);
    expect(evs.filter((x) => (x as SimEvent & { vid: string }).vid === v.id)).toHaveLength(1);
    expect(v.lastSnipeAt).not.toBeNull();
    expect(RIVAL_SNIPE_COOLDOWN_MIN).toBeGreaterThanOrEqual(15);
  });

  it('carries the AI brain reason when it has one', () => {
    const { w, v, ai } = setup(9702);
    const evs = collect(w, 'rival_snipe');
    ai.lastDecision = {
      id: 'req-x',
      kind: 'contract',
      reason: 'closest P0 to my dock',
      model: 'gemini-3.5-flash-lite',
      latencyMs: 10,
      t: w.t,
    };
    const target = w.orders.find((o) => o.id === v.fareOffer!.copilotId)!;
    target.claimant = ai.id;
    target.state = 'claimed';
    tick(w, 0.1);
    const e = evs.find((x) => (x as SimEvent & { vid: string }).vid === v.id) as
      | (SimEvent & { reason?: string; rival: string })
      | undefined;
    expect(e).toBeDefined();
    expect(e!.rival).toBe(ai.id);
    expect(e!.reason).toBe('closest P0 to my dock');
  });
});
