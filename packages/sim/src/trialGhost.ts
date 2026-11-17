/**
 * Floor Trials ghost runs: record a run's trajectory every sim tick, pack it into a compact
 * base64url string, sample it back for rendering, and check a submitted run for plausibility.
 *
 * Ghosts store the *trajectory* (pose, forks, stack, sway, pick/drop/topple markers), not the
 * inputs: replaying inputs would depend on bit-identical float maths across browsers, while a
 * recorded trajectory always draws exactly what the original driver saw.
 *
 * Wire format (`TRIAL_GHOST_FORMAT` = 1), little-endian bytes, base64url without padding:
 *
 * ```
 * u8      format (1)
 * varint  n            sample count (sample i is the state at level time i × 0.1)
 * varint  x0, y0       first sample, quantized (1/64 tile)
 * u8      a0           heading, 256 steps per turn
 * u8      fork0        fork height 0..1 → 0..63
 * zigzag  sway0        load sway −1..1 → 1/32 steps
 * u8      stack0
 * u8      k0, k0 × u8 event   events on sample 0 (e.g. a pick before the first tick)
 * then n−1 records:
 *   zigzag dx, dy      position delta (1/64 tile)
 *   zigzag da          heading delta, wrapped to −128..127
 *   u8     aux         bit0 fork, bit1 sway, bit2 stack, bit3 events follow
 *   [zigzag dFork] [zigzag dSway] [u8 stack] [u8 k, k × u8 event]
 * event byte: low 3 bits kind (1 pick, 2 drop, 3 topple, 4 crash, 5 rack fall, 6 stow,
 *             7 traffic); high 5 bits = pallets delivered (drop / stow). Low bits 0 escape to
 *             an extended kind in the high 5 bits (1 glass shatter, 2 charge stop).
 * ```
 *
 * Events that happen at level time t (a pick between two ticks) attach to sample round(t × 10).
 * A 90 s run is ~900 samples at ~4–5 bytes each, i.e. ~5–6 KB of base64.
 */
import { TRIAL_GHOST_TRACK_MAX_CHARS } from '@warehouse/protocol';
import { windowState } from './trialMechanics.js';
import { createTrial, starsFor, TRIAL_LIFT_SPEED, TRIAL_MAX_STRIKES, trialDropTargets, trialLevel } from './trials.js';
import type { Trial, TrialEventKind, TrialLevel } from './trials.js';

export const TRIAL_GHOST_FORMAT = 1;
/** Sim tick (game-min) between samples: the fixed 10 Hz trial step. */
export const TRIAL_GHOST_DT = 0.1;
/** Longest run a ghost may cover (seconds of level time). */
export const TRIAL_GHOST_MAX_TIME = 600;
/** Hard cap on the encoded track length (base64url chars). */
export const TRIAL_GHOST_MAX_CHARS = TRIAL_GHOST_TRACK_MAX_CHARS;
/**
 * Max truck travel per tick (tiles): boost top speed is 3.15 × 2.2 × 1.35 ≈ 9.36 tiles/min
 * (0.94 tiles per tick); the extra covers quantization and wall-slide nudges.
 */
export const TRIAL_GHOST_MAX_STEP = 1.05;
/** A run faster than this fraction of par is rejected as implausible. */
export const TRIAL_GHOST_MIN_PAR_FRAC = 0.4;

const POS_Q = 64;
const ANG_Q = 256;
const FORK_Q = 63;
const SWAY_Q = 32;

export type GhostEventKind =
  | 'pick'
  | 'drop'
  | 'stow'
  | 'topple'
  | 'crash'
  | 'rack_fall'
  | 'traffic'
  | 'shatter'
  | 'charge';
/**
 * Event byte: low 3 bits are the kind (1–7); 0 escapes to an extended kind in the high 5 bits.
 * For drop / stow the high 5 bits carry the pallets delivered instead.
 */
