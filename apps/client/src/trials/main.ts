/// <reference types="vite/client" />
/**
 * Floor Trials: Flarts-style level select + gameplay in one pane.
 *
 * Runs the deterministic trial sim (`@warehouse/sim` trials.ts) locally at a fixed 10 Hz and
 * renders with the main game's WarehouseRenderer. Progress (best stars / time per level) is
 * kept in localStorage. Ghost runs (ghosts.ts) record every attempt, keep your fastest locally and
 * share / fetch other players' runs through the lobby's `/api/trials/:levelId/*` endpoints.
 */
import {
  IMPACT_DROP,
  IMPACT_REST,
  TRIAL_LEVELS,
  TRIAL_MAX_STRIKES,
  createTrial,
  stepTrial,
  trialGuide,
  trialInteract,
  type DriverInput,
  type Trial,
  type TrialEvent,
  type TrialLevel,
} from '@warehouse/sim';
import { WarehouseRenderer, type RenderOptions } from '../renderer.js';
import type { Pose } from '../render/motion.js';
import { forkHeightM, isoZ } from '../render/liftGeometry.js';
import { CARGO_TIER_Z, cargoOffset } from '../render/vehicles.js';
import { StackWhip, TrialFx } from './fx.js';
import { TrialGhosts } from './ghosts.js';

const STEP_MS = 100; // 1 tick = 0.1 game-min = 100 ms real time (matches TICK_MIN)
const STORE_KEY = 'ff.trials.v1';

interface Best {
  stars: number;
  time: number;
}
type Progress = Record<string, Best>;

function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Progress) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveProgress(p: Progress): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
  } catch {
    // Private mode / quota: progress just isn't persisted this session.
  }
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Floor Trials: missing #${id}`);
  return el as T;
};

const els = {
  canvas: $<HTMLCanvasElement>('trCanvas'),
  levels: $<HTMLOListElement>('trLevels'),
  total: $('trTotal'),
  levelName: $('trLevelName'),
  timer: $('trTimer'),
  strikes: $('trStrikes'),
  stack: $('trStack'),
  meter: $('trMeter'),
  meterFill: $('trMeterFill'),
  intent: $('trIntent'),
  toasts: $('trToasts'),
  result: $('trResult'),
  resStars: $('trResStars'),
  resTitle: $('trResTitle'),
  resLine: $('trResLine'),
  retry: $<HTMLButtonElement>('trRetry'),
  next: $<HTMLButtonElement>('trNext'),
};

let progress = loadProgress();
let trial: Trial = createTrial(TRIAL_LEVELS[0].id);
let prevPose: Pose = poseOf(trial);
let acc = 0;
let lastFrame = 0;
let seenSeq = 0;
const keys = new Set<string>();
/** Brief sim pause after a hard impact (hit-stop); the level clock is sim time, so it's free. */
const HITSTOP_MS = 70;
let freezeUntil = 0;
const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const reducedMotion = (): boolean => Boolean(motionQuery?.matches);
const whip = new StackWhip();
const fx = new TrialFx(reducedMotion);
const ghosts = new TrialGhosts({
  stage: els.canvas.parentElement ?? document.body,
  storage: (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })(),
  reducedMotion,
});
/** Ghost clock (level seconds): follows the drawn player pose, keeps running after the finish. */
let ghostT = 0;

const renderer = new WarehouseRenderer({
  canvas: els.canvas,
  onSelectVehicle: () => {},
  onClickTile: () => {},
});

function poseOf(tr: Trial): Pose {
  return { x: tr.vehicle.px, y: tr.vehicle.py, a: tr.vehicle.angle };
}

function unlocked(level: TrialLevel): boolean {
  if (level.num === 1) return true;
  const prev = TRIAL_LEVELS.find((l) => l.num === level.num - 1);
  return !!prev && (progress[prev.id]?.stars ?? 0) > 0;
}

const starRow = (n: number): string => `<b>${'★'.repeat(n)}</b>${'★'.repeat(Math.max(0, 3 - n))}`;

