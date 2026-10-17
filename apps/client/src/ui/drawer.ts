/**
 * Right drawer (mock lines 174-188, renderDrawer 1911-1927): Leaderboard / Value / Days /
 * Events / Brain log. Toggled with H or the toolbar's History button.
 */
import { leaderboard, STRAT_ORDER, type StrategyName } from '@warehouse/sim';
import { DRAWER_TABS, type DrawerTab } from '../state.js';
import type { UiCtx, UiModule } from './context.js';
import { button, el, KeyedView, swatch } from './dom.js';
import { DASH, eventColor, teamColor, timeOfDay } from './format.js';
import { hallRows, leaderboardView, leaderRowEl } from './leaderboard.js';
import { valueChartBlock } from './valueChart.js';

export const DRAWER_TAB_LABEL: Record<DrawerTab, string> = {
  leaderboard: 'Leaderboard',
  value: 'Value',
  days: 'Days',
  events: 'Events',
  brain: 'Brain log',
};

export function mountDrawer(drawer: HTMLElement, ctx: UiCtx): UiModule {
  const { store, actions } = ctx;
  const tabs = DRAWER_TABS.map((tab) => {
    const b = button(DRAWER_TAB_LABEL[tab], 'btn small', () => actions.setDrawer(true, tab));
    b.setAttribute('role', 'tab');
    return { tab, b };
  });
  const body = el('div', { class: 'drawer-body', attrs: { role: 'tabpanel' } });
  const view = new KeyedView(body);
  drawer.replaceChildren(
    el('div', { class: 'drawer-head' }, [
      el('div', { class: 'drawer-tabs', attrs: { role: 'tablist' } }, tabs.map((t) => t.b)),
      button('✕', 'btn small', () => actions.setDrawer(false), 'Close [H]'),
    ]),
    body,
    el('div', { class: 'drawer-foot muted small', text: 'History is kept by the site server.' }),
  );

  const renderTab = (tab: DrawerTab): Array<HTMLElement | SVGSVGElement> => {
    const w = store.world;
    if (!store.welcomed) return [el('div', { class: 'empty', text: 'Waiting for the site…' })];
    switch (tab) {
      case 'leaderboard': {
        const lb = leaderboard(w);
        const v = leaderboardView(lb, store.renderMyVid(), lb.length);
        const openFullBtn = button(
          '🏆 Full Leaderboard & Silly Awards [L]',
          'btn small lb-open-modal-btn',
          () => actions.showLeaderboardModal(true, 'all'),
          'Open the full-screen Leaderboard & Silly Superlatives modal [L]',
        );
        return [
          openFullBtn,
          el('div', { class: 'label sub', text: 'This shift' }),
          ...v.rows.map((r) => leaderRowEl(r, () => actions.select(r.row.id))),
          w.hallOfFame.length ? el('div', { class: 'label sub', text: 'Hall of fame' }) : el('span'),
          ...hallRows(w, 10),
          el('div', { class: 'label sub', text: 'Network (lifetime)' }),
          ...(store.network.leaderboard.length
            ? store.network.leaderboard
                .filter((e) => !e.isBot)
                .slice(0, 10)
                .map((e, i) =>
                  el('div', { class: `lb-row num${store.you?.clientId === e.clientId ? ' row-hl b' : ''}` }, [
                    el('span', { class: 'rank muted', text: String(i + 1) }),
                    el('span', { class: 'grow ellipsis', text: `${e.name}${e.siteId ? ` · ${e.siteId.toUpperCase()}` : ''}` }),
                    el('span', { class: 'muted small', text: `${e.deliveries} del` }),
                    el('span', { class: 'pts b', text: String(Math.round(e.lifetimePoints ?? e.points ?? 0)) }),
                  ]),
                )
            : [el('div', { class: 'empty', text: store.network.error ?? 'No network leaderboard yet.' })]),
        ];
      }
      case 'value':
        return valueChartBlock(ctx, 340, 160);
      case 'days': {
        if (!w.history.length) {
          return [el('div', { class: 'empty', text: 'No finished days yet. A day closes at 06:00 game time (24 real minutes).' })];
        }
        return w.history
          .slice()
          .reverse()
          .map((h) =>
            el('div', { class: 'day' }, [
              el('div', { class: 'day-head' }, [el('b', { text: `Day ${h.day}` }), el('span', { class: 'muted', text: `Best: ${h.winner}` })]),
              el('div', {
                class: 'num',
                text: `${h.shipped} shipped · ${h.onTimePct ?? DASH}% on time · ${h.incidents} incidents · ${h.lost} lost · ${h.poaches} poaches`,
              }),
              el(
                'div',
                { class: 'day-grid num small' },
                (STRAT_ORDER as StrategyName[])
                  .filter((s) => h.per?.[s] && (h.per[s].shipped || s !== 'Human'))
                  .flatMap((s) => [
                    el('span', {}, [swatch(teamColor(s)), s]),
                    el('span', { class: 'r', text: String(h.per[s].shipped) }),
                    el('span', { class: 'r', text: `${h.per[s].onTimePct ?? DASH}%` }),
                    el('span', { class: `r${h.per[s].incidents ? ' bad' : ''}`, text: String(h.per[s].incidents) }),
                  ]),
              ),
            ]),
          );
      }
      case 'events':
        return store.events.length
          ? store.events.map((e) =>
              el('div', { class: 'log-row' }, [
                el('span', { class: 'muted num', text: timeOfDay(e.t) }),
                el('span', { style: { color: eventColor(e.type) }, text: ' ● ' }),
                e.text,
              ]),
            )
          : [el('div', { class: 'empty', text: 'No events yet.' })];
      case 'brain':
        return store.brainLog.length
          ? store.brainLog.map((b) =>
              el('div', { class: `log-row${b.error ? ' bad' : ''}` }, [
                el('span', { class: 'muted num', text: timeOfDay(b.t) }),
                ' ',
                b.text,
                b.model ? el('span', { class: 'muted small', text: ` · ${b.model}${typeof b.latencyMs === 'number' ? ` · ${Math.round(b.latencyMs)} ms` : ''}` }) : null,
              ]),
            )
          : [el('div', { class: 'empty', text: 'No brain calls recorded yet.' })];
    }
  };

  return {
    update() {
      const open = store.ui.drawerOpen;
      drawer.classList.toggle('closed', !open);
      drawer.setAttribute('aria-hidden', String(!open));
      drawer.inert = !open;
      for (const t of tabs) {
        const on = t.tab === store.ui.drawerTab;
        t.b.classList.toggle('on', on);
        t.b.setAttribute('aria-selected', String(on));
      }
      if (!open) return;
      const tab = store.ui.drawerTab;
      const w = store.world;
      const key =
        tab === 'events'
          ? `${store.events.length}|${store.events[0]?.t}|${store.events[0]?.text}`
          : tab === 'brain'
            ? `${store.brainLog.length}|${store.brainLog[0]?.t}|${store.brainLog[0]?.text}`
            : tab === 'days'
              ? String(w.history.length)
              : tab === 'value'
                ? `${store.ui.valueWindow}|${w.valueSeries.length}|${w.valueSeries[w.valueSeries.length - 1]?.t}`
                : `${Math.round(w.t)}|${store.network.updatedAt}|${w.hallOfFame.length}`;
      view.render(`${store.welcomed}|${tab}|${key}`, () => renderTab(tab));
    },
  };
}
