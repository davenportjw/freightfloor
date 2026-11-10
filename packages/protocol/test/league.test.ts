import { describe, expect, it } from 'vitest';
import {
  LEAGUE_TOP_RUNS,
  LeagueResponseSchema,
  LeagueResultMessageSchema,
  ServerMessageSchema,
  addWeeks,
  nextLeagueRuns,
  previousWeekKey,
  weekEndMs,
  weekKey,
  weekKeyToStartMs,
  weekStartMs,
} from '../src/index.js';

const utc = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);

describe('ISO week keys around year boundaries', () => {
  it('assigns week 53 and week 1 correctly', () => {
    expect(weekKey(utc(2026, 12, 31))).toBe('2026-W53');
    expect(weekKey(utc(2027, 1, 3, 23))).toBe('2026-W53');
    expect(weekKey(utc(2027, 1, 4))).toBe('2027-W01');
    expect(weekKey(utc(2020, 12, 31))).toBe('2020-W53');
    expect(weekKey(utc(2021, 1, 1))).toBe('2020-W53');
    expect(weekKey(utc(2024, 12, 30))).toBe('2025-W01');
    expect(weekKey(utc(2025, 12, 28))).toBe('2025-W52');
    expect(weekKey(utc(2025, 12, 29))).toBe('2026-W01');
  });

  it('round-trips week keys to their Monday start', () => {
    for (const key of ['2026-W53', '2027-W01', '2020-W53', '2025-W01', '2026-W46']) {
      const start = weekKeyToStartMs(key);
      expect(new Date(start).getUTCDay()).toBe(1);
      expect(weekKey(start)).toBe(key);
      expect(weekKey(start - 1)).not.toBe(key);
      expect(weekEndMs(key) - start).toBe(7 * 86_400_000);
      expect(weekKey(weekEndMs(key) - 1)).toBe(key);
    }
    expect(weekKeyToStartMs('2026-W46')).toBe(weekStartMs(utc(2026, 11, 12)));
  });

  it('rejects malformed and nonexistent weeks', () => {
    expect(() => weekKeyToStartMs('2025-W53')).toThrow();
    expect(() => weekKeyToStartMs('2026-W00')).toThrow();
    expect(() => weekKeyToStartMs('2026-W60')).toThrow();
    expect(() => weekKeyToStartMs('2026-46')).toThrow();
  });

  it('steps weeks across the year boundary', () => {
    expect(addWeeks('2026-W53', 1)).toBe('2027-W01');
    expect(addWeeks('2027-W01', -1)).toBe('2026-W53');
    expect(previousWeekKey(utc(2027, 1, 4))).toBe('2026-W53');
    expect(previousWeekKey(utc(2026, 11, 10, 12))).toBe('2026-W45');
  });
});

describe('nextLeagueRuns', () => {
  it('counts every positive run until the top runs are full', () => {
    let runs: number[] = [];
    for (let i = 1; i <= LEAGUE_TOP_RUNS; i += 1) {
      const u = nextLeagueRuns(runs, i * 10);
      expect(u.counted).toBe(true);
      expect(u.delta).toBe(i * 10);
      runs = u.topRuns;
    }
    expect(runs).toEqual([100, 90, 80, 70, 60, 50, 40, 30, 20, 10]);
  });

  it('evicts the 10th best only when beaten', () => {
    const full = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
    expect(nextLeagueRuns(full, 10)).toEqual({ topRuns: full, weekPts: 550, delta: 0, counted: false });
    const u = nextLeagueRuns(full, 35);
    expect(u.counted).toBe(true);
    expect(u.topRuns).toEqual([100, 90, 80, 70, 60, 50, 40, 35, 30, 20]);
    expect(u.weekPts).toBe(575);
    expect(u.delta).toBe(25);
  });

  it('ignores non-positive scores and sanitizes stored runs', () => {
    expect(nextLeagueRuns([50], 0).counted).toBe(false);
    expect(nextLeagueRuns([50], -20).counted).toBe(false);
    expect(nextLeagueRuns([50], Number.NaN).counted).toBe(false);
    const u = nextLeagueRuns(['x', -5, 40.7, null, 60], 10);
    expect(u.topRuns).toEqual([60, 40, 10]);
    expect(nextLeagueRuns(null, 12)).toEqual({ topRuns: [12], weekPts: 12, delta: 12, counted: true });
  });
});

describe('league schemas', () => {
  it('parses a league result message through the server union', () => {
    const msg = { type: 'leagueResult', weekKey: '2026-W46', pts: 300, weekPts: 1200, delta: 0, counted: false, runsCounted: 10, rank: 3, of: 9 };
    expect(LeagueResultMessageSchema.parse(msg)).toEqual(msg);
    expect(ServerMessageSchema.parse(msg).type).toBe('leagueResult');
  });

  it('accepts a finalized board with a podium and rejects stray keys silently', () => {
    const body = {
      weekKey: '2026-W45',
      endsAt: weekEndMs('2026-W45'),
      top: [{ publicId: 'p_abc', name: 'Ada', weekPts: 900, runs: 12, siteId: 'site-den-1' }],
      entrants: 1,
      finalized: true,
      podium: [{ rank: 1, publicId: 'p_abc', name: 'Ada', weekPts: 900 }],
    };
    expect(LeagueResponseSchema.parse(body).podium?.[0].rank).toBe(1);
    expect(LeagueResponseSchema.safeParse({ ...body, podium: [{ ...body.podium[0], rank: 4 }] }).success).toBe(false);
  });
});
