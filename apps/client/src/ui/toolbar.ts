/**
 * Top-right toolbar (mock lines 97-109): mode/speed selector, layers, camera, panel controls, history drawer, help.
 */
import type { DifficultyLevel } from '@warehouse/protocol';
import type { RenderLayers } from '../renderer.js';
import type { UiCtx, UiModule } from './context.js';
import { button, el } from './dom.js';
import {
  difficultyLabel,
  difficultyTooltip,
  plural,
  VOTE_LEVELS,
  voteCounts,
  voteLevelOf,
  type VoteLevel,
} from './format.js';

export function mountToolbar(zone: HTMLElement, ctx: UiCtx): UiModule {
  const { actions, store } = ctx;
  const modeButtons = new Map<VoteLevel, HTMLButtonElement>();
  for (const lvl of VOTE_LEVELS) {
    const b = button(
      difficultyLabel(lvl),
      'btn small mode-btn',
      () => actions.vote(lvl as DifficultyLevel),
      difficultyTooltip(lvl),
    );
    b.dataset.mode = lvl;
    modeButtons.set(lvl, b);
  }
  const layerBtn = (key: keyof RenderLayers, text: string, hot: string): HTMLButtonElement =>
    button(text, 'btn', () => actions.toggleLayer(key), `Toggle ${text} layer [${hot}]`);
  const routes = layerBtn('routes', 'Routes', '1');
  const traffic = layerBtn('traffic', 'Traffic', '2');
  const labels = layerBtn('labels', 'Labels', '3');
  const fold = button(
    'Fold',
    'btn',
    () => actions.foldPanels(),
    'Fold all open HUD panels into compact pills (or expand them)',
  );
  const panels = button(
    'Panels',
    'btn',
    () => actions.toggleDocks(),
    'Show or hide left & right side panels for an unobstructed floor view (Tab hides all HUD)',
  );
  const history = button('History', 'btn', () => actions.setDrawer(!store.ui.drawerOpen), 'History drawer [H]');
  const introBtn = button(
    'Intro & Rules ?',
    'btn intro-open-btn',
    () => actions.showHelp(true),
    'Open Intro, Rules & AI Concepts [?]',
  );
  introBtn.dataset.action = 'open-intro';
  const root = el('div', { class: 'hud toolbar', attrs: { role: 'toolbar', 'aria-label': 'Map controls' } }, [
    el('span', { class: 'label', text: 'Mode', title: 'Floor speed & difficulty mode (Easy · Medium · Hard · Turbo)' }),
    ...VOTE_LEVELS.map((lvl) => modeButtons.get(lvl)!),
    el('span', { class: 'vsep' }),
    el('span', { class: 'label', text: 'Layers' }),
    routes,
    traffic,
    labels,
    el('span', { class: 'vsep' }),
    button('−', 'btn', () => actions.zoomBy(0.8), 'Zoom out'),
    button('+', 'btn', () => actions.zoomBy(1.25), 'Zoom in'),
    button('Fit', 'btn', () => actions.fit(), 'Fit the floor'),
    el('span', { class: 'vsep' }),
    fold,
    panels,
    history,
    introBtn,
  ]);
  zone.append(root);
  return {
    update() {
      const w = store.world;
      const counts = voteCounts(w.difficultyVotes);
      const myVote = store.you ? voteLevelOf(w.difficultyVotes[store.you.clientId]) : null;
      const current = voteLevelOf(w.difficulty);
      const ready = store.welcomed && store.conn.status === 'open';
      for (const lvl of VOTE_LEVELS) {
        const b = modeButtons.get(lvl)!;
        const isCurrent = current === lvl;
        const isVoted = myVote === lvl;
        b.disabled = !ready;
        b.classList.toggle('on', isCurrent);
        b.classList.toggle('voted', isVoted);
        b.textContent = counts[lvl] > 0 ? `${difficultyLabel(lvl)} ${counts[lvl]}` : difficultyLabel(lvl);
        b.title = `${difficultyTooltip(lvl)}. ${plural(counts[lvl], 'vote')}${isVoted ? ' (yours)' : ''}.`;
        b.setAttribute('aria-pressed', String(isCurrent));
      }
      routes.classList.toggle('on', store.layers.routes);
      traffic.classList.toggle('on', store.layers.traffic);
      labels.classList.toggle('on', store.layers.labels);
      panels.classList.toggle('on', !store.ui.docksHidden);
      panels.title = store.ui.docksHidden
        ? 'Side panels hidden — click to show left & right panels'
        : 'Side panels visible — click to hide left & right panels for a clear floor view';
      history.classList.toggle('on', store.ui.drawerOpen);
      introBtn.classList.toggle('on', store.ui.helpOpen);
      for (const b of [routes, traffic, labels, panels, history, introBtn]) {
        b.setAttribute('aria-pressed', String(b.classList.contains('on')));
      }
    },
  };
}

