/**
 * Bottom-left inspector (mock updateInspector, lines 1863-1904). Re-renders only when its change
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
        const strat = v.human ? (v.autopilot ? `Co-Pilot (${v.strategy})` : 'Human') : v.strategy;
        const bat = Math.round(v.battery);
        const g = store.side.guides.get(v.id);
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
                class: 'muted',
                text: `${strat}${mine ? ' · you' : v.human && v.driver ? ` · ${v.driver}` : ''}`,
              }),
            ]),
            button('✕', 'btn small', () => actions.select(null), 'Deselect [Esc]'),
          ]),
          el('div', { class: 'insp-grid num' }, [
            stat(
              'Battery',
              `${bat}%`,
              bat < 20,
              v.state === 'charging' || v.humanCharging
                ? el('span', { class: 'charge-badge', text: '⚡ +5', title: 'Charging (+5%/min)' })
                : null,
            ),
            stat('Speed', Math.abs(v.speedNow).toFixed(1)),
            v.human && !v.autopilot
              ? stat('Fork', `${Math.round(v.fork * 100)}%`)
              : stat('State', v.state),
            stat('Shift pts', String(Math.round(v.sPts))),
            stat('Incidents', String(v.incidents)),
            stat('Near-miss', String(v.nearMisses)),
          ]),
        );
        if (mine && g?.text) kids.push(el('div', { class: `guide${g.inRange ? ' ok' : ''}`, text: `${g.inRange ? '✓' : '▶'} ${g.text}` }));
        const theme = getSiteTheme(store.siteId ?? w.siteId);
        kids.push(
          el('div', { class: 'insp-line', title: theme.cargoLabel }, [
            el('span', { class: 'label', text: 'Contract ' }),
            contractText(v, w.t),
          ]),
        );
        if (v.directive || v.autopilot) {
          kids.push(
            el('div', { class: 'insp-line', attrs: { 'data-role': 'inspector-directive' } }, [
              el('span', { class: 'label', text: 'Co-Pilot ' }),
              formatDirectiveSummary(v),
            ]),
          );
        }
        if (v.msg) kids.push(el('div', { class: 'insp-msg', text: v.msg }));
        if (!v.human || v.autopilot) {
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
          const toggleAutoBtn = button(
            v.autopilot ? '🕹️ Take Over ' : '🤖 Co-Pilot ',
            v.autopilot ? 'btn small' : 'btn small on',
            () => actions.setAutopilot(!v.autopilot, v.id),
            v.autopilot ? 'Switch to manual WASD driving' : 'Engage Co-Pilot Autopilot for your vehicle [Esc]',
          );
          toggleAutoBtn.append(kbd(v.autopilot ? 'WASD' : 'Esc'));
          actionsRow.append(toggleAutoBtn);

          const designerBtn = button(
            '🎛️ Designer ',
            'btn small',
            () => actions.showAgentDesigner(true),
            'Open Co-Pilot & Agent Designer [G]',
          );
          designerBtn.append(kbd('G'));
          actionsRow.append(designerBtn);

          if (store.canHandBack()) {
            const hb = button('Hand back ', 'btn small', () => actions.handBack(), 'Return this leased AI vehicle');
            hb.append(kbd('Esc'));
            actionsRow.append(hb);
          }
        } else if (!v.human) {
          const take = button('Take the wheel ', 'btn drive', () => actions.takeWheel(v.id));
          take.append(kbd('T'));
          if (pres.full) {
            take.disabled = true;
            take.title = `Driver cap reached (${pres.capText}).`;
          }
          actionsRow.append(take);
          const dirBtn = button(
            '🎛️ Direct ',
            'btn small',
            () => actions.showAgentDesigner(true),
            'Open Co-Pilot & Agent Designer for this vehicle [G]',
          );
          dirBtn.append(kbd('G'));
          actionsRow.append(dirBtn);
        } else {
          actionsRow.append(el('span', { class: 'muted small', text: `Driven by ${v.driver ?? 'another player'}.` }));
        }
        kids.push(actionsRow);
        if (mine) {
          kids.push(
            el('div', { class: 'hint' }, [
              kbd('W'),
              kbd('A'),
              kbd('S'),
              kbd('D'),
              ' instant takeover · ',
              kbd('G'),
              ' Co-Pilot Designer · ',
              kbd('E'),
              ' pick / drop / charge',
            ]),
          );
        }
        return kids;
      });
    },
  };
}
