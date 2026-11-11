/** 3D vehicle models (AGV / counterbalance / reach) ported from the mock's vehicleParts/drawVehicle. */
import { BOOST_COLLISION_SPEED, type Vehicle } from '@warehouse/sim';
import { isoDepth } from './iso.js';
import type { Pose } from './motion.js';
import type { Painter } from './painter.js';
import { cargoPrims, teamColor } from './scenery.js';
import { forkHeightM, isoZ, ISO_PX_PER_M, TILE_M } from './liftGeometry.js';
import type { WheelMotion } from './wheels.js';

/**
 * Semantic tag for every part, so renderers can re-style parts by meaning instead of by colour /
 * size (e.g. the Cab View splits the mast into rails, hides the overhead guard, ghosts the hood).
 */
export type PartRole =
  | 'wheel'
  | 'hub'
  | 'lug'
  | 'chassis'
  | 'body'
  | 'trim'
  | 'counterweight'
  | 'bumper'
  | 'seat'
  | 'console'
  | 'guardPost'
  | 'guardRoof'
  | 'mast'
  | 'mastTie'
  | 'liftCylinder'
  | 'backrest'
  | 'fork'
  | 'forkTip'
  | 'leg'
  | 'skirt'
  | 'sensor'
  | 'light'
  | 'beacon'
  | 'brake'
  | 'cargo';

export interface Part {
  cx: number;
  cy: number;
  /** Box: length along the heading (tiles). Wheel: tyre diameter (tiles). */
  len: number;
  /** Box: width across the heading (tiles). Wheel: tread width (tiles). */
  wid: number;
  /** Bottom / height in iso-px. Wheels are drawn taller than true scale in iso for readability. */
  z0: number;
  h: number;
  hex: string;
  role?: PartRole;
  /**
   * `wheel` = cylinder whose axle runs across the heading; `cyl` = upright cylinder of diameter
   * `len` (carried cargo); default is an oriented box.
   */
  shape?: 'box' | 'wheel' | 'cyl';
  /** Yaw relative to the vehicle heading (rad), e.g. a steered wheel. */
  yaw?: number;
  /** Wheels only: true axle height in metres (the 3D Cab View draws true-scale round tyres). */
  axleM?: number;
}

export interface VehiclePartsOptions {
  /** Wheel roll / steer state (see `WheelOdometer`); wheels sit straight and still without it. */
  motion?: WheelMotion;
  /** Emit a rotating rim marker on each hub (3D only: sub-pixel in iso). */
  lugs?: boolean;
}

/** Collapsed (fully lowered) mast height in iso-px for counterbalance trucks. */
export const MAST_COLLAPSED_COUNTERBALANCE = 18;
/** Collapsed (fully lowered) mast height in iso-px for reach / turret trucks. */
export const MAST_COLLAPSED_REACH = 20;
/** Fork carriage backrest height (iso-px) plus the clearance the inner mast keeps above it. */
const CARRIAGE_TOP_CLEARANCE = 5.5 + 1.5;
/** True-scale iso-px per tile of height (1 tile = TILE_M metres). */
const PX_PER_TILE = TILE_M * ISO_PX_PER_M;
/**
 * Iso draws everything vertically compressed (6.5 px/m vs ~24 px/m across the floor), so a
 * true-scale tyre would read as a sliver. Wheels get this extra vertical stretch in iso only.
 */
export const WHEEL_ISO_STRETCH = 1.6;
/** Carried pallets are drawn smaller than floor pallets so they fit between mast and fork tips. */
const CARRIED_XY = 0.66;
const CARRIED_Z = 0.8;

/** Top of the telescoping mast (iso-px): stays collapsed until the carriage needs to rise past it. */
export function mastTopZ(forkZ: number, collapsed: number): number {
  return Math.max(collapsed, forkZ + CARRIAGE_TOP_CLEARANCE);
}

export type ModelKind = 'agv' | 'reach' | 'counterbalance';

