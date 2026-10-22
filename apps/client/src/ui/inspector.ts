/**
 * Floor-view inspector card (HUD v3: left:12 bottom:70) for the selected vehicle (mock updateInspector, lines 1863-1904). Re-renders only when its change
 * key changes so the buttons stay clickable. Brain lines show only real server data: the latest
 * reason text and, when a real decision arrived, its model and latency.
 */
import { getSiteTheme, policy, STRATEGIES, type Vehicle, type World } from '@warehouse/sim';
import type { ClientStore } from '../state.js';
import { formatDirectiveSummary } from './agentDesigner.js';
import type { UiCtx, UiModule } from './context.js';
import { button, el, kbd, KeyedView, swatch } from './dom.js';
import { teamColor } from './format.js';
import { presenceView } from './presence.js';

export function contractText(v: Pick<Vehicle, 'orders'>, t: number): string {
  const o = v.orders[0];
  if (!o) return 'none';
  const more = v.orders.length > 1 ? ` (+${v.orders.length - 1})` : '';
  const skuPart = o.sku ? ` · ${o.sku}` : '';
  return `#${o.id}${o.p0 ? ' ★' : ''}${skuPart} → bay ${o.bay} · ${Math.max(0, Math.round(o.due - t))} min left${more}`;
}

/** Mock change key + the server-side extras (guide, brain reason/decision, driver cap, ownership, co-pilot). */
export function inspectorKey(store: ClientStore): string {
  const v = store.vehicle(store.selectedVid);
  if (!v) return '';
  const g = store.side.guides.get(v.id);
  const d = store.side.decisions.get(v.id);
  const mine = store.you?.vid === v.id;
  return [
    v.id,
    v.human,
    Boolean(v.autopilot),
    v.strategy,
    Math.round(v.battery),
    v.state,
    Boolean(v.humanCharging),
    v.orders.length,
    v.deliveries,
    v.incidents,
    v.nearMisses,
    Math.round(v.speedNow * 5),
    Math.round(v.fork * 20),
    v.msg,
    Math.round(store.world.t),
    Math.round(v.sPts),
    g?.text ?? '',
    g?.inRange ?? false,
    v.driver ?? '',
    store.side.reasons.get(v.id) ?? '',
    d ? `${d.t}|${d.model}` : '',
    v.brainError ?? '',
    mine,
    store.canHandBack(),
    presenceView(store).full,
    v.tactics?.respect,
    v.tactics?.speed,
    v.directive ? JSON.stringify(v.directive) : '',
  ].join('|');
}

function stat(label: string, value: string, bad = false, extra?: HTMLElement | null): HTMLElement {
  const valRow = el('div', { class: `b${bad ? ' bad' : ''}`, text: value });
  if (extra) valRow.append(' ', extra);
  return el('div', {}, [el('div', { class: 'label', text: label }), valRow]);
}

function policyLine(w: World, v: Vehicle): string {
  const pol = policy(w, v);
  const blurb = (STRATEGIES as Record<string, { blurb: string } | undefined>)[v.strategy]?.blurb ?? '';
  return `${blurb} Respect ${pol.respect.toFixed(2)}, speed ${pol.speed.toFixed(2)}.`;
}

export function mountInspector(root: HTMLElement, ctx: UiCtx): UiModule {
  root.classList.add('hud', 'inspector');
  root.setAttribute('aria-label', 'Vehicle inspector');
  root.hidden = true;
  const view = new KeyedView(root);

  return {
    update() {
      const { store, actions } = ctx;
      const v = store.vehicle(store.selectedVid);
      // HUD v3: the inspector belongs to the Floor view (left:12 bottom:70); while driving the
      // run capsule / dash carry the same information for your own vehicle.
      const show = Boolean(v) && store.hudMode() === 'floor' && store.activeOverlay() !== 'results';
      if (!v || !show) {
        root.hidden = true;
        view.invalidate();
        return;
      }
      root.hidden = false;
      const following = store.ui.followVid === v.id;
      view.render(`${inspectorKey(store)}|${following}`, () => {
        const w = store.world;
        const mine = store.you?.vid === v.id && v.human;
        const strat = v.human ? (v.autopilot ? `Co-Pilot (${v.strategy})` : 'Human') : v.strategy;
        const bat = Math.round(v.battery);
        const reason = store.side.reasons.get(v.id);
        const decision = store.side.decisions.get(v.id);
        const pres = presenceView(store);
        const kids: HTMLElement[] = [];

        kids.push(
          el('div', { class: 'insp-head' }, [
            el('div', { class: 'insp-title' }, [
              swatch(teamColor(v.human ? 'Human' : v.strategy)),
              el('b', { class: 'big', text: v.id }),
              el('span', {
                class: 'muted ellipsis',
                text: `${strat}${mine ? ' · you' : v.human && v.driver ? ` · ${v.driver}` : ''}`,
              }),
            ]),
            button('✕', 'x', () => actions.select(null), 'Deselect [Esc]'),
          ]),
          el('div', { class: 'insp-grid num' }, [
            stat(
              'Battery',
              `${bat}%`,
              bat < 20,
              v.state === 'charging' || v.humanCharging ? el('span', { class: 'charge-badge', text: '⚡', title: 'Charging' }) : null,
            ),
            stat('Delivered', String(v.deliveries)),
            stat('Shift pts', String(Math.round(v.sPts))),
          ]),
        );
        const theme = getSiteTheme(store.siteId ?? w.siteId);
        kids.push(
          el('div', { class: 'insp-line', title: theme.cargoLabel }, [el('span', { class: 'label', text: 'Contract ' }), contractText(v, w.t)]),
        );
        if (v.directive || v.autopilot) {
          kids.push(
            el('div', { class: 'insp-line', attrs: { 'data-role': 'inspector-directive' } }, [
              el('span', { class: 'label', text: 'Co-Pilot ' }),
              formatDirectiveSummary(v),
            ]),
          );
        }
        if (!v.human || v.autopilot) {
          if (reason || decision) {
            const meta = decision ? ` (${decision.model} · ${Math.round(decision.latencyMs)} ms)` : '';
            kids.push(
              el('div', { class: 'insp-brain', title: policyLine(w, v) }, [
                el('span', { class: 'label', text: 'Brain ' }),
                decision?.reason ?? reason ?? '',
                meta ? el('span', { class: 'muted', text: meta }) : null,
              ]),
            );
          }
          if (v.brainError) kids.push(el('div', { class: 'insp-msg bad', text: `Brain error: ${v.brainError}` }));
        }

        const actionsRow = el('div', { class: 'insp-actions' });
        if (!v.human) {
          const take = button('Take this one ', 'primary', () => actions.takeWheel(v.id));
          take.append(kbd('T'));
          if (pres.full) {
            take.disabled = true;
            take.title = `Driver cap reached (${pres.capText}).`;
          } else if (store.isDriving()) {
            take.disabled = true;
            take.title = 'You are already driving — hand back first.';
          }
          actionsRow.append(take);
        } else if (!mine) {
          actionsRow.append(el('span', { class: 'muted small', text: `Driven by ${v.driver ?? 'another player'}.` }));
        }
        const follow = button(following ? 'Following ✓' : 'Follow', `ghost${following ? ' on' : ''}`, () => actions.follow(following ? null : v.id));
        follow.title = following ? 'Stop following (free camera)' : `Keep the camera on ${v.id}`;
        actionsRow.append(follow);
        kids.push(actionsRow);
        return kids;
      });
    },
  };
}
