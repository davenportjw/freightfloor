/**
 * Daily Shift view helpers (client side). The authoritative rules live in `@warehouse/sim`
 * (`dailyInfo`, `DAILY_EFFECTS`); the server stamps the run's `dailyKey`. These helpers only
 * describe the day for the HUD and keep a per-browser "today's best" until `/api/daily` lands.
 */
import { dayKey, type DailyBoardResponse, type DailyInfo } from '@warehouse/protocol';
import { dailyInfo, type Vehicle } from '@warehouse/sim';
import type { StorageLike } from './panel.js';

export const DAILY_BEST_KEY = 'warehouse.daily.best';

/** Today's Daily Shift by the local clock (UTC day). */
export function todayDaily(nowMs: number = Date.now()): DailyInfo {
  return dailyInfo(dayKey(nowMs));
}

/** The Daily a vehicle is playing: the server-stamped day when known, else today. */
export function dailyOf(v: Pick<Vehicle, 'dailyKey'> | null | undefined, nowMs: number = Date.now()): DailyInfo {
  const key = v?.dailyKey;
  if (key) {
    try {
      return dailyInfo(key);
    } catch {
      /* malformed key: fall back to today */
    }
  }
  return todayDaily(nowMs);
}

/** "Daily #3 · Express Freight". */
export function dailyTitle(info: DailyInfo): string {
  return `Daily #${info.number} · ${info.modifier.label}`;
}

/** "resets in 9h 37m" / "resets in 12m". */
export function dailyResetText(info: DailyInfo, nowMs: number = Date.now()): string {
  const mins = Math.max(0, Math.ceil((info.resetsAt - nowMs) / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `resets in ${h > 0 ? `${h}h ${m}m` : `${m}m`}`;
}

interface StoredBest {
  dayKey: string;
  pts: number;
}

function readBest(storage: StorageLike | null | undefined): StoredBest | null {
  try {
    const raw = storage?.getItem(DAILY_BEST_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredBest>;
    return typeof v.dayKey === 'string' && typeof v.pts === 'number' ? { dayKey: v.dayKey, pts: v.pts } : null;
  } catch {
    return null;
  }
}

/** This browser's best Daily score for `key` (null when none yet). */
export function dailyBest(storage: StorageLike | null | undefined, key: string): number | null {
  const b = readBest(storage);
  return b && b.dayKey === key ? b.pts : null;
}

/**
 * Record a finished Daily run. Returns the day's best after recording and whether this run set
 * it. Only one day is kept: a new day replaces yesterday's best.
 */
export function recordDailyBest(
  storage: StorageLike | null | undefined,
  key: string,
  pts: number,
): { best: number; isNew: boolean } {
  const prev = dailyBest(storage, key);
  if (prev !== null && prev >= pts) return { best: prev, isNew: false };
  try {
    storage?.setItem(DAILY_BEST_KEY, JSON.stringify({ dayKey: key, pts }));
  } catch {
    /* storage unavailable: the best simply isn't remembered */
  }
  return { best: pts, isNew: true };
}

/** Run tape (`O` on-time, `L` late, `X` incident) as emoji, capped for the results card. */
export function tapeEmoji(tape: string | undefined, max = 20): string {
  if (!tape) return '';
  const map: Record<string, string> = { O: '🟩', L: '🟨', X: '🟥' };
  const shown = [...tape.slice(0, max)].map((c) => map[c] ?? '').join('');
  return tape.length > max ? `${shown}…` : shown;
}

/** "🏆 Leader: Ace 420 pts · 12 drivers today" (null when the board is missing or for another day). */
export function dailyLeaderText(board: DailyBoardResponse | null | undefined, key: string): string | null {
  if (!board || board.dayKey !== key) return null;
  const lead = board.top[0];
  if (!lead) return '🏆 No scores yet today: set the pace';
  return `🏆 Leader: ${lead.name} ${lead.pts} pts · ${board.total} driver${board.total === 1 ? '' : 's'} today`;
}

/** "You: #4 of 23" for your rank on the day's board (null without a recorded score). */
export function dailyYouText(board: DailyBoardResponse | null | undefined, key: string): string | null {
  if (!board || board.dayKey !== key || !board.you) return null;
  return `You: #${board.you.rank} of ${board.total}`;
}

/** Compact key for re-render checks. */
export function dailyBoardKey(board: DailyBoardResponse | null | undefined): string {
  if (!board) return '';
  return `${board.dayKey}|${board.total}|${board.top.map((r) => `${r.publicId}:${r.pts}`).join(',')}|${board.you?.rank ?? ''}:${board.you?.pts ?? ''}`;
}
