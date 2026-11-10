import { describe, expect, it } from 'vitest';
import {
  addDays,
  DAILY_EPOCH_DAY,
  DAILY_MODIFIER_IDS,
  DAILY_MODIFIERS,
  DAILY_BOARD_SIZE,
  DAILY_DEAL_SIZE,
  DAILY_DECK,
  DailyBoardResponseSchema,
  DailyInfoSchema,
  DailyResultMessageSchema,
  dailyCardsFor,
  dailyInfoFor,
  dailyModifierFor,
  displayStreak,
  nextDailyStreak,
  ServerMessageSchema,
  WelcomeMessageSchema,
  dailyNumber,
  dailySeed,
  dayKeyToMs,
  fnv1a,
  isTimedRun,
  mulberry32,
  RunModeSchema,
} from '../src/index.js';

describe('@warehouse/protocol: Daily Shift', () => {
  it('numbers days from the epoch (epoch is #1)', () => {
    expect(dailyNumber(DAILY_EPOCH_DAY)).toBe(1);
    expect(dailyNumber(addDays(DAILY_EPOCH_DAY, 1))).toBe(2);
    expect(dailyNumber(addDays(DAILY_EPOCH_DAY, 365))).toBe(366);
    expect(dailyNumber(addDays(DAILY_EPOCH_DAY, -1))).toBe(0);
  });

  it('pins the launch epoch and its modifier rotation (never change after launch)', () => {
    expect(DAILY_EPOCH_DAY).toBe('2026-11-10');
    expect(dayKeyToMs(DAILY_EPOCH_DAY)).toBe(Date.UTC(2026, 10, 10));
    expect(dailyNumber('2027-01-01')).toBe(53);
    const week = Array.from({ length: 7 }, (_, i) => dailyModifierFor(addDays(DAILY_EPOCH_DAY, i)).id);
    expect(week).toEqual([
      'long_haul',
      'eco_run',
      'cold_chain',
      'combo_day',
      'express',
      'heavy_load',
      'clean_shift',
    ]);
  });

  it('accepts the daily run mode and treats blitz + daily as timed runs', () => {
    expect(RunModeSchema.parse('daily')).toBe('daily');
    expect(isTimedRun('blitz')).toBe(true);
    expect(isTimedRun('daily')).toBe(true);
    expect(isTimedRun('freerange')).toBe(false);
    expect(isTimedRun(null)).toBe(false);
    expect(isTimedRun(undefined)).toBe(false);
  });

  it('seeds deterministically per day and rejects malformed keys', () => {
    const a = dailySeed('2026-11-10');
    expect(dailySeed('2026-11-10')).toBe(a);
    expect(dailySeed('2026-11-11')).not.toBe(a);
    expect(a).toBe(fnv1a('ff-daily:2026-11-10'));
    expect(() => dailySeed('2026-13-01')).toThrow();
    expect(() => dailySeed('nope')).toThrow();
  });

  it('mulberry32 is a deterministic stream in [0, 1)', () => {
    const s1 = mulberry32(42);
    const s2 = mulberry32(42);
    const xs = Array.from({ length: 200 }, () => s1());
    expect(Array.from({ length: 200 }, () => s2())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(xs).size).toBeGreaterThan(190);
  });

  it('rotates modifiers: every block of 7 is a permutation, never the same two days running', () => {
    const n = DAILY_MODIFIER_IDS.length;
    const ids: string[] = [];
    for (let i = 0; i < 420; i++) ids.push(dailyModifierFor(addDays(DAILY_EPOCH_DAY, i)).id);
    for (let b = 0; b + n <= ids.length; b += n) {
      expect(new Set(ids.slice(b, b + n)).size).toBe(n);
    }
    for (let i = 1; i < ids.length; i++) expect(ids[i]).not.toBe(ids[i - 1]);
    // Pre-epoch days still resolve (block −1 and earlier).
    expect(DAILY_MODIFIER_IDS).toContain(dailyModifierFor(addDays(DAILY_EPOCH_DAY, -3)).id);
  });

  it('has copy for every modifier and a DailyInfo schema that round-trips', () => {
    for (const id of DAILY_MODIFIER_IDS) {
      expect(DAILY_MODIFIERS[id].id).toBe(id);
      expect(DAILY_MODIFIERS[id].label.length).toBeGreaterThan(0);
      expect(DAILY_MODIFIERS[id].blurb.length).toBeGreaterThan(0);
    }
    const info = {
      dayKey: '2026-11-12',
      number: dailyNumber('2026-11-12'),
      modifier: dailyModifierFor('2026-11-12'),
      cards: ['Speed Demon', 'Eco Cell', 'Clean Shift'],
      resetsAt: dayKeyToMs('2026-11-13'),
    };
    expect(DailyInfoSchema.parse(JSON.parse(JSON.stringify(info)))).toEqual(info);
    expect(() => DailyInfoSchema.parse({ ...info, dayKey: '2026-1-1' })).toThrow();
  });

  it('deals a deterministic, distinct hand from DAILY_DECK', () => {
    const key = '2026-12-03';
    const cards = dailyCardsFor(key);
    expect(cards).toHaveLength(DAILY_DEAL_SIZE);
    expect(new Set(cards).size).toBe(DAILY_DEAL_SIZE);
    for (const c of cards) expect(DAILY_DECK).toContain(c);
    expect(dailyCardsFor(key)).toEqual(cards);
    const info = dailyInfoFor(key);
    expect(DailyInfoSchema.parse(info)).toEqual(info);
    expect(info.resetsAt).toBe(dayKeyToMs('2026-12-04'));
    expect(info.modifier).toEqual(dailyModifierFor(key));
  });

  describe('streaks', () => {
    const d1 = '2026-12-01';
    it('starts at 1, extends on consecutive days, and counts completions', () => {
      const a = nextDailyStreak(null, d1);
      expect(a).toMatchObject({ streakDelta: 1, firstToday: true });
      expect(a.next).toEqual({ dailyStreak: 1, bestDailyStreak: 1, lastDailyKey: d1, dailiesCompleted: 1 });
      const b = nextDailyStreak(a.next, addDays(d1, 1));
      expect(b.next.dailyStreak).toBe(2);
      const c = nextDailyStreak(b.next, addDays(d1, 2));
      expect(c.next).toEqual({ dailyStreak: 3, bestDailyStreak: 3, lastDailyKey: addDays(d1, 2), dailiesCompleted: 3 });
    });

    it('is a no-op on a second completion the same day', () => {
      const a = nextDailyStreak({ dailyStreak: 4, bestDailyStreak: 6, lastDailyKey: d1, dailiesCompleted: 9 }, d1);
      expect(a).toEqual({
        next: { dailyStreak: 4, bestDailyStreak: 6, lastDailyKey: d1, dailiesCompleted: 9 },
        streakDelta: 0,
        firstToday: false,
      });
    });

    it('restarts at 1 after a gap but keeps the best streak', () => {
      const a = nextDailyStreak({ dailyStreak: 5, bestDailyStreak: 5, lastDailyKey: d1, dailiesCompleted: 5 }, addDays(d1, 2));
      expect(a.next).toEqual({ dailyStreak: 1, bestDailyStreak: 5, lastDailyKey: addDays(d1, 2), dailiesCompleted: 6 });
      expect(a.streakDelta).toBe(1);
    });

    it('treats malformed or future history as absent', () => {
      expect(nextDailyStreak({ dailyStreak: 3, lastDailyKey: 'nope' }, d1).next.dailyStreak).toBe(1);
      expect(nextDailyStreak({ dailyStreak: 3, lastDailyKey: addDays(d1, 1) }, d1).next.dailyStreak).toBe(1);
      expect(() => nextDailyStreak(null, '2026-13-01')).toThrow();
    });

    it('decays to 0 at read time once a day is missed', () => {
      expect(displayStreak(d1, 4, d1)).toBe(4);
      expect(displayStreak(d1, 4, addDays(d1, 1))).toBe(4);
      expect(displayStreak(d1, 4, addDays(d1, 2))).toBe(0);
      expect(displayStreak(null, 4, d1)).toBe(0);
    });
  });

  it('validates the board response, result message, and welcome daily field', () => {
    const info = dailyInfoFor('2026-12-03');
    const row = { publicId: 'p1_abcdefghijklmnopqrstuv', name: 'Ada', pts: 410, streak: 2, siteId: 'den-1' };
    expect(DailyBoardResponseSchema.parse({ info, top: [row], entrants: 1, you: { rank: 1, bestPts: 410, attempts: 2 } }).top[0]).toEqual(row);
    expect(() =>
      DailyBoardResponseSchema.parse({ info, top: Array(DAILY_BOARD_SIZE + 1).fill(row), entrants: 21 }),
    ).toThrow();
    const result = {
      type: 'dailyResult',
      dailyKey: '2026-12-03',
      pts: 300,
      dailyBest: 410,
      improved: false,
      dailyRank: 3,
      dailyOf: 12,
      attempts: 2,
      streak: 2,
      streakDelta: 0,
    };
    expect(DailyResultMessageSchema.parse(result)).toEqual(result);
    expect(ServerMessageSchema.parse(result)).toEqual(result);
    const welcome = WelcomeMessageSchema.parse({
      type: 'welcome',
      you: { clientId: 'p1_x', name: 'A', vid: null, role: 'spectator', siteId: 'den-1' },
      snapshot: {},
      daily: info,
    });
    expect(welcome.daily).toEqual(info);
  });
});
