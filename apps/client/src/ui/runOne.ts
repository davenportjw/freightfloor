/**
 * "Drive first" onboarding (pure, unit-tested): Run 1 skips the contract pick sheet (the client
 * auto-keeps one card), shows only Blitz, and a 3-step coach rides on the objective pill.
 * Also the local run memory behind the results headline ("▲ 23 vs last run").
 *
 * Everything shown comes from real state: the dealt offer, the driven vehicle, the server guide and
 * the real `fare` event. Nothing here invents numbers.
 */
import type { Card } from '@warehouse/sim';
import type { StorageLike } from './panel.js';

/** localStorage: number of runs this browser has finished (results sheet shown). */
export const RUNS_DONE_KEY = 'warehouse.runs.done';
/** localStorage: points of the last finished run (results headline). */
export const LAST_RUN_PTS_KEY = 'warehouse.runs.lastPts';

function readInt(storage: StorageLike | null | undefined, key: string): number | null {
  try {
    const raw = storage?.getItem(key);
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n) : null;
  } catch {
    return null;
  }
}

function writeInt(storage: StorageLike | null | undefined, key: string, n: number): void {
  try {
    storage?.setItem(key, String(Math.round(n)));
  } catch {
    /* storage unavailable (private mode): onboarding simply repeats next time */
  }
}

export function readRunsDone(storage: StorageLike | null | undefined): number {
  return Math.max(0, readInt(storage, RUNS_DONE_KEY) ?? 0);
}

export function readLastRunPts(storage: StorageLike | null | undefined): number | null {
  return readInt(storage, LAST_RUN_PTS_KEY);
}

/**
 * Remember a finished run: bumps the finished-run count and stores its points. Returns the PREVIOUS
 * run's points (null on the first run) so the results headline can compare against it.
 */
export function recordFinishedRun(storage: StorageLike | null | undefined, pts: number): number | null {
  const prev = readLastRunPts(storage);
  writeInt(storage, RUNS_DONE_KEY, readRunsDone(storage) + 1);
  writeInt(storage, LAST_RUN_PTS_KEY, pts);
  return prev;
}

/**
 * Run 1 = the callsign is on its first run (`… Run 1` or no suffix) AND this browser has never
 * finished a run. A resumed veteran callsign (`Run 4`) or a returning browser is never "Run 1".
 */
export function isDriveFirstRun(s: { runNumber: number; runsDone: number }): boolean {
  return s.runNumber <= 1 && s.runsDone <= 0;
}

/** Card ids auto-kept on Run 1: the server-marked starter card, else the first card (one card only). */
export function autoKeepIds(offer: ReadonlyArray<Pick<Card, 'id' | 'starter'>> | null | undefined): string[] {
  if (!offer || !offer.length) return [];
  const pick = offer.find((c) => c.starter) ?? offer[0];
  return [pick.id];
}

export interface CoachInput {
  /** The driven vehicle (manual). */
  me: { runDeliveries?: number; cargo?: ReadonlyArray<{ bay?: string | null; putaway?: unknown }> | null; autopilot?: boolean };
  /** Server guide for the driven vehicle (drop target bay when carrying). */
  guide?: { kind?: string; text?: string | null; order?: { bay?: string | null } | null } | null;
  /** My last real `fare` event this run: points and when it arrived (ms). */
  lastFare?: { pts: number; at: number } | null;
  now: number;
}

/** How long the "Nice! +N" step stays up after the first delivery. */
export const COACH_NICE_MS = 4_000;

/** Bay letters in guide text ("Drop at Bay E2" / "→ E2"). */
function bayFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /\bbay\s+([A-Z]{1,4}\d{0,2})\b/i.exec(text);
  return m ? m[1].toUpperCase() : null;
}

/**
 * The 3-step Run 1 coach text (null = no coach; show the normal objective):
 *   1. no cargo, no delivery yet → "Drive to the glowing pallet → E"
 *   2. carrying                   → "Take it to Bay X → E" (bay from the real cargo / guide)
 *   3. first delivery landed      → "Nice! +N" (N from the real `fare` event) for COACH_NICE_MS
 */
export function coachText(c: CoachInput): string | null {
  if (c.me.autopilot) return null;
  const delivered = (c.me.runDeliveries ?? 0) > 0 || Boolean(c.lastFare);
  if (delivered) {
    if (c.lastFare && c.now - c.lastFare.at <= COACH_NICE_MS) return `Nice! +${Math.round(c.lastFare.pts)}`;
    return null;
  }
  const cargo = c.me.cargo ?? [];
  if (cargo.length) {
    if (cargo.every((o) => o.putaway)) return 'Stow it on the glowing rack → E';
    const bay = cargo.find((o) => o.bay && !o.putaway)?.bay ?? c.guide?.order?.bay ?? bayFromText(c.guide?.text);
    return bay ? `Take it to Bay ${bay} → E` : 'Take it to the blue bay → E';
  }
  return 'Drive to the glowing pallet → E';
}

/** Progressive disclosure: combo pips appear after the first delivery of the run. */
export function showComboMeter(me: { runDeliveries?: number; fareTrips?: number }): boolean {
  return (me.runDeliveries ?? 0) > 0 || (me.fareTrips ?? 0) > 0;
}

/** Progressive disclosure: the battery meter shows below 50%, while charging, or while boosting. */
export const BATTERY_SHOW_PCT = 50;
export function showBatteryMeter(me: {
  battery: number;
  humanCharging?: boolean;
  boosting?: boolean;
}): boolean {
  return (
    Boolean(me.humanCharging) ||
    Boolean(me.boosting) ||
    Math.round(me.battery) < BATTERY_SHOW_PCT
  );
}

/** Results headline vs the last finished run: "▲ 23 vs last run" / "▼ 5 vs last run" / "= last run". */
export function runDeltaHeadline(score: number, lastPts: number | null | undefined): string | null {
  if (lastPts == null || !Number.isFinite(lastPts)) return null;
  const d = Math.round(score) - Math.round(lastPts);
  if (d === 0) return '= last run';
  return `${d > 0 ? '▲' : '▼'} ${Math.abs(d)} vs last run`;
}
