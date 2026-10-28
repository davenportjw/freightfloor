import { describe, expect, it } from 'vitest';
import {
  applyClientInputSlice,
  createWorld,
  spawnPlayerVehicle,
  stepHuman,
  STREAM_STALE_DT,
  tick,
} from '../src/index.js';

const W = { up: true, down: false, left: false, right: false, boost: false };
const WD = { ...W, right: true };
const NONE = { up: false, down: false, left: false, right: false, boost: false };

function setup() {
  const w = createWorld({ seed: 77, agents: 0 });
  const v = spawnPlayerVehicle(w, 'cs', 'Stream')!;
  const hy = w.map.hwyY[1]!;
  v.px = 4.5;
  v.py = hy + 0.5;
  v.tile = { x: 4, y: hy };
  v.angle = 0;
  v.speedNow = 0;
  return { w, v };
}

describe('client-timed input stream (applyClientInputSlice)', () => {
  it('applies exactly the client slices, matching a local replay of the same slices', () => {
    const { w, v } = setup();
    const { w: w2, v: ref } = setup();
    const slices: Array<[typeof W, number]> = [
      [NONE, 0],
      [W, 0.1],
      [W, 0.037],
      [WD, 0.063],
      [W, 0.1],
    ];
    for (let i = 0; i < slices.length; i++) {
      const [inp, dt] = slices[i]!;
      const next = slices[i + 1]?.[0] ?? NONE;
      applyClientInputSlice(w, v, inp, dt, next);
      if (dt > 0) stepHuman(w2, ref, inp, dt);
    }
    expect(v.px).toBeCloseTo(ref.px, 9);
    expect(v.py).toBeCloseTo(ref.py, 9);
    expect(v.angle).toBeCloseTo(ref.angle, 9);
    expect(v.angle).toBeGreaterThan(0.1);
    expect(v.input).toMatchObject(NONE);
  });

  it('tick leaves a live stream alone, advances a stale one, and deducts that debt from the next slice', () => {
    const { w, v } = setup();
    applyClientInputSlice(w, v, NONE, 0, W);
    applyClientInputSlice(w, v, W, 0.1, W);
    const x0 = v.px;
    tick(w); // stream still live → server does not move the vehicle on its own
    expect(v.px).toBe(x0);
    const ticks = Math.ceil(STREAM_STALE_DT / 0.1) + 1;
    for (let i = 0; i < ticks; i++) tick(w);
    expect(v.px).toBeGreaterThan(x0); // stale → coasting / driving continues server-side
    const debt = v.streamDebtDt ?? 0;
    expect(debt).toBeGreaterThan(0);
    const x1 = v.px;
    applyClientInputSlice(w, v, W, debt, W); // resuming slice fully covered by the debt
    expect(v.px).toBe(x1);
    expect(v.streamDebtDt).toBe(0);
  });

  it('does not move the vehicle during a factory break', () => {
    const { w, v } = setup();
    w.phase = 'break';
    applyClientInputSlice(w, v, W, 0.2, W);
    expect(v.speedNow).toBe(0);
    expect(v.px).toBe(4.5);
  });
});
