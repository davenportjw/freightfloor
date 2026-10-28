/**
 * Opt-in 3D Vertical Rack Lift Minigame ("Option A: Hold E to Raise Forks & Release E to Grab").
 *
 * - Default OFF (`store.isRackLiftEnabled() === false`); when disabled, `onInteractDown`
 *   immediately sends `{ type: 'interact' }` with no `forkHeight`, preserving 100% existing behavior.
 * - When enabled and in reach of a rack slot (`requiresRackLift(order, action)`):
 *   - Holding `E` (`onInteractDown`) smoothly raises the 3D forklift mast & fork carriage from
 *     `0.08` up to `0.98` (oscillating between `0.06` and `0.98` if held past top).
 *   - Releasing `E` (`onInteractUp`) locks `currentFork` and sends `{ type: 'interact', forkHeight }`.
 *   - Smart Hybrid Safety Net (`< 140ms`): if the target shelf is L2 (`1`) or L3 (`2`) and the player
 *     only tapped `E` quickly (`heldMs < 140`), `twoTapArmed = true` keeps the forks rising so a
 *     second `E` press locks the height instead of accidentally scraping at the bottom!
 *   - On L1 (`0`), a quick tap is already inside the L1 sweet spot (`0.08..0.22`), so releasing
 *     immediately commits a Perfect/Clean L1 grab with zero extra friction.
 */
import {
  evaluateRackLift,
  getCardModifiers,
  interactAt,
  KINDS,
  RACK_LEVEL_FORK_TARGETS,
  RACK_LEVEL_LABELS,
  rackLiftWindows,
  requiresRackLift,
  type DistrictKind,
  type Order,
  type Slot,
  type Vehicle,
  type World,
} from '@warehouse/sim';

export const TWO_TAP_THRESHOLD_MS = 140;

export interface RackLiftGaugeLayout {
  isCompact: boolean;
  cardX: number;
  cardY: number;
  cardW: number;
  cardH: number;
  trackX: number;
  trackY: number;
  trackW: number;
  trackH: number;
  cursorH: number;
  labelFontPx: number;
}

export function computeRackLiftGaugeLayout(
  viewportWidth: number,
  viewportHeight: number,
  anchorX: number,
  anchorY: number,
  active = false,
): RackLiftGaugeLayout {
  const vw = viewportWidth > 0 ? viewportWidth : 1024;
  const vh = viewportHeight > 0 ? viewportHeight : 768;
  const isCompact = vw <= 680;
  const trackW = (isCompact ? 26 : 22) + (active ? 2 : 0);
  const trackH = (isCompact ? 126 : 112) + (active ? 6 : 0);
  const cardW = trackW + (isCompact ? 44 : 40);
  const cardH = trackH + 28;

  // Clamp within viewport bounds (keeping clear of top objective bar and bottom mobile touch controls)
  const minX = 12;
  const maxX = Math.max(minX, vw - cardW - 12);
  const minY = isCompact ? 88 : 96;
  const bottomMargin = isCompact ? 160 : 64;
  const maxY = Math.max(minY, vh - cardH - bottomMargin);

  const rawCardX = Math.round(anchorX + (isCompact ? 28 : 34));
  const rawCardY = Math.round(anchorY - cardH * 0.52);

  const cardX = Math.max(minX, Math.min(maxX, rawCardX));
  const cardY = Math.max(minY, Math.min(maxY, rawCardY));

  return {
    isCompact,
    cardX,
    cardY,
    cardW,
    cardH,
    trackX: cardX + 8,
    trackY: cardY + 20,
    trackW,
    trackH,
    cursorH: isCompact ? 7 : 6,
    labelFontPx: isCompact ? 12 : 11,
  };
}

export interface RackLiftFlash {
  grade: 'perfect' | 'clean' | 'scrape';
  label: string;
  sublabel: string;
  slot: Slot;
  forkHeight: number;
  targetLevel: 0 | 1 | 2;
  untilMs: number;
}

