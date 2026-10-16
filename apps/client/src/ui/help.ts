/**
 * "How to win" help overlay (mock lines 149-169). Shown on the first visit only
 * (localStorage `warehouse.help.seen`), reopened with ? or the toolbar button.
 */
import type { UiCtx, UiModule } from './context.js';
import { button, el, kbd } from './dom.js';
import { HOTKEYS } from './hotkeys.js';
import type { StorageLike } from './panel.js';

export const HELP_SEEN_KEY = 'warehouse.help.seen';

export function shouldShowHelpOnBoot(storage: StorageLike | null | undefined): boolean {
  try {
    return !storage?.getItem(HELP_SEEN_KEY);
  } catch {
    return false;
  }
}

export function markHelpSeen(storage: StorageLike | null | undefined): void {
  try {
    storage?.setItem(HELP_SEEN_KEY, '1');
  } catch {
    /* storage unavailable (private mode): help simply shows again next time */
  }
}

export function mountHelp(overlay: HTMLElement, ctx: UiCtx): UiModule {
  const close = button('Got it', 'btn drive', () => ctx.actions.showHelp(false));
  const p = (...kids: Array<Node | string>): HTMLElement => el('p', {}, kids);
  const b = (t: string): HTMLElement => el('b', { text: t });
  const card = el('div', { class: 'hud help-card', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'helpTitle' } }, [
    el('div', { class: 'help-head' }, [el('h2', { text: 'How to win', attrs: { id: 'helpTitle' } }), close]),
    p(b('Goal: '), 'finish each 8-hour shift ranked ', b('#1'), ' on the leaderboard. Every vehicle, AI or human, scores the same way.'),
    p(b('Points: '), '+10 per pallet delivered, +40 for a P0 order. Half points if late. −15 if you cause a crash.'),
    el('div', { class: 'label sub', text: 'Your first minute' }),
    el('ol', {}, [
      el('li', {}, ['Press ', b('🚜 Drive'), ' (or click any vehicle, then ', b('Take the wheel'), ').']),
      el('li', {}, [
        'Follow the glowing ring. When it turns ',
        b('green'),
        ' and the bar says ',
        b('In range'),
        ', press ',
        kbd('E'),
        ' to pick up, then drive to the blue bay ring and press ',
        kbd('E'),
        ' again to deliver.',
      ]),
      el('li', {}, ['Pick contract cards when offered. They add bonus points and post purple pallets for you.']),
      el('li', {}, ['Keep the battery above 20%. Park on a green charger and press ', kbd('E'), '.']),
    ]),
    el('div', { class: 'label sub', text: 'Controls' }),
    el(
      'table',
      { class: 'keys' },
      HOTKEYS.map((h) => el('tr', {}, [el('td', {}, [kbd(h.key)]), el('td', { text: h.action })])),
    ),
    p(
      'Hitting another vehicle at speed is a crash: both stop for 4 minutes and a pallet may be damaged. ',
      'Other players drive other vehicles on the same site and share the leaderboard.',
    ),
  ]);
  overlay.replaceChildren(card);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) ctx.actions.showHelp(false);
  });
  return {
    update() {
      const open = ctx.store.ui.helpOpen;
      if (overlay.hidden === !open) return;
      overlay.hidden = !open;
      if (open) close.focus();
    },
  };
}
