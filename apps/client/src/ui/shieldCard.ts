/**
 * 🛡 Model Armor shield card (`#shieldCard`, top centre under the objective): shown for a few
 * seconds when one of my typed commands was blocked by Model Armor. Text comes verbatim from the
 * server's `commandEcho.armor` (layer / stage / filter) via `shieldCardFor`; the strike counter is
 * the per-session count of blocks (or the server's, whichever is higher).
 */
import type { UiCtx, UiModule } from './context.js';
import { el } from './dom.js';

export const SHIELD_CARD_MS = 6_000;

export function shieldStrikeText(strikes: number, muted: boolean): string {
  const s = `${strikes} strike${strikes === 1 ? '' : 's'} this session`;
  return muted ? `${s} · commands paused` : s;
}

export function mountShieldCard(root: HTMLElement, ctx: UiCtx): UiModule {
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.dataset.role = 'shield-card';
  let last = '';
  return {
    update() {
      const sh = ctx.store.ui.shield;
      if (sh && Date.now() >= sh.until) ctx.store.ui.shield = null;
      const cur = ctx.store.ui.shield;
      root.hidden = !cur;
      if (!cur) {
        last = '';
        return;
      }
      const key = `${cur.title}|${cur.strikes}|${cur.muted}|${cur.until}`;
      if (key === last) return;
      last = key;
      root.replaceChildren(
        el('b', { text: cur.title }),
        el('span', { class: 'sub', attrs: { 'data-role': 'shield-strikes' }, text: shieldStrikeText(cur.strikes, cur.muted) }),
      );
    },
  };
}
