/**
 * Pure motion helpers: angle wrap, jitter-buffered pose interpolation on the server
 * world.t timeline, and nearest-vehicle picking. No DOM access.
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

interface Sample {
  /** Server world time (game-min; 0.1 per 100 ms tick at 1x). */
  t: number;
  pose: Pose;
}

interface Track {
  samples: Sample[];
}

/** Teleports longer than this (tiles) snap instead of sliding. */
const SNAP_DIST = 4;
/** Real ms per game-minute at the server's fixed 1x rate (TICK_MIN 0.1 per 100 ms tick). */
const MS_PER_WORLD_MIN = 1000;
/**
 * Playout delay (ms) behind the earliest-possible arrival of each server tick (tuned on recorded
 * live deltas: 150 ms still starved, 250 ms is within ~25% of jitter-free smoothness). Deltas reach the
 * browser with 50–200 ms spacing (network + Cloud Run timer jitter), so remote poses are
 * rendered on a server-time timeline this far in the past instead of being advanced by packet
 * arrival — which made every rival speed up and stall in step with the jitter.
 */
export const INTERP_DELAY_MS = 250;
const MAX_SAMPLES = 10;

/**
 * Jitter-buffered remote-pose interpolation (the standard "entity interpolation" approach):
 * every delta is stored with its server `world.t`, a local clock maps server time to
 * `performance.now()` using the lower envelope of observed arrival offsets, and each frame
 * evaluates the track at `now - offset - INTERP_DELAY_MS`. Poses come from the midpoints of
 * consecutive samples, which filters `stepAI`'s alternating tile-centre cadence (0.75 / 0.25
 * tiles per tick) into a steady 0.5 tiles per tick.
 */
export class PoseTracker {
  private tracks = new Map<string, Track>();
  private lastT = Number.NaN;
  /** Lower envelope of (arrival ms - server ms); NaN until the first delta. */
  private targetOffset = Number.NaN;
  /** Offset actually used for rendering: slews toward `targetOffset` (max ±8% time warp). */
  private offset = Number.NaN;
  private lastNowMs = Number.NaN;

  constructor(private readonly delayMs = INTERP_DELAY_MS) {}

  /** Server world time (game-min) to render at `nowMs`. */
  private renderT(nowMs: number): number {
    if (Number.isNaN(this.offset)) return this.lastT;
    return (nowMs - this.offset - this.delayMs) / MS_PER_WORLD_MIN;
  }

  private evalTrack(tr: Track, rt: number): Pose {
    const s = tr.samples;
    if (s.length === 1 || !Number.isFinite(rt)) return s[s.length - 1]!.pose;
    // Midpoint curve: knot k sits halfway between samples k and k+1 (in time and pose).
    const knotT = (k: number) => (s[k]!.t + s[k + 1]!.t) / 2;
    const knotP = (k: number) => lerpPose(s[k]!.pose, s[k + 1]!.pose, 0.5);
    const last = s.length - 2;
    if (rt <= knotT(0)) {
      // Before the first knot: slide in from the first sample.
      const t0 = s[0]!.t;
      const k0 = knotT(0);
      return rt <= t0 ? s[0]!.pose : lerpPose(s[0]!.pose, knotP(0), (rt - t0) / (k0 - t0));
    }
    for (let k = 0; k < last; k++) {
      const ta = knotT(k);
      const tb = knotT(k + 1);
      if (rt <= tb) return lerpPose(knotP(k), knotP(k + 1), (rt - ta) / (tb - ta));
    }
    // Past the newest knot (late / lost delta): finish sliding to the newest sample, then hold.
    // No extrapolation beyond it, so a late packet never causes a backwards correction.
    const tk = knotT(last);
    const tn = s[last + 1]!.t;
    return tn > tk ? lerpPose(knotP(last), s[last + 1]!.pose, (rt - tk) / (tn - tk)) : s[last + 1]!.pose;
  }

  update(
    worldT: number,
    nowMs: number,
    vehicles: ReadonlyArray<{ id: string; px: number; py: number; angle: number }>,
  ): void {
    const tChanged = worldT !== this.lastT;
    if (tChanged) {
      if (!Number.isNaN(this.lastT) && worldT < this.lastT) {
        // Server clock went backwards (reconnect / new world): restart the timeline.
        this.tracks.clear();
        this.targetOffset = Number.NaN;
        this.offset = Number.NaN;
      }
      this.lastT = worldT;
      const sample = nowMs - worldT * MS_PER_WORLD_MIN;
      if (Number.isNaN(this.targetOffset) || Math.abs(sample - this.targetOffset) > 1000) {
        // First delta or a long stall / clock jump: resync hard.
        this.targetOffset = sample;
        this.offset = sample;
      } else if (sample < this.targetOffset) {
        this.targetOffset = sample; // an earlier arrival than any so far
      } else {
        this.targetOffset += (sample - this.targetOffset) * 0.01; // slow upward drift tracking
      }
    }
    // Slew the render clock toward the target instead of jumping, so a single early packet
    // never teleports every remote vehicle forward.
    if (!Number.isNaN(this.offset) && !Number.isNaN(this.lastNowMs) && nowMs > this.lastNowMs) {
      const maxStep = (nowMs - this.lastNowMs) * 0.08;
      const diff = this.targetOffset - this.offset;
      this.offset += Math.max(-maxStep, Math.min(maxStep, diff));
    }
    this.lastNowMs = nowMs;
    const seen = new Set<string>();
    for (const v of vehicles) {
      seen.add(v.id);
      const actual: Pose = { x: v.px, y: v.py, a: v.angle };
      const tr = this.tracks.get(v.id);
      if (!tr) {
        this.tracks.set(v.id, { samples: [{ t: worldT, pose: actual }] });
        continue;
      }
      const lastS = tr.samples[tr.samples.length - 1]!;
      if (Math.hypot(actual.x - lastS.pose.x, actual.y - lastS.pose.y) > SNAP_DIST) {
        tr.samples = [{ t: worldT, pose: actual }];
      } else if (worldT > lastS.t) {
        tr.samples.push({ t: worldT, pose: actual });
        if (tr.samples.length > MAX_SAMPLES) tr.samples.shift();
      } else {
        lastS.pose = actual; // same tick re-sent: keep the latest pose
      }
    }
    for (const id of this.tracks.keys()) if (!seen.has(id)) this.tracks.delete(id);
  }

  /** Interpolated pose, or null for an unknown id. */
  pose(id: string, nowMs: number): Pose | null {
    const tr = this.tracks.get(id);
    return tr ? this.evalTrack(tr, this.renderT(nowMs)) : null;
  }

  clear(): void {
    this.tracks.clear();
    this.lastT = Number.NaN;
    this.targetOffset = Number.NaN;
    this.offset = Number.NaN;
    this.lastNowMs = Number.NaN;
  }
}
