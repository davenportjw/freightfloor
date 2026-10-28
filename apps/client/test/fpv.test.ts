import { describe, expect, it } from 'vitest';
import {
  createWorld,
  evaluateRackLift,
  postOrder,
  RACK_LEVEL_FORK_TARGETS,
  rackLiftWindows,
  type DistrictKind,
} from '@warehouse/sim';
import {
  beamTopM,
  forkHeightM,
  isoZ,
  liftWindowM,
  pocketCenterM,
  POCKET_OFFSET_M,
  rackHeightM,
  FORK_TRAVEL_M,
} from '../src/render/liftGeometry.js';
import {
  cabEye,
  cabTouchDirs,
  cabYaw,
  damp,
  headTiltTarget,
  liftGradeAt,
  MAX_PITCH,
  rackFace,
  REST_PITCH,
} from '../src/fpv/cabMath.js';
import { PrimRecorder, parseColor } from '../src/fpv/boxSink.js';
import { resolveLiftTarget } from '../src/fpv/liftTarget.js';
import { RackLiftController } from '../src/ui/rackLiftMinigame.js';
import { drawRack } from '../src/render/scenery.js';

const LEVELS = [0, 1, 2] as const;
const DISTRICTS: Array<DistrictKind | undefined> = [undefined, 'ambient', 'fast', 'haz', 'cold', 'bulk'];
const MULS = [0.5, 0.8, 1, 1.25, 2];

describe('liftGeometry: one height contract for iso + cab', () => {
  it('a Perfect-target fork lands exactly in the pallet pocket at every level', () => {
    for (const l of LEVELS) {
      expect(forkHeightM(RACK_LEVEL_FORK_TARGETS[l])).toBeCloseTo(pocketCenterM(l), 9);
      expect(pocketCenterM(l) - beamTopM(l)).toBeCloseTo(POCKET_OFFSET_M, 9);
    }
  });

  it('beams rise monotonically and the top level fits under the rack cap', () => {
    expect(beamTopM(0)).toBeLessThan(beamTopM(1));
    expect(beamTopM(1)).toBeLessThan(beamTopM(2));
    expect(rackHeightM(3)).toBeGreaterThan(beamTopM(2) + 1);
    expect(rackHeightM(2)).toBeGreaterThan(beamTopM(1) + 1);
    // Keeps the classic iso silhouette (~36 px for 3-level racks).
    expect(isoZ(rackHeightM(3))).toBeGreaterThan(30);
    expect(isoZ(rackHeightM(3))).toBeLessThan(40);
  });

  it('forks at full travel physically reach above the L3 pocket', () => {
    expect(forkHeightM(1)).toBeGreaterThan(pocketCenterM(2));
    expect(forkHeightM(0)).toBeLessThan(pocketCenterM(0));
  });

  it('liftWindowM is the server window scaled by fork travel', () => {
    for (const l of LEVELS) {
      for (const district of DISTRICTS) {
        for (const forkLiftMul of MULS) {
          const n = rackLiftWindows(l, { district, forkLiftMul });
          const m = liftWindowM(l, { district, forkLiftMul });
          expect(m.perfectM).toBeCloseTo(n.perfectWindow * FORK_TRAVEL_M, 9);
          expect(m.cleanM).toBeCloseTo(n.cleanWindow * FORK_TRAVEL_M, 9);
          expect(m.centerM).toBeCloseTo(pocketCenterM(l), 9);
        }
      }
    }
  });
});

describe('rackLiftWindows == evaluateRackLift grading (B1: gauge must not lie)', () => {
  it('client grade from windows matches the server for every district / card multiplier', () => {
    for (const l of LEVELS) {
      for (const district of DISTRICTS) {
        for (const forkLiftMul of MULS) {
          const win = rackLiftWindows(l, { district, forkLiftMul });
          for (let f = 0; f <= 1.0001; f += 0.01) {
            const server = evaluateRackLift(f, l, { district, forkLiftMul });
            expect(liftGradeAt(server.forkHeight, win)).toBe(server.grade);
            expect(server.perfectWindow).toBeCloseTo(win.perfectWindow, 12);
            expect(server.cleanWindow).toBeCloseTo(win.cleanWindow, 12);
          }
        }
      }
    }
  });
});

describe('cabMath', () => {
  it('cab yaw looks along the sim heading', () => {
    for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7]) {
      const yaw = cabYaw(a);
      // three.js camera forward for rotation.y = yaw (order YXZ, pitch 0): (-sin yaw, 0, -cos yaw)
      expect(-Math.sin(yaw)).toBeCloseTo(Math.cos(a), 9);
      expect(-Math.cos(yaw)).toBeCloseTo(Math.sin(a), 9);
    }
  });

  it('eye sits behind the vehicle centre along the heading', () => {
    const e = cabEye({ x: 10, y: 5, a: 0 });
    expect(e.x).toBeLessThan(10 * 1.5);
    expect(e.z).toBeCloseTo(5 * 1.5, 9);
  });

  it('head tilts up toward the forks while lifting and rests otherwise', () => {
    expect(headTiltTarget({ lifting: false, fork: 0.9 })).toBe(REST_PITCH);
    const high = headTiltTarget({ lifting: true, fork: 0.92, pocketM: pocketCenterM(2) });
    const low = headTiltTarget({ lifting: true, fork: 0.1, pocketM: pocketCenterM(0) });
    expect(high).toBeGreaterThan(0);
    expect(high).toBeLessThanOrEqual(MAX_PITCH);
    expect(low).toBeLessThan(high);
    expect(headTiltTarget({ lifting: true, fork: 0.92, reducedMotion: true })).toBe(REST_PITCH);
  });

  it('damp converges and is frame-rate independent', () => {
    let a = 0;
    for (let i = 0; i < 60; i++) a = damp(a, 1, 16.67);
    let b = 0;
    for (let i = 0; i < 30; i++) b = damp(b, 1, 33.34);
    expect(a).toBeGreaterThan(0.99);
    expect(Math.abs(a - b)).toBeLessThan(1e-3);
  });

  it('touch stick in the cab becomes throttle + steer (no absolute moveAngle)', () => {
    expect(cabTouchDirs({ up: true, left: true, moveAngle: 1.2 })).toEqual({
      up: true,
      down: false,
      left: true,
      right: false,
      moveAngle: null,
    });
  });

  it('rackFace sits on the shared edge with a normal into the aisle', () => {
    const f = rackFace({ rx: 4, ry: 7, ax: 5, ay: 7 });
    expect(f).toEqual({ gx: 5, gy: 7.5, nx: 1, ny: 0 });
  });
});

