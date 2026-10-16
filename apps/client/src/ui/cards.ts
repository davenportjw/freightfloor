/**
 * Contract cards (mock updateCards, lines 1959-1999): the hand tray (bottom-right) and the
 * non-blocking deal panel. The hand is `world.cards[you.clientId]`; "Keep N" sends every
 * selected id in one keepCards message.
 */
import type { Card } from '@warehouse/sim';
import type { UiCtx, UiModule } from './context.js';
import { button, el, KeyedView } from './dom.js';

/** Identity of an offer (a new deal resets the selection). */
export function offerKey(offer: readonly Card[] | null | undefined): string | null {
  return offer && offer.length ? offer.map((c) => c.id).join(',') : null;
}

/** Starter card preselected (else the first card), like the mock. */
export function initialOfferSel(offer: readonly Card[] | null | undefined): Set<string> {
  if (!offer || !offer.length) return new Set();
  return new Set([(offer.find((c) => c.starter) ?? offer[0]).id]);
}

export function toggleOfferSel(sel: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(sel);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Ids to send, in offer order, restricted to cards still on offer. */
export function keepIds(offer: readonly Card[], sel: ReadonlySet<string>): string[] {
  return offer.filter((c) => sel.has(c.id)).map((c) => c.id);
}

export function keepLabel(n: number): string {
  return `Keep ${n} card${n === 1 ? '' : 's'}`;
}

function cardColor(c: Card): string {
  return c.status === 'done' ? '#16A34A' : c.status === 'active' ? '#7C3AED' : '#94A3B8';
}

function cardKind(c: Card): string {
  return c.starter ? 'Starter' : c.type === 'route' ? 'Route' : 'Skill';
}

export function mountCards(trayZone: HTMLElement, dealZone: HTMLElement, ctx: UiCtx): UiModule {
  const tray = el('div', { class: 'cards-tray', attrs: { 'aria-label': 'Your contracts' } });
  const trayView = new KeyedView(tray);
  const deal = el('div', { class: 'hud deal', attrs: { role: 'dialog', 'aria-label': 'New contracts' } });
  const dealView = new KeyedView(deal);
  deal.hidden = true;
  trayZone.append(tray);
  dealZone.append(deal);

  return {
    update() {
      const { store, actions } = ctx;
      const hand = store.welcomed ? store.myHand() : null;
      const aiDone = store.world.totals?.aiCardsDone ?? 0;

      // ---- tray ----
      if (!store.welcomed) {
        trayView.render('none', () => []);
      } else if (!hand || (!hand.cards.length && !hand.offer)) {
        trayView.render(`empty|${aiDone}`, () => [
          el('div', { class: 'hud card card-empty' }, [
            el('div', { class: 'label', text: 'Contracts' }),
            el('div', {
              class: 'small',
              text: `Take the wheel to be dealt 3 cards each shift. Agents hold cards too (${aiDone} done).`,
            }),
          ]),
        ]);
      } else if (hand.cards.length) {
        trayView.render(
          JSON.stringify([hand.cards.map((c) => [c.id, c.status, c.progress, c.goal]), aiDone]),
          () => [
            ...hand.cards.map((c) => {
              const col = cardColor(c);
              const pct = c.status === 'done' ? 100 : Math.min(100, Math.round((100 * c.progress) / Math.max(1, c.goal)));
              const mark = c.status === 'done' ? '✓ ' : c.status === 'lost' ? '✗ ' : '';
              return el(
                'div',
                {
                  class: `hud card${c.status === 'active' || c.status === 'done' ? '' : ' dim'}`,
                  style: { 'border-top': `5px solid ${col}` },
                  title: c.desc,
                },
                [
                  el('div', { class: 'card-top' }, [
                    el('span', { class: 'label', text: cardKind(c) }),
                    el('span', { class: 'num b card-pts', style: { color: col }, text: `${mark}+${c.pts}` }),
                  ]),
                  el('div', { class: 'card-title b', text: c.title }),
                  el('div', { class: 'grow' }),
                  el('div', { class: 'bar' }, [el('div', { style: { width: `${pct}%`, background: col } })]),
                  el('div', { class: 'small muted num', text: c.status === 'active' ? `${c.progress} / ${c.goal}` : c.status }),
                ],
              );
            }),
            el('div', { class: 'small muted cards-ai', text: `Agents: ${aiDone} cards done` }),
          ],
        );
      } else {
        trayView.render('choose', () => [el('div', { class: 'hud card-note small', text: 'Choose your contracts above.' })]);
      }

      // ---- deal ----
      const offer = hand?.offer ?? null;
      if (!offer || !offer.length) {
        deal.hidden = true;
        dealView.render('none', () => []);
        if (store.ui.offerKey !== null) {
          store.ui.offerKey = null;
          store.ui.offerSel = new Set();
        }
        return;
      }
      const key = offerKey(offer);
      if (key !== store.ui.offerKey) {
        store.ui.offerKey = key;
        store.ui.offerSel = initialOfferSel(offer);
      }
      const sel = store.ui.offerSel;
      const ids = keepIds(offer, sel);
      deal.hidden = false;
      dealView.render(JSON.stringify([key, [...sel].sort()]), () => [
        el('div', { class: 'deal-head' }, [
          el('b', { text: 'New contracts' }),
          el('span', {
            class: 'muted',
            text: ' keep at least one. Bonus points on top of order points. Unfinished cards simply expire.',
          }),
        ]),
        el(
          'div',
          { class: 'deal-tiles' },
          offer.map((c) => {
            const on = sel.has(c.id);
            const b = button('', `deal-tile${on ? ' on' : ''}`, () => {
              store.ui.offerSel = toggleOfferSel(store.ui.offerSel, c.id);
              actions.refresh();
            });
            b.setAttribute('aria-pressed', String(on));
            b.append(
              el('div', { class: 'card-top' }, [
                el('span', { class: 'label', text: cardKind(c) }),
                el('span', { class: 'num b violet', text: `+${c.pts}` }),
              ]),
              el('div', { class: 'b card-title', text: c.title }),
              el('div', { class: 'small muted', text: c.desc }),
            );
            return b;
          }),
        ),
        el('div', { class: 'deal-actions' }, [
          (() => {
            const b = button(keepLabel(ids.length), 'btn drive', () => actions.keepCards(keepIds(offer, store.ui.offerSel)));
            b.disabled = ids.length === 0;
            return b;
          })(),
        ]),
      ]);
    },
  };
}
