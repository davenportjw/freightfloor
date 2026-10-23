/**
 * Tiny DOM helpers. Everything goes through textContent / setAttribute so that
 * server-provided strings (driver names, event text, brain reasons) can never be
 * interpreted as HTML.
 */

export interface ElOptions {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
  style?: Partial<Record<string, string>>;
  onClick?: (ev: MouseEvent) => void;
}

export type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.title) node.title = opts.title;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  }
  if (opts.style) {
    for (const [k, v] of Object.entries(opts.style)) {
      if (v !== undefined) node.style.setProperty(k, v);
    }
  }
  if (opts.onClick) {
    bindTapClick(node, opts.onClick);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/**
 * Bind a click handler that also activates on a clean touch `pointerup` (with
 * scroll-slop tolerance and synthetic-click deduplication) so iOS Safari never
 * swallows the first tap when a modal or live HUD updates between touch events.
 */
export function bindTapClick(node: HTMLElement, handler: (ev: MouseEvent) => void): void {
  let downX = 0;
  let downY = 0;
  let touchTracking = false;
  let lastTouchFireAt = 0;
  const SLOP_PX = 12;
  const DEDUPE_MS = 450;

  if (typeof node.addEventListener !== 'function') return;

  node.addEventListener('pointerdown', (ev: PointerEvent) => {
    if (ev.pointerType !== 'touch') return;
    touchTracking = true;
    downX = ev.clientX;
    downY = ev.clientY;
  });
  node.addEventListener('pointercancel', () => {
    touchTracking = false;
  });
  node.addEventListener('pointerup', (ev: PointerEvent) => {
    if (!touchTracking || ev.pointerType !== 'touch') return;
    touchTracking = false;
    if ((node as HTMLButtonElement).disabled) return;
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > SLOP_PX) return;
    lastTouchFireAt = Date.now();
    handler(ev as unknown as MouseEvent);
  });
  node.addEventListener('click', (ev) => {
    if (Date.now() - lastTouchFireAt < DEDUPE_MS) {
      ev.preventDefault();
      return;
    }
    handler(ev as MouseEvent);
  });
}

export function button(
  text: string,
  cls: string,
  onClick: (ev: MouseEvent) => void,
  title?: string,
): HTMLButtonElement {
  const b = el('button', { class: cls, text, title, onClick });
  b.type = 'button';
  return b;
}

export function kbd(key: string): HTMLSpanElement {
  return el('span', { class: 'kbd', text: key });
}

export function swatch(color: string, cls = 'swatch'): HTMLElement {
  return el('i', { class: cls, style: { background: color } });
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in index.html`);
  return node as T;
}

/** Replace children only when the render key changed (keeps buttons clickable). */
export class KeyedView {
  private last = '\u0000';
  constructor(public readonly root: HTMLElement) {}
  render(key: string, build: () => Child[]): boolean {
    if (key === this.last) return false;
    this.last = key;
    const kids = build().filter((c): c is Node | string => !!c);
    this.root.replaceChildren(...kids);
    return true;
  }
  invalidate(): void {
    this.last = '\u0000';
  }
}
