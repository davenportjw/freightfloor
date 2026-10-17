/**
 * Phase 1-2 client: guide-arrow colours, event callouts, combo meter, run-end fare stats and
 * card perk / pick-1-of-2 helpers. Pure functions only (no DOM / canvas).
 */
import { describe, expect, it } from 'vitest';
import type { Card, SimEvent } from '@warehouse/sim';
import { arrowColor, calloutFor, FX_COLORS, guideUrgency } from '../src/render/fx.js';
import { comboMeter } from '../src/ui/commandBar.js';
import { runEndFareStats } from '../src/ui/runEnd.js';
import { canKeep, dealTitle, keepIds, perkText, toggleOfferSel } from '../src/ui/cards.js';

const ev = (type: string, extra: Record<string, unknown>): SimEvent => ({ t: 10, type, text: type, ...extra });

describe('fx.arrowColor', () => {
  it('colours by kind', () => {
    expect(arrowColor('pick')).toBe(FX_COLORS.pick);
    expect(arrowColor('drop')).toBe(FX_COLORS.drop);
    expect(arrowColor('charge')).toBe(FX_COLORS.charge);
    expect(arrowColor('wait')).toBe(FX_COLORS.wait);
  });
  it('P0 is gold, < 15 min left is red and beats gold', () => {
    expect(arrowColor('pick', { p0: true })).toBe(FX_COLORS.p0);
    expect(arrowColor('drop', { p0: true, minutesLeft: 40 })).toBe(FX_COLORS.p0);
    expect(arrowColor('drop', { p0: true, minutesLeft: 14.9 })).toBe(FX_COLORS.late);
    expect(arrowColor('pick', { minutesLeft: 3 })).toBe(FX_COLORS.late);
    expect(arrowColor('pick', { minutesLeft: 15 })).toBe(FX_COLORS.pick);
    expect(arrowColor('pick', { minutesLeft: null })).toBe(FX_COLORS.pick);
  });
  it('charge / wait ignore urgency', () => {
    expect(arrowColor('charge', { p0: true, minutesLeft: 1 })).toBe(FX_COLORS.charge);
    expect(arrowColor('wait', { p0: true, minutesLeft: 1 })).toBe(FX_COLORS.wait);
  });
});

describe('fx.guideUrgency', () => {
  const o = (id: number, p0: boolean, due: number, bay: string, ax = 0, ay = 0) => ({ id, p0, due, bay, slot: { ax, ay } });
  it('pick resolves the pallet at the target slot', () => {
    const orders = [o(1, false, 100, 'B1', 3, 4), o(2, true, 50, 'B2', 7, 8)];
    expect(guideUrgency({ kind: 'pick', x: 7, y: 8 }, 40, orders, [])).toEqual({ p0: true, minutesLeft: 10 });
    expect(guideUrgency({ kind: 'pick', x: 9, y: 9 }, 40, orders, [])).toEqual({ p0: false, minutesLeft: null });
  });
  it('drop uses the most urgent carried pallet for the bay', () => {
    const cargo = [o(1, false, 90, 'B1'), o(2, false, 60, 'B1'), o(3, true, 20, 'B2')];
    expect(guideUrgency({ kind: 'drop', x: 0, y: 0 }, 10, [], cargo, 'B1')).toEqual({ p0: false, minutesLeft: 50 });
    expect(guideUrgency({ kind: 'charge', x: 0, y: 0 }, 10, [], cargo)).toEqual({ p0: false, minutesLeft: null });
  });
});

