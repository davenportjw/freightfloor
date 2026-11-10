import { describe, expect, it } from 'vitest';
import {
  addDays,
  DAILY_EPOCH_DAY,
  DAILY_MODIFIER_IDS,
  DAILY_MODIFIERS,
  DailyInfoSchema,
  dailyModifierFor,
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
});
