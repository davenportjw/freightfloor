/**
 * Mobile / touch driving controls (#touchControls):
 *   - Bottom-left: floating virtual thumbstick (8-way steering + throttle/brake via Pointer Events)
 *   - Bottom-right: dedicated Hold-to-Boost button and contextual Interact (Pick / Drop / Clear / Charge / Take) button
 *
 * Shown on touch / compact mobile viewports while in DRIVE mode with no modal/sheet overlay open.
 */
import type { FareOffer, Vehicle } from '@warehouse/sim';
import { thumbstickDirsFromVector } from '../input.js';
import { headingUpRotation } from '../render/iso.js';
import type { GuideInfo } from '../state.js';
import type { UiCtx, UiModule } from './context.js';
import type { ActiveOverlay, HudMode } from './mode.js';

export interface TouchControlsInput {
  hudMode: HudMode;
  activeOverlay: ActiveOverlay;
  helpOpen?: boolean;
  drawerOpen?: boolean;
  leaderboardOpen?: boolean;
  agentDesignerOpen?: boolean;
  me: Pick<Vehicle, 'battery' | 'autopilot' | 'runFinished' | 'orders' | 'cargo'> | null;
  guide: GuideInfo | null;
  fareOffer: FareOffer | null;
  fareSel?: number;
  boostHeld: boolean;
}

export interface TouchControlsView {
  visible: boolean;
  interactLabel: string;
  interactSub: string;
  interactReady: boolean;
  interactTone: 'blue' | 'amber' | 'teal' | 'neutral';
  selectedFareOrderId: number | null;
  boostDisabled: boolean;
  boostActive: boolean;
}

/** Pure view-model for #touchControls visibility and button states. */
export function touchControlsView(inp: TouchControlsInput): TouchControlsView {
  const modalOpen = Boolean(
    inp.activeOverlay !== null ||
      inp.helpOpen ||
      inp.drawerOpen ||
      inp.leaderboardOpen ||
      inp.agentDesignerOpen,
  );
  const visible = inp.hudMode === 'driving' && !modalOpen && inp.me !== null;

  let interactLabel = 'Act';
  let interactSub = 'E · Use';
  let interactReady = false;
  let interactTone: TouchControlsView['interactTone'] = 'neutral';

  const opts = inp.fareOffer?.options ?? [];
  const selIdx = Math.max(0, Math.min(opts.length - 1, inp.fareSel ?? 0));
  const selectedFareOrderId = opts.length > 0 ? (opts[selIdx]?.orderId ?? opts[0]!.orderId) : null;

  const g = inp.guide;
  if (g && g.inRange) {
    interactReady = true;
    const kind = g.kind.toLowerCase();
    const txt = (g.text ?? '').toLowerCase();
    if (kind.includes('pick') || txt.startsWith('pick')) {
      interactLabel = 'Pick';
      interactSub = 'Pallet';
      interactTone = 'blue';
    } else if (kind.includes('drop') || kind.includes('deliver') || txt.startsWith('drop') || txt.startsWith('deliver')) {
      interactLabel = 'Drop';
      interactSub = 'Deliver';
      interactTone = 'teal';
    } else if (kind.includes('spill') || kind.includes('clear') || txt.includes('spill')) {
      interactLabel = 'Clear';
      interactSub = 'Spill';
      interactTone = 'amber';
    } else if (kind.includes('charg') || txt.includes('charg')) {
      interactLabel = 'Charge';
      interactSub = 'Battery';
      interactTone = 'teal';
    } else {
      interactLabel = 'Use';
      interactSub = 'E · Now';
      interactTone = 'blue';
    }
  } else if (
    selectedFareOrderId !== null &&
    inp.me &&
    (inp.me.cargo?.length ?? 0) === 0 &&
    (inp.me.orders?.length ?? 0) === 0
  ) {
    interactLabel = `Take #${selectedFareOrderId}`;
    interactSub = 'Claim';
    interactReady = true;
    interactTone = 'blue';
  }

  const battery = inp.me?.battery ?? 0;
  const boostDisabled = battery <= 0 || Boolean(inp.me?.runFinished);
  const boostActive = Boolean(inp.boostHeld && !boostDisabled);

  return {
    visible,
    interactLabel,
    interactSub,
    interactReady,
    interactTone,
    selectedFareOrderId,
    boostDisabled,
    boostActive,
  };
}

