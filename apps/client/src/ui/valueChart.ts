/**
 * "Value created" chart (mock updateValueChart, lines 2035-2055). Series samples come from the
 * welcome snapshot + delta `stats.seriesAppend`; values are drawn relative to the window start.
 */
import type { ValueSample } from '@warehouse/protocol';
import type { UiCtx, UiModule } from './context.js';
import { button, el, KeyedView } from './dom.js';
import { createPanel, type PanelHandle } from './panel.js';

export const VALUE_WINDOWS: ReadonlyArray<[number, string]> = [
  [240, '4h'],
  [480, '8h'],
  [1440, '24h'],
];

export const VALUE_LINES = [
  { key: 'you', color: '#0D9488', name: 'Human drivers', width: 2.6 },
  { key: 'avg', color: '#64748B', name: 'Agent avg', width: 1.8 },
  { key: 'best', color: '#EA580C', name: 'Best agent', width: 1.8 },
] as const;

export interface ValueChartModel {
  enough: boolean;
  width: number;
  height: number;
  zeroY: number;
  lines: Array<{ key: string; color: string; name: string; width: number; last: number; path: string }>;
}

/** Pure: window the samples to `[now-window, now]` and build SVG paths relative to the first sample. */
export function valueChartModel(
  series: readonly ValueSample[],
  now: number,
  window: number,
  width = 270,
  height = 92,
): ValueChartModel {
  const pts = series.filter((p) => p.t >= now - window && p.t <= now);
  const base = pts[0] ?? { t: now, you: 0, avg: 0, best: 0 };
  const rel = VALUE_LINES.map((l) => ({ ...l, d: pts.map((p) => ({ t: p.t, v: p[l.key] - base[l.key] })) }));
  const vals = rel.flatMap((l) => l.d.map((p) => p.v));
  const max = Math.max(10, ...vals);
  const min = Math.min(0, ...vals);
  const x = (t: number): number => ((t - (now - window)) / window) * width;
  const y = (v: number): number => height - 4 - ((v - min) / (max - min)) * (height - 10);
  return {
    enough: pts.length > 1,
    width,
    height,
    zeroY: y(0),
    lines: rel.map((l) => ({
      key: l.key,
      color: l.color,
      name: l.name,
      width: l.width,
      last: l.d.length ? l.d[l.d.length - 1].v : 0,
      path: l.d.length > 1 ? 'M' + l.d.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' L') : '',
    })),
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function valueChartSvg(m: ValueChartModel): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(m.width));
  svg.setAttribute('height', String(m.height));
  svg.setAttribute('viewBox', `0 0 ${m.width} ${m.height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Value created over time');
  const zero = document.createElementNS(SVG_NS, 'line');
  zero.setAttribute('x1', '0');
  zero.setAttribute('x2', String(m.width));
  zero.setAttribute('y1', m.zeroY.toFixed(1));
  zero.setAttribute('y2', m.zeroY.toFixed(1));
  zero.setAttribute('stroke', '#E2E8F0');
  svg.append(zero);
  for (const l of m.lines) {
    if (!l.path) continue;
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', l.path);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', l.color);
    p.setAttribute('stroke-width', String(l.width));
    svg.append(p);
  }
  return svg;
}

/** Window buttons + chart + legend; shared by the right panel and the drawer's Value tab. */
export function valueChartBlock(ctx: UiCtx, width: number, height: number): Array<HTMLElement | SVGSVGElement> {
  const { store, actions } = ctx;
  const W = store.ui.valueWindow;
  const m = valueChartModel(store.world.valueSeries, store.world.t, W, width, height);
  const t = store.world.totals;
  return [
    el(
      'div',
      { class: 'chart-windows' },
      VALUE_WINDOWS.map(([mins, name]) => {
        const b = button(name, `btn small${W === mins ? ' on' : ''}`, () => {
          store.ui.valueWindow = mins;
          actions.refresh();
        });
        b.setAttribute('aria-pressed', String(W === mins));
        return b;
      }),
    ),
    m.enough ? valueChartSvg(m) : el('div', { class: 'empty', text: 'Collecting samples (one every 5 game-min)…' }),
    el(
      'div',
      { class: 'legend num' },
      m.lines.map((l) => el('span', { style: { color: l.color } }, [el('b', { text: l.name }), ` ${Math.round(l.last)}`])),
    ),
    el('div', {
      class: 'hint',
      text: `Value = pallet points + card bonuses − crashes. Cards done: humans ${t.cardsDone}, agents ${t.aiCardsDone}.`,
    }),
  ];
}

export function mountValueChart(zone: HTMLElement, ctx: UiCtx): UiModule & { panel: PanelHandle } {
  const body = el('div', { class: 'value-chart' });
  const view = new KeyedView(body);
  const panel = createPanel(
    {
      id: 'value',
      title: 'Value created',
      zone: 'right',
      defaultState: 'collapsed',
      summary: () => {
        const s = ctx.store;
        if (!s.welcomed) return '';
        const m = valueChartModel(s.world.valueSeries, s.world.t, s.ui.valueWindow);
        return m.lines.map((l) => Math.round(l.last)).join(' / ');
      },
    },
    body,
  );
  zone.append(panel.root);
  return {
    panel,
    update() {
      const s = ctx.store;
      if (!panel.isOpen()) {
        panel.refreshSummary();
        return;
      }
      const series = s.world.valueSeries;
      const last = series[series.length - 1];
      view.render(JSON.stringify([s.welcomed, s.ui.valueWindow, series.length, last?.t, Math.floor(s.world.t / 5)]), () =>
        s.welcomed ? valueChartBlock(ctx, 270, 92) : [el('div', { class: 'empty', text: 'Waiting for the site…' })],
      );
    },
  };
}
