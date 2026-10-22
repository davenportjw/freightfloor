/**
 * Order choice (fare offer) view models, ghost planner helpers, rival callouts / bubbles and the
 * Q / F / 4 hotkeys. Pure functions plus a light GhostPlanner run on a real sim world.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type Card, type FareOffer, type SimEvent } from '@warehouse/sim';
import {
  countdownText,
  cycleIndex,
  clampIndex,
  FARE_CLASS_COLORS,
  fareOfferKey,
  optionPills,
  rivalDraftText,
  rivalPillText,
  secondsLeft,
} from '../src/ui/fareChoice.js';
import { GhostPlanner, ghostPolyline, ghostTarget } from '../src/render/ghost.js';
import { calloutFor, rivalBubbleFor, wrapBubbleText } from '../src/render/fx.js';
import { resolveHotkey, type HotkeyContext } from '../src/ui/hotkeys.js';

const offer = (extra: Partial<FareOffer> = {}): FareOffer => ({
  since: 100,
  copilotId: 7,
  reason: 'closest pickup, P0 due soon',
  carpool: false,
  options: [
    { orderId: 7, farClass: 'short', carpool: false, p0: true, bay: 'E2', value: 41.6, tiles: 9, parEmpty: 4.2, parLoaded: 11 },
    { orderId: 12, farClass: 'long', carpool: false, p0: false, bay: 'W1', value: 80, tiles: 30, parEmpty: null, parLoaded: 25.5 },
    { orderId: 3, farClass: 'contract', carpool: false, p0: false, bay: 'N4', value: 55, tiles: 14, parEmpty: 6, parLoaded: null },
  ],
  ...extra,
});

const ev = (type: string, extra: Record<string, unknown>): SimEvent => ({ t: 10, type, text: type, ...extra });

describe('fareChoice.optionPills', () => {
  it('labels inbound putaway options with the rack and an open cross-dock window', () => {
    const pills = optionPills(
      offer({
        options: [
          { orderId: 21, farClass: 'cross', carpool: false, p0: false, bay: 'E3', value: 8, tiles: 12, parEmpty: 5, parLoaded: 9, putaway: true, putawayRack: 'R12', xdockBay: 'E3', xdockLeft: 31 },
          { orderId: 22, farClass: 'short', carpool: false, p0: false, bay: 'E1', value: 13, tiles: 4, parEmpty: 2, parLoaded: 6, putaway: true, putawayRack: 'R04', xdockBay: 'E1', xdockLeft: null },
        ],
        copilotId: 21,
      }),
      0,
    );
    expect(pills[0].label).toBe('Inbound #21 → R12 · ⇄ E3 +10 · 31s');
    expect(pills[0].title).toContain('rack R12');
    expect(pills[0].title).toContain('cross-dock to bay E3 within 31s for +10');
    expect(pills[1].label).toBe('Inbound #22 → R04');
    expect(pills[1].title).not.toContain('cross-dock');
  });
  it('builds labelled, coloured pills with the Co-Pilot star and par text', () => {
    const pills = optionPills(offer(), 0);
    expect(pills).toHaveLength(3);
    expect(pills[0]).toMatchObject({
      orderId: 7,
      label: '#7 → E2',
      classColor: FARE_CLASS_COLORS.short,
      classLabel: 'Short hop',
      valueText: '42 pts',
      parText: 'par 4s + 11s',
      tilesText: '9 tiles',
      isCopilot: true,
      p0: true,
      highlighted: true,
    });
    expect(pills[0].title).toContain('★ Co-Pilot pick');
    expect(pills[1].parText).toBe('par — + 26s');
    expect(pills[2].parText).toBe('par 6s + —');
    expect(pills[1].classColor).toBe(FARE_CLASS_COLORS.long);
    expect(pills[2].classColor).toBe(FARE_CLASS_COLORS.contract);
    expect(pills[1].isCopilot).toBe(false);
  });
  it('clamps the highlighted index into range', () => {
    expect(optionPills(offer(), 9).map((p) => p.highlighted)).toEqual([false, false, true]);
    expect(optionPills(offer(), -2).map((p) => p.highlighted)).toEqual([true, false, false]);
    expect(optionPills(null, 0)).toEqual([]);
  });
});

describe('fareChoice index / countdown / key', () => {
  it('cycleIndex wraps and handles empty', () => {
    expect(cycleIndex(0, 3)).toBe(1);
    expect(cycleIndex(2, 3)).toBe(0);
    expect(cycleIndex(5, 0)).toBe(0);
    expect(clampIndex(4, 2)).toBe(1);
  });
  it('secondsLeft / countdownText mirror the timeout', () => {
    expect(secondsLeft({ since: 100 }, 101.2, 8)).toBe(7);
    expect(secondsLeft({ since: 100 }, 200, 8)).toBe(0);
    const s = secondsLeft({ since: 100 }, 101);
    expect(countdownText({ since: 100, carpool: false }, 101)).toBe(`Co-Pilot picks in ${s}s`);
    expect(countdownText({ since: 100, carpool: true }, 101)).toBe(`Carpool lapses in ${s}s`);
  });
  it('fareOfferKey identifies an offer', () => {
    expect(fareOfferKey(offer())).toBe('100|0|7,12,3');
    expect(fareOfferKey(offer({ carpool: true }))).toBe('100|1|7,12,3');
    expect(fareOfferKey(offer({ options: [] }))).toBeNull();
    expect(fareOfferKey(null)).toBeNull();
  });
});

describe('ghost helpers', () => {
  it('ghostPolyline starts at the pose and threads cell centres', () => {
    expect(ghostPolyline({ x: 1.2, y: 2.7 }, null)).toEqual([]);
    expect(ghostPolyline({ x: 1.2, y: 2.7 }, [])).toEqual([]);
    expect(ghostPolyline({ x: 1.2, y: 2.7 }, [{ x: 2, y: 2 }, { x: 3, y: 2 }])).toEqual([
      { x: 1.2, y: 2.7 },
      { x: 2.5, y: 2.5 },
      { x: 3.5, y: 2.5 },
    ]);
  });
  it('ghostTarget prefers the highlighted option, else the guide', () => {
    const orders = [
      { id: 7, slot: { ax: 4, ay: 5 } },
      { id: 12, slot: { ax: 9, ay: 1 } },
    ];
    const guide = { kind: 'drop', x: 20, y: 3 };
    expect(ghostTarget(offer(), 0, orders, guide)).toEqual({ x: 4, y: 5, orderId: 7 });
    expect(ghostTarget(offer(), 1, orders, guide)).toEqual({ x: 9, y: 1, orderId: 12 });
    expect(ghostTarget(offer(), 2, orders, guide)).toBeNull();
    expect(ghostTarget(null, 0, orders, guide)).toEqual({ x: 20, y: 3, orderId: null });
    expect(ghostTarget(null, 0, orders, { kind: 'charge', x: 1, y: 1 })).toBeNull();
    expect(ghostTarget(null, 0, orders, null)).toBeNull();
  });
  it('GhostPlanner memoises the sim planner per start/target', () => {
    const world = createWorld({ seed: 1 });
    const [a, b] = world.vehicles;
    expect(a && b).toBeTruthy();
    const planner = new GhostPlanner();
    const target = { x: b.tile.x, y: b.tile.y, orderId: null };
    const p1 = planner.plan(world, a.tile.x, a.tile.y, target, 1);
    const p2 = planner.plan(world, a.tile.x, a.tile.y, target, 1);
    expect(p2).toBe(p1);
    expect(planner.plan(world, a.tile.x, a.tile.y, null, 1)).toBeNull();
    expect(planner.plan(world, -5, -5, target, 1)).toBeNull();
  });
});

describe('fx: fare choice + rival callouts and bubbles', () => {
  it('fare_choice callouts', () => {
    expect(calloutFor(ev('fare_choice', { vid: 'FL-01', orderId: 7, auto: true }), 'FL-01')).toEqual({ text: 'CO-PILOT PICKED #7', tone: 'info' });
    expect(calloutFor(ev('fare_choice', { vid: 'FL-01', orderId: 7 }), 'FL-01')).toEqual({ text: 'RESERVED #7', tone: 'good' });
    expect(calloutFor(ev('fare_choice', { vid: 'FL-01', orderId: 9, carpool: true }), 'FL-01')).toEqual({ text: 'CARPOOL #9', tone: 'good' });
    expect(calloutFor(ev('fare_choice', { vid: 'FL-02', orderId: 7 }), 'FL-01')).toBeNull();
  });
  it('rival callouts', () => {
    expect(calloutFor(ev('rival_snipe', { vid: 'FL-01', rival: 'FL-03', orderId: 4 }), 'FL-01')).toEqual({ text: 'FL-03 SNIPED #4', tone: 'bad' });
    expect(calloutFor(ev('rival_taunt', { vid: 'FL-01', rival: 'FL-03', theirs: 3, mine: 1 }), 'FL-01')).toEqual({ text: 'FL-03 WINS GRUDGE 3–1', tone: 'bad' });
  });
  it('rivalBubbleFor uses the real reason, else event text; only for me', () => {
    expect(rivalBubbleFor(ev('rival_snipe', { vid: 'FL-01', rival: 'FL-03', reason: 'too slow' }), 'FL-01')).toEqual({ vid: 'FL-03', text: '“too slow”' });
    expect(rivalBubbleFor({ t: 1, type: 'rival_taunt', text: 'FL-03 leads', vid: 'FL-01', rival: 'FL-03' }, 'FL-01')).toEqual({ vid: 'FL-03', text: 'FL-03 leads' });
    expect(rivalBubbleFor(ev('rival_snipe', { vid: 'FL-02', rival: 'FL-03' }), 'FL-01')).toBeNull();
    expect(rivalBubbleFor(ev('fare', { vid: 'FL-01', rival: 'FL-03' }), 'FL-01')).toBeNull();
    expect(rivalBubbleFor(ev('rival_snipe', { vid: 'FL-01', rival: 'FL-03' }), null)).toBeNull();
  });
  it('wrapBubbleText wraps greedily and ellipsises overflow', () => {
    expect(wrapBubbleText('one two three', 8)).toEqual(['one two', 'three']);
    const lines = wrapBubbleText('aaaa bbbb cccc dddd eeee', 9, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
    expect(wrapBubbleText('')).toEqual([]);
  });
});

describe('rival pills', () => {
  it('rivalPillText', () => {
    const vs = [{ id: 'FL-01', sPts: 10 }, { id: 'FL-03', sPts: 119.6 }];
    expect(rivalPillText('FL-03', vs)).toBe('Rival FL-03 · 120 pts');
    expect(rivalPillText('FL-09', vs)).toBeNull();
    expect(rivalPillText(null, vs)).toBeNull();
    expect(rivalPillText('FL-03', vs, 125)).toBe('Rival FL-03 · 120 pts · you +5');
    expect(rivalPillText('FL-03', vs, 105)).toBe('Rival FL-03 · 120 pts · you −15');
    expect(rivalPillText('FL-03', vs, 120)).toBe('Rival FL-03 · 120 pts · tied');
    expect(rivalPillText('FL-03', vs, null)).toBe('Rival FL-03 · 120 pts');
  });
  it('rivalDraftText needs active cards, no pending offer and a cards decision', () => {
    const active = { status: 'active' } as unknown as Card;
    const hand = { offer: null, cards: [active] };
    const dec = { kind: 'cards' as const, reason: 'kept the bay sweep', model: 'gemini-3.8-flash' };
    expect(rivalDraftText(hand, dec)).toBe('Rival drafted: kept the bay sweep (gemini-3.8-flash)');
    expect(rivalDraftText({ offer: [active], cards: [active] }, dec)).toBeNull();
    expect(rivalDraftText({ offer: null, cards: [] }, dec)).toBeNull();
    expect(rivalDraftText(hand, { ...dec, kind: 'plan' as never })).toBeNull();
    expect(rivalDraftText(hand, null)).toBeNull();
  });
});

describe('hotkeys: Q / F / 4', () => {
  const base: HotkeyContext = {
    typing: false,
    canHandBack: false,
    helpOpen: false,
    drawerOpen: false,
    coneMode: false,
    selectedVid: null,
    driving: true,
    fareOpen: true,
  };
  it('Q cycles and F confirms only while driving with an open offer', () => {
    expect(resolveHotkey({ key: 'q', code: 'KeyQ' }, base)).toBe('fare:cycle');
    expect(resolveHotkey({ key: 'f', code: 'KeyF' }, base)).toBe('fare:confirm');
    expect(resolveHotkey({ key: 'q', code: 'KeyQ' }, { ...base, fareOpen: false })).toBeNull();
    expect(resolveHotkey({ key: 'f', code: 'KeyF' }, { ...base, fareOpen: false })).toBeNull();
    // HUD v3: in the Floor view F is "🚜 Drive" (jump back in), not an order confirm.
    expect(resolveHotkey({ key: 'f', code: 'KeyF' }, { ...base, driving: false })).toBe('drive');
    expect(resolveHotkey({ key: 'f', code: 'KeyF' }, { ...base, typing: true })).toBeNull();
  });
  it('4 opens Dispatch in the Floor view (Ghost layer lives in ☰ → Layers)', () => {
    expect(resolveHotkey({ key: '4', code: 'Digit4' }, { ...base, driving: false, fareOpen: false })).toBe('order:dispatch');
  });
});
