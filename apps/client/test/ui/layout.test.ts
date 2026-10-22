/**
 * Pure view-model tests for the HUD v3 layout (DRIVE vs FLOOR modes, sheets, Floor orders).
 * No DOM: every function under test is a pure helper exported from src/ui/*, src/render/orders.ts
 * or the ClientStore's local countdown.
 */
import { describe, expect, it } from 'vitest';
import type { BoardRow, FloorOrdersStatus, SiteLimits } from '@warehouse/protocol';
import { bayAt, chargerAt, createWorld, isBlocked, type Card, type Vehicle } from '@warehouse/sim';
import { activeOverlay, hudMode, pickSheetOpen } from '../../src/ui/mode.js';
import { offerKey } from '../../src/ui/cards.js';
import { runCapsuleView } from '../../src/ui/runCapsule.js';
import { ordinal, rankStylesPerTruck, standingsHeadline } from '../../src/ui/teamStandings.js';
import { dispatchMax, fleetStepper, floorOrderButtons } from '../../src/ui/floorOrders.js';
import { FEED_MAX, FEED_TTL_MS, feedRows, feedTone } from '../../src/ui/floorView.js';
import { gapToNext } from '../../src/ui/standings.js';
import { contractsLine, resultsPosition, selectRunEndRows } from '../../src/ui/runEnd.js';
import { progressSegments } from '../../src/ui/contracts.js';
import { alertView } from '../../src/ui/objective.js';
import { coneTileError, dispatchRackZones } from '../../src/render/orders.js';
import { ClientStore, defaultContractsCollapsed, type RunEndLeaderboardRow } from '../../src/state.js';
import { DASH } from '../../src/ui/format.js';
import { touchControlsView } from '../../src/ui/touchControls.js';

const card = (id: string, status = 'offer'): Card => ({ id, status, title: id, progress: 0, goal: 1 }) as unknown as Card;

describe('hudMode / activeOverlay', () => {
  it('DRIVE while holding a wheel; FLOOR otherwise or after "Watch the floor"', () => {
    expect(hudMode({ driving: false, myVid: null, runFinished: false, runEndDismissedVid: null })).toBe('floor');
    expect(hudMode({ driving: true, myVid: 'v1', runFinished: false, runEndDismissedVid: null })).toBe('driving');
    expect(hudMode({ driving: true, myVid: 'v1', runFinished: true, runEndDismissedVid: null })).toBe('driving');
    expect(hudMode({ driving: true, myVid: 'v1', runFinished: true, runEndDismissedVid: 'v1' })).toBe('floor');
    // A dismissal for an older vehicle does not hide the new run.
    expect(hudMode({ driving: true, myVid: 'v2', runFinished: true, runEndDismissedVid: 'v1' })).toBe('driving');
  });

  it('pick sheet = initial deal only, while driving, until minimised for that offer', () => {
    const offer = [card('a'), card('b'), card('c')];
    const hand = { offer, pick: null } as never;
    expect(pickSheetOpen({ mode: 'driving', hand, dealMinimizedKey: null })).toBe(true);
    expect(pickSheetOpen({ mode: 'floor', hand, dealMinimizedKey: null })).toBe(false);
    expect(pickSheetOpen({ mode: 'driving', hand, dealMinimizedKey: offerKey(offer) })).toBe(false);
    // Replacement draw ("pick 1") lives in the contracts card, not the sheet.
    expect(pickSheetOpen({ mode: 'driving', hand: { offer, pick: 1 } as never, dealMinimizedKey: null })).toBe(false);
    expect(pickSheetOpen({ mode: 'driving', hand: { offer: null, pick: null } as never, dealMinimizedKey: null })).toBe(false);
  });

  it('results > pick > explicit overlay', () => {
    const hand = { offer: [card('a')], pick: null } as never;
    const base = { mode: 'driving' as const, hand, dealMinimizedKey: null, overlay: 'chat' as const };
    expect(activeOverlay({ ...base, runEndOpen: true })).toBe('results');
    expect(activeOverlay({ ...base, runEndOpen: false })).toBe('pick');
    expect(activeOverlay({ ...base, runEndOpen: false, hand: null })).toBe('chat');
    expect(activeOverlay({ ...base, runEndOpen: false, hand: null, overlay: null })).toBeNull();
  });
});