/** Map the sim's vehicle types onto the three mock models. */
export function modelOf(type: string | undefined): ModelKind {
  if (type === 'agv') return 'agv';
  if (type === 'reach' || type === 'turret') return 'reach';
  return 'counterbalance';
}

const TYRE = '#111827';
const RIM = '#CBD5E1';
const RIM_MARK = '#F59E0B';
const STEEL_DARK = '#1E293B';
const STEEL = '#334155';
const STEEL_MID = '#475569';
const HAZARD = '#FBBF24';

export function vehicleParts(
  v: Vehicle,
  p: Pose,
  nowMs: number,
  siteId = 'den-1',
  includeCargo = true,
  camRot = 0,
  opts: VehiclePartsOptions = {},
): Part[] {
  const ca = Math.cos(p.a);
  const sa = Math.sin(p.a);
  const team = teamColor(v);
  const parts: Part[] = [];
  const model = modelOf(v.type);
  const travel = opts.motion?.travel ?? 0;
  const steer = opts.motion?.steer ?? 0;
  const add = (ox: number, oy: number, len: number, wid: number, z0: number, h: number, hex: string, role: PartRole) =>
    parts.push({ cx: p.x + ca * ox - sa * oy, cy: p.y + sa * ox + ca * oy, len, wid, z0, h, hex, role });

  /**
   * Tyre + rim (+ optional rotating rim marker). `d` is the true tyre diameter in tiles; iso
   * heights get `WHEEL_ISO_STRETCH`, the Cab View uses `axleM` for a true-scale round wheel.
   */
  const wheel = (ox: number, oy: number, d: number, tread: number, yaw = 0, rimHex = RIM) => {
    const cx = p.x + ca * ox - sa * oy;
    const cy = p.y + sa * ox + ca * oy;
    const axleM = (d * TILE_M) / 2;
    const hIso = d * PX_PER_TILE * WHEEL_ISO_STRETCH;
    parts.push({ cx, cy, len: d, wid: tread, z0: 0, h: hIso, hex: TYRE, role: 'wheel', shape: 'wheel', yaw, axleM });
    const dr = d * 0.56;
    const hr = dr * PX_PER_TILE * WHEEL_ISO_STRETCH;
    parts.push({
      cx,
      cy,
      len: dr,
      wid: tread + 0.016,
      z0: (hIso - hr) / 2,
      h: hr,
      hex: rimHex,
      role: 'hub',
      shape: 'wheel',
      yaw,
      axleM,
    });
    if (opts.lugs) {
      // Marker on the outboard rim face, rolling with distance travelled (true scale, 3D only).
      const phi = -travel / (d / 2);
      const r = (dr / 2) * 0.7;
      const fx = Math.cos(phi) * r;
      const lat = Math.sign(oy || 1) * (tread / 2 + 0.014);
      const cy2 = Math.cos(yaw);
      const sy2 = Math.sin(yaw);
      const lx = ox + cy2 * fx - sy2 * lat;
      const ly = oy + sy2 * fx + cy2 * lat;
      const zPx = (axleM + Math.sin(phi) * r * TILE_M) * ISO_PX_PER_M;
      const sz = 0.05 * TILE_M * ISO_PX_PER_M;
      parts.push({
        cx: p.x + ca * lx - sa * ly,
        cy: p.y + sa * lx + ca * ly,
        len: 0.05,
        wid: 0.012,
        z0: zPx - sz / 2,
        h: sz,
        hex: RIM_MARK,
        role: 'lug',
        yaw,
      });
    }
  };

  const fork = Number.isFinite(v.fork) ? v.fork : 0;
  const forkZ = isoZ(forkHeightM(fork)); // blade bottom, shared with rack beams (liftGeometry)
  const cargo = includeCargo ? (v.cargo ?? []) : [];
  /** Carried loads: the shared `cargoPrims` model, scaled to sit on the forks, stacked upward. */
  const cargoAt = (ox: number, z: number) => {
    let zz = z;
    for (const o of cargo) {
      const { prims, height } = cargoPrims(o, siteId);
      for (const q of prims) {
        const lx = ox + q.x * CARRIED_XY;
        const ly = q.y * CARRIED_XY;
        const part: Part = {
          cx: p.x + ca * lx - sa * ly,
          cy: p.y + sa * lx + ca * ly,
          len: q.w * CARRIED_XY,
          wid: q.d * CARRIED_XY,
          z0: zz + q.z0 * CARRIED_Z,
          h: q.h * CARRIED_Z,
          hex: q.hex,
          role: 'cargo',
        };
        if (q.kind === 'cyl') part.shape = 'cyl';
        parts.push(part);
      }
      zz += height * CARRIED_Z;
    }
  };

  /** Telescoping mast: twin rails per stage plus a tie bar across each stage's top. */
  const mast = (x: number, wid: number, base: number) => {
    const top = mastTopZ(forkZ, base);
    const rail = (dx: number, w: number, z0: number, h: number, hex: string) => {
      for (const sy of [-1, 1]) add(x + dx, sy * w, 0.07, 0.05, z0, h, hex, 'mast');
      add(x + dx, 0, 0.05, w * 2 + 0.05, z0 + h - 1.4, 1.4, hex, 'mastTie');
    };
    const half = wid / 2 - 0.05;
    rail(0, half, 0, base, STEEL);
    // Inner stage: same length as the outer one, slid up so its top meets the carriage
    // (previously a fixed 32/40 iso-px slab towered over the truck even with the forks down).
    if (top > base + 0.25) rail(0.012, half - 0.035, top - base, base, '#3B4A61');
    add(x - 0.02, 0, 0.05, 0.05, 2, top - 4, '#CBD5E1', 'liftCylinder');
    // Fork carriage: backrest plate + high-vis load-backrest bar.
    add(x + 0.04, 0, 0.04, wid - 0.06, forkZ, 5.5, STEEL_DARK, 'backrest');
    add(x + 0.045, 0, 0.03, wid - 0.04, forkZ + 4.6, 1.0, HAZARD, 'backrest');
    // Blades stop where the tips begin (overlapping coplanar boxes z-fight in the Cab View).
    for (const sy of [-1, 1]) {
      add(x + 0.18, sy * 0.12, 0.34, 0.06, forkZ, 2, STEEL_MID, 'fork');
      add(x + 0.39, sy * 0.12, 0.08, 0.06, forkZ, 2, '#F59E0B', 'forkTip'); // high-vis fork tips
    }
  };

  if (model === 'agv') {
    // Differential-drive AGV: dark skirt, two centre drive wheels just proud of the body.
    for (const sy of [-1, 1]) wheel(0, sy * 0.262, 0.2, 0.05, 0, '#64748B');
    add(0, 0, 0.9, 0.5, 0.6, 1.4, STEEL_DARK, 'skirt');
    add(0, 0, 0.9, 0.52, 1.8, 5.7, '#E2E8F0', 'body');
    add(0, 0, 0.84, 0.46, 7.5, 1.6, team, 'trim');
    for (const sy of [-1, 1]) add(0, sy * 0.262, 0.56, 0.008, 4.6, 0.8, '#38BDF8', 'light'); // status strip
    for (const sx of [-1, 1]) add(sx * 0.455, 0, 0.02, 0.5, 2.2, 1.5, HAZARD, 'bumper');
    add(0.38, 0, 0.1, 0.3, 7.5, 5, STEEL, 'sensor'); // LiDAR sensor bar
    add(0.41, 0, 0.06, 0.22, 9.2, 1.6, '#38BDF8', 'sensor'); // LiDAR optical lens
    cargoAt(-0.02, 9.2);
  } else {
    const reach = model === 'reach';
    const wid = reach ? 0.38 : 0.48;
    if (reach) {
      // Narrow-aisle reach truck: straddle legs with load wheels, steered rear drive wheel + caster.
      for (const sy of [-1, 1]) {
        add(0.2, sy * 0.2, 0.52, 0.06, 0.4, 1.8, STEEL_DARK, 'leg');
        add(0.455, sy * 0.2, 0.02, 0.065, 0.4, 1.8, HAZARD, 'leg');
        wheel(0.38, sy * 0.2, 0.12, 0.05);
      }
      wheel(-0.28, -0.07, 0.26, 0.09, -steer);
      wheel(-0.28, 0.12, 0.15, 0.06);
      add(-0.12, 0, 0.5, wid - 0.012, 2.4, 7.6, '#94A3B8', 'body'); // inset: no coplanar faces with the counterweight
      add(-0.12, 0, 0.5, wid + 0.01, 7.2, 0.9, team, 'trim');
      add(-0.36, 0, 0.24, wid, 2.4, 9.6, team, 'counterweight');
      add(-0.485, 0, 0.012, wid - 0.04, 3.4, 1.2, HAZARD, 'bumper');
      add(-0.1, 0, 0.3, 0.3, 10, 6, '#64748B', 'console');
      add(-0.1, 0, 0.2, 0.22, 10, 4.5, '#0F172A', 'seat');
      for (const sy of [-1, 1]) add(-0.3, sy * 0.16, 0.04, 0.04, 12, 12, STEEL, 'guardPost');
      add(-0.16, 0, 0.34, 0.36, 24, 1.6, STEEL_MID, 'guardRoof');
    } else {
      // Counterbalance: big front drive tyres under the mast, smaller rear steer tyres.
      for (const sy of [-1, 1]) {
        wheel(0.22, sy * 0.25, 0.36, 0.11);
        wheel(-0.27, sy * 0.225, 0.28, 0.09, -steer);
      }
      add(-0.04, 0, 0.72, wid - 0.08, 1.2, 2.4, STEEL_MID, 'chassis');
      add(-0.04, 0, 0.66, wid - 0.012, 3.4, 6.6, '#94A3B8', 'body'); // inset: no coplanar faces with the counterweight
      add(-0.04, 0, 0.6, wid + 0.012, 8.2, 1.0, team, 'trim');
      add(-0.36, 0, 0.26, wid, 3, 13, team, 'counterweight'); // counterweight carries the team colour
      add(-0.495, 0, 0.012, wid - 0.06, 4.2, 1.4, HAZARD, 'bumper');
      // Operator seat (cushion + back) & steering console
      add(-0.12, 0, 0.18, 0.22, 10, 2.2, '#0F172A', 'seat');
      add(-0.21, 0, 0.05, 0.2, 10, 5, '#0F172A', 'seat');
      add(0.08, 0, 0.08, 0.14, 10, 4, STEEL, 'console');
      for (const sx of [-0.22, 0.08]) for (const sy of [-1, 1]) add(sx, sy * 0.19, 0.04, 0.04, 10, 14, STEEL, 'guardPost');
      add(-0.07, 0, 0.4, 0.42, 24, 2, STEEL_MID, 'guardRoof'); // overhead guard
      for (const sy of [-1, 1]) add(0.27, sy * 0.17, 0.02, 0.06, 8.6, 1.2, '#FEF9C3', 'light'); // headlights
    }
    mast(0.4, wid, reach ? MAST_COLLAPSED_REACH : MAST_COLLAPSED_COUNTERBALANCE);
    cargoAt(0.62, forkZ + 2);
  }
  const blink = Math.floor(nowMs / 350) % 2 === 0 && (Math.abs(v.speedNow ?? 0) > 0.2 || v.state === 'picking');
  add(
    model === 'agv' ? -0.3 : -0.22,
    0,
    0.08,
    0.08,
    model === 'agv' ? 9.5 : model === 'reach' ? 25.6 : 26,
    3,
    blink ? '#FBBF24' : '#92400E',
    'beacon',
  );
  if (v.braking) for (const sy of [-1, 1]) add(model === 'agv' ? -0.45 : -0.5, sy * 0.15, 0.04, 0.08, 6, 3, '#EF4444', 'brake');
  parts.sort((a, b) => isoDepth(a.cx, a.cy, camRot) - isoDepth(b.cx, b.cy, camRot) || a.z0 - b.z0);
  return parts;
}


