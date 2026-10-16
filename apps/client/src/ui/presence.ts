/**
 * Presence pill (mock lines 110-114): who is on this site, driver cap, rename.
 * Every number comes from the server `presence` message and the welcome `limits`.
 */
import type { PresenceEntry } from '@warehouse/protocol';
import type { ClientStore } from '../state.js';
import type { UiCtx, UiModule } from './context.js';
import { button, el, KeyedView } from './dom.js';
import { DASH } from './format.js';

export interface PresenceView {
  me: string;
  drivers: number;
  maxDrivers: number | null;
  capText: string;
  full: boolean;
  players: Array<{ name: string; detail: string; mine: boolean; bot: boolean }>;
}

export function isDriverEntry(p: PresenceEntry): boolean {
  return p.role ? p.role === 'driver' : p.vid !== null;
}

/** Driver cap: welcome `limits.maxDrivers`, else the site heartbeat in /api/network. Never invented. */
export function maxDriversOf(store: Pick<ClientStore, 'limits' | 'network' | 'siteId'>): number | null {
  if (store.limits?.maxDrivers) return store.limits.maxDrivers;
  const site = store.network.sites.find((s) => s.id === store.siteId);
  return site?.maxDrivers ?? null;
}

export function presenceView(store: ClientStore): PresenceView {
  const drivers = store.presence.filter(isDriverEntry).length;
  const maxDrivers = maxDriversOf(store);
  const v = store.myVehicle();
  const name = store.you?.name ?? null;
  const me = !store.welcomed
    ? 'Not connected'
    : v && v.human
      ? `${name ?? 'You'} (driving ${v.id})`
      : `${name ?? 'You'} (spectating)`;
  return {
    me,
    drivers,
    maxDrivers,
    capText: `${drivers}/${maxDrivers ?? DASH} drivers`,
    full: maxDrivers !== null && drivers >= maxDrivers,
    players: store.presence.map((p) => ({
      name: p.name,
      detail: [
        p.vid ? `driving ${p.vid}` : 'spectating',
        typeof p.points === 'number' ? `${Math.round(p.points)} pts` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      mine: !!store.you && p.clientId === store.you.clientId,
      bot: !!p.isBot,
    })),
  };
}

export function mountPresence(zone: HTMLElement, ctx: UiCtx): UiModule {
  const meEl = el('span', { class: 'presence-me' });
  const capEl = el('span', { class: 'muted num' });
  const chevron = el('span', { class: 'panel-chevron', text: '▸' });
  const head = el('button', { class: 'pill-head', attrs: { type: 'button', 'aria-expanded': 'false' } }, [
    el('span', { class: 'label', text: 'Drivers' }),
    meEl,
    capEl,
    chevron,
  ]);
  const listEl = el('div', { class: 'presence-list' });
  const list = new KeyedView(listEl);
  const input = el('input', {
    class: 'text-input',
    attrs: { maxlength: '18', placeholder: 'New display name', 'aria-label': 'Display name' },
  });
  const err = el('div', { class: 'form-error', attrs: { role: 'alert' } });
  const form = el('form', { class: 'rename-form' }, [
    input,
    button('Rename', 'btn', () => submit()),
  ]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  const body = el('div', { class: 'pill-body', attrs: { hidden: '' } }, [listEl, form, err]);
  const root = el('div', { class: 'hud pill-panel presence', title: 'Multiplayer presence' }, [head, body]);
  zone.append(root);

  function submit(): void {
    const res = ctx.actions.rename(input.value);
    err.textContent = res ?? '';
    if (!res) input.value = '';
  }
  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
    head.setAttribute('aria-expanded', String(!body.hidden));
    chevron.textContent = body.hidden ? '▸' : '▾';
  });

  return {
    update() {
      const v = presenceView(ctx.store);
      meEl.textContent = v.me;
      capEl.textContent = `· ${v.capText}`;
      capEl.classList.toggle('bad', v.full);
      list.render(JSON.stringify(v.players), () =>
        v.players.length
          ? v.players.map((p) =>
              el('div', { class: `presence-row${p.mine ? ' row-hl' : ''}` }, [
                el('b', { text: p.name }),
                p.bot ? el('span', { class: 'tag', text: 'bot' }) : null,
                el('span', { class: 'muted', text: p.detail }),
              ]),
            )
          : [el('div', { class: 'empty', text: 'No presence report yet.' })],
      );
    },
  };
}
