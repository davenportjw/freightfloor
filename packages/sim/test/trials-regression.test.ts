/**
 * Bit-for-bit regression for the "Getting started" Floor Trials (levels 1–6).
 *
 * The expected fingerprints below were recorded on `main` (3a81da7) before the Challenge levels
 * (7–18) and their opt-in mechanics landed. Every new mechanic is gated by an optional
 * `TrialLevel` field, so these levels must replay identically: same par, same clock, same
 * stars/strikes, same final pose and the same sway trace.
 */
import { describe, expect, it } from 'vitest';
import {
  createTrial,
  findPath,
  stepTrial,
  trialGuide,
  trialInteract,
  type DriverInput,
  type Trial,
} from '../src/index.js';

const IDLE: DriverInput = { up: false, down: false, left: false, right: false };

/** FNV-1a over a rounded numeric trace (stable across platforms for identical float math). */
class Trace {
  private h = 0x811c9dc5;
  add(n: number): void {
    const s = n.toFixed(6);
    for (let i = 0; i < s.length; i++) {
      this.h ^= s.charCodeAt(i);
      this.h = Math.imul(this.h, 0x01000193) >>> 0;
    }
  }
  get hex(): string {
    return this.h.toString(16).padStart(8, '0');
  }
}

function sample(tr: Trial, trace: Trace): void {
  trace.add(tr.vehicle.px);
  trace.add(tr.vehicle.py);
  trace.add(tr.state.sway);
  trace.add(tr.vehicle.cargo.length);
  trace.add(tr.state.strikes);
}

/** Frozen copy of the original path-following autoplay (do not tune: it is the fixture). */
function autoplay(tr: Trial, trace: Trace): void {
  const v = tr.vehicle;
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const step = (i: DriverInput) => {
    stepTrial(tr, i);
    sample(tr, trace);
  };
  const driveTo = (tx: number, ty: number): boolean => {
    let path = findPath(tr.world, v.tile.x, v.tile.y, tx, ty) ?? [];
    let i = 0;
    for (let n = 0; n < 900; n++) {
      if (tr.state.status === 'failed') return false;
      while (i < path.length && Math.hypot(v.px - (path[i].x + 0.5), v.py - (path[i].y + 0.5)) < 0.45) i++;
      const endD = Math.hypot(v.px - (tx + 0.5), v.py - (ty + 0.5));
      if (endD < 0.9 && Math.abs(v.speedNow) < 0.6) return true;
      const wp = path[Math.min(i, path.length - 1)] ?? { x: tx, y: ty };
      const diff = wrap(Math.atan2(wp.y + 0.5 - v.py, wp.x + 0.5 - v.px) - v.angle);
      const nxt = path[i + 1];
      const turnAhead = nxt ? Math.abs(wrap(Math.atan2(nxt.y - wp.y, nxt.x - wp.x) - v.angle)) > 0.5 : false;
      const corner = [3, 2.6, 1.9, 1.4][v.cargo.length];
      const slow = endD < 1.8 || (turnAhead && Math.abs(v.speedNow) > corner) || Math.abs(diff) > 0.6;
      const creep = endD < 1.8 && endD > 0.8 && Math.abs(diff) < 0.6 && v.speedNow < 0.7;
      step({
        up: !slow || creep,
        down: slow && !creep && v.speedNow > (endD < 1.8 ? 0.2 : corner * 0.8),
        left: diff < -0.08,
        right: diff > 0.08,
      });
      if (n % 60 === 59 && (i >= path.length || Math.abs(v.speedNow) < 0.05)) {
        path = findPath(tr.world, v.tile.x, v.tile.y, tx, ty) ?? [];
        i = 0;
      }
    }
    return false;
  };
  for (let guard = 0; guard < 30 && tr.state.status !== 'won' && tr.state.status !== 'failed'; guard++) {
    const g = trialGuide(tr);
    if (!g) return;
    const bay = g.kind === 'drop' ? tr.world.map.bays.find((b) => b.id === g.order.bay)! : null;
    const target = bay ? { x: bay.tiles[1].x - 1, y: bay.tiles[1].y } : { x: g.x, y: g.y };
    if (!driveTo(target.x, target.y)) return;
    for (let k = 0; k < 8 && v.speedNow > 0; k++) step({ ...IDLE, down: true });
    trialInteract(tr);
  }
}

