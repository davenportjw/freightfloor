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

/**
 * Toggle a card in the offer selection. With `maxKeep === 1` (replacement draw:
 * "pick 1 of 2") selecting a card replaces the previous choice.
 */
export function toggleOfferSel(sel: ReadonlySet<string>, id: string, maxKeep?: number | null): Set<string> {
  if (maxKeep === 1) return sel.has(id) ? new Set() : new Set([id]);
  const next = new Set(sel);
  if (next.has(id)) next.delete(id);
  else if (maxKeep == null || next.size < maxKeep) next.add(id);
  return next;
}

/** Ids to send, in offer order, restricted to cards still on offer. */
export function keepIds(offer: readonly Card[], sel: ReadonlySet<string>): string[] {
  return offer.filter((c) => sel.has(c.id)).map((c) => c.id);
}

export function keepLabel(n: number): string {
  return `Keep ${n} card${n === 1 ? '' : 's'}`;
}

/** Keep is allowed with 1..pick cards (pick unset → any number ≥ 1). */
export function canKeep(n: number, pick?: number | null): boolean {
  return n >= 1 && (pick == null || n <= pick);
}

/** Deal-panel heading: 'Pick 1 of 2' on replacement draws, else 'New contracts'. */
export function dealTitle(offer: readonly Card[], pick?: number | null): string {
  return pick != null ? `Pick ${pick} of ${offer.length}` : 'New contracts';
}

const pct = (x: number): string => `${Math.round(Math.abs(x) * 100)}%`;

/** Human-readable perk list, e.g. 'Perk: +8% speed · −15% battery drain'; null when the card has no perk. */
export function perkText(c: Pick<Card, 'perk'>): string | null {
  const p = c.perk;
  if (!p) return null;
  const parts: string[] = [];
  for (const [k, raw] of Object.entries(p)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    switch (k) {
      case 'speedMul':
        if (raw !== 1) parts.push(`${raw > 1 ? '+' : '−'}${pct(raw - 1)} speed`);
        break;
      case 'reachBonus':
        if (raw) parts.push(`+${Math.round(raw * 100) / 100} tile reach`);
        break;
      case 'batteryDrainMul':
      case 'drainMul':
        if (raw !== 1) parts.push(`${raw < 1 ? '−' : '+'}${pct(1 - raw)} battery drain`);
        break;
      case 'forkLiftMul':
        if (raw !== 1) parts.push(`${raw > 1 ? '+' : '−'}${pct(raw - 1)} fork speed`);
        break;
      case 'chargeBonus':
        if (raw > 0) parts.push(`+${Math.round(raw)}%/s charge speed`);
        break;
      case 'ptsMul':
        if (raw !== 1) parts.push(`${raw > 1 ? '+' : '−'}${pct(raw - 1)} delivery pts`);
        break;
      case 'comboFloor':
        if (raw > 0) parts.push(`combo resets only to ×${[1.0, 1.2, 1.5, 2.0][Math.min(3, Math.round(raw))].toFixed(1)}`);
        break;
      default:
        if (raw) parts.push(`${k} ${raw > 0 ? '+' : ''}${raw}`);
    }
  }
  return parts.length ? `Perk: ${parts.join(' · ')}` : null;
}

