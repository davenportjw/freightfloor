import { describe, expect, it } from 'vitest';
import {
  applyDecision,
  ContractOption,
  createWorld,
  deliver,
  guide,
  humanInteract,
  INBOUND_INTERVAL_MIN,
  postInbound,
  postOrder,
  PUTAWAY_VALUE,
  receiveTransfer,
  restore,
  serialize,
  spawnPlayerVehicle,
  tick,
  World,
  Order,
  Vehicle,
  XDOCK_AI_HOLD_MIN,
  XDOCK_BONUS,
  XDOCK_WINDOW_MIN,
} from '../src/index.js';

/** Drive pending Brain decisions through the real applyDecision API (first valid option). */
function drivePendingDecisions(w: World): void {
  const meta = { model: 'gemini-3.8-flash', latencyMs: 12, inputTokens: 64, outputTokens: 16 };
  for (const req of [...w.pendingDecisions]) {
    if (req.kind === 'contract' && req.options.length > 0) {
      applyDecision(w, req.id, { orderIds: [(req.options[0] as ContractOption).orderId], reason: 'first' }, meta);
    } else if (req.kind === 'hazard') {
      applyDecision(w, req.id, { choice: 'reroute', reason: 'reroute' }, meta);
    } else if (req.kind === 'tactics') {
      applyDecision(
        w,
        req.id,
        { speed: 1.15, buffer: 2, respect: 0.85, chargeAt: 25, batch: 2, reason: 'balanced' },
        meta,
      );
    } else if (req.kind === 'cards' && req.options.length > 0) {
      applyDecision(w, req.id, { keep: req.options.slice(0, 2).map((o) => o.id), reason: 'keep' }, meta);
    }
  }
}

/** Put a human vehicle on a tile carrying `o` (as if it had just picked it up). */
function carry(w: World, v: Vehicle, o: Order, x: number, y: number): void {
  v.px = x + 0.5;
  v.py = y + 0.5;
  v.tile = { x, y };
  v.speedNow = 0;
  o.claimant = v.id;
  o.state = 'picked';
  o.pickedAt = w.t;
  v.cargo.push(o);
}