/** Reckless scripted inputs (boost, hard turns, braking) from the start pose: exercises sway, walls and strikes. */
function reckless(tr: Trial, trace: Trace): void {
  const B: DriverInput = { up: true, down: false, left: false, right: false, boost: true };
  const script: Array<[DriverInput, number]> = [
    [{ ...IDLE, up: true }, 12],
    [{ ...IDLE, up: true, left: true }, 6],
    [B, 10],
    [{ ...B, right: true }, 5],
    [{ ...IDLE, down: true }, 8],
    [{ ...IDLE, up: true, right: true }, 9],
    [B, 14],
    [{ ...IDLE, down: true, left: true }, 6],
    [{ ...IDLE, up: true }, 20],
  ];
  // Pre-load the forks so the sway model is in play from the first tick.
  for (const o of tr.world.orders.slice(0, tr.level.stackMax)) {
    o.state = 'picked';
    tr.vehicle.cargo.push(o);
    tr.vehicle.orders.push(o);
  }
  for (const [inp, n] of script) {
    for (let i = 0; i < n; i++) {
      stepTrial(tr, inp);
      sample(tr, trace);
    }
  }
}

interface Fingerprint {
  par: number;
  status: string;
  t: number;
  stars: number;
  strikes: number;
  delivered: number;
  px: string;
  py: string;
  trace: string;
}

function fingerprint(tr: Trial, trace: Trace): Fingerprint {
  return {
    par: tr.state.par,
    status: tr.state.status,
    t: tr.state.t,
    stars: tr.state.stars,
    strikes: tr.state.strikes,
    delivered: tr.state.delivered,
    px: tr.vehicle.px.toFixed(6),
    py: tr.vehicle.py.toFixed(6),
    trace: trace.hex,
  };
}

const LEGACY = ['first-lift', 'double-stack', 'tower-of-three', 'wet-floor', 'wobbly-racks', 'rush-hour'] as const;

// Recorded on main @ 3a81da7 (before Challenge levels).
const AUTOPLAY: Record<string, Fingerprint> = {
  'first-lift': { par: 11.4, status: 'won', t: 14, stars: 3, strikes: 0, delivered: 1, px: '56.619259', py: '9.484117', trace: 'a77fbce5' },
  'double-stack': { par: 14.8, status: 'won', t: 23.5, stars: 2, strikes: 0, delivered: 2, px: '56.629093', py: '6.462162', trace: '1ab3c5e3' },
  'tower-of-three': { par: 19.9, status: 'won', t: 27.3, stars: 2, strikes: 0, delivered: 3, px: '57.494418', py: '19.398386', trace: '0e17b244' },
  'wet-floor': { par: 19.3, status: 'won', t: 29.4, stars: 2, strikes: 0, delivered: 3, px: '56.791295', py: '24.442153', trace: '219247ee' },
  'wobbly-racks': { par: 24.3, status: 'won', t: 35.2, stars: 2, strikes: 0, delivered: 3, px: '56.640185', py: '9.509646', trace: '28c0ce3b' },
  'rush-hour': { par: 53.1, status: 'won', t: 72.1, stars: 2, strikes: 0, delivered: 6, px: '56.628615', py: '33.443732', trace: '2df115eb' },
};
const RECKLESS: Record<string, Fingerprint> = {
  'first-lift': { par: 11.4, status: 'running', t: 9, stars: 0, strikes: 1, delivered: 0, px: '44.092986', py: '22.735584', trace: '6d935a2b' },
  'double-stack': { par: 14.8, status: 'running', t: 9, stars: 0, strikes: 1, delivered: 0, px: '39.302684', py: '7.086471', trace: '6857534e' },
  'tower-of-three': { par: 19.9, status: 'running', t: 9, stars: 0, strikes: 2, delivered: 0, px: '22.924142', py: '1.328715', trace: '75b1c6ee' },
  'wet-floor': { par: 19.3, status: 'running', t: 9, stars: 0, strikes: 2, delivered: 0, px: '40.649078', py: '15.781475', trace: 'a22d142e' },
  'wobbly-racks': { par: 24.3, status: 'running', t: 9, stars: 0, strikes: 2, delivered: 0, px: '21.070270', py: '1.189918', trace: 'ce080909' },
  'rush-hour': { par: 53.1, status: 'running', t: 9, stars: 0, strikes: 2, delivered: 0, px: '27.497707', py: '28.408625', trace: 'bdf8e7af' },
};

describe('Getting started levels replay bit-for-bit', () => {
  it.each(LEGACY.map((id) => [id]))('%s autoplay fingerprint', (id) => {
    const tr = createTrial(id);
    const trace = new Trace();
    autoplay(tr, trace);
    expect(fingerprint(tr, trace)).toEqual(AUTOPLAY[id]);
  });

  it.each(LEGACY.map((id) => [id]))('%s reckless-script fingerprint', (id) => {
    const tr = createTrial(id);
    const trace = new Trace();
    reckless(tr, trace);
    expect(fingerprint(tr, trace)).toEqual(RECKLESS[id]);
  });
});
