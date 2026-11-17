/**
 * Floor Trials ghost runs (client): record every run, keep the player's fastest trajectory per
 * level locally, share it through the lobby (`/api/trials/:levelId/*`) and draw up to three
 * translucent ghost trucks that drive the level in step with the player's clock.
 *
 * Slots: **World #1** (default; the teaching ghost), **Next to beat** (the run just faster than
 * your best) and **My best** (local). The selected slot also paints a faint trail on the floor
 * with its pick / drop stops. If the lobby is unreachable the panel says so; no ghost is invented.
 */
import {
  TrialGhostsResponseSchema,
  TrialRunSubmitResponseSchema,
  type TrialGhostsResponse,
  type TrialRunSubmitResponse,
} from '@warehouse/protocol';
import {
  createGhostRecorder,
  decodeGhost,
  encodeGhost,
  recordGhost,
  sampleGhost,
  trialRev,
  validateGhostRun,
  type GhostRecorder,
  type GhostRun,
  type GhostTrack,
  type Trial,
  type TrialLevel,
} from '@warehouse/sim';
import type { Painter } from '../render/painter.js';
import { forkHeightM, isoZ } from '../render/liftGeometry.js';
import type { StorageLike } from '../ui/panel.js';

/** Own best trajectory per level: `{ [levelId]: LocalGhost }` (separate from `ff.trials.v1`). */
export const GHOST_STORE_KEY = 'ff.trials.ghosts.v1';
/** Selected ghost slot (`world` | `next` | `mine` | `off`). */
export const GHOST_MODE_KEY = 'ff.trials.ghostMode';
/** Same raw clientId the live game uses (bearer credential for lobby calls; never displayed). */
export const CLIENT_ID_KEY = 'warehouse_client_id';

export type GhostSlot = 'world' | 'next' | 'mine';
export type GhostMode = GhostSlot | 'off';
export const GHOST_MODES: readonly GhostMode[] = ['world', 'next', 'mine', 'off'];
const MODE_LABEL: Record<GhostMode, string> = { world: 'World #1', next: 'Next to beat', mine: 'My best', off: 'Off' };
const SLOT_COLOR: Record<GhostSlot, string> = { world: '#b45309', next: '#2563eb', mine: '#475569' };

export interface LocalGhost {
  rev: number;
  time: number;
  stars: number;
  strikes: number;
  track: string;
  /** True once the lobby accepted this run. */
  submitted: boolean;
}
export type LocalGhosts = Record<string, LocalGhost>;

export function loadLocalGhosts(storage: StorageLike | null): LocalGhosts {
  try {
    const raw = storage?.getItem(GHOST_STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as LocalGhosts) : {};
  } catch {
    return {};
  }
}

function saveLocalGhosts(storage: StorageLike | null, all: LocalGhosts): void {
  try {
    storage?.setItem(GHOST_STORE_KEY, JSON.stringify(all));
  } catch {
    // Private mode / quota: the ghost just isn't kept this session.
  }
}

/** The player's local best for the level's current rules revision, or null. */
export function localBest(storage: StorageLike | null, level: TrialLevel): LocalGhost | null {
  const g = loadLocalGhosts(storage)[level.id];
  return g && g.rev === trialRev(level) && typeof g.track === 'string' && Number.isFinite(g.time) ? g : null;
}

/**
 * Keeps `run` as the local best when it is faster than the stored one (or the stored one is for
 * an older rules revision). Returns true when it replaced the stored best.
 */
export function saveLocalBest(storage: StorageLike | null, level: TrialLevel, run: GhostRun): boolean {
  const all = loadLocalGhosts(storage);
  const prev = localBest(storage, level);
  if (prev && prev.time <= run.time) return false;
  all[level.id] = { rev: run.rev, time: run.time, stars: run.stars, strikes: run.strikes, track: run.track, submitted: false };
  saveLocalGhosts(storage, all);
  return true;
}