describe('run capsule', () => {
  const me = (over: Partial<Vehicle>): Vehicle =>
    ({ id: 'v2', runMode: 'blitz', runEndsAt: 400, runStartedAt: 100, runPts: 41.6, streak: 3, combo: 1.5, ...over }) as unknown as Vehicle;
  const rows = [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }];

  it('reads clock, points, position and ▲/▼ from live data', () => {
    const v = runCapsuleView(me({}), { t: 340 }, rows, 3);
    expect(v.mode).toBe('blitz');
    expect(v.clock).toBe('01:00');
    expect(v.overdrive).toBe(true);
    expect(v.pts).toBe('42');
    expect(v.streak).toBe(3);
    expect(v.pos).toBe('P2');
    expect(v.posSub).toBe('of 3');
    expect(v.delta).toBe(1);
  });

  it('shows — when the Blitz has not started or the vehicle is not ranked', () => {
    const v = runCapsuleView(me({ runEndsAt: null as never }), { t: 0 }, [{ id: 'v9' }], null);
    expect(v.clock).toBe(DASH);
    expect(v.clockSub).toContain('starts on move');
    expect(v.pos).toBe(DASH);
    expect(v.delta).toBeNull();
    expect(v.overdrive).toBe(false);
  });
});

describe('Team Standings (per-truck ranking)', () => {
  const row = (strat: string, vehicles: number, perHr: number): BoardRow =>
    ({ strat, vehicles, perHr, count: 0, onTimePct: null, incidents: 0 }) as unknown as BoardRow;

  it('ranks by orders/hr per truck, trucks-less styles last', () => {
    const ranked = rankStylesPerTruck([row('Sprinter', 4, 40), row('Human', 1, 12), row('Batcher', 0, 0), row('Steady', 2, 16)]);
    expect(ranked.map((r) => r.row.strat)).toEqual(['Human', 'Sprinter', 'Steady', 'Batcher']);
    expect(ranked[0].perTruck).toBe(12);
    expect(ranked[3].perTruck).toBeNull();
    expect(standingsHeadline(ranked)).toBe('Humans rank 1st of 4 driving styles');
  });

  it('headline without humans or rows; ordinals', () => {
    expect(standingsHeadline([])).toMatch(/No deliveries/);
    expect(standingsHeadline(rankStylesPerTruck([row('Sprinter', 1, 3)]))).toMatch(/no human drivers/);
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
  });
});

