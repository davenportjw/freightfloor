import { describe, expect, it } from 'vitest';
import { buildMap } from '@warehouse/sim';
import {
  anchorOn,
  centreOn,
  fitCamera,
  HEADING_UP_ANCHOR_Y,
  headingUpRotation,
  project,
  unproject,
  zoomAt,
  ZOOM_MAX,
  ZOOM_MIN,
  type Camera,
} from '../src/render/iso.js';
import { INTERP_DELAY_MS, interpAlpha, lerpPose, pickNearest, PoseTracker, wrapAngle } from '../src/render/motion.js';
import {
  CHARGE_CUE_PERIOD_MS,
  CHARGE_RATE_PER_MIN,
  computeChargeVisualCue,
  isVehicleCharging,
} from '../src/render/vehicles.js';

describe('render/iso', () => {
  it('project/unproject round-trips on the floor plane', () => {
    const cam: Camera = { x: 412.5, y: -37.25, zoom: 0.73 };
    for (const [gx, gy] of [
      [0, 0],
      [12.25, 3.5],
      [59, 42],
      [30.7, 80.1],
    ]) {
      const [sx, sy] = project(cam, gx, gy);
      const g = unproject(cam, sx, sy);
      expect(g.x).toBeCloseTo(gx, 9);
      expect(g.y).toBeCloseTo(gy, 9);
    }
  });

  it('raising z moves a point straight up the screen', () => {
    const cam: Camera = { x: 0, y: 0, zoom: 2 };
    const [ax, ay] = project(cam, 5, 5);
    const [bx, by] = project(cam, 5, 5, 10);
    expect(bx).toBe(ax);
    expect(ay - by).toBe(20);
  });

  it('fitCamera keeps every map corner inside the viewport (base and max tier)', () => {
    for (const tier of [0, 6]) {
      const m = buildMap(tier);
      for (const [vw, vh] of [
        [1440, 900],
        [1920, 1080],
        [1024, 768],
      ]) {
        const cam = fitCamera(m.w, m.h, vw, vh);
        expect(cam.zoom).toBeGreaterThanOrEqual(ZOOM_MIN);
        for (const [gx, gy] of [
          [0, 0],
          [m.w, 0],
          [0, m.h],
          [m.w, m.h],
        ]) {
          const [sx, sy] = project(cam, gx, gy);
          expect(sx).toBeGreaterThanOrEqual(0);
          expect(sx).toBeLessThanOrEqual(vw);
          expect(sy).toBeGreaterThanOrEqual(0);
          expect(sy).toBeLessThanOrEqual(vh);
        }
      }
    }
  });

  it('zoomAt keeps the world point under the cursor fixed and clamps zoom', () => {
    const cam: Camera = { x: 300, y: 120, zoom: 0.8 };
    const mx = 640;
    const my = 410;
    const before = unproject(cam, mx, my);
    const z1 = zoomAt(cam, mx, my, 1.7);
    const after = unproject(z1, mx, my);
    expect(z1.zoom).toBeCloseTo(1.36, 9);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(zoomAt(cam, mx, my, 100).zoom).toBe(ZOOM_MAX);
    expect(zoomAt(cam, mx, my, 0.001).zoom).toBe(ZOOM_MIN);
  });
});

