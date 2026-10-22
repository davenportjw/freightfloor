/**
 * Canvas sizing watchers (dependency-injected so they unit-test without a DOM).
 *
 * `watchDevicePixelRatio` fires when the page moves between monitors / the user zooms: a
 * `(resolution: Xdppx)` media query only matches the *current* DPR, so after each change it
 * re-registers against the new ratio. `watchElementSize` wraps ResizeObserver so the canvas
 * follows its container (sidebar/drawer toggles), not only `window.resize`.
 */

export interface DprMediaQueryList {
  addEventListener(type: 'change', fn: () => void): void;
  removeEventListener(type: 'change', fn: () => void): void;
}

export interface DprWindow {
  readonly devicePixelRatio: number;
  matchMedia?(query: string): DprMediaQueryList;
}

/** Calls `onChange(dpr)` whenever devicePixelRatio changes. Returns an unsubscribe function. */
export function watchDevicePixelRatio(win: DprWindow, onChange: (dpr: number) => void): () => void {
  if (typeof win.matchMedia !== 'function') return () => {};
  let mq: DprMediaQueryList | null = null;
  let stopped = false;
  const listen = (): void => {
    if (stopped) return;
    mq = win.matchMedia!(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
    mq.addEventListener('change', handler);
  };
  const handler = (): void => {
    mq?.removeEventListener('change', handler);
    mq = null;
    onChange(win.devicePixelRatio || 1);
    listen();
  };
  listen();
  return () => {
    stopped = true;
    mq?.removeEventListener('change', handler);
    mq = null;
  };
}

export interface SizeObserverLike {
  observe(el: unknown): void;
  disconnect(): void;
}

export type SizeObserverCtor = new (cb: () => void) => SizeObserverLike;

/** Observe `el` with ResizeObserver (when available). Returns a disconnect function. */
export function watchElementSize(
  el: unknown,
  onResize: () => void,
  Ctor: SizeObserverCtor | undefined = (globalThis as { ResizeObserver?: SizeObserverCtor }).ResizeObserver,
): () => void {
  if (!el || !Ctor) return () => {};
  const ro = new Ctor(() => onResize());
  ro.observe(el);
  return () => ro.disconnect();
}
