import { describe, expect, it } from 'vitest';
import { StackWhip, TUMBLE_MS, BOUNCE_MS, TrialFx, leanTarget, swayWarn, tumblePose, type Tumble } from '../src/trials/fx.js';
import { leanAt, mixHex, vehicleParts } from '../src/render/vehicles.js';
import type { Vehicle } from '@warehouse/sim';

describe('StackWhip (per-tier stack lean)', () => {
  it('settles on the static lean targets, top tier leaning most', () => {
    const w = new StackWhip();
    for (let i = 0; i < 200; i++) w.step(0.8, 3, 16);
    const t = w.tiers;
    expect(t).toHaveLength(4);
    expect(t[0]).toBe(0);
    for (let k = 1; k <= 3; k++) expect(t[k]).toBeCloseTo(leanTarget(0.8, k), 3);
    expect(t[3]).toBeGreaterThan(t[2]);
    expect(t[2]).toBeGreaterThan(t[1]);
  });

  it('whips: the top overshoots past its target after the sway snaps back', () => {
    const w = new StackWhip();
    for (let i = 0; i < 200; i++) w.step(1, 3, 16);
    let minTop = Infinity;
    for (let i = 0; i < 60; i++) minTop = Math.min(minTop, w.step(0, 3, 16)[3]);
    expect(minTop).toBeLessThan(-0.02); // swung through centre to the other side
  });

  it('upper tiers lag the lower ones (S-curve) when the sway changes', () => {
    const w = new StackWhip();
    w.step(0, 3, 16);
    w.step(1, 3, 40);
    const t = w.tiers;
    const rel = (k: number) => t[k] / leanTarget(1, k);
    expect(rel(1)).toBeGreaterThan(rel(3));
  });

  it('snaps to targets under reduced motion and tracks stack size', () => {
    const w = new StackWhip();
    w.step(0.5, 2, 16, true);
    expect(w.tiers).toEqual([0, leanTarget(0.5, 1), leanTarget(0.5, 2)]);
    w.step(0.5, 1, 16, true);
    expect(w.tiers).toHaveLength(2);
  });
});

describe('swayWarn', () => {
  it('is 0 while steady and saturates near the topple threshold', () => {
    expect(swayWarn(0.3)).toBe(0);
    expect(swayWarn(-0.55)).toBe(0);
    expect(swayWarn(0.75)).toBeCloseTo(0.5, 5);
    expect(swayWarn(-1.2)).toBe(1);
  });
});

describe('tumblePose', () => {
  const t: Tumble = { orderId: 7, from: { x: 1, y: 1, z: 30 }, to: { x: 2, y: 3 }, angle: 0, side: 1, startMs: 0 };
  it('starts at the stack, lands on the floor tile, bounces once, then is done', () => {
    const a = tumblePose(t, 0);
    expect([a.x, a.y, a.z]).toEqual([1, 1, 30]);
    const mid = tumblePose(t, TUMBLE_MS / 2);
    expect(mid.z).toBeGreaterThan(0);
    expect(mid.z).toBeLessThan(30);
    const land = tumblePose(t, TUMBLE_MS);
    expect([land.x, land.y, land.z]).toEqual([2, 3, 0]);
    expect(tumblePose(t, TUMBLE_MS + BOUNCE_MS / 2).z).toBeGreaterThan(0);
    expect(tumblePose(t, TUMBLE_MS + BOUNCE_MS).done).toBe(true);
  });
});

describe('TrialFx', () => {
  it('hides a tumbling pallet until its bounce ends; reduced motion skips tumble and shake', () => {
    const fx = new TrialFx(() => false);
    fx.tumble({ orderId: 3, from: { x: 0, y: 0, z: 20 }, to: { x: 1, y: 0 }, angle: 0, side: 1, startMs: 0 });
    expect(fx.hidden.has(3)).toBe(true);
    fx.kick(8, 0);
    expect(Math.hypot(fx.shakeOffset(10).x, fx.shakeOffset(10).y)).toBeGreaterThan(0);
    expect(fx.shakeOffset(2000)).toEqual({ x: 0, y: 0 });

    const calm = new TrialFx(() => true);
    calm.tumble({ orderId: 4, from: { x: 0, y: 0, z: 20 }, to: { x: 1, y: 0 }, angle: 0, side: 1, startMs: 0 });
    calm.kick(8, 0);
    expect(calm.hidden.size).toBe(0);
    expect(calm.shakeOffset(10)).toEqual({ x: 0, y: 0 });
  });
});

describe('stack lean rendering helpers', () => {
  it('mixHex blends #RRGGBB colours and clamps t', () => {
    expect(mixHex('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(mixHex('#C4A06B', '#EF4444', 0)).toBe('#c4a06b');
    expect(mixHex('#C4A06B', '#EF4444', 2)).toBe('#ef4444');
  });

  it('leanAt interpolates within a pallet', () => {
    const lean = { tiers: [0, 0.1, 0.3], warn: 0 };
    expect(leanAt(lean, 1, 0)).toBeCloseTo(0.1);
    expect(leanAt(lean, 1, 0.5)).toBeCloseTo(0.2);
    expect(leanAt(undefined, 1, 0.5)).toBe(0);
  });

  it('vehicleParts bends a carried stack and tints the tipping top pallet', () => {
    const v = {
      id: 't', type: 'counterbalance', fork: 0, speedNow: 0, state: 'idle',
      cargo: [{ id: 1, p0: false }, { id: 2, p0: false }],
    } as unknown as Vehicle;
    const pose = { x: 10, y: 10, a: 0 };
    const straight = vehicleParts(v, pose, 0, 'den-1', true, 0);
    const bent = vehicleParts(v, pose, 0, 'den-1', true, 0, { tiers: [0, 0.1, 0.3], warn: 1 });
    const cargoY = (ps: typeof straight) => ps.filter((q) => q.z0 > 10 && q.len <= 0.42 && q.wid >= 0.34).map((q) => q.cy);
    expect(Math.max(...cargoY(straight))).toBeCloseTo(10);
    expect(Math.max(...cargoY(bent))).toBeGreaterThan(10.15);
    expect(bent.map((q) => q.hex)).not.toEqual(straight.map((q) => q.hex));
  });
});

describe('trials tumble landing', () => {
  it('lands square to the grid and holds that heading through the bounce', async () => {
    const { tumblePose, TUMBLE_MS, BOUNCE_MS } = await import('../src/trials/fx.js');
    for (const angle of [0, 0.3, 1.1, -2.4]) {
      for (const side of [1, -1]) {
        const t = { orderId: 1, from: { x: 0, y: 0, z: 20 }, to: { x: 1, y: 0 }, angle, side, startMs: 0 };
        const land = tumblePose(t, TUMBLE_MS).angle;
        const q = land / (Math.PI / 2);
        expect(Math.abs(q - Math.round(q))).toBeLessThan(1e-9);
        expect(tumblePose(t, TUMBLE_MS - 1).angle).toBeCloseTo(land, 1);
        expect(tumblePose(t, TUMBLE_MS + BOUNCE_MS).angle).toBe(land);
      }
    }
  });
});