describe('Floor orders bar', () => {
  const limits = { maxOpenP0: 4, conesPerPlayer: 5, coneTtlGameMin: 120, dispatchMaxCount: 6 } as SiteLimits;
  const status: FloorOrdersStatus = {
    rush: { readyInMs: 0 },
    p0: { open: 1, readyInMs: 0 },
    cones: { mine: ['3,4'] },
    dispatch: { readyInMs: 0 },
    fleet: { addReadyInMs: 0, removable: 1 },
    nl: { left: 6, resetInMs: 0 },
  };
  const ui = { coneMode: false, dispatchOpen: false };

  it('every button is disabled with a reason and shows — before the status arrives', () => {
    const b = floorOrderButtons(null, null, { t: 0 }, ui);
    expect(b.map((x) => x.id)).toEqual(['rush', 'p0', 'cones', 'dispatch']);
    for (const x of b.filter((x) => x.id !== 'cones')) {
      expect(x.disabled).toBe(true);
      expect(x.detail).toBe(DASH);
      expect(x.title).toMatch(/Waiting/);
    }
    expect(b[2].detail).toBe(`${DASH}/${DASH}`);
  });

  it('handles a status with missing fields (older site)', () => {
    const b = floorOrderButtons({ rush: { readyInMs: 0 } }, limits, { t: 0 }, ui);
    expect(b[0].state).toBe('ready');
    expect(b[1].disabled).toBe(true);
    expect(b[1].detail).toBe(DASH);
    expect(b[2].detail).toBe(`${DASH}/5`);
    expect(b[3].disabled).toBe(true);
  });

  it('ready / cooling / capped / active states', () => {
    const ready = floorOrderButtons(status, limits, { t: 0 }, ui);
    expect(ready.map((x) => x.state)).toEqual(['ready', 'ready', 'ready', 'ready']);
    expect(ready[1].detail).toBe('1/4');
    expect(ready[2].detail).toBe('1/5');

    const cool = floorOrderButtons({ ...status, rush: { readyInMs: 9500 }, dispatch: { readyInMs: 3000 } }, limits, { t: 0 }, ui, { rush: 19000 });
    expect(cool[0].state).toBe('cool');
    expect(cool[0].detail).toBe('10s');
    expect(cool[0].ring).toBeCloseTo(0.5, 2);
    expect(cool[0].title).toMatch(/ready in 10s/);
    expect(cool[3].ring).toBe(1); // no total tracked yet → full ring

    const capped = floorOrderButtons({ ...status, p0: { open: 4, readyInMs: 0 } }, limits, { t: 0 }, ui);
    expect(capped[1].disabled).toBe(true);
    expect(capped[1].title).toMatch(/4\/4/);

    const active = floorOrderButtons(status, limits, { t: 100, rushUntil: 115 }, { coneMode: true, dispatchOpen: true });
    expect(active[0].state).toBe('active');
    expect(active[0].detail).toBe('15m');
    expect(active[0].ring).toBeCloseTo(0.5, 2);
    expect(active[2].state).toBe('active');
    expect(active[3].state).toBe('active');
    expect(active[3].disabled).toBe(false);
  });

  it('ClientStore.floorOrdersNow counts cooldowns down locally from the last server status', () => {
    const store = new ClientStore();
    expect(store.floorOrdersNow()).toBeNull();
    store.floorOrders = { ...status, rush: { readyInMs: 5000 }, fleet: { addReadyInMs: 800, removable: 2 }, nl: { left: 3, resetInMs: 20000 } };
    store.floorOrdersAt = 1_000;
    const now = store.floorOrdersNow(3_000)!;
    expect(now.rush.readyInMs).toBe(3000);
    expect(now.fleet.addReadyInMs).toBe(0);
    expect(now.fleet.removable).toBe(2);
    expect(now.nl).toEqual({ left: 3, resetInMs: 18000 });
    expect(now.cones.mine).toEqual(['3,4']);
  });

  it('fleet stepper: waits for status, honours the shared cooldown and removable count', () => {
    const vehicles = [
      { id: 'a', human: false, extra: true },
      { id: 'b', human: false, extra: false },
      { id: 'h', human: true, extra: false },
    ] as unknown as Vehicle[];
    const fl = { fleetCap: 24, maxTier: 4, baseFleet: 8, tierStep: 4 } as SiteLimits;
    expect(fleetStepper(vehicles, 0, fl, false, null)).toMatchObject({ count: DASH, canAdd: false, canRemove: false });
    expect(fleetStepper(vehicles, 0, fl, true, null).addTitle).toMatch(/Waiting/);
    const ok = fleetStepper(vehicles, 0, fl, true, status);
    expect(ok).toMatchObject({ count: '2', canAdd: true, canRemove: true });
    const cooling = fleetStepper(vehicles, 0, fl, true, { ...status, fleet: { addReadyInMs: 4100, removable: 1 } });
    expect(cooling.canAdd).toBe(false);
    expect(cooling.addTitle).toMatch(/ready in 5s/);
    const none = fleetStepper(vehicles, 0, fl, true, { ...status, fleet: { addReadyInMs: 0, removable: 0 } });
    expect(none.canRemove).toBe(false);
    expect(none.removeTitle).toMatch(/No agent can be removed/);
  });

  it('dispatchMax clamps to the site limit / schema cap', () => {
    expect(dispatchMax({ dispatchMaxCount: 3 } as SiteLimits)).toBe(3);
    expect(dispatchMax(null)).toBeGreaterThanOrEqual(1);
  });
});

