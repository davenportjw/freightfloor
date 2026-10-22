/**
 * Pure view-model tests for the UI-parity client (docs/design/ui-parity-plan.md, Phases 0/2/4).
 * No DOM: every function under test is a pure helper exported from src/ui/* or src/state.ts.
 */
import { describe, expect, it } from 'vitest';
import type { BoardRow, ValueSample } from '@warehouse/protocol';
import { createWorld, type Card, type CardHand, type Vehicle } from '@warehouse/sim';
import { clockLine, onTimeText, DASH } from '../../src/ui/format.js';
import { initialOfferSel, keepIds, keepLabel, toggleOfferSel } from '../../src/ui/cards.js';
import { fleetView } from '../../src/ui/fleet.js';
import { kpiSummary } from '../../src/ui/kpiBar.js';
import { sortBoard, boardSummary } from '../../src/ui/teamStandings.js';
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

  it('maps the documented keys (HUD v3 floor view)', () => {
    expect(resolveHotkey(key('Tab'), base)).toBe('standings');
    expect(resolveHotkey(key('KeyH'), base)).toBe('drawer');
    expect(resolveHotkey(key('KeyB'), base)).toBe('board');
    expect(resolveHotkey(key('KeyM'), base)).toBe('menu');
    expect(resolveHotkey(key('KeyV'), base)).toBe('hudMinimal');
    expect(resolveHotkey(key('KeyL'), base)).toBe('leaderboardModal');
    expect(resolveHotkey(key('Digit1'), base)).toBe('order:rush');
    expect(resolveHotkey(key('Digit2'), base)).toBe('order:p0');
    expect(resolveHotkey(key('Digit3'), base)).toBe('order:cones');
    expect(resolveHotkey(key('Digit4'), base)).toBe('order:dispatch');
    expect(resolveHotkey(key('Digit2'), { ...base, overlay: 'pick' })).toBe('pick:2');
    expect(resolveHotkey(key('Digit2'), { ...base, driving: true })).toBeNull();
    expect(resolveHotkey(key('KeyC'), base)).toBeNull();
    expect(resolveHotkey(key('Slash', '?'), base)).toBe('help');
    expect(resolveHotkey(key('KeyT'), base)).toBeNull();
    expect(resolveHotkey(key('KeyT'), { ...base, selectedVid: 'v3' })).toBe('takeWheel');
  });

  it('Enter: pick sheet keeps, results plays again, dispatch sends, else chat', () => {
    expect(resolveHotkey(key('Enter'), { ...base, overlay: 'pick' })).toBe('pick:keep');
    expect(resolveHotkey(key('Enter'), { ...base, overlay: 'results' })).toBe('results:again');
    expect(resolveHotkey(key('Enter'), { ...base, dispatchOpen: true })).toBe('dispatch:send');
    expect(resolveHotkey(key('Enter'), base)).toBe('chat');
  });

  it('Esc closes sheets / flyouts / dispatch before cones and selection', () => {
    expect(resolveHotkey(key('Escape'), { ...base, overlay: 'pick', coneMode: true })).toBe('closeOverlay');
    expect(resolveHotkey(key('Escape'), { ...base, flyoutOpen: true, selectedVid: 'v1' })).toBe('closeOverlay');
    expect(resolveHotkey(key('Escape'), { ...base, dispatchOpen: true })).toBe('closeOverlay');
  });

  it('Esc: leaderboardModal > exit cone > hand back > deselect', () => {
    // HUD v3: cone placing is a Floor-view tool, so Esc finishes it before handing a vehicle back.
    expect(resolveHotkey(key('Escape'), { ...base, canHandBack: true, coneMode: true })).toBe('exitCone');
    expect(resolveHotkey(key('Escape'), { ...base, canHandBack: true, selectedVid: 'v1' })).toBe('handBack');
    expect(resolveHotkey(key('Escape'), { ...base, leaderboardModalOpen: true, coneMode: true })).toBe('closeLeaderboardModal');
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

  it('captures Shift / Space speed boost and setBoost pointer state', () => {
    const { c, sent } = make();
    expect(c.keyDown({ code: 'ShiftLeft' }, 0)).toBe(true);
    expect(c.held.boost).toBe(true);
    expect(sent[sent.length - 1]).toMatchObject({ type: 'input', boost: true });

    expect(c.keyUp({ code: 'ShiftLeft' }, 50)).toBe(true);
    expect(c.held.boost).toBe(false);
    expect(sent[sent.length - 1]).toMatchObject({ type: 'input', boost: false });

    expect(c.keyDown({ code: 'Space' }, 60)).toBe(true);
    expect(c.held.boost).toBe(true);
    c.blur(80);
    expect(c.held.boost).toBe(false);
    expect(sent[sent.length - 1]).toMatchObject({ type: 'input', boost: false });

    c.setBoost(true, 100);
    expect(c.held.boost).toBe(true);
    expect(sent[sent.length - 1]).toMatchObject({ type: 'input', boost: true });
    c.setBoost(false, 120);
    expect(c.held.boost).toBe(false);
  });

  it('consumes server elapsed dt on applyAck rather than dropping extra client frames when timers cross', async () => {
    const { createWorld, spawnPlayerVehicle } = await import('@warehouse/sim');
    const { voteCounts, voteLevelOf, VOTE_LEVELS, difficultyTooltip } = await import('../../src/ui/format.js');
    expect(VOTE_LEVELS).toEqual(['easy', 'normal', 'hard', 'turbo']);
    expect(voteLevelOf('medium')).toBe('normal');
    expect(voteLevelOf('turbo')).toBe('turbo');
    expect(voteCounts({ p1: 'easy', p2: 'medium', p3: 'turbo' })).toEqual({
      easy: 1,
      normal: 1,
      hard: 0,
      turbo: 1,
    });
    expect(difficultyTooltip('turbo')).toContain('Speed ×2');

    const w = createWorld({ seed: 42, agents: 0 });
    const v = spawnPlayerVehicle(w, 'p1', 'Driver1')!;
    v.tile = { x: 4, y: 13 };
    v.px = 4.5;
    v.py = 13.5;
    v.angle = 0;

    const { c } = make();
    c.keyDown({ code: 'KeyW' }, 0);
    c.predict(w, v, 100);
    c.tick(100); // closes seq 2 (dt=0.1), opens tail

    // Initial ack establishes baseline lastAckT = 10.0 at seq 1
    c.applyAck(w, v, { type: 'ack', seq: 1, t: 10.0, x: 4.6, y: 13.5, angle: 0, speedNow: 0.5 });
    expect(c.frames.map((f) => f.seq)).toEqual([2]);

    // Client ticks again before server's next tick arrives (seq 3 has 0.1 min, seq 2 has 0.1 min)
    c.predict(w, v, 100);
    c.tick(200);
    expect(c.frames.length).toBe(2);

    // Server advances by 1 tick (0.1 min: t=10.0 -> 10.1), but acks seq 3 because seq 3 arrived just before server step
    c.applyAck(w, v, { type: 'ack', seq: 3, t: 10.1, x: 4.7, y: 13.5, angle: 0, speedNow: 1.0 });
    // Only 0.1 min was consumed on the server, so 0.1 min of unapplied prediction remains in frames
    const remainingDt = c.frames.reduce((s, f) => s + f.dt, 0);
    expect(remainingDt).toBeCloseTo(0.1, 4);
    expect(v.px).toBeGreaterThan(4.7);
  });
});

