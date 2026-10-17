import { describe, expect, it } from 'vitest';
import {
  applyAgentDirective,
  createWorld,
  isAutopilotDriven,
  isManualHuman,
  postOrder,
  release,
  scoreOrder,
  serialize,
  restore,
  setVehicleAutopilot,
  takeWheel,
  tick,
} from '../src/index.js';

describe('Co-Pilot & Agent Designer (Phase 1 @warehouse/sim)', () => {
  it('toggles Co-Pilot autopilot on a human-claimed vehicle and resets on release', () => {
    const w = createWorld({ seed: 101, agents: 4 });
    const err = takeWheel(w, 'client-alice', 'alice', 'FL-01');
    expect(err).toBeNull();
    const v = w.vehicles.find((x) => x.id === 'FL-01')!;
    expect(v.human).toBe(true);
    expect(v.autopilot).toBe(false);
    expect(isManualHuman(v)).toBe(true);
    expect(isAutopilotDriven(v)).toBe(false);

    const enabled = setVehicleAutopilot(w, 'FL-01', true, 'Co-Pilot engaged');
    expect(enabled).toBe(true);
    expect(v.autopilot).toBe(true);
    expect(v.humanCharging).toBe(false);
    expect(isManualHuman(v)).toBe(false);
    expect(isAutopilotDriven(v)).toBe(true);

    const disabled = setVehicleAutopilot(w, v, false, 'Manual override');
    expect(disabled).toBe(true);
    expect(v.autopilot).toBe(false);
    expect(v.path).toEqual([]);
    expect(isManualHuman(v)).toBe(true);

    // Re-enable then release -> resets autopilot & directive
    setVehicleAutopilot(w, v, true);
    applyAgentDirective(w, v, { priority: 'p0_first', preferredZones: ['U'] });
    release(w, 'FL-01');
    expect(v.human).toBe(false);
    expect(v.autopilot).toBe(false);
    expect(v.directive).toBeNull();
  });

  it('applies AgentDirective with strategy, clamped tactics, zones, bays, and immediate tasks', () => {
    const w = createWorld({ seed: 202, agents: 4 });
    expect(takeWheel(w, 'client-bob', 'bob', 'FL-02')).toBeNull();
    const v = w.vehicles.find((x) => x.id === 'FL-02')!;

    // Apply directive with strategy + tactics out-of-bounds to verify clamping
    const applied = applyAgentDirective(w, v, {
      strategy: 'Opportunist',
      priority: 'p0_first',
      preferredZones: ['U', 'Z'],
      preferredBays: ['E1'],
      avoidZones: ['X'],
      tactics: {
        speed: 9.9,
        chargeAt: 5,
        batch: 9,
        poach: true,
        buffer: 10,
        respect: 0.1,
      },
      immediateTask: { kind: 'charge' },
      summary: 'Top off battery & prioritize P0s',
    });

    expect(applied).not.toBeNull();
    expect(v.autopilot).toBe(true);
    expect(v.strategy).toBe('Opportunist');
    expect(v.tactics.speed).toBe(1.4);
    expect(v.tactics.chargeAt).toBe(8);
    expect(v.tactics.batch).toBe(3);
    expect(v.tactics.poach).toBe(true);
    expect(v.tactics.buffer).toBe(4);
    expect(v.tactics.respect).toBe(0.3);
    expect(v.directive?.priority).toBe('p0_first');
    expect(v.directive?.preferredZones).toEqual(['U', 'Z']);
    expect(v.directive?.preferredBays).toEqual(['E1']);
    expect(v.directive?.avoidZones).toEqual(['X']);
    expect(v.state).toBe('toCharge');
    expect(v.target?.kind).toBe('charge');

    // Immediate task: zone
    const oU = postOrder(w, { zone: 'U', bayId: 'E2', p0: true, force: true })!;
    applyAgentDirective(w, v, {
      immediateTask: { kind: 'zone', zone: 'U' },
      summary: 'Head to Zone U',
    });
    expect(v.orders.some((o) => o.id === oU.id)).toBe(true);
    expect(v.state).toBe('toPick');

    // Immediate task: bay
    const oE1 = postOrder(w, { zone: 'A', bayId: 'E1', force: true })!;
    applyAgentDirective(w, v, {
      immediateTask: { kind: 'bay', bay: 'E1' },
      summary: 'Head to Bay E1',
    });
    expect(v.orders.some((o) => o.id === oE1.id)).toBe(true);
    expect(v.target?.x).toBeDefined();
  });

  it('scores orders according to priority, preferredZones, preferredBays, and avoidZones', () => {
    const w = createWorld({ seed: 303, agents: 2 });
    expect(takeWheel(w, 'client-carol', 'carol', 'FL-01')).toBeNull();
    const v = w.vehicles.find((x) => x.id === 'FL-01')!;
    const oGen = postOrder(w, { zone: 'A', bayId: 'E1', force: true })!;
    const oHigh = postOrder(w, { zone: 'U', bayId: 'E4', p0: true, force: true })!;
    const oAvoid = postOrder(w, { zone: 'X', bayId: 'E6', force: true })!;

    applyAgentDirective(w, v, {
      priority: 'p0_first',
      preferredZones: ['U'],
      preferredBays: ['E4'],
      avoidZones: ['X'],
    });

    const scGen = scoreOrder(w, v, oGen);
    const scHigh = scoreOrder(w, v, oHigh);
    const scAvoid = scoreOrder(w, v, oAvoid);

    expect(scHigh).toBeGreaterThan(scGen);
    expect(scGen).toBeGreaterThan(scAvoid);
  });

  it('drives autonomously in Co-Pilot mode, picks and delivers orders, and credits human player score', () => {
    const w = createWorld({ seed: 404, agents: 2 });
    expect(takeWheel(w, 'client-dave', 'dave', 'FL-01')).toBeNull();
    const v = w.vehicles.find((x) => x.id === 'FL-01')!;
    const order = postOrder(w, { zone: 'A', bayId: 'E1', p0: true, force: true })!;

    applyAgentDirective(w, v, {
      strategy: 'Sprinter',
      priority: 'p0_first',
      immediateTask: { kind: 'order', orderId: order.id },
      summary: `Pick #${order.id}`,
    });

    expect(v.autopilot).toBe(true);
    expect(v.orders.map((o) => o.id)).toContain(order.id);

    // Run ticks until the Co-Pilot vehicle completes the delivery
    for (let i = 0; i < 600; i++) {
      tick(w, 0.1);
      if (v.sShipped >= 1) break;
    }

    expect(v.sShipped).toBeGreaterThanOrEqual(1);
    expect(v.sPts).toBeGreaterThan(0);
    expect(w.shift.byStrat.Human.shipped).toBeGreaterThanOrEqual(1);
    expect(w.deliveries.some((d) => d.vid === 'FL-01' && d.strat === 'Human')).toBe(true);
  });

  it('preserves autopilot and directive across serialize() and restore()', () => {
    const w = createWorld({ seed: 505, agents: 3 });
    expect(takeWheel(w, 'client-erin', 'erin', 'FL-01')).toBeNull();
    const v = w.vehicles.find((x) => x.id === 'FL-01')!;
    applyAgentDirective(w, v, {
      strategy: 'Strategist',
      priority: 'high_value',
      preferredZones: ['W', 'U'],
      preferredBays: ['E2'],
      avoidZones: ['Z'],
      tactics: { speed: 1.2, poach: true },
    });

    const snap = serialize(w);
    const w2 = restore(snap);
    const v2 = w2.vehicles.find((x) => x.id === 'FL-01')!;
    expect(v2.human).toBe(true);
    expect(v2.autopilot).toBe(true);
    expect(v2.directive?.strategy).toBe('Strategist');
    expect(v2.directive?.priority).toBe('high_value');
    expect(v2.directive?.preferredZones).toEqual(['W', 'U']);
    expect(v2.directive?.preferredBays).toEqual(['E2']);
    expect(v2.directive?.avoidZones).toEqual(['Z']);
    expect(v2.tactics.speed).toBe(1.2);
  });
});
