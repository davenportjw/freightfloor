/**
 * Daily Shift client wiring (retention spec §2): store state for the private daily messages,
 * the intro pill text, the results-sheet lines, the run capsule's Daily mode, and the
 * `/api/daily` fetch. The `fetch` passed to `fetchDailyBoard` is a test double.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  dailyInfoFor,
  type DailyResultMessage,
  type DailyStatusMessage,
  type WelcomeMessage,
} from '@warehouse/protocol';
import { createWorld, serialize, type Vehicle } from '@warehouse/sim';
import { ClientStore } from '../src/state.js';
import { dailyPillText } from '../src/ui/help.js';
import { dailyRankText, dailyStreakText } from '../src/ui/runEnd.js';
import { runCapsuleView } from '../src/ui/runCapsule.js';
import { fetchDailyBoard } from '../src/net.js';

const DAY = '2026-11-12';
const info = dailyInfoFor(DAY);

const result = (over: Partial<DailyResultMessage> = {}): DailyResultMessage => ({
  type: 'dailyResult',
  dailyKey: DAY,
  pts: 900,
  dailyBest: 900,
  improved: true,
  dailyRank: 7,
  dailyOf: 213,
  attempts: 1,
  streak: 6,
  streakDelta: 1,
  ...over,
});

const status = (over: Partial<DailyStatusMessage> = {}): DailyStatusMessage => ({
  type: 'dailyStatus',
  dailyKey: DAY,
  streak: 5,
  bestStreak: 5,
  playedToday: false,
  ...over,
});

function welcome(dayKey: string): WelcomeMessage {
  return {
    type: 'welcome',
    you: { role: 'spectator', siteId: 'den-1', vid: null, name: 'Swift-Pallet' },
    snapshot: serialize(createWorld({ seed: 42, agents: 0 })),
    daily: dailyInfoFor(dayKey),
  } as unknown as WelcomeMessage;
}

describe('ClientStore daily state', () => {
  it('a dailyResult advances my streak status (played today, best kept)', () => {
    const store = new ClientStore();
    store.applyDailyStatus(status({ streak: 5, bestStreak: 9 }));
    store.dailyResultError = 'old error';
    store.applyDailyResult(result({ streak: 6 }));
    expect(store.dailyResult?.dailyRank).toBe(7);
    expect(store.dailyResultError).toBeNull();
    expect(store.dailyStatus).toEqual(status({ streak: 6, bestStreak: 9, playedToday: true }));
  });

  it('clearRunResults forgets the previous run but keeps the streak status', () => {
    const store = new ClientStore();
    store.applyRunSummary({ type: 'runSummary', runMode: 'daily', pts: 1, deliveries: 1, tape: 'O', dailyKey: DAY });
    store.applyDailyResult(result());
    store.dailyResultError = 'x';
    store.clearRunResults();
    expect(store.runSummary).toBeNull();
    expect(store.dailyResult).toBeNull();
    expect(store.dailyResultError).toBeNull();
    expect(store.dailyStatus?.playedToday).toBe(true);
  });

  it('welcome stores today and a new day resets the status and board', () => {
    const store = new ClientStore();
    expect(store.applyWelcome(welcome(DAY))).toBeNull();
    expect(store.daily?.dayKey).toBe(DAY);
    store.applyDailyStatus(status());
    store.dailyBoard = { status: 'ready', data: null, error: null, updatedAt: 1 };
    store.applyWelcome(welcome(DAY));
    expect(store.dailyStatus).not.toBeNull();
    store.applyWelcome(welcome('2026-11-13'));
    expect(store.daily?.dayKey).toBe('2026-11-13');
    expect(store.dailyStatus).toBeNull();
    expect(store.dailyBoard.status).toBe('idle');
  });
});

describe('intro Daily pill', () => {
  it('shows number, modifier and a live streak for the same day', () => {
    expect(dailyPillText(info, null)).toBe(`📅 Daily #${info.number} · ${info.modifier.label}`);
    expect(dailyPillText(info, status({ streak: 5 }))).toBe(`📅 Daily #${info.number} · ${info.modifier.label} · 🔥5`);
    expect(dailyPillText(info, status({ streak: 5, playedToday: true }))).toMatch(/🔥5 ✓$/);
    expect(dailyPillText(info, status({ streak: 0 }))).not.toContain('🔥');
    // A status for another day is ignored.
    expect(dailyPillText(info, status({ dailyKey: '2026-11-11', streak: 3 }))).not.toContain('🔥');
  });
});

describe('results sheet Daily lines', () => {
  it('rank line: recorded, save error, or saving', () => {
    expect(dailyRankText(result(), null)).toBe('#7 of 213 today · new best today');
    expect(dailyRankText(result({ improved: false, dailyBest: 1840 }), null)).toBe('#7 of 213 today · best today 1,840');
    expect(dailyRankText(null, 'Could not record your Daily result.')).toBe('Daily not saved: Could not record your Daily result.');
    expect(dailyRankText(null, null)).toBe('Saving your Daily…');
  });

  it('streak line: extended, started, reset, repeat attempt', () => {
    expect(dailyStreakText(result({ streak: 6, streakDelta: 1 }), null)).toBe('🔥 6 — extended!');
    expect(dailyStreakText(result({ streak: 1, streakDelta: 1 }), status({ bestStreak: 1 }))).toBe('🔥 1 — streak started');
    expect(dailyStreakText(result({ streak: 1, streakDelta: 1 }), status({ bestStreak: 4 }))).toBe('🔥 1 — streak reset · best 🔥4');
    expect(dailyStreakText(result({ streak: 3, streakDelta: 0, attempts: 2 }), null)).toBe('🔥 3 · attempt 2 today');
  });
});

describe('run capsule Daily mode', () => {
  const me = (over: Partial<Vehicle>): Vehicle =>
    ({ id: 'v2', runMode: 'daily', runEndsAt: 400, runStartedAt: 100, runPts: 10, streak: 0, combo: 1, ...over }) as unknown as Vehicle;

  it('runs a clock like Blitz with the Daily number and modifier tooltip', () => {
    const v = runCapsuleView(me({}), { t: 340 }, [{ id: 'v2' }], null, { number: 42, modifierLabel: 'Cold Chain Day' });
    expect(v.mode).toBe('daily');
    expect(v.clock).toBe('01:00');
    expect(v.clockSub).toBe('Daily #42');
    expect(v.modifier).toBe('Cold Chain Day');
    expect(v.overdrive).toBe(true);
    const idle = runCapsuleView(me({ runEndsAt: null as never }), { t: 0 }, [], null, null);
    expect(idle.clockSub).toBe('Daily · starts on move');
  });
});

describe('fetchDailyBoard', () => {
  const board = { info, top: [{ publicId: 'p1', name: 'Ace', pts: 50, streak: 2, siteId: 'den-1' }], entrants: 1, you: { rank: 1, bestPts: 50, attempts: 1 } };

  it('passes my publicId and validates the payload', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(board), { status: 200 }));
    const res = await fetchDailyBoard('p 1', fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledWith('/api/daily?publicId=p%201');
    expect(res).toEqual({ ok: true, data: board });
  });

  it('surfaces lobby errors and bad payloads', async () => {
    const down = vi.fn(async () => new Response(JSON.stringify({ error: 'daily_unavailable', message: 'The Daily board is unavailable.' }), { status: 503 }));
    const res = await fetchDailyBoard(null, down as unknown as typeof fetch);
    expect(down).toHaveBeenCalledWith('/api/daily');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('/api/daily');
    const bad = vi.fn(async () => new Response(JSON.stringify({ top: 'nope' }), { status: 200 }));
    expect(await fetchDailyBoard(null, bad as unknown as typeof fetch)).toEqual({ ok: false, error: '/api/daily returned an unexpected payload' });
    const thrown = vi.fn(async () => Promise.reject(new Error('offline')));
    expect(await fetchDailyBoard(null, thrown as unknown as typeof fetch)).toEqual({ ok: false, error: 'offline' });
  });
});
