/**
 * Weekly League (retention spec §5) pure view helpers shared by the leaderboard modal's
 * This Week tab, the results-sheet league pill, and the intro podium pill. No DOM here.
 * Every number comes from the server (`leagueResult` / `GET /api/league`); nothing is guessed.
 */
import type { LeagueResponse, LeagueResultMessage } from '@warehouse/protocol';
import type { StorageLike } from './panel.js';

/** localStorage key prefix for a dismissed "last week's podium" pill (one per week). */
export const LEAGUE_PODIUM_DISMISS_PREFIX = 'ff-league-podium-dismissed:';

/** Results-sheet league line, or `''` when this run produced no league message (nothing to show). */
export function leagueLineText(result: LeagueResultMessage | null, error: string | null): string {
  if (result) {
    return result.counted
      ? `League: #${result.rank} this week (+${result.delta.toLocaleString('en-US')})`
      : `League: #${result.rank} this week · didn't beat your 10th-best run`;
  }
  if (error) return `League not saved: ${error}`;
  return '';
}

/** Countdown to the week's end, e.g. `ends in 3d 4h`, `ends in 2h 5m`, or `ended`. */
export function leagueEndsInText(endsAtMs: number, nowMs: number): string {
  const left = endsAtMs - nowMs;
  if (!(left > 0)) return 'ended';
  const mins = Math.floor(left / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `ends in ${d}d ${h}h`;
  if (h > 0) return `ends in ${h}h ${m}m`;
  return `ends in ${Math.max(1, m)}m`;
}

/** Intro pill text for last week's finalized podium, or `null` when there is nothing to show. */
export function podiumPillText(prev: LeagueResponse | null): string | null {
  if (!prev || !prev.finalized || !prev.podium || prev.podium.length === 0) return null;
  const places = [...prev.podium]
    .sort((a, b) => a.rank - b.rank)
    .map((p) => `${p.rank}. ${p.name} ${p.weekPts.toLocaleString('en-US')}`);
  return `🏆 Last week: ${places.join(' · ')}`;
}

export function podiumDismissKey(weekKey: string): string {
  return `${LEAGUE_PODIUM_DISMISS_PREFIX}${weekKey}`;
}

export function isPodiumDismissed(storage: StorageLike | null | undefined, weekKey: string): boolean {
  try {
    return storage?.getItem(podiumDismissKey(weekKey)) === '1';
  } catch {
    return false;
  }
}

export function dismissPodium(storage: StorageLike | null | undefined, weekKey: string): void {
  try {
    storage?.setItem(podiumDismissKey(weekKey), '1');
  } catch {
    /* storage unavailable (private mode): the pill stays dismissed for this page only */
  }
}
