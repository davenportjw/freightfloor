/**
 * Pure view-model tests for the UI-parity client (docs/design/ui-parity-plan.md, Phases 0/2/4).
 * No DOM: every function under test is a pure helper exported from src/ui/* or src/state.ts.
 */
import { describe, expect, it } from 'vitest';
import type { BoardRow, ValueSample } from '@warehouse/protocol';
import type { Card, CardHand } from '@warehouse/sim';
import { clockLine, onTimeText, DASH } from '../../src/ui/format.js';
import { initialOfferSel, keepIds, keepLabel, toggleOfferSel } from '../../src/ui/cards.js';
import { sortBoard, boardSummary } from '../../src/ui/strategyBoard.js';
import { valueChartModel } from '../../src/ui/valueChart.js';
import { resolvePanelState, readStoredPanelState, writeStoredPanelState, AUTO_COLLAPSE_WIDTH } from '../../src/ui/panel.js';
import { resolveHotkey, isTypingTarget, type HotkeyContext } from '../../src/ui/hotkeys.js';
import {
  appendSeries,
  denseHeat,
  EVENT_CAP,
  findMyHand,
  mergeEvents,
  mergeOwnHand,
  unflattenPath,
} from '../../src/state.js';
import { InputController, INPUT_SEND_INTERVAL_MS } from '../../src/input.js';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

describe('Phase 0 fixes', () => {
  it('clock line contains the day exactly once', () => {
    const line = clockLine(2 * 1440 + 11 * 60 + 12);
    expect(line).toMatch(/^Day 3 · \d{2}:\d{2} · Shift [A-C]$/);
    expect(line.match(/Day/g)?.length).toBe(1);
  });

  it('on-time shows a dash (not 100%) when nothing shipped', () => {
    expect(onTimeText({ shipped: 0, onTime: 0 })).toBe(DASH);
    expect(onTimeText({ shipped: 4, onTime: 3 })).toBe('75%');
  });

  it('hand is looked up by clientId, not vehicle id', () => {
    const hand = { offer: [], kept: [] } as unknown as CardHand;
    const cards: Record<string, CardHand> = { 'client-abc': hand };
    expect(findMyHand(cards, { clientId: 'client-abc' })).toBe(hand);
    expect(findMyHand(cards, { clientId: 'v1' })).toBeNull();
    expect(findMyHand(cards, null)).toBeNull();
  });

  it('merging the own-hand delta keeps agent hands and drops a stale own hand', () => {
    const agent = { offer: [] } as unknown as CardHand;
    const mine = { offer: [] } as unknown as CardHand;
    const cards: Record<string, CardHand> = { a1: agent, me: mine };
    mergeOwnHand(cards, {}, 'me');
    expect(cards.a1).toBe(agent);
    expect(cards.me).toBeUndefined();
    const fresh = { offer: [] } as unknown as CardHand;
    mergeOwnHand(cards, { me: fresh }, 'me');
    expect(cards.me).toBe(fresh);
  });

  it('keep multi-select sends every selected id in offer order', () => {
    const offer = [
      { id: 'c1', starter: false },
      { id: 'c2', starter: true },
      { id: 'c3', starter: false },
    ] as unknown as Card[];
    let sel = initialOfferSel(offer);
    expect([...sel]).toEqual(['c2']);
    sel = toggleOfferSel(sel, 'c3');
    sel = toggleOfferSel(sel, 'c1');
    expect(keepIds(offer, sel)).toEqual(['c1', 'c2', 'c3']);
    sel = toggleOfferSel(sel, 'c2');
    expect(keepIds(offer, sel)).toEqual(['c1', 'c3']);
    expect(keepLabel(2)).toBe('Keep 2 cards');
    expect(keepLabel(1)).toBe('Keep 1 card');
  });

  it('events are newest-first and capped', () => {
    const existing = [3, 2, 1];
    expect(mergeEvents(existing, [4, 5])).toEqual([5, 4, 3, 2, 1]);
    const many = Array.from({ length: EVENT_CAP + 30 }, (_, i) => i);
    const out = mergeEvents([], many);
    expect(out.length).toBe(EVENT_CAP);
    expect(out[0]).toBe(EVENT_CAP + 29);
  });
});

describe('delta application helpers', () => {
  it('unflattens path ints into points', () => {
    expect(unflattenPath([1, 2, 3, 4, 5])).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
  });

  it('densifies the sparse heat layer', () => {
    const dense = denseHeat({ w: 3, h: 2, cells: [[0, 1.5], [5, 2], [99, 7]] });
    expect(dense.length).toBe(6);
    expect(Array.from(dense)).toEqual([1.5, 0, 0, 0, 0, 2]);
  });

  it('appends only newer value samples and trims to cap', () => {
    const s = (t: number): ValueSample => ({ t, you: t, avg: 0, best: 0 });
    const series = [s(0), s(5)];
    appendSeries(series, [s(5), s(10), s(15)], 3);
    expect(series.map((x) => x.t)).toEqual([5, 10, 15]);
  });
});

describe('Phase 4 panels', () => {
  const row = (strat: string, perHr: number): BoardRow => ({
    strat,
    vehicles: 1,
    count: 1,
    perHr,
    onTimePct: null,
    incidents: 0,
    kwhPerOrder: null,
  });

  it('board sorts by /hr descending, stable for ties', () => {
    const sorted = sortBoard([row('A', 2), row('B', 9), row('C', 2)]);
    expect(sorted.map((r) => r.strat)).toEqual(['B', 'A', 'C']);
    expect(boardSummary([])).toBe(DASH);
    expect(boardSummary([row('A', 2), row('B', 9.25)])).toBe('B 9.3/hr');
  });

  it('value chart windows samples and is relative to window start', () => {
    const series: ValueSample[] = [
      { t: 0, you: 100, avg: 50, best: 70 },
      { t: 300, you: 120, avg: 60, best: 80 },
      { t: 480, you: 150, avg: 65, best: 95 },
    ];
    const m = valueChartModel(series, 480, 240);
    expect(m.enough).toBe(true);
    const you = m.lines.find((l) => l.key === 'you');
    expect(you?.last).toBe(30); // 150 - 120 (first sample in window)
    const tiny = valueChartModel(series, 480, 60);
    expect(tiny.enough).toBe(false);
  });
});

