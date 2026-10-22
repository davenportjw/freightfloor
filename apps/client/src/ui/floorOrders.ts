/**
 * FLOOR view → Floor orders bar (`#orders`, bottom centre), the 📦 Dispatch drawer (`#dispatchPop`,
 * right:12 top:80), the cone hint (`#coneHint`, bottom:76) and, in the same spot, the transient
 * Floor-order refusal line (`#orderNote`, ui/notify.ts).
 *
 * Button state comes only from the server's per-player `floorOrders` status (counted down locally
 * by `store.floorOrdersNow`) plus `limits.*` caps; when the status (or one of its fields) has not
 * arrived the button is disabled with a reason and shows '—'. Nothing is hardcoded or guessed.
 */
import {
  DISPATCH_MAX_COUNT,
  DISPATCH_SOURCE_ZONES,
  DISPATCH_TARGET_BAYS,
  type FloorOrdersStatus,
  type SiteLimits,
} from '@warehouse/protocol';
import type { Vehicle } from '@warehouse/sim';
import type { UiCtx, UiModule } from './context.js';
import { el, kbd, KeyedView } from './dom.js';
import { DASH } from './format.js';
import { fleetView } from './fleet.js';

/**
 * Rush lasts 30 game-minutes (sim engine `w.rushUntil = w.t + 30`; not exported as a constant).
 * Only used to draw the active ring; the active state itself comes from `world.rushUntil`.
 */
export const RUSH_GAME_MIN = 30;

export type OrderId = 'rush' | 'p0' | 'cones' | 'dispatch';
export type OrderState = 'ready' | 'cool' | 'active' | 'off';

export interface OrderButton {
  id: OrderId;
  key: string;
  label: string;
  /** Small right-hand detail (count / seconds); '—' when unknown. */
  detail: string;
  state: OrderState;
  /** 0..1 ring fill (cooldown remaining or active time left); null = no ring. */
  ring: number | null;
  /** Tooltip; for disabled buttons this is the reason. */
  title: string;
  disabled: boolean;
}

export interface FleetStepper {
  count: string;
  canAdd: boolean;
  canRemove: boolean;
  addTitle: string;
  removeTitle: string;
}

const secs = (ms: number): string => `${Math.ceil(ms / 1000)}s`;

/**
 * Pure view model for the Floor orders bar.
 * `cooldownTotals` = the largest readyInMs seen for each cooldown since it was last 0 (tracked by the
 * mount) so the ring can show the fraction left; without it cool buttons draw a full ring.
 */
