import { describe, expect, it } from 'vitest';
import { buildMap } from '@warehouse/sim';
import { fitCamera, project, unproject, zoomAt, ZOOM_MAX, ZOOM_MIN, type Camera } from '../src/render/iso.js';
import { interpAlpha, lerpPose, pickNearest, PoseTracker, wrapAngle } from '../src/render/motion.js';

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

  it('PoseTracker slides between the last two world.t values and drops removed vehicles', () => {
    const tr = new PoseTracker();
    const v = { id: 'FL-01', px: 0, py: 0, angle: 0 };
    tr.update(1, 0, [v]);
    expect(tr.pose('FL-01', 0)).toEqual({ x: 0, y: 0, a: 0 });
    v.px = 1;
    tr.update(1.1, 100, [v]); // new server tick at t=100ms
    const halfway = tr.pose('FL-01', 150)!;
    expect(halfway.x).toBeGreaterThan(0);
    expect(halfway.x).toBeLessThan(1);
    expect(tr.pose('FL-01', 10_000)!.x).toBe(1);
    tr.update(1.2, 200, []);
    expect(tr.pose('FL-01', 200)).toBeNull();
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
