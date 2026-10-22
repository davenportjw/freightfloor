import { describe, expect, it } from 'vitest';
import {
  BLITZ_DURATION_MIN,
  createWorld,
  deliver,
  detectDispatchersCallSituation,
  DISPATCHERS_CALL_CLOSE_MIN,
  DISPATCHERS_CALL_EVAL_MIN,
  DISPATCHERS_CALL_MAX_PTS,
  DISPATCHERS_CALL_OPEN_MIN,
  DISPATCHERS_CALL_PICK_MIN,
  DISPATCHERS_CALL_PTS_PER_PALLET,
  dispatchersCallWindow,
  offerDispatchersCall,
  postOrder,
  resolveDispatchersCallPick,
  settleDispatchersCall,
  setDriverRunMode,
  skipDispatchersCall,
  spawnPlayerVehicle,
  startBlitzClock,
  tick,
  type DispatchersCallSituation,
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

/** World with a human Blitz run whose clock started `elapsed` game-min ago. */
function midRun(seed: number, elapsed = 95): { w: World; v: Vehicle } {
  const w = createWorld({ seed, agents: 0 });
  const v = spawnPlayerVehicle(w, `dc-${seed}`, 'Dispatcher', 'blitz')!;
  startBlitzClock(w, v);
  v.runStartedAt = w.t - elapsed;
  v.runEndsAt = Math.round((v.runStartedAt + BLITZ_DURATION_MIN) * 10) / 10;
  return { w, v };
}

/** Remove every live signal so the detector sees a calm floor. */
function calmFloor(w: World): void {
  w.orders = [];
  w.spills.length = 0;
  for (const b of w.bays) {
    b.load = 0;
    b.departUntil = 0;
  }
}

function realSituation(w: World): DispatchersCallSituation {
  calmFloor(w);
  for (let i = 0; i < 2; i++) postOrder(w, { p0: true, force: true });
  const s = detectDispatchersCallSituation(w);
  expect(s).not.toBeNull();
  return s!;
}

/** Load the order into the vehicle and deliver it at its bay right now. */
function deliverNow(w: World, v: Vehicle, orderId: number): void {
  const o = w.orders.find((x) => x.id === orderId)!;
  o.state = 'picked';
  o.claimant = v.id;
  o.pickedAt = w.t - 1;
  v.cargo.push(o);
  v.orders.push(o);
  deliver(w, v, o.bay);
}

describe("Dispatcher's Call window", () => {
  it('opens once per Blitz run between the open and close marks', () => {
    const w = createWorld({ seed: 7001, agents: 0 });
    const v = spawnPlayerVehicle(w, 'dc-w', 'Win', 'blitz')!;
    expect(dispatchersCallWindow(w, v)).toBe('ineligible'); // clock not started
    startBlitzClock(w, v);
    expect(dispatchersCallWindow(w, v)).toBe('early');
    v.runStartedAt = w.t - DISPATCHERS_CALL_OPEN_MIN;
    expect(dispatchersCallWindow(w, v)).toBe('open');
    v.runStartedAt = w.t - DISPATCHERS_CALL_CLOSE_MIN - 1;
    expect(dispatchersCallWindow(w, v)).toBe('closed');
    setDriverRunMode(w, v, 'freerange');
    expect(dispatchersCallWindow(w, v)).toBe('ineligible');
  });
});

describe("Dispatcher's Call situation detector (real state only)", () => {
  it('returns null on a calm floor', () => {
    const { w } = midRun(7002);
    calmFloor(w);
    expect(detectDispatchersCallSituation(w)).toBeNull();
  });

  it('detects spill, P0 surge, trailer near cap, hazmat and dock backlogs', () => {
    const { w } = midRun(7003);
    calmFloor(w);
    w.spills.push({ id: 99, x: 5, y: 5, born: w.t, until: w.t + 20 });
    expect(detectDispatchersCallSituation(w)?.kind).toBe('spill');

    calmFloor(w);
    postOrder(w, { p0: true, force: true });
    expect(detectDispatchersCallSituation(w)).toBeNull();
    postOrder(w, { p0: true, force: true });
    const p0 = detectDispatchersCallSituation(w)!;
    expect(p0.kind).toBe('p0_surge');
    expect(p0.openP0).toBe(2);

    calmFloor(w);
    const bay = w.bays.find((b) => !b.isTransferBay && b.id !== 'RET')!;
    bay.load = Math.ceil(bay.cap * 0.8);
    const tr = detectDispatchersCallSituation(w)!;
    expect(tr.kind).toBe('trailer_near_cap');
    expect(tr.bayId).toBe(bay.id);
    // A departing trailer is not loading; it does not qualify.
    bay.departUntil = w.t + 10;
    expect(detectDispatchersCallSituation(w)).toBeNull();

    calmFloor(w);
    for (let i = 0; i < 3; i++) postOrder(w, { zone: 'Z', bayId: 'RET', force: true });
    expect(detectDispatchersCallSituation(w)?.kind).toBe('hazmat_backlog');

    calmFloor(w);
    for (let i = 0; i < 3; i++) {
      const o = postOrder(w, { force: true })!;
      o.putaway = { ...o.slot };
    }
    expect(detectDispatchersCallSituation(w)?.kind).toBe('dock_backlog');
  });
});

describe("Dispatcher's Call lifecycle", () => {
  it('a pick runs a real dispatch, tracks the orders and pays per on-time pallet', () => {
    const { w, v } = midRun(7004);
    const results = collect(w, 'dispatchers_call_result');
    const situation = realSituation(w);
    const dc = offerDispatchersCall(w, v, { situation, optionCount: 3, geminiIdx: 1 })!;
    expect(dc.status).toBe('offered');
    expect(dispatchersCallWindow(w, v)).toBe('ineligible'); // once per run

    const before = v.runPts;
    const res = resolveDispatchersCallPick(w, v, dc.id, {
      optionIdx: 1,
      params: { sourceZone: 'general', targetBay: 'E1', priority: 'urgent', count: 3, mode: 'spawn_only' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.agreed).toBe(true);
    expect(res.dispatch!.orderIds).toHaveLength(3);
    expect(dc.status).toBe('evaluating');
    expect(dc.evalUntil).toBeCloseTo(w.t + DISPATCHERS_CALL_EVAL_MIN, 5);
    for (const id of dc.orderIds) {
      expect(w.orders.find((o) => o.id === id)!.dispatchCallId).toBe(dc.id);
    }

    // Delivered by another driver still counts (anyone).
    const other = spawnPlayerVehicle(w, 'dc-other', 'Other', 'freerange')!;
    deliverNow(w, other, dc.orderIds[0]);
    deliverNow(w, v, dc.orderIds[1]);
    expect(dc.delivered).toBe(2);
    expect(dc.onTime).toBe(2);
    const afterDeliveries = v.runPts;

    // Score at evalUntil via the tick.
    for (let i = 0; i < DISPATCHERS_CALL_EVAL_MIN * 10 + 2 && dc.status !== 'done'; i++) tick(w, 0.1);
    expect(dc.status).toBe('done');
    expect(dc.pts).toBe(2 * DISPATCHERS_CALL_PTS_PER_PALLET);
    expect(v.runPts - afterDeliveries).toBeCloseTo(dc.pts, 5);
    expect(v.runPts).toBeGreaterThan(before);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: dc.id, agreed: true, timedOut: false, onTime: 2, pts: 10 });
  });

  it('late deliveries pay nothing and the payout is capped', () => {
    const { w, v } = midRun(7005);
    const dc = offerDispatchersCall(w, v, { situation: realSituation(w), optionCount: 2, geminiIdx: 0 })!;
    const res = resolveDispatchersCallPick(w, v, dc.id, {
      optionIdx: 1,
      params: { sourceZone: 'general', targetBay: 'E1', priority: 'urgent', count: 8, mode: 'spawn_only' },
    });
    expect(res.ok && !res.agreed).toBe(true);
    const late = w.orders.find((o) => o.id === dc.orderIds[0])!;
    late.due = w.t - 1;
    for (const id of dc.orderIds) deliverNow(w, v, id);
    expect(dc.delivered).toBe(8);
    expect(dc.onTime).toBe(7);
    settleDispatchersCall(w, v);
    expect(dc.pts).toBe(DISPATCHERS_CALL_MAX_PTS);
  });

  it('no pick by the deadline: times out, nothing dispatched, no points', () => {
    const { w, v } = midRun(7006);
    const results = collect(w, 'dispatchers_call_result');
    const dc = offerDispatchersCall(w, v, { situation: realSituation(w), optionCount: 2, geminiIdx: 0 })!;
    for (let i = 0; i < DISPATCHERS_CALL_PICK_MIN * 10 + 2 && dc.status === 'offered'; i++) tick(w, 0.1);
    expect(dc.status).toBe('done');
    expect(dc.orderIds).toHaveLength(0);
    expect(dc.pts).toBe(0);
    expect(results[0]).toMatchObject({ timedOut: true, pts: 0 });
    expect(resolveDispatchersCallPick(w, v, dc.id, null)).toEqual({ ok: false, error: 'stale' });
    expect(w.orders.some((o) => o.dispatchCallId)).toBe(false); // nothing dispatched
  });

  it('run end scores an in-flight call before the run is recorded', () => {
    const { w, v } = midRun(7007, 170);
    // Window is closed at 170; open it artificially for this run-end check.
    v.runStartedAt = w.t - 100;
    const dc = offerDispatchersCall(w, v, { situation: realSituation(w), optionCount: 2, geminiIdx: 0 })!;
    resolveDispatchersCallPick(w, v, dc.id, {
      optionIdx: 0,
      params: { sourceZone: 'general', targetBay: 'E1', priority: 'urgent', count: 1, mode: 'spawn_only' },
    });
    deliverNow(w, v, dc.orderIds[0]);
    v.runEndsAt = Math.round((w.t + 0.1) * 10) / 10;
    expect(dc.evalUntil).toBeGreaterThan(v.runEndsAt);
    for (let i = 0; i < 5 && !v.runFinished; i++) tick(w, 0.1);
    expect(v.runFinished).toBe(true);
    expect(dc.status).toBe('done');
    expect(dc.pts).toBe(DISPATCHERS_CALL_PTS_PER_PALLET);
    const ptsAtEnd = v.runPts;
    const rec = w.completedRuns?.at(-1);
    expect(rec?.vehicleId).toBe(v.id);
    expect(rec!.pts).toBeCloseTo(Math.round(ptsAtEnd), 0);
  });

  it('rejects wrong ids, bad options and double picks', () => {
    const { w, v } = midRun(7008);
    const dc = offerDispatchersCall(w, v, { situation: realSituation(w), optionCount: 2, geminiIdx: 0 })!;
    const params = { sourceZone: 'general', targetBay: 'E1', count: 1 } as const;
    expect(resolveDispatchersCallPick(w, v, 'nope', { optionIdx: 0, params })).toEqual({
      ok: false,
      error: 'no_challenge',
    });
    expect(resolveDispatchersCallPick(w, v, dc.id, { optionIdx: 2, params })).toEqual({
      ok: false,
      error: 'bad_option',
    });
    expect(resolveDispatchersCallPick(w, v, dc.id, { optionIdx: 0, params }).ok).toBe(true);
    expect(resolveDispatchersCallPick(w, v, dc.id, { optionIdx: 0, params })).toEqual({
      ok: false,
      error: 'stale',
    });
  });

  it('offer validation, skip and reset on a new run', () => {
    const { w, v } = midRun(7009);
    const situation = realSituation(w);
    expect(offerDispatchersCall(w, v, { situation, optionCount: 1, geminiIdx: 0 })).toBeNull();
    expect(offerDispatchersCall(w, v, { situation, optionCount: 3, geminiIdx: 3 })).toBeNull();
    const skipped = skipDispatchersCall(w, v, 'model_error')!;
    expect(skipped.status).toBe('skipped');
    expect(dispatchersCallWindow(w, v)).toBe('ineligible');
    expect(offerDispatchersCall(w, v, { situation, optionCount: 2, geminiIdx: 0 })).toBeNull();
    setDriverRunMode(w, v, 'freerange');
    setDriverRunMode(w, v, 'blitz');
    expect(v.dispatchersCall).toBeNull();
  });
});
