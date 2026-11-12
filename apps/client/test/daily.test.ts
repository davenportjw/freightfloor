import { describe, expect, it } from 'vitest';
import { dailyInfo } from '@warehouse/sim';
import { ClientStore } from '../src/state.js';
import {
  DAILY_BEST_KEY,
  dailyBest,
  dailyBoardKey,
  dailyLeaderText,
  dailyOf,
  dailyResetText,
  dailyTitle,
  recordDailyBest,
  dailyYouText,
  tapeEmoji,
  todayDaily,
} from '../src/ui/daily.js';

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('Daily Shift client helpers', () => {
  it("uses the server-stamped day, else today's UTC day", () => {
    const noon = Date.UTC(2026, 10, 12, 12);
    expect(todayDaily(noon).dayKey).toBe('2026-11-12');
    expect(todayDaily(noon).number).toBe(1);
    expect(dailyOf({ dailyKey: '2026-11-10' }, noon)).toEqual(dailyInfo('2026-11-10'));
    expect(dailyOf(null, noon).dayKey).toBe('2026-11-12');
    expect(dailyOf({ dailyKey: 'garbage' }, noon).dayKey).toBe('2026-11-12');
  });

  it('formats title and reset countdown', () => {
    const info = dailyInfo('2026-11-12');
    expect(dailyTitle(info)).toBe(`Daily #1 · ${info.modifier.label}`);
    expect(dailyResetText(info, info.resetsAt - (2 * 60 + 5) * 60_000)).toBe('resets in 2h 5m');
    expect(dailyResetText(info, info.resetsAt - 30_000)).toBe('resets in 1m');
  });

  it("keeps one day's best and replaces it on a new day", () => {
    const s = memStorage();
    expect(dailyBest(s, '2026-11-12')).toBeNull();
    expect(recordDailyBest(s, '2026-11-12', 120)).toEqual({ best: 120, isNew: true });
    expect(recordDailyBest(s, '2026-11-12', 90)).toEqual({ best: 120, isNew: false });
    expect(recordDailyBest(s, '2026-11-12', 150)).toEqual({ best: 150, isNew: true });
    expect(dailyBest(s, '2026-11-12')).toBe(150);
    expect(dailyBest(s, '2026-11-13')).toBeNull();
    expect(recordDailyBest(s, '2026-11-13', 10)).toEqual({ best: 10, isNew: true });
    expect(JSON.parse(s.m.get(DAILY_BEST_KEY)!)).toEqual({ dayKey: '2026-11-13', pts: 10 });
  });

  it('renders the run tape as emoji, capped', () => {
    expect(tapeEmoji('OLX')).toBe('🟩🟨🟥');
    expect(tapeEmoji('')).toBe('');
    expect(tapeEmoji(undefined)).toBe('');
    expect(tapeEmoji('OOOO', 2)).toBe('🟩🟩…');
  });

  it('describes the server board for the matching day only', () => {
    const info = dailyInfo('2026-11-12');
    const board = {
      dayKey: '2026-11-12',
      number: 1,
      modifier: info.modifier,
      resetsAt: info.resetsAt,
      total: 2,
      top: [
        { rank: 1, name: 'Bo', pts: 300, tape: 'OO', siteId: 'den-1', publicId: 'p1_b' },
        { rank: 2, name: 'Ace', pts: 120, tape: 'O', siteId: 'den-1', publicId: 'p1_a' },
      ],
      you: { rank: 2, pts: 120, tape: 'O' },
    };
    expect(dailyLeaderText(board, '2026-11-12')).toBe('🏆 Leader: Bo 300 pts · 2 drivers today');
    expect(dailyYouText(board, '2026-11-12')).toBe('You: #2 of 2');
    expect(dailyLeaderText(board, '2026-11-13')).toBeNull();
    expect(dailyLeaderText({ ...board, top: [], total: 0, you: null }, '2026-11-12')).toBe('🏆 No scores yet today: set the pace');
    expect(dailyYouText({ ...board, you: null }, '2026-11-12')).toBeNull();
    expect(dailyBoardKey(board)).not.toBe(dailyBoardKey({ ...board, total: 3 }));
  });

  it('defaults new client sessions to Daily Shift mode', () => {
    expect(new ClientStore().ui.runMode).toBe('daily');
  });
});
