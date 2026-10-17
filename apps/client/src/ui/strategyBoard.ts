/**
 * Left: Strategy Board (mock lines 80-93). Rows come from the server's stats.board
 * (or the welcome snapshot's real delivery log until the first stats arrive).
 */
import type { BoardRow } from '@warehouse/protocol';
import type { UiCtx, UiModule } from './context.js';
import { el, KeyedView, swatch } from './dom.js';
import { DASH, fmt, teamColor } from './format.js';
import { createPanel, type PanelHandle } from './panel.js';

/** Highest throughput first (stable for ties). */
export function sortBoard(rows: readonly BoardRow[]): BoardRow[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.perHr - a.r.perHr || a.i - b.i)
    .map((x) => x.r);
}

export function boardSummary(rows: readonly BoardRow[] | null): string {
  if (!rows || !rows.length) return DASH;
  const top = sortBoard(rows)[0];
  return `${top.strat} ${fmt(top.perHr, 1)}/hr`;
}

export function mountStrategyBoard(zone: HTMLElement, ctx: UiCtx): UiModule & { panel: PanelHandle } {
  const rowsEl = el('div', { class: 'board-rows' });
  const view = new KeyedView(rowsEl);
  const body = el('div', { class: 'board' }, [
    el('div', { class: 'board-grid board-head label' }, [
      el('span', { text: 'Strategy', title: 'AI dispatch archetype or Human drivers (× vehicle count)' }),
      el('span', { class: 'r', text: '/hr', title: 'Orders delivered per game-hour (rolling 60m)' }),
      el('span', { class: 'r', text: 'On-time', title: 'Percentage of orders delivered before deadline' }),
      el('span', { class: 'r', text: '⚠', title: 'Collisions/incidents in the last 60 game-min' }),
      el('span', { class: 'r', text: 'kWh/ord', title: 'Battery energy used per delivered order' }),
    ]),
    rowsEl,
    el('div', {
      class: 'hint',
      text: 'AI dispatch strategies compete against each other and human drivers (rolling 60m). Click any row to highlight that team on the floor and spot bottlenecks.',
    }),
  ]);
  const panel = createPanel(
    {
      id: 'board',
      title: 'Strategy Board',
      zone: 'left',
      defaultState: 'open',
      hotkey: 'B',
      summary: () => boardSummary(ctx.store.board),
    },
    body,
  );
  zone.append(panel.root);

  return {
    panel,
    update() {
      const { store, actions } = ctx;
      const rows = store.welcomed && store.board ? sortBoard(store.board) : null;
      view.render(JSON.stringify([rows, store.highlightStrategy]), () => {
        if (!rows) return [el('div', { class: 'empty', text: 'Waiting for the site…' })];
        if (!rows.length) return [el('div', { class: 'empty', text: 'No deliveries in the last 60 game-min.' })];
        return rows.map((r) => {
          const row = el(
            'button',
            {
              class: `board-row board-grid num${store.highlightStrategy === r.strat ? ' row-hl' : ''}`,
              attrs: { type: 'button', 'aria-pressed': String(store.highlightStrategy === r.strat) },
              onClick: () => actions.setHighlight(store.highlightStrategy === r.strat ? null : r.strat),
            },
            [
              el('span', { class: 'strat' }, [
                swatch(teamColor(r.strat)),
                el('b', { text: r.strat }),
                el('span', { class: 'muted', text: `×${r.vehicles}` }),
              ]),
              el('span', { class: 'r b', text: fmt(r.perHr, 1) }),
              el('span', { class: 'r', text: fmt(r.onTimePct, 0, '%') }),
              el('span', { class: `r${r.incidents ? ' bad b' : ''}`, text: String(r.incidents) }),
              el('span', { class: 'r', text: fmt(r.kwhPerOrder, 2) }),
            ],
          );
          return row;
        });
      });
      panel.refreshSummary();
    },
  };
}
