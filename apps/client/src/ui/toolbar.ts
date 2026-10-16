/**
 * Top-right toolbar (mock lines 97-109): layers, camera, history drawer, help.
 */
import type { RenderLayers } from '../renderer.js';
import type { UiCtx, UiModule } from './context.js';
import { button, el } from './dom.js';

export function mountToolbar(zone: HTMLElement, ctx: UiCtx): UiModule {
  const { actions, store } = ctx;
  const layerBtn = (key: keyof RenderLayers, text: string, hot: string): HTMLButtonElement =>
    button(text, 'btn', () => actions.toggleLayer(key), `Toggle ${text} layer [${hot}]`);
  const routes = layerBtn('routes', 'Routes', '1');
  const traffic = layerBtn('traffic', 'Traffic', '2');
  const labels = layerBtn('labels', 'Labels', '3');
  const history = button('History', 'btn', () => actions.setDrawer(!store.ui.drawerOpen), 'History drawer [H]');
  const root = el('div', { class: 'hud toolbar', attrs: { role: 'toolbar', 'aria-label': 'Map controls' } }, [
    el('span', { class: 'label', text: 'Layers' }),
    routes,
    traffic,
    labels,
    el('span', { class: 'vsep' }),
    button('−', 'btn', () => actions.zoomBy(0.8), 'Zoom out'),
    button('+', 'btn', () => actions.zoomBy(1.25), 'Zoom in'),
    button('Fit', 'btn', () => actions.fit(), 'Fit the floor'),
    el('span', { class: 'vsep' }),
    history,
    button('?', 'btn', () => actions.showHelp(true), 'How to play [?]'),
  ]);
  zone.append(root);
  return {
    update() {
      routes.classList.toggle('on', store.layers.routes);
      traffic.classList.toggle('on', store.layers.traffic);
      labels.classList.toggle('on', store.layers.labels);
      history.classList.toggle('on', store.ui.drawerOpen);
      for (const b of [routes, traffic, labels, history]) b.setAttribute('aria-pressed', String(b.classList.contains('on')));
    },
  };
}
