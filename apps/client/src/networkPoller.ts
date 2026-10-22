/**
 * `/api/network` poller: pauses in hidden tabs, never overlaps requests, and drops responses
 * that arrive out of order (an older request finishing after a newer one).
 */
import type { NetworkFetch } from './net.js';

export interface NetworkPollerDeps {
  fetchNetwork: () => Promise<NetworkFetch>;
  /** Apply a fresh (in-order) result to the store. */
  apply: (res: NetworkFetch) => void;
  /** Called right before a request starts (e.g. to mark the store `loading`). */
  onStart?: () => void;
  isHidden: () => boolean;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  intervalMs: number;
}

export class NetworkPoller {
  private seq = 0;
  private appliedSeq = 0;
  private inFlight: Promise<void> | null = null;
  private handle: unknown = null;
  /** A poll was requested while one was in flight: run one more when it settles. */
  private queued = false;

  constructor(private readonly deps: NetworkPollerDeps) {}

  get running(): boolean {
    return this.handle !== null;
  }

  get busy(): boolean {
    return this.inFlight !== null;
  }

  /** Start the periodic poll (immediately polls once) unless the tab is hidden. */
  start(): void {
    if (this.handle !== null || this.deps.isHidden()) return;
    this.handle = this.deps.setInterval(() => void this.poll(), this.deps.intervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.handle === null) return;
    this.deps.clearInterval(this.handle);
    this.handle = null;
  }

  /** Wire to `visibilitychange`: hidden → stop; visible → resume (with an immediate poll). */
  onVisibilityChange(): void {
    if (this.deps.isHidden()) this.stop();
    else this.start();
  }

  /**
   * Poll once. A call while a request is in flight does not start a second request; it
   * coalesces into one follow-up poll after the current one settles (so an explicit refresh
   * still sees fresh data). Skipped while the tab is hidden.
   */
  poll(): Promise<void> {
    if (this.deps.isHidden()) return Promise.resolve();
    if (this.inFlight) {
      this.queued = true;
      return this.inFlight;
    }
    const mySeq = ++this.seq;
    this.deps.onStart?.();
    const run = (async () => {
      let res: NetworkFetch;
      try {
        res = await this.deps.fetchNetwork();
      } catch (err) {
        res = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      // Drop out-of-order responses.
      if (mySeq < this.appliedSeq) return;
      this.appliedSeq = mySeq;
      this.deps.apply(res);
    })();
    this.inFlight = run.finally(() => {
      this.inFlight = null;
      if (this.queued) {
        this.queued = false;
        void this.poll();
      }
    });
    return this.inFlight;
  }
}
