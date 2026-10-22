/**
 * Ghost planner: the route the sim's own planner (`findPath`) would take from the driven
 * forklift to the highlighted order's pickup access tile (or the current guide target).
 * Computed client-side on the locally held World; pure helpers + a tiny memo so A* runs
 * only when the start tile / target / map changes.
 */
import { findPath, type FareOffer, type Point, type World } from '@warehouse/sim';
import { clampIndex } from '../ui/fareChoice.js';

export interface GridPt {
  x: number;
  y: number;
}

export interface GhostTarget {
  x: number;
  y: number;
  /** The order behind the target when known (offer option). */
  orderId: number | null;
}

/**
 * Path (tile cells) → polyline in grid coords: starts at the vehicle's pose and passes through
 * each cell centre. A null path yields an empty polyline.
 */
export function ghostPolyline(start: GridPt, path: readonly Point[] | null | undefined): GridPt[] {
  if (!path) return [];
  const out: GridPt[] = [{ x: start.x, y: start.y }];
  for (const c of path) out.push({ x: c.x + 0.5, y: c.y + 0.5 });
  return out.length > 1 ? out : [];
}

/**
 * Target tile for the ghost: the highlighted option's pickup access tile while an offer is open,
 * otherwise the server guide target (pick / drop) when it has coordinates.
 */
export function ghostTarget(
  offer: FareOffer | null | undefined,
  highlightedIdx: number,
  orders: ReadonlyArray<{ id: number; slot: { ax: number; ay: number } }>,
  guide: { kind: string; x?: number | null; y?: number | null } | null | undefined,
): GhostTarget | null {
  if (offer && offer.options.length) {
    const opt = offer.options[clampIndex(highlightedIdx, offer.options.length)];
    const o = orders.find((x) => x.id === opt.orderId);
    return o ? { x: o.slot.ax, y: o.slot.ay, orderId: o.id } : null;
  }
  if (guide && (guide.kind === 'pick' || guide.kind === 'drop') && guide.x != null && guide.y != null) {
    return { x: guide.x, y: guide.y, orderId: null };
  }
  return null;
}

/** Memoises the last planner run keyed by start tile, target and map/cones identity. */
export class GhostPlanner {
  private metaKey = '';
  private lastSx = -1;
  private lastSy = -1;
  private path: Point[] | null = null;

  /** Planner cells from (sx, sy) to the target; null when unreachable / no target. */
  plan(world: World, sx: number, sy: number, target: GhostTarget | null, mapVersion: number): Point[] | null {
    if (!target) {
      this.metaKey = '';
      this.lastSx = -1;
      this.lastSy = -1;
      this.path = null;
      return null;
    }
    const metaKey = `${mapVersion}|${world.tier}|${world.cones.size}|${target.x},${target.y}`;
    if (metaKey === this.metaKey && this.path !== null) {
      if (sx === this.lastSx && sy === this.lastSy) {
        return this.path;
      }
      const stepIdx = this.path.findIndex((p, i) => i < 3 && p.x === sx && p.y === sy);
      if (stepIdx >= 0) {
        this.path = this.path.slice(stepIdx + 1);
        this.lastSx = sx;
        this.lastSy = sy;
        return this.path;
      }
    }
    this.metaKey = metaKey;
    this.lastSx = sx;
    this.lastSy = sy;
    const inMap = sx >= 0 && sy >= 0 && sx < world.map.w && sy < world.map.h;
    this.path = inMap ? findPath(world, sx, sy, target.x, target.y) : null;
    return this.path;
  }
}
