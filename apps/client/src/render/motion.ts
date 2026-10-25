/**
 * Pure motion helpers: angle wrap, pose interpolation between the last two server
 * world.t values, and nearest-vehicle picking. No DOM access.
 */

export interface Pose {
  x: number;
  y: number;
  a: number;
}

/** Wrap an angle difference into [-PI, PI]. */
export function wrapAngle(d: number): number {
  const twoPi = Math.PI * 2;
  let r = d % twoPi;
  if (r > Math.PI) r -= twoPi;
  else if (r < -Math.PI) r += twoPi;
  return r;
}

/** Interpolate from `prev` to `curr` (mock `pose(v, al)`), taking the short way round for the angle. */
export function lerpPose(prev: Pose, curr: Pose, alpha: number): Pose {
  const al = Math.max(0, Math.min(1, alpha));
  return {
    x: prev.x + (curr.x - prev.x) * al,
    y: prev.y + (curr.y - prev.y) * al,
    a: prev.a + wrapAngle(curr.a - prev.a) * al,
  };
}

/** Fraction of the inter-update interval elapsed since the last world.t change, clamped to [0, 1]. */
export function interpAlpha(nowMs: number, changedAtMs: number, intervalMs: number): number {
  if (!(intervalMs > 0)) return 1;
  return Math.max(0, Math.min(1, (nowMs - changedAtMs) / intervalMs));
}

/** Id of the pose nearest to (gx, gy) strictly within `maxDist` tiles, or null. */
export function pickNearest(
  poses: Iterable<[string, { x: number; y: number }]>,
  gx: number,
  gy: number,
  maxDist = 1.1,
): string | null {
  let best: string | null = null;
  let bd = maxDist;
  for (const [id, p] of poses) {
    const d = Math.hypot(p.x - gx, p.y - gy);
    if (d < bd) {
      bd = d;
      best = id;
    }
  }
  return best;
}

interface Track {
  prev: Pose;
  mid: Pose;
  curr: Pose;
}

/** Teleports longer than this (tiles) snap instead of sliding. */
const SNAP_DIST = 4;

/**
 * Keeps prev/mid/curr poses per vehicle id and interpolates smoothly across server
 * `world.t` ticks. During `[0, interval]` each track slides from its on-screen `prev`
 * pose toward the 2-tick midpoint `mid = lerpPose(prevRaw, currRaw, 0.5)`, filtering out
 * tile-center cadence variations in `stepAI`; during `(interval, 2 * interval]` it
 * continues seamlessly from `mid` to `curr` so a late network frame never stalls at 0 px/frame.
 */
export class PoseTracker {
  private tracks = new Map<string, Track>();
  private lastT = Number.NaN;
  private changedAt = 0;
  private interval = 100;

  private evalTrack(tr: Track, nowMs: number): Pose {
    if (!(this.interval > 0)) return tr.curr;
    const u = Math.max(0, (nowMs - this.changedAt) / this.interval);
    if (u <= 1) return lerpPose(tr.prev, tr.mid, u);
    return lerpPose(tr.mid, tr.curr, Math.min(1, u - 1));
  }

  update(
    worldT: number,
    nowMs: number,
    vehicles: ReadonlyArray<{ id: string; px: number; py: number; angle: number }>,
  ): void {
    const tChanged = worldT !== this.lastT;
    const prevChangedAt = this.changedAt;
    const prevInterval = this.interval;
    if (tChanged) {
      if (!Number.isNaN(this.lastT)) {
        const dt = nowMs - prevChangedAt;
        if (dt > 0) this.interval = this.interval * 0.7 + Math.max(30, Math.min(1000, dt)) * 0.3;
      }
      this.lastT = worldT;
      this.changedAt = nowMs;
    }
    const seen = new Set<string>();
    for (const v of vehicles) {
      seen.add(v.id);
      const actual: Pose = { x: v.px, y: v.py, a: v.angle };
      const tr = this.tracks.get(v.id);
      if (!tr) {
        this.tracks.set(v.id, { prev: actual, mid: actual, curr: actual });
        continue;
      }
      if (tChanged) {
        const u = prevInterval > 0 ? Math.max(0, (nowMs - prevChangedAt) / prevInterval) : 2;
        const onScreen =
          u <= 1 ? lerpPose(tr.prev, tr.mid, u) : lerpPose(tr.mid, tr.curr, Math.min(1, u - 1));
        if (Math.hypot(actual.x - onScreen.x, actual.y - onScreen.y) > SNAP_DIST) {
          tr.prev = actual;
          tr.mid = actual;
          tr.curr = actual;
        } else {
          tr.prev = onScreen;
          tr.mid = lerpPose(tr.curr, actual, 0.5);
          tr.curr = actual;
        }
      } else {
        tr.curr = actual;
        if (Math.hypot(tr.curr.x - tr.prev.x, tr.curr.y - tr.prev.y) > SNAP_DIST) {
          tr.prev = actual;
          tr.mid = actual;
        }
      }
    }
    for (const id of this.tracks.keys()) if (!seen.has(id)) this.tracks.delete(id);
  }

  alpha(nowMs: number): number {
    return interpAlpha(nowMs, this.changedAt, this.interval);
  }

  /** Interpolated pose, or null for an unknown id. */
  pose(id: string, nowMs: number): Pose | null {
    const tr = this.tracks.get(id);
    return tr ? this.evalTrack(tr, nowMs) : null;
  }

  clear(): void {
    this.tracks.clear();
    this.lastT = Number.NaN;
  }
}
