import { describe, expect, it } from 'vitest';
import { drive, runOf } from './helpers/trialDriver.js';
import {
  TRIAL_GHOST_MAX_STEP,
  TRIAL_LEVELS,
  createTrial,
  decodeGhost,
  encodeGhost,
  ghostLevelPar,
  ghostSampleCount,
  sampleGhost,
  trialLevel,
  trialRev,
  validateGhostRun,
  type GhostRecorder,
  type GhostRun,
  type Trial,
} from '../src/index.js';

const recorded = new Map<string, { tr: Trial; rec: GhostRecorder; run: GhostRun }>();
function recordedRun(id: string, boost = false) {
  const key = `${id}:${boost}`;
  const hit = recorded.get(key);
  if (hit) return hit;
  const tr = createTrial(id);
  const rec = drive(tr, { boost });
  const r = { tr, rec, run: runOf(tr, rec) };
  recorded.set(key, r);
  return r;
}

describe('trial ghosts: recording and encoding', () => {
  it('records one sample per tick from the start pose to the winning drop', () => {
    const { tr, rec } = recordedRun('first-lift');
    expect(tr.state.status).toBe('won');
    const level = trialLevel('first-lift')!;
    expect(rec.track.x.length).toBe(ghostSampleCount(tr.state.t));
    expect(rec.track.x[0]).toBe(level.start.x + 0.5);
    expect(rec.track.y[0]).toBe(level.start.y + 0.5);
    expect(rec.track.events.map((e) => e.kind)).toEqual(['pick', 'drop']);
    expect(rec.track.events[1]).toMatchObject({ i: rec.track.x.length - 1, n: 1 });
    expect(rec.track.stack.at(-1)).toBe(0);
    expect(Math.max(...rec.track.stack)).toBe(1);
  });

  it('round-trips a real run within quantization error and stays compact', () => {
    const { tr, rec, run } = recordedRun('rush-hour');
    expect(tr.state.status).toBe('won');
    const back = decodeGhost(run.track);
    const n = rec.track.x.length;
    expect(back.x.length).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(Math.abs(back.x[i] - rec.track.x[i])).toBeLessThanOrEqual(1 / 128 + 1e-9);
      expect(Math.abs(back.y[i] - rec.track.y[i])).toBeLessThanOrEqual(1 / 128 + 1e-9);
      const da = Math.atan2(Math.sin(back.a[i] - rec.track.a[i]), Math.cos(back.a[i] - rec.track.a[i]));
      expect(Math.abs(da)).toBeLessThanOrEqual(Math.PI / 256 + 1e-9);
      expect(back.stack[i]).toBe(rec.track.stack[i]);
      expect(Math.abs(back.sway[i] - rec.track.sway[i])).toBeLessThanOrEqual(1 / 64 + 1e-9);
      expect(Math.abs(back.fork[i] - rec.track.fork[i])).toBeLessThanOrEqual(1 / 126 + 1e-9);
    }
    expect(back.events).toEqual(rec.track.events);
    // Bytes per second of run: a 90 s run must stay under ~10 KB of base64.
    const perSecond = run.track.length / tr.state.t;
    expect(perSecond * 90).toBeLessThan(10_000);
    // eslint-disable-next-line no-console
    console.info(`[ghost] ${tr.level.id}: ${tr.state.t.toFixed(1)} s, ${n} samples, ${run.track.length} chars (${(perSecond * 90 / 1024).toFixed(1)} KiB per 90 s)`);
  });

  it('sampleGhost interpolates between ticks and reports the end of the run', () => {
    const { rec } = recordedRun('first-lift');
    const tk = rec.track;
    const mid = sampleGhost(tk, 0.55);
    expect(mid.x).toBeCloseTo((tk.x[5] + tk.x[6]) / 2, 6);
    expect(mid.y).toBeCloseTo((tk.y[5] + tk.y[6]) / 2, 6);
    expect(mid.done).toBe(false);
    const end = sampleGhost(tk, 1e6);
    expect(end.done).toBe(true);
    expect(end.x).toBe(tk.x.at(-1));
    expect(sampleGhost(tk, -5).x).toBe(tk.x[0]);
  });

  it('rejects malformed tracks', () => {
    const { run } = recordedRun('first-lift');
    expect(() => decodeGhost('')).toThrow();
    expect(() => decodeGhost('!!!!')).toThrow();
    expect(() => decodeGhost(run.track.slice(0, -6))).toThrow();
    expect(() => decodeGhost(run.track + 'AAAA')).toThrow();
    expect(() => decodeGhost('Ag')).toThrow(); // format 2
  });
});

