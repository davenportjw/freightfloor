/**
 * Moment juice (retention spec §4b): triggers come only from real events/messages, frames are
 * deterministic, and every effect respects prefers-reduced-motion.
 */
import { describe, expect, it } from 'vitest';
import { LIVERIES, type DailyResultMessage } from '@warehouse/protocol';
import { HUMAN, type SimEvent } from '@warehouse/sim';
import {
  cabJuiceAnchor,
  paintCabRing,
  paintConfetti,
  paintEdgeFlash,
  type JuiceCtx,
  confettiFrame,
  confettiPalette,
  dailyJuice,
  flashAlpha,
  GOLD,
  JUICE_MAX,
  JUICE_MS,
  juiceForEvent,
  pruneJuice,
  ringFrame,
  ringJuice,
  streakMilestone,
  type Juice,
} from '../src/render/juice.js';

const fare = (over: Partial<SimEvent> = {}): SimEvent =>
  ({ t: 1, type: 'fare', text: 'x', vid: 'v1', rating: 'normal', orderId: 7, pts: 10, ...over }) as SimEvent;

const daily = (over: Partial<DailyResultMessage> = {}): DailyResultMessage => ({
  type: 'dailyResult',
  dailyKey: '2026-11-10',
  pts: 500,
  dailyBest: 500,
  improved: false,
  dailyRank: 3,
  dailyOf: 40,
  attempts: 1,
  streak: 2,
  streakDelta: 1,
  ...over,
});

describe('juiceForEvent (on-time delivery confetti)', () => {
  it('fires for my normal / speedy fares in my livery colours', () => {
    const j = juiceForEvent(fare({ rating: 'speedy' }), 'v1', LIVERIES.night_shift, 100);
    expect(j?.kind).toBe('confetti');
    expect(j?.colors.slice(0, 2)).toEqual([LIVERIES.night_shift.primary, LIVERIES.night_shift.accent]);
    expect(juiceForEvent(fare(), 'v1', null, 100)?.colors[0]).toBe(HUMAN.color);
  });
  it('never fires for late (slow) fares, other drivers, spectators or other events', () => {
    expect(juiceForEvent(fare({ rating: 'slow' }), 'v1', null, 1)).toBeNull();
    expect(juiceForEvent(fare({ vid: 'v2' }), 'v1', null, 1)).toBeNull();
    expect(juiceForEvent(fare(), null, null, 1)).toBeNull();
    expect(juiceForEvent(fare({ type: 'incident' }), 'v1', null, 1)).toBeNull();
  });
  it('palette falls back to the livery highlight when there is no accent', () => {
    expect(confettiPalette(LIVERIES.century)[1]).toBe(LIVERIES.century.accent ?? LIVERIES.century.light);
  });
});

describe('streakMilestone', () => {
  it('fires once when crossing a multiple of 5', () => {
    expect(streakMilestone(4, 5)).toBe(5);
    expect(streakMilestone(9, 10)).toBe(10);
    expect(streakMilestone(5, 6)).toBeNull();
    expect(streakMilestone(3, 4)).toBeNull();
  });
  it('ignores resets and unchanged streaks', () => {
    expect(streakMilestone(10, 0)).toBeNull();
    expect(streakMilestone(5, 5)).toBeNull();
  });
});

describe('dailyJuice', () => {
  it('flashes gold for a new best on a repeat attempt only', () => {
    expect(dailyJuice(daily({ improved: true, attempts: 2, streakDelta: 0 }), 0).map((j) => j.kind)).toEqual(['flash']);
    expect(dailyJuice(daily({ improved: true, attempts: 1, streakDelta: 0 }), 0)).toEqual([]);
  });
  it('pulses a ring when a Daily streak milestone is reached', () => {
    expect(dailyJuice(daily({ streak: 3, streakDelta: 1 }), 0).map((j) => j.kind)).toEqual(['ring']);
    expect(dailyJuice(daily({ streak: 7, streakDelta: 0 }), 0)).toEqual([]);
    expect(dailyJuice(daily({ streak: 4, streakDelta: 1 }), 0)).toEqual([]);
  });
});

describe('frames', () => {
  const confetti: Juice = { kind: 'confetti', born: 0, colors: ['#111111', '#222222'], seed: 42 };
  it('confetti is deterministic, fades out and ends', () => {
    const a = confettiFrame(confetti, 300, false);
    expect(a.length).toBeGreaterThan(0);
    expect(confettiFrame(confetti, 300, false)).toEqual(a);
    expect(a[0].color).toBe('#111111');
    expect(confettiFrame(confetti, JUICE_MS.confetti - 1, false).every((b) => b.alpha < 0.05)).toBe(true);
    expect(confettiFrame(confetti, JUICE_MS.confetti, false)).toEqual([]);
  });
  it('ring expands, or holds still under reduced motion', () => {
    const r = ringJuice(0);
    expect(r.colors[0]).toBe(GOLD);
    expect(ringFrame(r, 800, false)!.radius).toBeGreaterThan(ringFrame(r, 100, false)!.radius);
    expect(ringFrame(r, 800, true)!.radius).toBe(ringFrame(r, 100, true)!.radius);
    expect(ringFrame(r, JUICE_MS.ring, false)).toBeNull();
  });
  it('flash rises once then decays; dim under reduced motion', () => {
    const f: Juice = { kind: 'flash', born: 0, colors: [GOLD], seed: 0 };
    const peak = flashAlpha(f, JUICE_MS.flash * 0.15, false);
    expect(flashAlpha(f, 20, false)).toBeLessThan(peak);
    expect(flashAlpha(f, 600, false)).toBeLessThan(peak);
    expect(Math.max(...[0, 100, 300, 600].map((t) => flashAlpha(f, t, true)))).toBeLessThanOrEqual(0.12);
    expect(flashAlpha(f, JUICE_MS.flash, false)).toBe(0);
  });
});