describe('PrimRecorder (iso builders → 3D primitives)', () => {
  it('parses hex / rgba colours', () => {
    expect(parseColor('#ff0000')).toEqual([1, 0, 0, 1]);
    expect(parseColor('#0f0')).toEqual([0, 1, 0, 1]);
    const [r, g, b, a] = parseColor('rgba(34,197,94,0.45)');
    expect([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), a]).toEqual([34, 197, 94, 0.45]);
  });

  it('records the detailed rack model from drawRack with shelf beams at the liftGeometry heights', () => {
    const rec = new PrimRecorder();
    drawRack(rec.asPainter(), { id: 'R1', zone: 'A', kind: 'ambient', x: 3, y: 4, tone: 0 }, 'den-1');
    expect(rec.prims.length).toBeGreaterThan(5);
    for (const p of rec.prims) {
      expect(p.cx).toBeGreaterThanOrEqual(3);
      expect(p.cx).toBeLessThanOrEqual(4);
    }
    // Every shelf level top equals the beam top used to grade / place pallets.
    for (const l of LEVELS) {
      const top = isoZ(beamTopM(l));
      expect(rec.prims.some((p) => Math.abs(p.z0 + p.h - top) < 1e-6)).toBe(true);
    }
  });
});

describe('resolveLiftTarget', () => {
  it('prefers the active controller slot, else the guided rack order', () => {
    const world = createWorld({ seed: 42 });
    const v = world.vehicles[0]!;
    v.cargo = [];
    const order = postOrder(world)!;
    order.slot = { ...order.slot, level: 1 };
    const g = { kind: 'pick', x: order.slot.ax, y: order.slot.ay, inRange: true, order: { id: order.id } };
    const t = resolveLiftTarget(world, v, g, null);
    if (order.slot.rx !== order.slot.ax || order.slot.ry !== order.slot.ay) {
      expect(t?.level).toBe(1);
      expect(t?.active).toBe(false);
    }
    const ctrl = new RackLiftController();
    ctrl.active = true;
    ctrl.slot = { ...order.slot, level: 2 };
    ctrl.targetLevel = 2;
    expect(resolveLiftTarget(world, v, g, ctrl)?.active).toBe(true);
    expect(resolveLiftTarget(world, v, g, ctrl)?.level).toBe(2);
  });
});

describe('RackLiftController fixes', () => {
  function liftSetup(level: 0 | 1 | 2) {
    const world = createWorld({ seed: 42 });
    const v = world.vehicles[0]!;
    v.cargo = [];
    const order = postOrder(world)!;
    order.slot = { ...order.slot, id: 'R1-1', zone: 'A', level } as typeof order.slot;
    v.px = order.slot.ax + 0.5;
    v.py = order.slot.ay + 0.5;
    return { world, v };
  }

  it('step() always takes milliseconds (a 1 ms frame is not a 1 s jump)', () => {
    const { world, v } = liftSetup(2);
    const ctrl = new RackLiftController();
    expect(ctrl.onKeyDown(0, world, v, true).action).toBe('lifting');
    ctrl.step(1, world, v, true);
    expect(v.fork).toBeCloseTo(0.08 + 1.12 * 0.001, 6);
  });

  it('step() no longer touches vehicle speed (the dead damping code is gone)', () => {
    const { world, v } = liftSetup(2);
    v.speedNow = 3;
    const ctrl = new RackLiftController();
    ctrl.onKeyDown(0, world, v, true);
    ctrl.step(100, world, v, true);
    expect(v.speedNow).toBe(3);
  });

  it('practice mode flashes say PRACTICE and never promise money', () => {
    const { world, v } = liftSetup(2);
    const ctrl = new RackLiftController();
    ctrl.practice = true;
    ctrl.onKeyDown(1000, world, v, true);
    ctrl.step(750, world, v, true);
    const res = ctrl.onKeyUp(1750, v, world);
    expect(res.action).toBe('commit');
    const flash = ctrl.lastFlash(1800)!;
    expect(flash.label.startsWith('PRACTICE')).toBe(true);
    expect(flash.sublabel).not.toMatch(/\$/);
  });

  it('windows() mirrors the server for the active district / card multiplier', () => {
    const ctrl = new RackLiftController();
    ctrl.targetLevel = 1;
    ctrl.district = 'haz';
    ctrl.forkLiftMul = 1.25;
    expect(ctrl.windows()).toEqual(rackLiftWindows(1, { district: 'haz', forkLiftMul: 1.25 }));
  });
});