function markSubmitted(storage: StorageLike | null, levelId: string, track: string): void {
  const all = loadLocalGhosts(storage);
  const g = all[levelId];
  if (g && g.track === track) {
    g.submitted = true;
    saveLocalGhosts(storage, all);
  }
}

export function loadGhostMode(storage: StorageLike | null): GhostMode {
  try {
    const m = storage?.getItem(GHOST_MODE_KEY);
    return (GHOST_MODES as readonly string[]).includes(m ?? '') ? (m as GhostMode) : 'world';
  } catch {
    return 'world';
  }
}

/** Reads (or mints, like the live game) the browser's raw clientId. */
export function trialClientId(storage: StorageLike | null): string | null {
  try {
    const existing = storage?.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    if (!storage || typeof crypto === 'undefined' || !crypto.randomUUID) return null;
    const id = crypto.randomUUID();
    storage.setItem(CLIENT_ID_KEY, id);
    return id;
  } catch {
    return null;
  }
}

export interface ShownGhost {
  slot: GhostSlot;
  name: string;
  time: number;
  track: GhostTrack;
  /** Encoded track: identical runs collapse into one ghost. */
  key: string;
}

function decodeSafe(encoded: string): GhostTrack | null {
  try {
    return decodeGhost(encoded);
  } catch {
    return null;
  }
}

/**
 * The ghosts to draw, in slot order, without duplicates. When a shared ghost is your own run
 * (you hold World #1) it is labelled "You" and also serves as My best.
 */
export function pickGhosts(board: TrialGhostsResponse | null, mine: LocalGhost | null): ShownGhost[] {
  const out: ShownGhost[] = [];
  const add = (slot: GhostSlot, name: string, time: number, encoded: string) => {
    if (out.some((g) => g.key === encoded)) return;
    const track = decodeSafe(encoded);
    if (track) out.push({ slot, name: mine && encoded === mine.track ? 'You' : name, time, track, key: encoded });
  };
  const top = board?.top[0];
  if (top) add('world', top.name, top.time, top.track);
  if (board?.next) add('next', board.next.name, board.next.time, board.next.track);
  if (mine) add('mine', 'You', mine.time, mine.track);
  return out;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; reason?: string };
    return body.message ? `${body.message}${body.reason ? ` (${body.reason})` : ''}` : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function fetchTrialGhosts(
  fetchFn: FetchLike,
  levelId: string,
  myTime: number | null,
): Promise<{ ok: true; data: TrialGhostsResponse } | { ok: false; error: string }> {
  try {
    const q = myTime != null ? `?time=${encodeURIComponent(myTime.toFixed(1))}` : '';
    const res = await fetchFn(`/api/trials/${encodeURIComponent(levelId)}/ghosts${q}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, error: await readError(res) };
    const parsed = TrialGhostsResponseSchema.safeParse(await res.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: 'Unexpected ghost data from the server.' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function submitTrialRun(
  fetchFn: FetchLike,
  clientId: string,
  run: GhostRun,
): Promise<{ ok: true; data: TrialRunSubmitResponse } | { ok: false; error: string }> {
  try {
    const res = await fetchFn(`/api/trials/${encodeURIComponent(run.levelId)}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, rev: run.rev, time: run.time, stars: run.stars, strikes: run.strikes, track: run.track }),
    });
    if (!res.ok) return { ok: false, error: await readError(res) };
    const parsed = TrialRunSubmitResponseSchema.safeParse(await res.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: 'Unexpected reply from the server.' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
}

