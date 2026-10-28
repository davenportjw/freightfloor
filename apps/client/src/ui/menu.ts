/**
 * ☰ menu (`#menuBtn` → `#menu`, left:12 top:70) and its flyouts (`#flyout`, same anchor, beside it).
 *
 *   Floor   — Team Standings (B) · Fleet · Drivers (online count) · Value created · Network
 *   View    — Layers ▸ · Day history (H) · HUD Full / Minimal (V)
 *   Co-Pilot— Tune Co-Pilot (G)
 *   Game    — Settings · Leaderboard & awards (L) · How to play (?)
 *
 * Team Standings has its own flyout element (`#standFly`, ui/teamStandings.ts). The other flyouts
 * reuse the existing panel modules (fleet, presence, value chart, network) mounted into sections
 * of `#flyout`, forced open, with their panel headers hidden by CSS.
 */
import type { FlyoutId } from '../state.js';
import type { RenderLayers } from '../renderer.js';
import type { UiCtx, UiModule } from './context.js';
import { el, kbd, KeyedView } from './dom.js';
import { mountFleet } from './fleet.js';
import { mountNetwork } from './network.js';
import type { PanelHandle } from './panel.js';
import { mountPresence, presenceView } from './presence.js';
import { mountValueChart } from './valueChart.js';

interface MenuItem {
  label: string;
  key?: string;
  /** Right-hand detail (live count, current state). */
  detail?: string;
  active?: boolean;
  attrs?: Record<string, string>;
  title?: string;
  onClick: () => void;
}

export const FLYOUT_TITLES: Record<FlyoutId, string> = {
  board: 'Team Standings',
  fleet: 'Fleet',
  drivers: 'Drivers',
  value: 'Value created',
  network: 'Network',
  layers: 'Layers',
  settings: 'Settings',
};