describe('fx.calloutFor', () => {
  it('fare ratings with combo', () => {
    expect(calloutFor(ev('fare', { vid: 'F1', rating: 'speedy', pts: 27.6, combo: 1.5 }), 'F1')).toEqual({
      text: '+28 SPEEDY ×1.5',
      tone: 'good',
    });
    expect(calloutFor(ev('fare', { vid: 'F1', rating: 'normal', pts: 20, combo: 1 }), 'F1')).toEqual({
      text: '+20 NORMAL',
      tone: 'info',
    });
    expect(calloutFor(ev('fare', { vid: 'F1', rating: 'slow', pts: 10, combo: 1 }), 'F1')).toEqual({
      text: '+10 SLOW',
      tone: 'bad',
    });
    expect(calloutFor(ev('fare', { vid: 'F1', rating: 'speedy', pts: 40, combo: 2 }), 'F1')?.text).toBe('+40 SPEEDY ×2.0');
  });
  it('combo reset, trailer closer, crazy stop', () => {
    expect(calloutFor(ev('combo_reset', { vid: 'F1', reason: 'crash', combo: 1 }), 'F1')).toEqual({
      text: 'COMBO RESET · CRASH',
      tone: 'bad',
    });
    expect(calloutFor(ev('combo_reset', { vid: 'F1', reason: 'drop', combo: 1 }), 'F1')?.text).toBe(
      'COMBO RESET · PALLET DROPPED',
    );
    expect(calloutFor(ev('trailer_closer', { vid: 'F1', bay: 'B2', pts: 5, combo: 1.2 }), 'F1')).toEqual({
      text: 'TRAILER CLOSED +5',
      tone: 'good',
    });
    expect(calloutFor(ev('precision_stop', { vid: 'F1' }), 'F1')).toEqual({ text: 'CRAZY STOP!', tone: 'good' });
  });
  it('ignores other vehicles and unrelated events', () => {
    expect(calloutFor(ev('fare', { vid: 'F2', rating: 'speedy', pts: 30, combo: 1 }), 'F1')).toBeNull();
    expect(calloutFor(ev('precision_stop', { vid: 'F2' }), 'F1')).toBeNull();
    expect(calloutFor(ev('pick', { vid: 'F1' }), 'F1')).toBeNull();
    expect(calloutFor(ev('fare', { vid: 'F1', rating: 'speedy', pts: 30, combo: 1 }), null)).toBeNull();
  });
  it('card poach: owner (by hand key) is told, thief is told, bystanders are not', () => {
    const poach = ev('poach', { vid: 'F7', owner: 'client-me', cardId: 'c1', orderId: 9 });
    expect(calloutFor(poach, 'F1', 'client-me')).toEqual({ text: 'CONTRACT POACHED!', tone: 'bad' });
    expect(calloutFor(poach, 'F7', 'client-thief')).toEqual({ text: 'CONTRACT STOLEN!', tone: 'good' });
    expect(calloutFor(poach, 'F3', 'client-other')).toBeNull();
    // legacy poach (no cardId) has no callout
    expect(calloutFor(ev('poach', { vid: 'F1' }), 'F1')).toBeNull();
  });
});

describe('combo meter', () => {
  it('labels and pips', () => {
    const m1 = comboMeter(undefined);
    expect(m1.label).toBe('COMBO ×1.0');
    expect(m1.pips.map((p) => p.on)).toEqual([true, false, false, false]);
    expect(m1.max).toBe(false);
    const m15 = comboMeter(1.5);
    expect(m15.label).toBe('COMBO ×1.5');
    expect(m15.pips.map((p) => p.on)).toEqual([true, true, true, false]);
    const m2 = comboMeter(2);
    expect(m2.label).toBe('COMBO ×2.0');
    expect(m2.pips.every((p) => p.on)).toBe(true);
    expect(m2.max).toBe(true);
  });
});

describe('run-end fare stats', () => {
  it('best combo, speedy %, cards completed', () => {
    expect(runEndFareStats({ comboBest: 2, fareTrips: 8, speedyTrips: 6, cardsDone: 2 })).toEqual([
      { label: 'Best Combo', value: '×2.0', tone: 'accent' },
      { label: 'Speedy Trips', value: '75% (6/8)', tone: 'good' },
      { label: 'Cards Completed', value: '2', tone: 'good' },
    ]);
  });
  it('dash when no rated trips', () => {
    const s = runEndFareStats({});
    expect(s[0].value).toBe('×1.0');
    expect(s[1].value).toBe('—');
    expect(s[2].value).toBe('0');
  });
});

describe('cards: perks and pick 1 of 2', () => {
  const card = (id: string, extra: Partial<Card> = {}): Card => ({
    id,
    type: 'quick',
    goal: 3,
    progress: 0,
    status: 'offer',
    pts: 20,
    title: id,
    desc: `${id} desc`,
    ...extra,
  });

  it('perkText renders perk keys', () => {
    expect(perkText(card('a', { perk: { speedMul: 1.08 } }))).toBe('Perk: +8% speed');
    expect(perkText(card('b', { perk: { batteryDrainMul: 0.85, reachBonus: 0.2 } }))).toBe(
      'Perk: −15% battery drain · +0.2 tile reach',
    );
    expect(perkText(card('c', { perk: { forkLiftMul: 1.3 } }))).toBe('Perk: +30% fork speed');
    expect(perkText(card('d', { perk: { comboFloor: 1 } }))).toBe('Perk: combo resets only to ×1.2');
    expect(perkText(card('e'))).toBeNull();
  });

  it('pick 1 of 2: selecting replaces, keep needs exactly one', () => {
    const offer = [card('x'), card('y')];
    let sel = toggleOfferSel(new Set(['x']), 'y', 1);
    expect([...sel]).toEqual(['y']);
    expect(keepIds(offer, sel)).toEqual(['y']);
    expect(canKeep(1, 1)).toBe(true);
    expect(canKeep(2, 1)).toBe(false);
    expect(canKeep(0, 1)).toBe(false);
    sel = toggleOfferSel(sel, 'y', 1);
    expect(sel.size).toBe(0);
    expect(dealTitle(offer, 1)).toBe('Pick 1 of 2');
    expect(dealTitle([...offer, card('z')], null)).toBe('New contracts');
  });

  it('without a pick limit the selection stays multi-select', () => {
    const sel = toggleOfferSel(toggleOfferSel(new Set(['a']), 'b'), 'c');
    expect([...sel].sort()).toEqual(['a', 'b', 'c']);
    expect(canKeep(3, null)).toBe(true);
  });
});
