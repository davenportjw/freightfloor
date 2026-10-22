/**
 * DRIVE HUD → `#dash` (bottom centre): battery track · driving keys legend (WASD Drive / E Pick·Drop)
 * · boost (hold, Shift) · separator · key hints (C Co-Pilot / ↵ Chat / Tab Standings / ? Controls).
 * Minimal HUD hides the legend and the hints.
 *
 * Boost has no meter of its own in the sim — it drains the battery — so the boost track shows
 * whether boost is engaged (held) and is disabled on a flat battery.
 */
import type { UiCtx, UiModule } from './context.js';
import { el, kbd } from './dom.js';
import { LOW_BATTERY_PCT } from './objective.js';
import { showBatteryMeter } from './runOne.js';

export interface DashView {
  battery: number;
  /** Progressive disclosure: the battery meter shows only below 50% or while charging. */
  showBattery: boolean;
  low: boolean;
  boosting: boolean;
  boostDisabled: boolean;
  cargoRisk: boolean;
  autopilot: boolean;
}

export function dashView(me: {
  battery: number;
  humanCharging?: boolean;
  autopilot?: boolean;
  input?: { boost?: boolean };
  cargo?: readonly unknown[] | null;
}): DashView {
  const battery = Math.max(0, Math.min(100, Math.round(me.battery)));
  const boosting = Boolean(me.input?.boost) && battery > 0;
  return {
    battery,
    showBattery: showBatteryMeter({ battery, humanCharging: me.humanCharging }),
    low: battery < LOW_BATTERY_PCT,
    boosting,
    boostDisabled: battery <= 0,
    cargoRisk: boosting && (me.cargo?.length ?? 0) > 0,
    autopilot: Boolean(me.autopilot),
  };
}

export function mountDash(root: HTMLElement, ctx: UiCtx): UiModule {
  const { actions } = ctx;
  const batFill = el('i');
  const batVal = el('b', { class: 'num', text: '—' });
  const battery = el('div', { class: 'meter', title: 'Battery — drive onto a ⚡ charger and press E to charge' }, [
    el('span', { class: 'sub', text: 'Battery' }),
    el('span', { class: 'track' }, [batFill]),
    batVal,
  ]);

  // Driving controls legend (left of Boost) so the core keys are visible right where you drive.
  const legend = (keys: string[], label: string, title: string) =>
    el('span', { class: 'drive-key', title }, [...keys.map((k) => kbd(k)), el('span', { text: label })]);
  const driveKeys = el('div', { class: 'drive-keys', attrs: { 'data-role': 'drive-keys' } }, [
    legend(['WASD'], 'Drive', 'W A S D or arrow keys to drive'),
    legend(['E'], 'Pick / Drop', 'E: pick up / drop pallets, or charge on a ⚡ charger'),
    el('span', { class: 'dash-sep' }),
  ]);

  const boostFill = el('i');
  const boostVal = el('b', { class: 'num kbd', text: 'Shift' });
  const boost = el(
    'button',
    {
      class: 'meter boost',
      title: 'Hold Shift / Space (or hold here) to boost: +120% speed, extra battery drain; collisions drop carried pallets',
      attrs: { type: 'button', 'data-role': 'boost-btn' },
    },
    [el('span', { class: 'sub', text: 'Boost' }), el('span', { class: 'track' }, [boostFill]), boostVal],
  );
  boost.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!boost.disabled) actions.setBoost(true);
  });
  for (const name of ['pointerup', 'pointerleave', 'pointercancel'] as const) {
    boost.addEventListener(name, () => actions.setBoost(false));
  }

  const copilotLabel = el('span', { text: 'Co-Pilot' });
  const copilotKey = kbd('C');
  const copilot = el(
    'button',
    {
      class: 'hint-key',
      attrs: { type: 'button', 'data-role': 'copilot-toggle' },
      onClick: () => actions.setAutopilot(!ctx.store.isMyVehicleAutopilot()),
    },
    [copilotKey, copilotLabel],
  );
  const chat = el(
    'button',
    { class: 'hint-key', title: 'Chat with your Co-Pilot or the Floor', attrs: { type: 'button' }, onClick: () => actions.setOverlay('chat') },
    [kbd('↵'), el('span', { text: 'Chat' })],
  );
  const standings = el(
    'button',
    { class: 'hint-key', title: 'Hold Tab to show the Standings sheet', attrs: { type: 'button' }, onClick: () => actions.setOverlay('standings') },
    [kbd('Tab'), el('span', { text: 'Standings' })],
  );
  const allControls = el(
    'button',
    { class: 'hint-key', title: 'All controls (How to play)', attrs: { type: 'button', 'data-role': 'all-controls' }, onClick: () => actions.showHelp(true) },
    [kbd('?'), el('span', { text: 'Controls' })],
  );
  const hints = el('div', { class: 'hints' }, [el('span', { class: 'dash-sep' }), copilot, chat, standings, allControls]);
  root.replaceChildren(battery, driveKeys, boost, hints);

  let last = '';
  return {
    update() {
      const { store } = ctx;
      const me = store.hudMode() === 'driving' ? store.myVehicle() : null;
      const ov = store.activeOverlay();
      root.hidden = !me || ov === 'results' || ov === 'pick' || ov === 'chat';
      if (!me || root.hidden) {
        last = '';
        return;
      }
      const v = dashView(me);
      const key = JSON.stringify([v, store.ui.hudMinimal]);
      if (key === last) return;
      last = key;
      hints.hidden = store.ui.hudMinimal;
      driveKeys.hidden = store.ui.hudMinimal;
      battery.hidden = !v.showBattery;
      battery.classList.toggle('low', v.low);
      batFill.style.width = `${v.battery}%`;
      batVal.textContent = `${v.battery}%`;
      boost.classList.toggle('on', v.boosting);
      boost.classList.toggle('risk', v.cargoRisk);
      boost.disabled = v.boostDisabled;
      boost.title = v.boostDisabled
        ? 'Battery flat — recharge at a ⚡ charger to boost'
        : v.cargoRisk
          ? 'Boosting with cargo — a collision drops your pallets!'
          : 'Hold Shift / Space (or hold here) to boost: +120% speed, extra battery drain; collisions drop carried pallets';
      boostFill.style.width = v.boosting ? '100%' : '0%';
      boostVal.textContent = v.boosting ? 'ON' : 'Shift';
      copilot.classList.toggle('on', v.autopilot);
      copilotLabel.textContent = v.autopilot ? 'Take back control' : 'Co-Pilot';
      copilotKey.textContent = v.autopilot ? 'WASD' : 'C';
      copilot.title = v.autopilot
        ? 'Co-Pilot is driving — click (or press W A S D) to take back control'
        : 'Hand the wheel to your Co-Pilot (C) — you keep your vehicle and score';
    },
  };
}