export function floorOrderButtons(
  status: Partial<FloorOrdersStatus> | null,
  limits: SiteLimits | null,
  world: { t: number; rushUntil?: number | null },
  ui: { coneMode: boolean; dispatchOpen: boolean },
  cooldownTotals: Partial<Record<'rush' | 'p0' | 'dispatch' | 'fleet', number>> = {},
): OrderButton[] {
  const waiting = 'Waiting for Floor-order status from the site…';
  const ring = (k: 'rush' | 'p0' | 'dispatch', ms: number): number => {
    const total = cooldownTotals[k];
    return total && total > 0 ? Math.max(0, Math.min(1, ms / total)) : 1;
  };

  // 1 · Rush
  let rush: OrderButton;
  const rushLeft = typeof world.rushUntil === 'number' ? world.rushUntil - world.t : 0;
  if (rushLeft > 0) {
    rush = {
      id: 'rush', key: '1', label: '⚡ Rush', detail: `${Math.ceil(rushLeft)}m`, state: 'active',
      ring: Math.max(0, Math.min(1, rushLeft / RUSH_GAME_MIN)),
      title: `Rush is on for ${Math.ceil(rushLeft)} more game-min`, disabled: true,
    };
  } else if (!status?.rush) {
    rush = { id: 'rush', key: '1', label: '⚡ Rush', detail: DASH, state: 'off', ring: null, title: waiting, disabled: true };
  } else if (status.rush.readyInMs > 0) {
    rush = {
      id: 'rush', key: '1', label: '⚡ Rush', detail: secs(status.rush.readyInMs), state: 'cool',
      ring: ring('rush', status.rush.readyInMs), title: `Rush cooling down — ready in ${secs(status.rush.readyInMs)}`, disabled: true,
    };
  } else {
    rush = { id: 'rush', key: '1', label: '⚡ Rush', detail: '', state: 'ready', ring: null, title: 'Rush the whole floor: faster work for a while (1)', disabled: false };
  }

  // 2 · ★ P0
  let p0: OrderButton;
  const maxP0 = limits?.maxOpenP0;
  if (!status?.p0) {
    p0 = { id: 'p0', key: '2', label: '★ P0', detail: DASH, state: 'off', ring: null, title: waiting, disabled: true };
  } else {
    const detail = `${status.p0.open}/${maxP0 ?? DASH}`;
    if (typeof maxP0 === 'number' && status.p0.open >= maxP0) {
      p0 = { id: 'p0', key: '2', label: '★ P0', detail, state: 'off', ring: null, title: `${status.p0.open}/${maxP0} ★ P0 orders already open — wait for one to ship`, disabled: true };
    } else if (status.p0.readyInMs > 0) {
      p0 = {
        id: 'p0', key: '2', label: '★ P0', detail, state: 'cool', ring: ring('p0', status.p0.readyInMs),
        title: `★ P0 cooling down — ready in ${secs(status.p0.readyInMs)}`, disabled: true,
      };
    } else {
      p0 = { id: 'p0', key: '2', label: '★ P0', detail, state: 'ready', ring: null, title: 'Create a ★ P0 priority order (2)', disabled: false };
    }
  }

  // 3 · 🚧 Cones
  const coneCap = limits?.conesPerPlayer;
  const mine = status?.cones?.mine?.length;
  const cones: OrderButton = {
    id: 'cones', key: '3', label: '🚧 Cones',
    detail: `${mine ?? DASH}/${coneCap ?? DASH}`,
    state: ui.coneMode ? 'active' : 'ready', ring: null,
    title: ui.coneMode
      ? 'Placing cones: click a tile to place / remove, right-click removes · Esc to finish'
      : `Place traffic cones to block aisles (3)${limits?.coneTtlGameMin ? ` · each lasts ${limits.coneTtlGameMin} game-min` : ''}`,
    disabled: false,
  };

  // 4 · 📦 Dispatch
  let dispatch: OrderButton;
  if (ui.dispatchOpen) {
    dispatch = { id: 'dispatch', key: '4', label: '📦 Dispatch', detail: '', state: 'active', ring: null, title: 'Close the dispatch drawer (4)', disabled: false };
  } else if (!status?.dispatch) {
    dispatch = { id: 'dispatch', key: '4', label: '📦 Dispatch', detail: DASH, state: 'off', ring: null, title: waiting, disabled: true };
  } else if (status.dispatch.readyInMs > 0) {
    dispatch = {
      id: 'dispatch', key: '4', label: '📦 Dispatch', detail: secs(status.dispatch.readyInMs), state: 'cool',
      ring: ring('dispatch', status.dispatch.readyInMs), title: `Dispatch cooling down — ready in ${secs(status.dispatch.readyInMs)}`, disabled: true,
    };
  } else {
    dispatch = { id: 'dispatch', key: '4', label: '📦 Dispatch', detail: '', state: 'ready', ring: null, title: 'Send pallets from a zone to a bay (4)', disabled: false };
  }
  return [rush, p0, cones, dispatch];
}

/** Fleet ± stepper: fleet caps (fleetView) + the server's shared fleet cooldown / removable count. */
export function fleetStepper(
  vehicles: readonly Vehicle[],
  tier: number,
  limits: SiteLimits | null,
  welcomed: boolean,
  status: Partial<FloorOrdersStatus> | null,
): FleetStepper {
  const fv = fleetView(vehicles, tier, limits, welcomed);
  const count = welcomed ? String(vehicles.filter((v) => !v.human).length) : DASH;
  const f = status?.fleet;
  if (!welcomed || !f) {
    const why = welcomed ? 'Waiting for Floor-order status from the site…' : 'Waiting for the site…';
    return { count, canAdd: false, canRemove: false, addTitle: why, removeTitle: why };
  }
  const cooling = f.addReadyInMs > 0 ? `Fleet change cooling down — ready in ${secs(f.addReadyInMs)}` : null;
  const canAdd = fv.canAdd && !cooling;
  const canRemove = fv.canRemove && f.removable > 0 && !cooling;
  return {
    count,
    canAdd,
    canRemove,
    addTitle: cooling ?? (canAdd ? 'Add an AI agent' : fv.addTitle),
    removeTitle: cooling ?? (canRemove ? 'Remove an idle AI agent' : f.removable === 0 ? 'No agent can be removed right now.' : fv.removeTitle),
  };
}

