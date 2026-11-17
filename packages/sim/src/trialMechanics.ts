/**
 * Floor Trials challenge mechanics (levels 7–18): pure, deterministic helpers and constants.
 *
 * Every mechanic here is opt-in through an optional `TrialLevel` field (see trials.ts); a level
 * that sets none of them plays exactly like the original "Getting started" levels.
 *
 * - **Dock windows**: a bay only accepts drops while its window is open
 *   (`(t + offset) mod period < open`, `t` = level clock).
 * - **Scripted traffic**: AI forklifts on fixed loops. Their pose is a pure function of the level
 *   clock, so replays and tests are exact. Touching one is a strike.
 * - **Weight**: heavy pallets stabilise a stack from the bottom and destabilise it from the top.
 * - **Fragile**: glass pallets tip at a lower sway and shatter (instant fail) when they fall.
 * - **Battery**: a per-tile charge budget, refilled only on the level's highlighted chargers.
 */
import type { Point } from './types.js';

/** A bay's timed acceptance window (game-min ≈ seconds on the level clock). */
export interface TrialWindow {
  /** Full cycle length. */
  period: number;
  /** Open time at the start of each cycle. */
  open: number;
  /** Clock offset (shifts the cycle; lets two bays alternate). */
  offset?: number;
}

/** A scripted AI forklift driving a closed loop of axis-aligned waypoints at constant speed. */
export interface TrialTraffic {
  /** Loop waypoints (tile coords). The last point connects back to the first. Two points = shuttle. */
  path: Point[];
  /** Cruise speed along the loop (tiles / game-min). */
  speed: number;
  /** Starting distance along the loop (tiles). */
  phase?: number;
}

/** Battery budget for a level: drains with distance driven, refills on the listed chargers. */
export interface TrialBattery {
  /** Charge (%) at the start. */
  start: number;
  /** Charge (%) used per tile driven. */
  perTile: number;
  /** Charger tiles (subset of `map.chargers`) that work in this level. */
  chargers: Point[];
}

/** Sway at which a stack carrying a glass (fragile) pallet tips (plain stacks tip at 1.0). */
export const FRAGILE_SWAY_LIMIT = 0.55;
/** Sway gain multiplier when the bottom pallet is heavy (ballast). */
export const HEAVY_BASE_GAIN = 0.8;
/** Sway gain multiplier for each heavy pallet resting above a light one (top-heavy). */
export const HEAVY_TOP_GAIN = 1.6;
/** Battery (%) restored per game-min while parked on a working charger. */
export const CHARGE_RATE = 30;
/** Max |speed| that still counts as parked on a charger. */
export const CHARGE_MAX_SPEED = 0.3;
/** Battery level (%) that raises the low-battery warning. */
export const BATTERY_LOW = 20;
/** Centre distance (tiles) at which the player truck touches a traffic forklift. */
export const TRAFFIC_HIT = 0.8;
/** Game-min after a traffic hit before the same forklift can strike again. */
export const TRAFFIC_COOLDOWN = 3;
/** Sway kick (× stack gain) from being hit by traffic. */
export const TRAFFIC_KICK = 2.4;

/** Window state of a bay at level time `t`, or null when the bay has no window. */
export function windowState(
  windows: Readonly<Record<string, TrialWindow>> | undefined,
  bayId: string,
  t: number,
): { open: boolean; left: number } | null {
  const w = windows?.[bayId];
  if (!w) return null;
  const phase = (((t + (w.offset ?? 0)) % w.period) + w.period) % w.period;
  return phase < w.open ? { open: true, left: w.open - phase } : { open: false, left: w.period - phase };
}

/** Game-min to wait at time `t` before the bay accepts a drop (0 when open or unwindowed). */
export function windowWait(windows: Readonly<Record<string, TrialWindow>> | undefined, bayId: string, t: number): number {
  const s = windowState(windows, bayId, t);
  return !s || s.open ? 0 : s.left;
}

function loopLength(path: readonly Point[]): number {
  let len = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    const b = path[(i + 1) % path.length];
    len += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
  }
  return len;
}

/** Every tile a traffic loop drives over (for validation and client lane hints). */
export function trafficTiles(tr: TrialTraffic): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < tr.path.length; i++) {
    const a = tr.path[i];
    const b = tr.path[(i + 1) % tr.path.length];
    const n = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    const dx = Math.sign(b.x - a.x);
    const dy = Math.sign(b.y - a.y);
    for (let k = 0; k < n; k++) out.push({ x: a.x + dx * k, y: a.y + dy * k });
  }
  return out;
}

/**
 * Pose of a scripted forklift at level time `t`: centre in tile units (+0.5) and heading.
 * Pure function of `t`; the forklift is parked at its phase point before the clock starts.
 */
export function trafficPose(tr: TrialTraffic, t: number): { x: number; y: number; a: number } {
  const L = loopLength(tr.path);
  if (L <= 0 || tr.path.length < 2) {
    const p = tr.path[0] ?? { x: 0, y: 0 };
    return { x: p.x + 0.5, y: p.y + 0.5, a: 0 };
  }
  let s = ((((tr.phase ?? 0) + tr.speed * Math.max(0, t)) % L) + L) % L;
  for (let i = 0; i < tr.path.length; i++) {
    const a = tr.path[i];
    const b = tr.path[(i + 1) % tr.path.length];
    const seg = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (s <= seg || i === tr.path.length - 1) {
      const u = seg ? Math.min(1, s / seg) : 0;
      return {
        x: a.x + (b.x - a.x) * u + 0.5,
        y: a.y + (b.y - a.y) * u + 0.5,
        a: Math.atan2(b.y - a.y, b.x - a.x),
      };
    }
    s -= seg;
  }
  return { x: tr.path[0].x + 0.5, y: tr.path[0].y + 0.5, a: 0 };
}

/**
 * Sway gain multiplier for a stack listed bottom → top. 1 for an all-light stack, so levels
 * without heavy pallets are unchanged.
 */
export function stackWeightFactor(heavy: readonly boolean[]): number {
  if (!heavy.some(Boolean)) return 1;
  let f = heavy[0] ? HEAVY_BASE_GAIN : 1;
  let lightBelow = !heavy[0];
  for (let i = 1; i < heavy.length; i++) {
    if (heavy[i] && lightBelow) f *= HEAVY_TOP_GAIN;
    if (!heavy[i]) lightBelow = true;
  }
  return f;
}
