import { describe, expect, it } from 'vitest';
import {
  CARD_TYPES,
  CardHandSchema,
  CardSchema,
  ClientMessageSchema,
  FareOfferSchema,
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

describe('@warehouse/protocol order choice & rival (Phase 3)', () => {
  const offer = {
    since: 12.3,
    copilotId: 42,
    reason: 'Recommended #42: 6 tiles closer than #17, P0 +20.',
    carpool: false,
    options: [
      { orderId: 42, farClass: 'long' as const, carpool: false, p0: true, bay: 'E2', value: 40, tiles: 9, parEmpty: 3.2, parLoaded: 15.1 },
      { orderId: 17, farClass: 'short' as const, carpool: false, p0: false, bay: 'E1', value: 20, tiles: 15, parEmpty: 5, parLoaded: null },
    ],
  };

  it('chooseOrder parses; rejects missing, negative and fractional order ids', () => {
    expect(ClientMessageSchema.parse({ type: 'chooseOrder', orderId: 7 })).toEqual({ type: 'chooseOrder', orderId: 7 });
    expect(ClientMessageSchema.safeParse({ type: 'chooseOrder' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'chooseOrder', orderId: -1 }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'chooseOrder', orderId: 1.5 }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'chooseOrder', orderId: '7' }).success).toBe(false);
  });

  it('vehicle deltas carry fareOffer and rivalId, and stay backward compatible', () => {
    const delta = { id: 'p1', fareOffer: offer, rivalId: 'FL-03' };
    expect(QuantisedVehicleDeltaSchema.parse(delta)).toEqual(delta);
    expect(QuantisedVehicleDeltaSchema.parse({ id: 'p1', fareOffer: null, rivalId: null })).toEqual({
      id: 'p1',
      fareOffer: null,
      rivalId: null,
    });
    expect(QuantisedVehicleDeltaSchema.parse({ id: 'p1' })).toEqual({ id: 'p1' });
  });

  it('FareOfferSchema rejects unknown classes and more than 3 options', () => {
    expect(FareOfferSchema.safeParse({ ...offer, options: [{ ...offer.options[0], farClass: 'teleport' }] }).success).toBe(false);
    expect(FareOfferSchema.safeParse({ ...offer, options: [...offer.options, ...offer.options] }).success).toBe(false);
  });

  it('FareOfferSchema keeps inbound putaway and cross-dock fields', () => {
    const inbound = {
      ...offer,
      options: [
        { ...offer.options[0], putaway: true, putawayRack: 'R12', xdockBay: 'E2', xdockLeft: 30 },
        { ...offer.options[1], putaway: true, putawayRack: 'R03', xdockBay: 'E1', xdockLeft: null },
      ],
    };
    expect(FareOfferSchema.parse(inbound)).toEqual(inbound);
    expect(FareOfferSchema.safeParse({ ...offer, options: [{ ...offer.options[0], putaway: 'yes' }] }).success).toBe(false);
  });

  it('CardSchema keeps the Rival Grudge window', () => {
    const card = {
      id: 'rg', type: 'rival_grudge' as const, goal: 1, progress: 0, status: 'active' as const, pts: 30,
      title: 'Rival Grudge', desc: '', rarity: 'wild' as const, until: 190, rivalBase: { rivalId: 'FL-03', self: 2, rival: 4 },
    };
    expect(CardSchema.parse(card)).toEqual(card);
  });
});
