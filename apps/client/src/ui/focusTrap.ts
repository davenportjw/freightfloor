/**
 * Focus trap + focus return for modal dialogs (help / intro, leaderboard, results).
 *
 * `activate()` remembers the element that had focus, moves focus into the dialog and keeps
 * Tab / Shift+Tab cycling inside it; `deactivate()` removes the trap and returns focus to the
 * remembered element (when it is still in the document). The DOM surface used is tiny so the
 * logic is unit-testable without a browser.
 */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Minimal focusable element surface. */
export interface FocusableLike {
  focus(): void;
  hidden?: boolean;
  isConnected?: boolean;
  getClientRects?: () => { length: number };
  closest?: (sel: string) => unknown;
}

export interface TrapContainer<E extends FocusableLike = FocusableLike> {
  querySelectorAll(sel: string): ArrayLike<E>;
  contains(node: unknown): boolean;
  addEventListener(type: 'keydown', fn: (ev: TrapKeyEvent) => void): void;
  removeEventListener(type: 'keydown', fn: (ev: TrapKeyEvent) => void): void;
}

export interface TrapKeyEvent {
  key: string;
  shiftKey: boolean;
  preventDefault(): void;
}

export interface TrapDocument {
  readonly activeElement: unknown;
}

/** Pure: where Tab (or Shift+Tab) should move focus, or null to let the browser handle it. */
export function nextTrapTarget<T>(items: readonly T[], active: unknown, backwards: boolean): T | null {
  if (!items.length) return null;
  const idx = items.indexOf(active as T);
  if (idx === -1) return backwards ? items[items.length - 1]! : items[0]!;
  if (backwards && idx === 0) return items[items.length - 1]!;
  if (!backwards && idx === items.length - 1) return items[0]!;
  return null;
}

function isVisible(el: FocusableLike): boolean {
  if (el.hidden) return false;
  if (el.closest && el.closest('[hidden]')) return false;
  if (el.getClientRects && el.getClientRects().length === 0) return false;
  return true;
}

export interface FocusTrap {
  readonly active: boolean;
  activate(initial?: FocusableLike | null): void;
  deactivate(): void;
}

export function createFocusTrap<E extends FocusableLike>(
  container: TrapContainer<E>,
  doc: TrapDocument | null = typeof document !== 'undefined' ? document : null,
): FocusTrap {
  let returnTo: FocusableLike | null = null;
  let on = false;
  // Minimal DOM stand-ins (unit tests) may lack querySelectorAll / focus: degrade to a no-op trap.
  const focusables = (): E[] =>
    typeof container.querySelectorAll === 'function'
      ? Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isVisible)
      : [];
  const onKey = (ev: TrapKeyEvent): void => {
    if (ev.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) {
      ev.preventDefault();
      return;
    }
    const active = doc?.activeElement ?? null;
    const inside = active !== null && container.contains(active);
    const target = inside ? nextTrapTarget(items, active, ev.shiftKey) : (ev.shiftKey ? items[items.length - 1] : items[0]);
    if (target) {
      ev.preventDefault();
      target.focus();
    }
  };
  return {
    get active() {
      return on;
    },
    activate(initial) {
      if (!on) {
        const prev = doc?.activeElement as FocusableLike | null | undefined;
        returnTo = prev && typeof prev.focus === 'function' && !container.contains(prev) ? prev : null;
        if (typeof container.addEventListener === 'function') container.addEventListener('keydown', onKey);
        on = true;
      }
      const first = initial ?? focusables()[0] ?? null;
      if (first && typeof first.focus === 'function') first.focus();
    },
    deactivate() {
      if (!on) return;
      on = false;
      if (typeof container.removeEventListener === 'function') container.removeEventListener('keydown', onKey);
      const back = returnTo;
      returnTo = null;
      if (back && back.isConnected !== false) {
        try {
          back.focus();
        } catch {
          /* element no longer focusable */
        }
      }
    },
  };
}