/** Aggregate unlocked perks across all completed cards in the driver's hand. */
export function activePerksSummary(cards: readonly Card[] | null | undefined): string | null {
  if (!cards || !cards.length) return null;
  const doneCards = cards.filter((c) => c.status === 'done' && c.perk);
  if (!doneCards.length) return null;
  let speedMul = 1;
  let reachBonus = 0;
  let drainMul = 1;
  let chargeBonus = 0;
  let ptsMul = 1;
  let forkLiftMul = 1;
  let comboFloor = 0;
  for (const c of doneCards) {
    const p = c.perk;
    if (!p) continue;
    if (typeof p.speedMul === 'number') speedMul *= p.speedMul;
    if (typeof p.reachBonus === 'number') reachBonus += p.reachBonus;
    if (typeof p.batteryDrainMul === 'number') drainMul *= p.batteryDrainMul;
    if (typeof p.drainMul === 'number') drainMul *= p.drainMul;
    if (typeof p.chargeBonus === 'number') chargeBonus += p.chargeBonus;
    if (typeof p.ptsMul === 'number') ptsMul *= p.ptsMul;
    if (typeof p.forkLiftMul === 'number') forkLiftMul *= p.forkLiftMul;
    if (typeof p.comboFloor === 'number') comboFloor = Math.max(comboFloor, p.comboFloor);
  }
  const summary = perkText({
    perk: {
      ...(speedMul !== 1 ? { speedMul } : {}),
      ...(reachBonus > 0 ? { reachBonus } : {}),
      ...(drainMul !== 1 ? { drainMul } : {}),
      ...(chargeBonus > 0 ? { chargeBonus } : {}),
      ...(ptsMul !== 1 ? { ptsMul } : {}),
      ...(forkLiftMul !== 1 ? { forkLiftMul } : {}),
      ...(comboFloor > 0 ? { comboFloor } : {}),
    },
  });
  return summary ? summary.replace(/^Perk:\s*/, 'Active Perks: ') : null;
}

/** Route cards: the owner's pallets are reserved for 90 game-min (≈ 90 s), then anyone can poach them. */
export const ROUTE_RESERVE_HINT = 'Your pallets are reserved for 90 s, then rivals can poach them.';

function cardColor(c: Card): string {
  return c.status === 'done' ? '#16A34A' : c.status === 'active' ? (c.rarity === 'wild' ? '#B45309' : '#7C3AED') : '#94A3B8';
}