describe('KPI summary, Fleet panel view, and network sync', () => {
  it('kpiSummary returns DASH before welcome and rich clock/shipped/on-time when welcomed', () => {
    expect(kpiSummary({ clock: DASH, shipped: DASH, onTime: DASH })).toBe(DASH);
    expect(kpiSummary({ clock: 'Day 1 · 08:15 · Shift A', shipped: '18', onTime: '94%' })).toBe(
      'Day 1 · 08:15 · Shift A · 18 shipped · 94% on-time',
    );
  });

  it('fleetView formats summary text, breakdown detail, and add/remove capabilities', () => {
    expect(fleetView([], 0, null, false).text).toBe(DASH);
    const vehicles = [
      { id: 'v1', human: false, extra: false },
      { id: 'v2', human: false, extra: true },
      { id: 'v3', human: true, extra: false },
    ] as unknown as Vehicle[];
    const v = fleetView(vehicles, 1, { maxVehicles: 24, maxTier: 4 }, true);
    expect(v.text).toBe('3 vehicles · wing 1/4');
    expect(v.detail).toBe('2 AI agents · 1 human drivers · Wing 1/4');
    expect(v.canAdd).toBe(true);
    expect(v.canRemove).toBe(true);
  });

  it('isDriverEntry and reconcileNetworkSites synchronize Presence and Network driver/spectator counts', async () => {
    const { isDriverEntry } = await import('../../src/ui/presence.js');
    const { reconcileNetworkSites } = await import('../../src/ui/network.js');
    const { ClientStore } = await import('../../src/state.js');

    expect(
      isDriverEntry({
        clientId: 'c1',
        name: 'Alice',
        vid: 'DRV-01',
        role: 'driver',
      }),
    ).toBe(true);
    // Role is 'driver' but vid is null -> must not count as active driver
    expect(
      isDriverEntry({
        clientId: 'c2',
        name: 'Bob',
        vid: null,
        role: 'driver',
      }),
    ).toBe(false);
    // Role is 'spectator' -> must not count as active driver
    expect(
      isDriverEntry({
        clientId: 'c3',
        name: 'Carol',
        vid: null,
        role: 'spectator',
      }),
    ).toBe(false);

    const store = new ClientStore();
    store.welcomed = true;
    store.siteId = 'den-1';
    store.limits = { maxDrivers: 8 };
    store.world.tier = 2;
    store.world.totals.shipped = 42;
    store.world.phase = 'running';
    store.network.sites = [
      {
        id: 'den-1',
        state: 'live',
        drivers: 3, // stale poll count
        spectators: 0,
        tier: 0,
        shipped: 10,
        phase: 'running',
        wsUrl: 'ws://localhost:8080/ws?site=den-1',
        maxDrivers: 8,
        updatedAt: 1000,
      },
      {
        id: 'sfo-1',
        state: 'live',
        drivers: 1,
        spectators: 2,
        tier: 1,
        shipped: 15,
        phase: 'running',
        wsUrl: 'ws://localhost:8080/ws?site=sfo-1',
        maxDrivers: 8,
        updatedAt: 1000,
      },
    ];
    store.applyPresence([
      { clientId: 'c1', name: 'Alice', vid: 'DRV-01', role: 'driver' },
      { clientId: 'c2', name: 'Bob', vid: null, role: 'spectator' },
    ]);

    const reconciled = reconcileNetworkSites(store);
    const den = reconciled.find((s) => s.id === 'den-1')!;
    const sfo = reconciled.find((s) => s.id === 'sfo-1')!;
    expect(den.drivers).toBe(1);
    expect(den.spectators).toBe(1);
    expect(den.tier).toBe(2);
    expect(den.shipped).toBe(42);
    expect(sfo.drivers).toBe(1);
    expect(sfo.spectators).toBe(2);
  });
});


