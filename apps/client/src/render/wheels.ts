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
  /**
   * Body pitch (rad, + = nose down): the truck dips forward when braking and squats back when
   * accelerating, and the mast sways with it. Derived from the smoothed longitudinal acceleration.
   */
  pitch?: number;
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
/** Pitch per tile/s² of deceleration (rad), clamped to ±MAX_PITCH. */
const PITCH_PER_ACCEL = 0.012;
export const MAX_PITCH = 0.06;
/** Speed / pitch smoothing time constants (ms): speed is noisy at 10 Hz, pitch should feel springy. */
const SPEED_TAU_MS = 90;
const PITCH_TAU_MS = 160;

interface Entry {
  x: number;
  y: number;
  a: number;
  travel: number;
  steer: number;
  speed: number;
  pitch: number;
  ms: number;
}

export class WheelOdometer {
  private readonly s = new Map<string, Entry>();
  private calls = 0;

  /** Advance one vehicle to its current render pose and return its wheel motion. */
  update(id: string, p: Pose, nowMs: number): WheelMotion {
    const e = this.s.get(id);
    if (!e) {
      this.s.set(id, { x: p.x, y: p.y, a: p.a, travel: 0, steer: 0, speed: 0, pitch: 0, ms: nowMs });
      this.maybePrune(nowMs);
      return { travel: 0, steer: 0, pitch: 0 };
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
        // Longitudinal speed (tiles/s, signed) → acceleration → pitch (braking dips the nose).
        const sec = dtMs / 1000;
        const prevSpeed = e.speed;
        e.speed += (ds / sec - e.speed) * (1 - Math.exp(-dtMs / SPEED_TAU_MS));
        const accel = (e.speed - prevSpeed) / sec;
        // Inertia pitches the body against the acceleration: braking forward (or speeding up in
        // reverse) dips the nose; accelerating forward (or braking in reverse) squats the rear.
        const pitchTarget = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, -accel * PITCH_PER_ACCEL));
        e.pitch += (pitchTarget - e.pitch) * (1 - Math.exp(-dtMs / PITCH_TAU_MS));
      }
      e.x = p.x;
      e.y = p.y;
      e.a = p.a;
      e.ms = nowMs;
    }
    this.maybePrune(nowMs);
    return { travel: e.travel, steer: e.steer, pitch: e.pitch };
  }

  private maybePrune(nowMs: number): void {
    if (++this.calls % 256) return;
    for (const [id, e] of this.s) if (nowMs - e.ms > STALE_MS) this.s.delete(id);
  }
}