describe('inbound receiving, putaway and cross-dock', () => {
  it('inbound trailers arrive on schedule at a west dock with a rack destination', () => {
    const w = createWorld({ seed: 4242 });
    expect(w.nextInboundAt).toBe(6);
    while (w.t < 6.05) tick(w);
    const inbound = w.orders.filter((o) => o.putaway);
    expect(inbound.length).toBe(1);
    const o = inbound[0];
    expect(w.map.westDocks.some((d) => o.slot.key === `2,${d.y}`)).toBe(true);
    expect(w.map.slots.some((s) => s.key === o.putaway!.key)).toBe(true);
    expect(o.value).toBe(PUTAWAY_VALUE);
    expect(o.xdockDue).toBeCloseTo(o.created + XDOCK_WINDOW_MIN, 5);
    expect(w.nextInboundAt).toBeGreaterThan(w.t);
    expect(w.nextInboundAt - w.t).toBeLessThanOrEqual(INBOUND_INTERVAL_MIN + 0.2);
    expect(w.events.some((e) => e.type === 'inbound')).toBe(true);
  });

  it('postOrder never picks a slot reserved as a pending putaway destination', () => {
    const w = createWorld({ seed: 5151 });
    const reserved = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const o = postInbound(w);
      if (o?.putaway) reserved.add(o.putaway.key);
    }
    expect(reserved.size).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) {
      const o = postOrder(w);
      if (o) expect(reserved.has(o.slot.key)).toBe(false);
    }
  });

  it('human stow at the rack pays the putaway fare and clears the order', () => {
    const w = createWorld({ seed: 6161 });
    const o = postInbound(w)!;
    const v = spawnPlayerVehicle(w, 'client-stow', 'Erin')!;
    carry(w, v, o, o.putaway!.ax, o.putaway!.ay);
    const g = guide(w, v)!;
    expect(g.kind).toBe('drop');
    expect((g as { stow?: boolean }).stow).toBe(true);
    const before = v.sPts;
    humanInteract(w, v.id);
    expect(v.cargo.includes(o)).toBe(false);
    expect(w.orders.includes(o)).toBe(false);
    expect(w.totals.putaways).toBe(1);
    expect(v.sPts).toBeGreaterThan(before);
    expect(w.events.some((e) => e.type === 'stow')).toBe(true);
  });

  it('human cross-dock inside the window pays value + bonus; after the window the bay refuses it', () => {
    const w = createWorld({ seed: 7171 });
    const v = spawnPlayerVehicle(w, 'client-xd', 'Finn')!;

    const fresh = postInbound(w)!;
    const bayCfg = w.map.bays.find((b) => b.id === fresh.xdockBay)!;
    const bt = bayCfg.tiles[0];
    carry(w, v, fresh, bt.x, bt.y);
    const before = v.sPts;
    humanInteract(w, v.id);
    expect(w.totals.crossDocks).toBe(1);
    expect(v.cargo.length).toBe(0);
    const ev = w.events.find((e) => e.type === 'xdock')!;
    expect(ev).toBeTruthy();
    expect(ev.bonus).toBe(XDOCK_BONUS);
    const fare = v.fareLog!.at(-1)!;
    expect(fare.orderId).toBe(fresh.id);
    expect(v.sPts - before).toBeGreaterThan(0);

    const stale = postInbound(w)!;
    const staleBay = w.map.bays.find((b) => b.id === stale.xdockBay)!.tiles[0];
    stale.xdockDue = w.t - 1; // window already closed
    carry(w, v, stale, staleBay.x, staleBay.y);
    humanInteract(w, v.id);
    expect(v.cargo.includes(stale)).toBe(true);
    expect(w.totals.crossDocks).toBe(1);
    expect(w.events.some((e) => e.type === 'hint' && /Cross-dock window closed/.test(e.text))).toBe(true);
  });

  it('AI vehicles cannot cross-dock an inbound pallet', () => {
    const w = createWorld({ seed: 8181 });
    const o = postInbound(w)!;
    const ai = w.vehicles.find((x) => !x.human)!;
    o.claimant = ai.id;
    o.state = 'picked';
    o.pickedAt = w.t;
    ai.cargo.push(o);
    expect(deliver(w, ai, o.xdockBay!)).toBe(0);
    expect(w.totals.crossDocks ?? 0).toBe(0);
  });

  it('AI leaves fresh inbound pallets alone during the hold, then picks and stows them', () => {
    const w = createWorld({ seed: 9191 });
    w.nextInboundAt = 1e9; // only the pallet posted below
    const o = postInbound(w)!;
    let firstClaimAt: number | null = null;
    for (let i = 0; i < 4000 && (w.totals.putaways ?? 0) === 0; i++) {
      tick(w);
      drivePendingDecisions(w);
      if (firstClaimAt == null && o.claimant) firstClaimAt = w.t;
    }
    expect(firstClaimAt).not.toBeNull();
    expect(firstClaimAt!).toBeGreaterThanOrEqual(o.created + XDOCK_AI_HOLD_MIN - 0.01);
    expect(w.totals.putaways).toBe(1);
    expect(w.orders.includes(o)).toBe(false);
    expect(w.events.some((e) => e.type === 'stow' && e.orderId === o.id)).toBe(true);
  });

  it('serialize/restore keeps nextInboundAt and putaway fields', () => {
    const w = createWorld({ seed: 1212 });
    const o = postInbound(w)!;
    w.nextInboundAt = 77;
    const r = restore(serialize(w));
    expect(r.nextInboundAt).toBe(77);
    const ro = r.orders.find((x) => x.id === o.id)!;
    expect(ro.slot.key).toBe(o.slot.key);
    expect(ro.putaway?.key).toBe(o.putaway!.key);
    expect(ro.xdockBay).toBe(o.xdockBay);
    expect(ro.xdockDue).toBe(o.xdockDue);
  });

  it('network transfers land as putaway orders worth 8 + 5', () => {
    const w = createWorld({ seed: 1313 });
    const o = receiveTransfer(w, {
      id: 'xfer-den-1-1',
      fromSite: 'den-1',
      toSite: w.siteId,
      orderRef: 1,
      sku: 'SKU-TEST',
      value: 10,
      shippedAt: 0,
      carrier: 'FL-01',
    })!;
    expect(o.value).toBe(PUTAWAY_VALUE + 5);
    expect(o.putaway).toBeTruthy();
    expect(o.fromSite).toBe('den-1');
  });
});
