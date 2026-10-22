/**
 * "Win the shift" leaderboard (mock updateLb, lines 2004-2021): top 5 + my row, rules,
 * site record, agent decision counts and hall of fame. (Mode voting lives in the top bar.)
 */
import { leaderboard, type World } from '@warehouse/sim';
import type { UiCtx, UiModule } from './context.js';
import { button, el, KeyedView, swatch, type Child } from './dom.js';
import { difficultyLabel, plural, shiftLeft, teamColor } from './format.js';
import { createPanel, type PanelHandle } from './panel.js';

export type LeaderRow = ReturnType<typeof leaderboard>[number];

export interface LeaderboardView<T> {
  rows: Array<{ rank: number; row: T; mine: boolean }>;
  /** True when my row is appended after a ⋯ gap. */
  gap: boolean;
  myRank: number | null;
}

/** Top `top` rows plus (after a gap) my own row and any other human drivers further down. */
export function leaderboardView<T extends { id: string; human?: boolean }>(
  rows: readonly T[],
  myVid: string | null,
  top = 5,
): LeaderboardView<T> {
  const myIdx = myVid ? rows.findIndex((r) => r.id === myVid) : -1;
  const out = rows.slice(0, top).map((row, i) => ({ rank: i + 1, row, mine: i === myIdx }));
  let gap = false;
  for (let i = top; i < rows.length; i++) {
    const row = rows[i];
    if (i === myIdx || Boolean(row.human)) {
      if (i > (out[out.length - 1]?.rank ?? 0)) gap = true;
      out.push({ rank: i + 1, row, mine: i === myIdx });
    }
  }
  return { rows: out, gap, myRank: myIdx >= 0 ? myIdx + 1 : null };
}

export function leaderboardHeader(myRank: number | null, t: number): string {
  return `Win the shift${myRank ? ` · #${myRank}` : ''} · ends in ${shiftLeft(t)}`;
}

export function leaderRowEl(r: { rank: number; row: LeaderRow; mine: boolean }, onClick: () => void): HTMLElement {
  const who = r.row.human && r.row.driver ? ` · ${r.row.driver}` : '';
  const modeTag = r.row.human
    ? `${r.row.runMode === 'freerange' ? '🌐 Free' : '⏱️ Blitz'}${r.row.streak && r.row.streak >= 3 ? ` · 🔥×${r.row.streak}` : ''}`
    : r.row.strat;
  return el(
    'button',
    {
      class: `board-row lb-row num${r.mine ? ' row-hl b' : ''}`,
      attrs: { type: 'button' },
      title: `Select ${r.row.id}`,
      onClick,
    },
    [
      el('span', { class: 'rank muted', text: String(r.rank) }),
      swatch(r.row.human ? teamColor('Human') : teamColor(r.row.strat)),
      el('span', { class: 'grow ellipsis', text: `${r.row.id}${who}${r.mine ? ' ★ you' : ''}` }),
      el('span', { class: 'muted small', text: modeTag }),
      el('span', { class: 'pts b', text: String(Math.round(r.row.pts)) }),
    ],
  );
}

export function hallRows(w: World, limit = 5): HTMLElement[] {
  return w.hallOfFame.slice(0, limit).map((h, i) =>
    el('div', { class: `lb-row num${h.human ? ' row-hl b' : ''}`, title: `${h.shift} · ${h.diff} · ${h.pts} raw pts` }, [
      el('span', { class: 'rank muted', text: String(i + 1) }),
      el('span', { class: 'grow ellipsis' }, [
        `${h.human && h.driver ? h.driver : h.id}${h.human ? ' ★' : ''} `,
        el('span', { class: 'muted small', text: `${h.strat} · ${difficultyLabel(h.diff)}` }),
      ]),
      el('span', { class: 'pts b', text: String(h.scored) }),
    ]),
  );
}

export function mountLeaderboard(zone: HTMLElement, ctx: UiCtx): UiModule & { panel: PanelHandle } {
  const header = el('div', { class: 'lb-head num' });
  const rowsEl = el('div');
  const rows = new KeyedView(rowsEl);
  const restEl = el('div');
  const rest = new KeyedView(restEl);
  const body = el('div', { class: 'leaderboard' }, [header, rowsEl, restEl]);
  const panel = createPanel(
    {
      id: 'leaderboard',
      title: 'Leaderboard',
      zone: 'right',
      defaultState: 'open',
      summary: () => {
        const s = ctx.store;
        if (!s.welcomed) return '';
        const v = leaderboardView(leaderboard(s.world), s.renderMyVid());
        return leaderboardHeader(v.myRank, s.world.t);
      },
    },
    body,
  );
  zone.append(panel.root);

  return {
    panel,
    update() {
      const { store, actions } = ctx;
      if (!store.welcomed) {
        header.textContent = '';
        rows.render('wait', () => [el('div', { class: 'empty', text: 'Waiting for the site…' })]);
        rest.render('wait', () => []);
        return;
      }
      const w = store.world;
      const lb = leaderboard(w);
      const view = leaderboardView(lb, store.renderMyVid());
      header.textContent = leaderboardHeader(view.myRank, w.t);
      rows.render(
        JSON.stringify(
          view.rows.map((r) => [
            r.rank,
            r.row.id,
            Math.round(r.row.pts),
            r.row.driver,
            r.mine,
            r.row.strat,
            r.row.runMode,
            r.row.streak,
          ]),
        ),
        () => {
          const out: Child[] = [];
          view.rows.forEach((r, i) => {
            if (i > 0 && r.rank > view.rows[i - 1].rank + 1) {
              out.push(el('div', { class: 'gap muted', text: '⋯' }));
            }
            out.push(leaderRowEl(r, () => actions.select(r.row.id)));
          });
          if (!out.length) out.push(el('div', { class: 'empty', text: 'No vehicles on the floor.' }));
          return out;
        },
      );
      const t = w.totals;
      const dc = t.decisions;
      const dn = dc.reroute + dc.wait + dc.push;
      const openModalBtn = button(
        '🏆 Full Leaderboard & Silly Awards [L]',
        'btn small lb-open-modal-btn',
        () => actions.showLeaderboardModal(true, 'all'),
        'Open the full-screen Leaderboard & Silly Superlatives modal [L]',
      );
      openModalBtn.dataset.action = 'open-leaderboard-modal';
      rest.render(
        JSON.stringify([t.wins, t.humanShifts, dc, t.hazards, w.hallOfFame.length, w.hallOfFame[0]?.scored]),
        () => [
          openModalBtn,
          el('div', { class: 'hint' }, [
            '+10 per pallet, +40 P0, streak up to 1.5×, −15 per crash.',
            t.humanShifts
              ? el('div', { text: `Human drivers on this site: ${plural(t.wins, 'win')} in ${plural(t.humanShifts, 'shift')}.` })
              : null,
          ]),
          el('div', {
            class: 'hint num',
            title: 'Each agent scores reroute, wait and push-through from its own policy, cargo and deadline slack.',
            text: `Spills ${t.hazards} · agent calls ${dn}${dn ? ` (reroute ${dc.reroute}, wait ${dc.wait}, push ${dc.push})` : ''}`,
          }),
          w.hallOfFame.length ? el('div', { class: 'label sub', text: 'Hall of fame' }) : null,
          ...hallRows(w),
        ],
      );
      panel.refreshSummary();
    },
  };
}