export function mountMenu(menuBtn: HTMLElement, root: HTMLElement, ctx: UiCtx): UiModule {
  const view = new KeyedView(root);
  menuBtn.addEventListener('click', () => ctx.actions.setOverlay(ctx.store.ui.overlay === 'menu' ? null : 'menu'));
  return {
    update() {
      const { store, actions } = ctx;
      const open = store.activeOverlay() === 'menu';
      root.hidden = !open;
      menuBtn.classList.toggle('on', open || store.ui.flyout !== null);
      menuBtn.setAttribute('aria-expanded', String(open));
      if (!open) {
        view.invalidate();
        return;
      }
      const pres = presenceView(store);
      const floor = store.hudMode() === 'floor';
      const fly = store.ui.flyout;
      const groups: Array<[string, MenuItem[]]> = [
        [
          'Floor',
          [
            {
              label: 'Team Standings',
              key: 'B',
              active: fly === 'board',
              attrs: { 'data-flyout': 'board' },
              onClick: () => actions.setFlyout('board'),
            },
            { label: 'Fleet', active: fly === 'fleet', attrs: { 'data-flyout': 'fleet' }, onClick: () => actions.setFlyout('fleet') },
            {
              label: 'Drivers',
              detail: store.welcomed ? pres.capText.replace(' drivers', ' online') : '—',
              active: fly === 'drivers',
              attrs: { 'data-flyout': 'drivers' },
              onClick: () => actions.setFlyout('drivers'),
            },
            { label: 'Value created', active: fly === 'value', attrs: { 'data-flyout': 'value' }, onClick: () => actions.setFlyout('value') },
            { label: 'Network', active: fly === 'network', attrs: { 'data-flyout': 'network' }, onClick: () => actions.setFlyout('network') },
          ],
        ],
        [
          'View',
          [
            { label: 'Layers ▸', active: fly === 'layers', attrs: { 'data-flyout': 'layers' }, onClick: () => actions.setFlyout('layers') },
            {
              label: 'Day history',
              key: 'H',
              active: store.ui.drawerOpen,
              onClick: () => {
                actions.setOverlay(null);
                actions.setDrawer(!store.ui.drawerOpen);
              },
            },
            {
              label: 'HUD',
              key: 'V',
              detail: store.ui.hudMinimal ? 'Minimal' : 'Full',
              attrs: { 'data-role': 'hud-minimal-toggle' },
              title: floor ? 'Full / Minimal applies to the driving HUD' : 'Minimal hides the key hints and the contracts card',
              onClick: () => actions.toggleMinimal(),
            },
            {
              label: 'Drive camera',
              key: 'R',
              detail:
                (typeof store.driveCameraMode === 'function'
                  ? store.driveCameraMode()
                  : (store.ui?.driveCameraMode ?? 'fixed')) === 'headingUp'
                  ? 'Forklift up'
                  : 'Fixed floor',
              active:
                (typeof store.driveCameraMode === 'function'
                  ? store.driveCameraMode()
                  : (store.ui?.driveCameraMode ?? 'fixed')) === 'headingUp',
              attrs: { 'data-role': 'menu-drive-camera-toggle', 'data-act': 'toggle-drive-camera' },
              title: 'Switch between driving with a fixed floor aspect or rotating the floor so the forklift always drives up',
              onClick: () => {
                if (typeof actions.toggleDriveCamera === 'function') actions.toggleDriveCamera();
                else if (typeof store.toggleDriveCameraMode === 'function') store.toggleDriveCameraMode();
              },
            },
            {
              label: 'Cab View',
              key: 'P',
              detail: store.isCabViewPref() ? 'First person' : 'Off',
              active: store.isCabViewPref(),
              attrs: { 'data-role': 'menu-cab-view-toggle', 'data-act': 'toggle-cab-view' },
              title: 'Drive from the forklift seat (first person). Turns Lift Mode on while you are in the cab.',
              onClick: () => actions.toggleCabView?.(),
            },
          ],
        ],
        [
          'Co-Pilot',
          [
            {
              label: 'Tune Co-Pilot',
              key: 'G',
              active: store.ui.agentDesignerOpen,
              attrs: { 'data-role': 'agent-designer-btn' },
              title: 'Co-Pilot & Agent Designer: persona, zones and tactics',
              onClick: () => {
                actions.setOverlay(null);
                actions.showAgentDesigner(true);
              },
            },
          ],
        ],
        [
          'Game',
          [
            { label: 'Settings', active: fly === 'settings', attrs: { 'data-flyout': 'settings' }, onClick: () => actions.setFlyout('settings') },
            {
              label: 'Leaderboard & awards',
              key: 'L',
              onClick: () => {
                actions.setOverlay(null);
                actions.showLeaderboardModal(true, 'all');
              },
            },
            {
              label: 'How to play',
              key: '?',
              attrs: { 'data-action': 'open-intro' },
              onClick: () => {
                actions.setOverlay(null);
                actions.showHelp(true);
              },
            },
          ],
        ],
      ];
      const key = JSON.stringify(groups.map(([g, items]) => [g, items.map((i) => [i.label, i.detail, i.active])]));
      view.render(key, () => [
        ...groups.map(([title, items]) =>
          el('div', { class: 'menu-group' }, [
            el('div', { class: 'sub', text: title }),
            ...items.map((i) =>
              el(
                'button',
                {
                  class: `menu-item${i.active ? ' on' : ''}`,
                  title: i.title,
                  attrs: { type: 'button', ...(i.attrs ?? {}) },
                  onClick: i.onClick,
                },
                [el('span', { class: 'grow', text: i.label }), i.detail ? el('span', { class: 'muted num', text: i.detail }) : null, i.key ? kbd(i.key) : null],
              ),
            ),
          ]),
        ),
        el('div', { class: 'menu-group menu-credits' }, [
          el(
            'a',
            {
              class: 'menu-item menu-powered-link',
              title: 'Visit Davenporter (davenporter.com)',
              attrs: {
                href: 'https://davenporter.com',
                target: '_blank',
                rel: 'noopener noreferrer',
                'aria-label': 'Powered by Davenporter',
              },
            },
            [el('span', { class: 'grow' }, ['Powered by ', el('strong', { text: 'Davenporter' })]), el('span', { class: 'muted', text: '↗' })],
          ),
        ]),
      ]);
    },
  };
}

const LAYER_ROWS: Array<[keyof RenderLayers, string, string]> = [
  ['routes', 'Routes', 'Planned paths of every vehicle'],
  ['traffic', 'Traffic heat', 'Congestion heat map (streamed from the site while on)'],
  ['labels', 'Labels', 'Vehicle ids, bays and zone names'],
  ['ghost', 'Ghost planner', 'Dashed planner path to your highlighted order'],
];

