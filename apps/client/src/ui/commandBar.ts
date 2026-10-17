/**
 * Bottom-centre command bar (mock lines 132-141) and the drive guidance bar (mock 147, 2022-2026).
 */
import { computeDriverPpm, leaderboard, streakMultiplier, type Order, type Vehicle } from '@warehouse/sim';
import type { ClientStore } from '../state.js';
import { formatDirectiveSummary } from './agentDesigner.js';
import type { UiCtx, UiModule } from './context.js';
import { button, el, kbd, KeyedView } from './dom.js';

export const NL_MAX_LEN = 200;

export function formatBlitzRemaining(
  meOrRem: Pick<Vehicle, 'runMode' | 'runStartedAt' | 'runEndsAt'> | number,
  t = 0,
): string {
  if (typeof meOrRem === 'number') {
    const totalSec = Math.max(0, Math.ceil(meOrRem));
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }
  if (meOrRem.runEndsAt == null) return '05:00';
  const remSimMin = Math.max(0, meOrRem.runEndsAt - t);
  const totalSec = Math.max(0, Math.ceil(remSimMin));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export interface CommandBarView {
  ready: boolean;
  driving: boolean;
  autopilot: boolean;
  agentDesignerOpen: boolean;
  copilotSummary: string;
  driveTitle: string;
  rushText: string;
  rushActive: boolean;
  rushTitle: string;
  p0Text: string;
  p0Active: boolean;
  p0Title: string;
  conesActive: boolean;
  conesTitle: string;
  opsGuideOpen: boolean;
}

export function commandBarView(
  store: Pick<ClientStore, 'welcomed' | 'conn' | 'coneMode'> & {
    world: { t: number; rushUntil: number; orders: readonly Pick<Order, 'p0' | 'state'>[] };
    isDriving(): boolean;
    isMyVehicleAutopilot?: () => boolean;
    myVehicle?: () => Vehicle | null;
    ui?: { opsGuideOpen?: boolean; agentDesignerOpen?: boolean };
  },
): CommandBarView {
  const ready = store.welcomed && store.conn.status === 'open';
  const driving = store.isDriving();
  const autopilot = store.isMyVehicleAutopilot ? store.isMyVehicleAutopilot() : false;
  const myVeh = store.myVehicle ? store.myVehicle() : null;
  const rushRem = store.welcomed && store.world.rushUntil > store.world.t
    ? Math.max(1, Math.ceil(store.world.rushUntil - store.world.t))
    : 0;
  const rushActive = rushRem > 0;
  const openP0 = store.welcomed
    ? store.world.orders.filter((o) => o.p0 && (o.state === 'open' || o.state === 'claimed')).length
    : 0;
  return {
    ready,
    driving,
    autopilot,
    agentDesignerOpen: Boolean(store.ui?.agentDesignerOpen),
    copilotSummary: formatDirectiveSummary(myVeh),
    driveTitle: driving
      ? autopilot
        ? 'Your forklift is in Co-Pilot Autopilot — press WASD to take manual control'
        : 'You are driving manually (press Esc to engage Co-Pilot Autopilot)'
      : 'Take manual control of the best available forklift (WASD/Arrows, E to interact, Shift to boost)',
    rushText: rushActive ? `⚡ Rush (${rushRem}m)` : '⚡ Rush wave',
    rushActive,
    rushTitle: rushActive
      ? `Rush wave active (${rushRem} game-min left) — click to spawn another burst of 12 orders`
      : 'Spawn 12 orders immediately, boost arrivals (+32/hr), and tighten deadlines for 30 game-min',
    p0Text: openP0 > 0 ? `★ P0 (${openP0}/4)` : '★ P0 order',
    p0Active: openP0 > 0,
    p0Title: 'Spawn a high-priority P0 contract (+40 pts, 30m deadline, max 4 open at once)',
    conesActive: store.coneMode,
    conesTitle: 'Toggle Cone Mode [C]: click open floor tiles to place/remove cones and reroute AI traffic',
    opsGuideOpen: Boolean(store.ui?.opsGuideOpen),
  };
}

/** Fare combo steps, mirroring the sim's COMBO_STEPS. */
export const COMBO_PIPS = [1.0, 1.2, 1.5, 2.0] as const;

/** Combo meter view: 'COMBO ×1.5' + 4 pips lit up to the current step; `max` at ×2.0. */
export function comboMeter(combo: number | null | undefined): {
  label: string;
  pips: Array<{ step: number; on: boolean }>;
  max: boolean;
} {
  const c = typeof combo === 'number' && Number.isFinite(combo) ? combo : 1;
  const top = COMBO_PIPS[COMBO_PIPS.length - 1];
  return {
    label: `COMBO ×${c.toFixed(1)}`,
    pips: COMBO_PIPS.map((step) => ({ step, on: c >= step - 1e-9 })),
    max: c >= top - 1e-9,
  };
}

/**
 * 🚜 Drive target: the selected AI vehicle, else an idle, charged, unloaded, un-stunned agent
 * (idle first, then highest battery), else any AI vehicle. Bot-driven vehicles are never picked.
 */
export function pickDriveTarget(vehicles: readonly Vehicle[], selectedVid: string | null, t: number): string | null {
  const free = vehicles.filter((v) => !v.human && !v.isBot);
  const sel = free.find((v) => v.id === selectedVid);
  if (sel) return sel.id;
  const ok = free.filter((v) => !v.cargo.length && v.battery > 35 && t >= v.stunnedUntil);
  ok.sort((a, b) => (a.state === 'idle' ? 0 : 1) - (b.state === 'idle' ? 0 : 1) || b.battery - a.battery);
  return (ok[0] ?? free[0])?.id ?? null;
}

export function mountCommandBar(zone: HTMLElement, ctx: UiCtx): UiModule {
  const { actions, store } = ctx;
  const drive = button(
    '🚜 Drive',
    'btn drive',
    () => actions.quickDrive(),
    'Take manual control of the best available forklift (WASD/Arrows, E to interact, Shift to boost)',
  );
  const copilotBtn = button(
    '🤖 Co-Pilot [G]',
    'btn',
    () => actions.showAgentDesigner(!store.ui.agentDesignerOpen),
    'Open the Co-Pilot & Agent Designer [G] to direct your forklift with natural language or custom tactics',
  );
  const rush = button(
    '⚡ Rush wave',
    'btn warn',
    () => actions.manager('rush'),
    'Spawn 12 orders immediately, boost arrivals (+32/hr), and tighten deadlines for 30 game-min',
  );
  const p0 = button(
    '★ P0 order',
    'btn warn',
    () => actions.manager('p0'),
    'Spawn a high-priority P0 contract (+40 pts, 30m deadline, max 4 open at once)',
  );
  const cones = button(
    '🚧 Cones',
    'btn',
    () => actions.setConeMode(!store.coneMode),
    'Toggle Cone Mode [C]: click open floor tiles to place/remove cones and reroute AI traffic',
  );
  const opsBtn = button(
    'ⓘ Ops',
    'btn',
    () => actions.setOpsGuide(!store.ui.opsGuideOpen),
    'Show or hide quick reference for floor & manager controls',
  );

  // Target selector for natural-language input: 'car' (My Co-Pilot) vs 'floor' (Floor Ops)
  let nlTarget: 'car' | 'floor' = 'car';
  const targetToggle = button(
    '🤖 My Car',
    'btn small nl-target-toggle on',
    () => {
      nlTarget = nlTarget === 'car' ? 'floor' : 'car';
      syncNlTargetUi();
    },
    'Toggle whether natural-language commands direct your own forklift Co-Pilot or the whole warehouse floor',
  );

  const input = el('input', {
    class: 'text-input nl-input',
    attrs: {
      maxlength: String(NL_MAX_LEN),
      placeholder: 'Direct your Co-Pilot… (e.g. "prioritize P0s in Zone C & D, charge at 30%", or toggle 🏭 Floor)',
      'aria-label': 'Co-Pilot or Floor command',
      enterkeyhint: 'send',
    },
  });

  function syncNlTargetUi(): void {
    const isCar = nlTarget === 'car';
    targetToggle.textContent = isCar ? '🤖 My Car' : '🏭 Floor';
    targetToggle.classList.toggle('on', isCar);
    input.placeholder = isCar
      ? 'Direct your Co-Pilot… (e.g. "sweep Zones C & D, prioritize P0s, charge at 30%")'
      : 'Tell the floor what to do… (e.g. "get hazmats to returns", "rush wave", or click 🎯 Objectives)';
  }

  const form = el('form', { class: 'nl-form' }, [targetToggle, input]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = input.value.trim().slice(0, NL_MAX_LEN);
    if (!raw) return;
    if (/^(@floor|floor:)/i.test(raw)) {
      actions.nlCommand(raw.replace(/^(@floor|floor:)\s*/i, ''));
    } else if (/^(@me|@car|copilot:)/i.test(raw) || nlTarget === 'car') {
      const cleaned = raw.replace(/^(@me|@car|copilot:)\s*/i, '');
      actions.agentCommand({
        vid: store.you?.vid ?? undefined,
        mode: 'autopilot',
        text: cleaned,
      });
    } else {
      actions.nlCommand(raw);
    }
    input.value = '';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') input.blur();
  });

  const pillCopilotP0 = button(
    '🤖 My Car: P0s',
    'btn small intent-pill intent-pill--accent',
    () =>
      actions.agentCommand({
        vid: store.you?.vid ?? undefined,
        mode: 'autopilot',
        text: 'Prioritize urgent P0 orders across the floor with Sprinter speed',
        directive: {
          autopilot: true,
          persona: 'Sprinter',
          priority: 'p0_first',
          immediateTask: 'pick_p0',
          tactics: { speed: 1.35, preemptForP0: true, batch: 1 },
          summary: 'P0 Responder · Sprinter · P0 First',
        },
      }),
    'Engage Co-Pilot on your forklift to hunt urgent ★ P0 orders at Sprinter speed',
  );
  const pillHazRet = button(
    '☣ Hazmat → Returns',
    'btn small intent-pill warn',
    () =>
      actions.dispatchRoute({
        sourceZone: 'haz',
        targetBay: 'RET',
        priority: 'rush',
        mode: 'nearest',
        count: 2,
      }),
    'Dispatch 2 Hazmat (Zone Z) pallets to Returns & QA containment bay (RET) with P0 priority',
  );
  const pillColdE2 = button(
    '❄ Cold → Bay E2',
    'btn small intent-pill',
    () =>
      actions.dispatchRoute({
        sourceZone: 'cold',
        targetBay: 'E2',
        priority: 'rush',
        mode: 'nearest',
        count: 2,
      }),
    'Dispatch 2 Cold Storage (Zone W) pallets to East Dock Bay E2 with P0 priority',
  );
  const pillBacklog = button(
    '🔥 Clear Backlog',
    'btn small intent-pill',
    () =>
      actions.dispatchRoute({
        sourceZone: 'any',
        targetBay: 'any',
        priority: 'rush',
        mode: 'all',
        count: 3,
      }),
    'Expedite up to 3 open floor orders to P0 priority and dispatch nearest idle forklifts',
  );
  const pillObjectives = button(
    '🎯 Objectives',
    'btn small intent-pill intent-pill--accent',
    () => actions.openObjectives(),
    'Open the interactive A2UI Floor Objective & Route Clarification Builder',
  );
  const intentBar = el(
    'div',
    { class: 'hud intent-pills', attrs: { role: 'toolbar', 'aria-label': 'Quick floor intent pills' } },
    [
      el('span', { class: 'label intent-pills__label', text: 'Quick Intents' }),
      pillCopilotP0,
      pillHazRet,
      pillColdE2,
      pillBacklog,
      pillObjectives,
    ],
  );

  const relocationWrap = el('div', {
    class: 'hud relocation-pill-bar',
    attrs: { 'data-role': 'relocation-pill', role: 'region', 'aria-label': 'Surge relocation offer' },
  });
  relocationWrap.hidden = true;
  const relocationView = new KeyedView(relocationWrap);

  const opsRow = (label: string, desc: Array<Node | string>): HTMLElement =>
    el('div', { class: 'ops-guide__row' }, [el('b', { class: 'ops-guide__key', text: label }), el('span', {}, desc)]);

  const opsGuide = el('div', { class: 'hud ops-guide', attrs: { role: 'region', 'aria-label': 'Floor operations guide' } }, [
    el('div', { class: 'ops-guide__head' }, [
      el('span', { class: 'label', text: 'Floor & Manager Operations' }),
      button('✕', 'btn small', () => actions.setOpsGuide(false), 'Close operations guide'),
    ]),
    opsRow('🚜 Drive / WASD', [
      'Drive your forklift manually with ',
      kbd('WASD'),
      '/Arrows, ',
      kbd('E'),
      ' to pick/drop/charge, ',
      kbd('Shift'),
      ' to boost. Pressing ',
      kbd('WASD'),
      ' takes over from Co-Pilot instantly.',
    ]),
    opsRow('🤖 Co-Pilot [G / Esc]', [
      'Press ',
      kbd('Esc'),
      ' while driving to hand your forklift to AI Co-Pilot (keeps your lease & points). Press ',
      kbd('G'),
      ' to open the Agent Designer modal.',
    ]),
    opsRow('☣ Hazmat → Returns', [
      'Routes Hazmat (Zone Z) pallets directly to the Returns & QA containment bench (RET, +6 bonus pts) and assigns nearest idle forklifts.',
    ]),
    opsRow('🎯 Objectives', [
      'Opens the A2UI Floor Objective Builder to customize source zone, destination bay, priority, and batch size with live floor telemetry.',
    ]),
    opsRow('⚡ Rush wave', [
      'Drops 12 orders immediately + spikes order arrivals (+32/hr) for 30 game-min to stress-test the floor and score fast.',
    ]),
    opsRow('★ P0 order', [
      'Posts a 40-pt urgent purple pallet (30m deadline, max 4 active at once).',
    ]),
    opsRow('🚧 Cones [C]', [
      'Click open floor tiles to place/remove traffic cones that redirect AI pathfinding around jams.',
    ]),
    opsRow('💬 Command bar', [
      'Toggle ',
      kbd('🤖 My Car'),
      ' vs ',
      kbd('🏭 Floor'),
      ' to instruct your own forklift Co-Pilot or dispatch the entire warehouse in plain English.',
    ]),
  ]);
  opsGuide.hidden = true;

  const root = el('div', { class: 'hud command-bar' }, [
    drive,
    copilotBtn,
    el('span', { class: 'vsep' }),
    rush,
    p0,
    cones,
    el('span', { class: 'vsep' }),
    form,
    opsBtn,
  ]);
  zone.append(opsGuide, relocationWrap, intentBar, root);
  return {
    update() {
      const v = commandBarView(store);
      drive.disabled = !v.ready || (v.driving && !v.autopilot);
      drive.title = v.driveTitle;
      copilotBtn.disabled = !v.ready;
      copilotBtn.classList.toggle('on', v.agentDesignerOpen || v.autopilot);
      copilotBtn.textContent = v.autopilot ? '🤖 Co-Pilot: ON [G]' : '🤖 Co-Pilot [G]';
      for (const b of [rush, p0, cones, pillCopilotP0, pillHazRet, pillColdE2, pillBacklog, pillObjectives, targetToggle]) {
        b.disabled = !v.ready;
      }
      pillObjectives.classList.toggle('on', Boolean(store.activeA2ui));
      input.disabled = !v.ready;
      rush.textContent = v.rushText;
      rush.title = v.rushTitle;
      rush.classList.toggle('on', v.rushActive);
      p0.textContent = v.p0Text;
      p0.title = v.p0Title;
      p0.classList.toggle('on', v.p0Active);
      cones.title = v.conesTitle;
      cones.classList.toggle('on', v.conesActive);
      cones.setAttribute('aria-pressed', String(v.conesActive));
      opsBtn.classList.toggle('on', v.opsGuideOpen);
      opsBtn.setAttribute('aria-expanded', String(v.opsGuideOpen));
      opsGuide.hidden = !v.opsGuideOpen;

      const offer = store.relocationOffer;
      if (!offer) {
        relocationWrap.hidden = true;
        relocationView.render('none', () => []);
      } else {
        relocationWrap.hidden = false;
        relocationView.render(
          `${offer.fromSite}|${offer.toSite}|${offer.bonusPts}|${offer.activeDrivers}`,
          () => {
            const acceptBtn = button(
              `⚡ Relocate to ${offer.toSite.toUpperCase()} (+${offer.bonusPts} Pts)`,
              'btn small drive',
              () => actions.acceptRelocation(offer.toSite),
              `Accept cross-site surge transfer to ${offer.toSite.toUpperCase()} and keep your score, streak, and completed perks + ${offer.bonusPts} bonus pts`,
            );
            acceptBtn.dataset.action = 'accept-relocation';
            const dismissBtn = button(
              '✕',
              'btn small',
              () => actions.dismissRelocation(),
              'Dismiss surge relocation offer',
            );
            dismissBtn.dataset.action = 'dismiss-relocation';
            return [
              el('span', {
                class: 'small b',
                text: `🚨 ${offer.fromSite.toUpperCase()} Floor Surge (${offer.activeDrivers}/${offer.maxDrivers} drivers) — ${offer.reason}`,
              }),
              acceptBtn,
              dismissBtn,
            ];
          },
        );
      }
    },
  };
}

