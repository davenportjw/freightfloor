/**
 * Pure Cab View (first-person) math: no three.js / DOM, safe for node tests.
 *
 * Coordinate convention (three.js world, metres): X = grid x · TILE_M, Z = grid y · TILE_M,
 * Y = up. The sim heading `a` (`atan2(dy, dx)` on the y-down grid) points along (cos a, 0, sin a).
 */
import { TILE_M, forkHeightM } from '../render/liftGeometry.js';

/** Operator eye height (m) above the floor. */
export const EYE_M = 2.0;
/** Eye position along the heading, relative to the vehicle centre (tiles; seat is at −0.1). */
export const EYE_FWD_TILES = -0.12;
/** Fork tip distance ahead of the vehicle centre (tiles), matching `vehicleParts` (0.79). */
export const FORK_TIP_TILES = 0.79;
/** Resting head pitch (rad, negative = looking down) so the fork tips sit in the lower frame. */
export const REST_PITCH = -0.28;
export const MIN_PITCH = -0.6;
export const MAX_PITCH = 0.8;
/** Head-tilt smoothing time constant (ms). */
export const TILT_TAU_MS = 120;
/** Vertical field of view (degrees). */
export const CAB_FOV = 70;

/** three.js camera yaw (rotation.y, order 'YXZ') that looks along sim heading `a`. */
export function cabYaw(a: number): number {
  return -a - Math.PI / 2;
}

/** three.js object yaw (rotation.y) that aligns a +X-length box with sim heading `a`. */
export function objectYaw(a: number): number {
  return -a;
}

/** Grid (tiles) → three.js metres on the floor plane. */
export function gridToWorld(gx: number, gy: number): { x: number; z: number } {
  return { x: gx * TILE_M, z: gy * TILE_M };
}

export interface CabEye {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Eye pose for a vehicle pose (grid x/y, heading a). */
export function cabEye(pose: { x: number; y: number; a: number }): CabEye {
  const gx = pose.x + Math.cos(pose.a) * EYE_FWD_TILES;
  const gy = pose.y + Math.sin(pose.a) * EYE_FWD_TILES;
  const w = gridToWorld(gx, gy);
  return { x: w.x, y: EYE_M, z: w.z, yaw: cabYaw(pose.a) };
}

/**
 * Head pitch the cab camera eases toward. While a rack lift is active the head tilts up toward
 * the midpoint between the fork tips and the target pallet pocket, so both stay in frame at L3.
 */
export function headTiltTarget(opts: {
  lifting: boolean;
  fork: number;
  pocketM?: number | null;
  reducedMotion?: boolean;
}): number {
  if (!opts.lifting || opts.reducedMotion) return REST_PITCH;
  const forkM = forkHeightM(opts.fork);
  const lookM = opts.pocketM != null ? (forkM + opts.pocketM) / 2 : forkM;
  const dist = (FORK_TIP_TILES - EYE_FWD_TILES) * TILE_M;
  const p = Math.atan2(lookM - EYE_M, dist) * 0.9;
  return Math.max(MIN_PITCH, Math.min(MAX_PITCH, p));
}

/** Frame-rate independent exponential approach. */
export function damp(current: number, target: number, dtMs: number, tauMs = TILT_TAU_MS): number {
  if (!(dtMs > 0)) return current;
  const k = 1 - Math.exp(-dtMs / Math.max(1, tauMs));
  return current + (target - current) * k;
}

/**
 * Touch stick → driver input in Cab View. The camera turns with the truck, so "camera-relative"
 * means stick-up = throttle, stick-left/right = steer — exactly the keyboard's tank steering.
 * We deliberately drop the absolute `moveAngle` (it would be re-aimed every frame as the heading
 * turns underneath it, making the truck chase its own tail).
 */
export function cabTouchDirs(dirs: {
  up?: boolean;
  down?: boolean;
  left?: boolean;
  right?: boolean;
  moveAngle?: number | null;
}): { up: boolean; down: boolean; left: boolean; right: boolean; moveAngle: null } {
  return {
    up: Boolean(dirs.up),
    down: Boolean(dirs.down),
    left: Boolean(dirs.left),
    right: Boolean(dirs.right),
    moveAngle: null,
  };
}

/** A rack face (boundary between a rack tile and its aisle access tile). */
export interface RackFace {
  /** Face centre on the floor (grid units). */
  gx: number;
  gy: number;
  /** Unit normal pointing from the rack into the aisle (grid units). */
  nx: number;
  ny: number;
}

export function rackFace(slot: { rx: number; ry: number; ax: number; ay: number }): RackFace {
  const dx = slot.ax - slot.rx;
  const dy = slot.ay - slot.ry;
  const len = Math.hypot(dx, dy) || 1;
  const nx = dx / len;
  const ny = dy / len;
  return { gx: slot.rx + 0.5 + nx * 0.5, gy: slot.ry + 0.5 + ny * 0.5, nx, ny };
}

/** Lift grade colour for a fork value against server windows. */
export function liftGradeAt(
  fork: number,
  win: { targetFork: number; perfectWindow: number; cleanWindow: number },
): 'perfect' | 'clean' | 'scrape' {
  const err = Math.abs(fork - win.targetFork);
  if (err <= win.perfectWindow) return 'perfect';
  if (err <= win.cleanWindow) return 'clean';
  return 'scrape';
}
