import { describe, expect, it } from 'vitest';
import { TRIAL_LEVELS, createTrial, trialGuide, trialSection } from '@warehouse/sim';
import {
  batteryHud,
  challengeIntent,
  drawChallengeWorld,
  drawFog,
  fogRings,
  mechanicTags,
  stackSummary,
} from '../src/trials/challenges.js';
import type { Painter } from '../src/render/painter.js';

/** Recording stand-in for the Painter / canvas context (no DOM needed). */
function fakePainter() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const ctx = new Proxy(
    { measureText: () => ({ width: 30 }) } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return (...args: unknown[]) => calls.push({ fn: `ctx.${prop}`, args });
      },
      set() {
        return true;
      },
    },
  );
  const pt = {
    ctx,
    P: (x: number, y: number, z = 0) => [x * 10, y * 10 - z],
    circleGrid: (x: number, y: number, r: number) => [
      [x - r, y],
      [x, y - r],
      [x + r, y],
    ],
    poly: (...args: unknown[]) => calls.push({ fn: 'poly', args }),
    tile: (...args: unknown[]) => calls.push({ fn: 'tile', args }),
    oBox: (...args: unknown[]) => calls.push({ fn: 'oBox', args }),
    pill: (...args: unknown[]) => calls.push({ fn: 'pill', args }),
  };
  return { pt: pt as unknown as Painter, calls };
}

const level = (id: string) => TRIAL_LEVELS.find((l) => l.id === id)!;

describe('Floor Trials challenge HUD copy', () => {
  it('tags each challenge card with its mechanics and leaves the basics untagged', () => {
    for (const l of TRIAL_LEVELS.filter((x) => trialSection(x) === 'start')) {
      // Wet Floor / Wobbly Racks keep their own blurbs; only spills / wobbly tags would apply.
      expect(mechanicTags(l).every((t) => t === 'Spills' || t === 'Wobbly racks')).toBe(true);
    }
    expect(mechanicTags(level('putaway'))).toEqual(['Putaway']);
    expect(mechanicTags(level('cross-dock'))).toEqual(['Cross-dock']);
    expect(mechanicTags(level('traffic'))).toEqual(['Traffic']);
    expect(mechanicTags(level('lights-out'))).toEqual(expect.arrayContaining(['Dark', 'Cones', 'Spills']));
    expect(mechanicTags(level('night-shift')).length).toBeGreaterThanOrEqual(8);
  });

  it('shows the battery only on battery levels, with low and charging tones', () => {
    expect(batteryHud(createTrial('first-lift'))).toBeNull();
    const tr = createTrial('low-battery');
    expect(batteryHud(tr)).toEqual({ text: 'Battery 55%', tone: 'ok' });
    tr.state.battery = 12.7;
    expect(batteryHud(tr)).toEqual({ text: 'Battery 12%', tone: 'low' });
    tr.state.charging = true;
    expect(batteryHud(tr)?.tone).toBe('charging');
  });

  it('lists carried glass / heavy pallets bottom to top', () => {
    const tr = createTrial('heavy-bottom');
    expect(stackSummary(tr)).toBe('Stack 0/3 · 0/6 shipped');
    const [heavy, light] = tr.world.orders;
    tr.vehicle.cargo.push(heavy, light);
    expect(stackSummary(tr)).toBe('Stack 2/3 (heavy · light) · 0/6 shipped');
    const plain = createTrial('first-lift');
    plain.vehicle.cargo.push(plain.world.orders[0]);
    expect(stackSummary(plain)).toBe('Stack 1/1 · 0/1 shipped');
  });

  it('explains charging, shut doors and stowing', () => {
    const bat = createTrial('low-battery');
    bat.state.status = 'running';
    bat.state.battery = 6;
    expect(challengeIntent(bat, trialGuide(bat))).toMatch(/charger/);
    bat.state.charging = true;
    expect(challengeIntent(bat, trialGuide(bat))).toBe('Charging 6% · stay parked');

    const doors = createTrial('dock-windows');
    doors.state.status = 'running';
    doors.state.t = 1;
    for (const o of doors.world.orders.filter((x) => x.bay === 'E4')) {
      o.state = 'picked';
      doors.vehicle.cargo.push(o);
    }
    doors.vehicle.px = 57.5;
    doors.vehicle.py = 18.5;
    expect(challengeIntent(doors, trialGuide(doors))).toBe('Bay E4 door shut · opens in 7.0s');

    const stow = createTrial('putaway');
    stow.state.status = 'running';
    const o = stow.world.orders[0];
    stow.vehicle.cargo.push(o);
    stow.vehicle.px = o.putaway!.ax + 0.5;
    stow.vehicle.py = o.putaway!.ay + 0.5;
    expect(challengeIntent(stow, trialGuide(stow))).toBe('E · Stow in I1-2');

    expect(challengeIntent(createTrial('first-lift'), null)).toBeNull();
  });
});

describe('Floor Trials challenge overlays', () => {
  it('draws nothing extra on a basic level', () => {
    const { pt, calls } = fakePainter();
    drawChallengeWorld(pt, createTrial('tower-of-three'), 0, new Set(), false);
    expect(calls).toHaveLength(0);
  });

  it('draws traffic forklifts at their scripted pose and door pills with countdowns', () => {
    const { pt, calls } = fakePainter();
    const tr = createTrial('rush-hour-ii');
    drawChallengeWorld(pt, tr, 0, new Set(), true, 0);
    expect(calls.filter((c) => c.fn === 'oBox')).toHaveLength(3 * 3);
    const pills = calls.filter((c) => c.fn === 'pill').map((c) => c.args[0]);
    expect(pills).toEqual(['E7 OPEN 9.0s', 'E8 SHUT 10.0s']);
  });

  it('marks putaway slots, working chargers and glass / heavy pallets', () => {
    const put = fakePainter();
    const tr = createTrial('putaway');
    tr.vehicle.cargo.push(tr.world.orders[0]);
    drawChallengeWorld(put.pt, tr, 0, new Set(), true);
    expect(put.calls.filter((c) => c.fn === 'tile')).toHaveLength(4);
    expect(put.calls.find((c) => c.fn === 'pill')?.args[0]).toBe('I1-2');

    const bat = fakePainter();
    drawChallengeWorld(bat.pt, createTrial('low-battery'), 0, new Set(), true);
    expect(bat.calls.filter((c) => c.fn === 'poly')).toHaveLength(6);

    const glass = fakePainter();
    const g = createTrial('fragile');
    drawChallengeWorld(glass.pt, g, 0, new Set([g.world.orders[0].id]), true);
    const texts = glass.calls.filter((c) => c.fn === 'ctx.fillText').map((c) => c.args[0]);
    expect(texts).toEqual(['GLASS']); // the hidden (mid-tumble) glass pallet is skipped
  });

  it('fog leaves a soft-edged hole of the visibility radius around the truck', () => {
    expect(fogRings(4.5).map((r) => r.r)).toEqual([4.5, 5.1, 5.7, 6.3]);
    const { pt, calls } = fakePainter();
    drawFog(pt, { x: 10, y: 10, a: 0 }, 4.5);
    expect(calls.filter((c) => c.fn === 'ctx.fill').map((c) => c.args[0])).toEqual(['evenodd', 'evenodd', 'evenodd', 'evenodd']);
  });
});