function cardKind(c: Card): string {
  const base = c.starter ? 'Starter' : c.type === 'route' ? 'Route' : 'Skill';
  return c.rarity === 'wild' ? `Wild · ${base}` : base;
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
      const me = store.myVehicle();
      const activeMode = me?.runMode ?? store.runMode ?? 'blitz';

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
        const perksSummary = activePerksSummary(hand.cards);
        trayView.render(
          JSON.stringify([
            hand.cards.map((c) => [c.id, c.status, c.progress, c.goal, c.rarity, c.perk]),
            aiDone,
            perksSummary,
          ]),
          () => [
            ...hand.cards.map((c) => {
              const col = cardColor(c);
              const pct = c.status === 'done' ? 100 : Math.min(100, Math.round((100 * c.progress) / Math.max(1, c.goal)));
              const mark = c.status === 'done' ? '✓ ' : c.status === 'lost' ? '✗ ' : '';
              const done = c.status === 'done';
              const perk = perkText(c);
              const perkLine = perk ? (done ? `✓ ${perk} (unlocked)` : `${perk} on completion`) : null;
              const tip = [c.desc, perk, c.type === 'route' ? ROUTE_RESERVE_HINT : null].filter(Boolean).join('\n');
              return el(
                'div',
                {
                  class: `hud card${c.status === 'active' || done ? '' : ' dim'}${done ? ' unlocked' : ''}${c.rarity === 'wild' ? ' wild' : ''}`,
                  style: { 'border-top': `5px solid ${col}` },
                  title: tip,
                },
                [
                  el('div', { class: 'card-top' }, [
                    el('span', { class: 'label', text: cardKind(c) }),
                    el('span', { class: 'num b card-pts', style: { color: col }, text: `${mark}+${c.pts}` }),
                  ]),
                  el('div', { class: 'card-title b', text: c.title }),
                  el('div', { class: `card-perk${done ? ' on' : ''}`, text: perkLine ?? c.desc }),
                  el('div', { class: 'grow' }),
                  el('div', { class: 'bar' }, [el('div', { style: { width: `${pct}%`, background: col } })]),
                  el('div', {
                    class: 'small muted num',
                    text: c.status === 'active' ? `${c.progress} / ${c.goal}` : done ? (perk ? 'done · perk active' : 'done') : c.status,
                  }),
                ],
              );
            }),
            perksSummary
              ? el('div', {
                  class: 'small b cards-active-perks',
                  attrs: { 'data-role': 'active-perks-badge' },
                  text: `✨ ${perksSummary}`,
                })
              : null,
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
      const pick = typeof hand?.pick === 'number' ? hand.pick : null;
      deal.hidden = false;
      dealView.render(JSON.stringify([key, [...sel].sort(), pick, activeMode]), () => [
        el('div', { class: 'deal-head' }, [
          el('b', { text: dealTitle(offer, pick) }),
          el('span', {
            class: 'muted',
            text:
              pick != null
                ? ` replacement card — choose ${pick === 1 ? 'one' : `up to ${pick}`}. Perks stay active for your run.`
                : ' keep at least one (max 3 active, one wild). Completed card perks stack for your entire run!',
          }),
        ]),
        pick == null
          ? el('div', { class: 'deal-mode-row', attrs: { 'data-role': 'deal-mode-selector' } }, [
              el('span', { class: 'label', text: 'Run Mode:' }),
              (() => {
                const b = button(
                  '⏱️ 5-Min Blitz',
                  `btn small intent-pill${activeMode === 'blitz' ? ' on' : ''}`,
                  () => actions.setRunMode('blitz'),
                  'Competitive 5-minute scored sprint. Timer starts when you keep cards or move (15s grace).',
                );
                b.dataset.mode = 'blitz';
                b.setAttribute('aria-pressed', String(activeMode === 'blitz'));
                return b;
              })(),
              (() => {
                const b = button(
                  '🌐 Free Range',
                  `btn small intent-pill${activeMode === 'freerange' ? ' on' : ''}`,
                  () => actions.setRunMode('freerange'),
                  'Open-ended sandbox shift with no countdown timer and cross-site surge relocation bonuses.',
                );
                b.dataset.mode = 'freerange';
                b.setAttribute('aria-pressed', String(activeMode === 'freerange'));
                return b;
              })(),
              el('span', {
                class: 'small muted',
                text:
                  activeMode === 'blitz'
                    ? '⏱️ 5:00 clock starts on Keep or first movement'
                    : '🌐 Open-ended session · scored by PPM & On-Time %',
              }),
            ])
          : null,
        el(
          'div',
          { class: 'deal-tiles' },
          offer.map((c) => {
            const on = sel.has(c.id);
            const wild = c.rarity === 'wild';
            const b = button('', `deal-tile${on ? ' on' : ''}${wild ? ' wild' : ''}`, () => {
              store.ui.offerSel = toggleOfferSel(store.ui.offerSel, c.id, pick);
              actions.refresh();
            });
            b.setAttribute('aria-pressed', String(on));
            const perk = perkText(c);
            const extra: HTMLElement[] = [];
            if (perk) extra.push(el('div', { class: 'card-perk', text: perk }));
            if (c.type === 'route') extra.push(el('div', { class: 'small muted card-hint', text: ROUTE_RESERVE_HINT }));
            b.append(
              el('div', { class: 'card-top' }, [
                el('span', { class: 'label', text: cardKind(c) }),
                el('span', { class: `num b ${wild ? 'card-wild-pts' : 'violet'}`, text: `+${c.pts}` }),
              ]),
              el('div', { class: 'b card-title', text: c.title }),
              el('div', { class: 'small muted', text: c.desc }),
              ...extra,
            );
            return b;
          }),
        ),
        el('div', { class: 'deal-actions' }, [
          (() => {
            const b = button(keepLabel(ids.length), 'btn drive', () => {
              const keep = keepIds(offer, store.ui.offerSel);
              if (canKeep(keep.length, pick)) actions.keepCards(keep);
            });
            b.disabled = !canKeep(ids.length, pick);
            return b;
          })(),
        ]),
      ]);
    },
  };
}
