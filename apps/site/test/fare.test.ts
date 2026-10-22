import { describe, expect, it } from 'vitest';
import { QuantisedVehicleDeltaSchema } from '@warehouse/protocol';
import {
  createWorld,
  dealShiftCards,
  deliver,
  guide,
  postInbound,
  postOrder,
  spawnPlayerVehicle,
  type CardOption,
} from '@warehouse/sim';
import { fareStats, guideExtras, HUMAN_ONLY_CARD_TYPES, renderDecisionPrompt, vehicleDetail } from '../src/index.js';

describe('site: fare & card wiring (Phases 1-2)', () => {
  it('AI card prompt hides humanOnly cards and shows rarity/perk', () => {
    expect([...HUMAN_ONLY_CARD_TYPES].sort()).toEqual([
      'beat_planner',
      'combo_king',
      'crazy_stop',
      'ghost_hunter',
      'poacher',
      'rival_grudge',
    ]);
    const world = createWorld({ seed: 8101, agents: 3 });
    const [req] = dealShiftCards(world);
    expect(req).toBeDefined();
    const opts = req.options as CardOption[];
    expect(opts.some((o) => HUMAN_ONLY_CARD_TYPES.has(o.cardType))).toBe(false);
    // A restored/legacy request that somehow carries a humanOnly option must not reach the model.
    opts.push({ ...opts[0], id: 'human-only-x', cardType: 'crazy_stop', title: 'Crazy Stop' });
    const { prompt } = renderDecisionPrompt(world, req);
    expect(prompt).not.toContain('human-only-x');
    expect(prompt).toContain('rarity=');
    expect(prompt).toContain('at most one wild');
    for (const o of opts.slice(0, -1)) expect(prompt).toContain(`id="${o.id}"`);
  });

  it('vehicle deltas carry combo, comboBest, fareTrips and speedyTrips', () => {
    const world = createWorld({ seed: 8102, agents: 0 });
    const v = spawnPlayerVehicle(world, 'fare-wire', 'Wire', 'blitz')!;
    world.cards['fare-wire']!.cards = [];
    world.cards['fare-wire']!.offer = null;
    world.bays.forEach((b) => (b.load = 0));
    const o = postOrder(world, { bayId: 'E1', force: true })!;
    o.state = 'picked';
    o.claimant = v.id;
    o.pickedAt = world.t - 1;
    o.parLoaded = 10;
    o.due = world.t + 50;
    v.cargo = [o];
    deliver(world, v, 'E1');

    const stats = fareStats(v);
    expect(stats).toEqual({ combo: 1.2, comboBest: 1.2, fareTrips: 1, speedyTrips: 1 });
    const detail = vehicleDetail(v);
    expect(detail).toMatchObject(stats);
    expect(QuantisedVehicleDeltaSchema.parse({ id: v.id, ...stats })).toMatchObject(stats);
  });
});

describe('site guide wire extras (inbound putaway)', () => {
  it('forwards stow + open cross-dock alt for a carried inbound pallet, nothing for outbound', () => {
    const w = createWorld({ seed: 3131 });
    const v = spawnPlayerVehicle(w, 'client-guide', 'Gail')!;
    const o = postInbound(w)!;
    o.claimant = v.id;
    o.state = 'picked';
    o.pickedAt = w.t;
    v.cargo.push(o);
    const extras = guideExtras(guide(w, v)!);
    expect(extras.stow).toBe(true);
    expect(extras.alt?.bay).toBe(o.xdockBay);
    expect(extras.alt?.left).toBeGreaterThan(0);
    o.xdockDue = w.t - 1;
    expect(guideExtras(guide(w, v)!)).toEqual({ stow: true });
    v.cargo.length = 0;
    expect(guideExtras(guide(w, v) ?? {})).toEqual({});
  });
});
