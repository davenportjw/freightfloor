/**
 * Network panel: the real `/api/network` site list (no invented sites). Shows loading / error /
 * empty states and a Switch button with pending / error / done feedback.
 */
import type { SiteStatus } from '@warehouse/protocol';
import { getSiteTheme } from '@warehouse/sim';
import type { ClientStore, NetworkState } from '../state.js';
import type { UiCtx, UiModule } from './context.js';
import { button, el, KeyedView } from './dom.js';
import { DASH } from './format.js';
import { createPanel, type PanelHandle } from './panel.js';
import { isDriverEntry, maxDriversOf } from './presence.js';

export function canSwitchTo(site: SiteStatus, currentSiteId: string | null, net: NetworkState): boolean {
  if (site.id === currentSiteId) return false;
  if (net.switching?.status === 'pending') return false;
  if (site.state === 'offline') return false;
  return site.maxDrivers === undefined || site.drivers < site.maxDrivers;
}

export function reconcileNetworkSites(store: ClientStore): SiteStatus[] {
  return store.network.sites.map((s) => {
    if (!store.welcomed || s.id !== store.siteId) return s;
    const hasLivePresence = store.presence.length > 0;
    const drivers = hasLivePresence ? store.presence.filter(isDriverEntry).length : s.drivers;
    const spectators = hasLivePresence ? store.presence.length - drivers : s.spectators;
    const maxDrivers = maxDriversOf(store) ?? s.maxDrivers;
    return {
      ...s,
      drivers,
      spectators,
      maxDrivers,
      tier: store.world.tier,
      shipped: store.world.totals.shipped,
      phase: store.phaseInfo?.phase ?? store.world.phase,
    };
  });
}

export function networkSummary(net: NetworkState): string {
  if (net.status === 'error') return 'unavailable';
  if (!net.sites.length) return net.status === 'loading' ? 'loading…' : DASH;
  const live = net.sites.filter((s) => s.state !== 'offline').length;
  return `${live}/${net.sites.length} sites online`;
}

export function mountNetwork(zone: HTMLElement, ctx: UiCtx): UiModule & { panel: PanelHandle } {
  const body = el('div', { class: 'network' });
  const view = new KeyedView(body);
  const panel = createPanel(
    {
      id: 'network',
      title: 'Network',
      zone: 'right',
      defaultState: 'collapsed',
      summary: () => networkSummary(ctx.store.network),
    },
    body,
  );
  zone.append(panel.root);

  return {
    panel,
    update() {
      const { store, actions } = ctx;
      const net = store.network;
      const sites = reconcileNetworkSites(store);
      panel.refreshSummary();
      view.render(JSON.stringify([net.status, net.error, net.switching, net.updatedAt, sites, store.siteId]), () => {
        const kids: HTMLElement[] = [];
        if (net.status === 'error') kids.push(el('div', { class: 'form-error', text: `Network status unavailable: ${net.error ?? 'unknown error'}` }));
        if (!sites.length) {
          kids.push(el('div', { class: 'empty', text: net.status === 'loading' || net.status === 'idle' ? 'Loading sites…' : 'The lobby reports no sites.' }));
        }
        for (const s of sites) {
          const here = s.id === store.siteId;
          const theme = getSiteTheme(s.id);
          const sw = button(here ? 'You are here' : 'Switch', `btn small${here ? ' on' : ''}`, () => actions.switchSite(s.id));
          sw.disabled = !canSwitchTo(s, store.siteId, net);
          if (!here && sw.disabled && s.maxDrivers !== undefined && s.drivers >= s.maxDrivers) sw.title = 'Site is full';
          kids.push(
            el('div', { class: `site-row${here ? ' row-hl' : ''}`, title: `${theme.subtitle} — ${theme.cargoLabel}` }, [
              el('span', { class: `dot state-${s.state}`, title: s.state }),
              el('div', { class: 'grow' }, [
                el('b', { text: `${s.id.toUpperCase()} · ${theme.name}` }),
                el('div', {
                  class: 'muted small num',
                  text: `${theme.subtitle} · ${s.state} · ${s.phase} · tier ${s.tier} · ${s.drivers}/${s.maxDrivers ?? DASH} drivers · ${s.spectators} watching · ${s.shipped} shipped`,
                }),
              ]),
              sw,
            ]),
          );
        }
        if (net.switching) {
          kids.push(
            el('div', {
              class: net.switching.status === 'error' ? 'form-error' : 'hint',
              attrs: { role: 'status' },
              text: net.switching.message,
            }),
          );
        }
        kids.push(
          el('div', { class: 'net-foot' }, [
            el('span', { class: 'muted small', text: net.updatedAt ? `Updated ${new Date(net.updatedAt).toLocaleTimeString()}` : '' }),
            button('Refresh', 'btn small', () => actions.refreshNetwork()),
          ]),
        );
        return kids;
      });
    },
  };
}
