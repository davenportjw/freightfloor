/**
 * Which rack slot the Cab View lift visuals (fork laser, tolerance slab, fork-cam) should aim at.
 * Pure: depends only on sim state, the guide, and the RackLiftController.
 */
import {
  getCardModifiers,
  requiresRackLift,
  type DistrictKind,
  type Order,
  type Slot,
  type Vehicle,
  type World,
} from '@warehouse/sim';
import { resolveDistrict, type RackLiftController } from '../ui/rackLiftMinigame.js';

export interface LiftTarget {
  slot: Slot;
  level: 0 | 1 | 2;
  district: DistrictKind;
  forkLiftMul: number;
  /** True while E is held / two-tap armed (the mast is under player control). */
  active: boolean;
}

interface GuideLike {
  kind: string;
  x?: number | null;
  y?: number | null;
  stow?: boolean;
  order?: { id: number } | null;
}

export function resolveLiftTarget(
  world: World,
  me: Vehicle,
  guide: GuideLike | null | undefined,
  rackLift: RackLiftController | null | undefined,
): LiftTarget | null {
  if (rackLift?.isActive() && rackLift.slot) {
    return {
      slot: rackLift.slot,
      level: rackLift.targetLevel,
      district: rackLift.district,
      forkLiftMul: rackLift.forkLiftMul,
      active: true,
    };
  }
  if (!guide || guide.x == null || guide.y == null) return null;
  let order: Order | undefined;
  let slot: Slot | undefined;
  if (guide.kind === 'pick') {
    order = world.orders.find(
      (o) => (guide.order?.id != null && o.id === guide.order.id) || (o.slot.ax === guide.x && o.slot.ay === guide.y),
    );
    if (order && requiresRackLift(order, 'pick')) slot = order.slot;
  } else if (guide.kind === 'drop' && guide.stow) {
    order = (me.cargo ?? []).find(
      (o) =>
        (guide.order?.id != null && o.id === guide.order.id) ||
        (o.putaway && o.putaway.ax === guide.x && o.putaway.ay === guide.y),
    );
    if (order && order.putaway && requiresRackLift(order, 'stow')) slot = order.putaway;
  }
  if (!order || !slot) return null;
  return {
    slot,
    level: (slot.level ?? 0) as 0 | 1 | 2,
    district: resolveDistrict(world, order, slot),
    forkLiftMul: getCardModifiers(world, me).forkLiftMul ?? 1,
    active: false,
  };
}
