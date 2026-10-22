import { describe, expect, it } from 'vitest';
import {
  DOCK_SWAP_MIN,
  DOCK_TRAVEL_TILES,
  dockParts,
  dockTruckFrame,
  RIG_LEN,
  rigParts,
  SimClock,
  TRAILER_LEN,
  TRAILER_TOP,
  TRAILER_WID,
  type RigOpts,
} from '../src/render/trucks.js';

describe('render/trucks dock cycle', () => {
  it('is docked (no offset, fully opaque) outside the swap window', () => {
    for (const [t, until] of [
      [0, 0],
      [12, 10],
      [10, 10],
    ]) {
      const f = dockTruckFrame(t, until);
      expect(f).toMatchObject({ phase: 'docked', visible: true, dx: 0, alpha: 1, gear: 0 });
    }
  });

  it('pulls the full rig out, leaves the apron empty, then backs the next rig in', () => {
    const until = 100;
    const at = (u: number) => dockTruckFrame(until - DOCK_SWAP_MIN * (1 - u), until);
    const start = at(0.01);
    expect(start.phase).toBe('departing');
    expect(start.braking).toBe(true); // releasing brakes before pulling away

    const d1 = at(0.15);
    const d2 = at(0.35);
    expect(d1.phase).toBe('departing');
    expect(d1.gear).toBe(1);
    expect(d2.dx).toBeGreaterThan(d1.dx);
    expect(d2.dx).toBeLessThanOrEqual(DOCK_TRAVEL_TILES);

    expect(at(0.5)).toMatchObject({ phase: 'empty', visible: false });

    const a1 = at(0.6);
    const a2 = at(0.85);
    expect(a1.phase).toBe('arriving');
    expect(a1.gear).toBe(-1); // reversing in
    expect(a2.dx).toBeLessThan(a1.dx);
    const settle = at(0.995);
    expect(settle.dx).toBeLessThan(0.01);
    expect(settle.braking).toBe(true);
  });

  it('is continuous at the window edges (no pop when the bay reopens)', () => {
    const until = 50;
    expect(dockTruckFrame(until - 1e-6, until).dx).toBeCloseTo(0, 4);
    expect(dockTruckFrame(until - DOCK_SWAP_MIN + 1e-6, until).dx).toBeCloseTo(0, 4);
  });

  it('fades rigs out far from the dock and keeps alpha in range', () => {
    const until = 10;
    for (let i = 0; i <= 100; i++) {
      const f = dockTruckFrame(until - DOCK_SWAP_MIN + (i / 100) * DOCK_SWAP_MIN, until);
      expect(f.alpha).toBeGreaterThanOrEqual(0);
      expect(f.alpha).toBeLessThanOrEqual(1);
      if (f.visible && f.dx < DOCK_TRAVEL_TILES * 0.5) expect(f.alpha).toBe(1);
    }
  });

  it('treats non-finite inputs as docked', () => {
    expect(dockTruckFrame(Number.NaN, 5).phase).toBe('docked');
    expect(dockTruckFrame(1, Number.NaN).phase).toBe('docked');
  });
});

describe('render/trucks rig model', () => {
  const base: RigOpts = { dockX: 40, cy: 10.5, dx: 0, kind: 'ship', fill: 0, blink: false, gear: 0, braking: false };

  it('spans trailer + tractor along +x from the dock face, within the bay width', () => {
    const parts = rigParts(base);
    const minX = Math.min(...parts.map((p) => p.x));
    const maxX = Math.max(...parts.map((p) => p.x + p.w));
    const minY = Math.min(...parts.map((p) => p.y));
    const maxY = Math.max(...parts.map((p) => p.y + p.d));
    expect(minX).toBeCloseTo(40, 5);
    expect(maxX).toBeGreaterThan(40 + TRAILER_LEN + 1);
    expect(maxX).toBeLessThanOrEqual(40 + RIG_LEN + 0.05);
    expect(minY).toBeGreaterThanOrEqual(10.5 - TRAILER_WID / 2 - 1e-9);
    expect(maxY).toBeLessThanOrEqual(10.5 + TRAILER_WID / 2 + 0.05);
    expect(Math.max(...parts.map((p) => p.z0 + p.h))).toBeGreaterThanOrEqual(TRAILER_TOP);
  });

  it('translates rigidly with dx', () => {
    const a = rigParts(base);
    const b = rigParts({ ...base, dx: 2.5 });
    expect(b).toHaveLength(a.length);
    b.forEach((p, i) => {
      expect(p.x - a[i].x).toBeCloseTo(2.5, 9);
      expect(p.y).toBe(a[i].y);
    });
  });

  it('draws running gear before the trailer body (painter order)', () => {
    const parts = rigParts(base);
    const body = parts.findIndex((p) => p.w === TRAILER_LEN && p.d === TRAILER_WID);
    expect(body).toBeGreaterThan(0);
    const wheels = parts
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.z0 === 0 && p.h === 6 && p.hex === '#111827');
    expect(wheels.length).toBe(10); // 2 trailer + 2 drive + 1 steer axle, both sides
    for (const w of wheels) expect(w.i).toBeLessThan(body);
  });

  it('adds wheel chocks only when chocked, squats when loaded, and uses NET livery', () => {
    const chocks = (o: RigOpts) => rigParts(o).filter((p) => p.hex === '#FACC15').length;
    expect(chocks(base)).toBe(0);
    expect(chocks({ ...base, chocked: true })).toBe(2);

    const deck = (fill: number) => rigParts({ ...base, fill }).find((p) => p.w === TRAILER_LEN && p.d === TRAILER_WID)!.z0;
    expect(deck(1)).toBeLessThan(deck(0));

    const shipping = rigParts(base).map((p) => p.hex);
    const net = rigParts({ ...base, kind: 'net' }).map((p) => p.hex);
    expect(net).toContain('#6366F1');
    expect(shipping).not.toContain('#6366F1');
  });

  it('lights the beacon only while moving and blinking', () => {
    const beacon = (o: Partial<RigOpts>) => rigParts({ ...base, ...o }).at(-1)!.hex;
    expect(beacon({ blink: true, gear: 0 })).toBe('#92400E');
    expect(beacon({ blink: true, gear: -1 })).toBe('#FBBF24');
  });

  it('places dock bumpers just outside the trailer footprint', () => {
    const [left, right] = dockParts(40, 10.5);
    expect(left.y + left.d).toBeLessThanOrEqual(10.5 - TRAILER_WID / 2);
    expect(right.y).toBeGreaterThanOrEqual(10.5 + TRAILER_WID / 2);
    // West docks: bumpers sit on the building side (+x) of the dock face.
    for (const b of dockParts(0.95, 10.5, -1)) expect(b.x).toBeGreaterThanOrEqual(0.95);
  });
});