function renderLevels(): void {
  els.levels.innerHTML = '';
  let total = 0;
  for (const level of TRIAL_LEVELS) {
    const best = progress[level.id];
    total += best?.stars ?? 0;
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tr-level';
    btn.disabled = !unlocked(level);
    btn.setAttribute('aria-current', String(level.id === trial.level.id));
    btn.innerHTML = `
      <span class="tr-level__num">${level.num}</span>
      <span>
        <div class="tr-level__name">${level.name}</div>
        <div class="tr-level__blurb">${btn.disabled ? 'Clear the previous level to unlock.' : level.blurb}</div>
        <div class="tr-level__stars">${starRow(best?.stars ?? 0)}${
          best ? `<span class="tr-level__best">${best.time.toFixed(1)}s</span>` : ''
        }</div>
      </span>`;
    btn.addEventListener('click', () => startLevel(level.id));
    li.appendChild(btn);
    els.levels.appendChild(li);
  }
  els.total.textContent = `${total} / ${TRIAL_LEVELS.length * 3} ★`;
}

function startLevel(id: string): void {
  trial = createTrial(id);
  prevPose = poseOf(trial);
  acc = 0;
  seenSeq = 0;
  freezeUntil = 0;
  whip.reset();
  fx.clear();
  els.toasts.innerHTML = '';
  els.result.hidden = true;
  els.levelName.textContent = `${trial.level.num}. ${trial.level.name}`;
  ghostT = 0;
  ghosts.startLevel(trial, progress[id]?.time ?? null);
  renderLevels();
  toast({ seq: 0, t: 0, kind: 'hint', text: trial.level.tip });
}

function input(): DriverInput {
  return {
    up: keys.has('KeyW') || keys.has('ArrowUp'),
    down: keys.has('KeyS') || keys.has('ArrowDown'),
    left: keys.has('KeyA') || keys.has('ArrowLeft'),
    right: keys.has('KeyD') || keys.has('ArrowRight'),
    boost: keys.has('ShiftLeft') || keys.has('ShiftRight') || keys.has('Space'),
  };
}

function toast(ev: TrialEvent): void {
  const el = document.createElement('div');
  el.className = 'tr-toast';
  el.dataset.kind = ev.kind;
  el.textContent = ev.text;
  els.toasts.prepend(el);
  while (els.toasts.children.length > 4) els.toasts.lastElementChild?.remove();
  window.setTimeout(() => el.remove(), 2700);
}

function drainEvents(now: number): void {
  for (const ev of trial.state.events) {
    if (ev.seq <= seenSeq) continue;
    seenSeq = ev.seq;
    if (ev.kind !== 'won' && ev.kind !== 'failed') toast(ev);
    if (ev.kind === 'rack_warn') fx.kick(4, now);
    if (ev.kind === 'rack_fall' && ev.x != null && ev.y != null) {
      fx.kick(10, now);
      fx.dust(ev.x + 0.5, ev.y + 0.5, 1.8, now);
    }
    if (ev.kind === 'crash') fx.kick(11, now);
  }
}

/**
 * One sim step plus the client-side reactions it implies: a hard impact shakes the screen (and
 * briefly hit-stops), and every pallet that left the forks without being delivered tumbles from
 * its place in the stack to the floor tile the sim put it on.
 */
