/**
 * Garage flyout (☰ → Game → Garage): the forklift livery catalog.
 *
 * Cosmetic only. Cards come from `garageCards(store.livery)`; the site decides what is unlocked
 * (`liveryStatus`) and answers an equip with `liveryStatus` or a `livery_*` error shown inline.
 * Equip is sent only from a click (never from `update()`).
 */
import type { UiCtx, UiModule } from './context.js';
import { el, KeyedView } from './dom.js';
import { garageButton, garageCards, type GarageCard } from './liveries.js';

function swatch(c: GarageCard): HTMLElement {
  return el('span', {
    class: 'garage-swatch',
    attrs: { 'aria-hidden': 'true' },
    style: {
      background: c.accent ? `linear-gradient(135deg, ${c.primary} 0 62%, ${c.accent} 62% 100%)` : c.primary,
    },
  });
}

export function mountGarage(root: HTMLElement, ctx: UiCtx): UiModule {
  const view = new KeyedView(root);
  return {
    update() {
      const { store, actions } = ctx;
      const driving = store.myVid != null;
      const key = JSON.stringify([driving, store.livery, store.liveryPending, store.liveryError]);
      view.render(key, () => {
        const cards = garageCards(store.livery);
        const head = el('div', {
          class: 'hint',
          text: driving
            ? 'Paint your forklift. Liveries are cosmetic and follow you to every site.'
            : 'Join as a driver to paint your forklift.',
        });
        const err = store.liveryError
          ? el('div', { class: 'garage-error', attrs: { role: 'alert', 'data-role': 'garage-error' }, text: store.liveryError })
          : null;
        const grid = el(
          'div',
          { class: 'garage-grid', attrs: { 'data-role': 'garage-grid' } },
          cards.map((c) => {
            const state = garageButton(c, driving, store.liveryPending);
            const btn = el('button', {
              class: `btn${c.equipped ? ' active' : ''}`,
              text: state.label,
              attrs: {
                type: 'button',
                'data-act': 'equip-livery',
                'data-livery': c.id,
                'aria-pressed': c.equipped ? 'true' : 'false',
              },
              onClick: () => {
                if (!garageButton(c, store.myVid != null, store.liveryPending).disabled) actions.setLivery(c.id);
              },
            });
            btn.disabled = state.disabled;
            return el(
              'div',
              {
                class: `garage-card${c.locked ? ' locked' : ''}${c.equipped ? ' equipped' : ''}`,
                attrs: { 'data-livery-card': c.id },
              },
              [
                swatch(c),
                el('div', { class: 'garage-name', text: `${c.locked ? '🔒 ' : ''}${c.name}` }),
                c.locked ? el('div', { class: 'garage-rule', text: c.rule }) : null,
                btn,
              ],
            );
          }),
        );
        return [head, err, grid];
      });
    },
  };
}