describe('floor feed', () => {
  it('keeps at most FEED_MAX recent rows and marks the last second as fading', () => {
    const now = 100_000;
    const arrived = [0, 1, 2, 3].map((i) => ({ ev: i, at: now - i * 100 }));
    expect(feedRows(arrived, now).length).toBe(FEED_MAX);
    expect(feedRows([{ ev: 1, at: now - FEED_TTL_MS }], now)).toEqual([]);
    expect(feedRows([{ ev: 1, at: now - FEED_TTL_MS + 500 }], now)[0].fading).toBe(true);
    expect(feedRows([{ ev: 1, at: now - 10 }], now)[0].fading).toBe(false);
  });

  it('tones: mine → you, else by type; noise skipped', () => {
    expect(feedTone({ type: 'deliver', vid: 'v1' }, 'v1', null)).toBe('you');
    expect(feedTone({ type: 'deliver' } as never, null, null)).toBe('good');
    expect(feedTone({ type: 'incident' } as never, null, null)).toBe('bad');
    expect(feedTone({ type: 'rush' } as never, null, null)).toBe('warn');
    expect(feedTone({ type: 'nearmiss' } as never, null, null)).toBeNull();
  });
});

describe('standings + results sheets', () => {
  it('gapToNext: points to pass the driver above', () => {
    const rows = [{ id: 'a', pts: 50 }, { id: 'b', pts: 41.2 }, { id: 'c', pts: 10 }];
    expect(gapToNext(rows, 'b')).toEqual({ gap: 9, aheadId: 'a' });
    expect(gapToNext(rows, 'a')).toBeNull();
    expect(gapToNext(rows, 'zz')).toBeNull();
    expect(gapToNext(rows, null)).toBeNull();
  });

  it('resultsPosition shows ▲/▼ only when the start rank is known', () => {
    expect(resultsPosition({ rank: 2, totalVehicles: 9 }, 5)).toEqual({ value: 'P2/9', sub: '▲3 from start' });
    expect(resultsPosition({ rank: 6, totalVehicles: 9 }, 4).sub).toBe('▼2 from start');
    expect(resultsPosition({ rank: 4, totalVehicles: 9 }, 4).sub).toBe('same as start');
    expect(resultsPosition({ rank: 4, totalVehicles: 9 }, null).sub).toBe('final position');
  });

  it('contractsLine marks done ✓ and everything else ✕', () => {
    expect(contractsLine([])).toBe('No contracts this run.');
    expect(contractsLine([{ title: 'Bay sweep', status: 'done' }, { title: 'Cold run', status: 'active' }])).toBe('✓ Bay sweep  ·  ✕ Cold run');
  });

  it('selectRunEndRows prioritizes Top 3, current player run, neighbors, and past runs, and filters human runs', () => {
    const mkRow = (rank: number, id: string, driver: string, over: Partial<RunEndLeaderboardRow> = {}): RunEndLeaderboardRow => ({
      rank,
      id,
      driver,
      baseName: driver,
      runNumber: 1,
      score: 300 - rank * 20,
      deliveries: 10,
      ppm: 2.0,
      onTimePct: 100,
      bestStreak: 4,
      incidents: 0,
      isYou: false,
      isYourPastRun: false,
      isHuman: false,
      isArchived: false,
      ...over,
    });

    const rows: RunEndLeaderboardRow[] = [
      mkRow(1, 'ai-1', 'Sprinter-1'),
      mkRow(2, 'ai-2', 'Batcher-2'),
      mkRow(3, 'h-other', 'Casey Run 1', { isHuman: true, baseName: 'Casey' }),
      mkRow(4, 'ai-3', 'Steady-3'),
      mkRow(5, 'ai-4', 'Opportunist-4'),
      mkRow(6, 'me-past', 'Alex Run 1', { isHuman: true, isYourPastRun: true, isArchived: true, baseName: 'Alex', runNumber: 1 }),
      mkRow(7, 'ai-5', 'Strategist-5'),
      mkRow(8, 'me-now', 'Alex Run 2', { isHuman: true, isYou: true, baseName: 'Alex', runNumber: 2 }),
      mkRow(9, 'ai-6', 'Sprinter-6'),
    ];

    const allSelected = selectRunEndRows(rows, 'all', 6);
    expect(allSelected).toHaveLength(6);
    // Must include top 3, current run ('me-now'), immediate neighbor ('ai-5'), and past run ('me-past')
    expect(allSelected.map((r) => r.id)).toEqual(['ai-1', 'ai-2', 'h-other', 'me-past', 'ai-5', 'me-now']);

    const humansSelected = selectRunEndRows(rows, 'humans', 6);
    expect(humansSelected.map((r) => r.id)).toEqual(['h-other', 'me-past', 'me-now']);
    expect(humansSelected.every((r) => r.isHuman)).toBe(true);
  });
});

