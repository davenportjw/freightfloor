import { describe, expect, it, vi } from 'vitest';
import { FRAME_ERROR_LOG_MS, guardedFrame } from '../src/frameLoop.js';
import { NetworkPoller, type NetworkPollerDeps } from '../src/networkPoller.js';
import type { NetworkFetch } from '../src/net.js';
import { createFocusTrap, nextTrapTarget, type TrapContainer, type TrapKeyEvent } from '../src/ui/focusTrap.js';
import { bindTapClick } from '../src/ui/dom.js';
import { PointerSet, pinchStep } from '../src/render/gestures.js';
import { zoomAt } from '../src/render/iso.js';
import { watchDevicePixelRatio, watchElementSize } from '../src/render/dpr.js';

describe('guardedFrame', () => {
  it('re-queues the next frame even when a frame throws, and throttles error logs', () => {
    const queue: Array<(now: number) => void> = [];
    const logs: string[] = [];
    let clock = 0;
    let fail = true;
    const loop = guardedFrame(
      () => {
        if (fail) throw new Error('boom');
      },
      { requestFrame: (cb) => queue.push(cb), logError: (m) => logs.push(m), clock: () => clock },
    );
    loop.start();
    expect(queue).toHaveLength(1);
    for (let i = 0; i < 10; i++) {
      queue.shift()!(i * 16);
      clock += 16;
    }
    expect(queue).toHaveLength(1); // still alive
    expect(loop.errorCount).toBe(10);
    expect(logs).toHaveLength(1);
    clock += FRAME_ERROR_LOG_MS;
    queue.shift()!(0);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatch(/\+9 more/);
    fail = false;
    queue.shift()!(0);
    expect(loop.errorCount).toBe(11);
    expect(queue).toHaveLength(1);
  });
});

describe('NetworkPoller', () => {
  const ok: NetworkFetch = { ok: true, data: { sites: [], leaderboard: [] } } as unknown as NetworkFetch;

  function setup(over: Partial<NetworkPollerDeps> = {}) {
    let hidden = false;
    const intervals: Array<() => void> = [];
    const applied: NetworkFetch[] = [];
    const pending: Array<(r: NetworkFetch) => void> = [];
    const fetchNetwork = vi.fn(() => new Promise<NetworkFetch>((r) => pending.push(r)));
    const poller = new NetworkPoller({
      fetchNetwork,
      apply: (r) => applied.push(r),
      isHidden: () => hidden,
      setInterval: (fn) => {
        intervals.push(fn);
        return intervals.length;
      },
      clearInterval: () => {
        intervals.length = 0;
      },
      intervalMs: 5000,
      ...over,
    });
    return { poller, fetchNetwork, applied, pending, intervals, setHidden: (h: boolean) => (hidden = h) };
  }

  it('never overlaps requests; a poll during one coalesces into a single follow-up', async () => {
    const t = setup();
    void t.poller.poll();
    void t.poller.poll();
    void t.poller.poll();
    expect(t.fetchNetwork).toHaveBeenCalledTimes(1);
    t.pending.shift()!(ok);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.applied).toHaveLength(1);
    expect(t.fetchNetwork).toHaveBeenCalledTimes(2);
    t.pending.shift()!(ok);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.applied).toHaveLength(2);
    expect(t.fetchNetwork).toHaveBeenCalledTimes(2);
  });

  it('pauses while the tab is hidden and resumes with an immediate poll', async () => {
    const t = setup();
    t.poller.start();
    expect(t.poller.running).toBe(true);
    expect(t.fetchNetwork).toHaveBeenCalledTimes(1);
    t.pending.shift()!(ok);
    await new Promise((r) => setTimeout(r, 0));
    t.setHidden(true);
    t.poller.onVisibilityChange();
    expect(t.poller.running).toBe(false);
    await t.poller.poll(); // hidden: skipped
    expect(t.fetchNetwork).toHaveBeenCalledTimes(1);
    t.setHidden(false);
    t.poller.onVisibilityChange();
    expect(t.poller.running).toBe(true);
    expect(t.fetchNetwork).toHaveBeenCalledTimes(2);
  });

  it('surfaces a thrown fetch as an error result (no fake data)', async () => {
    const applied: NetworkFetch[] = [];
    const poller = new NetworkPoller({
      fetchNetwork: async () => {
        throw new Error('offline');
      },
      apply: (r) => applied.push(r),
      isHidden: () => false,
      setInterval: () => 1,
      clearInterval: () => {},
      intervalMs: 1000,
    });
    await poller.poll();
    expect(applied).toEqual([{ ok: false, error: 'offline' }]);
  });
});