export function resolveDistrict(w: World, o: Order, slot: Slot): DistrictKind {
  const rawZone = (o as { zone?: string }).zone ?? slot.zone;
  if (rawZone && rawZone in KINDS) return rawZone as DistrictKind;
  const rack = w.map?.racks?.find((r) => r.id === slot.rackId);
  if (rack) return rack.kind;
  const zk = w.map?.zoneKind?.[slot.zone];
  if (zk) return zk;
  return 'ambient';
}

function hasArmedPrecisionStop(w: World | null, v: Vehicle | null, slot: Slot): boolean {
  const a = v?.precisionArmed;
  if (!w || !v || !a) return false;
  if (typeof a.until === 'number' && Array.isArray(a.tiles)) {
    return a.until >= w.t && a.tiles.some((t) => t.x === slot.ax && t.y === slot.ay);
  }
  if (typeof a.t === 'number' && typeof a.x === 'number' && typeof a.y === 'number') {
    return w.t - a.t <= 0.05 && Math.hypot(a.x - (slot.ax + 0.5), a.y - (slot.ay + 0.5)) <= 1.6;
  }
  return false;
}

export class RackLiftController {
  active = false;
  twoTapArmed = false;
  orderId: number | null = null;
  action: 'pick' | 'stow' = 'pick';
  slot: Slot | null = null;
  district: DistrictKind = 'ambient';
  targetLevel: 0 | 1 | 2 = 0;
  targetFork = 0.14;
  currentFork = 0.08;
  direction: 1 | -1 = 1;
  startedAtMs = 0;
  forkLiftMul = 1;
  flash: RackLiftFlash | null = null;
  /**
   * True when the site does not grade lifts (`limits.rackLiftMinigame` off ⇒ server kill switch),
   * but the player enabled Lift Mode locally (or is in Cab View). Flashes say PRACTICE, no $.
   */
  practice = false;

  /** Server-identical grading windows for the active (or given) target level. */
  windows(level: 0 | 1 | 2 = this.targetLevel): ReturnType<typeof rackLiftWindows> {
    return rackLiftWindows(level, { forkLiftMul: this.forkLiftMul, district: this.district });
  }

  resolveCandidate(
    world: World,
    vehicle: Vehicle,
  ): { action: 'pick' | 'stow'; order: Order; slot: Slot; level: 0 | 1 | 2 } | null {
    const r = interactAt(world, vehicle);
    if (!r) return null;
    const rawHit = 'hit' in r && r.hit !== undefined ? r.hit : r;
    const hit = rawHit as { kind?: string; order?: Order; orders?: Order[] } | null;
    if (!hit || !hit.kind) return null;
    const isDockId = (s: Slot): boolean => {
      const maybeId = (s as Slot & { id?: string }).id ?? '';
      return maybeId.startsWith('DOCK-') || s.rackId.startsWith('DOCK-');
    };
    if (hit.kind === 'pick' && hit.order && requiresRackLift(hit.order, 'pick') && !isDockId(hit.order.slot)) {
      const level = (hit.order.slot.level ?? 0) as 0 | 1 | 2;
      return { action: 'pick', order: hit.order, slot: hit.order.slot, level };
    }
    if (hit.kind === 'stow') {
      const orders = Array.isArray(hit.orders) ? hit.orders : hit.order ? [hit.order] : [];
      const st = orders.find((o) => requiresRackLift(o, 'stow') && o.putaway && !isDockId(o.putaway));
      if (st && st.putaway) {
        const level = (st.putaway.level ?? 0) as 0 | 1 | 2;
        return { action: 'stow', order: st, slot: st.putaway, level };
      }
    }
    return null;
  }

  isActive(): boolean {
    return this.active;
  }

  isTwoTapConfirmPending(): boolean {
    return this.active && this.twoTapArmed;
  }

