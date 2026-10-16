/**
 * Bottom-left inspector (mock updateInspector, lines 1863-1904). Re-renders only when its change
 * key changes so the buttons stay clickable. Brain lines show only real server data: the latest
 * reason text and, when a real decision arrived, its model and latency.
 */
import { policy, STRATEGIES, type Vehicle, type World } from '@warehouse/sim';
import type { ClientStore } from '../state.js';
import type { UiCtx, UiModule } from './context.js';
import { button, el, kbd, KeyedView, swatch } from './dom.js';
import { teamColor } from './format.js';
import { presenceView } from './presence.js';

export function contractText(v: Pick<Vehicle, 'orders'>, t: number): string {
  const o = v.orders[0];
  if (!o) return 'none';
  const more = v.orders.length > 1 ? ` (+${v.orders.length - 1})` : '';
  return `#${o.id}${o.p0 ? ' ★' : ''} → bay ${o.bay} · ${Math.max(0, Math.round(o.due - t))} min left${more}`;
}

/** Mock change key + the server-side extras (guide, brain reason/decision, driver cap, ownership). */
export function inspectorKey(store: ClientStore): string {
  const v = store.vehicle(store.selectedVid);
  if (!v) return '';
  const g = store.side.guides.get(v.id);
  const d = store.side.decisions.get(v.id);
  const mine = store.you?.vid === v.id;
  return [
    v.id,
    v.human,
    Math.round(v.battery),
    v.state,
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
    mine && v.human ? `${Math.round(v.px * 2)},${Math.round(v.py * 2)}` : '',
    v.driver ?? '',
    store.side.reasons.get(v.id) ?? '',
    d ? `${d.t}|${d.model}` : '',
    v.brainError ?? '',
    mine,
    store.canHandBack(),
    presenceView(store).full,
    v.tactics?.respect,
    v.tactics?.speed,
  ].join('|');
}

function stat(label: string, value: string, bad = false): HTMLElement {
  return el('div', {}, [el('div', { class: 'label', text: label }), el('div', { class: `b${bad ? ' bad' : ''}`, text: value })]);
}

function policyLine(w: World, v: Vehicle): string {
  const pol = policy(w, v);
  const blurb = (STRATEGIES as Record<string, { blurb: string } | undefined>)[v.strategy]?.blurb ?? '';
  return `${blurb} Respect ${pol.respect.toFixed(2)}, speed ${pol.speed.toFixed(2)}.`;
}

export function mountInspector(zone: HTMLElement, ctx: UiCtx): UiModule {
  const root = el('section', { class: 'hud inspector', attrs: { 'aria-label': 'Vehicle inspector' } });
  root.hidden = true;
  const view = new KeyedView(root);
  zone.append(root);

  return {
    update() {
      const { store, actions } = ctx;
      const v = store.vehicle(store.selectedVid);
      if (!v) {
        root.hidden = true;
        view.invalidate();
        return;
      }
      root.hidden = false;
      view.render(inspectorKey(store), () => {
        const w = store.world;
        const mine = store.you?.vid === v.id && v.human;
        const strat = v.human ? 'Human' : v.strategy;
        const bat = Math.round(v.battery);
        const g = store.side.guides.get(v.id);
        const reason = store.side.reasons.get(v.id);
        const decision = store.side.decisions.get(v.id);
        const pres = presenceView(store);
        const kids: HTMLElement[] = [];

        kids.push(
          el('div', { class: 'insp-head' }, [
            el('div', { class: 'insp-title' }, [
              swatch(teamColor(strat)),
              el('b', { class: 'big', text: v.id }),
              el('span', {
                class: 'muted',
                text: `${strat}${mine ? ' · you' : v.human && v.driver ? ` · ${v.driver}` : ''}`,
              }),
            ]),
            button('✕', 'btn small', () => actions.select(null), 'Deselect [Esc]'),
          ]),
          el('div', { class: 'insp-grid num' }, [
            stat('Battery', `${bat}%`, bat < 20),
            stat('Speed', Math.abs(v.speedNow).toFixed(1)),
            v.human ? stat('Fork', `${Math.round(v.fork * 100)}%`) : stat('State', v.state),
            stat('Shift pts', String(Math.round(v.sPts))),
            stat('Incidents', String(v.incidents)),
            stat('Near-miss', String(v.nearMisses)),
          ]),
        );
        if (mine && g?.text) kids.push(el('div', { class: `guide${g.inRange ? ' ok' : ''}`, text: `${g.inRange ? '✓' : '▶'} ${g.text}` }));
        kids.push(el('div', { class: 'insp-line' }, [el('span', { class: 'label', text: 'Contract ' }), contractText(v, w.t)]));
        if (v.msg) kids.push(el('div', { class: 'insp-msg', text: v.msg }));
        if (!v.human) {
          kids.push(el('div', { class: 'hint', text: policyLine(w, v) }));
          if (reason || decision) {
            const meta = decision ? ` (${decision.kind} · ${decision.model} · ${Math.round(decision.latencyMs)} ms)` : '';
            kids.push(
              el('div', { class: 'insp-brain' }, [
                el('span', { class: 'label', text: 'Brain ' }),
                decision?.reason ?? reason ?? '',
                meta ? el('span', { class: 'muted', text: meta }) : null,
              ]),
            );
          }
          if (v.brainError) kids.push(el('div', { class: 'insp-msg bad', text: `Brain error: ${v.brainError}` }));
        }

        const actionsRow = el('div', { class: 'insp-actions' });
        if (mine) {
          if (store.canHandBack()) {
            actionsRow.append(button('Hand back ', 'btn', () => actions.handBack(), 'Return this vehicle to its AI'));
            actionsRow.lastElementChild?.append(kbd('Esc'));
          } else {
            actionsRow.append(el('span', { class: 'muted small', text: 'Your own vehicle.' }));
          }
        } else if (!v.human) {
          const take = button('Take the wheel ', 'btn drive', () => actions.takeWheel(v.id));
          take.append(kbd('T'));
          if (pres.full) {
            take.disabled = true;
            take.title = `Driver cap reached (${pres.capText}).`;
          }
          actionsRow.append(take);
        } else {
          actionsRow.append(el('span', { class: 'muted small', text: `Driven by ${v.driver ?? 'another player'}.` }));
        }
        kids.push(actionsRow);
        if (mine) {
          kids.push(
            el('div', { class: 'hint' }, [kbd('W'), kbd('A'), kbd('S'), kbd('D'), ' drive · ', kbd('E'), ' pick / drop / charge · fast hits cause incidents']),
          );
        }
        return kids;
      });
    },
  };
}