describe('contracts card + alerts', () => {
  it('progressSegments: one segment per step up to 10, proportional beyond', () => {
    expect(progressSegments(2, 4, false)).toEqual({ n: 4, on: 2 });
    expect(progressSegments(3, 4, true)).toEqual({ n: 4, on: 4 });
    expect(progressSegments(10, 20, false)).toEqual({ n: 10, on: 5 });
    expect(progressSegments(-1, 3, false)).toEqual({ n: 3, on: 0 });
  });

  it('alertView: flat/low battery beats a nearby spill', () => {
    expect(alertView({ battery: 0, tile: { x: 0, y: 0 } }, [])?.tone).toBe('bad');
    expect(alertView({ battery: 90, tile: { x: 5, y: 5 } }, [{ x: 6, y: 5 }])).toMatchObject({ tone: 'warn' });
    expect(alertView({ battery: 90, tile: { x: 5, y: 5 } }, [{ x: 40, y: 40 }])).toBeNull();
    expect(alertView({ battery: 90, tile: { x: 5, y: 5 } }, null)).toBeNull();
  });
});

describe('map overlays (render/orders)', () => {
  it('dispatchRackZones mirrors the sim source-zone table', () => {
    expect(dispatchRackZones('haz')).toEqual(['Z']);
    expect(dispatchRackZones('general')).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(dispatchRackZones('any')).toContain('W');
    expect(dispatchRackZones('B')).toEqual(['B']);
    expect(dispatchRackZones('nope')).toEqual([]);
  });

  it('coneTileError mirrors sim toggleCone validity', () => {
    const w = createWorld({ seed: 42, agents: 0 });
    w.orders = [];
    let open: { x: number; y: number } | null = null;
    for (let y = 1; y < w.map.h - 1 && !open; y++) {
      for (let x = 1; x < w.map.w - 1 && !open; x++) {
        if (!isBlocked(w, x, y) && !bayAt(w.map, x, y) && chargerAt(w.map, x, y) < 0) open = { x, y };
      }
    }
    expect(open).not.toBeNull();
    const { x, y } = open!;
    expect(coneTileError(w, x, y)).toBeNull();
    expect(coneTileError(w, 0, 0)).toMatch(/open floor/);
    w.cones.add(`${x},${y}`);
    expect(coneTileError(w, x, y)).toBeNull(); // existing cone: click removes it
    w.cones.clear();
    w.vehicles = [{ tile: { x, y } } as unknown as Vehicle];
    expect(coneTileError(w, x, y)).toMatch(/vehicle/);
  });
});