/** Flyouts other than Team Standings, hosted in `#flyout`. Returns the panels for resize handling. */
export function mountFlyouts(root: HTMLElement, ctx: UiCtx): UiModule & { panels: PanelHandle[] } {
  const sections = new Map<FlyoutId, HTMLElement>();
  const title = el('h3');
  const close = el('button', { class: 'x', text: '✕', title: 'Close (Esc)', attrs: { type: 'button', 'aria-label': 'Close' } });
  close.addEventListener('click', () => ctx.actions.setFlyout(null));
  root.append(el('div', { class: 'fly-head' }, [title, close]));
  for (const id of ['fleet', 'drivers', 'value', 'network', 'layers', 'settings'] as FlyoutId[]) {
    const s = el('div', { class: `fly-section fly-${id}`, attrs: { 'data-flyout-section': id } });
    s.hidden = true;
    sections.set(id, s);
    root.append(s);
  }
  const fleet = mountFleet(sections.get('fleet')!, ctx);
  const presence = mountPresence(sections.get('drivers')!, ctx);
  const value = mountValueChart(sections.get('value')!, ctx);
  const network = mountNetwork(sections.get('network')!, ctx);
  const panels = [fleet.panel, value.panel, network.panel];
  for (const p of panels) p.setState('open', false);

  // Layers
  const layersView = new KeyedView(sections.get('layers')!);
  // Settings: camera + experimental gameplay.
  const getCamMode = () =>
    typeof ctx.store.driveCameraMode === 'function'
      ? ctx.store.driveCameraMode()
      : (ctx.store.ui?.driveCameraMode ?? 'fixed');
  const driveCamBtn = el('button', {
    class: 'btn',
    text: `Drive Camera: ${getCamMode() === 'headingUp' ? 'Forklift Up (Rotate Floor)' : 'Fixed Floor'}`,
    title: 'Choose whether the freight floor stays locked in its fixed isometric aspect or rotates so your forklift always drives up (R)',
    attrs: {
      type: 'button',
      'data-act': 'toggle-drive-camera',
      'data-role': 'settings-drive-camera-toggle',
      'aria-pressed': getCamMode() === 'headingUp' ? 'true' : 'false',
    },
    onClick: () => {
      if (typeof ctx.actions.toggleDriveCamera === 'function') ctx.actions.toggleDriveCamera();
      else if (typeof ctx.store.toggleDriveCameraMode === 'function') ctx.store.toggleDriveCameraMode();
    },
  });
  const cabViewBtn = el('button', {
    class: 'btn',
    text: `Cab View: ${ctx.store.isCabViewPref() ? 'ON' : 'OFF'}`,
    title: 'First-person camera from the forklift seat while driving (P). Lift Mode is on while you are in the cab.',
    attrs: {
      type: 'button',
      'data-act': 'toggle-cab-view',
      'data-role': 'settings-cab-view-toggle',
      'aria-pressed': ctx.store.isCabViewPref() ? 'true' : 'false',
    },
    onClick: () => ctx.actions.toggleCabView?.(),
  });
  const rackLiftBtn = el('button', {
    class: 'btn',
    text: `Rack Lift Minigame: ${ctx.store.isRackLiftEnabled() ? 'ON' : 'OFF'}`,
    title: 'Opt-in 3D vertical rack shelf lifting: hold E to raise forks to L1 / L2 / L3 and release in the sweet spot for +$5',
    attrs: {
      type: 'button',
      'data-act': 'toggle-rack-lift',
      'aria-pressed': ctx.store.isRackLiftEnabled() ? 'true' : 'false',
    },
    onClick: () => ctx.store.setRackLiftMinigame(!ctx.store.isRackLiftEnabled()),
  });
  const dispatchBtn = el('button', {
    class: 'btn',
    text: `Dispatcher's Call: ${ctx.store.ui.dispatchersCall ? 'ON' : 'OFF'}`,
    title: "Once per Blitz run Gemini spots a floor situation; pick a dispatch in 8 s and compare with Gemini's call",
    attrs: {
      type: 'button',
      'data-act': 'toggle-dispatchers-call',
      'aria-pressed': ctx.store.ui.dispatchersCall ? 'true' : 'false',
    },
    onClick: () => ctx.actions.setDispatchersCallPref(!ctx.store.ui.dispatchersCall),
  });
  sections.get('settings')!.append(
    el('div', { class: 'sub', text: 'Camera' }),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn', text: 'Fit floor', attrs: { type: 'button' }, onClick: () => ctx.actions.fit() }),
      el('button', { class: 'btn', text: 'Zoom +', attrs: { type: 'button' }, onClick: () => ctx.actions.zoomBy(1.2) }),
      el('button', { class: 'btn', text: 'Zoom −', attrs: { type: 'button' }, onClick: () => ctx.actions.zoomBy(1 / 1.2) }),
    ]),
    el('div', { class: 'row' }, [driveCamBtn]),
    el('div', { class: 'row' }, [cabViewBtn]),
    el('div', {
      class: 'hint',
      text: 'Fixed Floor keeps the board orientation locked; Forklift Up rotates the floor so your forklift always drives up.',
    }),
    el('div', { class: 'sub', text: 'Gameplay' }),
    el('div', { class: 'row' }, [rackLiftBtn]),
    el('div', { class: 'hint', text: 'Hold E at racks to raise forks to shelf L1 / L2 / L3 and release in the sweet spot.' }),
    el('div', { class: 'row' }, [dispatchBtn]),
    el('div', { class: 'hint', text: 'Once per Blitz run: pick a dispatch move in 8 s and see what Gemini would have done.' }),
  );

  const modules: UiModule[] = [fleet, presence, value, network];
  return {
    panels,
    update() {
      const { store, actions } = ctx;
      const id = store.ui.flyout;
      const open = id !== null && id !== 'board';
      root.hidden = !open;
      if (!open) return;
      title.textContent = FLYOUT_TITLES[id];
      for (const [sid, s] of sections) s.hidden = sid !== id;
      if (id === 'layers') {
        layersView.render(JSON.stringify(store.layers), () =>
          LAYER_ROWS.map(([k, label, tip]) => {
            const box = el('input', { attrs: { type: 'checkbox', 'data-layer': k } });
            box.checked = Boolean(store.layers[k]);
            box.addEventListener('change', () => actions.toggleLayer(k));
            return el('label', { class: 'layer-row', title: tip }, [box, el('span', { text: label })]);
          }),
        );
      }
      if (id === 'settings') {
        const headingUp = getCamMode() === 'headingUp';
        driveCamBtn.textContent = `Drive Camera: ${headingUp ? 'Forklift Up (Rotate Floor)' : 'Fixed Floor'}`;
        driveCamBtn.setAttribute('aria-pressed', headingUp ? 'true' : 'false');
        driveCamBtn.classList.toggle('active', headingUp);
        const cabOn = store.isCabViewPref();
        cabViewBtn.textContent = `Cab View: ${cabOn ? 'ON' : 'OFF'}`;
        cabViewBtn.setAttribute('aria-pressed', cabOn ? 'true' : 'false');
        cabViewBtn.classList.toggle('active', cabOn);
        const on = store.isRackLiftEnabled();
        // Site doesn't grade lifts (server kill switch) → the minigame is ungraded practice here.
        const graded = store.isRackLiftGraded();
        rackLiftBtn.textContent = `Rack Lift Minigame: ${on ? 'ON' : 'OFF'}${on && !graded ? ' (practice)' : ''}`;
        rackLiftBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        rackLiftBtn.classList.toggle('active', on);
        const dc = store.ui.dispatchersCall;
        const dcServer = Boolean(store.limits?.dispatchersCall);
        dispatchBtn.textContent = `Dispatcher's Call: ${dc ? 'ON' : 'OFF'}${dcServer ? '' : ' (site off)'}`;
        dispatchBtn.setAttribute('aria-pressed', dc ? 'true' : 'false');
        dispatchBtn.classList.toggle('active', dc && dcServer);
      }
      for (const m of modules) {
        try {
          m.update();
        } catch (err) {
          console.error('flyout update failed', err);
        }
      }
    },
  };
}