export function mountTouchControls(
  root: HTMLElement,
  ctx: UiCtx,
  isBoostHeld: () => boolean,
): UiModule {
  root.innerHTML = `
    <div class="touch-stick-zone" data-role="touch-stick" aria-label="Virtual steering thumbstick">
      <div class="touch-stick-ring" data-role="stick-base">
        <span class="touch-dir n" data-dir="up" aria-hidden="true">▲</span>
        <span class="touch-dir e" data-dir="right" aria-hidden="true">▶</span>
        <span class="touch-dir s" data-dir="down" aria-hidden="true">▼</span>
        <span class="touch-dir w" data-dir="left" aria-hidden="true">◀</span>
        <div class="touch-stick-knob" data-role="stick-knob"></div>
      </div>
    </div>
    <div class="touch-actions" data-role="touch-actions">
      <button type="button" class="touch-btn boost" data-role="touch-boost" aria-label="Hold to boost">
        <span class="touch-btn-main"><svg class="touch-btn-icon" viewBox="0 0 12 14" width="9" height="11" aria-hidden="true"><path d="M7 0L1 8h4.5L4.5 14 11 5.5H6.5L7 0z" fill="currentColor"/></svg><span>Boost</span></span>
        <span class="touch-btn-sub">HOLD</span>
      </button>
      <button type="button" class="touch-btn interact" data-role="touch-interact" aria-label="Interact with pallet, bay, or spill">
        <span class="touch-btn-main" data-role="interact-label">Act</span>
        <span class="touch-btn-sub" data-role="interact-sub">E · Use</span>
      </button>
    </div>
  `;

  const stickZone = root.querySelector<HTMLElement>('[data-role="touch-stick"]')!;
  const stickBase = root.querySelector<HTMLElement>('[data-role="stick-base"]')!;
  const stickKnob = root.querySelector<HTMLElement>('[data-role="stick-knob"]')!;
  const dirUpEl = root.querySelector<HTMLElement>('[data-dir="up"]')!;
  const dirDownEl = root.querySelector<HTMLElement>('[data-dir="down"]')!;
  const dirLeftEl = root.querySelector<HTMLElement>('[data-dir="left"]')!;
  const dirRightEl = root.querySelector<HTMLElement>('[data-dir="right"]')!;
  const boostBtn = root.querySelector<HTMLButtonElement>('[data-role="touch-boost"]')!;
  const interactBtn = root.querySelector<HTMLButtonElement>('[data-role="touch-interact"]')!;
  const interactLabelEl = root.querySelector<HTMLElement>('[data-role="interact-label"]')!;
  const interactSubEl = root.querySelector<HTMLElement>('[data-role="interact-sub"]')!;

  let stickPointerId: number | null = null;
  let stickCenterX = 0;
  let stickCenterY = 0;
  let boostPointerId: number | null = null;

  const updateStickFromPoint = (clientX: number, clientY: number) => {
    const me = ctx.store.myVehicle();
    if (ctx.store.isDriving() && me?.runFinished && ctx.store.ui.runEnd === null && ctx.store.hudMode() === 'driving') {
      ctx.actions.showRunEnd();
      return;
    }
    const dx = clientX - stickCenterX;
    const dy = clientY - stickCenterY;
    const camMode =
      typeof ctx.store.driveCameraMode === 'function'
        ? ctx.store.driveCameraMode()
        : (ctx.store.ui?.driveCameraMode ?? 'fixed');
    const camRot = camMode === 'headingUp' && me ? headingUpRotation(me.angle) : 0;
    const state = thumbstickDirsFromVector(dx, dy, 10, 34, camRot);
    stickKnob.style.transform = `translate3d(${state.clampedX.toFixed(1)}px, ${state.clampedY.toFixed(1)}px, 0)`;
    stickZone.classList.toggle('active', state.active);
    dirUpEl.classList.toggle('on', state.up);
    dirDownEl.classList.toggle('on', state.down);
    dirLeftEl.classList.toggle('on', state.left);
    dirRightEl.classList.toggle('on', state.right);
    ctx.actions.setTouchDirs({
      up: state.up,
      down: state.down,
      left: state.left,
      right: state.right,
      moveAngle: state.moveAngle,
    });
  };

  const releaseStick = () => {
    if (stickPointerId === null && !stickZone.classList.contains('active')) return;
    stickPointerId = null;
    stickKnob.style.transform = 'translate3d(0px, 0px, 0)';
    stickZone.classList.remove('active');
    dirUpEl.classList.remove('on');
    dirDownEl.classList.remove('on');
    dirLeftEl.classList.remove('on');
    dirRightEl.classList.remove('on');
    ctx.actions.setTouchDirs({
      up: false,
      down: false,
      left: false,
      right: false,
      moveAngle: null,
    });
  };

  stickZone.addEventListener('pointerdown', (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    stickPointerId = e.pointerId;
    const rect = stickBase.getBoundingClientRect();
    stickCenterX = rect.left + rect.width / 2;
    stickCenterY = rect.top + rect.height / 2;
    try {
      stickZone.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events in unit tests may not support setPointerCapture
    }
    updateStickFromPoint(e.clientX, e.clientY);
  });

  stickZone.addEventListener('pointermove', (e: PointerEvent) => {
    if (stickPointerId === null || e.pointerId !== stickPointerId) return;
    e.preventDefault();
    updateStickFromPoint(e.clientX, e.clientY);
  });

  const onStickEnd = (e: PointerEvent) => {
    if (stickPointerId !== null && e.pointerId !== stickPointerId) return;
    releaseStick();
  };
  stickZone.addEventListener('pointerup', onStickEnd);
  stickZone.addEventListener('pointercancel', onStickEnd);
  stickZone.addEventListener('lostpointercapture', onStickEnd);

  const releaseBoost = () => {
    if (boostPointerId === null && !isBoostHeld()) return;
    boostPointerId = null;
    ctx.actions.setBoost(false);
    boostBtn.classList.remove('active');
  };

  boostBtn.addEventListener('pointerdown', (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (boostBtn.disabled) return;
    boostPointerId = e.pointerId;
    try {
      boostBtn.setPointerCapture(e.pointerId);
    } catch {
      // Ignore in synthetic test environments
    }
    ctx.actions.setBoost(true);
    boostBtn.classList.add('active');
  });

  const onBoostEnd = (e: PointerEvent) => {
    if (boostPointerId !== null && e.pointerId !== boostPointerId) return;
    releaseBoost();
  };
  boostBtn.addEventListener('pointerup', onBoostEnd);
  boostBtn.addEventListener('pointercancel', onBoostEnd);
  boostBtn.addEventListener('lostpointercapture', onBoostEnd);

  const interactHold = createInteractHold(ctx.actions);
  interactBtn.addEventListener('pointerdown', (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const s = ctx.store;
    const me = s.myVehicle();
    if (s.isDriving() && me?.runFinished && s.ui.runEnd === null && s.hudMode() === 'driving') {
      ctx.actions.showRunEnd();
      return;
    }
    const g = s.myGuide();
    if (g && g.inRange) {
      try {
        interactBtn.setPointerCapture(e.pointerId);
      } catch {
        // Ignore in synthetic test environments
      }
      interactHold.down();
      return;
    }
    const off = s.myFareOffer();
    const opts = off?.options ?? [];
    const selIdx = Math.max(0, Math.min(opts.length - 1, s.ui.fareSel));
    const selOrderId = opts.length > 0 ? (opts[selIdx]?.orderId ?? opts[0]!.orderId) : null;
    if (selOrderId !== null && me && me.cargo.length === 0 && me.orders.length === 0) {
      ctx.actions.chooseOrder(selOrderId);
      return;
    }
    interactHold.down();
  });

  const onInteractEnd = () => interactHold.release();
  interactBtn.addEventListener('pointerup', onInteractEnd);
  interactBtn.addEventListener('pointercancel', onInteractEnd);
  interactBtn.addEventListener('lostpointercapture', onInteractEnd);

  return {
    update() {
      const s = ctx.store;
      const me = s.myVehicle();
      const vm = touchControlsView({
        hudMode: s.hudMode(),
        activeOverlay: s.activeOverlay(),
        helpOpen: s.ui.helpOpen,
        drawerOpen: s.ui.drawerOpen,
        leaderboardOpen: s.ui.leaderboardModalOpen,
        agentDesignerOpen: s.ui.agentDesignerOpen,
        me,
        guide: s.myGuide(),
        fareOffer: s.myFareOffer(),
        fareSel: s.ui.fareSel,
        boostHeld: isBoostHeld(),
      });

      if (!vm.visible) {
        if (!root.hidden) {
          releaseStick();
          releaseBoost();
          // Hidden mid-hold (a modal / sheet opened): pointerup will never reach the button.
          interactHold.release();
          root.hidden = true;
        }
        return;
      }
      root.hidden = false;

      if (interactLabelEl.textContent !== vm.interactLabel) {
        interactLabelEl.textContent = vm.interactLabel;
      }
      if (interactSubEl.textContent !== vm.interactSub) {
        interactSubEl.textContent = vm.interactSub;
      }
      interactBtn.classList.toggle('ready', vm.interactReady);
      interactBtn.classList.toggle('amber', vm.interactReady && vm.interactTone === 'amber');
      interactBtn.classList.toggle('teal', vm.interactReady && vm.interactTone === 'teal');
      boostBtn.disabled = vm.boostDisabled;
      boostBtn.classList.toggle('active', vm.boostActive);
    },
  };
}

/** Touch Interact hold state: `release()` is idempotent and safe to call from the hide path. */
export interface InteractHold {
  readonly held: boolean;
  down(): void;
  release(): void;
}

export function createInteractHold(actions: {
  interact(): void;
  interactDown?: () => void;
  interactUp?: () => void;
}): InteractHold {
  let held = false;
  return {
    get held() {
      return held;
    },
    down() {
      held = true;
      if (actions.interactDown) actions.interactDown();
      else actions.interact();
    },
    release() {
      if (!held) return;
      held = false;
      actions.interactUp?.();
    },
  };
}
