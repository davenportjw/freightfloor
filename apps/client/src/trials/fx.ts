/**
 * Floor Trials visual effects (client only; the sim never reads any of this).
 *
 * - `StackWhip`: a spring chain that turns the sim's single load-sway value into a per-tier stack
 *   lean, so upper pallets lag and overshoot the lower ones (a 3-stack whips into an S-curve).
 * - `swayWarn`: how close the load is to tipping (drives the red top-pallet tint).
 * - `TrialFx`: short-lived world effects (tumbling pallets, carton scatter, dust) and screen shake.
 */
import type { Painter } from '../render/painter.js';
import { CARGO_SWAY_LEAN, type CargoLean } from '../render/vehicles.js';

/** Lean target exponent: higher tiers lean disproportionately more (a tower bends, it doesn't shear). */
const LEAN_CURVE = 1.15;
/** Spring stiffness of the first boundary (1/s²); boundary k uses WHIP_K / k (higher = softer). */
const WHIP_K = 320;
/** Damping ratio of each boundary spring (<1 overshoots). */
const WHIP_ZETA = 0.42;
/** Integration substep (ms). */
const WHIP_SUBSTEP = 8;

/** Static lean target of boundary k (tiles) for a given sim sway, before any spring lag. */
export function leanTarget(sway: number, k: number): number {
  return sway * CARGO_SWAY_LEAN * Math.pow(k, LEAN_CURVE);
}

/** 0 while the load is steady, rising to 1 as |sway| approaches the topple threshold (1.0). */
export function swayWarn(sway: number): number {
  return Math.max(0, Math.min(1, (Math.abs(sway) - 0.55) / 0.4));
}

export class StackWhip {
  private x: number[] = [0];
  private v: number[] = [0];

  /** Current boundary offsets (tiles); `[0]` is the forks and is always 0. */
  get tiers(): readonly number[] {
    return this.x;
  }

  reset(): void {
    this.x = [0];
    this.v = [0];
  }

  /**
   * Advance by `dtMs` toward the lean for `sway` with `n` pallets carried. Each boundary chases its
   * parent's *actual* offset plus its own relative target, which is what makes the top whip.
   * With `instant` (reduced motion) the stack snaps straight to the static targets.
   */
  step(sway: number, n: number, dtMs: number, instant = false): readonly number[] {
    while (this.x.length < n + 1) {
      const k = this.x.length;
      this.x.push(leanTarget(sway, k));
      this.v.push(0);
    }
    this.x.length = n + 1;
    this.v.length = n + 1;
    if (instant) {
      for (let k = 1; k <= n; k++) {
        this.x[k] = leanTarget(sway, k);
        this.v[k] = 0;
      }
      return this.x;
    }
    let left = Math.max(0, Math.min(100, dtMs));
    while (left > 0) {
      const h = Math.min(WHIP_SUBSTEP, left) / 1000;
      left -= WHIP_SUBSTEP;
      for (let k = 1; k <= n; k++) {
        const K = WHIP_K / k;
        const C = 2 * WHIP_ZETA * Math.sqrt(K);
        const target = this.x[k - 1] + (leanTarget(sway, k) - leanTarget(sway, k - 1));
        this.v[k] += (K * (target - this.x[k]) - C * this.v[k]) * h;
        this.x[k] += this.v[k] * h;
      }
    }
    return this.x;
  }

  lean(sway: number): CargoLean {
    return { tiers: this.x, warn: swayWarn(sway) };
  }
}

/** A pallet falling off the stack: arc from the fork stack to its floor tile, then one bounce. */
export interface Tumble {
  orderId: number;
  from: { x: number; y: number; z: number };
  to: { x: number; y: number };
  angle: number;
  /** +1 / -1: the side it falls toward (spin direction). */
  side: number;
  startMs: number;
}

/** Flight and bounce durations (ms). */
export const TUMBLE_MS = 560;
export const BOUNCE_MS = 200;

/** Pose of a tumbling pallet `ms` after it left the stack (centre in tiles, base z in iso-px). */
export function tumblePose(t: Tumble, ms: number): { x: number; y: number; z: number; angle: number; tilt: number; done: boolean } {
  const u = Math.max(0, ms) / TUMBLE_MS;
  if (u < 1) {
    const e = u * u * (3 - 2 * u); // ease the ground track; the height carries the gravity feel
    return {
      x: t.from.x + (t.to.x - t.from.x) * e,
      y: t.from.y + (t.to.y - t.from.y) * e,
      z: Math.max(0, t.from.z * (1 - u * u) + 9 * u * (1 - u)),
      angle: t.angle + t.side * u * Math.PI * 0.75,
      tilt: t.side * Math.sin(u * Math.PI),
      done: false,
    };
  }
  const b = (ms - TUMBLE_MS) / BOUNCE_MS;
  return {
    x: t.to.x,
    y: t.to.y,
    z: b < 1 ? 3.5 * Math.sin(b * Math.PI) : 0,
    angle: t.angle + t.side * Math.PI * 0.75,
    tilt: 0,
    done: b >= 1,
  };
}

interface Puff {
  x: number;
  y: number;
  startMs: number;
  size: number;
}

interface Carton {
  x: number;
  y: number;
  dx: number;
  dy: number;
  startMs: number;
}

const PUFF_MS = 700;
const CARTON_MS = 900;
const SHAKE_DECAY_MS = 110;

