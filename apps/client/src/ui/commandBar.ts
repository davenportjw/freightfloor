/**
 * Pure run/drive helpers shared by the HUD v3 modules (run capsule, dash, results sheet).
 * The old bottom command bar / drive bar mounts were retired with HUD v3.
 */
import { BLITZ_DURATION_MIN, type Vehicle } from '@warehouse/sim';

export const NL_MAX_LEN = 200;

export function formatBlitzRemaining(
  meOrRem: Pick<Vehicle, 'runMode' | 'runStartedAt' | 'runEndsAt'> | number,
  t = 0,
): string {
  if (typeof meOrRem === 'number') {
    const totalSec = Math.max(0, Math.ceil(meOrRem));
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }
  if (meOrRem.runEndsAt == null) {
    const defSec = Math.max(0, Math.ceil(BLITZ_DURATION_MIN));
    const mm = String(Math.floor(defSec / 60)).padStart(2, '0');
    const ss = String(defSec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }
  const remSimMin = Math.max(0, meOrRem.runEndsAt - t);
  const totalSec = Math.max(0, Math.ceil(remSimMin));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** Fare combo steps, mirroring the sim's COMBO_STEPS. */
export const COMBO_PIPS = [1.0, 1.2, 1.5, 2.0] as const;

/** Combo meter view: 'COMBO ×1.5' + 4 pips lit up to the current step; `max` at ×2.0. */
export function comboMeter(combo: number | null | undefined): {
  label: string;
  pips: Array<{ step: number; on: boolean }>;
  max: boolean;
} {
  const c = typeof combo === 'number' && Number.isFinite(combo) ? combo : 1;
  const top = COMBO_PIPS[COMBO_PIPS.length - 1];
  return {
    label: `COMBO ×${c.toFixed(1)}`,
    pips: COMBO_PIPS.map((step) => ({ step, on: c >= step - 1e-9 })),
    max: c >= top - 1e-9,
  };
}

/**
 * 🚜 Drive target: the selected AI vehicle, else an idle, charged, unloaded, un-stunned agent
 * (idle first, then highest battery), else any AI vehicle. Bot-driven vehicles are never picked.
 */
export function pickDriveTarget(vehicles: readonly Vehicle[], selectedVid: string | null, t: number): string | null {
  const free = vehicles.filter((v) => !v.human && !v.isBot);
  const sel = free.find((v) => v.id === selectedVid);
  if (sel) return sel.id;
  const ok = free.filter((v) => !v.cargo.length && v.battery > 35 && t >= v.stunnedUntil);
  ok.sort((a, b) => (a.state === 'idle' ? 0 : 1) - (b.state === 'idle' ? 0 : 1) || b.battery - a.battery);
  return (ok[0] ?? free[0])?.id ?? null;
}

/**
 * Run-over strip view: shown in the drive status bar once the player's timed run has finished
 * (the sim freezes a finished Blitz vehicle, so driving input no longer moves it).
 */
export function runOverView(
  me: Pick<Vehicle, 'runFinished' | 'runMode' | 'runPts' | 'sPts'> | null | undefined,
): { over: boolean; text: string } {
  if (!me?.runFinished) return { over: false, text: '' };
  const pts = Math.round(me.runPts ?? me.sPts ?? 0);
  return {
    over: true,
    text: `🏁 ${me.runMode === 'freerange' ? 'Run' : '3-Minute Blitz'} over · ${pts} pts — your forklift is parked until you start a new run`,
  };
}
