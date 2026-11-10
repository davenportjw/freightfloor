import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayKey,
  dayKeyToMs,
  daysBetween,
  nextVisitLedger,
  weekKey,
  weekStartMs,
} from '../src/index.js';

const at = (iso: string) => Date.parse(iso);

describe('@warehouse/protocol: retention calendar', () => {
  it('keys days on UTC midnight regardless of local offset', () => {
    expect(dayKey(at('2026-11-09T23:59:59.999Z'))).toBe('2026-11-09');
    expect(dayKey(at('2026-11-10T00:00:00.000Z'))).toBe('2026-11-10');
    // 17:00 MST on Nov 9 is already Nov 10 UTC.
    expect(dayKey(at('2026-11-09T17:00:00-07:00'))).toBe('2026-11-10');
  });

  it('round-trips and rejects malformed or impossible day keys', () => {
    expect(dayKey(dayKeyToMs('2028-02-29'))).toBe('2028-02-29');
    expect(() => dayKeyToMs('2027-02-29')).toThrow();
    expect(() => dayKeyToMs('2026-1-9')).toThrow();
  });

  it('adds and diffs days across month, year, and DST transitions', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    // US DST ends 2026-11-01; UTC keys are unaffected.
    expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2);
    expect(daysBetween('2026-11-09', '2026-11-02')).toBe(-7);
  });

  it('computes ISO-8601 week keys including year-boundary weeks', () => {
    expect(weekKey(at('2026-11-09T00:00:00Z'))).toBe('2026-W46'); // Monday
    expect(weekKey(at('2026-11-15T23:59:59Z'))).toBe('2026-W46'); // Sunday
    expect(weekKey(at('2026-11-16T00:00:00Z'))).toBe('2026-W47');
    expect(weekKey(at('2021-01-03T12:00:00Z'))).toBe('2020-W53');
    expect(weekKey(at('2024-12-30T12:00:00Z'))).toBe('2025-W01');
    expect(weekKey(at('2026-12-31T12:00:00Z'))).toBe('2026-W53');
  });

  it('finds the Monday 00:00 UTC week start', () => {
    expect(weekStartMs(at('2026-11-12T15:30:00Z'))).toBe(at('2026-11-09T00:00:00Z'));
    expect(weekStartMs(at('2026-11-15T23:59:59Z'))).toBe(at('2026-11-09T00:00:00Z'));
    expect(weekStartMs(at('2026-11-09T00:00:00Z'))).toBe(at('2026-11-09T00:00:00Z'));
  });
});

describe('@warehouse/protocol: nextVisitLedger', () => {
  it('starts a ledger on the first-ever visit without counting it as a return', () => {
    const u = nextVisitLedger(null, '2026-11-09');
    expect(u).toEqual({
      ledger: { firstDay: '2026-11-09', lastDay: '2026-11-09', activeDays: 1 },
      isNewDay: true,
      isReturn: false,
      daysSinceLast: null,
    });
  });

  it('is a no-op for repeat visits on the same day', () => {
    const first = nextVisitLedger(null, '2026-11-09').ledger;
    const again = nextVisitLedger(first, '2026-11-09');
    expect(again.isNewDay).toBe(false);
    expect(again.isReturn).toBe(false);
    expect(again.ledger).toEqual(first);
  });

  it('counts a return on a later day and reports the gap', () => {
    const u = nextVisitLedger(
      { firstDay: '2026-11-01', lastDay: '2026-11-06', activeDays: 4 },
      '2026-11-09',
    );
    expect(u.ledger).toEqual({ firstDay: '2026-11-01', lastDay: '2026-11-09', activeDays: 5 });
    expect(u.isReturn).toBe(true);
    expect(u.daysSinceLast).toBe(3);
  });

  it('restarts from a malformed or future-dated ledger instead of producing negative gaps', () => {
    for (const bad of [
      { firstDay: 'nope', lastDay: '2026-11-01', activeDays: 2 },
      { firstDay: '2026-11-01', lastDay: '2026-12-01', activeDays: 2 },
      { firstDay: '2026-11-01', lastDay: '2026-11-02', activeDays: 0 },
      {},
    ]) {
      const u = nextVisitLedger(bad, '2026-11-09');
      expect(u.ledger).toEqual({ firstDay: '2026-11-09', lastDay: '2026-11-09', activeDays: 1 });
      expect(u.isReturn).toBe(false);
    }
  });
});