  lastFlash(nowMs: number): (RackLiftFlash & { at: number }) | null {
    if (!this.flash) return null;
    if (nowMs >= this.flash.untilMs) {
      this.flash = null;
      return null;
    }
    return { ...this.flash, at: this.flash.untilMs - 850 };
  }

  onKeyDown(
    nowMs: number,
    world: World | null,
    vehicle: Vehicle | null,
    enabled: boolean,
  ):
    | { action: 'immediate' }
    | { action: 'lifting'; level: 0 | 1 | 2 }
    | {
        action: 'commit';
        forkHeight: number;
        evaluation: ReturnType<typeof evaluateRackLift> & { bonusPts: number };
      } {
    if (!world || !vehicle || !enabled) {
      this.cancel(vehicle);
      return { action: 'immediate' };
    }
    if (this.active) {
      let committedFork = 0;
      this.commit(nowMs, world, vehicle, (fh) => {
        committedFork = fh ?? this.currentFork;
      });
      const evalRes = evaluateRackLift(committedFork, this.targetLevel, {
        forkLiftMul: this.forkLiftMul,
        district: this.district,
      });
      return {
        action: 'commit',
        forkHeight: committedFork,
        evaluation: { ...evalRes, bonusPts: evalRes.bonusDelta },
      };
    }
    const cand = this.resolveCandidate(world, vehicle);
    if (!cand) {
      return { action: 'immediate' };
    }
    this.active = true;
    this.twoTapArmed = false;
    this.orderId = cand.order.id;
    this.action = cand.action;
    this.slot = cand.slot;
    this.district = resolveDistrict(world, cand.order, cand.slot);
    this.targetLevel = cand.level;
    this.targetFork = RACK_LEVEL_FORK_TARGETS[cand.level];
    this.currentFork = 0.08;
    this.direction = 1;
    this.startedAtMs = nowMs;
    this.forkLiftMul = getCardModifiers(world, vehicle).forkLiftMul ?? 1;
    vehicle.fork = this.currentFork;
    vehicle.forkTarget = this.currentFork;
    return { action: 'lifting', level: cand.level };
  }

  onKeyUp(
    nowMs: number,
    vehicle: Vehicle | null,
    world: World | null = null,
  ):
    | { action: 'noop' }
    | { action: 'continue_two_tap' }
    | {
        action: 'commit';
        forkHeight: number;
        evaluation: ReturnType<typeof evaluateRackLift> & { bonusPts: number };
      } {
    if (!this.active || this.twoTapArmed) return { action: 'noop' };
    const heldMs = Math.max(0, nowMs - this.startedAtMs);
    if (heldMs < TWO_TAP_THRESHOLD_MS && this.targetLevel > 0) {
      this.twoTapArmed = true;
      return { action: 'continue_two_tap' };
    }
    let committedFork = 0;
    this.commit(nowMs, world, vehicle, (fh) => {
      committedFork = fh ?? this.currentFork;
    });
    const evalRes = evaluateRackLift(committedFork, this.targetLevel, {
      forkLiftMul: this.forkLiftMul,
      district: this.district,
    });
    return {
      action: 'commit',
      forkHeight: committedFork,
      evaluation: { ...evalRes, bonusPts: evalRes.bonusDelta },
    };
  }

  onInteractDown(
    nowMs: number,
    world: World | null,
    vehicle: Vehicle | null,
    enabled: boolean,
    sendInteract: (forkHeight?: number) => void,
  ): void {
    const res = this.onKeyDown(nowMs, world, vehicle, enabled);
    if (res.action === 'immediate') {
      sendInteract();
    } else if (res.action === 'commit') {
      sendInteract(res.forkHeight);
    }
  }

  onInteractUp(
    nowMs: number,
    world: World | null,
    vehicle: Vehicle | null,
    sendInteract: (forkHeight?: number) => void,
  ): void {
    const res = this.onKeyUp(nowMs, vehicle, world);
    if (res.action === 'commit') {
      sendInteract(res.forkHeight);
    }
  }