function stepWithFx(now: number): void {
  const v = trial.vehicle;
  const before = v.cargo.map((o) => o.id);
  const prevSpeed = Math.abs(v.speedNow);
  const pose = poseOf(trial);
  const forkZ = isoZ(forkHeightM(Number.isFinite(v.fork) ? v.fork : 0)) + 2;
  const side = Math.sign(trial.state.sway) || 1;
  stepTrial(trial, input());
  ghosts.record(trial);
  const drop = prevSpeed - Math.abs(v.speedNow);
  if (drop > IMPACT_DROP && Math.abs(v.speedNow) < IMPACT_REST) {
    fx.kick(3 + prevSpeed * 2.2, now);
    if (!reducedMotion()) freezeUntil = now + HITSTOP_MS;
  } else if (drop > IMPACT_DROP && v.cargo.length) {
    // Letting go of boost: a light lurch, no hitstop.
    fx.kick(1.5 + drop * 0.4, now);
  }
  const ca = Math.cos(pose.a);
  const sa = Math.sin(pose.a);
  const ox = cargoOffset(v.type);
  before.forEach((id, i) => {
    if (v.cargo.some((o) => o.id === id)) return;
    const o = trial.world.orders.find((x) => x.id === id);
    if (!o || o.state !== 'open') return;
    const lat = whip.tiers[i] ?? 0;
    fx.tumble({
      orderId: id,
      from: { x: pose.x + ca * ox - sa * lat, y: pose.y + sa * ox + ca * lat, z: forkZ + i * CARGO_TIER_Z },
      to: { x: o.slot.ax + 0.5, y: o.slot.ay + 0.5 },
      angle: pose.a,
      side,
      startMs: now,
    });
  });
}

function finish(): void {
  const st = trial.state;
  const won = st.status === 'won';
  ghosts.finish(trial);
  if (won) {
    const best = progress[trial.level.id];
    if (!best || st.stars > best.stars || (st.stars === best.stars && st.t < best.time)) {
      progress = { ...progress, [trial.level.id]: { stars: st.stars, time: st.t } };
      saveProgress(progress);
    }
  }
  els.resStars.innerHTML = starRow(won ? st.stars : 0);
  els.resTitle.textContent = won ? `${trial.level.name} clear` : 'Three strikes';
  els.resLine.textContent = won
    ? `${st.t.toFixed(1)}s · par ${st.par.toFixed(1)}s · ${st.strikes} strike${st.strikes === 1 ? '' : 's'}`
    : `${st.delivered}/${st.total} delivered. Ease off in the turns.`;
  const next = TRIAL_LEVELS.find((l) => l.num === trial.level.num + 1);
  els.next.disabled = !next || !unlocked(next);
  els.result.hidden = false;
  renderLevels();
}

function updateHud(): void {
  const st = trial.state;
  const v = trial.vehicle;
  els.timer.textContent = `${st.t.toFixed(1)}s`;
  els.strikes.innerHTML = `<b>${'✖'.repeat(st.strikes)}</b>${'✖'.repeat(Math.max(0, TRIAL_MAX_STRIKES - st.strikes))}`;
  els.stack.textContent = `Stack ${v.cargo.length}/${trial.level.stackMax} · ${st.delivered}/${st.total} shipped`;
  const s = Math.max(-1, Math.min(1, st.sway));
  const pct = Math.abs(s) * 50;
  els.meterFill.style.width = `${pct}%`;
  els.meterFill.style.left = s >= 0 ? '50%' : `${50 - pct}%`;
  els.meter.dataset.level = Math.abs(s) > 0.75 ? 'danger' : Math.abs(s) > 0.45 ? 'warn' : 'ok';
  const g = trialGuide(trial);
  let intent = '';
  if (st.status === 'ready') intent = 'Drive to start the clock';
  else if (g?.inRange && Math.abs(v.speedNow) < 1) intent = g.kind === 'pick' ? 'E · Lift pallet' : `E · Drop at Bay ${g.order.bay}`;
  else if (Math.abs(s) > 0.75) intent = 'Load tipping! Straighten up';
  els.intent.textContent = intent;
}

