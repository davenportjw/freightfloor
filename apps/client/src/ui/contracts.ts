/**
 * DRIVE HUD → `#contracts` card (right, top, 250px, collapsible). One `.q` row per contract with a
 * segmented progress bar; a replacement "pick 1 of 2" offer slides into the card; an "offer waiting"
 * row reopens a tucked-away start-of-run pick sheet. Hidden in Minimal HUD.
 */
import type { Card } from '@warehouse/sim';
import { activePerksSummary, canKeep, cardKind, dealTitle, keepIds, offerKey, perkText, ROUTE_RESERVE_HINT, toggleOfferSel } from './cards.js';
import type { UiCtx, UiModule } from './context.js';
import { button, el, KeyedView } from './dom.js';

/** Max bar segments; bigger goals are drawn proportionally on this many segments. */
export const MAX_SEGMENTS = 10;

/** Segmented bar: `n` segments with `on` lit (proportional when goal > MAX_SEGMENTS). */
export function progressSegments(progress: number, goal: number, done: boolean): { n: number; on: number } {
  const g = Math.max(1, Math.round(goal));
  const n = Math.min(MAX_SEGMENTS, g);
  if (done) return { n, on: n };
  const p = Math.max(0, Math.min(g, progress));
  return { n, on: g <= MAX_SEGMENTS ? Math.floor(p) : Math.floor((p / g) * n) };
}

function bar(c: Card): HTMLElement {
  const done = c.status === 'done';
  const s = progressSegments(c.progress, c.goal, done);
  return el(
    'div',
    { class: `ct-bar${done ? ' done' : ''}`, attrs: { 'aria-label': `${c.progress} of ${c.goal}` } },
    Array.from({ length: s.n }, (_, i) => el('i', { class: i < s.on ? 'on' : '' })),
  );
}

export function mountContracts(root: HTMLElement, ctx: UiCtx): UiModule {
  const view = new KeyedView(root);
  const lastProgress = new Map<string, number>();
  return {
    update() {
      const { store, actions } = ctx;
      const show = store.hudMode() === 'driving' && !store.ui.hudMinimal && store.welcomed;
      const ov = store.activeOverlay();
      root.hidden = !show || ov === 'results' || ov === 'pick';
      if (root.hidden) {
        view.invalidate();
        return;
      }
      const hand = store.myHand();
      const cards = hand?.cards ?? [];
      const shown = cards.filter((c) => c.status === 'active' || c.status === 'done');
      const offer = hand?.offer && hand.offer.length ? hand.offer : null;
      const pick = typeof hand?.pick === 'number' ? hand.pick : null;
      const key = offerKey(offer);
      if (offer && pick != null && key !== store.ui.offerKey) {
        store.ui.offerKey = key;
        store.ui.offerSel = new Set();
      }
      const replacement = offer && pick != null ? offer : null;
      const waiting = offer && pick == null && store.ui.dealMinimizedKey === key;
      const perks = activePerksSummary(cards);
      const collapsed = store.ui.contractsCollapsed;
      // Flash rows whose progress just went up.
      const flash = new Set<string>();
      for (const c of shown) {
        const prev = lastProgress.get(c.id);
        if (prev !== undefined && c.progress > prev) flash.add(c.id);
        lastProgress.set(c.id, c.progress);
      }
      const activeN = cards.filter((c) => c.status === 'active').length;
      root.classList.toggle('collapsed', collapsed);
      view.render(
        JSON.stringify([
          collapsed,
          shown.map((c) => [c.id, c.status, c.progress, c.goal, c.title, c.pts]),
          replacement?.map((c) => c.id),
          [...store.ui.offerSel].sort(),
          waiting,
          perks,
          [...flash],
        ]),
        () => {
          const head = el(
            'button',
            {
              class: 'ct-head',
              attrs: { type: 'button', 'aria-expanded': String(!collapsed) },
              title: collapsed ? 'Show contracts' : 'Collapse contracts',
              onClick: () => {
                store.ui.contractsCollapsed = !collapsed;
                actions.refresh();
              },
            },
            [el('span', { class: 'sub', text: 'Contracts' }), el('span', { class: 'num muted', text: `${activeN} active ${collapsed ? '▸' : '▾'}` })],
          );
          if (collapsed) return [head];
          const rows: Array<HTMLElement | null> = shown.map((c) => {
            const done = c.status === 'done';
            const perk = perkText(c);
            const tip = [c.desc, perk ? (done ? `${perk} (active)` : `${perk} on completion`) : null, c.type === 'route' ? ROUTE_RESERVE_HINT : null]
              .filter(Boolean)
              .join('\n');
            return el('div', { class: `q${done ? ' done' : ''}${flash.has(c.id) ? ' flash' : ''}`, title: tip }, [
              el('div', { class: 'q-top' }, [
                el('span', { class: 'q-title', text: `${done ? '✓ ' : ''}${c.title}` }),
                el('span', { class: 'num q-pts', text: `+${c.pts}` }),
              ]),
              bar(c),
              el('div', { class: 'q-sub num', text: done ? (perk ? 'done · perk active' : 'done') : `${c.progress} / ${c.goal} · ${cardKind(c)}` }),
            ]);
          });
          if (!shown.length && !replacement && !waiting) {
            rows.push(el('div', { class: 'q muted', text: offer ? 'Pick your contracts to start the run.' : 'No contracts yet — they are dealt when you take the wheel.' }));
          }
          if (waiting && offer) {
            const b = button(`🃏 ${offer.length} contracts waiting — choose`, 'q q-offer', () => {
              store.ui.dealMinimizedKey = null;
              actions.refresh();
            });
            b.dataset.action = 'open-deal';
            rows.push(b);
          }
          if (replacement) {
            const sel = store.ui.offerSel;
            const ids = keepIds(replacement, sel);
            rows.push(
              el('div', { class: 'q q-replace', attrs: { 'data-role': 'replacement-offer' } }, [
                el('div', { class: 'sub', text: dealTitle(replacement, pick) }),
                ...replacement.map((c) => {
                  const on = sel.has(c.id);
                  const b = button('', `rep${on ? ' sel' : ''}${c.rarity === 'wild' ? ' wild' : ''}`, () => {
                    store.ui.offerSel = toggleOfferSel(store.ui.offerSel, c.id, pick);
                    actions.refresh();
                  }, [c.desc, perkText(c)].filter(Boolean).join('\n'));
                  b.setAttribute('aria-pressed', String(on));
                  b.append(el('b', { text: c.title }), el('span', { class: 'num', text: ` +${c.pts}` }));
                  return b;
                }),
                (() => {
                  const b = button(ids.length ? `Keep ${ids.length}` : 'Pick one', 'go small', () => {
                    const keep = keepIds(replacement, store.ui.offerSel);
                    if (canKeep(keep.length, pick)) actions.keepCards(keep);
                  });
                  b.disabled = !canKeep(ids.length, pick);
                  if (b.disabled) b.title = 'Select a card first';
                  return b;
                })(),
              ]),
            );
          }
          if (perks) rows.push(el('div', { class: 'perks', attrs: { 'data-role': 'active-perks-badge' }, text: `✨ ${perks}` }));
          return [head, ...rows];
        },
      );
    },
  };
}
