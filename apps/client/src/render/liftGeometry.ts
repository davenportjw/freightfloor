/**
 * Single source of truth for rack / fork *visual* heights, shared by the iso renderer and the
 * first-person Cab View.
 *
 * The sim's normalized `Vehicle.fork` (0..1) and `RACK_LEVEL_FORK_TARGETS` stay the protocol
 * truth. Every visual height here is *derived* from those targets, so a forkHeight that the server
 * grades as a dead-centre Perfect lift always draws the fork blades exactly inside the pallet
 * pocket at that shelf level (previously iso forks topped out below the L3 pallet).
 */
import { RACK_LEVEL_FORK_TARGETS, rackLiftWindows, type DistrictKind } from '@warehouse/sim';

/** Metres per tile (one aisle width). */
export const TILE_M = 1.5;
/** Fork blade *bottom* at `fork = 0` (metres above the floor). */
export const FORK_MIN_M = 0.08;
/** Fork blade travel from `fork = 0` to `fork = 1` (metres). Shared by every forklift model. */
export const FORK_TRAVEL_M = 4.2;
/**
 * Fork blade bottom sits this far above the beam top when centred in the pallet pocket
 * (blade = 2 iso-px ≈ 0.31 m inside the 2.5 iso-px ≈ 0.38 m pallet deck).
 */
export const POCKET_OFFSET_M = 0.04;
/** Pallet sits directly on the beam top; deck height in metres (2.5 iso-px). */
export const PALLET_DECK_M = 2.5 / 6.5;
/** Beam (shelf) thickness. */
export const BEAM_M = 0.12;
/** Clearance above the top level's load to the rack's top cap. */
export const LOAD_CLEARANCE_M = 1.3;
/** Iso-pixels per metre (keeps the classic iso rack silhouette ≈ 36 px tall). */
export const ISO_PX_PER_M = 6.5;

export type RackLevel = 0 | 1 | 2;

/** Fork blade bottom height (m) for a normalized fork value. */
export function forkHeightM(fork: number): number {
  const f = Math.max(0, Math.min(1, Number.isFinite(fork) ? fork : 0));
  return FORK_MIN_M + f * FORK_TRAVEL_M;
}

/** Blade-bottom height (m) that sits centred in the pallet pocket at a shelf level (= Perfect target). */
export function pocketCenterM(level: RackLevel): number {
  return forkHeightM(RACK_LEVEL_FORK_TARGETS[level]);
}

/** Beam top (m) at a shelf level. */
export function beamTopM(level: RackLevel): number {
  return pocketCenterM(level) - POCKET_OFFSET_M;
}

/** Rack upright height (m) for a rack with `levels` shelves. */
export function rackHeightM(levels: 2 | 3): number {
  return beamTopM((levels - 1) as RackLevel) + LOAD_CLEARANCE_M;
}

/** Number of shelf levels for a rack district kind (`fast` racks are 2 high, bulk is floor stack). */
export function rackLevelsFor(kind: DistrictKind | string): 2 | 3 {
  return kind === 'fast' ? 2 : 3;
}

/** Metres → iso-pixels. */
export const isoZ = (m: number): number => m * ISO_PX_PER_M;

/** Server-identical grading tolerance at a level, expressed as metres of fork travel. */
export function liftWindowM(
  level: RackLevel,
  opts?: { forkLiftMul?: number; district?: DistrictKind },
): { centerM: number; perfectM: number; cleanM: number } {
  const w = rackLiftWindows(level, opts);
  return {
    centerM: forkHeightM(w.targetFork),
    perfectM: w.perfectWindow * FORK_TRAVEL_M,
    cleanM: w.cleanWindow * FORK_TRAVEL_M,
  };
}
