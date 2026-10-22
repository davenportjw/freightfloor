/**
 * Tab → Standings sheet (820 px, two columns): live drivers table (#, Driver, Pts, Best ×) with my
 * row tinted, the gap to the next place, and the difficulty vote (real `voteDifficulty`).
 */
import type { DifficultyLevel } from '@warehouse/protocol';
import { leaderboard } from '@warehouse/sim';
import type { UiCtx, UiModule } from './context.js';
import { el, KeyedView } from './dom.js';
import { DASH, difficultyLabel, difficultyTooltip, VOTE_LEVELS, voteCounts, voteLevelOf } from './format.js';
import { leaderboardView } from './leaderboard.js';

/** Points needed to pass the driver directly above (null when first / unknown). */
export function gapToNext(rows: ReadonlyArray<{ id: string; pts: number }>, myVid: string | null): { gap: number; aheadId: string } | null {
  const i = myVid ? rows.findIndex((r) => r.id === myVid) : -1;
  if (i <= 0) return null;
  return { gap: Math.max(0, Math.ceil(rows[i - 1].pts - rows[i].pts)), aheadId: rows[i - 1].id };
}

export function mountStandings(root: HTMLElement, ctx: UiCtx): UiModule {
  const view = new KeyedView(root);
  return {
    update() {
      const { store, actions } = ctx;
      const open = store.activeOverlay() === 'standings';
      root.hidden = !open;
      if (!open) {
        view.invalidate();
        return;
      }
      const rows = store.welcomed ? leaderboard(store.world) : [];
      const myVid = store.myVehicle()?.id ?? null;
      const lv = leaderboardView(rows, myVid, 8);
      const gap = gapToNext(rows, myVid);
      const votes = store.world.difficultyVotes ?? {};
      const counts = voteCounts(votes);
      const myVote = voteLevelOf(store.you?.clientId ? votes[store.you.clientId] : null);
      const current = voteLevelOf(store.world.difficulty);
      const best = (id: string): string => {
        const c = store.vehicle(id)?.comboBest;
        return typeof c === 'number' ? `×${c.toFixed(1)}` : DASH;
      };
      const key = JSON.stringify([
        lv.rows.map((r) => [r.rank, r.row.id, r.row.driver, Math.round(r.row.pts), r.mine, best(r.row.id)]),
        gap,
        counts,
        myVote,
        current,
        store.welcomed,
      ]);
      view.render(key, () => {
        const drivers = el('div', { class: 'col' }, [
          el('h3', { text: 'Drivers' }),
          store.welcomed
            ? el('table', { class: 'tbl' }, [
                el('thead', {}, [
                  el('tr', {}, [
                    el('th', { text: '#' }),
                    el('th', { text: 'Driver' }),
                    el('th', { class: 'r', text: 'Pts' }),
                    el('th', { class: 'r', text: 'Best ×', title: 'Best fare combo this run' }),
                  ]),
                ]),
                el(
                  'tbody',
                  {},
                  lv.rows.length
                    ? lv.rows.map((r) =>
                        el('tr', { class: r.mine ? 'me' : '' }, [
                          el('td', { class: 'num', text: String(r.rank) }),
                          el('td', { class: 'ellipsis', text: `${r.row.human && r.row.driver ? r.row.driver : r.row.id}${r.mine ? ' (you)' : ''}` }),
                          el('td', { class: 'num r b', text: String(Math.round(r.row.pts)) }),
                          el('td', { class: 'num r', text: best(r.row.id) }),
                        ]),
                      )
                    : [el('tr', {}, [el('td', { attrs: { colspan: '4' }, class: 'muted', text: 'No drivers on the floor yet.' })])],
                ),
              ])
            : el('div', { class: 'empty', text: 'Waiting for the site…' }),
        ]);
        const voteBtns = VOTE_LEVELS.map((lvl) =>
          el(
            'button',
            {
              class: `seg-btn${myVote === lvl ? ' on' : ''}${current === lvl ? ' current' : ''}`,
              title: `${difficultyTooltip(lvl)}${current === lvl ? ' · current' : ''}`,
              attrs: { type: 'button', 'data-vote': lvl },
              onClick: () => actions.vote(lvl as DifficultyLevel),
            },
            [`${difficultyLabel(lvl)} `, el('span', { class: 'num muted', text: String(counts[lvl]) })],
          ),
        );
        const side = el('div', { class: 'col' }, [
          el('h3', { text: 'Gap to next place' }),
          el('div', { class: 'gap-big num', text: gap ? `${gap.gap} pts` : lv.myRank === 1 ? 'You lead' : DASH }),
          el('div', { class: 'muted', text: gap ? `to pass ${gap.aheadId}` : lv.myRank === 1 ? 'Hold the lead until the shift ends.' : 'Drive to get on the board.' }),
          el('h3', { text: 'Difficulty vote' }),
          el('div', { class: 'seg-toggle' }, voteBtns),
          el('div', { class: 'muted small', text: `Current: ${current ? difficultyLabel(current) : DASH} · your vote: ${myVote ? difficultyLabel(myVote) : DASH}` }),
        ]);
        return [
          el('div', { class: 'sheet-head' }, [el('h2', { text: 'Standings' }), el('span', { class: 'muted', text: 'Hold Tab to peek · Esc closes' })]),
          el('div', { class: 'cols' }, [drivers, side]),
        ];
      });
    },
  };
}