describe('render/motion', () => {
  it('wrapAngle maps differences into [-PI, PI]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(-1.5 * Math.PI)).toBeCloseTo(0.5 * Math.PI, 9);
    expect(wrapAngle(0.3)).toBeCloseTo(0.3, 9);
  });

  it('lerpPose interpolates position and takes the short way round for the angle', () => {
    const a = { x: 0, y: 10, a: Math.PI - 0.1 };
    const b = { x: 4, y: 6, a: -Math.PI + 0.1 };
    const mid = lerpPose(a, b, 0.5);
    expect(mid.x).toBeCloseTo(2, 9);
    expect(mid.y).toBeCloseTo(8, 9);
    expect(Math.abs(wrapAngle(mid.a - Math.PI))).toBeCloseTo(0, 9);
    expect(lerpPose(a, b, 2)).toEqual(lerpPose(a, b, 1));
  });

  it('interpAlpha is elapsed/interval clamped to [0,1]', () => {
    expect(interpAlpha(1050, 1000, 100)).toBeCloseTo(0.5, 9);
    expect(interpAlpha(900, 1000, 100)).toBe(0);
    expect(interpAlpha(5000, 1000, 100)).toBe(1);
    expect(interpAlpha(1000, 1000, 0)).toBe(1);
  });

  it('PoseTracker holds the newest pose when data stops and drops removed vehicles', () => {
    const tr = new PoseTracker();
    const v = { id: 'FL-01', px: 0, py: 0, angle: 0 };
    tr.update(1, 0, [v]);
    expect(tr.pose('FL-01', 0)).toEqual({ x: 0, y: 0, a: 0 });
    v.px = 1;
    tr.update(1.1, 100, [v]);
    const later = tr.pose('FL-01', 100 + INTERP_DELAY_MS)!;
    expect(later.x).toBeGreaterThan(0);
    expect(later.x).toBeLessThanOrEqual(1);
    expect(tr.pose('FL-01', 10_000)!.x).toBe(1); // no extrapolation past the newest sample
    tr.update(1.2, 200, []);
    expect(tr.pose('FL-01', 200)).toBeNull();
  });

  it('PoseTracker renders on the server-time timeline: packet arrival jitter never makes a vehicle surge or stall', () => {
    const tr = new PoseTracker();
    const v = { id: 'FL-02', px: 10, py: 5, angle: 0 };
    // Live-like arrival jitter (ms) per 100 ms server tick, and stepAI's alternating
    // 0.75 / 0.25 tile-centre cadence (0.5 tiles per tick on average).
    const jitter = [0, 60, 5, 95, 10, 0, 80, 20, 45, 0, 70, 15, 90, 5, 30, 0, 85, 10, 50, 0];
    const arrivals: Array<{ at: number; t: number; x: number }> = [];
    let x = 10;
    for (let k = 0; k < 60; k++) {
      arrivals.push({ at: k * 100 + jitter[k % jitter.length]!, t: 1 + k * 0.1, x });
      x += k % 2 === 0 ? 0.75 : 0.25;
    }
    arrivals.sort((p, q) => p.at - q.at);
    const steps: number[] = [];
    let i = 0;
    let prev: number | null = null;
    for (let now = 0; now < 5800; now += 1000 / 60) {
      while (i < arrivals.length && arrivals[i]!.at <= now) {
        v.px = arrivals[i]!.x;
        tr.update(arrivals[i]!.t, arrivals[i]!.at, [v]);
        i++;
      }
      tr.update(arrivals[Math.max(0, i - 1)]!.t, now, [v]);
      const p = tr.pose('FL-02', now)!;
      if (prev !== null && now > 1000) steps.push(p.x - prev);
      prev = p.x;
    }
    const perFrame = 0.5 / 6; // 0.5 tiles per 100 ms at 60 Hz
    for (const s of steps) expect(Math.abs(s - perFrame)).toBeLessThan(perFrame * 0.15);
  });

  it('pickNearest returns the closest pose within the radius, else null', () => {
    const poses = new Map([
      ['A', { x: 10, y: 10 }],
      ['B', { x: 10.6, y: 10 }],
      ['C', { x: 30, y: 30 }],
    ]);
    expect(pickNearest(poses, 10.5, 10)).toBe('B');
    expect(pickNearest(poses, 9.8, 10.1)).toBe('A');
    expect(pickNearest(poses, 20, 20)).toBeNull();
    expect(pickNearest(poses, 31.2, 30)).toBeNull(); // 1.2 tiles > 1.1 default radius
  });
});

