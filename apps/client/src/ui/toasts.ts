/**
 * Toast stack (mock toast/onEvent, lines 1807-1823): max 4, retune 9 s, everything else 5.5 s.
 */
import type { SimEvent } from '@warehouse/sim';
import { el } from './dom.js';
import { eventColor } from './format.js';

export const TOAST_MAX = 4;

export interface ToastContext {
  selectedVid: string | null;
  driving: boolean;
}

/** nearmiss → log only; decision → only for the selected vehicle; hint → only while driving. */
export function shouldToast(ev: Pick<SimEvent, 'type'> & { vid?: unknown }, ctx: ToastContext): boolean {
  if (ev.type === 'nearmiss') return false;
  if (ev.type === 'decision') return typeof ev.vid === 'string' && ev.vid === ctx.selectedVid;
  if (ev.type === 'hint') return ctx.driving;
  return true;
}

export function toastDurationMs(type: string): number {
  return type === 'retune' ? 9000 : 5500;
}

export class ToastStack {
  constructor(private readonly box: HTMLElement) {}

  push(type: string, text: string, extra?: string): void {
    const node = el('div', { class: 'toast hud', attrs: { role: 'status' }, style: { 'border-left-color': eventColor(type) } }, [
      text,
      extra ? el('div', { class: 'toast-extra', text: extra }) : null,
    ]);
    this.box.append(node);
    while (this.box.children.length > TOAST_MAX) this.box.firstElementChild?.remove();
    setTimeout(() => node.remove(), toastDurationMs(type));
  }
}