describe('panel persistence and auto-collapse', () => {
  const opts = { id: 'board', defaultState: 'open' as const };

  it('defaults open on wide screens and auto-collapses on narrow ones', () => {
    expect(resolvePanelState(opts, new MemStorage(), 1600)).toEqual({ state: 'open', source: 'default' });
    expect(resolvePanelState(opts, new MemStorage(), AUTO_COLLAPSE_WIDTH - 1)).toEqual({
      state: 'collapsed',
      source: 'auto',
    });
    expect(resolvePanelState({ ...opts, autoCollapse: false }, new MemStorage(), 800).state).toBe('open');
  });

  it('an explicit user choice is persisted and beats auto-collapse', () => {
    const st = new MemStorage();
    writeStoredPanelState(st, 'board', { state: 'open', user: true });
    expect(readStoredPanelState(st, 'board')).toEqual({ state: 'open', user: true });
    expect(resolvePanelState(opts, st, 900)).toEqual({ state: 'open', source: 'user' });
    st.setItem('warehouse.panel.board', '{bad json');
    expect(readStoredPanelState(st, 'board')).toBeNull();
  });
});

describe('hotkeys', () => {
  const base: HotkeyContext = {
    typing: false,
    canHandBack: false,
    helpOpen: false,
    drawerOpen: false,
    coneMode: false,
    selectedVid: null,
    driving: false,
  };
  const key = (code: string, k = '') => ({ code, key: k });

  it('maps the documented keys', () => {
    expect(resolveHotkey(key('Tab'), base)).toBe('hideHud');
    expect(resolveHotkey(key('KeyH'), base)).toBe('drawer');
    expect(resolveHotkey(key('KeyB'), base)).toBe('board');
    expect(resolveHotkey(key('Digit2'), base)).toBe('layer:traffic');
    expect(resolveHotkey(key('KeyC'), base)).toBe('cones');
    expect(resolveHotkey(key('Slash', '?'), base)).toBe('help');
    expect(resolveHotkey(key('KeyT'), base)).toBeNull();
    expect(resolveHotkey(key('KeyT'), { ...base, selectedVid: 'v3' })).toBe('takeWheel');
  });

  it('Esc: hand back > exit cone > deselect', () => {
    expect(resolveHotkey(key('Escape'), { ...base, canHandBack: true, coneMode: true })).toBe('handBack');
    expect(resolveHotkey(key('Escape'), { ...base, coneMode: true, selectedVid: 'v1' })).toBe('exitCone');
    expect(resolveHotkey(key('Escape'), { ...base, selectedVid: 'v1' })).toBe('deselect');
  });

  it('ignores keys while typing, with modifiers, or on repeat', () => {
    expect(resolveHotkey(key('KeyH'), { ...base, typing: true })).toBeNull();
    expect(resolveHotkey({ ...key('KeyH'), metaKey: true }, base)).toBeNull();
    expect(resolveHotkey({ ...key('KeyH'), repeat: true }, base)).toBeNull();
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'CANVAS' })).toBe(false);
  });
});

describe('driving input controller', () => {
  function make(driving = true) {
    const sent: Array<Record<string, unknown>> = [];
    let isDriving = driving;
    const c = new InputController((m) => sent.push(m as unknown as Record<string, unknown>), () => isDriving);
    return { c, sent, setDriving: (d: boolean) => (isDriving = d) };
  }

  it('does not capture keys when not driving', () => {
    const { c, sent } = make(false);
    expect(c.keyDown({ code: 'KeyW' }, 0)).toBe(false);
    expect(sent.length).toBe(0);
  });

  it('ignores auto-repeat and sends once per edge', () => {
    const { c, sent } = make();
    expect(c.keyDown({ code: 'KeyW' }, 0)).toBe(true);
    expect(c.keyDown({ code: 'KeyW', repeat: true }, 10)).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ type: 'input', up: true, seq: 1 });
  });

  it('re-sends at 10 Hz while held and stops when released', () => {
    const { c, sent } = make();
    c.keyDown({ code: 'ArrowLeft' }, 0);
    expect(c.tick(50)).toBe(false);
    expect(c.tick(INPUT_SEND_INTERVAL_MS)).toBe(true);
    expect(c.tick(2 * INPUT_SEND_INTERVAL_MS)).toBe(true);
    c.keyUp({ code: 'ArrowLeft' }, 210);
    const n = sent.length;
    expect(c.tick(400)).toBe(false);
    expect(sent.length).toBe(n);
    expect(sent[sent.length - 1]).toMatchObject({ left: false });
  });

  it('window blur releases all held keys and notifies the server', () => {
    const { c, sent } = make();
    c.keyDown({ code: 'KeyW' }, 0);
    c.keyDown({ code: 'KeyD' }, 5);
    c.blur(20);
    expect(c.held).toMatchObject({ up: false, down: false, left: false, right: false });
    expect(sent[sent.length - 1]).toMatchObject({ up: false, right: false });
  });

  it('records pending frames for replay with sequential seq numbers', () => {
    const { c } = make();
    c.keyDown({ code: 'KeyW' }, 0);
    c.tick(100);
    c.tick(200);
    expect(c.frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(c.tail.input.up).toBe(true);
  });
});