describe('mobile HUD + touch controls view-model', () => {
  it('collapses contracts by default on mobile viewports and keeps expanded on desktop', () => {
    expect(defaultContractsCollapsed({ width: 390, height: 844 })).toBe(true);
    expect(defaultContractsCollapsed({ width: 844, height: 390 })).toBe(true);
    expect(defaultContractsCollapsed({ width: 1440, height: 900 })).toBe(false);
  });

  it('touchControlsView shows only when actively driving with no modal overlay and adapts contextual action button', () => {
    const me = { battery: 80, autopilot: false, runFinished: false, orders: [], cargo: [] } as unknown as Vehicle;
    const base = {
      hudMode: 'driving' as const,
      activeOverlay: null,
      helpOpen: false,
      drawerOpen: false,
      leaderboardOpen: false,
      agentDesignerOpen: false,
      me,
      guide: null,
      fareOffer: null,
      fareSel: 0,
      boostHeld: false,
    };

    // Hidden when sheet/modal overlay is open, or in floor mode
    expect(touchControlsView({ ...base, helpOpen: true }).visible).toBe(false);
    expect(touchControlsView({ ...base, activeOverlay: 'standings' }).visible).toBe(false);
    expect(touchControlsView({ ...base, hudMode: 'floor' }).visible).toBe(false);

    // Visible while driving; when no nearby guide in range and no fare choice, action button is neutral
    const idle = touchControlsView(base);
    expect(idle.visible).toBe(true);
    expect(idle.interactReady).toBe(false);
    expect(idle.interactLabel).toBe('Act');

    // When fareOffer is available and no order is reserved, action button offers quick-claim
    const withFare = touchControlsView({
      ...base,
      fareOffer: {
        options: [{ orderId: 42 } as never],
      } as never,
    });
    expect(withFare.interactReady).toBe(true);
    expect(withFare.interactLabel).toBe('Take #42');
    expect(withFare.interactSub).toBe('Claim');

    // In-range pickup guide overrides fareOffer with contextual Pick action
    const nearPick = touchControlsView({
      ...base,
      guide: { kind: 'pickup', text: 'Pick #42 → B2', inRange: true },
    });
    expect(nearPick.interactReady).toBe(true);
    expect(nearPick.interactLabel).toBe('Pick');
    expect(nearPick.interactTone).toBe('blue');
  });
});

