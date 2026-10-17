/**
 * Pure view-model formatters (no DOM). Unit-tested in test/ui/format.test.ts.
 */
import {
  clockText,
  DIFFICULTY,
  HUMAN,
  shiftName,
  STRATEGIES,
  type DifficultyKey,
  type PeriodStats,
  type StrategyName,
} from '@warehouse/sim';

export const DASH = '—';

/** "Day 3 · 11:12 · Shift B" — clockText already contains the day, so it is used exactly once. */
export function clockLine(t: number): string {
  return `${clockText(t)} · Shift ${shiftName(t)}`;
}

/** Time-of-day part only ("11:12"), used in event rows. */
export function timeOfDay(t: number): string {
  const parts = clockText(t).split(' · ');
  return parts[parts.length - 1] ?? DASH;
}

export function fmt(v: number | null | undefined, digits = 0, suffix = ''): string {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : `${v.toFixed(digits)}${suffix}`;
}

/** On-time percentage, or "—" when nothing has shipped (never a fake 100%). */
export function onTimeText(stats: Pick<PeriodStats, 'shipped' | 'onTime'> | null | undefined): string {
  if (!stats || !stats.shipped) return DASH;
  return `${Math.round((100 * stats.onTime) / stats.shipped)}%`;
}

/** Remaining time in the current 8-hour shift as H:MM. */
export function shiftLeft(t: number): string {
  const m = 480 - (((t % 480) + 480) % 480);
  return `${Math.floor(m / 60)}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
}

export function teamColor(strat: StrategyName | string): string {
  if (strat === 'Human') return HUMAN.color;
  const cfg = (STRATEGIES as Record<string, { color: string } | undefined>)[strat];
  return cfg?.color ?? '#64748B';
}

export type VoteLevel = 'easy' | 'normal' | 'hard' | 'turbo';
export const VOTE_LEVELS: VoteLevel[] = ['easy', 'normal', 'hard', 'turbo'];

/** Collapse the sim's difficulty keys onto the 4 vote buttons (matches protocol normaliseDifficultyKey). */
export function voteLevelOf(key: string | null | undefined): VoteLevel | null {
  switch (key) {
    case 'easy':
    case 'calm':
      return 'easy';
    case 'normal':
    case 'medium':
      return 'normal';
    case 'hard':
    case 'surge':
      return 'hard';
    case 'crisis':
    case 'turbo':
      return 'turbo';
    default:
      return null;
  }
}

export function voteCounts(votes: Record<string, string> | null | undefined): Record<VoteLevel, number> {
  const out: Record<VoteLevel, number> = { easy: 0, normal: 0, hard: 0, turbo: 0 };
  for (const v of Object.values(votes ?? {})) {
    const lvl = voteLevelOf(v);
    if (lvl) out[lvl]++;
  }
  return out;
}

export function difficultyTooltip(level: VoteLevel): string {
  const d = DIFFICULTY[level as DifficultyKey];
  return `Speed ×${d.speed ?? 1}, demand ×${d.demand}, deadlines ×${d.due}, ~${d.hazardPerHr} spills/hr, crash risk ×${d.crash}, hall score ×${d.score}`;
}

export function difficultyLabel(key: string): string {
  const d = (DIFFICULTY as Record<string, { label: string } | undefined>)[key];
  return d?.label ?? key;
}

/** Event-type → accent colour (from the mock's TOAST_COLOR). */
export const TOAST_COLOR: Record<string, string> = {
  card: '#7C3AED',
  shift: '#7C3AED',
  incident: '#DC2626',
  poach: '#CA8A04',
  p0: '#F59E0B',
  preempt: '#EA580C',
  retune: '#059669',
  truck: '#2563EB',
  day: '#475569',
  rush: '#EA580C',
  drive: '#0D9488',
  hint: '#0D9488',
  p0done: '#F59E0B',
  hazard: '#CA8A04',
  decision: '#0891B2',
  difficulty: '#475569',
  vote_difficulty: '#475569',
  expand: '#0891B2',
  fleet: '#475569',
  brain_error: '#DC2626',
  error: '#DC2626',
  echo: '#2563EB',
  transfer_in: '#2563EB',
  transfer_out: '#2563EB',
  phase: '#475569',
};

export function eventColor(type: string): string {
  return TOAST_COLOR[type] ?? '#64748B';
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