describe('trial ghosts: plausibility validator', () => {
  it.each(TRIAL_LEVELS.map((l) => [l.id]))('accepts a genuine recorded clear of %s', (id) => {
    const { tr, run } = recordedRun(id);
    expect(tr.state.status).toBe('won');
    const res = validateGhostRun(run);
    expect(res).toMatchObject({ ok: true });
  });

  it('accepts a genuine boosted run and the speed bound covers it', () => {
    const { tr, rec, run } = recordedRun('rush-hour', true);
    expect(tr.state.status).toBe('won');
    let max = 0;
    for (let i = 1; i < rec.track.x.length; i++) {
      max = Math.max(max, Math.hypot(rec.track.x[i] - rec.track.x[i - 1], rec.track.y[i] - rec.track.y[i - 1]));
    }
    // eslint-disable-next-line no-console
    console.info(`[ghost] boosted ${tr.level.id}: max step ${max.toFixed(3)} tiles/tick`);
    expect(max).toBeGreaterThan(0.9); // the run really hit boost top speed
    expect(max).toBeLessThan(TRIAL_GHOST_MAX_STEP);
    expect(validateGhostRun(run)).toMatchObject({ ok: true });
  });

  it('rejects rule mismatches', () => {
    const { run } = recordedRun('first-lift');
    const par = ghostLevelPar('first-lift')!;
    expect(validateGhostRun({ ...run, levelId: 'nope' })).toEqual({ ok: false, reason: 'unknown_level' });
    expect(validateGhostRun({ ...run, rev: run.rev + 1 })).toEqual({ ok: false, reason: 'stale_rev' });
    expect(validateGhostRun({ ...run, time: run.time - 0.1 })).toMatchObject({ ok: false });
    expect(validateGhostRun({ ...run, time: run.time + 0.05 })).toEqual({ ok: false, reason: 'bad_time' });
    expect(validateGhostRun({ ...run, time: Math.round(par * 2) / 10 })).toEqual({ ok: false, reason: 'too_fast' });
    expect(validateGhostRun({ ...run, stars: run.stars === 3 ? 2 : 3 })).toEqual({ ok: false, reason: 'bad_stars' });
    expect(validateGhostRun({ ...run, strikes: 3 })).toEqual({ ok: false, reason: 'bad_strikes' });
    expect(validateGhostRun({ ...run, track: 'garbage!' })).toEqual({ ok: false, reason: 'bad_track' });
  });

  it('rejects doctored trajectories', () => {
    const { rec, run } = recordedRun('first-lift');
    const tk = rec.track;
    const clone = () => ({
      x: [...tk.x], y: [...tk.y], a: [...tk.a], fork: [...tk.fork], sway: [...tk.sway], stack: [...tk.stack],
      events: tk.events.map((e) => ({ ...e })),
    });
    const check = (mut: (t: ReturnType<typeof clone>) => void) => {
      const t = clone();
      mut(t);
      return validateGhostRun({ ...run, track: encodeGhost(t) });
    };
    // Teleport: one tick jumps two tiles.
    expect(check((t) => { for (let i = 20; i < t.x.length; i++) t.x[i] += 2; })).toMatchObject({ ok: false });
    // Wrong start pose.
    expect(check((t) => { t.x[0] += 1; })).toEqual({ ok: false, reason: 'bad_start' });
    // Delivered nothing.
    expect(check((t) => { t.events = t.events.filter((e) => e.kind !== 'drop'); })).toEqual({ ok: false, reason: 'not_delivered' });
    // Hidden strike.
    expect(check((t) => { t.events.push({ i: 30, kind: 'topple' }); })).toEqual({ ok: false, reason: 'strike_mismatch' });
    // Stack above the level cap.
    expect(check((t) => { t.stack[40] = 3; })).toEqual({ ok: false, reason: 'stack_overflow' });
    // Drop away from any bay.
    expect(check((t) => { const d = t.events.find((e) => e.kind === 'drop')!; d.i = 0; t.events.push({ i: t.x.length - 1, kind: 'drop', n: 0 }); })).toEqual({ ok: false, reason: 'drop_off_bay' });
  });
});

describe('trial ghosts: rules revision', () => {
  it('defaults to rev 1 and follows an explicit rev', () => {
    const level = trialLevel('first-lift')!;
    expect(trialRev(level)).toBe(level.rev ?? 1);
    expect(trialRev({ ...level, rev: 4 })).toBe(4);
  });
});