const EVENT_CODES: Partial<Record<GhostEventKind, number>> = { pick: 1, drop: 2, topple: 3, crash: 4, rack_fall: 5, stow: 6, traffic: 7 };
const EVENT_KINDS: Array<GhostEventKind | null> = [null, 'pick', 'drop', 'topple', 'crash', 'rack_fall', 'stow', 'traffic'];
/** Extended kinds (escape code 0): failures and markers that carry no count. */
const EXT_EVENT_CODES: Partial<Record<GhostEventKind, number>> = { shatter: 1, charge: 2 };
const EXT_EVENT_KINDS: Array<GhostEventKind | null> = [null, 'shatter', 'charge'];
/** Ghost events that count as strikes (`strike()` in trials.ts). */
export const GHOST_STRIKE_KINDS: ReadonlySet<GhostEventKind> = new Set(['topple', 'crash', 'rack_fall', 'traffic']);
const isDelivery = (k: GhostEventKind): boolean => k === 'drop' || k === 'stow';

function eventByte(e: GhostEvent): number {
  const code = EVENT_CODES[e.kind];
  if (code != null) return code | (isDelivery(e.kind) ? Math.min(31, e.n ?? 0) << 3 : 0);
  return (EXT_EVENT_CODES[e.kind] ?? 0) << 3;
}

export interface GhostEvent {
  /** Sample index (level time = i × 0.1). */
  i: number;
  kind: GhostEventKind;
  /** Pallets delivered by a drop or stow. */
  n?: number;
}

/** One decoded (or recorded) trajectory, column-wise. Sample i is level time i × 0.1. */
export interface GhostTrack {
  x: number[];
  y: number[];
  a: number[];
  fork: number[];
  sway: number[];
  stack: number[];
  events: GhostEvent[];
}

/** Interpolated ghost pose at a level time. */
export interface GhostPose {
  x: number;
  y: number;
  a: number;
  fork: number;
  sway: number;
  stack: number;
  /** True once `t` is past the last sample (the ghost has finished its run). */
  done: boolean;
}

/** A shareable run: what the client submits and the lobby serves back. */
export interface GhostRun {
  levelId: string;
  rev: number;
  /** Level time (s / game-min) of the finished run. */
  time: number;
  stars: number;
  strikes: number;
  /** `encodeGhost` output. */
  track: string;
}

/** Rules revision of a level (default 1); ghosts only race ghosts of the same revision. */
export function trialRev(level: TrialLevel): number {
  return level.rev ?? 1;
}

/** Sample count of a run that took `time` seconds (sample 0 is the start pose). */
export function ghostSampleCount(time: number): number {
  return Math.round(time / TRIAL_GHOST_DT) + 1;
}

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

export interface GhostRecorder {
  track: GhostTrack;
  /** Last trial event sequence number already folded into the track. */
  seenSeq: number;
  /** `state.delivered` already attributed to drop / stow events. */
  delivered: number;
  /** Whether the truck was charging at the last record (a new charge stop is a marker). */
  charging: boolean;
}

const GHOST_EVENT_FROM_TRIAL: Partial<Record<TrialEventKind, GhostEventKind>> = {
  pick: 'pick',
  drop: 'drop',
  stow: 'stow',
  topple: 'topple',
  crash: 'crash',
  rack_fall: 'rack_fall',
  traffic: 'traffic',
  shatter: 'shatter',
};

function snapshotInto(track: GhostTrack, i: number, tr: Trial): void {
  const v = tr.vehicle;
  track.x[i] = v.px;
  track.y[i] = v.py;
  track.a[i] = v.angle;
  track.fork[i] = Number.isFinite(v.fork) ? v.fork : 0;
  track.sway[i] = tr.state.sway;
  track.stack[i] = v.cargo.length;
}

/** Starts a recording at the trial's current (start) state. */
export function createGhostRecorder(tr: Trial): GhostRecorder {
  const rec: GhostRecorder = {
    track: { x: [], y: [], a: [], fork: [], sway: [], stack: [], events: [] },
    seenSeq: tr.state.eventSeq,
    delivered: tr.state.delivered,
    charging: Boolean(tr.state.charging),
  };
  snapshotInto(rec.track, 0, tr);
  return rec;
}