function frame(now: number): void {
  const dt = lastFrame ? Math.min(250, now - lastFrame) : 0;
  lastFrame = now;
  const live = trial.state.status === 'ready' || trial.state.status === 'running';
  if (live) {
    if (now >= freezeUntil) acc += dt;
    while (acc >= STEP_MS) {
      prevPose = poseOf(trial);
      stepWithFx(now);
      acc -= STEP_MS;
      if (trial.state.status === 'won' || trial.state.status === 'failed') {
        acc = 0;
        break;
      }
    }
    drainEvents(now);
    if (trial.state.status === 'won' || trial.state.status === 'failed') finish();
  }
  whip.step(trial.state.sway, trial.vehicle.cargo.length, dt, reducedMotion());
  const shake = fx.shakeOffset(now);
  els.canvas.style.transform = shake.x || shake.y ? `translate(${shake.x.toFixed(1)}px, ${shake.y.toFixed(1)}px)` : '';
  const cur = poseOf(trial);
  const k = Math.min(1, acc / STEP_MS);
  let da = cur.a - prevPose.a;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  const pose: Pose = {
    x: prevPose.x + (cur.x - prevPose.x) * k,
    y: prevPose.y + (cur.y - prevPose.y) * k,
    a: prevPose.a + da * k,
  };
  if (trial.state.status === 'running') ghostT = Math.max(0, trial.state.t - 0.1 + 0.1 * k);
  else if (trial.state.status !== 'ready') ghostT += dt / 1000;
  const guide = trialGuide(trial);
  const opts: RenderOptions = {
    layers: { routes: false, traffic: false, labels: true, ghost: false },
    highlightStrategy: null,
    selectedVid: null,
    myVid: trial.vehicle.id,
    coneMode: false,
    overlays: new Map(),
    guide: guide && !(guide.kind === 'pick' && fx.hidden.has(guide.order.id)) ? guide : null,
    myPose: pose,
    cargoLean: whip.lean(trial.state.sway),
    hiddenOrders: fx.hidden,
    floorFx: (pt) => ghosts.drawFloor(pt, ghostT),
    worldFx: (pt, nowMs) => {
      fx.draw(pt, nowMs);
      ghosts.draw(pt, ghostT);
    },
    minimalChrome: true,
    markerFilter: (m) => !fx.landingOn(m.x, m.y),
  };
  renderer.render(trial.world, opts, now);
  updateHud();
  requestAnimationFrame(frame);
}

const DRIVE_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight', 'Space',
]);

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (DRIVE_KEYS.has(e.code)) {
    keys.add(e.code);
    e.preventDefault();
    return;
  }
  if (e.repeat) return;
  if (e.code === 'KeyE') {
    trialInteract(trial);
    ghosts.record(trial);
    drainEvents(performance.now());
    if (trial.state.status === 'won') finish();
  } else if (e.code === 'KeyG') {
    ghosts.cycle();
  } else if (e.code === 'KeyR') {
    startLevel(trial.level.id);
  } else if (e.code === 'Enter' && !els.result.hidden && !els.next.disabled) {
    els.next.click();
  } else if (/^Digit[1-9]$/.test(e.code)) {
    const level = TRIAL_LEVELS.find((l) => l.num === Number(e.code.slice(5)));
    if (level && unlocked(level)) startLevel(level.id);
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// Touch controls: hold a pad button = hold its key; E taps interact.
for (const btn of document.querySelectorAll<HTMLButtonElement>('#trTouch button')) {
  const key = btn.dataset.key;
  const release = (): void => {
    if (key) keys.delete(key);
    btn.setAttribute('aria-pressed', 'false');
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    btn.setAttribute('aria-pressed', 'true');
    if (key) keys.add(key);
    else if (btn.dataset.act === 'interact') {
      trialInteract(trial);
      ghosts.record(trial);
      drainEvents(performance.now());
      if (trial.state.status === 'won') finish();
    }
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) btn.addEventListener(ev, release);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

els.retry.addEventListener('click', () => startLevel(trial.level.id));
els.next.addEventListener('click', () => {
  const next = TRIAL_LEVELS.find((l) => l.num === trial.level.num + 1);
  if (next && unlocked(next)) startLevel(next.id);
});

// Resume at the first level without stars (or the last unlocked one).
const resume = TRIAL_LEVELS.find((l) => unlocked(l) && !progress[l.id]) ?? TRIAL_LEVELS[TRIAL_LEVELS.length - 1];
startLevel(resume.id);
requestAnimationFrame(frame);

// Dev server only (stripped from production builds): lets the Playwright visual check stage a loaded stack.
if (import.meta.env.DEV) {
  (window as unknown as { __trials?: unknown }).__trials = { get trial() { return trial; }, interact: trialInteract };
}
