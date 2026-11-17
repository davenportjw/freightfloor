import { describe, expect, it } from 'vitest';
import { drive, recordGuided, runOf, type DriveLog } from './trialDriver.js';
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

const recorded = new Map<string, { tr: Trial; rec: GhostRecorder; run: GhostRun; log: DriveLog | null }>();
/**
 * A genuine recorded clear: levels 1–6 (and boosted runs) use the path-following `drive`; the
 * Challenge levels 7–18 use the challenge-aware `guidedDrive` (charger stops, dock windows,
 * traffic yields, glass / heavy corner speeds).
 */
function recordedRun(id: string, boost = false) {
  const key = `${id}:${boost}`;
  const hit = recorded.get(key);
  if (hit) return hit;
  const tr = createTrial(id);
  let rec: GhostRecorder;
  let log: DriveLog | null = null;
  if (boost || tr.level.num <= 6) rec = drive(tr, { boost });
  else ({ rec, log } = recordGuided(tr));
  const r = { tr, rec, run: runOf(tr, rec), log };
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

describe('trial ghosts: Challenge levels 7–18', () => {
  const challenges = TRIAL_LEVELS.filter((l) => l.num > 6);
  const BODY_LIMIT = 64 * 1024;

  it.each(challenges.map((l) => [l.id]))('%s: a guided clear validates, round-trips and stays small', (id) => {
    const { tr, rec, run } = recordedRun(id);
    expect(tr.state.status).toBe('won');
    expect(validateGhostRun(run)).toMatchObject({ ok: true });
    const back = decodeGhost(run.track);
    expect(back.x.length).toBe(rec.track.x.length);
    expect(back.stack).toEqual(rec.track.stack);
    expect(back.events).toEqual(rec.track.events);
    // Structured delivery counts: drops + stows add up to every pallet.
    const delivered = back.events.filter((e) => e.kind === 'drop' || e.kind === 'stow').reduce((a, e) => a + (e.n ?? 0), 0);
    expect(delivered).toBe(tr.level.pallets.length);
    const body = JSON.stringify({ clientId: 'x'.repeat(36), rev: run.rev, time: run.time, stars: run.stars, strikes: run.strikes, track: run.track });
    expect(body.length).toBeLessThan(BODY_LIMIT / 4);
  });

  it('exercises the mechanics: stows, cross-dock, charger stops, dock windows and traffic', () => {
    const kinds = new Set<string>();
    let charges = 0;
    let waits = 0;
    let yields = 0;
    let largest = { id: '', chars: 0, time: 0 };
    for (const l of challenges) {
      const { run, rec, log } = recordedRun(l.id);
      for (const e of rec.track.events) kinds.add(e.kind);
      charges += log?.charges ?? 0;
      waits += log?.windowWaits ?? 0;
      yields += log?.trafficYields ?? 0;
      if (run.track.length > largest.chars) largest = { id: l.id, chars: run.track.length, time: run.time };
    }
    expect(kinds.has('stow')).toBe(true);
    expect(kinds.has('charge')).toBe(true);
    expect(charges).toBeGreaterThan(0);
    expect(waits).toBeGreaterThan(0);
    expect(yields).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.info(`[ghost] largest challenge ghost: ${largest.id} ${largest.time.toFixed(1)} s, ${largest.chars} chars`);
    expect(largest.chars).toBeLessThan(16_000);
  });

  it('encodes every event kind, including traffic strikes and extended markers', () => {
    const n = 6;
    const tk = {
      x: Array.from({ length: n }, (_, i) => 10 + i * 0.1),
      y: Array(n).fill(5),
      a: Array(n).fill(0),
      fork: Array(n).fill(0.15),
      sway: Array(n).fill(0),
      stack: [0, 1, 1, 0, 0, 0],
      events: [
        { i: 1, kind: 'pick' as const },
        { i: 2, kind: 'traffic' as const },
        { i: 2, kind: 'charge' as const },
        { i: 3, kind: 'stow' as const, n: 1 },
        { i: 4, kind: 'shatter' as const },
        { i: 5, kind: 'drop' as const, n: 3 },
      ],
    };
    expect(decodeGhost(encodeGhost(tk)).events).toEqual(tk.events);
  });

  it('rejects doctored challenge runs: off-slot stow, closed dock door, hidden traffic strike, shatter', () => {
    const pick = (pred: (id: string) => boolean) => challenges.find((l) => pred(l.id) && recordedRun(l.id).tr.state.status === 'won')!;
    const clone = (rec: GhostRecorder) => ({
      x: [...rec.track.x], y: [...rec.track.y], a: [...rec.track.a], fork: [...rec.track.fork],
      sway: [...rec.track.sway], stack: [...rec.track.stack], events: rec.track.events.map((e) => ({ ...e })),
    });
    const stowLevel = challenges.find((l) => recordedRun(l.id).rec.track.events.some((e) => e.kind === 'stow'))!;
    {
      const { rec, run } = recordedRun(stowLevel.id);
      const t = clone(rec);
      const st = t.events.find((e) => e.kind === 'stow')!;
      st.i = 0; // the start pose is nowhere near a putaway slot
      expect(validateGhostRun({ ...run, track: encodeGhost(t) })).toMatchObject({ ok: false });
    }
    const windowed = pick((id) => Boolean(trialLevel(id)!.windows));
    {
      const { rec, run } = recordedRun(windowed.id);
      const level = trialLevel(windowed.id)!;
      const t = clone(rec);
      // Move the first windowed-bay drop to a tick when that door is shut (same pose: truck parked).
      const d = t.events.find((e) => e.kind === 'drop' && level.windows![level.pallets.find((p) => p.bay && level.windows![p.bay])!.bay!])!;
      expect(d).toBeTruthy();
      const bay = Object.keys(level.windows!)[0];
      let shut = -1;
      for (let i = d.i; i > 0 && shut < 0; i--) {
        const w = level.windows![bay];
        const phase = (((i * 0.1 + (w.offset ?? 0)) % w.period) + w.period) % w.period;
        if (phase >= w.open + 0.2 && Math.hypot(t.x[i] - t.x[d.i], t.y[i] - t.y[d.i]) < 0.01) shut = i;
      }
      expect(shut).toBeGreaterThan(0); // the guided driver waited parked at the door
      if (shut > 0) {
        d.i = shut;
        expect(validateGhostRun({ ...run, track: encodeGhost(t) })).toMatchObject({ ok: false });
      }
    }
    const { rec, run } = recordedRun(challenges[0].id);
    const hidden = clone(rec);
    hidden.events.push({ i: 3, kind: 'traffic' });
    expect(validateGhostRun({ ...run, track: encodeGhost(hidden) })).toEqual({ ok: false, reason: 'strike_mismatch' });
    const broken = clone(rec);
    broken.events.push({ i: 3, kind: 'shatter' });
    expect(validateGhostRun({ ...run, track: encodeGhost(broken) })).toEqual({ ok: false, reason: 'shattered' });
  });
});

describe('trial ghosts: rules revision', () => {
  it('defaults to rev 1 and follows an explicit rev', () => {
    const level = trialLevel('first-lift')!;
    expect(trialRev(level)).toBe(level.rev ?? 1);
    expect(trialRev({ ...level, rev: 4 })).toBe(4);
  });
});