/**
 * Folds the trial's current state into the recording. Call after every `stepTrial` and after
 * every `trialInteract`; it is idempotent within a tick (an interaction between two ticks just
 * refreshes the current sample's stack and adds its event).
 */
export function recordGhost(rec: GhostRecorder, tr: Trial): void {
  const i = Math.round(tr.state.t / TRIAL_GHOST_DT);
  const tk = rec.track;
  // Fill any skipped ticks with the previous pose (never happens with one call per step).
  for (let k = tk.x.length; k < i; k++) {
    tk.x[k] = tk.x[k - 1];
    tk.y[k] = tk.y[k - 1];
    tk.a[k] = tk.a[k - 1];
    tk.fork[k] = tk.fork[k - 1];
    tk.sway[k] = tk.sway[k - 1];
    tk.stack[k] = tk.stack[k - 1];
  }
  snapshotInto(tk, i, tr);
  for (const ev of tr.state.events) {
    if (ev.seq <= rec.seenSeq) continue;
    rec.seenSeq = ev.seq;
    const kind = GHOST_EVENT_FROM_TRIAL[ev.kind];
    if (!kind) continue;
    const e: GhostEvent = { i: Math.round(ev.t / TRIAL_GHOST_DT), kind };
    if (isDelivery(kind)) {
      // Structured count: the delivered tally moved by exactly this drop / stow.
      e.n = tr.state.delivered - rec.delivered;
      rec.delivered = tr.state.delivered;
    }
    tk.events.push(e);
  }
  const charging = Boolean(tr.state.charging);
  if (charging && !rec.charging) tk.events.push({ i, kind: 'charge' });
  rec.charging = charging;
}

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

