import { describe, expect, it, vi } from 'vitest';
import { returnVisitEvent } from '../src/analytics.js';
import { recordLocalVisit, VISIT_LEDGER_KEY } from '../src/visits.js';

/** Minimal Storage test double backed by a Map (the browser API itself is under test elsewhere). */
function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => void map.set(k, v)),
  };
}

const at = (iso: string) => Date.parse(iso);

describe('@warehouse/client: return-visit ledger', () => {
  it('does not report a return on the first-ever day, or on same-day repeats', () => {
    const s = memoryStorage();
    const first = recordLocalVisit(s, at('2026-11-09T15:00:00Z'));
    expect(first?.isReturn).toBe(false);
    expect(returnVisitEvent(first)).toBeNull();
    expect(JSON.parse(s.map.get(VISIT_LEDGER_KEY)!)).toEqual({
      firstDay: '2026-11-09',
      lastDay: '2026-11-09',
      activeDays: 1,
    });

    const again = recordLocalVisit(s, at('2026-11-09T22:00:00Z'));
    expect(returnVisitEvent(again)).toBeNull();
    expect(s.setItem).toHaveBeenCalledTimes(1);
  });

  it('emits return_visit with the gap and active-day count on a later UTC day', () => {
    const s = memoryStorage({
      [VISIT_LEDGER_KEY]: JSON.stringify({ firstDay: '2026-11-01', lastDay: '2026-11-07', activeDays: 3 }),
    });
    const ev = returnVisitEvent(recordLocalVisit(s, at('2026-11-09T01:00:00Z')));
    expect(ev).toEqual({ name: 'return_visit', params: { days_since_last: 2, active_days: 4 } });
    // Privacy: only numeric, non-identifying params.
    expect(Object.keys(ev!.params).sort()).toEqual(['active_days', 'days_since_last']);
  });

  it('restarts from corrupt storage and reports nothing when storage is unavailable', () => {
    const s = memoryStorage({ [VISIT_LEDGER_KEY]: '{not json' });
    expect(recordLocalVisit(s, at('2026-11-09T01:00:00Z'))?.ledger.activeDays).toBe(1);
    expect(recordLocalVisit(null, Date.now())).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(recordLocalVisit(throwing, Date.now())).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