describe('reduced motion', () => {
  it('drops confetti entirely', () => {
    const j = juiceForEvent(fare(), 'v1', null, 0)!;
    expect(confettiFrame(j, 200, true)).toEqual([]);
  });
});

describe('pruneJuice', () => {
  it('drops expired effects and caps the list', () => {
    const many = Array.from({ length: 10 }, (_, i) => ringJuice(i));
    expect(pruneJuice(many, 10)).toHaveLength(JUICE_MAX);
    expect(pruneJuice([ringJuice(0)], JUICE_MS.ring + 1)).toEqual([]);
  });
});

/** Records painter calls (no DOM in the client test env). */
function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const stops: Array<[number, string]> = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    translate: (x: number, y: number) => calls.push(['translate', x, y]),
    rotate: (r: number) => calls.push(['rotate', r]),
    fillRect: (...a: number[]) => calls.push(['fillRect', ...a, ctx.globalAlpha, ctx.fillStyle]),
    beginPath: () => calls.push(['beginPath']),
    ellipse: (...a: number[]) => calls.push(['ellipse', ...a]),
    stroke: () => calls.push(['stroke', ctx.globalAlpha, ctx.strokeStyle, ctx.lineWidth]),
    createRadialGradient: () => ({ addColorStop: (o: number, c: string) => stops.push([o, c]) }),
  };
  return { ctx: ctx as unknown as JuiceCtx, calls, stops };
}

describe('shared juice painters (iso + Cab View)', () => {
  it('edge flash fills the viewport with a gold edge gradient, and skips zero alpha', () => {
    const r = recorder();
    paintEdgeFlash(r.ctx, 800, 600, 0);
    expect(r.calls).toEqual([]);
    paintEdgeFlash(r.ctx, 800, 600, 0.4);
    expect(r.calls.find((c) => c[0] === 'fillRect')?.slice(1, 5)).toEqual([0, 0, 800, 600]);
    expect(r.stops).toEqual([[0, 'rgba(245,158,11,0)'], [1, 'rgba(245,158,11,0.400)']]);
    expect(r.calls.filter((c) => c[0] === 'save').length).toBe(r.calls.filter((c) => c[0] === 'restore').length);
  });

  it('confetti paints one balanced rect per bit at the scaled offset', () => {
    const j = juiceForEvent(fare(), 'v1', null, 1000)!;
    const bits = confettiFrame(j, 1300, false);
    const r = recorder();
    paintConfetti(r.ctx, bits, 100, 200, 2);
    const rects = r.calls.filter((c) => c[0] === 'fillRect');
    expect(rects.length).toBe(bits.length);
    const t0 = r.calls.find((c) => c[0] === 'translate')!;
    expect(t0[1]).toBeCloseTo(100 + bits[0].dx * 2);
    expect(t0[2]).toBeCloseTo(200 + bits[0].dy * 2);
    expect(r.calls.filter((c) => c[0] === 'save').length).toBe(bits.length);
    expect(r.calls.filter((c) => c[0] === 'restore').length).toBe(bits.length);
  });

  it('Cab View anchor sits at the lower centre and scales with the viewport', () => {
    const small = cabJuiceAnchor(400, 300);
    const big = cabJuiceAnchor(1920, 1080);
    expect(small.x).toBe(200);
    expect(small.y).toBeCloseTo(300 * 0.62);
    expect(big.ringPx).toBeGreaterThan(small.ringPx);
    expect(small.scale).toBeGreaterThanOrEqual(1);
    expect(big.scale).toBeLessThanOrEqual(2.2);
  });

  it('Cab View ring is a squashed floor ellipse in the ring colour; reduced motion keeps its radius', () => {
    const j = ringJuice(0);
    const draw = (now: number, reduced: boolean) => {
      const r = recorder();
      paintCabRing(r.ctx, 800, 600, ringFrame(j, now, reduced)!, GOLD);
      return r.calls;
    };
    const calls = draw(200, false);
    const e = calls.find((c) => c[0] === 'ellipse')! as number[] & unknown[];
    expect(e[1]).toBe(400);
    expect(e[4] as number).toBeCloseTo((e[3] as number) * 0.35);
    expect(calls.find((c) => c[0] === 'stroke')![2]).toBe(GOLD);
    const rx = (now: number) => draw(now, true).find((c) => c[0] === 'ellipse')![3];
    expect(rx(100)).toBe(rx(900));
  });
});
