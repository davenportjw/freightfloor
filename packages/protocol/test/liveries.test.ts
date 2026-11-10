import { describe, expect, it } from 'vitest';
import {
  DailyBoardRowSchema,
  LeaderboardEntrySchema,
  LeagueRowSchema,
  LIVERIES,
  LIVERY_IDS,
  LiveryIdSchema,
  QuantisedVehicleDeltaSchema,
  isLiveryId,
  liveryFromIndex,
  liveryIndex,
  newlyUnlocked,
  regionalLiveryFor,
  unlockedLiveries,
  type LiveryId,
  type LiveryProfile,
} from '../src/index.js';

describe('livery catalog', () => {
  it('keeps the wire order stable (append-only)', () => {
    expect(LIVERY_IDS).toEqual([
      'standard',
      'night_shift',
      'hi_vis',
      'cold_chain',
      'century',
      'gold_fork',
      'regional_den',
      'regional_slc',
      'regional_phx',
      'regional_abq',
      'champion',
      'streak_30',
    ]);
  });

  it('defines every id with hex colours and a rule', () => {
    for (const id of LIVERY_IDS) {
      const def = LIVERIES[id];
      expect(def.id).toBe(id);
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.rule.length).toBeGreaterThan(0);
      for (const c of [def.primary, def.dark, def.light, ...(def.accent ? [def.accent] : [])]) {
        expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
      expect(Boolean(def.accent)).toBe(Boolean(def.accentKind));
    }
  });

  it('round-trips wire indices and falls back to standard', () => {
    for (const id of LIVERY_IDS) expect(liveryFromIndex(liveryIndex(id))).toBe(id);
    expect(liveryFromIndex(undefined)).toBe('standard');
    expect(liveryFromIndex(99)).toBe('standard');
    expect(liveryFromIndex(1.5)).toBe('standard');
    expect(isLiveryId('champion')).toBe(true);
    expect(isLiveryId('rainbow')).toBe(false);
    expect(LiveryIdSchema.safeParse('rainbow').success).toBe(false);
  });

  it('accepts livery on vehicle deltas', () => {
    expect(QuantisedVehicleDeltaSchema.parse({ id: 'P1', livery: 10 }).livery).toBe(10);
    expect(QuantisedVehicleDeltaSchema.safeParse({ id: 'P1', livery: -1 }).success).toBe(false);
  });

  it('maps sites (including overflow) to regional liveries', () => {
    expect(regionalLiveryFor('den-1')).toBe('regional_den');
    expect(regionalLiveryFor('den-7')).toBe('regional_den');
    expect(regionalLiveryFor('abq-4')).toBe('regional_abq');
    expect(regionalLiveryFor('nyc-1')).toBeNull();
  });
});

describe('unlockedLiveries truth table', () => {
  const cases: [string, LiveryProfile | null, LiveryId[]][] = [
    ['null profile', null, ['standard']],
    ['empty profile', {}, ['standard']],
    ['streak 2', { bestDailyStreak: 2 }, ['standard']],
    ['streak 3', { bestDailyStreak: 3 }, ['standard', 'night_shift']],
    ['streak 7', { bestDailyStreak: 7 }, ['standard', 'night_shift', 'hi_vis']],
    ['streak 30', { bestDailyStreak: 30 }, ['standard', 'night_shift', 'hi_vis', 'streak_30']],
    ['4 dailies', { dailiesCompleted: 4 }, ['standard']],
    ['5 dailies', { dailiesCompleted: 5 }, ['standard', 'cold_chain']],
    ['99 deliveries', { totalDeliveries: 99 }, ['standard']],
    ['100 deliveries', { totalDeliveries: 100 }, ['standard', 'century']],
    ['top 10 once', { dailyTop10s: 1 }, ['standard', 'gold_fork']],
    ['den + phx overflow', { dailySites: ['den-1', 'phx-9', 'mars-1'] }, ['standard', 'regional_den', 'regional_phx']],
    ['league win', { leagueWins: 1 }, ['standard', 'champion']],
    [
      'everything',
      {
        bestDailyStreak: 31,
        dailiesCompleted: 40,
        totalDeliveries: 5000,
        dailyTop10s: 3,
        dailySites: ['den-1', 'slc-2', 'phx-3', 'abq-4'],
        leagueWins: 2,
      },
      [...LIVERY_IDS],
    ],
  ];
  it.each(cases)('%s', (_name, profile, expected) => {
    expect(unlockedLiveries(profile)).toEqual(expected);
  });

  it('newlyUnlocked reports only the difference', () => {
    expect(newlyUnlocked({ bestDailyStreak: 2 }, { bestDailyStreak: 3, dailyTop10s: 1 })).toEqual([
      'night_shift',
      'gold_fork',
    ]);
    expect(newlyUnlocked({ leagueWins: 1 }, { leagueWins: 2 })).toEqual([]);
    expect(newlyUnlocked(null, null)).toEqual([]);
  });
});

describe('board rows carry an optional livery', () => {
  const lb = { clientId: 'p1_x', name: 'Ada', deliveries: 3 };
  const daily = { publicId: 'p1_x', name: 'Ada', pts: 10, streak: 1, siteId: 'site-den-1' };
  const league = { publicId: 'p1_x', name: 'Ada', weekPts: 10, runs: 1, siteId: 'site-den-1' };
  it('accepts catalog ids and omission', () => {
    for (const [schema, row] of [[LeaderboardEntrySchema, lb], [DailyBoardRowSchema, daily], [LeagueRowSchema, league]] as const) {
      expect(schema.safeParse(row).success).toBe(true);
      expect(schema.parse({ ...row, livery: 'gold_fork' })).toMatchObject({ livery: 'gold_fork' });
    }
  });
  it('rejects ids outside the catalog', () => {
    for (const [schema, row] of [[LeaderboardEntrySchema, lb], [DailyBoardRowSchema, daily], [LeagueRowSchema, league]] as const) {
      expect(schema.safeParse({ ...row, livery: 'rainbow' }).success).toBe(false);
    }
  });
});