describe('render/vehicles charging visual cue', () => {
  it('detects charging for both AI (state=charging) and human-driven (humanCharging=true) vehicles', () => {
    expect(isVehicleCharging({ state: 'idle', battery: 50 })).toBe(false);
    expect(isVehicleCharging({ state: 'driven', humanCharging: false, battery: 50 })).toBe(false);
    expect(isVehicleCharging({ state: 'charging', battery: 40 })).toBe(true);
    expect(isVehicleCharging({ state: 'driven', humanCharging: true, battery: 40 })).toBe(true);
  });

  it('animates a rising ⚡ +5 cue and ascending isometric ring across CHARGE_CUE_PERIOD_MS', () => {
    const idleCue = computeChargeVisualCue({ state: 'moving', battery: 80 }, 300);
    expect(idleCue.active).toBe(false);
    expect(idleCue.label).toBe('');
    expect(idleCue.alpha).toBe(0);

    const startCue = computeChargeVisualCue({ state: 'charging', battery: 35 }, 0);
    const midCue = computeChargeVisualCue(
      { state: 'driven', humanCharging: true, battery: 35 },
      CHARGE_CUE_PERIOD_MS / 2,
    );
    const lateCue = computeChargeVisualCue(
      { state: 'charging', battery: 35 },
      CHARGE_CUE_PERIOD_MS * 0.85,
    );

    expect(startCue.active).toBe(true);
    expect(startCue.label).toBe(`⚡ +${CHARGE_RATE_PER_MIN}`);
    expect(midCue.zOffset).toBeGreaterThan(startCue.zOffset);
    expect(lateCue.zOffset).toBeGreaterThan(midCue.zOffset);
    expect(midCue.ringZ).toBeGreaterThan(startCue.ringZ);
    expect(lateCue.ringZ).toBeGreaterThan(midCue.ringZ);
    expect(midCue.alpha).toBeCloseTo(1, 5);
    expect(midCue.alpha).toBeGreaterThan(startCue.alpha);
    expect(midCue.alpha).toBeGreaterThan(lateCue.alpha);
  });

  it('locks the charging visual cue to a static offset when reducedMotion is enabled', () => {
    const a = computeChargeVisualCue({ state: 'charging', battery: 50 }, 100, true);
    const b = computeChargeVisualCue({ state: 'charging', battery: 50 }, 750, true);
    expect(a.active).toBe(true);
    expect(a.label).toBe('⚡ +5');
    expect(a).toEqual(b);
  });
});

