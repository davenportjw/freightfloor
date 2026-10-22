/**
 * Floor KPI view model (pure) used by the Floor view KPI strip (ui/floorView.ts):
 * day KPIs, site badge, brain health, connection.
 */
import type { BrainHealthMessage } from '@warehouse/protocol';
import { getSiteTheme, phaseText, type World } from '@warehouse/sim';
import type { ClientStore, PhaseInfo } from '../state.js';
import { clockLine, DASH, onTimeText } from './format.js';

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
    siteTitle: `${theme.city} — ${theme.cargoLabel}`,
    brain,
    conn,
    live: store.conn.status === 'open' && (store.phaseInfo?.phase ?? w.phase) === 'running',
  };
}

export function kpiSummary(v: Pick<KpiView, 'clock' | 'shipped' | 'onTime'>): string {
  if (v.clock === DASH) return DASH;
  return `${v.clock} · ${v.shipped} shipped · ${v.onTime} on-time`;
}
