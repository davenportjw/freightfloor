/**
 * Top-left KPI bar: live dot, clock, phase pill, day KPIs, site badge, brain health, connection.
 * Mirrors mock-v4 lines 56-78 (minus the speed buttons: the server owns sim speed).
 */
import type { BrainHealthMessage } from '@warehouse/protocol';
import { phaseText, type World } from '@warehouse/sim';
import type { ClientStore, PhaseInfo } from '../state.js';
import type { UiCtx, UiModule } from './context.js';
import { el } from './dom.js';
import { clockLine, DASH, onTimeText } from './format.js';
import { createPanel, type PanelHandle } from './panel.js';

export interface KpiView {
  clock: string;
  phase: string;
  shipped: string;
  onTime: string;
  incidents: string;
  backlog: string;
  lost: string;
  site: string;
  brain: { text: string; tone: 'ok' | 'bad' | 'none'; title: string };
  conn: { text: string; tone: 'ok' | 'warn' | 'bad' };
  live: boolean;
}

/** Phase pill text. `resumesAt` is epoch-ms (site server.ts), so the countdown uses wall time. */
export function phaseLabel(w: World, info: PhaseInfo | null, nowMs: number): string {
  const phase = info?.phase ?? w.phase;
  if (phase === 'resuming') {
    if (info?.resumesAt) return `Resuming in ${Math.max(0, Math.ceil((info.resumesAt - nowMs) / 1000))}s`;
    return 'Resuming';
  }
  return phaseText({ ...w, phase } as World);
}

export function brainHealthView(h: BrainHealthMessage | null): KpiView['brain'] {
  if (!h) return { text: DASH, tone: 'none', title: 'No brain health report received from the site yet.' };
  const text = `${h.ok ? 'OK' : 'Degraded'} · p50 ${Math.round(h.p50ms)} ms · ${h.errors1m} err/min`;
  const parts = [
    h.model ? `Model ${h.model}` : null,
    `Budget left $${h.budgetLeftUsd.toFixed(2)}`,
    typeof h.armorBlocks1h === 'number' ? `Model Armor blocks (1h): ${h.armorBlocks1h}` : null,
  ].filter(Boolean);
  return { text, tone: h.ok ? 'ok' : 'bad', title: parts.join(' · ') };
}

export function connView(store: Pick<ClientStore, 'conn'>): KpiView['conn'] {
  const { status, text } = store.conn;
  switch (status) {
    case 'open':
      return { text: 'Live', tone: 'ok' };
    case 'connecting':
      return { text: text || 'Connecting…', tone: 'warn' };
    case 'reconnecting':
      return { text: text || 'Reconnecting…', tone: 'warn' };
    case 'error':
      return { text: text || 'Connection error', tone: 'bad' };
    default:
      return { text: text || 'Offline', tone: 'warn' };
  }
}

export function kpiView(store: ClientStore, nowMs: number): KpiView {
  const brain = brainHealthView(store.brainHealth);
  const conn = connView(store);
  if (!store.welcomed) {
    return {
      clock: DASH,
      phase: DASH,
      shipped: DASH,
      onTime: DASH,
      incidents: DASH,
      backlog: DASH,
      lost: DASH,
      site: DASH,
      brain,
      conn,
      live: false,
    };
  }
  const w = store.world;
  const d = w.day;
  return {
    clock: clockLine(w.t),
    phase: phaseLabel(w, store.phaseInfo, nowMs),
    shipped: String(d.shipped),
    onTime: onTimeText(d),
    incidents: String(d.incidents),
    backlog: String(w.orders.filter((o) => o.state === 'open' || o.state === 'claimed').length),
    lost: String(d.lost),
    site: `${(store.siteId ?? w.siteId).toUpperCase()} · Tier ${w.tier}`,
    brain,
    conn,
    live: store.conn.status === 'open' && (store.phaseInfo?.phase ?? w.phase) === 'running',
  };
}

function kpi(label: string): { root: HTMLElement; value: HTMLElement } {
  const value = el('div', { class: 'kpi-value num', text: DASH });
  return { root: el('div', { class: 'kpi' }, [el('div', { class: 'label', text: label }), value]), value };
}

export function mountKpiBar(zone: HTMLElement, ctx: UiCtx): UiModule & { panel: PanelHandle } {
  const liveDot = el('span', { class: 'live-dot', attrs: { 'aria-hidden': 'true' } });
  const clock = el('span', { class: 'clock num', text: DASH });
  const phase = el('span', { class: 'pill', text: DASH });
  const k = {
    shipped: kpi('Shipped'),
    onTime: kpi('On-time'),
    incidents: kpi('Incidents'),
    backlog: kpi('Backlog'),
    lost: kpi('Lost'),
  };
  const site = el('span', { class: 'pill site-badge num', title: 'Site and facility tier' });
  const brain = el('span', { class: 'pill brain-pill num' });
  const conn = el('span', { class: 'pill conn-pill' });
  const body = el('div', { class: 'kpi-bar' }, [
    el('div', { class: 'kpi-group' }, [liveDot, clock, phase]),
    el('span', { class: 'vsep' }),
    el('div', { class: 'kpi-group' }, Object.values(k).map((x) => x.root)),
    el('span', { class: 'vsep' }),
    el('div', { class: 'kpi-group' }, [site, el('span', { class: 'label', text: 'Brain' }), brain, conn]),
  ]);
  const panel = createPanel(
    {
      id: 'kpi',
      title: 'Floor',
      zone: 'left',
      defaultState: 'open',
      autoCollapse: false,
      className: 'panel-kpi',
      summary: () => kpiView(ctx.store, Date.now()).clock,
    },
    body,
  );
  zone.append(panel.root);

  return {
    panel,
    update() {
      const v = kpiView(ctx.store, Date.now());
      clock.textContent = v.clock;
      phase.textContent = v.phase;
      k.shipped.value.textContent = v.shipped;
      k.onTime.value.textContent = v.onTime;
      k.incidents.value.textContent = v.incidents;
      k.backlog.value.textContent = v.backlog;
      k.lost.value.textContent = v.lost;
      site.textContent = v.site;
      brain.textContent = v.brain.text;
      brain.title = v.brain.title;
      brain.dataset.tone = v.brain.tone;
      conn.textContent = v.conn.text;
      conn.dataset.tone = v.conn.tone;
      liveDot.classList.toggle('on', v.live);
      liveDot.title = v.live ? 'Live' : v.conn.text;
      panel.refreshSummary();
    },
  };
}