export function mountDriveBar(
  zone: HTMLElement,
  ctx: UiCtx,
  opts?: { onBoostChange?: (active: boolean) => void },
): UiModule {
  const { actions } = ctx;
  const root = el('div', { class: 'hud drive-bar', attrs: { role: 'status' } });
  root.hidden = true;
  const infoWrap = el('div', { class: 'drive-bar__info' });
  const view = new KeyedView(infoWrap);

  const copilotToggleBtn = button(
    '🤖 Engage Co-Pilot [Esc]',
    'btn small drive-bar__copilot',
    () => {
      const isAuto = ctx.store.isMyVehicleAutopilot();
      actions.setAutopilot(!isAuto);
    },
    'Toggle between Manual (WASD) driving and AI Co-Pilot Autopilot while keeping your vehicle & score',
  );
  copilotToggleBtn.setAttribute('data-role', 'copilot-toggle');

  const designerBtn = button(
    '🎛️ Designer [G]',
    'btn small drive-bar__designer',
    () => actions.showAgentDesigner(!ctx.store.ui.agentDesignerOpen),
    'Open the Co-Pilot & Agent Designer modal [G] to customize your forklift persona, zones, and tactics',
  );
  designerBtn.setAttribute('data-role', 'agent-designer-btn');

  const boostBtn = button(
    '⚡ Boost [Shift]',
    'btn small drive-bar__boost',
    undefined,
    'Hold Shift, Space, or press & hold to boost speed (+65% speed; collisions drop carried pallets!)',
  );
  boostBtn.setAttribute('data-role', 'boost-btn');
  boostBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    opts?.onBoostChange?.(true);
  });
  for (const evName of ['pointerup', 'pointerleave', 'pointercancel'] as const) {
    boostBtn.addEventListener(evName, () => {
      opts?.onBoostChange?.(false);
    });
  }
  root.append(infoWrap, copilotToggleBtn, designerBtn, boostBtn);
  zone.append(root);
  return {
    update() {
      const { store } = ctx;
      const me = store.isDriving() ? store.myVehicle() : null;
      if (!me) {
        root.hidden = true;
        view.invalidate();
        return;
      }
      root.hidden = false;
      const isAuto = Boolean(me.autopilot);
      const g = store.myGuide();
      const lb = leaderboard(store.world);
      const rank = lb.findIndex((r) => r.id === me.id) + 1;
      const dist =
        g && typeof g.x === 'number' && typeof g.y === 'number'
          ? Math.round(Math.abs(g.x - me.tile.x) + Math.abs(g.y - me.tile.y))
          : null;
      const bat = Math.round(me.battery);
      const boosting = Boolean(me.input?.boost) && me.battery > 0;
      const hasCargoRisk = boosting && (me.cargo?.length ?? 0) > 0;

      copilotToggleBtn.classList.toggle('on', isAuto);
      copilotToggleBtn.textContent = isAuto ? '🕹️ Take Over [WASD]' : '🤖 Co-Pilot [Esc]';
      designerBtn.classList.toggle('on', store.ui.agentDesignerOpen);

      boostBtn.classList.toggle('is-boosting', boosting);
      boostBtn.classList.toggle('has-cargo-risk', hasCargoRisk);
      boostBtn.disabled = bat <= 0;
      boostBtn.textContent =
        bat <= 0
          ? '🪫 Recharge to Boost'
          : hasCargoRisk
            ? '⚡ BOOSTING (Cargo Risk!)'
            : boosting
              ? '⚡ BOOSTING'
              : '⚡ Boost [Shift]';

      const dirSummary = formatDirectiveSummary(me);
      const primaryText = isAuto
        ? `${me.msg ? `${me.msg} · ` : ''}${dirSummary}`
        : g?.text
          ? `${g.inRange ? '✓' : '▶'} ${g.text}`
          : `Driving ${me.id} · WASD to steer or Esc for Co-Pilot`;

      const combo = comboMeter(me.combo);
      const runMode = me.runMode ?? store.runMode ?? 'blitz';
      const remSimMin = me.runEndsAt != null ? Math.max(0, me.runEndsAt - store.world.t) : 300;
      const isOverdrive = runMode === 'blitz' && me.runEndsAt != null && remSimMin <= 60;
      const blitzClock = runMode === 'blitz' ? formatBlitzRemaining(me, store.world.t) : '';
      const ppm = computeDriverPpm(me, store.world.t);
      const streak = me.streak ?? 0;
      const sMult = streakMultiplier(streak);
      const modeLabel =
        runMode === 'blitz'
          ? `⏱️ Blitz ${blitzClock}`
          : `🌐 Free Range · ${ppm.toFixed(1)} PPM`;

      view.render(
        JSON.stringify([
          isAuto,
          primaryText,
          g?.inRange,
          dist,
          rank,
          Math.round(me.sPts),
          bat,
          me.id,
          combo.label,
          modeLabel,
          isOverdrive,
          streak,
        ]),
        () => {
          const modeBtn = button(
            modeLabel,
            `btn small intent-pill run-mode-pill ${runMode}${isOverdrive ? ' overdrive' : ''}`,
            () => actions.setRunMode(runMode === 'blitz' ? 'freerange' : 'blitz'),
            runMode === 'blitz'
              ? '5-Minute Blitz mode active — click to switch to open-ended Free Range mode'
              : 'Free Range mode active — click to start a fresh 5-Minute Blitz countdown',
          );
          modeBtn.setAttribute('data-role', 'run-mode-pill');
          return [
            el('span', {
              class: `drive-mode-pill ${isAuto ? 'auto' : 'manual'}`,
              text: isAuto ? '🤖 CO-PILOT AUTO' : '🕹️ MANUAL (WASD)',
            }),
            modeBtn,
            el('span', {
              class: isAuto ? 'go' : g?.inRange ? 'ok' : 'go',
              text: primaryText,
            }),
            !isAuto && dist !== null && !g?.inRange ? el('span', { class: 'muted num', text: `${dist} tiles` }) : null,
            el('span', {
              class: `num${bat <= 0 ? ' bad b' : bat < 20 ? ' bad' : ''}`,
              text: bat <= 0 ? '🪫 0% LIMP (Drive to ⚡)' : `🔋 ${bat}%`,
            }),
            el('span', { class: 'num', text: `${rank ? `#${rank} · ` : ''}${Math.round(me.sPts)} pts` }),
            streak > 0
              ? el('span', {
                  class: `streak-pill num${sMult > 1 ? ' hot' : ''}`,
                  attrs: { 'data-role': 'streak-pill' },
                  title: 'Consecutive on-time deliveries: 3+ = 1.15×, 5+ = 1.3×, 8+ = 1.5× points! Resets on late delivery, crash, or pallet drop.',
                  text: `🔥 ×${streak}${sMult > 1 ? ` (${sMult}×)` : ''}`,
                })
              : null,
            el(
              'span',
              {
                class: `combo-pill${combo.max ? ' max' : ''}`,
                title: 'Fare combo: SPEEDY/NORMAL trips climb ×1.0 → ×1.2 → ×1.5 → ×2.0; slow trips, crashes, drops and skids reset it.',
                attrs: { 'data-role': 'combo-meter' },
              },
              [
                el('span', { class: 'combo-pill__label num', text: combo.label }),
                el(
                  'span',
                  { class: 'combo-pips', attrs: { 'aria-hidden': 'true' } },
                  combo.pips.map((p) => el('span', { class: `combo-pip${p.on ? ' on' : ''}` })),
                ),
              ],
            ),
          ];
        },
      );
    },
  };
}