describe('presenceView and leaderboardView synchronization', () => {
  it('keeps DRIVERS panel shift points synced with live vehicle sPts and shows all human drivers below top 5 on Leaderboard', async () => {
    const { ClientStore } = await import('../../src/state.js');
    const { presenceView } = await import('../../src/ui/presence.js');
    const { leaderboardView } = await import('../../src/ui/leaderboard.js');
    const { spawnPlayerVehicle, leaderboard } = await import('@warehouse/sim');

    const store = new ClientStore();
    store.welcomed = true;
    store.siteId = 'den-1';
    const w = store.world;
    // Give AI agents higher shift points so human drivers rank below top 5
    w.vehicles.forEach((v, idx) => {
      v.sPts = 100 - idx * 5;
    });
    const drv1 = spawnPlayerVehicle(w, { clientId: 'c-bm', name: 'bm', isBot: false })!;
    const drv2 = spawnPlayerVehicle(w, { clientId: 'c-big', name: 'BigLifter', isBot: false })!;
    drv1.sPts = 0;
    drv2.sPts = 0;
    store.you = { clientId: 'c-big', playerId: 'P2', name: 'BigLifter', vid: drv2.id, siteId: 'den-1' };
    store.myVid = drv2.id;

    // Server sends initial presence with 0 pts for everyone, including a newly joined 3rd driver (DRV-03)
    // whose vehicle arrives on the next light delta
    store.applyPresence([
      { clientId: 'c-bm', playerId: 'P1', name: 'bm', vid: drv1.id, points: 0, score: 0, role: 'driver', isBot: false },
      { clientId: 'c-big', playerId: 'P2', name: 'BigLifter', vid: drv2.id, points: 0, score: 0, role: 'driver', isBot: false },
      { clientId: 'c-thag', playerId: 'P3', name: 'THAGOMIZER', vid: 'DRV-03', points: 0, score: 0, role: 'driver', isBot: false },
    ]);

    // Next 10 Hz delta updates BigLifter (drv2) to 15 pts and introduces DRV-03 on a light delta
    store.applyDelta({
      type: 'delta',
      t: w.t + 0.1,
      vehicles: [
        ...w.vehicles.map((v) => ({
          id: v.id,
          qx: Math.round(v.px * 32),
          qy: Math.round(v.py * 32),
          angle: v.angle,
          state: v.state,
          battery: Math.round(v.battery),
          sPts: v.id === drv2.id ? 15 : v.sPts,
        })),
        {
          id: 'DRV-03',
          qx: 160,
          qy: 416,
          angle: 0,
          state: 'idle',
          battery: 100,
          sPts: 5,
        },
      ],
      events: [],
    });

    const pView = presenceView(store);
    expect(pView.drivers).toBe(3);
    expect(pView.players.find((p) => p.name === 'BigLifter')?.detail).toBe(`driving ${drv2.id} · 15 pts`);
    expect(pView.players.find((p) => p.name === 'THAGOMIZER')?.detail).toBe('driving DRV-03 · 5 pts');
    expect(pView.players.find((p) => p.name === 'bm')?.detail).toBe(`driving ${drv1.id} · 0 pts`);

    const lb = leaderboard(store.world);
    const lbView = leaderboardView(lb, store.renderMyVid(), 5);
    const lbIds = lbView.rows.map((r) => r.row.id);
    // All 3 human drivers (ranked below top 5) must appear on the Leaderboard panel
    expect(lbIds).toContain(drv1.id);
    expect(lbIds).toContain(drv2.id);
    expect(lbIds).toContain('DRV-03');
    expect(lbView.rows.find((r) => r.row.id === drv2.id)?.row.pts).toBe(15);
    expect(lbView.rows.find((r) => r.row.id === 'DRV-03')?.row.driver).toBe('THAGOMIZER');
  });
});

describe('Intro Page boot behavior (shouldShowHelpOnBoot & markHelpSeen)', () => {
  it('opens the Intro Page on both first visit (null) and subsequent visits ("1"), only skipping when explicitly set to "skip"', async () => {
    const { shouldShowHelpOnBoot, markHelpSeen, HELP_SEEN_KEY } = await import('../../src/ui/help.js');
    const st = new MemStorage();
    expect(shouldShowHelpOnBoot(null)).toBe(true);
    expect(shouldShowHelpOnBoot(st)).toBe(true);

    markHelpSeen(st);
    expect(st.getItem(HELP_SEEN_KEY)).toBe('1');
    // Still opens on subsequent visit even after markHelpSeen
    expect(shouldShowHelpOnBoot(st)).toBe(true);

    // Explicit opt-out skips boot display
    st.setItem(HELP_SEEN_KEY, 'skip');
    expect(shouldShowHelpOnBoot(st)).toBe(false);
  });
});