describe('focus trap', () => {
  it('nextTrapTarget wraps at both ends and leaves middle moves to the browser', () => {
    const items = ['a', 'b', 'c'];
    expect(nextTrapTarget(items, 'c', false)).toBe('a');
    expect(nextTrapTarget(items, 'a', true)).toBe('c');
    expect(nextTrapTarget(items, 'b', false)).toBeNull();
    expect(nextTrapTarget(items, 'zzz', false)).toBe('a');
    expect(nextTrapTarget([], 'a', false)).toBeNull();
  });

  it('activates on an initial element, wraps Tab inside and returns focus on deactivate', () => {
    const doc = { activeElement: null as unknown };
    const mk = (name: string) => ({ name, focus: () => (doc.activeElement = node(name)) });
    const nodes: Record<string, ReturnType<typeof mk>> = {};
    const node = (n: string) => nodes[n]!;
    for (const n of ['outside', 'first', 'last']) nodes[n] = mk(n);
    let handler: ((ev: TrapKeyEvent) => void) | null = null;
    const container: TrapContainer<ReturnType<typeof mk>> = {
      querySelectorAll: () => [node('first'), node('last')],
      contains: (x) => x === node('first') || x === node('last'),
      addEventListener: (_t, fn) => (handler = fn),
      removeEventListener: () => (handler = null),
    };
    node('outside').focus();
    const trap = createFocusTrap(container, doc);
    trap.activate(node('last'));
    expect(doc.activeElement).toBe(node('last'));
    const ev = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() };
    handler!(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(doc.activeElement).toBe(node('first'));
    handler!({ ...ev, shiftKey: true });
    expect(doc.activeElement).toBe(node('last'));
    trap.deactivate();
    expect(handler).toBeNull();
    expect(doc.activeElement).toBe(node('outside'));
  });

  it('skips programmatic initial focus on coarse-pointer (touch) devices to prevent iOS Safari tap swallowing', () => {
    const prevWin = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = {
      matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' }),
    };
    try {
      const doc = { activeElement: null as unknown };
      const first = { focus: vi.fn() };
      const container: TrapContainer<typeof first> = {
        querySelectorAll: () => [first],
        contains: () => false,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      const trap = createFocusTrap(container, doc);
      trap.activate(first);
      expect(first.focus).not.toHaveBeenCalled();
    } finally {
      (globalThis as Record<string, unknown>).window = prevWin;
    }
  });
});

describe('bindTapClick (iOS Safari single-tap activation)', () => {
  function makeMockButton(): {
    disabled: boolean;
    emit: (type: string, ev: Record<string, unknown>) => void;
    node: HTMLElement;
  } {
    const listeners = new Map<string, Array<(ev: unknown) => void>>();
    const btn = {
      disabled: false,
      addEventListener(type: string, fn: (ev: unknown) => void) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      emit(type: string, ev: Record<string, unknown>) {
        for (const fn of listeners.get(type) ?? []) fn(ev);
      },
    };
    return {
      get disabled() {
        return btn.disabled;
      },
      set disabled(v: boolean) {
        btn.disabled = v;
      },
      emit: btn.emit.bind(btn),
      node: btn as unknown as HTMLElement,
    };
  }

  it('fires on touch pointerup within slop and deduplicates the subsequent synthesized click', () => {
    const mock = makeMockButton();
    const handler = vi.fn();
    bindTapClick(mock.node, handler);

    mock.emit('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 200 });
    mock.emit('pointerup', { pointerType: 'touch', clientX: 104, clientY: 203 });
    expect(handler).toHaveBeenCalledTimes(1);

    const preventDefault = vi.fn();
    mock.emit('click', { preventDefault });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('ignores touch pointerup when the finger scrolled beyond the slop threshold', () => {
    const mock = makeMockButton();
    const handler = vi.fn();
    bindTapClick(mock.node, handler);

    mock.emit('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 200 });
    mock.emit('pointerup', { pointerType: 'touch', clientX: 100, clientY: 230 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('fires normally on mouse/keyboard click', () => {
    const mock = makeMockButton();
    const handler = vi.fn();
    bindTapClick(mock.node, handler);

    mock.emit('pointerdown', { pointerType: 'mouse', clientX: 50, clientY: 50 });
    mock.emit('pointerup', { pointerType: 'mouse', clientX: 50, clientY: 50 });
    expect(handler).not.toHaveBeenCalled();

    mock.emit('click', { preventDefault: vi.fn() });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('touch gestures', () => {
  it('pinch zooms about the finger midpoint', () => {
    const cam = { x: 10, y: 20, zoom: 1 };
    const next = pinchStep(cam, [{ x: 90, y: 100 }, { x: 110, y: 100 }], [{ x: 85, y: 100 }, { x: 115, y: 100 }]);
    expect(next).toEqual(zoomAt(cam, 100, 100, 1.5));
  });

  it('two fingers moving together pan without zooming', () => {
    const cam = { x: 0, y: 0, zoom: 1 };
    const next = pinchStep(cam, [{ x: 0, y: 0 }, { x: 20, y: 0 }], [{ x: 5, y: 7 }, { x: 25, y: 7 }]);
    expect(next.zoom).toBe(1);
    expect(next.x).toBeCloseTo(5);
    expect(next.y).toBeCloseTo(7);
  });

  it('PointerSet tracks fingers in order so a lifted finger rebases the drag on the remaining one', () => {
    const ps = new PointerSet();
    ps.set(1, { x: 0, y: 0 });
    ps.set(2, { x: 10, y: 0 });
    expect(ps.size).toBe(2);
    expect(ps.pair()).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    ps.delete(1);
    expect(ps.pair()).toBeNull();
    expect(ps.first()).toEqual({ id: 2, p: { x: 10, y: 0 } });
    ps.clear();
    expect(ps.size).toBe(0);
  });
});

describe('canvas sizing watchers', () => {
  it('re-registers the resolution media query after each DPR change', () => {
    const queries: string[] = [];
    const listeners = new Map<string, () => void>();
    const win = {
      devicePixelRatio: 1,
      matchMedia: (q: string) => {
        queries.push(q);
        return {
          addEventListener: (_t: 'change', fn: () => void) => listeners.set(q, fn),
          removeEventListener: (_t: 'change', _fn: () => void) => listeners.delete(q),
        };
      },
    };
    const seen: number[] = [];
    const stop = watchDevicePixelRatio(win, (d) => seen.push(d));
    expect(queries).toEqual(['(resolution: 1dppx)']);
    win.devicePixelRatio = 2;
    listeners.get('(resolution: 1dppx)')!();
    expect(seen).toEqual([2]);
    expect(queries.at(-1)).toBe('(resolution: 2dppx)');
    expect(listeners.has('(resolution: 1dppx)')).toBe(false);
    stop();
    expect(listeners.size).toBe(0);
  });

  it('observes the canvas container with ResizeObserver and disconnects on cleanup', () => {
    const calls: string[] = [];
    let cb: (() => void) | null = null;
    class RO {
      constructor(fn: () => void) {
        cb = fn;
      }
      observe() {
        calls.push('observe');
      }
      disconnect() {
        calls.push('disconnect');
      }
    }
    let resized = 0;
    const stop = watchElementSize({}, () => resized++, RO);
    cb!();
    expect(resized).toBe(1);
    stop();
    expect(calls).toEqual(['observe', 'disconnect']);
    expect(watchElementSize(null, () => {}, RO)).toBeTypeOf('function');
  });
});