/** Dispatch drawer chips: UI "Any" maps to 'any' for zones and 'auto' for bays. */
export const DISPATCH_ZONE_CHIPS = DISPATCH_SOURCE_ZONES.map((z) => ({ value: z, label: z === 'any' ? 'Any' : z }));
export const DISPATCH_BAY_CHIPS = DISPATCH_TARGET_BAYS.map((b) => ({ value: b, label: b === 'auto' ? 'Any' : b }));

/** Highest count one dispatch may move: `limits.dispatchMaxCount`, else the protocol schema cap. */
export function dispatchMax(limits: SiteLimits | null): number {
  return Math.max(1, Math.min(DISPATCH_MAX_COUNT, limits?.dispatchMaxCount ?? DISPATCH_MAX_COUNT));
}

export function mountFloorOrders(
  ordersEl: HTMLElement,
  popEl: HTMLElement,
  coneHintEl: HTMLElement,
  orderNoteEl: HTMLElement,
  ctx: UiCtx,
): UiModule {
  const ordersKv = new KeyedView(ordersEl);
  const popKv = new KeyedView(popEl);
  const totals: Partial<Record<'rush' | 'p0' | 'dispatch' | 'fleet', number>> = {};
  coneHintEl.replaceChildren(
    el('span', { text: '🚧 Click a tile to place or remove a cone · right-click removes · ' }),
    kbd('Esc'),
    el('span', { text: ' done' }),
  );

  const runOrder = (id: OrderId): void => {
    const { actions, store } = ctx;
    if (id === 'cones') actions.setConeMode(!store.coneMode);
    else if (id === 'dispatch') actions.setDispatchOpen(!store.ui.dispatchOpen);
    else actions.manager(id);
  };

  return {
    update() {
      const { store, actions } = ctx;
      const floor = store.hudMode() === 'floor' && store.welcomed && store.activeOverlay() !== 'results';
      ordersEl.hidden = !floor;
      popEl.hidden = !floor || !store.ui.dispatchOpen;
      // Floor-order refusal line (ui/notify.ts): same spot as the cone hint, which yields to it.
      const note = store.ui.orderNote && Date.now() < store.ui.orderNote.until ? store.ui.orderNote.text : null;
      orderNoteEl.hidden = !floor || note === null;
      if (note !== null && orderNoteEl.textContent !== note) orderNoteEl.textContent = note;
      coneHintEl.hidden = !floor || !store.coneMode || (note !== null);
      if (!floor) {
        ordersKv.invalidate();
        popKv.invalidate();
        return;
      }
      const st = store.floorOrdersNow();
      const track = (k: 'rush' | 'p0' | 'dispatch' | 'fleet', ms: number | undefined): void => {
        if (!ms) delete totals[k];
        else totals[k] = Math.max(totals[k] ?? 0, ms);
      };
      track('rush', st?.rush?.readyInMs);
      track('p0', st?.p0?.readyInMs);
      track('dispatch', st?.dispatch?.readyInMs);
      track('fleet', st?.fleet?.addReadyInMs);
      const btns = floorOrderButtons(st, store.limits, store.world, { coneMode: store.coneMode, dispatchOpen: store.ui.dispatchOpen }, totals);
      const fleet = fleetStepper(store.world.vehicles, store.world.tier, store.limits, store.welcomed, st);
      const nl = st?.nl;
      ordersKv.render(JSON.stringify([btns, fleet, nl?.left ?? null]), () => [
        ...btns.map((b) => {
          const node = el(
            'button',
            {
              class: `obtn ${b.state}`,
              title: b.title,
              attrs: { type: 'button', 'data-order': b.id, 'aria-pressed': String(b.state === 'active') },
              style: b.ring !== null ? { '--p': String(b.ring) } : {},
              onClick: () => runOrder(b.id),
            },
            [kbd(b.key), el('span', { class: 'olabel', text: b.label }), b.detail ? el('span', { class: 'odetail num', text: b.detail }) : null, b.ring !== null ? el('i', { class: 'ring' }) : null],
          );
          (node as HTMLButtonElement).disabled = b.disabled;
          return node;
        }),
        el('span', { class: 'dash-sep' }),
        el('div', { class: 'fleet', title: 'AI agents on the floor' }, [
          (() => {
            const b = el('button', { class: 'step', text: '−', title: fleet.removeTitle, attrs: { type: 'button', 'aria-label': 'Remove an AI agent', 'data-order': 'fleetRemove' }, onClick: () => actions.manager('fleetRemove') });
            (b as HTMLButtonElement).disabled = !fleet.canRemove;
            return b;
          })(),
          el('span', { class: 'num fleet-n' }, [el('b', { text: fleet.count }), el('span', { class: 'sub', text: ' agents' })]),
          (() => {
            const b = el('button', { class: 'step', text: '+', title: fleet.addTitle, attrs: { type: 'button', 'aria-label': 'Add an AI agent', 'data-order': 'fleetAdd' }, onClick: () => actions.manager('fleetAdd') });
            (b as HTMLButtonElement).disabled = !fleet.canAdd;
            return b;
          })(),
        ]),
        el(
          'button',
          {
            class: 'obtn ask',
            title: nl && nl.left === 0 ? `Floor command budget used up — refills in ${secs(nl.resetInMs)}` : 'Ask the floor in plain language (Enter)',
            attrs: { type: 'button', 'data-order': 'ask' },
            onClick: () => {
              actions.setChatTarget('floor');
              actions.setOverlay('chat');
            },
          },
          [kbd('↵'), el('span', { class: 'olabel', text: '💬 Ask' }), el('span', { class: 'odetail num', text: nl ? `${nl.left}` : DASH })],
        ),
      ]);

      if (!store.ui.dispatchOpen) {
        popKv.invalidate();
        return;
      }
      const d = store.ui.dispatchDraft;
      const max = dispatchMax(store.limits);
      if (d.count > max) d.count = max;
      const ready = st?.dispatch ? st.dispatch.readyInMs <= 0 : false;
      const sendWhy = !st?.dispatch ? 'Waiting for Floor-order status from the site…' : !ready ? `Dispatch cooling down — ready in ${secs(st.dispatch.readyInMs)}` : null;
      popKv.render(JSON.stringify([d, max, sendWhy]), () => {
        const chip = (label: string, on: boolean, onClick: () => void): HTMLElement =>
          el('button', { class: `chip${on ? ' on' : ''}`, text: label, attrs: { type: 'button', 'aria-pressed': String(on) }, onClick });
        const set = (patch: Partial<typeof d>): void => {
          Object.assign(store.ui.dispatchDraft, patch);
          actions.refresh();
        };
        const send = el('button', { class: 'go', title: sendWhy ?? 'Send this dispatch order (Enter)', attrs: { type: 'button', 'data-role': 'dispatch-send' }, onClick: () => actions.sendDispatch() }, [
          'Send ',
          kbd('↵'),
        ]);
        (send as HTMLButtonElement).disabled = sendWhy !== null;
        const minus = el('button', { class: 'step', text: '−', attrs: { type: 'button', 'aria-label': 'Fewer pallets' }, onClick: () => set({ count: Math.max(1, d.count - 1) }) });
        const plus = el('button', { class: 'step', text: '+', attrs: { type: 'button', 'aria-label': 'More pallets' }, onClick: () => set({ count: Math.min(max, d.count + 1) }) });
        (minus as HTMLButtonElement).disabled = d.count <= 1;
        (plus as HTMLButtonElement).disabled = d.count >= max;
        if (d.count >= max) plus.title = `At most ${max} per dispatch`;
        const close = el('button', { class: 'x', text: '✕', title: 'Close (Esc)', attrs: { type: 'button', 'aria-label': 'Close dispatch' }, onClick: () => actions.setDispatchOpen(false) });
        return [
          el('div', { class: 'fly-head' }, [el('h3', { text: '📦 Dispatch' }), close]),
          el('div', { class: 'sub', text: 'From' }),
          el('div', { class: 'chips' }, DISPATCH_ZONE_CHIPS.map((c) => chip(c.label, d.sourceZone === c.value, () => set({ sourceZone: c.value })))),
          el('div', { class: 'sub', text: 'To' }),
          el('div', { class: 'chips' }, DISPATCH_BAY_CHIPS.map((c) => chip(c.label, d.targetBay === c.value, () => set({ targetBay: c.value })))),
          el('div', { class: 'row' }, [
            el('span', { class: 'sub', text: 'Pallets' }),
            el('div', { class: 'fleet' }, [minus, el('b', { class: 'num fleet-n', text: String(d.count) }), plus]),
            el('label', { class: 'layer-row', title: 'Send as ★ P0 priority' }, [
              (() => {
                const box = el('input', { attrs: { type: 'checkbox' } });
                box.checked = d.p0;
                box.addEventListener('change', () => set({ p0: box.checked }));
                return box;
              })(),
              el('span', { text: '★ P0' }),
            ]),
            el('span', { class: 'grow' }),
            send,
          ]),
        ];
      });
    },
  };
}
