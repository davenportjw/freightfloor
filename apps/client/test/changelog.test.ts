import { describe, expect, it } from 'vitest';
import {
  CHANGELOG,
  CHANGELOG_SEEN_KEY,
  formatReleaseDate,
  hasUnseenChanges,
  latestReleaseId,
  markChangelogSeen,
} from '../src/changelog.js';

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe("What's new changelog", () => {
  it('is newest first with unique ISO dates and non-empty, commit-cited items', () => {
    const dates = CHANGELOG.map((r) => r.date);
    expect(new Set(dates).size).toBe(dates.length);
    expect([...dates].sort().reverse()).toEqual(dates);
    for (const rel of CHANGELOG) {
      expect(rel.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(rel.title.length).toBeGreaterThan(0);
      expect(rel.items.length).toBeGreaterThan(0);
      for (const it of rel.items) {
        expect(['new', 'improved', 'fixed']).toContain(it.kind);
        expect(it.body.length).toBeGreaterThan(0);
        expect(it.commits.length).toBeGreaterThan(0);
        for (const sha of it.commits) expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
      }
    }
  });

  it('highlights the Daily Shift and the graphics upgrade', () => {
    const titles = CHANGELOG.flatMap((r) => r.items.map((i) => i.title));
    expect(titles).toContain('Daily Shift');
    expect(CHANGELOG.some((r) => r.title === 'Graphics upgrade')).toBe(true);
  });

  it('tracks the NEW marker per latest release', () => {
    const s = memStorage();
    expect(hasUnseenChanges(s)).toBe(true);
    markChangelogSeen(s);
    expect(s.m.get(CHANGELOG_SEEN_KEY)).toBe(latestReleaseId());
    expect(hasUnseenChanges(s)).toBe(false);
    expect(hasUnseenChanges(memStorage({ [CHANGELOG_SEEN_KEY]: '2000-01-01' }))).toBe(true);
    expect(hasUnseenChanges(null)).toBe(true);
    expect(hasUnseenChanges(s, [])).toBe(false);
  });

  it('formats dates without time-zone drift', () => {
    expect(formatReleaseDate('2026-11-11')).toBe('Nov 11, 2026');
    expect(formatReleaseDate('2026-01-01')).toBe('Jan 1, 2026');
  });
});
