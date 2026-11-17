/**
 * Floor Trials (prototype): Flarts-style level select + gameplay in one pane.
 *
 * Runs the deterministic trial sim (`@warehouse/sim` trials.ts) locally at a fixed 10 Hz and
 * renders with the main game's WarehouseRenderer. Progress (best stars / time per level) is
 * kept in localStorage; nothing talks to the server.
 */
import {
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
  els.toasts.innerHTML = '';
  els.result.hidden = true;
  els.levelName.textContent = `${trial.level.num}. ${trial.level.name}`;
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

function drainEvents(): void {
  for (const ev of trial.state.events) {
    if (ev.seq <= seenSeq) continue;
    seenSeq = ev.seq;
    if (ev.kind !== 'won' && ev.kind !== 'failed') toast(ev);
  }
}

function finish(): void {
  const st = trial.state;
  const won = st.status === 'won';
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
    acc += dt;
    while (acc >= STEP_MS) {
      prevPose = poseOf(trial);
      stepTrial(trial, input());
      acc -= STEP_MS;
      if (trial.state.status === 'won' || trial.state.status === 'failed') {
        acc = 0;
        break;
      }
    }
    drainEvents();
    if (trial.state.status === 'won' || trial.state.status === 'failed') finish();
  }
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
  const opts: RenderOptions = {
    layers: { routes: false, traffic: false, labels: true, ghost: false },
    highlightStrategy: null,
    selectedVid: null,
    myVid: trial.vehicle.id,
    coneMode: false,
    overlays: new Map(),
    guide: trialGuide(trial),
    myPose: pose,
    cargoSway: trial.state.sway,
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
    drainEvents();
    if (trial.state.status === 'won') finish();
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

els.retry.addEventListener('click', () => startLevel(trial.level.id));
els.next.addEventListener('click', () => {
  const next = TRIAL_LEVELS.find((l) => l.num === trial.level.num + 1);
  if (next && unlocked(next)) startLevel(next.id);
});

// Resume at the first level without stars (or the last unlocked one).
const resume = TRIAL_LEVELS.find((l) => unlocked(l) && !progress[l.id]) ?? TRIAL_LEVELS[TRIAL_LEVELS.length - 1];
startLevel(resume.id);
requestAnimationFrame(frame);