export const CHARGE_RATE_PER_MIN = 5;
export const CHARGE_CUE_PERIOD_MS = 1200;

export interface ChargeCueFrame {
  active: boolean;
  label: string;
  zOffset: number;
  alpha: number;
  ringRadius: number;
  ringZ: number;
}

/** True when an AI or human-driven vehicle is actively charging on a charger pad. */
export function isVehicleCharging(
  v: Pick<Vehicle, 'state' | 'humanCharging' | 'battery'>,
): boolean {
  return v.state === 'charging' || Boolean(v.humanCharging);
}

/**
 * Computes the floating "+5" charge visual cue animation state (rising label offset,
 * fade alpha, and ascending isometric energy ring) for a vehicle at `nowMs`.
 */
export function computeChargeVisualCue(
  v: Pick<Vehicle, 'state' | 'humanCharging' | 'battery'>,
  nowMs: number,
  reducedMotion = false,
): ChargeCueFrame {
  if (!isVehicleCharging(v)) {
    return { active: false, label: '', zOffset: 0, alpha: 0, ringRadius: 0, ringZ: 0 };
  }
  const label = `⚡ +${CHARGE_RATE_PER_MIN}`;
  if (reducedMotion) {
    return {
      active: true,
      label,
      zOffset: 10,
      alpha: 0.95,
      ringRadius: 0.64,
      ringZ: 14,
    };
  }
  const phase =
    (((nowMs % CHARGE_CUE_PERIOD_MS) + CHARGE_CUE_PERIOD_MS) % CHARGE_CUE_PERIOD_MS) /
    CHARGE_CUE_PERIOD_MS;
  const zOffset = phase * 22;
  const alpha = Math.max(0.15, Math.sin(phase * Math.PI));
  const ringZ = 4 + phase * 26;
  const ringRadius = 0.56 + 0.14 * Math.sin(phase * Math.PI);
  return { active: true, label, zOffset, alpha, ringRadius, ringZ };
}

