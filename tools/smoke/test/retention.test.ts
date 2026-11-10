import { describe, expect, it } from 'vitest';
import { computeRetention, formatRetention } from '../src/retention.js';

describe('@warehouse/smoke: computeRetention', () => {
  const rows = [
    { firstSeenDay: '2026-11-01', lastSeenDay: '2026-11-01', activeDays: 1 }, // never returned
    { firstSeenDay: '2026-11-01', lastSeenDay: '2026-11-02', activeDays: 2 }, // D1 only
    { firstSeenDay: '2026-11-01', lastSeenDay: '2026-11-09', activeDays: 5 }, // D1 + D7
    { firstSeenDay: '2026-11-08', lastSeenDay: '2026-11-09', activeDays: 2 }, // D1; too new for D7
    { firstSeenDay: '2026-11-09', lastSeenDay: '2026-11-09', activeDays: 1 }, // too new for D1
    { firstSeenDay: '2026-11-01', lastSeenDay: '2026-11-09', isBot: true },
    { firstSeenDay: '2026-11-01', lastSeenDay: '2026-11-09', name: 'loadtest-001' },
    { name: 'legacy player without ledger' },
  ];

  it('computes unbounded retention over eligible human cohorts only', () => {
    const r = computeRetention(rows, '2026-11-09');
    expect(r.players).toBe(5);
    expect(r.skipped).toBe(1);
    expect(r.meanActiveDays).toBeCloseTo(11 / 5);
    expect(r.buckets).toEqual([
      { day: 1, eligible: 4, returned: 3, rate: 0.75 },
      { day: 7, eligible: 3, returned: 1, rate: 1 / 3 },
      { day: 30, eligible: 0, returned: 0, rate: null },
    ]);
  });

  it('formats a readable table with n/a for empty cohorts', () => {
    const text = formatRetention(computeRetention(rows, '2026-11-09'));
    expect(text).toContain('as of 2026-11-09');
    expect(text).toMatch(/D1\s+4\s+3\s+75\.0%/);
    expect(text).toMatch(/D30\s+0\s+0\s+n\/a/);
  });
});