describe('render/scenery & multi-site visual themes', () => {
  it('provides distinct visual palettes for den-1, slc-2, phx-3, and abq-4', async () => {
    const { getSiteVisuals } = await import('../src/render/scenery.js');
    const den = getSiteVisuals('den-1');
    const slc = getSiteVisuals('slc-2');
    const phx = getSiteVisuals('phx-3');
    const abq = getSiteVisuals('abq-4');

    expect(new Set([den.bg, slc.bg, phx.bg, abq.bg]).size).toBe(4);
    expect(new Set([den.hwyFill, slc.hwyFill, phx.hwyFill, abq.hwyFill]).size).toBe(4);
    expect(new Set([den.conveyorBed, slc.conveyorBed, phx.conveyorBed, abq.conveyorBed]).size).toBe(4);
    expect(getSiteVisuals('unknown-site')).toEqual(den);
  });

  it('draws distinct cargo item models, rack shelves, and vehicle-carried loads for each regional site', async () => {
    const { drawCargoItem, drawConveyorItem, drawRack } = await import('../src/render/scenery.js');
    const { vehicleParts } = await import('../src/render/vehicles.js');

    function recordCalls(fn: (pt: any) => void) {
      const boxColors: string[] = [];
      const pt = {
        cam: { zoom: 1 },
        aaBox: (_x: number, _y: number, _w: number, _h: number, _z0: number, _dz: number, col: string) => {
          boxColors.push(col);
        },
        cyl: (_x: number, _y: number, _r: number, _z0: number, _dz: number, col: string) => {
          boxColors.push(col);
        },
        P: (x: number, y: number, z = 0) => [x - y, x + y - z] as [number, number],
      };
      fn(pt);
      return boxColors;
    }

    const sampleOrder = {
      id: 101,
      p0: false,
      card: false,
      slot: { zone: 'A', rx: 10, ry: 5, ax: 9, ay: 5, kind: 'ambient' as const },
    };

    const denCargo = recordCalls((pt) => drawCargoItem(pt, 9, 5, 0, sampleOrder, 'den-1'));
    const slcCargo = recordCalls((pt) => drawCargoItem(pt, 9, 5, 0, sampleOrder, 'slc-2'));
    const phxCargo = recordCalls((pt) => drawCargoItem(pt, 9, 5, 0, sampleOrder, 'phx-3'));
    const abqCargo = recordCalls((pt) => drawCargoItem(pt, 9, 5, 0, sampleOrder, 'abq-4'));

    expect(denCargo.length).toBeGreaterThanOrEqual(2);
    expect(slcCargo.length).toBeGreaterThan(denCargo.length); // pot + foliage + blossom
    expect(phxCargo).not.toEqual(denCargo);
    expect(abqCargo).not.toEqual(denCargo);

    // Conveyor items also differ across sites
    const denConv = recordCalls((pt) => drawConveyorItem(pt, 25, 10, 8.5, 0, 'den-1'));
    const slcConv = recordCalls((pt) => drawConveyorItem(pt, 25, 10, 8.5, 0, 'slc-2'));
    const phxConv = recordCalls((pt) => drawConveyorItem(pt, 25, 10, 8.5, 0, 'phx-3'));
    const abqConv = recordCalls((pt) => drawConveyorItem(pt, 25, 10, 8.5, 0, 'abq-4'));
    expect(slcConv).not.toEqual(denConv);
    expect(phxConv).not.toEqual(denConv);
    expect(abqConv).not.toEqual(denConv);

    // Rack rendering differs across sites
    const rack = { x: 10, y: 5, zone: 'A', kind: 'ambient' as const };
    const denRack = recordCalls((pt) => drawRack(pt, rack, 'den-1'));
    const slcRack = recordCalls((pt) => drawRack(pt, rack, 'slc-2'));
    const phxRack = recordCalls((pt) => drawRack(pt, rack, 'phx-3'));
    const abqRack = recordCalls((pt) => drawRack(pt, rack, 'abq-4'));
    expect(slcRack).not.toEqual(denRack);
    expect(phxRack).not.toEqual(denRack);
    expect(abqRack).not.toEqual(denRack);

    // Vehicle carried cargo parts differ across sites when carrying an order
    const carriedVehicle: any = {
      id: 'FL-01',
      type: 'reach',
      strategy: 'Steady',
      human: false,
      fork: 0.6,
      cargo: [sampleOrder],
      orders: [sampleOrder],
    };
    const pose = { x: 10, y: 10, a: 0 };
    const denParts = vehicleParts(carriedVehicle, pose, 0, 'den-1').map((b) => b.hex);
    const slcParts = vehicleParts(carriedVehicle, pose, 0, 'slc-2').map((b) => b.hex);
    const phxParts = vehicleParts(carriedVehicle, pose, 0, 'phx-3').map((b) => b.hex);
    const abqParts = vehicleParts(carriedVehicle, pose, 0, 'abq-4').map((b) => b.hex);
    expect(slcParts).not.toEqual(denParts);
    expect(phxParts).not.toEqual(denParts);
    expect(abqParts).not.toEqual(denParts);
  });

  it('telescopes the forklift mast: short when lowered, extends with the forks', async () => {
    const { vehicleParts, MAST_COLLAPSED_COUNTERBALANCE } = await import('../src/render/vehicles.js');
    const pose = { x: 10, y: 10, a: 0 };
    const mastTop = (fork: number) => {
      const v: any = { id: 'FL-02', type: 'counterbalance', fork, cargo: [], orders: [] };
      const mast = vehicleParts(v, pose, 0, 'den-1').filter((q) => q.role === 'mast');
      return { n: mast.length, top: Math.max(...mast.map((q) => q.z0 + q.h)) };
    };
    const low = mastTop(0);
    expect(low.n).toBe(2); // one stage = twin rails
    expect(low.top).toBe(MAST_COLLAPSED_COUNTERBALANCE);
    const high = mastTop(1);
    expect(high.n).toBe(4); // outer + telescoped inner stage
    expect(high.top).toBeGreaterThan(MAST_COLLAPSED_COUNTERBALANCE);
    expect(mastTop(0.5).top).toBeLessThan(high.top);
  });

  it('gives every forklift model real round wheels, and tags every part with a role', async () => {
    const { vehicleParts, WHEEL_ISO_STRETCH } = await import('../src/render/vehicles.js');
    const { TILE_M, ISO_PX_PER_M } = await import('../src/render/liftGeometry.js');
    const pose = { x: 10, y: 10, a: 0.3 };
    for (const type of ['agv', 'counterbalance', 'reach']) {
      const v: any = { id: 'FL-W', type, fork: 0, cargo: [], orders: [] };
      const parts = vehicleParts(v, pose, 0, 'den-1');
      expect(parts.every((q) => typeof q.role === 'string')).toBe(true);
      const tyres = parts.filter((q) => q.role === 'wheel');
      expect(tyres.length).toBeGreaterThanOrEqual(2);
      for (const t of tyres) {
        expect(t.shape).toBe('wheel');
        expect(t.z0).toBe(0); // sits on the floor
        // 3D axle at the true radius; iso height is the stretched true diameter.
        expect(t.axleM).toBeCloseTo((t.len * TILE_M) / 2, 9);
        expect(t.h).toBeCloseTo(t.len * TILE_M * ISO_PX_PER_M * WHEEL_ISO_STRETCH, 9);
      }
      expect(parts.filter((q) => q.role === 'hub')).toHaveLength(tyres.length);
    }
  });

  it('steers the rear wheels of a counterbalance and spins rim markers with distance travelled', async () => {
    const { vehicleParts } = await import('../src/render/vehicles.js');
    const pose = { x: 10, y: 10, a: 0 };
    const v: any = { id: 'FL-S', type: 'counterbalance', fork: 0, cargo: [], orders: [] };
    const still = vehicleParts(v, pose, 0, 'den-1');
    expect(still.some((q) => q.role === 'lug')).toBe(false);
    const turning = vehicleParts(v, pose, 0, 'den-1', true, 0, { motion: { travel: 0.4, steer: 0.5 }, lugs: true });
    const tyres = turning.filter((q) => q.role === 'wheel');
    const rear = tyres.filter((q) => q.cx < pose.x);
    const front = tyres.filter((q) => q.cx > pose.x);
    expect(rear.every((q) => q.yaw === -0.5)).toBe(true); // rear-wheel steering turns opposite
    expect(front.every((q) => (q.yaw ?? 0) === 0)).toBe(true);
    const lugA = turning.filter((q) => q.role === 'lug').map((q) => q.z0);
    const lugB = vehicleParts(v, pose, 0, 'den-1', true, 0, { motion: { travel: 0.5, steer: 0.5 }, lugs: true })
      .filter((q) => q.role === 'lug')
      .map((q) => q.z0);
    expect(lugA).toHaveLength(tyres.length);
    expect(lugB).not.toEqual(lugA);
  });

  it('WheelOdometer accumulates signed travel and estimates steer from yaw rate', async () => {
    const { WheelOdometer, MAX_STEER } = await import('../src/render/wheels.js');
    const odo = new WheelOdometer();
    odo.update('v', { x: 0, y: 0, a: 0 }, 0);
    const fwd = odo.update('v', { x: 0.5, y: 0, a: 0 }, 100);
    expect(fwd.travel).toBeCloseTo(0.5, 9);
    expect(fwd.steer).toBeCloseTo(0, 9);
    const back = odo.update('v', { x: 0.3, y: 0, a: 0 }, 200);
    expect(back.travel).toBeCloseTo(0.3, 9); // reversing rolls the wheels backwards
    let m = back;
    for (let i = 1; i <= 20; i++) m = odo.update('v', { x: 0.3 + i * 0.05, y: 0, a: i * 0.05 }, 200 + i * 50);
    expect(m.steer).toBeGreaterThan(0);
    expect(m.steer).toBeLessThanOrEqual(MAX_STEER);
    const jump = odo.update('v', { x: 50, y: 50, a: 1 }, 2000);
    expect(jump.travel).toBeCloseTo(m.travel, 9); // teleports don't spin the wheels
  });

  it('Painter.wheel draws tread + sidewall, and drawVehicle grounds models with a footprint shadow', async () => {
    const { Painter, convexHull } = await import('../src/render/painter.js');
    const { drawVehicle } = await import('../src/render/vehicles.js');
    expect(convexHull([[0, 0], [2, 0], [1, 1], [2, 2], [0, 2]])).toHaveLength(4);
    let fills = 0;
    const ctx: any = {
      save() {},
      restore() {},
      setLineDash() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      stroke() {},
      fill() {
        fills++;
      },
      ellipse() {},
      createLinearGradient: () => ({ addColorStop() {} }),
      globalAlpha: 1,
    };
    const pt = new Painter(ctx, { x: 0, y: 0, zoom: 1 });
    pt.wheel(5, 5, 0.36, 0.11, 0.4, 0, 5, '#111827');
    expect(fills).toBe(2);
    const wheelCalls: number[] = [];
    const shadowCalls: number[] = [];
    const spy = Object.assign(Object.create(pt), {
      wheel: (...args: number[]) => wheelCalls.push(args[2]),
      footprintShadow: (...args: number[]) => shadowCalls.push(args[2]),
    });
    const v: any = { id: 'FL-D', type: 'counterbalance', fork: 0, cargo: [], orders: [], speedNow: 0 };
    drawVehicle(spy, v, { x: 10, y: 10, a: 0 }, { worldT: 0, dim: false, emphasised: false, brainError: false, pulse: () => 0, nowMs: 0 });
    expect(wheelCalls.length).toBe(8); // 4 tyres + 4 rims
    expect(shadowCalls).toHaveLength(1);
  });

  it('uses one cargo model for floor pallets and pallets carried on the forks', async () => {
    const { cargoPrims, drawCargoItem } = await import('../src/render/scenery.js');
    const { vehicleParts } = await import('../src/render/vehicles.js');
    const o = { id: 7, p0: false, isTransfer: false };
    for (const site of ['den-1', 'slc-2', 'phx-3', 'abq-4']) {
      const { prims, height } = cargoPrims(o, site);
      expect(prims.length).toBeGreaterThanOrEqual(5); // pallet base (3 runners + deck) + load
      expect(height).toBeGreaterThan(10);
      // Floor pallet: every primitive drawn, in model order.
      const floor: string[] = [];
      const pt: any = {
        aaBox: (_x: number, _y: number, _w: number, _d: number, _z: number, _h: number, hex: string) => floor.push(hex),
        cyl: (_x: number, _y: number, _r: number, _z: number, _h: number, hex: string) => floor.push(hex),
      };
      drawCargoItem(pt, 5, 5, 0, o, site);
      expect(floor).toEqual(prims.map((q) => q.hex));
      // Carried: the same primitives (cylinders stay cylinders), tagged as cargo.
      const v: any = { id: 'FL-C', type: 'counterbalance', fork: 0.1, cargo: [o], orders: [] };
      const carried = vehicleParts(v, { x: 10, y: 10, a: 0.4 }, 0, site).filter((q) => q.role === 'cargo');
      expect(carried).toHaveLength(prims.length);
      expect(carried.filter((q) => q.shape === 'cyl')).toHaveLength(prims.filter((q) => q.kind === 'cyl').length);
    }
  });

  it('splits wider strap bands so the iso painter never paints a band over the carton above it', async () => {
    const { cargoPrims } = await import('../src/render/scenery.js');
    const { prims } = cargoPrims({ id: 0, p0: false, isTransfer: false }, 'den-1');
    // Walk the stack bottom-to-top: no primitive may start below the top of an earlier, wider one
    // that it overlaps in plan (that ordering is what flattened the carton before).
    for (let i = 0; i < prims.length; i++) {
      for (let j = i + 1; j < prims.length; j++) {
        const a = prims[i];
        const b = prims[j];
        const overlapsPlan = Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.d + b.d) / 2;
        const aWider = a.w > b.w + 1e-9 || a.d > b.d + 1e-9;
        if (overlapsPlan && aWider && b.z0 < a.z0 + a.h - 1e-9) expect(b.z0 + b.h).toBeLessThanOrEqual(a.z0 + 1e-9);
      }
    }
  });

  it('chargers and cones are shared procedural props (iso + cab)', async () => {
    const { drawCharger, drawCone } = await import('../src/render/scenery.js');
    const boxes: string[] = [];
    const pt: any = {
      aaBox: (...a: any[]) => boxes.push(a[6]),
      cyl: (...a: any[]) => boxes.push(a[5]),
    };
    drawCharger(pt, 3, 3, false);
    const idle = boxes.splice(0);
    drawCharger(pt, 3, 3, true);
    expect(boxes.length).toBe(idle.length);
    expect(boxes).not.toEqual(idle); // busy lights up
    boxes.length = 0;
    drawCone(pt, 3, 3);
    expect(boxes).toContain('#EA580C');
  });

  it('headingUpRotation keeps the forklift driving straight up on screen while rotating the board', async () => {
    const { screenVectorToWorldAngle } = await import('../src/input.js');
    const { ClientStore } = await import('../src/state.js');

    for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.73, -2.15]) {
      const rot = headingUpRotation(heading);
      const cam: Camera = { x: 0, y: 0, zoom: 1.2, rot };
      const px = 14.5;
      const py = 22.25;
      const c = centreOn(cam, px, py, 1280, 720);
      cam.x = c.x;
      cam.y = c.y;

      const [cx, cy] = project(cam, px, py);
      expect(cx).toBeCloseTo(640, 6);
      expect(cy).toBeCloseTo(360, 6);

      // A point 1 tile ahead of the forklift projects straight UP on screen (same X, smaller Y)
      const [fx, fy] = project(cam, px + Math.cos(heading), py + Math.sin(heading));
      expect(fx).toBeCloseTo(cx, 6);
      expect(fy).toBeLessThan(cy - 15);

      // A point 1 tile to the right of the forklift (heading + pi/2) projects straight RIGHT on screen (larger X, same Y)
      const [rx, ry] = project(
        cam,
        px + Math.cos(heading + Math.PI / 2),
        py + Math.sin(heading + Math.PI / 2),
      );
      expect(rx).toBeGreaterThan(cx + 30);
      expect(ry).toBeCloseTo(cy, 6);

      // project / unproject round-trips under arbitrary board rotation
      for (const [gx, gy] of [
        [0, 0],
        [px, py],
        [31.4, 18.9],
      ]) {
        const [sx, sy] = project(cam, gx, gy);
        const u = unproject(cam, sx, sy);
        expect(u.x).toBeCloseTo(gx, 6);
        expect(u.y).toBeCloseTo(gy, 6);
      }

      // Pushing the thumbstick straight up (dx=0, dy=-30) in headingUp mode maps to the vehicle's forward heading
      const stickUpAngle = screenVectorToWorldAngle(0, -30, rot);
      expect(Math.abs(wrapAngle(stickUpAngle - heading))).toBeLessThan(0.005);
    }

    const store = new ClientStore();
    expect(store.driveCameraMode()).toBe('fixed');
    expect(store.toggleDriveCameraMode()).toBe('headingUp');
    expect(store.driveCameraMode()).toBe('headingUp');
    store.setDriveCameraMode('fixed');
    expect(store.driveCameraMode()).toBe('fixed');
  });

  it('anchorOn places the heading-up forklift in the lower quarter of the screen', () => {
    expect(HEADING_UP_ANCHOR_Y).toBeGreaterThan(0.75);
    expect(HEADING_UP_ANCHOR_Y).toBeLessThan(1);
    const cam: Camera = { x: 0, y: 0, zoom: 1.4, rot: headingUpRotation(0.9) };
    const t = anchorOn(cam, 12.5, 7.25, 640, 720 * HEADING_UP_ANCHOR_Y);
    const [sx, sy] = project({ ...cam, ...t }, 12.5, 7.25);
    expect(sx).toBeCloseTo(640, 6);
    expect(sy).toBeCloseTo(720 * HEADING_UP_ANCHOR_Y, 6);
    // centreOn is anchorOn at the viewport centre.
    expect(centreOn(cam, 12.5, 7.25, 1280, 720)).toEqual(anchorOn(cam, 12.5, 7.25, 640, 360));
  });
});



