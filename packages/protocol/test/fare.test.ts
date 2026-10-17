import { describe, expect, it } from 'vitest';
import {
  CARD_TYPES,
  CardHandSchema,
  CardSchema,
  QuantisedVehicleDeltaSchema,
} from '../src/index.js';

describe('@warehouse/protocol fare & card schemas (Phases 1-2)', () => {
  it('CardSchema accepts rarity, humanOnly, perk and completedAt; rejects unknown rarity', () => {
    const card = {
      id: 'c7',
      type: 'crazy_stop' as const,
      goal: 3,
      progress: 1,
      status: 'active' as const,
      pts: 15,
      title: 'Crazy Stop',
      desc: 'Brake hard…',
      rarity: 'common' as const,
      humanOnly: true,
      perk: { forkLiftMul: 1.5 },
      modifiers: { forkLiftMul: 1.5 },
    };
    expect(CardSchema.parse(card)).toEqual(card);
    expect(CardSchema.parse({ ...card, type: 'double_nothing', rarity: 'wild', perk: {} }).rarity).toBe(
      'wild',
    );
    expect(CardSchema.safeParse({ ...card, rarity: 'legendary' }).success).toBe(false);
    expect(CardSchema.parse({ ...card, status: 'done', completedAt: 12.5 }).completedAt).toBe(12.5);
  });

  it('CARD_TYPES lists all 21 sim card types', () => {
    expect(CARD_TYPES).toHaveLength(21);
    for (const t of ['trailer_closer', 'crazy_stop', 'combo_king', 'beat_planner', 'last_call']) {
      expect(CARD_TYPES).toContain(t);
    }
  });

  it('CardHandSchema carries the replacement-draw pick limit', () => {
    const hand = { shift: 0, offer: [], cards: [], pick: 1 };
    expect(CardHandSchema.parse(hand).pick).toBe(1);
    expect(CardHandSchema.safeParse({ ...hand, pick: 0 }).success).toBe(false);
  });

  it('QuantisedVehicleDeltaSchema carries combo, comboBest, fareTrips, speedyTrips', () => {
    const delta = { id: 'p1', combo: 1.5, comboBest: 2, fareTrips: 7, speedyTrips: 3 };
    expect(QuantisedVehicleDeltaSchema.parse(delta)).toEqual(delta);
    expect(QuantisedVehicleDeltaSchema.safeParse({ id: 'p1', fareTrips: -1 }).success).toBe(false);
    expect(QuantisedVehicleDeltaSchema.safeParse({ id: 'p1', speedyTrips: 1.5 }).success).toBe(false);
  });
});
