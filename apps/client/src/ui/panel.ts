/**
 * Reusable collapsible HUD panel.
 *
 * - The header is a fold button (▾ open / ▸ collapsed) with aria-expanded.
 * - A collapsed panel shrinks to a compact pill that shows a live one-line summary.
 * - State is persisted per panel in localStorage under `warehouse.panel.<id>`.
 * - Below AUTO_COLLAPSE_WIDTH panels fold automatically, unless the player has made
 *   an explicit choice for that panel (an explicit choice always wins).
 */
import { el } from './dom.js';

export type PanelZone = 'left' | 'right' | 'bottom';
export type PanelState = 'open' | 'collapsed' | 'hidden';

export const AUTO_COLLAPSE_WIDTH = 1366;
export const PANEL_KEY_PREFIX = 'warehouse.panel.';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PanelOptions {
  id: string; // localStorage key: warehouse.panel.<id>
  title: string; // uppercase label in the header button
  zone: PanelZone;
  defaultState: PanelState;
  hotkey?: string; // e.g. 'B' toggles the board (routed by ui/hotkeys.ts)
  summary?: () => string; // one-line pill text when collapsed
  /** Panels such as the KPI bar opt out of the narrow-screen auto fold. Default true. */
  autoCollapse?: boolean;
  className?: string;
  storage?: StorageLike | null;
  viewportWidth?: () => number;
}

export interface StoredPanelState {
  state: PanelState;
  user: boolean;
}

export interface ResolvedPanelState {
  state: PanelState;
  source: 'user' | 'auto' | 'default';
}

export function panelStorageKey(id: string): string {
  return `${PANEL_KEY_PREFIX}${id}`;
}

export function readStoredPanelState(
  storage: StorageLike | null | undefined,
  id: string,
): StoredPanelState | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(panelStorageKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPanelState>;
    if (parsed.state === 'open' || parsed.state === 'collapsed' || parsed.state === 'hidden') {
      return { state: parsed.state, user: parsed.user === true };
    }
  } catch {
    // Corrupt entry: treat as no stored choice.
  }
  return null;
}

export function writeStoredPanelState(
  storage: StorageLike | null | undefined,
  id: string,
  value: StoredPanelState,
): void {
  if (!storage) return;
  try {
    storage.setItem(panelStorageKey(id), JSON.stringify(value));
  } catch {
    // Storage full / disabled: the panel still works for this session.
  }
}

/** Pure decision: explicit user choice > narrow-screen auto fold > default. */
export function resolvePanelState(
  opts: Pick<PanelOptions, 'id' | 'defaultState' | 'autoCollapse'>,
  storage: StorageLike | null | undefined,
  width: number,
): ResolvedPanelState {
  const stored = readStoredPanelState(storage, opts.id);
  if (stored?.user) return { state: stored.state, source: 'user' };
  if (opts.autoCollapse !== false && width < AUTO_COLLAPSE_WIDTH && opts.defaultState === 'open') {
    return { state: 'collapsed', source: 'auto' };
  }
  return { state: opts.defaultState, source: 'default' };
}

export interface PanelHandle {
  readonly id: string;
  readonly opts: PanelOptions;
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  readonly header: HTMLButtonElement;
  state(): PanelState;
  isOpen(): boolean;
  /** user=true persists the choice so auto-collapse no longer overrides it. */
  setState(state: PanelState, user?: boolean): void;
  toggle(user?: boolean): void;
  refreshSummary(): void;
  /** Re-evaluate auto collapse after a viewport resize (no-op for user-chosen panels). */
  onViewportResize(): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function createPanel(opts: PanelOptions, body: HTMLElement): PanelHandle {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const width = opts.viewportWidth ?? (() => (typeof window !== 'undefined' ? window.innerWidth : 1920));

  const chevron = el('span', { class: 'panel-chevron', attrs: { 'aria-hidden': 'true' } });
  const titleEl = el('span', { class: 'label', text: opts.title });
  const summaryEl = el('span', { class: 'panel-summary num' });
  const hotkeyEl = opts.hotkey ? el('span', { class: 'kbd panel-hotkey', text: opts.hotkey }) : null;
  const header = el('button', { class: 'panel-header', attrs: { type: 'button' } }, [
    titleEl,
    summaryEl,
    el('span', { class: 'panel-spacer' }),
    hotkeyEl,
    chevron,
  ]);
  const bodyId = `panel-body-${opts.id}`;
  body.id = body.id || bodyId;
  body.classList.add('panel-body');
  header.setAttribute('aria-controls', body.id);

  const root = el('section', {
    class: `hud panel panel-${opts.zone}${opts.className ? ` ${opts.className}` : ''}`,
    attrs: { 'data-panel': opts.id, 'aria-label': opts.title },
  });
  root.append(header, body);

  let resolved = resolvePanelState(opts, storage, width());
  let current: PanelState = resolved.state;
  let userChosen = resolved.source === 'user';

  const apply = (): void => {
    root.classList.toggle('collapsed', current === 'collapsed');
    root.hidden = current === 'hidden';
    body.hidden = current !== 'open';
    header.setAttribute('aria-expanded', current === 'open' ? 'true' : 'false');
    chevron.textContent = current === 'open' ? '▾' : '▸';
    header.title = current === 'open' ? `Fold ${opts.title}` : `Expand ${opts.title}`;
    refreshSummary();
  };

  const refreshSummary = (): void => {
    if (current !== 'collapsed' || !opts.summary) {
      summaryEl.textContent = '';
      summaryEl.hidden = true;
      return;
    }
    summaryEl.hidden = false;
    summaryEl.textContent = opts.summary();
  };

  const handle: PanelHandle = {
    id: opts.id,
    opts,
    root,
    body,
    header,
    state: () => current,
    isOpen: () => current === 'open',
    setState(state, user = true) {
      current = state;
      if (user) {
        userChosen = true;
        writeStoredPanelState(storage, opts.id, { state, user: true });
      }
      apply();
    },
    toggle(user = true) {
      handle.setState(current === 'open' ? 'collapsed' : 'open', user);
    },
    refreshSummary,
    onViewportResize() {
      if (userChosen) return;
      resolved = resolvePanelState(opts, storage, width());
      if (resolved.state !== current) {
        current = resolved.state;
        apply();
      }
    },
  };

  header.addEventListener('click', () => handle.toggle(true));
  apply();
  return handle;
}
