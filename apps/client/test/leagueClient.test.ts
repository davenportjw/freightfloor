/**
 * Weekly League client wiring (retention spec §5): store state for the private `leagueResult`,
 * the results-sheet line, the This Week countdown, the intro podium pill + dismissal, and the
 * `/api/league` fetch. The `fetch` passed to `fetchLeagueBoard` is a test double.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LeagueResponse, LeagueResultMessage } from '@warehouse/protocol';
import { ClientStore } from '../src/state.js';
import { fetchLeagueBoard } from '../src/net.js';
import {
  dismissPodium,
  isPodiumDismissed,
  leagueEndsInText,
  leagueLineText,
  podiumDismissKey,
  podiumPillText,
} from '../src/ui/league.js';

const WEEK = '2026-W46';

const result = (over: Partial<LeagueResultMessage> = {}): LeagueResultMessage => ({
  type: 'leagueResult',
  weekKey: WEEK,
  pts: 212,
  weekPts: 1_412,
  delta: 212,
  counted: true,
  runsCounted: 4,
  rank: 14,
  of: 90,
  ...over,
});

const board = (over: Partial<LeagueResponse> = {}): LeagueResponse => ({
  weekKey: WEEK,
  endsAt: Date.UTC(2026, 10, 16),
  top: [{ publicId: 'p1', name: 'Ada', weekPts: 900, runs: 3, siteId: 'den-1' }],
  entrants: 1,
  you: { rank: 1, weekPts: 900, runsCounted: 3 },
  finalized: false,
  ...over,
});

class MemStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
}

describe('league store state', () => {
  it('opens the leaderboard modal on This Week by default', () => {
    expect(new ClientStore().ui.leaderboardModalTab).toBe('week');
  });

  it('a counted result marks the This Week board stale; clearRunResults resets the run fields', () => {
    const store = new ClientStore();
    store.leagueBoard = { status: 'ready', data: board(), error: null, updatedAt: 123 };
    store.leagueResultError = 'old';
    store.applyLeagueResult(result());
    expect(store.leagueResult?.rank).toBe(14);
    expect(store.leagueResultError).toBeNull();
    expect(store.leagueBoard.updatedAt).toBeNull();
    store.clearRunResults();
    expect(store.leagueResult).toBeNull();
    expect(store.leagueResultError).toBeNull();
  });

  it('an uncounted result leaves the board fresh', () => {
    const store = new ClientStore();
    store.leagueBoard = { status: 'ready', data: board(), error: null, updatedAt: 123 };
    store.applyLeagueResult(result({ counted: false, delta: 0 }));
    expect(store.leagueBoard.updatedAt).toBe(123);
  });
});

describe('leagueLineText', () => {
  it('shows rank and gain for counted runs', () => {
    expect(leagueLineText(result({ delta: 1_212 }), null)).toBe('League: #14 this week (+1,212)');
  });
  it('explains uncounted runs', () => {
    expect(leagueLineText(result({ counted: false, delta: 0 }), null)).toBe(
      "League: #14 this week · didn't beat your 10th-best run",
    );
  });
  it('surfaces the real save error, and nothing when no league message arrived', () => {
    expect(leagueLineText(null, 'store down')).toBe('League not saved: store down');
    expect(leagueLineText(null, null)).toBe('');
  });
});

describe('leagueEndsInText', () => {
  const end = Date.UTC(2026, 10, 16);
  it('formats days, hours, minutes, and ended', () => {
    expect(leagueEndsInText(end, end - (3 * 24 + 4) * 3_600_000 - 5)).toBe('ends in 3d 4h');
    expect(leagueEndsInText(end, end - (2 * 60 + 5) * 60_000)).toBe('ends in 2h 5m');
    expect(leagueEndsInText(end, end - 10_000)).toBe('ends in 1m');
    expect(leagueEndsInText(end, end)).toBe('ended');
  });
});

describe('podium pill', () => {
  const podium = [
    { rank: 2, publicId: 'p2', name: 'Bo', weekPts: 800 },
    { rank: 1, publicId: 'p1', name: 'Ada', weekPts: 1_900 },
  ];
  it('renders a finalized podium in rank order', () => {
    expect(podiumPillText(board({ finalized: true, podium }))).toBe('🏆 Last week: 1. Ada 1,900 · 2. Bo 800');
  });
  it('hides for unfinalized weeks, empty podiums, and missing data', () => {
    expect(podiumPillText(board({ finalized: false, podium }))).toBeNull();
    expect(podiumPillText(board({ finalized: true, podium: [] }))).toBeNull();
    expect(podiumPillText(null)).toBeNull();
  });
  it('remembers dismissal per week', () => {
    const storage = new MemStorage();
    expect(isPodiumDismissed(storage, WEEK)).toBe(false);
    dismissPodium(storage, WEEK);
    expect(storage.getItem(podiumDismissKey(WEEK))).toBe('1');
    expect(isPodiumDismissed(storage, WEEK)).toBe(true);
    expect(isPodiumDismissed(storage, '2026-W47')).toBe(false);
    expect(isPodiumDismissed(null, WEEK)).toBe(false);
  });
});

describe('fetchLeagueBoard', () => {
  it('requests the week with my publicId and validates the payload', async () => {
    const data = board();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(data), { status: 200 }));
    const res = await fetchLeagueBoard('current', 'p 1', fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledWith('/api/league?week=current&publicId=p%201');
    expect(res).toEqual({ ok: true, data });
  });

  it('surfaces lobby errors and bad payloads', async () => {
    const down = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'league_unavailable', message: 'The league board is unavailable.' }), {
          status: 503,
        }),
    );
    const res = await fetchLeagueBoard('previous', null, down as unknown as typeof fetch);
    expect(down).toHaveBeenCalledWith('/api/league?week=previous');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('/api/league');

    const bad = vi.fn(async () => new Response(JSON.stringify({ weekKey: 'nope' }), { status: 200 }));
    expect(await fetchLeagueBoard('current', null, bad as unknown as typeof fetch)).toEqual({
      ok: false,
      error: '/api/league returned an unexpected payload',
    });
  });
});
