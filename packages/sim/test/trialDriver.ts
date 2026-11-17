/**
 * Test-only guided driver for Floor Trials: follows `trialGuide` with `findPath`, using only the
 * real driving physics (`stepTrial`) and the E key (`trialInteract`). It handles every Challenge
 * mechanic the way a careful player would: slower corners with glass or a top-heavy stack, a
 * charger stop when the guide asks for one, waiting out a closed dock door, and braking or backing
 * off when a scripted forklift is about to cross its path. No state is ever teleported or faked.
 */
import {
  TRAFFIC_HIT,
  findPath,
  stackWeightFactor,
  stepTrial,
  trafficPose,
  trialGuide,
  trialInteract,
  windowState,
  type DriverInput,
  type Trial,
} from '../src/index.js';

const IDLE: DriverInput = { up: false, down: false, left: false, right: false };
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

export interface DriveLog {
  charges: number;
  windowWaits: number;
  trafficYields: number;
}

/** Closest approach (tiles) to any scripted forklift over the next ~1.6 s for a throttle plan. */
function trafficGap(tr: Trial, plan: 'go' | 'stop' | 'back'): number {
  const traffic = tr.level.traffic;
  if (!traffic?.length) return Infinity;
  const v = tr.vehicle;
  let x = v.px;
  let y = v.py;
  let sp = v.speedNow;
  let gap = Infinity;
  for (let k = 1; k <= 16; k++) {
    if (plan === 'go') sp = Math.min(Math.max(sp, 0) + 0.3, 3.2);
    else if (plan === 'stop') sp = sp > 0 ? Math.max(0, sp - 1.0) : Math.min(0, sp + 1.0);
    else sp = Math.max(-1.4, sp - 0.6);
    x += Math.cos(v.angle) * sp * 0.1;
    y += Math.sin(v.angle) * sp * 0.1;
    for (const tk of traffic) {
      const p = trafficPose(tk, tr.state.t + k * 0.1);
      gap = Math.min(gap, Math.hypot(x - p.x, y - p.y));
    }
  }
  return gap;
}

export function guidedDrive(tr: Trial): DriveLog {
  const v = tr.vehicle;
  const st = tr.state;
  const log: DriveLog = { charges: 0, windowWaits: 0, trafficYields: 0 };
  const SAFE = TRAFFIC_HIT + 0.65;
  const live = () => st.status !== 'won' && st.status !== 'failed';

  const step = (inp: DriverInput): void => {
    if (!tr.level.traffic?.length) return void stepTrial(tr, inp);
    // Yield to traffic: keep going only if the plan stays clear of every forklift.
    const wantsGo = inp.up || (!inp.down && Math.abs(v.speedNow) > 0.2);
    if (wantsGo && trafficGap(tr, 'go') < SAFE) {
      log.trafficYields++;
      const stop = trafficGap(tr, 'stop');
      const back = trafficGap(tr, 'back');
      if (stop >= SAFE || stop >= back) stepTrial(tr, { ...IDLE, down: v.speedNow > 0, up: v.speedNow < 0 });
      else stepTrial(tr, { ...IDLE, down: true });
      return;
    }
    if (!wantsGo && trafficGap(tr, 'stop') < SAFE && trafficGap(tr, 'back') > trafficGap(tr, 'stop')) {
      log.trafficYields++;
      stepTrial(tr, { ...IDLE, down: true });
      return;
    }
    stepTrial(tr, inp);
  };

  const cornerSpeed = (): number => {
    const n = v.cargo.length;
    let c = [3, 2.6, 1.9, 1.4][Math.min(3, n)];
    if (v.cargo.some((o) => tr.specs.get(o.id)?.fragile)) c *= 0.72;
    const f = stackWeightFactor(v.cargo.slice(0, 3).map((o) => Boolean(tr.specs.get(o.id)?.heavy)));
    if (f > 1) c /= Math.sqrt(f);
    return c;
  };

  const driveTo = (tx: number, ty: number, tight = false): boolean => {
    let path = findPath(tr.world, v.tile.x, v.tile.y, tx, ty) ?? [];
    let i = 0;
    for (let n = 0; n < 1600; n++) {
      if (!live()) return false;
      while (i < path.length && Math.hypot(v.px - (path[i].x + 0.5), v.py - (path[i].y + 0.5)) < 0.45) i++;
      const endD = Math.hypot(v.px - (tx + 0.5), v.py - (ty + 0.5));
      const onTile = v.tile.x === tx && v.tile.y === ty;
      if ((tight ? onTile && endD < 0.45 : endD < 0.9) && Math.abs(v.speedNow) < 0.6) return true;
      const wp = path[Math.min(i, path.length - 1)] ?? { x: tx, y: ty };
      const diff = wrap(Math.atan2(wp.y + 0.5 - v.py, wp.x + 0.5 - v.px) - v.angle);
      const nxt = path[i + 1];
      const turnAhead = nxt ? Math.abs(wrap(Math.atan2(nxt.y - wp.y, nxt.x - wp.x) - v.angle)) > 0.5 : false;
      const corner = cornerSpeed();
      const slow = endD < 1.8 || (turnAhead && Math.abs(v.speedNow) > corner) || Math.abs(diff) > 0.6;
      const creep = endD < 1.8 && endD > (tight ? 0.3 : 0.8) && Math.abs(diff) < 0.6 && v.speedNow < 0.7;
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

  const settle = (): void => {
    for (let k = 0; k < 10 && v.speedNow > 0 && live(); k++) step({ ...IDLE, down: true });
    for (let k = 0; k < 10 && v.speedNow < 0 && live(); k++) step({ ...IDLE, up: true });
  };

  for (let guard = 0; guard < 80 && live(); guard++) {
    const g = trialGuide(tr);
    if (!g) return log;
    if (g.kind === 'charge') {
      if (!driveTo(g.x, g.y, true)) return log;
      settle();
      log.charges++;
      for (let k = 0; k < 600 && live(); k++) {
        const cg = trialGuide(tr);
        if (cg?.kind !== 'charge' || !cg.inRange) break;
        stepTrial(tr, IDLE);
      }
      continue;
    }
    let target = { x: g.x, y: g.y };
    if (g.kind === 'drop' && !g.stow) {
      const bay = tr.world.map.bays.find((b) => b.id === g.order.bay)!;
      target = { x: bay.tiles[1].x - 1, y: bay.tiles[1].y };
    }
    if (!driveTo(target.x, target.y)) return log;
    settle();
    let ev = trialInteract(tr);
    if (ev?.kind === 'closed') {
      log.windowWaits++;
      for (let k = 0; k < 400 && live() && !windowState(tr.level.windows, g.order.bay, st.t)?.open; k++) step(IDLE);
      ev = trialInteract(tr);
    }
  }
  return log;
}
