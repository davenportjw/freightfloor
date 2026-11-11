/**
 * Client-only wheel animation state: how far each vehicle has rolled (for spinning wheel hubs)
 * and an estimated steering angle (for the counterbalance / reach steer wheels), derived purely
 * from the smoothed render poses. Visual only — never fed back into the sim.
 */
import { wrapAngle, type Pose } from './motion.js';

export interface WheelMotion {
  /** Signed distance rolled along the heading (tiles); a wheel of radius r has turned travel / r rad. */
  travel: number;
  /** Steering angle (rad, + = turning toward +heading rotation); 0 when driving straight. */
  steer: number;
}

/** Wheelbase used to turn yaw rate into an Ackermann steer angle (tiles). */
const WHEELBASE_TILES = 0.48;
/** Max visual steer lock (rad). */
export const MAX_STEER = 0.75;
/** Ignore pose jumps larger than this (teleport / respawn / site hop), in tiles. */
const TELEPORT_TILES = 1.5;
/** Steer smoothing time constant (ms). */
const STEER_TAU_MS = 140;
/** Drop vehicles not seen for this long (ms). */
const STALE_MS = 5000;

interface Entry {
  x: number;
  y: number;
  a: number;
  travel: number;
  steer: number;
  ms: number;
}

export class WheelOdometer {
  private readonly s = new Map<string, Entry>();
  private calls = 0;

  /** Advance one vehicle to its current render pose and return its wheel motion. */
  update(id: string, p: Pose, nowMs: number): WheelMotion {
    const e = this.s.get(id);
    if (!e) {
      this.s.set(id, { x: p.x, y: p.y, a: p.a, travel: 0, steer: 0, ms: nowMs });
      this.maybePrune(nowMs);
      return { travel: 0, steer: 0 };
    }
    const dtMs = nowMs - e.ms;
    if (dtMs > 0) {
      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const dist = Math.hypot(dx, dy);
      if (dist < TELEPORT_TILES) {
        // Signed by whether we moved along or against the heading (reversing spins backwards).
        const along = dx * Math.cos(p.a) + dy * Math.sin(p.a);
        const ds = along >= 0 ? dist : -dist;
        e.travel += ds;
        const dA = wrapAngle(p.a - e.a);
        let target = 0;
        if (Math.abs(ds) > 1e-4) target = Math.atan((WHEELBASE_TILES * dA) / ds);
        else if (Math.abs(dA) > 1e-4) target = Math.sign(dA) * MAX_STEER; // pivot on the spot
        target = Math.max(-MAX_STEER, Math.min(MAX_STEER, target));
        const k = 1 - Math.exp(-dtMs / STEER_TAU_MS);
        e.steer += (target - e.steer) * k;
      }
      e.x = p.x;
      e.y = p.y;
      e.a = p.a;
      e.ms = nowMs;
    }
    this.maybePrune(nowMs);
    return { travel: e.travel, steer: e.steer };
  }

  private maybePrune(nowMs: number): void {
    if (++this.calls % 256) return;
    for (const [id, e] of this.s) if (nowMs - e.ms > STALE_MS) this.s.delete(id);
  }
}