export class TrialFx {
  private tumbles: Tumble[] = [];
  private puffs: Puff[] = [];
  private cartons: Carton[] = [];
  private landed = new WeakSet<Tumble>();
  private shakeMag = 0;
  private shakeAt = 0;
  readonly hidden = new Set<number>();

  constructor(private readonly reducedMotion: () => boolean) {}

  clear(): void {
    this.tumbles = [];
    this.puffs = [];
    this.cartons = [];
    this.hidden.clear();
    this.shakeMag = 0;
  }

  /** Screen shake in px (largest kick wins; decays exponentially). Skipped under reduced motion. */
  kick(px: number, nowMs: number): void {
    if (this.reducedMotion()) return;
    const cur = this.shakeNow(nowMs);
    if (px > cur) {
      this.shakeMag = px;
      this.shakeAt = nowMs;
    }
  }

  private shakeNow(nowMs: number): number {
    return this.shakeMag * Math.exp(-(nowMs - this.shakeAt) / SHAKE_DECAY_MS);
  }

  /** Current shake offset (px); a smooth two-frequency wobble rather than per-frame noise. */
  shakeOffset(nowMs: number): { x: number; y: number } {
    const m = this.shakeNow(nowMs);
    if (m < 0.25) return { x: 0, y: 0 };
    return { x: m * Math.sin(nowMs * 0.09), y: m * 0.7 * Math.cos(nowMs * 0.127) };
  }

  tumble(t: Tumble): void {
    if (this.reducedMotion()) {
      this.dust(t.to.x, t.to.y, 1, t.startMs);
      return;
    }
    this.hidden.add(t.orderId);
    this.tumbles.push(t);
  }

  /** True while a pallet is still in the air (or bouncing) toward floor tile (x, y). */
  landingOn(x: number, y: number): boolean {
    return this.tumbles.some((t) => Math.floor(t.to.x) === x && Math.floor(t.to.y) === y);
  }

  dust(x: number, y: number, size: number, nowMs: number): void {
    this.puffs.push({ x, y, startMs: nowMs, size });
  }

  private land(t: Tumble, nowMs: number): void {
    this.dust(t.to.x, t.to.y, 1, nowMs);
    for (let k = 0; k < 4; k++) {
      const a = t.angle + k * (Math.PI / 2) + 0.45;
      this.cartons.push({ x: t.to.x, y: t.to.y, dx: Math.cos(a) * 0.42, dy: Math.sin(a) * 0.42, startMs: nowMs });
    }
  }

  /** Draw every live effect; call from the renderer's `worldFx` pass. */
  draw(pt: Painter, nowMs: number): void {
    const ctx = pt.ctx;
    // Dust (under the falling crates).
    this.puffs = this.puffs.filter((p) => nowMs - p.startMs < PUFF_MS);
    for (const p of this.puffs) {
      const u = (nowMs - p.startMs) / PUFF_MS;
      ctx.save();
      ctx.globalAlpha = 0.4 * (1 - u);
      for (let k = 0; k < 5; k++) {
        const a = k * 1.2566 + p.size;
        const r = (0.12 + 0.45 * u) * p.size;
        const d = 0.25 * u * p.size;
        pt.poly(pt.circleGrid(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, r, 14), 'rgb(203,213,225)');
      }
      ctx.restore();
    }
    // Loose cartons skidding away from the landing point.
    this.cartons = this.cartons.filter((c) => nowMs - c.startMs < CARTON_MS);
    for (const c of this.cartons) {
      const u = (nowMs - c.startMs) / CARTON_MS;
      const e = 1 - (1 - u) * (1 - u);
      ctx.save();
      ctx.globalAlpha = u > 0.7 ? (1 - u) / 0.3 : 1;
      const hop = 6 * Math.max(0, Math.sin(Math.min(1, u * 1.6) * Math.PI));
      pt.oBox(c.x + c.dx * e, c.y + c.dy * e, 0.16, 0.14, c.dx * 7, hop, 5, '#D9B98A', 'rgba(15,23,42,0.28)');
      ctx.restore();
    }
    // Tumbling pallets (the real floor pallet stays hidden until the bounce ends).
    const live: Tumble[] = [];
    for (const t of this.tumbles) {
      const ms = nowMs - t.startMs;
      const q = tumblePose(t, ms);
      if (ms >= TUMBLE_MS && !this.landed.has(t)) {
        this.landed.add(t);
        this.land(t, nowMs);
      }
      if (q.done) {
        this.hidden.delete(t.orderId);
        this.landed.delete(t);
        continue;
      }
      live.push(t);
      const ca = Math.cos(q.angle);
      const sa = Math.sin(q.angle);
      const lat = q.tilt * 0.14; // the crate's top swings toward the fall side
      const shadowA = 0.1 + 0.12 * (1 - Math.min(1, q.z / 40));
      pt.poly(pt.circleGrid(q.x, q.y, 0.3, 16), `rgba(15,23,42,${shadowA.toFixed(3)})`);
      pt.oBox(q.x, q.y, 0.42, 0.4, q.angle, q.z, 3, '#C4A06B', 'rgba(15,23,42,0.28)');
      pt.oBox(q.x - sa * lat * 0.5, q.y + ca * lat * 0.5, 0.36, 0.34, q.angle, q.z + 3, 4.5, '#D9B98A', 'rgba(15,23,42,0.28)');
      pt.oBox(q.x - sa * lat, q.y + ca * lat, 0.36, 0.34, q.angle, q.z + 7.5, 4.5, '#D9B98A', 'rgba(15,23,42,0.28)');
    }
    this.tumbles = live;
  }
}
