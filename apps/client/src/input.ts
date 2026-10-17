/**
 * Driving input: keyboard state, the 10 Hz send loop and client-side prediction.
 *
 * How the server steps (apps/site server.ts + sim tick):
 * - every 100 ms it runs `tick(world)` with `dt = TICK_MIN` (0.1 game-min), stepping each
 *   human vehicle with the LAST `input` it received (`v.input`);
 * - on each `input` message it stores the input and immediately replies with an `ack`
 *   carrying the vehicle pose at that moment.
 *
 * So when the ack for seq N arrives, the server has applied every input up to N-1 for the
 * time it was held, and input N for (almost) nothing yet. The client records, per send,
 * the input that was held during the interval that ENDED with that send (`frames`), plus
 * the open interval since the last send (`tail`). Reconciling = take the ack pose, drop
 * frames with seq <= N, replay the rest and then the tail, in TICK_MIN sub-steps exactly
 * like the server does.
 */
import type { AckMessage, InputMessage } from '@warehouse/protocol';
import { stepHuman, TICK_MIN, type DriverInput, type Vehicle, type World } from '@warehouse/sim';

/** Real milliseconds per server tick (server setInterval 100 ms). */
export const SERVER_TICK_MS = 100;
/** Game-minutes per real millisecond at the server's fixed 1x rate. */
export const SIM_MIN_PER_MS = TICK_MIN / SERVER_TICK_MS;
/** Send cadence while any driving key is held (10 Hz). */
export const INPUT_SEND_INTERVAL_MS = 100;
/** While driving with no key held, re-send the (all released) input this often so the 5 s server lease survives. */
export const KEEPALIVE_INTERVAL_MS = 2_000;
/** After the last send with nothing held, stop predicting and accept server poses. */
export const PREDICTION_GRACE_MS = 400;
/** Safety cap on unacknowledged frames (10 s at 10 Hz). */
export const MAX_PENDING_FRAMES = 100;

export type DriveDir = 'up' | 'down' | 'left' | 'right' | 'boost';

export const KEYMAP: Readonly<Record<string, DriveDir>> = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  ShiftLeft: 'boost',
  ShiftRight: 'boost',
  Space: 'boost',
};

export interface PendingInputFrame {
  seq: number;
  /** Input that was held during this interval. */
  input: DriverInput;
  /** Interval length in game-minutes. */
  dt: number;
}

export function emptyInput(): DriverInput {
  return { up: false, down: false, left: false, right: false, boost: false };
}

export function anyHeld(i: DriverInput): boolean {
  return i.up || i.down || i.left || i.right || Boolean(i.boost);
}

/** Step a human vehicle by `dt` game-minutes in server-sized sub-steps (<= TICK_MIN). */
export function stepInChunks(w: World, v: Vehicle, input: DriverInput, dt: number): void {
  let left = dt;
  while (left > 1e-9) {
    const step = Math.min(TICK_MIN, left);
    stepHuman(w, v, input, step);
    left -= step;
  }
}

/**
 * Reconciles the predicted pose with an authoritative ack and replays what the server has not
 * applied yet. Returns the frames that are still unacknowledged.
 */
export function reconcilePredictedVehicle(
  w: World,
  v: Vehicle,
  ack: AckMessage,
  pendingInputs: PendingInputFrame[],
  tail?: PendingInputFrame | null,
): PendingInputFrame[] {
  if (typeof ack.x === 'number') v.px = ack.x;
  if (typeof ack.y === 'number') v.py = ack.y;
  v.tile = { x: Math.floor(v.px), y: Math.floor(v.py) };
  if (typeof ack.angle === 'number') v.angle = ack.angle;
  if (typeof ack.speedNow === 'number') v.speedNow = ack.speedNow;

  const remaining = pendingInputs.filter((frame) => frame.seq > ack.seq);
  for (const frame of remaining) stepInChunks(w, v, frame.input, frame.dt);
  if (tail && tail.dt > 0) stepInChunks(w, v, tail.input, tail.dt);
  return remaining;
}

export interface KeyLike {
  code: string;
  repeat?: boolean;
}

