/**
 * Pure view-model tests for the UI-parity client (docs/design/ui-parity-plan.md, Phases 0/2/4).
 * No DOM: every function under test is a pure helper exported from src/ui/* or src/state.ts.
 */
import { describe, expect, it } from 'vitest';
import type { BoardRow, ValueSample } from '@warehouse/protocol';
import { createWorld, type Card, type CardHand, type Vehicle } from '@warehouse/sim';
import { clockLine, onTimeText, DASH } from '../../src/ui/format.js';
import { initialOfferSel, keepIds, keepLabel, toggleOfferSel } from '../../src/ui/cards.js';
import { commandBarView } from '../../src/ui/commandBar.js';
import { fleetView } from '../../src/ui/fleet.js';
import { kpiSummary } from '../../src/ui/kpiBar.js';
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
    expect(resolveHotkey(key('KeyL'), base)).toBe('leaderboardModal');
    expect(resolveHotkey(key('Digit2'), base)).toBe('layer:traffic');
    expect(resolveHotkey(key('KeyC'), base)).toBe('cones');
    expect(resolveHotkey(key('Slash', '?'), base)).toBe('help');
    expect(resolveHotkey(key('KeyT'), base)).toBeNull();
    expect(resolveHotkey(key('KeyT'), { ...base, selectedVid: 'v3' })).toBe('takeWheel');
  });

  it('Esc: hand back > leaderboardModal > exit cone > deselect', () => {
    expect(resolveHotkey(key('Escape'), { ...base, canHandBack: true, coneMode: true })).toBe('handBack');
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

describe('KPI summary, Fleet panel view, and Command bar view', () => {
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

  it('commandBarView reflects active Rush wave countdown, open P0 count, cone mode, and ops guide state', () => {
    const idle = commandBarView({
      welcomed: true,
      conn: { status: 'open', text: '' },
      coneMode: false,
      world: {
        t: 100,
        rushUntil: 90,
        orders: [{ p0: true, state: 'delivered' as const }, { p0: false, state: 'open' as const }],
      },
      isDriving: () => false,
      ui: { opsGuideOpen: false },
    });
    expect(idle.ready).toBe(true);
    expect(idle.rushActive).toBe(false);
    expect(idle.rushText).toBe('⚡ Rush wave');
    expect(idle.p0Active).toBe(false);
    expect(idle.p0Text).toBe('★ P0 order');

    const active = commandBarView({
      welcomed: true,
      conn: { status: 'open', text: '' },
      coneMode: true,
      world: {
        t: 100,
        rushUntil: 118.2,
        orders: [
          { p0: true, state: 'open' as const },
          { p0: true, state: 'claimed' as const },
          { p0: true, state: 'delivered' as const },
        ],
      },
      isDriving: () => true,
      ui: { opsGuideOpen: true },
    });
    expect(active.rushActive).toBe(true);
    expect(active.rushText).toBe('⚡ Rush (19m)');
    expect(active.p0Active).toBe(true);
    expect(active.p0Text).toBe('★ P0 (2/4)');
    expect(active.conesActive).toBe(true);
    expect(active.opsGuideOpen).toBe(true);
    expect(active.driving).toBe(true);
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

  it('maps KeyG to agentDesigner and Escape to closeAgentDesigner or engageCopilot when manual driving', () => {
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
    expect(resolveHotkey({ code: 'Escape', key: 'Escape' }, base)).toBe('engageCopilot');
    // When already in autopilot, Esc falls through to deselect
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
    expect(formatBlitzRemaining(60)).toBe('01:00');
    expect(formatBlitzRemaining(15)).toBe('00:15');
    expect(formatBlitzRemaining({ runMode: 'blitz', runStartedAt: 100, runEndsAt: 400 }, 100)).toBe('05:00');
    expect(formatBlitzRemaining({ runMode: 'blitz', runStartedAt: 100, runEndsAt: 400 }, 340)).toBe('01:00');
    expect(formatBlitzRemaining({ runMode: 'blitz', runStartedAt: null, runEndsAt: null }, 100)).toBe('05:00');
  });
});



