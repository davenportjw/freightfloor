import { describe, expect, it } from 'vitest';
import { buildMap } from '@warehouse/sim';
import {
  centreOn,
  fitCamera,
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
    expect(low.n).toBe(1);
    expect(low.top).toBe(MAST_COLLAPSED_COUNTERBALANCE);
    const high = mastTop(1);
    expect(high.n).toBe(2);
    expect(high.top).toBeGreaterThan(MAST_COLLAPSED_COUNTERBALANCE);
    expect(mastTop(0.5).top).toBeLessThan(high.top);
  });

  it('resolves regional cargo and conveyor sprite keys and blits via Painter.sprite when atlas is loaded', async () => {
    const {
      drawCargoItem,
      drawConveyorItem,
      resolveCargoSpriteKey,
      resolveConveyorSpriteKey,
    } = await import('../src/render/scenery.js');
    const { Painter } = await import('../src/render/painter.js');

    expect(resolveCargoSpriteKey({ id: 3, p0: false, card: false } as any, 'den-1')).toBe('cargo_boxes_0');
    expect(resolveCargoSpriteKey({ id: 4, p0: false, card: true } as any, 'slc-2')).toBe('cargo_plants_1');
    expect(resolveCargoSpriteKey({ id: 5, p0: true, card: false } as any, 'phx-3')).toBe('cargo_tech_p0');
    expect(resolveCargoSpriteKey({ id: 6, p0: false, card: false, isTransfer: true } as any, 'abq-4')).toBe(
      'cargo_artisan_net',
    );

    expect(resolveConveyorSpriteKey(0, 'den-1')).toBe('conv_boxes_0');
    expect(resolveConveyorSpriteKey(3, 'slc-2')).toBe('conv_plants_1');
    expect(resolveConveyorSpriteKey(2, 'phx-3')).toBe('conv_tech_0');
    expect(resolveConveyorSpriteKey(1, 'abq-4')).toBe('conv_artisan_1');

    const drawnImages: Array<{ sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number }> = [];
    const mockCtx: any = {
      drawImage: (_img: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) => {
        drawnImages.push({ sx, sy, sw, sh, dx, dy, dw, dh });
      },
    };
    const cam: Camera = { x: 500, y: 300, zoom: 1.25 };
    const painter = new Painter(mockCtx, cam);

    // Without atlas loaded, sprite() returns false so procedural 3D primitives run
    expect(painter.hasSprite('cargo_boxes_0')).toBe(false);
    expect(painter.sprite('cargo_boxes_0', 10, 5, 0)).toBe(false);

    // Attach atlas frames and dummy image source
    painter.setAtlas({} as any, {
      cargo_boxes_0: { frame: { x: 96, y: 192, w: 96, h: 96 }, anchor: { x: 0.5, y: 0.62 } },
      conv_plants_1: { frame: { x: 192, y: 288, w: 96, h: 96 }, anchor: { x: 0.5, y: 0.62 } },
    });

    expect(painter.hasSprite('cargo_boxes_0')).toBe(true);
    drawCargoItem(painter, 9, 5, 0, { id: 3, p0: false, card: false } as any, 'den-1');
    drawConveyorItem(painter, 12, 8, 8.5, 3, 'slc-2');

    expect(drawnImages.length).toBe(2);
    expect(drawnImages[0]!.sx).toBe(96);
    expect(drawnImages[0]!.sy).toBe(192);
    expect(drawnImages[0]!.dw).toBeCloseTo(96 * 1.25, 5);
    expect(drawnImages[1]!.sx).toBe(192);
    expect(drawnImages[1]!.sy).toBe(288);
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
});