describe('render/trucks west receiving docks (mirrored rig)', () => {
  const west: RigOpts = {
    dockX: 0.95,
    cy: 4.5,
    dx: 0,
    dir: -1,
    kind: 'receive',
    fill: 0,
    blink: false,
    gear: 0,
    braking: false,
  };
  const body = (parts: ReturnType<typeof rigParts>) => parts.find((p) => p.w === TRAILER_LEN && p.d === TRAILER_WID)!;

  it('mirrors the rig to extend towards -x from the dock face', () => {
    const parts = rigParts(west);
    expect(Math.max(...parts.map((p) => p.x + p.w))).toBeLessThanOrEqual(0.95 + 0.07); // only rear details protrude
    const minX = Math.min(...parts.map((p) => p.x));
    expect(minX).toBeGreaterThanOrEqual(0.95 - RIG_LEN - 1e-9);
    expect(minX).toBeLessThan(0.95 - TRAILER_LEN - 1);
    expect(body(parts).x + TRAILER_LEN).toBeCloseTo(0.95, 9);
  });

  it('draws the tractor first and the trailer rear last (camera sees the doors)', () => {
    const parts = rigParts(west);
    const bodyIdx = parts.indexOf(body(parts));
    const cabIdx = parts.findIndex((p) => p.hex === '#1D4ED8' && p.h === 20);
    expect(cabIdx).toBeGreaterThanOrEqual(0);
    expect(cabIdx).toBeLessThan(bodyIdx);
    const tail = parts.slice(bodyIdx + 1);
    expect(tail.some((p) => p.hex === '#DC2626')).toBe(true); // tail lamps
    expect(parts.some((p) => p.hex === '#CBD5E1' && p.w === 0.04)).toBe(false); // no hidden grille
  });

  it('opens the roll-up door and shows waiting pallets only when inbound freight is present', () => {
    const pallets = (o: Partial<RigOpts>) => rigParts({ ...west, ...o }).filter((p) => p.hex === '#D9B98A').length;
    const mouth = (o: Partial<RigOpts>) => rigParts({ ...west, ...o }).some((p) => p.hex === '#1E293B');
    expect(mouth({ doorPallets: null })).toBe(false);
    expect(pallets({ doorPallets: null })).toBe(0);
    expect(mouth({ doorPallets: 0 })).toBe(true);
    expect(pallets({ doorPallets: 2 })).toBe(2);
    expect(pallets({ doorPallets: 9 })).toBe(3); // capped to what fits in the trailer mouth
    // East bays never draw rear-door details (that face points away from the camera).
    expect(rigParts({ ...west, dir: 1, dockX: 40, doorPallets: 2 }).some((p) => p.hex === '#D9B98A')).toBe(false);
  });

  it('uses the receiving livery', () => {
    expect(rigParts(west).some((p) => p.hex === '#0F766E')).toBe(true);
  });
});

describe('render/trucks SimClock', () => {
  it('interpolates between 10 Hz world-time samples', () => {
    const c = new SimClock();
    expect(c.update(5, 1000)).toBe(5);
    c.update(5.1, 1100);
    const mid = c.update(5.1, 1150);
    expect(mid).toBeGreaterThan(5);
    expect(mid).toBeLessThan(5.1);
    expect(c.update(5.1, 1300)).toBeCloseTo(5.1, 9);
  });

  it('snaps on rewinds and large jumps', () => {
    const c = new SimClock();
    c.update(10, 0);
    expect(c.update(2, 100)).toBe(2);
    expect(c.update(40, 200)).toBe(40);
  });
});