describe('computeSillyAwards (Full-Screen Leaderboard Silly Superlatives)', () => {
  it('computes all 6 silly superlative awards from live vehicle telemetry', async () => {
    const { computeSillyAwards } = await import('../../src/ui/leaderboardModal.js');
    const { createWorld } = await import('@warehouse/sim');
    const world = createWorld({ seed: 42 });
    const v0 = world.vehicles[0]!;
    const v1 = world.vehicles[1]!;
    const v2 = world.vehicles[2]!;

    v0.incidents = 4;
    v0.palletDrops = 2;
    v1.skids = 5;
    v1.nearMisses = 7;
    v2.battery = 14;
    v2.human = true;
    v2.driver = 'Turbo-Badger';
    v2.sPts = 0;
    v2.sShipped = 0;
    v2.wait = 45;

    const awards = computeSillyAwards(world, v2.id);
    expect(awards).toHaveLength(6);

    const crashAward = awards.find((a) => a.id === 'crashes')!;
    expect(crashAward.vid).toBe(v0.id);
    expect(crashAward.statText).toBe('4 crashes (−60 pts)');

    const dropsAward = awards.find((a) => a.id === 'palletDrops')!;
    expect(dropsAward.vid).toBe(v0.id);
    expect(dropsAward.statText).toBe('2 dropped pallets');

    const skidsAward = awards.find((a) => a.id === 'skids')!;
    expect(skidsAward.vid).toBe(v1.id);
    expect(skidsAward.statText).toBe('5 spill skids');

    const nearMissAward = awards.find((a) => a.id === 'nearMisses')!;
    expect(nearMissAward.vid).toBe(v1.id);
    expect(nearMissAward.statText).toBe('7 near misses');

    const lowBatAward = awards.find((a) => a.id === 'lowBattery')!;
    expect(lowBatAward.vid).toBe(v2.id);
    expect(lowBatAward.holder).toContain('Turbo-Badger');
    expect(lowBatAward.mine).toBe(true);
    expect(lowBatAward.statText).toContain('14% battery');

    const brakeAward = awards.find((a) => a.id === 'parkingBrake')!;
    expect(brakeAward.vid).toBe(v2.id);
    expect(brakeAward.holder).toContain('Turbo-Badger');
    expect(brakeAward.mine).toBe(true);
  });

  it('renders Silly Superlatives as a structured table with matching styles', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const modalSrc = readFileSync(
      resolve(import.meta.dirname, '../../src/ui/leaderboardModal.ts'),
      'utf8',
    );
    const cssSrc = readFileSync(resolve(import.meta.dirname, '../../src/styles.css'), 'utf8');

    expect(modalSrc).toContain('silly-awards-table');
    expect(modalSrc).toContain("'data-role': 'silly-awards-table'");
    expect(modalSrc).toContain('silly-award-row');
    expect(modalSrc).not.toContain('silly-awards-grid');
    expect(modalSrc).not.toContain('silly-award-card');

    expect(cssSrc).toContain('.silly-award-row');
    expect(cssSrc).toContain('.lb-driver-cell');
  });
});

describe('Co-Pilot & Agent Designer helpers, hotkeys, and autopilot InputController', () => {
  it('createDraftFromVehicle, buildAgentDirectiveFromDraft, and formatDirectiveSummary round-trip directives cleanly', async () => {
    const {
      createDraftFromVehicle,
      buildAgentDirectiveFromDraft,
      formatDirectiveSummary,
      QUICK_INTENT_PILLS,
    } = await import('../../src/ui/agentDesigner.js');
    const { createWorld } = await import('@warehouse/sim');

    const world = createWorld({ seed: 42 });
    const v = world.vehicles[0]!;
    v.strat = 'Batcher';
    v.strategy = 'Batcher';
    v.directive = undefined;
    v.autopilot = true;

    const draft = createDraftFromVehicle(v);
    expect(draft.persona).toBe('Batcher');
    expect(draft.priority).toBe('balanced');
    expect(draft.immediateTask).toBe('auto');

    draft.persona = 'Sprinter';
    draft.chargeAt = 35;
    draft.priority = 'p0_first';
    draft.focusZones = ['C', 'D'];
    draft.immediateTask = 'pick_p0';
    draft.note = 'Stage P0s fast';

    const built = buildAgentDirectiveFromDraft(draft);
    expect(built.autopilot).toBe(true);
    expect(built.persona).toBe('Sprinter');
    expect(built.priority).toBe('p0_first');
    expect(built.focusZones).toEqual(['C', 'D']);
    expect(built.immediateTask).toBe('pick_p0');
    expect(built.tactics?.chargeAt).toBe(35);
    expect(built.tactics?.note).toBe('Stage P0s fast');

    v.directive = built;
    const summary = formatDirectiveSummary(v);
    expect(summary).toContain('Sprinter');
    expect(summary).toContain('P0 First');
    expect(summary).toContain('Zones C,D');
    expect(summary).toContain('charge ≤35%');
    expect(QUICK_INTENT_PILLS.length).toBeGreaterThanOrEqual(5);
  });

  it('maps KeyG to agentDesigner, C to toggleCopilot, and Escape only closes things', () => {
    const base: HotkeyContext = {
      typing: false,
      canHandBack: false,
      helpOpen: false,
      drawerOpen: false,
      coneMode: false,
      selectedVid: 'DRV-01',
      driving: true,
      autopilot: false,
      agentDesignerOpen: false,
    };
    expect(resolveHotkey({ code: 'KeyG', key: 'g' }, base)).toBe('agentDesigner');
    expect(
      resolveHotkey({ code: 'Escape', key: 'Escape' }, { ...base, agentDesignerOpen: true }),
    ).toBe('closeAgentDesigner');
    // Co-Pilot is C (toggle) — Esc never engages it; it just closes / deselects.
    expect(resolveHotkey({ code: 'KeyC', key: 'c' }, base)).toBe('toggleCopilot');
    expect(resolveHotkey({ code: 'KeyC', key: 'c' }, { ...base, autopilot: true })).toBe('toggleCopilot');
    expect(resolveHotkey({ code: 'Escape', key: 'Escape' }, base)).toBe('deselect');
    expect(resolveHotkey({ code: 'Escape', key: 'Escape' }, { ...base, selectedVid: null })).toBeNull();
    expect(
      resolveHotkey({ code: 'Escape', key: 'Escape' }, { ...base, autopilot: true }),
    ).toBe('deselect');
  });

  it('InputController skips idle keep-alive frames in autopilot and triggers instant WASD takeover', () => {
    const sent: Array<Record<string, unknown>> = [];
    let autopilot = true;
    let takeovers = 0;
    const ctrl = new InputController(
      (m) => sent.push(m as unknown as Record<string, unknown>),
      () => true,
      () => autopilot,
      () => {
        autopilot = false;
        takeovers++;
      },
    );

    // While in autopilot with no keys held, tick() does NOT send keep-alive frames and predicting() is false
    expect(ctrl.predicting(1000)).toBe(false);
    expect(ctrl.tick(2000)).toBe(false);
    expect(sent.length).toBe(0);

    // Pressing W triggers instant manual takeover and sends input immediately
    expect(ctrl.keyDown({ code: 'KeyW' }, 2100)).toBe(true);
    expect(takeovers).toBe(1);
    expect(autopilot).toBe(false);
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ type: 'input', up: true });
    expect(ctrl.predicting(2150)).toBe(true);
  });

  it('formatBlitzRemaining converts 10 Hz sim-minutes (1 sim-min = 1 real second) into MM:SS countdown', async () => {
    const { formatBlitzRemaining } = await import('../../src/ui/commandBar.js');
    expect(formatBlitzRemaining(300)).toBe('05:00');
    expect(formatBlitzRemaining(180)).toBe('03:00');
    expect(formatBlitzRemaining(60)).toBe('01:00');
    expect(formatBlitzRemaining(15)).toBe('00:15');
    expect(formatBlitzRemaining({ runMode: 'blitz', runStartedAt: 100, runEndsAt: 280 }, 100)).toBe('03:00');
    expect(formatBlitzRemaining({ runMode: 'blitz', runStartedAt: 100, runEndsAt: 280 }, 220)).toBe('01:00');
    expect(formatBlitzRemaining({ runMode: 'blitz', runStartedAt: null, runEndsAt: null }, 100)).toBe('03:00');
  });
});

