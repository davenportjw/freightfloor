/**
 * Start-of-run contract pick sheet (centred, over a scrim): the real offer from `hand.offer` as up
 * to three cards (kbd badge 1/2/3, rarity line, `.sel` state), a Blitz / Free Range toggle
 * (`setRunMode`) and "Start run · keep N ↵" (`keepCards`). Esc minimises the sheet
 * (`ui.dealMinimizedKey`) — the contracts card then shows "offer waiting".
 */
import type { Card } from '@warehouse/sim';
import { canKeep, cardKind, initialOfferSel, keepIds, offerKey, perkText, togglePickSel } from './cards.js';
import type { UiCtx, UiModule } from './context.js';
import { el, kbd, KeyedView } from './dom.js';
import { ALERT_MS } from './notify.js';

/**
 * Why the last pick action was refused. Shown inline in the sheet foot (the HUD alert line sits
 * under the scrim while the sheet is open), cleared after ALERT_MS.
 */
let pickNote: { text: string; until: number } | null = null;

function setPickNote(ctx: UiCtx, text: string): void {
  pickNote = { text, until: Date.now() + ALERT_MS };
  ctx.store.changed();
}

function currentOffer(ctx: UiCtx): { offer: Card[]; key: string; pick: number | null; active: Card[] } | null {
  const hand = ctx.store.myHand();
  const offer = hand?.offer && hand.offer.length ? hand.offer : null;
  const key = offerKey(offer);
  if (!offer || !key || !hand) return null;
  return { offer, key, pick: typeof hand.pick === 'number' ? hand.pick : null, active: hand.cards.filter((c) => c.status === 'active') };
}

/** Make sure `ui.offerSel` belongs to the current offer (a new deal resets it to the starter card). */
function syncSel(ctx: UiCtx, o: { offer: Card[]; key: string }): void {
  const ui = ctx.store.ui;
  if (ui.offerKey !== o.key) {
    ui.offerKey = o.key;
    ui.offerSel = initialOfferSel(o.offer);
  }
}

/** Toggle card `index` (0-based) of the open offer — used by clicks and the 1/2/3 hotkeys. */
export function pickToggle(ctx: UiCtx, index: number): void {
  const o = currentOffer(ctx);
  if (!o) return;
  syncSel(ctx, o);
  const card = o.offer[index];
  if (!card) return;
  const r = togglePickSel(o.offer, ctx.store.ui.offerSel, card.id, {
    pick: o.pick,
    activeCount: o.active.length,
    activeWilds: o.active.filter((c) => c.rarity === 'wild').length,
  });
  if (r.blocked) setPickNote(ctx, r.blocked);
  ctx.store.ui.offerSel = r.sel;
  ctx.actions.refresh();
}

/** Send keepCards with the selection (Enter / Start run). */
export function pickKeep(ctx: UiCtx): void {
  const o = currentOffer(ctx);
  if (!o) return;
  syncSel(ctx, o);
  const ids = keepIds(o.offer, ctx.store.ui.offerSel);
  if (!canKeep(ids.length, o.pick)) {
    setPickNote(ctx, 'Pick at least one contract to start.');
    return;
  }
  ctx.actions.keepCards(ids);
}

export function mountContractPick(root: HTMLElement, ctx: UiCtx): UiModule {
  const view = new KeyedView(root);
  return {
    update() {
      const { store, actions } = ctx;
      const o = store.activeOverlay() === 'pick' ? currentOffer(ctx) : null;
      root.hidden = !o;
      if (!o) {
        view.invalidate();
        return;
      }
      syncSel(ctx, o);
      const sel = store.ui.offerSel;
      const ids = keepIds(o.offer, sel);
      const mode = store.ui.runMode;
      if (pickNote && Date.now() >= pickNote.until) pickNote = null;
      const note = pickNote?.text ?? null;
      view.render(JSON.stringify([o.key, [...sel].sort(), mode, o.pick, note]), () => {
        const cards = o.offer.map((c, i) => {
          const on = sel.has(c.id);
          const perk = perkText(c);
          return el(
            'button',
            {
              class: `pcard${on ? ' sel' : ''}${c.rarity === 'wild' ? ' wild' : ''}`,
              title: c.desc,
              attrs: { type: 'button', 'aria-pressed': String(on), 'data-card-id': c.id },
              onClick: () => pickToggle(ctx, i),
            },
            [
              el('div', { class: 'pcard-top' }, [kbd(String(i + 1)), el('span', { class: 'rarity', text: cardKind(c) })]),
              el('div', { class: 'pcard-title', text: c.title }),
              el('div', { class: 'pcard-desc', text: c.desc }),
              perk ? el('div', { class: 'pcard-perk', text: perk }) : null,
              el('div', { class: 'pcard-foot num' }, [el('span', { text: `Goal ${c.goal}` }), el('b', { text: `+${c.pts} pts` })]),
            ],
          );
        });
        const modeBtn = (m: 'blitz' | 'freerange', label: string, tip: string): HTMLElement =>
          el('button', {
            class: `seg-btn${mode === m ? ' on' : ''}`,
            text: label,
            title: tip,
            attrs: { type: 'button', 'aria-pressed': String(mode === m) },
            onClick: () => actions.setRunMode(m),
          });
        const can = canKeep(ids.length, o.pick);
        const go = el(
          'button',
          {
            class: 'go',
            title: can ? 'Keep the selected contracts and start driving (Enter)' : 'Pick at least one contract to start',
            attrs: { type: 'button', 'data-role': 'keep-cards' },
            onClick: () => pickKeep(ctx),
          },
          [`Start run · keep ${ids.length} `, kbd('↵')],
        );
        (go as HTMLButtonElement).disabled = !can;
        return [
          el('div', { class: 'sheet-head' }, [
            el('h2', { text: o.pick != null ? `Pick ${o.pick} of ${o.offer.length}` : 'Pick your contracts' }),
            el('span', { class: 'muted', text: 'Esc to decide later' }),
          ]),
          el('div', { class: 'pcards' }, cards),
          el('div', { class: 'sheet-foot' }, [
            el('div', { class: 'seg-toggle', attrs: { 'data-role': 'deal-mode-selector' } }, [
              modeBtn('blitz', '⏱ Blitz', '3-minute timed run'),
              modeBtn('freerange', '🌐 Free Range', 'No timer — scored by pallets per minute'),
            ]),
            el('span', { class: 'grow' }),
            note ? el('span', { class: 'pick-note', text: note, attrs: { role: 'status', 'data-role': 'pick-note' } }) : null,
            go,
          ]),
        ];
      });
    },
  };
}
