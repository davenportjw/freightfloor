/** 3D vehicle models (AGV / counterbalance / reach) ported from the mock's vehicleParts/drawVehicle. */
import { BOOST_COLLISION_SPEED, getSiteTheme, type Vehicle } from '@warehouse/sim';
import type { Pose } from './motion.js';
import type { Painter } from './painter.js';
import { resolveCargoSpriteKey, teamColor } from './scenery.js';

export interface Part {
  cx: number;
  cy: number;
  len: number;
  wid: number;
  z0: number;
  h: number;
  hex: string;
}

export type ModelKind = 'agv' | 'reach' | 'counterbalance';

/** Map the sim's vehicle types onto the three mock models. */
export function modelOf(type: string | undefined): ModelKind {
  if (type === 'agv') return 'agv';
  if (type === 'reach' || type === 'turret') return 'reach';
  return 'counterbalance';
}

export function vehicleParts(
  v: Vehicle,
  p: Pose,
  nowMs: number,
  siteId = 'den-1',
  includeCargo = true,
): Part[] {
  const ca = Math.cos(p.a);
  const sa = Math.sin(p.a);
  const team = teamColor(v);
  const theme = getSiteTheme(siteId);
  const parts: Part[] = [];
  const model = modelOf(v.type);
  const add = (ox: number, oy: number, len: number, wid: number, z0: number, h: number, hex: string) =>
    parts.push({ cx: p.x + ca * ox - sa * oy, cy: p.y + sa * ox + ca * oy, len, wid, z0, h, hex });
  const fork = Number.isFinite(v.fork) ? v.fork : 0;
  const forkZ = 2 + fork * (model === 'reach' ? 26 : 20);
  const cargo = includeCargo ? (v.cargo ?? []) : [];
  const cargoAt = (ox: number, z: number) =>
    cargo.forEach((o, i) => {
      const zz = z + i * 13;
      if (theme.cargoStyle === 'plants') {
        add(ox, 0, 0.42, 0.4, zz, 2.5, '#A16207');
        add(ox, 0, 0.3, 0.3, zz + 2.5, 4.5, o.p0 ? '#DC2626' : '#C2410C');
        add(ox, 0, 0.38, 0.38, zz + 7.0, 5.5, '#16A34A');
      } else if (theme.cargoStyle === 'tech') {
        add(ox, 0, 0.42, 0.4, zz, 2.5, '#94A3B8');
        add(ox, 0, 0.36, 0.34, zz + 2.5, 8.5, o.p0 ? '#991B1B' : '#1E293B');
        add(ox, 0, 0.38, 0.36, zz + 6.5, 1.8, o.p0 ? '#F87171' : '#38BDF8');
      } else if (theme.cargoStyle === 'artisan') {
        add(ox, 0, 0.42, 0.4, zz, 2.5, '#A16207');
        add(ox, 0, 0.34, 0.34, zz + 2.5, 9.0, o.p0 ? '#DC2626' : '#78350F');
        add(ox, 0, 0.36, 0.36, zz + 6.2, 1.6, '#FBBF24');
      } else {
        add(ox, 0, 0.42, 0.4, zz, 3, '#C4A06B');
        add(ox, 0, 0.36, 0.34, zz + 3, 9, o.p0 ? '#F59E0B' : '#D9B98A');
      }
    });
  if (model === 'agv') {
    add(0, 0, 0.9, 0.52, 1.5, 6, '#E2E8F0');
    add(0, 0, 0.84, 0.46, 7.5, 1.6, team);
    add(0.38, 0, 0.1, 0.3, 7.5, 5, '#334155'); // LiDAR sensor bar
    add(0.41, 0, 0.06, 0.22, 9.2, 1.6, '#38BDF8'); // LiDAR optical lens
    cargoAt(-0.02, 9.2);
  } else {
    const reach = model === 'reach';
    const wid = reach ? 0.38 : 0.48;
    for (const sx of [-0.22, 0.24]) for (const sy of [-1, 1]) add(sx, sy * (wid / 2 + 0.02), 0.2, 0.1, 0, 5, '#1E293B');
    add(-0.04, 0, reach ? 0.62 : 0.74, wid, 3, 7, '#94A3B8');
    add(-0.36, 0, 0.26, wid, 3, reach ? 9 : 13, team); // counterweight carries the team colour
    // Operator seat & console detail
    add(-0.1, 0, 0.2, 0.22, 10, 4.5, '#0F172A');
    if (!reach) {
      for (const sx of [-0.22, 0.08]) for (const sy of [-1, 1]) add(sx, sy * 0.19, 0.04, 0.04, 10, 14, '#334155');
      add(-0.07, 0, 0.4, 0.42, 24, 2, '#475569'); // overhead guard
    } else {
      add(-0.1, 0, 0.3, 0.3, 10, 6, '#64748B');
    }
    const mastH = reach ? 40 : 32;
    add(0.4, 0, 0.08, wid - 0.08, 0, mastH, '#334155');
    add(0.38, 0, 0.05, 0.05, 2, mastH - 4, '#CBD5E1'); // hydraulic lift cylinder
    add(0.44, 0, 0.04, wid - 0.06, forkZ, 5.5, '#1E293B'); // fork carriage backrest
    for (const sy of [-1, 1]) {
      add(0.62, sy * 0.12, 0.42, 0.06, forkZ, 2, '#475569');
      add(0.79, sy * 0.12, 0.08, 0.06, forkZ, 2, '#F59E0B'); // high-vis fork tips
    }
    cargoAt(0.62, forkZ + 2);
  }
  const blink = Math.floor(nowMs / 350) % 2 === 0 && (Math.abs(v.speedNow ?? 0) > 0.2 || v.state === 'picking');
  add(
    model === 'agv' ? -0.3 : -0.22,
    0,
    0.08,
    0.08,
    model === 'agv' ? 9.5 : model === 'reach' ? 16 : 26,
    3,
    blink ? '#FBBF24' : '#92400E',
  ); // beacon
  if (v.braking) for (const sy of [-1, 1]) add(model === 'agv' ? -0.45 : -0.5, sy * 0.15, 0.04, 0.08, 6, 3, '#EF4444');
  parts.sort((a, b) => a.cx + a.cy - (b.cx + b.cy) || a.z0 - b.z0);
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
  pt.poly(pt.circleGrid(p.x, p.y, 0.62), 'rgba(15,23,42,0.16)'); // contact shadow
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

  const cargo = v.cargo ?? [];
  const forkRaised = (v.fork ?? 0) > 0.22;
  const useSpriteCargo =
    !forkRaised &&
    cargo.length > 0 &&
    typeof (pt as Partial<Painter>).hasSprite === 'function' &&
    typeof (pt as Partial<Painter>).sprite === 'function' &&
    pt.hasSprite(resolveCargoSpriteKey(cargo[0], siteId));

  for (const q of vehicleParts(v, p, s.nowMs, siteId, !useSpriteCargo)) {
    pt.oBox(q.cx, q.cy, q.len, q.wid, p.a, q.z0, q.h, q.hex, 'rgba(15,23,42,0.28)');
  }

  if (useSpriteCargo) {
    const model = modelOf(v.type);
    const fork = Number.isFinite(v.fork) ? v.fork : 0;
    const forkZ = 2 + fork * (model === 'reach' ? 26 : 20);
    const ox = model === 'agv' ? -0.02 : 0.62;
    const baseZ = model === 'agv' ? 9.2 : forkZ + 2;
    const gx = p.x + Math.cos(p.a) * ox;
    const gy = p.y + Math.sin(p.a) * ox;
    cargo.forEach((o, i) => {
      pt.sprite(resolveCargoSpriteKey(o, siteId), gx, gy, baseZ + i * 13, 1.05);
    });
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