describe('GitHub repository links (Intro modal and HUD)', () => {
  const EXPECTED_GITHUB_URL = 'https://github.com/davenportjw/freightfloor';

  it('renders #githubBtn in index.html HUD with expected href, target, rel, aria-label, and inline SVG icon', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const html = readFileSync(resolve(import.meta.dirname, '../../index.html'), 'utf8');

    const match = html.match(/<a\b[^>]*\bid="githubBtn"[^>]*>([\s\S]*?)<\/a>/);
    expect(match).not.toBeNull();
    const tag = match![0];
    const inner = match![1]!;

    expect(tag).toContain(`href="${EXPECTED_GITHUB_URL}"`);
    expect(tag).toContain('target="_blank"');
    expect(tag).toContain('rel="noopener noreferrer"');
    expect(tag).toContain('aria-label="View source on GitHub"');
    expect(tag).toContain('class="hud github-btn"');
    expect(inner).toContain('<svg');
    expect(inner).toContain('<path');

    const badgeMatch = html.match(/<div\b[^>]*\bid="brandBadge"[^>]*>([\s\S]*?)<\/div>/);
    expect(badgeMatch).not.toBeNull();
    expect(badgeMatch![0]).toContain('class="hud brand-badge"');
    expect(badgeMatch![1]).toContain('src="/favicon.svg"');
    expect(badgeMatch![1]).toContain('FREIGHT');
    expect(badgeMatch![1]).toContain('FLOOR');

    const css = readFileSync(resolve(import.meta.dirname, '../../src/styles.css'), 'utf8');
    const brandBlock = css.match(/#brandBadge\s*\{([^}]*)\}/)?.[1] ?? '';
    const kpisBlock = css.match(/#kpis\s*\{([^}]*)\}/)?.[1] ?? '';
    const brandOffset = Number(brandBlock.match(/calc\(var\(--gap\)\s*\+\s*(\d+)px\)/)?.[1] ?? NaN);
    const brandWidth = Number(brandBlock.match(/width:\s*(\d+)px/)?.[1] ?? NaN);
    const kpisOffset = Number(kpisBlock.match(/calc\(var\(--gap\)\s*\+\s*(\d+)px\)/)?.[1] ?? NaN);
    expect(brandOffset).toBe(108);
    expect(brandWidth).toBe(168);
    expect(kpisOffset).toBeGreaterThanOrEqual(brandOffset + brandWidth + 8);
  });

  it('mounts .intro-github-link inside the Intro modal header with expected href, target, rel, aria-label, and inline SVG icon', async () => {
    class MiniText {
      constructor(public data: string) {}
    }
    class MiniElement {
      tagName: string;
      className = '';
      hidden = false;
      value = '';
      dataset: Record<string, string> = {};
      attrs = new Map<string, string>();
      children: Array<MiniElement | MiniText> = [];
      listeners = new Map<string, Array<(ev: unknown) => void>>();
      classList: {
        contains: (cls: string) => boolean;
        add: (cls: string) => void;
        remove: (cls: string) => void;
        toggle: (cls: string, force?: boolean) => boolean;
      };

      constructor(tag: string) {
        this.tagName = tag.toUpperCase();
        const self = this;
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

    const prevDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = {
      createElement: (tag: string) => new MiniElement(tag),
      createElementNS: (_ns: string, tag: string) => new MiniElement(tag),
      createTextNode: (text: string) => new MiniText(text),
    };

    try {
      const { mountHelp } = await import('../../src/ui/help.js');
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

      mountHelp(overlay as unknown as HTMLElement, ctx);

      const ghLinks = overlay.queryAll((e) => e.tagName === 'A' && e.classList.contains('intro-github-link'));
      expect(ghLinks).toHaveLength(1);
      const ghLink = ghLinks[0]!;
      expect(ghLink.getAttribute('href')).toBe(EXPECTED_GITHUB_URL);
      expect(ghLink.getAttribute('target')).toBe('_blank');
      expect(ghLink.getAttribute('rel')).toBe('noopener noreferrer');
      expect(ghLink.getAttribute('aria-label')).toBe('View source on GitHub');

      const svgs = ghLink.queryAll((e) => e.tagName === 'SVG');
      expect(svgs).toHaveLength(1);

      const logos = overlay.queryAll((e) => e.tagName === 'IMG' && e.classList.contains('intro-logo-banner'));
      expect(logos).toHaveLength(1);
      expect(logos[0]!.getAttribute('src')).toBe('/assets/freightfloor-logo.svg');

      // Assigned callsign badge is rendered cleanly with no <datalist> or autocomplete input flashing
      const datalists = overlay.queryAll((e) => e.tagName === 'DATALIST');
      expect(datalists).toHaveLength(0);
      const callsignInputs = overlay.queryAll((e) => e.getAttribute('id') === 'introCallsign');
      expect(callsignInputs).toHaveLength(0);
      const badges = overlay.queryAll((e) => e.getAttribute('id') === 'introAssignedCallsign');
      expect(badges).toHaveLength(1);
    } finally {
      (globalThis as Record<string, unknown>).document = prevDoc;
    }
  });
});



