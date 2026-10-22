/**
 * Render-loop guard: one throwing frame must never freeze the canvas for good.
 *
 * `guardedFrame` runs the frame body inside try/finally and always re-queues the next
 * animation frame from `finally`. Errors are logged, throttled to one log per `logEveryMs`
 * (with a count of the frames that failed in between) so a persistent fault cannot flood the
 * console at 60 Hz.
 */
export const FRAME_ERROR_LOG_MS = 5_000;

export interface FrameLoopDeps {
  requestFrame: (cb: (now: number) => void) => unknown;
  logError: (message: string, err: unknown) => void;
  /** Wall clock for throttling (defaults to Date.now). */
  clock?: () => number;
  logEveryMs?: number;
}

export interface FrameLoop {
  /** Queue the first frame. */
  start(): void;
  /** The guarded callback handed to requestAnimationFrame (exposed for tests). */
  tick(now: number): void;
  /** Frames that threw since the loop started. */
  readonly errorCount: number;
}

export function guardedFrame(body: (now: number) => void, deps: FrameLoopDeps): FrameLoop {
  const clock = deps.clock ?? (() => Date.now());
  const every = deps.logEveryMs ?? FRAME_ERROR_LOG_MS;
  let lastLogAt = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  let errors = 0;
  const loop: FrameLoop = {
    start() {
      deps.requestFrame(loop.tick);
    },
    tick(now: number) {
      try {
        body(now);
      } catch (err) {
        errors++;
        const t = clock();
        if (t - lastLogAt >= every) {
          const extra = suppressed > 0 ? ` (+${suppressed} more since last report)` : '';
          deps.logError(`Render frame failed${extra}`, err);
          lastLogAt = t;
          suppressed = 0;
        } else {
          suppressed++;
        }
      } finally {
        deps.requestFrame(loop.tick);
      }
    },
    get errorCount() {
      return errors;
    },
  };
  return loop;
}