function wrapAngleDelta(d: number): number {
  const twoPi = Math.PI * 2;
  return ((((d + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
}

/**
 * Pure-ish controller: no DOM, time is injected. main.ts wires keyboard events, `blur`,
 * and calls `tick(now)` from a 10 Hz timer and `predict()` every animation frame.
 */
export class InputController {
  readonly held: DriverInput = emptyInput();
  seq = 0;
  frames: PendingInputFrame[] = [];
  /** Open interval since the last send (input = last sent input). */
  tail: PendingInputFrame = { seq: 0, input: emptyInput(), dt: 0 };
  lastSendMs: number | null = null;
  lastAckT: number | null = null;
  errorX = 0;
  errorY = 0;
  errorAngle = 0;

  constructor(
    private readonly send: (msg: InputMessage) => void,
    private readonly isDriving: () => boolean,
    private readonly isAutopilot: () => boolean = () => false,
    private readonly onManualTakeover?: () => void,
  ) {}

  /** Returns true when the key was consumed as a driving key. Repeats are swallowed but ignored. */
  keyDown(ev: KeyLike, nowMs: number): boolean {
    const dir = KEYMAP[ev.code];
    if (!dir || !this.isDriving()) return false;
    if (ev.repeat) return true;
    if (!this.held[dir]) {
      this.held[dir] = true;
      if (this.isAutopilot()) {
        this.onManualTakeover?.();
      }
      this.sendNow(nowMs);
    }
    return true;
  }

  keyUp(ev: KeyLike, nowMs: number): boolean {
    const dir = KEYMAP[ev.code];
    if (!dir) return false;
    if (this.held[dir]) {
      this.held[dir] = false;
      if (this.isDriving()) this.sendNow(nowMs);
    }
    return this.isDriving();
  }

  /** Programmatically set boost state (e.g. from the HUD boost button). */
  setBoost(active: boolean, nowMs: number): void {
    if (active && !this.isDriving()) return;
    const next = Boolean(active) && this.isDriving();
    if (Boolean(this.held.boost) !== next) {
      this.held.boost = next;
      if (next && this.isAutopilot()) {
        this.onManualTakeover?.();
      }
      if (this.isDriving()) this.sendNow(nowMs);
    }
  }

  /** Window lost focus: release every key (and tell the server). */
  blur(nowMs: number): void {
    if (!anyHeld(this.held)) return;
    this.held.up = this.held.down = this.held.left = this.held.right = false;
    this.held.boost = false;
    if (this.isDriving()) this.sendNow(nowMs);
  }

  /** Drop all state (hand back, reconnect, vehicle change). */
  reset(): void {
    this.held.up = this.held.down = this.held.left = this.held.right = false;
    this.held.boost = false;
    this.frames = [];
    this.tail = { seq: this.seq, input: emptyInput(), dt: 0 };
    this.lastSendMs = null;
    this.lastAckT = null;
    this.errorX = 0;
    this.errorY = 0;
    this.errorAngle = 0;
  }

  /** 10 Hz scheduler. Returns true if a message was sent. */
  tick(nowMs: number, keepAlive = false): boolean {
    if (!this.isDriving()) return false;
    const since = this.lastSendMs === null ? Infinity : nowMs - this.lastSendMs;
    if (anyHeld(this.held)) {
      if (since >= INPUT_SEND_INTERVAL_MS - 1) {
        this.sendNow(nowMs);
        return true;
      }
      return false;
    }
    if (this.isAutopilot()) return false;
    if (keepAlive && since >= KEEPALIVE_INTERVAL_MS) {
      this.sendNow(nowMs);
      return true;
    }
    return false;
  }

  /** True while local prediction should own our vehicle's pose (including coasting to a stop). */
  predicting(nowMs: number, v?: Vehicle | null): boolean {
    if ((this.isAutopilot() || v?.autopilot) && !anyHeld(this.held)) return false;
    if (anyHeld(this.held) || this.frames.length > 0) return true;
    if (this.lastSendMs !== null && nowMs - this.lastSendMs < PREDICTION_GRACE_MS) return true;
    if (v && v.human && !v.autopilot && v.state === 'driven' && Math.abs(v.speedNow) > 0.001) return true;
    return Math.hypot(this.errorX, this.errorY) > 1e-3 || Math.abs(this.errorAngle) > 1e-3;
  }

  /** Advance local prediction by `elapsedMs` of real time and decay visual reconciliation offset. */
  predict(w: World, v: Vehicle, elapsedMs: number): void {
    const clampedMs = Math.max(0, elapsedMs);
    if (clampedMs <= 0) return;
    const decay = Math.exp(-clampedMs / 80);
    this.errorX *= decay;
    this.errorY *= decay;
    this.errorAngle *= decay;
    if (Math.abs(this.errorX) < 1e-4) this.errorX = 0;
    if (Math.abs(this.errorY) < 1e-4) this.errorY = 0;
    if (Math.abs(this.errorAngle) < 1e-4) this.errorAngle = 0;

    const dt = clampedMs * SIM_MIN_PER_MS;
    this.tail.dt += dt;
    stepInChunks(w, v, this.tail.input, dt);
  }

  /** Smooth visual pose combining physical prediction with exponentially decaying ack error. */
  visualPose(v: Vehicle): { x: number; y: number; a: number } {
    return {
      x: v.px + this.errorX,
      y: v.py + this.errorY,
      a: wrapAngleDelta((v.angle || 0) + this.errorAngle),
    };
  }

  /** Server pose accepted (not predicting): nothing is in flight any more. */
  settle(): void {
    this.tail.dt = 0;
    this.lastAckT = null;
    this.errorX = 0;
    this.errorY = 0;
    this.errorAngle = 0;
  }

  applyAck(w: World, v: Vehicle, ack: AckMessage): void {
    // If the server simulation clock has not advanced since the previous ack (e.g. a key
    // press/release acked between 100 ms server ticks), do not discard sub-tick frames or
    // snap back to the already-reconciled server tick pose.
    if (
      typeof ack.t === 'number' &&
      this.lastAckT !== null &&
      Math.abs(ack.t - this.lastAckT) < 1e-6 &&
      this.frames.length > 0
    ) {
      return;
    }

    const prevAckT = this.lastAckT;
    if (typeof ack.t === 'number') {
      this.lastAckT = ack.t;
    }

    const prevVisX = v.px + this.errorX;
    const prevVisY = v.py + this.errorY;
    const prevVisAngle = wrapAngleDelta((v.angle || 0) + this.errorAngle);

    if (prevAckT !== null && typeof ack.t === 'number') {
      // Consume exactly the simulation time that elapsed on the server (`ack.t - prevAckT`)
      // rather than dropping all frames with `seq <= ack.seq`. This prevents losing 0.1 min
      // of predicted movement when client and server 10 Hz timers interleave or when
      // key-edge sends advance `seq` within a tick.
      let consumeDt = Math.max(0, ack.t - prevAckT);
      while (this.frames.length > 0 && consumeDt > 1e-6) {
        const head = this.frames[0];
        if (head.dt <= consumeDt + 1e-6) {
          consumeDt -= head.dt;
          this.frames.shift();
        } else {
          head.dt -= consumeDt;
          consumeDt = 0;
        }
      }
      while (this.frames.length > 0 && this.frames[0].dt <= 1e-6 && this.frames[0].seq <= ack.seq) {
        this.frames.shift();
      }
      // Cap total unacknowledged queued dt to prevent unbounded drift over long RTT spikes
      let totalQueuedDt = this.frames.reduce((sum, f) => sum + f.dt, 0);
      while (this.frames.length > 1 && totalQueuedDt > 0.25) {
        const dropped = this.frames.shift()!;
        totalQueuedDt -= dropped.dt;
      }

      if (typeof ack.x === 'number') v.px = ack.x;
      if (typeof ack.y === 'number') v.py = ack.y;
      v.tile = { x: Math.floor(v.px), y: Math.floor(v.py) };
      if (typeof ack.angle === 'number') v.angle = ack.angle;
      if (typeof ack.speedNow === 'number') v.speedNow = ack.speedNow;

      for (const frame of this.frames) stepInChunks(w, v, frame.input, frame.dt);
      if (this.tail.dt > 0) stepInChunks(w, v, this.tail.input, this.tail.dt);
    } else {
      this.frames = reconcilePredictedVehicle(w, v, ack, this.frames, this.tail);
    }

    const dx = prevVisX - v.px;
    const dy = prevVisY - v.py;
    const dist = Math.hypot(dx, dy);
    if (dist < 1.5) {
      this.errorX = dx;
      this.errorY = dy;
      this.errorAngle = wrapAngleDelta(prevVisAngle - (v.angle || 0));
    } else {
      this.errorX = 0;
      this.errorY = 0;
      this.errorAngle = 0;
    }
  }

  private sendNow(nowMs: number): void {
    const seq = ++this.seq;
    // Close the open interval: it ends with this send.
    this.frames.push({ seq, input: { ...this.tail.input }, dt: this.tail.dt });
    if (this.frames.length > MAX_PENDING_FRAMES) this.frames.shift();
    const input = { ...this.held };
    this.tail = { seq, input, dt: 0 };
    this.lastSendMs = nowMs;
    this.send({ type: 'input', ...input, seq });
  }
}
