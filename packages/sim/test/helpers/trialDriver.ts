import {
  createGhostRecorder,
  encodeGhost,
  findPath,
  recordGhost,
  stepTrial,
  trialGuide,
  trialInteract,
  trialRev,
  type DriverInput,
  type GhostRecorder,
  type GhostRun,
  type Trial,
} from '../../src/index.js';

/**
 * Path-following driver (same approach as trials.test.ts `autoplay`) that records the run the way
 * the client does: `recordGhost` after every `stepTrial` and every `trialInteract`. Every input is
 * a plain keyboard state, so the result is a genuine run of the real trial physics.
 */
export function drive(tr: Trial, opts: { boost?: boolean } = {}): GhostRecorder {
  const rec = createGhostRecorder(tr);
  const v = tr.vehicle;
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const step = (input: DriverInput) => {
    stepTrial(tr, input);
    recordGhost(rec, tr);
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
      // Boost only on long straights with an empty fork (a test of the speed bound, not of skill).
      let straight = 0;
      for (let k = i; k + 1 < path.length && k < i + 8; k++) {
        if (Math.abs(wrap(Math.atan2(path[k + 1].y - path[k].y, path[k + 1].x - path[k].x) - v.angle)) < 0.2) straight++;
        else break;
      }
      step({
        up: !slow || creep,
        down: slow && !creep && v.speedNow > (endD < 1.8 ? 0.2 : corner * 0.8),
        left: diff < -0.08,
        right: diff > 0.08,
        boost: Boolean(opts.boost) && !slow && !v.cargo.length && straight >= 5 && endD > 6,
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
    if (!g) break;
    const bay = g.kind === 'drop' ? tr.world.map.bays.find((b) => b.id === g.order.bay)! : null;
    const target = bay ? { x: bay.tiles[1].x - 1, y: bay.tiles[1].y } : { x: g.x, y: g.y };
    if (!driveTo(target.x, target.y)) break;
    for (let k = 0; k < 8 && v.speedNow > 0; k++) step({ up: false, down: true, left: false, right: false });
    trialInteract(tr);
    recordGhost(rec, tr);
  }
  return rec;
}

export function runOf(tr: Trial, rec: GhostRecorder): GhostRun {
  return {
    levelId: tr.level.id,
    rev: trialRev(tr.level),
    time: tr.state.t,
    stars: tr.state.stars,
    strikes: tr.state.strikes,
    track: encodeGhost(rec.track),
  };
}

