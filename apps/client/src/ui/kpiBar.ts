/**
 * Top-left KPI bar: live dot, clock, phase pill, mode/speed buttons, day KPIs, site badge, brain health, connection.
 */
import type { BrainHealthMessage, DifficultyLevel } from '@warehouse/protocol';
import { getSiteTheme, phaseText, type World } from '@warehouse/sim';
import type { ClientStore, PhaseInfo } from '../state.js';
import type { UiCtx, UiModule } from './context.js';
import { button, el } from './dom.js';
import {
  clockLine,
  DASH,
  difficultyLabel,
  difficultyTooltip,
  onTimeText,
  plural,
  VOTE_LEVELS,
  voteCounts,
  voteLevelOf,
  type VoteLevel,
} from './format.js';
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
  siteTitle?: string;
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
  const activeSiteId = store.siteId ?? w.siteId;
  const theme = getSiteTheme(activeSiteId);
  return {
    clock: clockLine(w.t),
    phase: phaseLabel(w, store.phaseInfo, nowMs),
    shipped: String(d.shipped),
    onTime: onTimeText(d),
    incidents: String(d.incidents),
    backlog: String(w.orders.filter((o) => o.state === 'open' || o.state === 'claimed').length),
    lost: String(d.lost),
    site: `${activeSiteId.toUpperCase()} · ${theme.name} · Tier ${w.tier}`,
    siteTitle: `${theme.subtitle} — ${theme.cargoLabel}`,
    brain,
    conn,
    live: store.conn.status === 'open' && (store.phaseInfo?.phase ?? w.phase) === 'running',
  };
}

export function kpiSummary(v: Pick<KpiView, 'clock' | 'shipped' | 'onTime'>): string {
  if (v.clock === DASH) return DASH;
  return `${v.clock} · ${v.shipped} shipped · ${v.onTime} on-time`;
}

function kpi(label: string, title?: string): { root: HTMLElement; value: HTMLElement } {
  const value = el('div', { class: 'kpi-value num', text: DASH });
  return { root: el('div', { class: 'kpi', title }, [el('div', { class: 'label', text: label }), value]), value };
}

export function mountKpiBar(zone: HTMLElement, ctx: UiCtx): UiModule & { panel: PanelHandle } {
  const { actions, store } = ctx;
  const liveDot = el('span', { class: 'live-dot', attrs: { 'aria-hidden': 'true' } });
  const clock = el('span', { class: 'clock num', text: DASH, title: 'Current shift day, game clock, and active shift' });
  const phase = el('span', { class: 'pill', text: DASH, title: 'Simulation state (Running, Shift Change, or Resuming)' });
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
  const k = {
    shipped: kpi('Shipped', 'Pallets delivered to dock bays today'),
    onTime: kpi('On-time', 'Share of today’s deliveries completed before their deadline'),
    incidents: kpi('Incidents', 'Vehicle collisions and safety incidents today (−15 pts each)'),
    backlog: kpi('Backlog', 'Open or claimed orders currently waiting on the floor'),
    lost: kpi('Lost', 'Orders that expired or were destroyed in crashes today'),
  };
  const site = el('span', { class: 'pill site-badge num', title: 'Site ID and current warehouse wing tier' });
  const brain = el('span', { class: 'pill brain-pill num' });
  const conn = el('span', { class: 'pill conn-pill', title: 'Live WebSocket connection status to this warehouse site' });
  const bar = el('div', { class: 'kpi-bar' }, [
    el('div', { class: 'kpi-group' }, [liveDot, clock, phase]),
    el('span', { class: 'vsep' }),
    el('div', { class: 'kpi-group mode-group' }, [
      el('span', { class: 'label', text: 'Mode' }),
      ...VOTE_LEVELS.map((lvl) => modeButtons.get(lvl)!),
    ]),
    el('span', { class: 'vsep' }),
    el('div', { class: 'kpi-group' }, Object.values(k).map((x) => x.root)),
    el('span', { class: 'vsep' }),
    el('div', { class: 'kpi-group' }, [site, el('span', { class: 'label', text: 'Brain' }), brain, conn]),
  ]);
  const hint = el('div', {
    class: 'hint',
    text: 'Facility health for the current day. Keep backlog & incidents low; Brain shows AI dispatcher latency & safety.',
  });
  const body = el('div', { class: 'kpi-panel-body' }, [bar, hint]);
  const panel = createPanel(
    {
      id: 'kpi',
      title: 'Floor',
      zone: 'left',
      defaultState: 'open',
      autoCollapse: true,
      className: 'panel-kpi',
      summary: () => kpiSummary(kpiView(ctx.store, Date.now())),
    },
    body,
  );
  zone.append(panel.root);

  return {
    panel,
    update() {
      const v = kpiView(store, Date.now());
      clock.textContent = v.clock;
      phase.textContent = v.phase;
      k.shipped.value.textContent = v.shipped;
      k.onTime.value.textContent = v.onTime;
      k.incidents.value.textContent = v.incidents;
      k.backlog.value.textContent = v.backlog;
      k.lost.value.textContent = v.lost;
      site.textContent = v.site;
      if (v.siteTitle) site.title = v.siteTitle;
      brain.textContent = v.brain.text;
      brain.title = v.brain.title;
      brain.dataset.tone = v.brain.tone;
      conn.textContent = v.conn.text;
      conn.dataset.tone = v.conn.tone;
      liveDot.classList.toggle('on', v.live);
      liveDot.title = v.live ? 'Live' : v.conn.text;
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
      panel.refreshSummary();
    },
  };
}