  commit(
    nowMs: number,
    world: World | null,
    vehicle: Vehicle | null,
    sendInteract: (forkHeight?: number) => void,
  ): void {
    if (!this.active || !this.slot) return;
    const fork = Number(this.currentFork.toFixed(3));
    const evalRes = evaluateRackLift(fork, this.targetLevel, {
      forkLiftMul: this.forkLiftMul,
      district: this.district,
    });
    const hadPrecision = hasArmedPrecisionStop(world, vehicle, this.slot);
    if (evalRes.grade === 'perfect') {
      const bonus = hadPrecision ? evalRes.bonusDelta + 5 : evalRes.bonusDelta;
      this.flash = {
        grade: 'perfect',
        label: hadPrecision ? 'SLIDE & SNATCH!' : 'PERFECT LIFT!',
        sublabel: hadPrecision ? `+$${bonus} SURGE` : `+$${evalRes.bonusDelta} BOOST`,
        slot: this.slot,
        forkHeight: fork,
        targetLevel: this.targetLevel,
        untilMs: nowMs + 850,
      };
    } else if (evalRes.grade === 'clean') {
      this.flash = {
        grade: 'clean',
        label: `CLEAN L${this.targetLevel + 1}`,
        sublabel: RACK_LEVEL_LABELS[this.targetLevel],
        slot: this.slot,
        forkHeight: fork,
        targetLevel: this.targetLevel,
        untilMs: nowMs + 850,
      };
    } else {
      this.flash = {
        grade: 'scrape',
        label: 'RACK SCRAPE!',
        sublabel: `-$${Math.abs(evalRes.bonusDelta)} WOBBLE`,
        slot: this.slot,
        forkHeight: fork,
        targetLevel: this.targetLevel,
        untilMs: nowMs + 850,
      };
    }
    if (this.practice) {
      // The site does not grade lifts (server kill switch): never claim a $ swing that won't happen.
      this.flash = {
        ...this.flash,
        label: `PRACTICE · ${this.flash.label.replace(/!$/, '')}`,
        sublabel: 'Not scored on this site',
      };
    }
    if (vehicle) {
      vehicle.fork = fork;
      vehicle.forkTarget = 0.3;
    }
    this.active = false;
    this.twoTapArmed = false;
    sendInteract(fork);
  }

  /**
   * Advance the mast oscillation by `dtMs` real milliseconds (always milliseconds; the old
   * `dt > 2 ? ms : s` heuristic misread sub-2 ms frames on high-refresh displays as seconds).
   */
  step(dtMs: number, world: World | null, vehicle: Vehicle | null, enabled = true): void {
    if (!enabled) {
      this.cancel(vehicle);
      return;
    }
    const dtSec = Math.max(0, Number.isFinite(dtMs) ? dtMs : 0) / 1000;
    if (!this.active) return;
    if (!world || !vehicle || !this.slot) {
      this.cancel(vehicle);
      return;
    }
    const dist = Math.hypot(vehicle.px - (this.slot.ax + 0.5), vehicle.py - (this.slot.ay + 0.5));
    if (dist > 2.1) {
      this.cancel(vehicle);
      return;
    }
    const baseRate = this.district === 'bulk' ? 1.12 : this.district === 'fast' ? 1.35 : 1.12;
    this.currentFork += this.direction * baseRate * dtSec;
    if (this.currentFork >= 0.98) {
      this.currentFork = 0.98;
      this.direction = -1;
    } else if (this.currentFork <= 0.06) {
      this.currentFork = 0.06;
      this.direction = 1;
    }
    vehicle.fork = this.currentFork;
    vehicle.forkTarget = this.currentFork;
  }

  cancel(vehicle?: Vehicle | null): void {
    const wasActive = this.active;
    this.active = false;
    this.twoTapArmed = false;
    this.orderId = null;
    this.slot = null;
    if (wasActive && vehicle) {
      vehicle.forkTarget = vehicle.cargo?.length ? 0.3 : 0.15;
    }
  }
}