export interface VehicleDrawState {
  worldT: number;
  dim: boolean;
  emphasised: boolean;
  brainError: boolean;
  pulse: (periodMs: number, phase?: number) => number; // 0..1 (constant when reduced motion)
  nowMs: number;
  reducedMotion?: boolean;
  siteId?: string;
  /** Wheel roll / steer from the renderer's `WheelOdometer` (wheels sit still without it). */
  motion?: WheelMotion;
}

/** Body footprint (tiles) for the ground shadow, centred `ox` ahead of the vehicle origin. */
export function footprintOf(model: ModelKind): { len: number; wid: number; ox: number } {
  if (model === 'agv') return { len: 0.94, wid: 0.58, ox: 0 };
  if (model === 'reach') return { len: 0.98, wid: 0.5, ox: 0.0 };
  return { len: 1.0, wid: 0.6, ox: -0.04 };
}

export function drawVehicle(
  pt: Painter,
  v: Vehicle,
  p: Pose,
  s: VehicleDrawState,
  siteId = s.siteId ?? 'den-1',
): void {
  const ctx = pt.ctx;
  const team = teamColor(v);
  ctx.save();
  ctx.globalAlpha = s.dim ? 0.4 : 1;
  const model = modelOf(v.type);
  if (typeof (pt as Partial<Painter>).footprintShadow === 'function') {
    const fp = footprintOf(model);
    pt.footprintShadow(p.x + Math.cos(p.a) * fp.ox, p.y + Math.sin(p.a) * fp.ox, fp.len, fp.wid, p.a, 0.32);
  } else {
    pt.poly(pt.circleGrid(p.x, p.y, 0.62), 'rgba(15,23,42,0.16)'); // contact shadow
  }
  pt.poly(pt.circleGrid(p.x, p.y, 0.72), null, team, s.emphasised ? 3 : 1.5); // team ring
  const speed = v.speedNow ?? 0;
  const stunned = s.worldT < (v.stunnedUntil ?? 0);
  const boosting =
    (Boolean(v.input?.boost) || (v.human && Math.abs(speed) > BOOST_COLLISION_SPEED)) && !stunned;
  if (boosting) {
    const hasCargo = (v.cargo?.length ?? 0) > 0;
    pt.poly(
      pt.circleGrid(p.x, p.y, 0.84),
      hasCargo ? 'rgba(239,68,68,0.18)' : 'rgba(245,158,11,0.18)',
      hasCargo ? '#EF4444' : '#F59E0B',
      2.2,
    );
  }
  if (Math.abs(speed) > 0.3 && !stunned) {
    const ca = Math.cos(p.a);
    const sa = Math.sin(p.a);
    const dir = Math.sign(speed);
    const n = -sa;
    const m = ca;
    pt.poly(
      [
        pt.P(p.x + ca * 0.5 * dir + n * 0.18, p.y + sa * 0.5 * dir + m * 0.18),
        pt.P(p.x + ca * 2.0 * dir + n * 0.55, p.y + sa * 2.0 * dir + m * 0.55),
        pt.P(p.x + ca * 2.0 * dir - n * 0.55, p.y + sa * 2.0 * dir - m * 0.55),
        pt.P(p.x + ca * 0.5 * dir - n * 0.18, p.y + sa * 0.5 * dir - m * 0.18),
      ],
      'rgba(253,230,138,0.22)',
    ); // headlight pool
  }
  const cue = computeChargeVisualCue(v, s.nowMs, Boolean(s.reducedMotion));
  if (cue.active) {
    const k = s.pulse(1257) * 2 - 1; // sin(now/200)
    pt.poly(pt.circleGrid(p.x, p.y, 0.8 + 0.08 * k), 'rgba(34,197,94,0.22)', '#16A34A', 2);
  }

  const camRot = pt.cam?.rot ?? 0;
  const canWheel = typeof (pt as Partial<Painter>).wheel === 'function';
  // LOD: rims are a couple of pixels when zoomed out; skip them there.
  const lowDetail = (pt.cam?.zoom ?? 1) < 0.9;
  for (const q of vehicleParts(v, p, s.nowMs, siteId, true, camRot, { motion: s.motion })) {
    if (lowDetail && q.role === 'hub') continue;
    const a = p.a + (q.yaw ?? 0);
    if (q.shape === 'wheel' && canWheel) pt.wheel(q.cx, q.cy, q.len, q.wid, a, q.z0, q.h, q.hex, 'rgba(15,23,42,0.35)');
    else if (q.shape === 'cyl' && typeof (pt as Partial<Painter>).cyl === 'function') pt.cyl(q.cx, q.cy, q.len / 2, q.z0, q.h, q.hex);
    else pt.oBox(q.cx, q.cy, q.len, q.wid, a, q.z0, q.h, q.hex, 'rgba(15,23,42,0.28)');
  }

  if (cue.active) {
    const ringPts: [number, number][] = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      ringPts.push(pt.P(p.x + Math.cos(a) * cue.ringRadius, p.y + Math.sin(a) * cue.ringRadius, cue.ringZ));
    }
    ctx.save();
    ctx.globalAlpha = (s.dim ? 0.4 : 1) * cue.alpha;
    pt.poly(ringPts, null, '#22C55E', 1.8);
    ctx.restore();
  }
  if (stunned) {
    ctx.setLineDash([5, 4]);
    pt.poly(pt.circleGrid(p.x, p.y, 0.85), null, '#DC2626', 2.5);
    ctx.setLineDash([]);
  }
  if (s.brainError) pt.poly(pt.circleGrid(p.x, p.y, 0.95), null, '#E11D48', 2.5);
  ctx.restore();
}
