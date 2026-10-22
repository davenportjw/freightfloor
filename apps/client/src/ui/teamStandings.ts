/**
 * Floor view → Team Standings flyout (B). Formerly the "Strategy Board": every AI driving
 * style and the Humans compete, ranked PER TRUCK so a style with more vehicles does not win
 * just by headcount. Rows come from the server's `stats.board` (or the welcome snapshot's real
 * delivery log until the first stats arrive). Clicking a row highlights that team on the floor.
 */
import type { BoardRow } from '@warehouse/protocol';
import type { UiCtx, UiModule } from './context.js';
import { el, KeyedView, swatch } from './dom.js';
import { DASH, fmt, teamColor } from './format.js';

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

export interface StyleRank {
  row: BoardRow;
  /** Orders per game-hour per vehicle; null when the style has no vehicles. */
  perTruck: number | null;
  rank: number;
}

/** Rank styles by orders/hr per truck (styles without trucks sink to the bottom, stable for ties). */
export function rankStylesPerTruck(rows: readonly BoardRow[]): StyleRank[] {
  const withPer = rows.map((row, i) => ({ row, i, perTruck: row.vehicles > 0 ? row.perHr / row.vehicles : null }));
  withPer.sort((a, b) => (b.perTruck ?? -1) - (a.perTruck ?? -1) || a.i - b.i);
  return withPer.map((x, idx) => ({ row: x.row, perTruck: x.perTruck, rank: idx + 1 }));
}

const ORDINAL = ['th', 'st', 'nd', 'rd'];
export function ordinal(n: number): string {
  const v = n % 100;
  return `${n}${ORDINAL[(v - 20) % 10] ?? ORDINAL[v] ?? ORDINAL[0]}`;
}

/** "Humans rank 3rd of 6 driving styles" (or a neutral line when no humans are on the board). */
export function standingsHeadline(ranked: readonly StyleRank[]): string {
  if (!ranked.length) return 'No deliveries in the last 60 game-min yet.';
  const humans = ranked.find((r) => r.row.strat === 'Human');
  if (!humans) return `${ranked.length} driving styles on the floor · no human drivers yet`;
  return `Humans rank ${ordinal(humans.rank)} of ${ranked.length} driving styles`;
}

export function mountTeamStandings(root: HTMLElement, ctx: UiCtx): UiModule {
  const view = new KeyedView(root);
  return {
    update() {
      const { store, actions } = ctx;
      const open = store.ui.flyout === 'board';
      root.hidden = !open;
      if (!open) {
        view.invalidate();
        return;
      }
      const ranked = store.welcomed && store.board ? rankStylesPerTruck(store.board) : null;
      view.render(JSON.stringify([ranked, store.highlightStrategy]), () => {
        const close = el('button', {
          class: 'x',
          text: '✕',
          title: 'Close Team Standings (Esc)',
          attrs: { type: 'button', 'aria-label': 'Close Team Standings' },
          onClick: () => actions.setFlyout(null),
        });
        const head = el('div', { class: 'fly-head' }, [el('h3', { text: 'Team Standings' }), close]);
        if (!ranked) return [head, el('div', { class: 'empty', text: 'Waiting for the site…' })];
        const rows = ranked.map((r) => {
          const me = r.row.strat === 'Human';
          const hl = store.highlightStrategy === r.row.strat;
          const tr = el(
            'tr',
            {
              class: `${me ? 'me' : ''}${hl ? ' hl' : ''}`.trim(),
              title: hl ? 'Click to clear the floor highlight' : `Click to highlight ${r.row.strat} on the floor`,
              attrs: { 'aria-pressed': String(hl), tabindex: '0' },
              onClick: () => actions.setHighlight(hl ? null : r.row.strat),
            },
            [
              el('td', { class: 'num', text: String(r.rank) }),
              el('td', {}, [swatch(teamColor(r.row.strat)), ' ', el('b', { text: me ? 'Humans' : r.row.strat })]),
              el('td', { class: 'num r', text: String(r.row.vehicles) }),
              el('td', { class: 'num r b', text: fmt(r.perTruck, 1) }),
              el('td', { class: 'num r', text: fmt(r.row.onTimePct, 0, '%') }),
              el('td', { class: 'num r', text: fmt(r.row.kwhPerOrder, 2) }),
              el('td', { class: `num r${r.row.incidents ? ' bad b' : ''}`, text: String(r.row.incidents) }),
            ],
          );
          tr.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              actions.setHighlight(hl ? null : r.row.strat);
            }
          });
          return tr;
        });
        return [
          head,
          el('div', { class: 'headline', attrs: { 'data-role': 'standings-headline' }, text: standingsHeadline(ranked) }),
          el('table', { class: 'tbl' }, [
            el('thead', {}, [
              el('tr', {}, [
                el('th', { text: '#' }),
                el('th', { text: 'Style' }),
                el('th', { class: 'r', text: 'Trucks' }),
                el('th', { class: 'r', text: 'Per truck/hr', title: 'Orders delivered per game-hour per vehicle (rolling 60m)' }),
                el('th', { class: 'r', text: 'On-time' }),
                el('th', { class: 'r', text: 'kWh/order' }),
                el('th', { class: 'r', text: 'Incid.', title: 'Collisions / incidents in the last 60 game-min' }),
              ]),
            ]),
            el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { attrs: { colspan: '7' }, class: 'muted', text: 'No deliveries in the last 60 game-min.' })])]),
          ]),
          el('div', {
            class: 'note',
            text: 'Ranked per truck so bigger teams don’t win on headcount. Rolling 60 game-min. Click a row to highlight that team on the floor.',
          }),
        ];
      });
    },
  };
}
