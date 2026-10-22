/**
 * Pure helpers for the floor-order map overlays (cone placement ghost, dispatch preview).
 * They mirror server-side rules so the preview matches what the server will accept; the
 * server stays authoritative and still rejects invalid requests with an error (shown via ui/notify.ts).
 */
import { bayAt, chargerAt, isBlocked, type World } from '@warehouse/sim';

/**
 * Dispatch source zone -> rack zone letters. Copied from the sim's (unexported)
 * SOURCE_ZONE_TO_RACKS in packages/sim/src/engine.ts; keep the two in sync.
 */
const SOURCE_ZONE_TO_RACKS: Record<string, readonly string[]> = {
  haz: ['Z'],
  cold: ['W'],
  bulk: ['X'],
  high: ['U'],
  general: ['A', 'B', 'C', 'D', 'E'],
  any: ['Z', 'W', 'X', 'U', 'A', 'B', 'C', 'D', 'E'],
};

/** Rack zone letters a dispatch from `sourceZone` draws from (single letters map to themselves). */
export function dispatchRackZones(sourceZone: string): readonly string[] {
  return SOURCE_ZONE_TO_RACKS[sourceZone] ?? (/^[A-Z]$/.test(sourceZone) ? [sourceZone] : []);
}

/**
 * Why a cone cannot be placed on tile (x, y), or null when it can (mirrors sim toggleCone).
 * An existing cone is always valid: clicking it removes it.
 */
export function coneTileError(world: World, x: number, y: number): string | null {
  if (world.cones.has(`${x},${y}`)) return null;
  if (isBlocked(world, x, y)) return 'Cones go on open floor only.';
  if (bayAt(world.map, x, y) || chargerAt(world.map, x, y) >= 0) return 'Keep bays and chargers clear.';
  const k = `${x},${y}`;
  if (world.orders.some((o) => o.slot.key === k)) return 'That tile is an active pickup.';
  if (
    world.vehicles.some(
      (v) => (v.tile.x === x && v.tile.y === y) || (!!v.moveTo && v.moveTo.x === x && v.moveTo.y === y),
    )
  ) {
    return 'A vehicle is on that tile.';
  }
  return null;
}