/** Faint floor trail of a ghost's whole run, brighter for the next 3 s, with pick / drop / stow stops. */
export function drawGhostTrail(pt: Painter, g: ShownGhost, t: number, dim = 1): void {
  const ctx = pt.ctx;
  const tk = g.track;
  const n = tk.x.length;
  if (n < 2) return;
  const color = SLOT_COLOR[g.slot];
  const z = pt.cam.zoom;
  /** Track point at fractional sample index `f` (linear, like `sampleGhost`). */
  const at = (f: number): [number, number] => {
    const i = Math.max(0, Math.min(n - 1, Math.floor(f)));
    const j = Math.min(n - 1, i + 1);
    const u = Math.max(0, Math.min(1, f - i));
    return pt.P(tk.x[i] + (tk.x[j] - tk.x[i]) * u, tk.y[i] + (tk.y[j] - tk.y[i]) * u);
  };
  // Polyline from fractional index `from` to `to`: exact interpolated end points, and only the
  // even-indexed samples in between (fixed parity), so the bright head tracks the smoothly lerped
  // ghost truck instead of stepping at 10 Hz, and the line no longer swaps between odd and even
  // samples every 100 ms (which made it wobble on curves).
  const stroke = (from: number, to: number, alpha: number, width: number) => {
    if (to - from < 0.05) return;
    ctx.beginPath();
    const [x0, y0] = at(from);
    ctx.moveTo(x0, y0);
    let i = Math.floor(from) + 1;
    if (i & 1) i++;
    for (; i < to; i += 2) {
      const [sx, sy] = pt.P(tk.x[i], tk.y[i]);
      ctx.lineTo(sx, sy);
    }
    const [x1, y1] = at(to);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = rgba(color, alpha);
    ctx.lineWidth = width;
    ctx.stroke();
  };
  ctx.save();
  ctx.globalAlpha *= dim;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  stroke(0, n - 1, 0.22, Math.max(2, 3 * z));
  const f0 = Math.max(0, Math.min(n - 1, t / 0.1));
  stroke(f0, Math.min(n - 1, f0 + 30), 0.5, Math.max(2.5, 4 * z));
  for (const e of tk.events) {
    if (e.kind !== 'pick' && e.kind !== 'drop' && e.kind !== 'stow') continue;
    const ring = pt.circleGrid(tk.x[e.i], tk.y[e.i], 0.2, 16);
    pt.poly(ring, e.kind === 'pick' ? rgba(color, 0.45) : null, rgba(color, 0.7), Math.max(1.5, 2 * z));
  }
  ctx.restore();
}

