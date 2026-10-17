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
  return (p.role ? p.role === 'driver' : true) && p.vid !== null;
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
    players: store.presence.map((p) => {
      const pv = p.vid ? store.vehicle(p.vid) : null;
      const pts = pv ? Math.round(pv.sPts) : typeof p.points === 'number' ? Math.round(p.points) : null;
      return {
        name: p.name,
        detail: [
          p.vid ? `driving ${p.vid}` : 'spectating',
          pts !== null ? `${pts} pts` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        mine: !!store.you && p.clientId === store.you.clientId,
        bot: !!p.isBot,
      };
    }),
  };
}

export function mountPresence(zone: HTMLElement, ctx: UiCtx): UiModule & { collapse(): void } {
  const meEl = el('span', { class: 'presence-me' });
  const capEl = el('span', { class: 'muted num' });
  const chevron = el('span', { class: 'panel-chevron', text: '▸' });
  const head = el(
    'button',
    {
      class: 'pill-head',
      title: 'Expand or fold multiplayer drivers and spectators on this site',
      attrs: { type: 'button', 'aria-expanded': 'false' },
    },
    [el('span', { class: 'label', text: 'Drivers' }), meEl, capEl, chevron],
  );
  const listEl = el('div', { class: 'presence-list' });
  const list = new KeyedView(listEl);
  const assignedBadgeVal = el('b', {
    class: 'callsign-badge-val num',
    attrs: { 'data-role': 'assigned-callsign' },
    text: DASH,
  });
  const assignedRow = el('div', { class: 'assigned-callsign-row' }, [
    el('span', { class: 'label', text: 'Your Callsign' }),
    assignedBadgeVal,
  ]);
  const input = el('input', {
    class: 'text-input',
    attrs: {
      maxlength: '64',
      placeholder: 'Resume callsign (e.g. Turbo-Forklift)',
      'aria-label': 'Resume assigned callsign',
    },
  });
  const err = el('div', { class: 'form-error', attrs: { role: 'alert' } });
  const resumeBtn = button('Resume Callsign', 'btn', () => void submit());
  const form = el('form', { class: 'rename-form' }, [input, resumeBtn]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void submit();
  });
  const hint = el('div', {
    class: 'hint',
    text: 'Callsigns are auto-assigned by the lobby to keep the leaderboard clean. Enter a previous callsign above to resume your stats.',
  });
  const body = el('div', { class: 'pill-body', attrs: { hidden: '' } }, [
    listEl,
    assignedRow,
    form,
    err,
    hint,
  ]);
  const root = el('div', { class: 'hud pill-panel presence', title: 'Multiplayer presence on this site' }, [head, body]);
  zone.append(root);

  async function submit(): Promise<void> {
    resumeBtn.disabled = true;
    try {
      const res = await ctx.actions.resumeCallsign(input.value);
      err.textContent = res ?? '';
      if (!res) input.value = '';
    } finally {
      resumeBtn.disabled = false;
    }
  }
  function setOpen(open: boolean): void {
    body.hidden = !open;
    head.setAttribute('aria-expanded', String(open));
    chevron.textContent = open ? '▾' : '▸';
  }
  head.addEventListener('click', () => {
    setOpen(body.hidden);
  });

  return {
    collapse() {
      setOpen(false);
    },
    update() {
      const v = presenceView(ctx.store);
      meEl.textContent = v.me;
      assignedBadgeVal.textContent = ctx.store.you?.name ?? DASH;
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