function toBase64Url(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

function fromBase64Url(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new Error('bad base64 length');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    const chunk = Math.min(4, s.length - i);
    for (let k = 0; k < 4; k++) {
      let v = 0;
      if (k < chunk) {
        const c = s.charCodeAt(i + k);
        v = c < 128 ? B64_INV[c] : -1;
        if (v < 0) throw new Error('bad base64 char');
      }
      n = (n << 6) | v;
    }
    out[o++] = (n >> 16) & 255;
    if (chunk > 2) out[o++] = (n >> 8) & 255;
    if (chunk > 3) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

const zig = (v: number): number => (v >= 0 ? v * 2 : -v * 2 - 1);
const unzig = (u: number): number => (u & 1 ? -(u + 1) / 2 : u / 2);

function pushVar(out: number[], u: number): void {
  let v = u;
  while (v >= 128) {
    out.push((v & 127) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

const qPos = (v: number): number => Math.max(0, Math.round(v * POS_Q));
const qAng = (a: number): number => {
  const t = a / (2 * Math.PI);
  return (((Math.round((t - Math.floor(t)) * ANG_Q)) % ANG_Q) + ANG_Q) % ANG_Q;
};
const qFork = (f: number): number => Math.max(0, Math.min(FORK_Q, Math.round(f * FORK_Q)));
const qSway = (s: number): number => Math.max(-48, Math.min(48, Math.round(s * SWAY_Q)));
const qStack = (n: number): number => Math.max(0, Math.min(7, Math.round(n)));

/** Packs a recorded track into the compact base64url wire string. */
export function encodeGhost(track: GhostTrack): string {
  const n = track.x.length;
  if (n < 1) throw new Error('empty ghost track');
  const out: number[] = [TRIAL_GHOST_FORMAT];
  pushVar(out, n);
  let px = qPos(track.x[0]);
  let py = qPos(track.y[0]);
  let pa = qAng(track.a[0]);
  let pf = qFork(track.fork[0]);
  let ps = qSway(track.sway[0]);
  let pk = qStack(track.stack[0]);
  pushVar(out, px);
  pushVar(out, py);
  out.push(pa, pf);
  pushVar(out, zig(ps));
  out.push(pk);
  const byIndex = new Map<number, GhostEvent[]>();
  for (const e of track.events) {
    const i = Math.max(0, Math.min(n - 1, e.i));
    const list = byIndex.get(i) ?? [];
    list.push(e);
    byIndex.set(i, list);
  }
  const pushEvents = (evs: GhostEvent[]) => {
    const list = evs.slice(0, 255);
    out.push(list.length);
    for (const e of list) out.push(eventByte(e));
  };
  pushEvents(byIndex.get(0) ?? []);
  for (let i = 1; i < n; i++) {
    const x = qPos(track.x[i]);
    const y = qPos(track.y[i]);
    const a = qAng(track.a[i]);
    const f = qFork(track.fork[i]);
    const s = qSway(track.sway[i]);
    const k = qStack(track.stack[i]);
    pushVar(out, zig(x - px));
    pushVar(out, zig(y - py));
    pushVar(out, zig(((a - pa + ANG_Q * 1.5) % ANG_Q) - ANG_Q / 2));
    const evs = byIndex.get(i) ?? [];
    const aux = (f !== pf ? 1 : 0) | (s !== ps ? 2 : 0) | (k !== pk ? 4 : 0) | (evs.length ? 8 : 0);
    out.push(aux);
    if (aux & 1) pushVar(out, zig(f - pf));
    if (aux & 2) pushVar(out, zig(s - ps));
    if (aux & 4) out.push(k);
    if (aux & 8) pushEvents(evs);
    px = x;
    py = y;
    pa = a;
    pf = f;
    ps = s;
    pk = k;
  }
  return toBase64Url(out);
}

/**
 * Unpacks a wire string. Throws on malformed input (bad base64, unknown format, truncation,
 * trailing bytes or more than `maxSamples` samples).
 */
export function decodeGhost(encoded: string, maxSamples = ghostSampleCount(TRIAL_GHOST_MAX_TIME)): GhostTrack {
  if (typeof encoded !== 'string' || encoded.length > TRIAL_GHOST_MAX_CHARS) throw new Error('ghost too large');
  const b = fromBase64Url(encoded);
  let p = 0;
  const u8 = (): number => {
    if (p >= b.length) throw new Error('ghost truncated');
    return b[p++];
  };
  const varint = (): number => {
    let v = 0;
    let mul = 1;
    for (let k = 0; k < 5; k++) {
      const c = u8();
      v += (c & 127) * mul;
      if (c < 128) return v;
      mul *= 128;
    }
    throw new Error('ghost varint overflow');
  };
  if (u8() !== TRIAL_GHOST_FORMAT) throw new Error('unknown ghost format');
  const n = varint();
  if (n < 1 || n > maxSamples) throw new Error('ghost sample count out of range');
  const tk: GhostTrack = { x: [], y: [], a: [], fork: [], sway: [], stack: [], events: [] };
  let x = varint();
  let y = varint();
  let a = u8();
  let f = u8();
  let s = unzig(varint());
  let k = u8();
  const put = (i: number) => {
    tk.x[i] = x / POS_Q;
    tk.y[i] = y / POS_Q;
    tk.a[i] = ((a > ANG_Q / 2 ? a - ANG_Q : a) / ANG_Q) * 2 * Math.PI;
    tk.fork[i] = f / FORK_Q;
    tk.sway[i] = s / SWAY_Q;
    tk.stack[i] = k;
  };
  const readEvents = (i: number) => {
    const m = u8();
    for (let e = 0; e < m; e++) {
      const c = u8();
      const kind = c & 7 ? EVENT_KINDS[c & 7] : (EXT_EVENT_KINDS[c >> 3] ?? null);
      if (!kind) throw new Error('bad ghost event');
      const ev: GhostEvent = { i, kind };
      if (isDelivery(kind)) ev.n = c >> 3;
      tk.events.push(ev);
    }
  };
  put(0);
  readEvents(0);
  for (let i = 1; i < n; i++) {
    x += unzig(varint());
    y += unzig(varint());
    a = (((a + unzig(varint())) % ANG_Q) + ANG_Q) % ANG_Q;
    const aux = u8();
    if (aux & ~15) throw new Error('bad ghost aux');
    if (aux & 1) f += unzig(varint());
    if (aux & 2) s += unzig(varint());
    if (aux & 4) k = u8();
    if (aux & 8) readEvents(i);
    put(i);
  }
  if (p !== b.length) throw new Error('ghost has trailing bytes');
  return tk;
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Ghost pose at level time `t` (linear between samples, shortest-arc heading). */
export function sampleGhost(track: GhostTrack, t: number): GhostPose {
  const n = track.x.length;
  const f = Math.max(0, t / TRIAL_GHOST_DT);
  const i = Math.min(n - 1, Math.floor(f));
  const j = Math.min(n - 1, i + 1);
  const u = i === j ? 0 : f - i;
  const lerp = (arr: number[]) => arr[i] + (arr[j] - arr[i]) * u;
  return {
    x: lerp(track.x),
    y: lerp(track.y),
    a: wrap(track.a[i] + wrap(track.a[j] - track.a[i]) * u),
    fork: lerp(track.fork),
    sway: lerp(track.sway),
    stack: track.stack[i],
    done: f > n - 1,
  };
}

// ---------------------------------------------------------------------------------------------
// Plausibility validation (shared by the client before submitting and the lobby on receipt)
// ---------------------------------------------------------------------------------------------

export type GhostValidation = { ok: true; track: GhostTrack } | { ok: false; reason: string };

interface LevelFacts {
  level: TrialLevel;
  par: number;
  /** Valid drop tiles (centres) from `trialDropTargets`: bay tiles and putaway access tiles. */
  targets: Array<{ x: number; y: number; kind: 'bay' | 'stow'; id: string; reach: number }>;
}

const factsCache = new Map<string, LevelFacts>();

function levelFacts(levelId: string): LevelFacts | null {
  const level = trialLevel(levelId);
  if (!level) return null;
  const hit = factsCache.get(levelId);
  if (hit && hit.level === level) return hit;
  const tr = createTrial(levelId);
  const targets = trialDropTargets(level).map((t) => ({ ...t, x: t.x + 0.5, y: t.y + 0.5 }));
  const facts: LevelFacts = { level, par: tr.state.par, targets };
  factsCache.set(levelId, facts);
  return facts;
}

/** Par time for a level (cached; same value the trial HUD shows). */
export function ghostLevelPar(levelId: string): number | null {
  return levelFacts(levelId)?.par ?? null;
}

const fail = (reason: string): GhostValidation => ({ ok: false, reason });

/**
 * Plausibility check for a submitted winning run. It cannot prove a run was driven by hand, but
 * it rejects anything the trial rules could not have produced:
 * - the level exists and `rev` matches its current rules revision;
 * - the track decodes, has exactly round(time × 10) + 1 samples (10 Hz) and time is within
 *   [TRIAL_GHOST_MIN_PAR_FRAC × par, TRIAL_GHOST_MAX_TIME];
 * - sample 0 is the level's start pose;
 * - no tick moves the truck further than TRIAL_GHOST_MAX_STEP tiles;
 * - stack never exceeds the level's `stackMax`; picks, drops and stows happen near standstill;
 * - every drop is within reach of one of the level's bays (`trialDropTargets`) whose dock window
 *   (if any) is open at that moment, and every stow is within reach of a putaway slot;
 * - delivered pallets (sum of drop + stow counts) equal the level's pallet total, the last
 *   delivery is on the last sample, no glass shattered, and strikes (topple, crash, rack fall,
 *   traffic: `GHOST_STRIKE_KINDS`) match the reported strikes;
 * - `stars` equals `starsFor(time, par, strikes)`.
 */
export function validateGhostRun(run: GhostRun): GhostValidation {
  const facts = levelFacts(run.levelId);
  if (!facts) return fail('unknown_level');
  const { level, par } = facts;
  if (run.rev !== trialRev(level)) return fail('stale_rev');
  if (!Number.isFinite(run.time) || run.time <= 0 || run.time > TRIAL_GHOST_MAX_TIME) return fail('bad_time');
  if (Math.abs(run.time * 10 - Math.round(run.time * 10)) > 1e-6) return fail('bad_time');
  if (run.time < par * TRIAL_GHOST_MIN_PAR_FRAC) return fail('too_fast');
  if (!Number.isInteger(run.strikes) || run.strikes < 0 || run.strikes >= TRIAL_MAX_STRIKES) return fail('bad_strikes');
  if (run.stars !== starsFor(run.time, par, run.strikes)) return fail('bad_stars');
  let track: GhostTrack;
  try {
    track = decodeGhost(run.track);
  } catch {
    return fail('bad_track');
  }
  const n = track.x.length;
  if (n !== ghostSampleCount(run.time)) return fail('sample_count');
  const sx = level.start.x + 0.5;
  const sy = level.start.y + 0.5;
  if (Math.hypot(track.x[0] - sx, track.y[0] - sy) > 0.05) return fail('bad_start');
  if (Math.abs(wrap(track.a[0] - level.start.angle)) > (2 * Math.PI) / ANG_Q) return fail('bad_start');
  if (track.stack[0] !== 0 && !track.events.some((e) => e.kind === 'pick' && e.i <= 1)) return fail('bad_start');
  const step = (i: number) => (i <= 0 ? 0 : Math.hypot(track.x[i] - track.x[i - 1], track.y[i] - track.y[i - 1]));
  for (let i = 1; i < n; i++) {
    if (step(i) > TRIAL_GHOST_MAX_STEP) return fail('too_fast_step');
    if (track.stack[i] > level.stackMax) return fail('stack_overflow');
  }
  // A pick/drop needs |speed| < TRIAL_LIFT_SPEED; allow one quantum of slack on the tick before.
  const liftStep = TRIAL_LIFT_SPEED * TRIAL_GHOST_DT + 2 / POS_Q;
  let delivered = 0;
  let strikes = 0;
  let lastDrop = -1;
  const isOpen = (bayId: string, t: number) =>
    [t, t - 1e-6, t + 1e-6].some((u) => windowState(level.windows, bayId, u)?.open ?? true);
  for (const e of track.events) {
    if (e.kind === 'pick' || isDelivery(e.kind)) {
      // Events attach to the first record after the interaction, so check that tick's motion.
      const moving = Math.min(step(e.i), step(e.i + 1 < n ? e.i + 1 : e.i));
      if (moving > liftStep) return fail('moving_lift');
    }
    if (isDelivery(e.kind)) {
      const at = { x: track.x[e.i], y: track.y[e.i] };
      const want = e.kind === 'drop' ? 'bay' : 'stow';
      const inReach = facts.targets.filter(
        (t) => t.kind === want && Math.hypot(at.x - t.x, at.y - t.y) <= t.reach + 0.1,
      );
      if (!inReach.length) return fail(e.kind === 'drop' ? 'drop_off_bay' : 'stow_off_slot');
      if (e.kind === 'drop' && !inReach.some((t) => isOpen(t.id, e.i * TRIAL_GHOST_DT))) return fail('dock_closed');
      if (!e.n || e.n < 1) return fail('empty_delivery');
      delivered += e.n;
      lastDrop = Math.max(lastDrop, e.i);
    } else if (e.kind === 'shatter') {
      return fail('shattered');
    } else if (GHOST_STRIKE_KINDS.has(e.kind)) {
      strikes++;
    }
  }
  if (delivered !== level.pallets.length) return fail('not_delivered');
  if (lastDrop !== n - 1) return fail('not_finished');
  if (strikes !== run.strikes) return fail('strike_mismatch');
  return { ok: true, track };
}