/** One translucent ghost truck (body, mast, forks and its carried stack) plus its label. */
export function drawGhostTruck(
  pt: Painter,
  g: ShownGhost,
  t: number,
  selected: boolean,
  reducedMotion: boolean,
  dim = 1,
): void {
  const p = sampleGhost(g.track, t);
  const ctx = pt.ctx;
  const color = SLOT_COLOR[g.slot];
  const ca = Math.cos(p.a);
  const sa = Math.sin(p.a);
  ctx.save();
  ctx.globalAlpha = (selected ? 0.5 : 0.3) * (p.done ? 0.6 : 1) * dim;
  pt.footprintShadow(p.x, p.y, 0.95, 0.6, p.a, 0.12);
  pt.oBox(p.x - ca * 0.1, p.y - sa * 0.1, 0.62, 0.5, p.a, 0, 9, color, 'rgba(255,255,255,0.6)');
  pt.oBox(p.x + ca * 0.25, p.y + sa * 0.25, 0.07, 0.46, p.a, 0, 22, color);
  const forkZ = isoZ(forkHeightM(p.fork));
  pt.oBox(p.x + ca * 0.5, p.y + sa * 0.5, 0.36, 0.32, p.a, forkZ, 1.5, color);
  for (let k = 0; k < p.stack; k++) {
    const lat = reducedMotion ? 0 : p.sway * 0.05 * (k + 1);
    pt.oBox(p.x + ca * 0.56 - sa * lat, p.y + sa * 0.56 + ca * lat, 0.42, 0.4, p.a, forkZ + 2 + k * 13, 11, '#D9B98A');
  }
  ctx.restore();
  const [sx, sy] = pt.P(p.x, p.y, 34 + Math.max(0, p.stack - 1) * 13);
  ctx.save();
  ctx.globalAlpha = (selected ? 0.95 : 0.7) * dim;
  pt.pill(`${g.name} · ${g.time.toFixed(1)}s`, sx, sy - 12, rgba(color, 0.9));
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------
// Controller (recording, persistence, network and the small selector panel)
// ---------------------------------------------------------------------------------------------

export interface TrialGhostsOptions {
  /** Element the selector panel is appended to (the trial stage). */
  stage: HTMLElement;
  storage: StorageLike | null;
  reducedMotion: () => boolean;
  fetchFn?: FetchLike;
}

type BoardState = { kind: 'loading' } | { kind: 'ok'; data: TrialGhostsResponse } | { kind: 'error'; message: string };

export class TrialGhosts {
  private rec: GhostRecorder | null = null;
  private level: TrialLevel | null = null;
  private board: BoardState = { kind: 'loading' };
  private shown: ShownGhost[] = [];
  private mode: GhostMode;
  private note = '';
  private loadSeq = 0;
  private readonly fetchFn: FetchLike;
  private readonly panel: HTMLDivElement;
  private readonly buttons = new Map<GhostMode, HTMLButtonElement>();
  private readonly status: HTMLDivElement;

  constructor(private readonly opts: TrialGhostsOptions) {
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.mode = loadGhostMode(opts.storage);
    this.panel = document.createElement('div');
    this.panel.className = 'tr-ghosts';
    this.panel.setAttribute('role', 'group');
    this.panel.setAttribute('aria-label', 'Ghost runs');
    const label = document.createElement('span');
    label.className = 'tr-ghosts__label';
    label.textContent = 'GHOST';
    label.title = 'Press G to cycle';
    const seg = document.createElement('div');
    seg.className = 'tr-ghosts__seg';
    for (const m of GHOST_MODES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = MODE_LABEL[m];
      b.addEventListener('click', () => this.setMode(m));
      this.buttons.set(m, b);
      seg.appendChild(b);
    }
    this.status = document.createElement('div');
    this.status.className = 'tr-ghosts__status';
    this.status.setAttribute('aria-live', 'polite');
    this.panel.append(label, seg, this.status);
    opts.stage.appendChild(this.panel);
    this.renderPanel();
  }

  /** New attempt: start recording and (re)load the level's ghosts. */
  startLevel(tr: Trial, fallbackBest: number | null): void {
    this.rec = createGhostRecorder(tr);
    const sameLevel = this.level?.id === tr.level.id;
    this.level = tr.level;
    if (!sameLevel) {
      this.note = '';
      this.board = { kind: 'loading' };
      this.refreshShown();
      void this.load(fallbackBest);
      void this.resubmitPending();
    }
  }

  /** Fold the trial's state into the recording (after every step and interaction). */
  record(tr: Trial): void {
    if (this.rec) recordGhost(this.rec, tr);
  }

  /** On a win: keep the run locally if it is your fastest and share it. */
  finish(tr: Trial): void {
    const rec = this.rec;
    this.rec = null;
    if (!rec || tr.state.status !== 'won') return;
    const run: GhostRun = {
      levelId: tr.level.id,
      rev: trialRev(tr.level),
      time: tr.state.t,
      stars: tr.state.stars,
      strikes: tr.state.strikes,
      track: encodeGhost(rec.track),
    };
    const verdict = validateGhostRun(run);
    if (!verdict.ok) {
      // Should never happen for a real run; surface it rather than posting a bad ghost.
      this.note = `Run not shareable (${verdict.reason}).`;
      this.renderPanel();
      return;
    }
    if (!saveLocalBest(this.opts.storage, tr.level, run)) return;
    this.refreshShown();
    void this.share(run);
  }

  cycle(): void {
    const i = GHOST_MODES.indexOf(this.mode);
    this.setMode(GHOST_MODES[(i + 1) % GHOST_MODES.length]);
  }

  /** Selected ghost's floor trail; `dim` scales opacity (e.g. over Lights Out fog). */
  drawFloor(pt: Painter, t: number, dim = 1): void {
    const sel = this.selected();
    if (sel) drawGhostTrail(pt, sel, t, dim);
  }

  draw(pt: Painter, t: number, dim = 1): void {
    if (this.mode === 'off') return;
    const sel = this.selected();
    for (const g of this.shown) if (g !== sel) drawGhostTruck(pt, g, t, false, this.opts.reducedMotion(), dim);
    if (sel) drawGhostTruck(pt, sel, t, true, this.opts.reducedMotion(), dim);
  }

  private selected(): ShownGhost | null {
    return this.slotGhost(this.mode);
  }

  private slotGhost(m: GhostMode): ShownGhost | null {
    if (m === 'off') return null;
    const direct = this.shown.find((g) => g.slot === m);
    if (direct || m !== 'mine') return direct ?? null;
    // Your best may already be on screen as a shared ghost (e.g. you hold World #1).
    return this.shown.find((g) => g.name === 'You') ?? null;
  }

  private setMode(m: GhostMode): void {
    this.mode = m;
    try {
      this.opts.storage?.setItem(GHOST_MODE_KEY, m);
    } catch {
      // not persisted
    }
    this.renderPanel();
  }

  private refreshShown(): void {
    const mine = this.level ? localBest(this.opts.storage, this.level) : null;
    this.shown = pickGhosts(this.board.kind === 'ok' ? this.board.data : null, mine);
    this.renderPanel();
  }

  private async load(fallbackBest: number | null): Promise<void> {
    const level = this.level;
    if (!level) return;
    const seq = ++this.loadSeq;
    const mine = localBest(this.opts.storage, level);
    const myTime = mine?.time ?? fallbackBest;
    const res = await fetchTrialGhosts(this.fetchFn, level.id, myTime);
    if (seq !== this.loadSeq) return;
    this.board = res.ok ? { kind: 'ok', data: res.data } : { kind: 'error', message: res.error };
    this.refreshShown();
  }

  private async share(run: GhostRun): Promise<void> {
    const clientId = trialClientId(this.opts.storage);
    if (!clientId) {
      this.note = 'Saved locally (no player id to share with).';
      this.renderPanel();
      return;
    }
    const res = await submitTrialRun(this.fetchFn, clientId, run);
    if (!res.ok) {
      this.note = `Saved locally; sharing failed: ${res.error}`;
    } else {
      markSubmitted(this.opts.storage, run.levelId, run.track);
      this.note = res.data.improved ? `Shared · world #${res.data.rank} of ${res.data.total}` : '';
    }
    if (this.level?.id === run.levelId) await this.load(run.time);
    this.renderPanel();
  }

  /** A best that never reached the lobby (offline at the time) is retried on the next visit. */
  private async resubmitPending(): Promise<void> {
    const level = this.level;
    if (!level) return;
    const mine = localBest(this.opts.storage, level);
    if (!mine || mine.submitted) return;
    const run: GhostRun = { levelId: level.id, rev: mine.rev, time: mine.time, stars: mine.stars, strikes: mine.strikes, track: mine.track };
    if (!validateGhostRun(run).ok) return;
    await this.share(run);
  }

  private renderPanel(): void {
    for (const [m, b] of this.buttons) {
      b.setAttribute('aria-pressed', String(m === this.mode));
      const has = m === 'off' || this.slotGhost(m) !== null;
      b.dataset.empty = String(!has);
    }
    let text = '';
    const sel = this.selected();
    if (this.mode === 'off') text = 'Ghosts hidden.';
    else if (this.board.kind === 'loading') text = 'Loading ghosts…';
    else if (sel) text = `${MODE_LABEL[this.mode]}: ${sel.name} · ${sel.time.toFixed(1)}s`;
    else if (this.mode === 'mine') text = 'No best run yet. Clear the level to record one.';
    else if (this.board.kind === 'error') text = `Shared ghosts unavailable: ${this.board.message}`;
    else if (this.mode === 'next') text = this.shown.some((g) => g.slot === 'mine') ? "You're the fastest. Nobody to chase." : 'Clear the level first.';
    else text = 'No shared runs yet. Be the first.';
    this.status.textContent = this.note ? `${text}\n${this.note}` : text;
    this.status.dataset.error = String(this.board.kind === 'error' && this.mode !== 'off' && this.mode !== 'mine');
  }
}
