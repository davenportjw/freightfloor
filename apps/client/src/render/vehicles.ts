/** 3D vehicle models (AGV / counterbalance / reach) ported from the mock's vehicleParts/drawVehicle. */
import type { Vehicle } from '@warehouse/sim';
import type { Pose } from './motion.js';
import type { Painter } from './painter.js';
import { teamColor } from './scenery.js';

interface Part {
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

function vehicleParts(v: Vehicle, p: Pose, nowMs: number): Part[] {
  const ca = Math.cos(p.a);
  const sa = Math.sin(p.a);
  const team = teamColor(v);
  const parts: Part[] = [];
  const model = modelOf(v.type);
  const add = (ox: number, oy: number, len: number, wid: number, z0: number, h: number, hex: string) =>
    parts.push({ cx: p.x + ca * ox - sa * oy, cy: p.y + sa * ox + ca * oy, len, wid, z0, h, hex });
  const fork = Number.isFinite(v.fork) ? v.fork : 0;
  const forkZ = 2 + fork * (model === 'reach' ? 26 : 20);
  const cargo = v.cargo ?? [];
  const cargoAt = (ox: number, z: number) =>
    cargo.forEach((o, i) => {
      const zz = z + i * 13;
      add(ox, 0, 0.42, 0.4, zz, 3, '#C4A06B');
      add(ox, 0, 0.36, 0.34, zz + 3, 9, o.p0 ? '#F59E0B' : '#D9B98A');
    });
  if (model === 'agv') {
    add(0, 0, 0.9, 0.52, 1.5, 6, '#E2E8F0');
    add(0, 0, 0.84, 0.46, 7.5, 1.6, team);
    add(0.38, 0, 0.1, 0.3, 7.5, 5, '#334155'); // sensor bar
    cargoAt(-0.02, 9.2);
  } else {
    const reach = model === 'reach';
    const wid = reach ? 0.38 : 0.48;
    for (const sx of [-0.22, 0.24]) for (const sy of [-1, 1]) add(sx, sy * (wid / 2 + 0.02), 0.2, 0.1, 0, 5, '#1E293B');
    add(-0.04, 0, reach ? 0.62 : 0.74, wid, 3, 7, '#94A3B8');
    add(-0.36, 0, 0.26, wid, 3, reach ? 9 : 13, team); // counterweight carries the team colour
    if (!reach) {
      for (const sx of [-0.22, 0.08]) for (const sy of [-1, 1]) add(sx, sy * 0.19, 0.04, 0.04, 10, 14, '#334155');
      add(-0.07, 0, 0.4, 0.42, 24, 2, '#475569'); // overhead guard
    } else {
      add(-0.1, 0, 0.3, 0.3, 10, 6, '#64748B');
    }
    const mastH = reach ? 40 : 32;
    add(0.4, 0, 0.08, wid - 0.08, 0, mastH, '#334155');
    for (const sy of [-1, 1]) add(0.62, sy * 0.12, 0.42, 0.06, forkZ, 2, '#475569');
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

export interface VehicleDrawState {
  worldT: number;
  dim: boolean;
  emphasised: boolean;
  brainError: boolean;
  pulse: (periodMs: number, phase?: number) => number; // 0..1 (constant when reduced motion)
  nowMs: number;
}

export function drawVehicle(pt: Painter, v: Vehicle, p: Pose, s: VehicleDrawState): void {
  const ctx = pt.ctx;
  const team = teamColor(v);
  ctx.save();
  ctx.globalAlpha = s.dim ? 0.4 : 1;
  pt.poly(pt.circleGrid(p.x, p.y, 0.62), 'rgba(15,23,42,0.16)'); // contact shadow
  pt.poly(pt.circleGrid(p.x, p.y, 0.72), null, team, s.emphasised ? 3 : 1.5); // team ring
  const speed = v.speedNow ?? 0;
  const stunned = s.worldT < (v.stunnedUntil ?? 0);
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
  if (v.state === 'charging' || v.humanCharging) {
    const k = s.pulse(1257) * 2 - 1; // sin(now/200)
    pt.poly(pt.circleGrid(p.x, p.y, 0.8 + 0.08 * k), 'rgba(34,197,94,0.22)', '#16A34A', 2);
  }
  for (const q of vehicleParts(v, p, s.nowMs)) pt.oBox(q.cx, q.cy, q.len, q.wid, p.a, q.z0, q.h, q.hex, 'rgba(15,23,42,0.28)');
  if (stunned) {
    ctx.setLineDash([5, 4]);
    pt.poly(pt.circleGrid(p.x, p.y, 0.85), null, '#DC2626', 2.5);
    ctx.setLineDash([]);
  }
  if (s.brainError) pt.poly(pt.circleGrid(p.x, p.y, 0.95), null, '#E11D48', 2.5);
  ctx.restore();
}