describe('Shift Briefing / Help modal (mountHelp, How to Play + "How the AI works" link)', () => {
  class MiniNode {
    children: Array<MiniElement | MiniText> = [];
    get textContent(): string {
      return this.children.map((c) => c.textContent).join('');
    }
    set textContent(v: string) {
      this.children = v ? [new MiniText(String(v))] : [];
    }
  }

  class MiniText extends MiniNode {
    constructor(public raw: string) {
      super();
    }
    override get textContent(): string {
      return this.raw;
    }
    override set textContent(v: string) {
      this.raw = String(v);
    }
  }

  class MiniElement extends MiniNode {
    tagName: string;
    className = '';
    title = '';
    type = '';
    value = '';
    disabled = false;
    hidden = false;
    private attrs = new Map<string, string>();
    private listeners = new Map<string, Array<(ev: unknown) => void>>();
    readonly dataset: Record<string, string>;
    readonly style = {
      props: new Map<string, string>(),
      setProperty(k: string, v: string) {
        this.props.set(k, v);
      },
    };
    readonly classList: {
      contains: (cls: string) => boolean;
      add: (cls: string) => void;
      remove: (cls: string) => void;
      toggle: (cls: string, force?: boolean) => boolean;
    };

    constructor(tag: string) {
      super();
      this.tagName = tag.toUpperCase();
      const self = this;
      this.dataset = new Proxy({} as Record<string, string>, {
        set(_t, prop: string, val: string) {
          const kebab = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
          self.attrs.set(`data-${kebab}`, String(val));
          return true;
        },
        get(_t, prop: string) {
          const kebab = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
          return self.attrs.get(`data-${kebab}`);
        },
      });
      this.classList = {
        contains: (cls: string) => self.className.split(/\s+/).filter(Boolean).includes(cls),
        add: (cls: string) => {
          const set = new Set(self.className.split(/\s+/).filter(Boolean));
          set.add(cls);
          self.className = [...set].join(' ');
        },
        remove: (cls: string) => {
          const set = new Set(self.className.split(/\s+/).filter(Boolean));
          set.delete(cls);
          self.className = [...set].join(' ');
        },
        toggle: (cls: string, force?: boolean) => {
          const has = self.classList.contains(cls);
          const next = force !== undefined ? force : !has;
          if (next) self.classList.add(cls);
          else self.classList.remove(cls);
          return next;
        },
      };
    }

    setAttribute(k: string, v: string): void {
      this.attrs.set(k, String(v));
    }

    getAttribute(k: string): string | null {
      return this.attrs.has(k) ? (this.attrs.get(k) as string) : null;
    }

    append(...nodes: Array<MiniElement | MiniText | string>): void {
      for (const n of nodes) {
        this.children.push(typeof n === 'string' ? new MiniText(n) : n);
      }
    }

    replaceChildren(...nodes: Array<MiniElement | MiniText | string>): void {
      this.children = [];
      this.append(...nodes);
    }

    addEventListener(type: string, fn: (ev: unknown) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }

    click(): void {
      for (const fn of this.listeners.get('click') ?? []) {
        fn({ target: this, preventDefault() {} });
      }
    }

    focus(): void {}

    queryAll(pred: (el: MiniElement) => boolean): MiniElement[] {
      const out: MiniElement[] = [];
      const walk = (node: MiniElement | MiniText) => {
        if (node instanceof MiniElement) {
          if (pred(node)) out.push(node);
          for (const ch of node.children) walk(ch);
        }
      };
      walk(this);
      return out;
    }
  }

  it('defaults to How to Play, opens AI Inside + Decision Lifecycle behind one "How the AI works" link, and renders validated personas, 2-lane SVG lifecycle diagram, and 3-row mode comparison matrix', async () => {
    const prevDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = {
      createElement: (tag: string) => new MiniElement(tag),
      createElementNS: (_ns: string, tag: string) => new MiniElement(tag),
      createTextNode: (text: string) => new MiniText(text),
    };

    try {
      const { mountHelp } = await import('../../src/ui/help.js');
      const { ClientStore } = await import('../../src/state.js');
      const { PERSONA_OPTIONS } = await import('../../src/ui/agentDesigner.js');
      const { STRATEGIES } = await import('@warehouse/sim');

      const overlay = new MiniElement('div');
      const store = new ClientStore();
      store.ui.helpOpen = true;
      const ctx = {
        store,
        actions: {
          showHelp: (open: boolean) => {
            store.ui.helpOpen = open;
          },
          quickDrive: () => {},
        },
      } as unknown as import('../../src/ui/context.js').UiCtx;

      const help = mountHelp(overlay as unknown as HTMLElement, ctx, {
        getCallsign: () => 'Forklift-Ace',
      });
      help.update();

      // One "🧠 How the AI works" link (data-intro-tab="ai") + a hidden "← How to Play" back link.
      const links = overlay.queryAll((e) => e.dataset.introTab !== undefined);
      expect(links.map((t) => t.dataset.introTab)).toEqual(['ai', 'play']);
      const [aiLink, backLink] = links as [MiniElement, MiniElement];
      expect(aiLink.textContent).toBe('🧠 How the AI works');
      expect(aiLink.hidden).toBe(false);
      expect(backLink.hidden).toBe(true);
      expect(overlay.queryAll((e) => e.getAttribute('role') === 'tab')).toHaveLength(0);

      const playPane = overlay.queryAll((e) => e.getAttribute('data-pane') === 'rules')[0]!;
      const aiPane = overlay.queryAll((e) => e.getAttribute('data-pane') === 'ai-concepts')[0]!;
      const lifecyclePane = overlay.queryAll((e) => e.getAttribute('data-pane') === 'decision-lifecycle')[0]!;
      expect(playPane).toBeDefined();
      expect(aiPane).toBeDefined();
      expect(lifecyclePane).toBeDefined();
      expect(playPane.hidden).toBe(false);
      expect(aiPane.hidden).toBe(true);
      expect(lifecyclePane.hidden).toBe(true);

      // The link opens the AI view: AI Inside and Decision Lifecycle stacked.
      aiLink.click();
      expect(playPane.hidden).toBe(true);
      expect(aiPane.hidden).toBe(false);
      expect(lifecyclePane.hidden).toBe(false);
      expect(aiLink.hidden).toBe(true);
      expect(backLink.hidden).toBe(false);

      // Verify 'The AI Inside' content: 4 cards, all 5 real archetypes, no stale Hauler/Sentinel, Game Engine vs. Gemini
      const aiCards = aiPane.queryAll((e) => e.classList.contains('ai-concept-card'));
      expect(aiCards).toHaveLength(4);
      const aiText = aiPane.textContent;
      expect(Object.keys(STRATEGIES)).toHaveLength(5);
      for (const persona of PERSONA_OPTIONS) {
        expect(aiText).toContain(persona.id);
      }
      expect(aiText).not.toContain('Hauler');
      expect(aiText).not.toContain('Sentinel');
      expect(aiText).toContain('Game Engine (10 Hz)');
      expect(aiText).toContain('gemini-3.5-flash-lite');
      expect(aiText).toContain('zero silent fallbacks');
      expect(aiText).toContain('7-layer Model Armor screening');
      // Ensure internal TypeScript identifiers are not exposed in user-facing UI
      for (const jargon of ['stepHuman', 'scoreOrdersFor', 'buildOccupancy', 'findPath', 'FacilityGovernor', 'thinkingBudget: 0']) {
        expect(aiText).not.toContain(jargon);
      }

      // 'lifecycle' is an alias for the same AI view.
      help.switchTab('lifecycle');
      expect(playPane.hidden).toBe(true);
      expect(aiPane.hidden).toBe(false);
      expect(lifecyclePane.hidden).toBe(false);

      // Verify Part 1: 2-Lane Swimlane SVG Visual Diagram (svg.lifecycle-svg inside .lifecycle-diagram-card)
      const diagramCards = lifecyclePane.queryAll((e) => e.classList.contains('lifecycle-diagram-card'));
      expect(diagramCards).toHaveLength(1);
      const svgs = lifecyclePane.queryAll((e) => e.tagName === 'SVG' && e.classList.contains('lifecycle-svg'));
      expect(svgs).toHaveLength(1);
      expect(svgs[0]!.getAttribute('viewBox')).toBe('0 0 760 250');
      expect(svgs[0]!.getAttribute('role')).toBe('img');

      const svgText = svgs[0]!.textContent;
      expect(svgText).toContain('10 Hz GAME ENGINE');
      expect(svgText).toContain('GEMINI 3.5 FLASH-LITE');
      expect(svgText).toContain('1. Drive & Avoid');
      expect(svgText).toContain('2. Trigger & Pre-Score');
      expect(svgText).toContain('3a. Priority Queue (Max 4)');
      expect(svgText).toContain('3b. Persona Decision');
      expect(svgText).toContain('4. Validate & Deliver');
      expect(svgText).toContain('Low Battery (< chargeAt)');
      expect(svgText).toContain('Async JSON (Top 6)');
      expect(svgText).toContain('Chosen Order ID');
      expect(svgText).toContain('0 Mock Fallbacks');

      // Verify Part 2: Compact 3-Row Visual Comparison Matrix (.lifecycle-matrix & .lifecycle-matrix-row)
      const matrices = lifecyclePane.queryAll((e) => e.classList.contains('lifecycle-matrix'));
      expect(matrices).toHaveLength(1);
      const matrixRows = lifecyclePane.queryAll((e) => e.classList.contains('lifecycle-matrix-row'));
      expect(matrixRows).toHaveLength(3);
      const chips = lifecyclePane.queryAll((e) => e.classList.contains('lc-chip'));
      expect(chips).toHaveLength(9);

      const lifecycleText = lifecyclePane.textContent;
      expect(lifecycleText).toContain('Who Calls Gemini vs. Game Engine?');
      expect(lifecycleText).toContain('AI Fleet (F-01..F-20)');
      expect(lifecycleText).toContain('Player Manual (Drive / Take Wheel)');
      expect(lifecycleText).toContain('Player Co-Pilot (Autopilot ON)');
      expect(lifecycleText).toContain('No Fallback');
      expect(lifecycleText).toContain('0 LLM Calls');
      expect(lifecycleText).toContain('1.0s Fallback');
      for (const jargon of ['stepHuman', 'scoreOrdersFor', 'buildOccupancy', 'findPath', 'FacilityGovernor', 'thinkingBudget: 0']) {
        expect(lifecycleText).not.toContain(jargon);
      }

      // "← How to Play" goes back.
      backLink.click();
      expect(playPane.hidden).toBe(false);
      expect(aiPane.hidden).toBe(true);
      expect(lifecyclePane.hidden).toBe(true);
      expect(aiLink.hidden).toBe(false);
      expect(backLink.hidden).toBe(true);
    } finally {
      (globalThis as Record<string, unknown>).document = prevDoc;
    }
  });

  it('handles ClientStore.applyRunEvicted, mountRunEnd slot release & Get Back in Line, and mountFloorView queue banner states', async () => {
    const prevDoc = (globalThis as Record<string, unknown>).document;
    const byId = new Map<string, MiniElement>();
    (globalThis as Record<string, unknown>).document = {
      createElement: (tag: string) => new MiniElement(tag),
      createElementNS: (_ns: string, tag: string) => new MiniElement(tag),
      createTextNode: (text: string) => new MiniText(text),
      getElementById: (id: string) => {
        if (!byId.has(id)) byId.set(id, new MiniElement('div'));
        return byId.get(id)!;
      },
    };

    try {
      const { ClientStore } = await import('../../src/state.js');
      const { mountRunEnd } = await import('../../src/ui/runEnd.js');
      const { mountFloorView } = await import('../../src/ui/floorView.js');

      const store = new ClientStore();
      store.welcomed = true;
      store.siteId = 'den-1';
      store.myVid = 'DRV-01';
      store.world.vehicles.push({
        id: 'DRV-01',
        type: 'forklift',
        strategy: 'Steady',
        x: 10,
        y: 10,
        tx: 10,
        ty: 10,
        vx: 0,
        vy: 0,
        heading: 0,
        speedNow: 0,
        bat: 88,
        state: 'idle',
        cargo: [],
        OrderId: null,
        pts: 180,
        sPts: 180,
        deliv: 6,
        onTime: 5,
        late: 1,
        dist: 40,
        stuns: 0,
        fork: 0,
        human: true,
        isPlayerVehicle: true,
        driver: 'Turbo-Badger',
        runMode: 'blitz',
        runPts: 180,
        runDeliveries: 6,
        runOnTime: 5,
        runIncidents: 0,
        streak: 3,
        bestStreak: 4,
        combo: 1.5,
        comboBest: 1.5,
        speedyTrips: 3,
        fareTrips: 6,
      } as unknown as import('@warehouse/sim').Vehicle);

      store.applyRunEvicted({
        type: 'runEvicted',
        vid: 'DRV-01',
        reason: 'idle_timeout',
        pts: 180,
        shipped: 6,
        incidents: 0,
        bestStreak: 4,
        runMode: 'blitz',
      });

      expect(store.myVid).toBeNull();
      expect(store.vehicle('DRV-01')).toBeNull();
      expect(store.evictedReason).toBe('idle_timeout');
      expect(store.ui.runEnd).not.toBeNull();
      expect(store.ui.runEnd?.reason).toBe('idle_timeout');

      let retried = 0;
      const retriedModes: Array<string | undefined> = [];
      let claimed = 0;
      let leftQueue = 0;
      let droveFromFloor = 0;
      const ctx = {
        store,
        actions: {
          retryNewRun: (mode?: string) => {
            retried++;
            retriedModes.push(mode);
          },
          dismissRunEnd: () => {
            store.ui.runEnd = null;
          },
          showLeaderboardModal: () => {},
          claimQueueSeat: () => {
            claimed++;
          },
          leaveQueue: () => {
            leftQueue++;
          },
          toggleAutoClaimSeat: () => {
            store.autoClaimSeat = !store.autoClaimSeat;
          },
          driveFromFloor: () => {
            droveFromFloor++;
          },
          panTo: () => {},
        },
      } as unknown as import('../../src/ui/context.js').UiCtx;

      // 1. mountRunEnd shows eviction reason, "Run again ↵" (when not queued), "Get Back in Line ↵" (when queued), and ghost secondary buttons ("Full Standings", "Watch the floor", "Free Range")
      expect(store.ui.runEnd?.leaderboardRows?.length).toBeGreaterThan(0);
      expect(store.ui.runEnd?.humanRank).toBe(1);
      expect(store.ui.runEnd?.totalHumanRuns).toBeGreaterThanOrEqual(1);
      const runEndHost = new MiniElement('div');
      const runEndView = mountRunEnd(runEndHost as unknown as HTMLElement, ctx);
      runEndView.update();

      const fullStandingsBtn = runEndHost.queryAll((e) => e.dataset.role === 'full-standings')[0]!;
      expect(fullStandingsBtn.className).toBe('ghost');

      const watchFloorBtn = runEndHost.queryAll((e) => e.dataset.role === 'watch-floor')[0]!;
      expect(watchFloorBtn.className).toBe('ghost');

      const tryAgainBtn = runEndHost.queryAll((e) => e.dataset.role === 'play-again')[0]!;
      expect(tryAgainBtn.textContent).toBe('Run again ↵');
      tryAgainBtn.click();
      expect(retried).toBe(1);
      expect(retriedModes[0]).toBe('blitz');

      const freeRangeBtn = runEndHost.queryAll((e) => e.dataset.role === 'go-freerange')[0]!;
      expect(freeRangeBtn).toBeDefined();
      expect(freeRangeBtn.className).toBe('ghost');
      expect(freeRangeBtn.textContent).toBe('Free Range');
      freeRangeBtn.click();
      expect(retried).toBe(2);
      expect(retriedModes[1]).toBe('freerange');

      store.setQueue({ state: 'queued', position: 3, totalQueued: 9, estimatedWaitSec: 35 });
      runEndView.update();

      const slotStatus = runEndHost.queryAll((e) => e.dataset.role === 'slot-status')[0]!;
      expect(slotStatus.hidden).toBe(false);
      expect(slotStatus.textContent).toContain('Session ended due to inactivity');

      const queueStatus = runEndHost.queryAll((e) => e.dataset.role === 'queue-status')[0]!;
      expect(queueStatus.hidden).toBe(false);
      expect(queueStatus.textContent).toContain('#3');

      const againBtn = runEndHost.queryAll((e) => e.dataset.role === 'play-again')[0]!;
      expect(againBtn.textContent).toBe('Get Back in Line ↵');
      againBtn.click();
      expect(retried).toBe(3);
      expect(retriedModes[2]).toBe('blitz');

      // 2. mountFloorView #floorBanner in queued, ready, and full states
      store.ui.runEnd = null;
      const kpisEl = new MiniElement('div');
      const banner = new MiniElement('div');
      const feedEl = new MiniElement('div');
      const floorView = mountFloorView(
        kpisEl as unknown as HTMLElement,
        banner as unknown as HTMLElement,
        feedEl as unknown as HTMLElement,
        ctx,
      );

      // Queued state
      floorView.update();
      expect(banner.hidden).toBe(false);
      expect(banner.textContent).toContain('Waiting in line · #3 of 9');
      const leaveBtn = banner.queryAll((e) => e.dataset.role === 'leave-queue')[0]!;
      expect(leaveBtn).toBeDefined();
      leaveBtn.click();
      expect(leftQueue).toBe(1);

      // Ready state (20s seat claim lease)
      store.setQueue({
        state: 'ready',
        position: 1,
        totalQueued: 4,
        assignedSiteId: 'slc-2',
        leaseExpiresAt: Date.now() + 18_000,
      });
      floorView.update();
      expect(banner.textContent).toContain('Forklift Ready on SLC-2');
      const claimBtn = banner.queryAll((e) => e.dataset.role === 'claim-seat')[0]!;
      expect(claimBtn.textContent).toContain('🚜 Take the Wheel ↵');
      claimBtn.click();
      expect(claimed).toBe(1);

      // Full shard state with no active queue -> "🕒 Join Waiting Line F"
      store.setQueue(null);
      store.limits = { maxDrivers: 32, maxPlayersPerSite: 32, maxBotsPerSite: 28 };
      store.presence = Array.from({ length: 32 }, (_, i) => ({
        clientId: `c-${i}`,
        name: `Driver-${i}`,
        vid: `DRV-${i}`,
        points: 0,
        role: 'driver' as const,
      }));
      floorView.update();
      const joinLineBtn = banner.queryAll((e) => e.dataset.role === 'drive-floor')[0]!;
      expect(joinLineBtn.disabled).toBe(false);
      expect(joinLineBtn.textContent).toBe('🕒 Join Waiting Line F');
      joinLineBtn.click();
      expect(droveFromFloor).toBe(1);
    } finally {
      (globalThis as Record<string, unknown>).document = prevDoc;
    }
  });
});

