import type { ArmorGuard, ArmorReasonCode } from '@warehouse/armor';
import type { DispatchParams, FloorOrdersStatus, ManagerOp } from '@warehouse/protocol';
import {
  addVehicle,
  bayAt,
  chargerAt,
  dispatchOrderRoute,
  isBlocked,
  postP0,
  removeVehicle,
  rushWave,
  setDifficulty,
  toggleCone,
  voteDifficulty,
  TICK_MIN,
  type DifficultyInput,
  type World,
} from '@warehouse/sim';

export const RUSH_PLAYER_COOLDOWN_SEC = 30; // 30 game-minutes (30 s at 10 Hz)
export const RUSH_SITE_COOLDOWN_SEC = 20; // min 20 s between rushes
export const P0_PLAYER_COOLDOWN_SEC = 15; // 15 game-minutes (15 s at 10 Hz)
export const DISPATCH_PLAYER_COOLDOWN_SEC = 10; // 10 game-minutes (10 s at 10 Hz)
export const MAX_OPEN_P0_ON_FLOOR = 4;
export const MAX_CONES_PER_PLAYER = 6;
export const MAX_CONES_ON_FLOOR = 24;
export const CONE_TOGGLE_COOLDOWN_SEC = 2;
export const CONE_EXPIRY_SEC = 60; // 1 game-hour (60 s at 10 Hz)
export const FLEET_PLAYER_COOLDOWN_SEC = 30;
/** Min seconds between `chooseOrder` messages from one player (≈ 4 picks/s max). */
export const CHOOSE_ORDER_COOLDOWN_SEC = 0.25;
export const MIN_AUTONOMOUS_AGENTS = 8;
export const MAX_AUTONOMOUS_AGENTS = 28;
export const MAX_CONCURRENT_NL_COMMANDS = 4;
/** Real-time interval of one site sim tick (10 Hz). */
export const SITE_TICK_MS = 100;
/** Real milliseconds per game-minute at 1x (`SITE_TICK_MS` / sim `TICK_MIN` = 1000). */
export const REAL_MS_PER_GAME_MIN = Math.round(SITE_TICK_MS / TICK_MIN);

interface TimeStampPair {
  gameMin: number;
  nowMs: number;
}

export interface ConeOwnership {
  key: string;
  x: number;
  y: number;
  clientId: string;
  placedAt: TimeStampPair;
}

export type GovernanceResult =
  | { ok: true; message: string }
  | {
      ok: false;
      code: ArmorReasonCode;
      reason: string;
      message: string;
      retryAfterSec?: number;
    };

export function canPlaceConeOnFloor(world: World, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 1 || y < 1 || x >= world.map.w - 1 || y >= world.map.h - 1) return false;
  if (isBlocked(world, x, y)) return false;
  if (bayAt(world.map, x, y)) return false;
  if (chargerAt(world.map, x, y) >= 0) return false;
  const k = `${x},${y}`;
  if (world.orders.some((o) => o.slot.key === k)) return false;
  if (
    world.vehicles.some(
      (v) =>
        (v.tile.x === x && v.tile.y === y) ||
        (v.moveTo && v.moveTo.x === x && v.moveTo.y === y),
    )
  ) {
    return false;
  }
  // Also reject tiles directly adjacent (Manhattan distance 1) to a bay or charger
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [dx, dy] of dirs) {
    if (bayAt(world.map, x + dx, y + dy)) return false;
    if (chargerAt(world.map, x + dx, y + dy) >= 0) return false;
  }
  return true;
}

export class FacilityGovernor {
  private lastSiteRush: TimeStampPair | null = null;
  private readonly lastPlayerRush = new Map<string, TimeStampPair>();
  private readonly lastPlayerP0 = new Map<string, TimeStampPair>();
  private readonly lastPlayerConeToggle = new Map<string, TimeStampPair>();
  private readonly lastPlayerFleet = new Map<string, TimeStampPair>();
  private readonly lastPlayerDispatch = new Map<string, TimeStampPair>();
  private readonly coneMeta = new Map<string, ConeOwnership>();
  private readonly lastPlayerChoose = new Map<string, TimeStampPair>();
  private inFlightNlCommands = 0;

  private elapsedSec(world: World, prev: TimeStampPair | undefined | null, nowMs: number): number {
    if (!prev) return Number.POSITIVE_INFINITY;
    const gameDelta = Math.max(0, world.t - prev.gameMin);
    const wallDelta = Math.max(0, (nowMs - prev.nowMs) / 1000);
    return Math.max(gameDelta, wallDelta);
  }

  private stamp(world: World, nowMs: number): TimeStampPair {
    return { gameMin: world.t, nowMs };
  }

  /**
   * Expires cones older than 1 game-hour (60 game-minutes / 60 real seconds).
   */
  public expireCones(world: World, nowMs: number = Date.now()): number {
    // Sync metadata with any cones removed directly from world.cones
    for (const key of this.coneMeta.keys()) {
      if (!world.cones.has(key)) {
        this.coneMeta.delete(key);
      }
    }

    let expired = 0;
    for (const [key, meta] of this.coneMeta.entries()) {
      if (this.elapsedSec(world, meta.placedAt, nowMs) >= CONE_EXPIRY_SEC) {
        world.cones.delete(key);
        this.coneMeta.delete(key);
        expired++;
      }
    }
    return expired;
  }

  public getPlayerConeCount(world: World, clientId: string, nowMs: number = Date.now()): number {
    this.expireCones(world, nowMs);
    let count = 0;
    for (const meta of this.coneMeta.values()) {
      if (meta.clientId === clientId && world.cones.has(meta.key)) {
        count++;
      }
    }
    return count;
  }

  public getPlayerLimitsSummary(
    world: World,
    clientId: string,
    nowMs: number = Date.now(),
  ): { rushCooldownMin: number; conesLeft: number } {
    const lastPlayer = this.lastPlayerRush.get(clientId);
    const playerRemaining = lastPlayer
      ? Math.max(0, RUSH_PLAYER_COOLDOWN_SEC - this.elapsedSec(world, lastPlayer, nowMs))
      : 0;
    const siteRemaining = this.lastSiteRush
      ? Math.max(0, RUSH_SITE_COOLDOWN_SEC - this.elapsedSec(world, this.lastSiteRush, nowMs))
      : 0;
    const activeRushRemaining = Math.max(0, world.rushUntil - world.t);
    const rushCooldownMin = Math.ceil(
      Math.max(playerRemaining, siteRemaining, activeRushRemaining),
    );

    const playerCones = this.getPlayerConeCount(world, clientId, nowMs);
    const playerConesLeft = Math.max(0, MAX_CONES_PER_PLAYER - playerCones);
    const siteConesLeft = Math.max(0, MAX_CONES_ON_FLOOR - world.cones.size);
    return {
      rushCooldownMin,
      conesLeft: Math.min(playerConesLeft, siteConesLeft),
    };
  }

  /** Real ms left on a `cooldownSec` limiter stamped at `prev` (0 = ready), same clock as the `try*` checks. */
  private cooldownLeftMs(
    world: World,
    prev: TimeStampPair | undefined | null,
    cooldownSec: number,
    nowMs: number,
  ): number {
    if (!prev) return 0;
    const elapsed = this.elapsedSec(world, prev, nowMs);
    if (elapsed >= cooldownSec) return 0;
    return Math.ceil((cooldownSec - elapsed) * 1000);
  }

  /**
   * Per-player Floor-order state derived from the exact limiter state `executeManagerOp`
   * enforces. Read-only: never stamps cooldowns or expires cones. `nl` comes from the
   * site's `ArmorGuard` sliding window (the `nlCommand` rate limiter).
   */
  public getFloorOrdersStatus(
    world: World,
    clientId: string,
    guard: ArmorGuard,
    ip?: string,
    nowMs: number = Date.now(),
  ): FloorOrdersStatus {
    const activeRushMs = Math.max(0, Math.ceil((world.rushUntil - world.t) * REAL_MS_PER_GAME_MIN));
    const rushReadyInMs = Math.max(
      activeRushMs,
      this.cooldownLeftMs(world, this.lastSiteRush, RUSH_SITE_COOLDOWN_SEC, nowMs),
      this.cooldownLeftMs(world, this.lastPlayerRush.get(clientId), RUSH_PLAYER_COOLDOWN_SEC, nowMs),
    );

    const mine: string[] = [];
    for (const meta of this.coneMeta.values()) {
      if (
        meta.clientId === clientId &&
        world.cones.has(meta.key) &&
        this.elapsedSec(world, meta.placedAt, nowMs) < CONE_EXPIRY_SEC
      ) {
        mine.push(meta.key);
      }
    }
    mine.sort();

    const autonomousCount = world.vehicles.filter((v) => !v.human && !v.isPlayerVehicle).length;
    const fleetReadyInMs = this.cooldownLeftMs(
      world,
      this.lastPlayerFleet.get(clientId),
      FLEET_PLAYER_COOLDOWN_SEC,
      nowMs,
    );

    return {
      rush: { readyInMs: rushReadyInMs },
      p0: {
        open: world.orders.filter((o) => o.p0 && o.state !== 'done').length,
        readyInMs: this.cooldownLeftMs(
          world,
          this.lastPlayerP0.get(clientId),
          P0_PLAYER_COOLDOWN_SEC,
          nowMs,
        ),
      },
      cones: { mine },
      dispatch: { readyInMs: this.getDispatchCooldownLeftMs(world, clientId, nowMs) },
      fleet: {
        addReadyInMs: fleetReadyInMs,
        removable: Math.max(0, autonomousCount - MIN_AUTONOMOUS_AGENTS),
      },
      nl: guard.peekBudget(clientId, ip, nowMs),
    };
  }

  /** Rate limit for order choice (`chooseOrder`): one per CHOOSE_ORDER_COOLDOWN_SEC per player. */
  public tryChooseOrder(world: World, clientId: string, nowMs: number = Date.now()): GovernanceResult {
    const elapsed = this.elapsedSec(world, this.lastPlayerChoose.get(clientId), nowMs);
    if (elapsed < CHOOSE_ORDER_COOLDOWN_SEC) {
      const reason = `Order choice rate limit (1 per ${CHOOSE_ORDER_COOLDOWN_SEC}s).`;
      return {
        ok: false,
        code: 'governance_limit',
        reason,
        message: reason,
        retryAfterSec: Math.max(0, Math.round((CHOOSE_ORDER_COOLDOWN_SEC - elapsed) * 100) / 100),
      };
    }
    this.lastPlayerChoose.set(clientId, this.stamp(world, nowMs));
    return { ok: true, message: 'ok' };
  }

  public tryRush(world: World, clientId: string, nowMs: number = Date.now()): GovernanceResult {
    // 1. Site-wide active rush check
    if (world.rushUntil > world.t) {
      const reason = 'A rush wave is already active on this floor.';
      return {
        ok: false,
        code: 'governance_limit',
        reason,
        message: reason,
        retryAfterSec: Math.ceil(world.rushUntil - world.t),
      };
    }

    // 2. Site-wide min 20s between rushes
    const siteElapsed = this.elapsedSec(world, this.lastSiteRush, nowMs);
    if (siteElapsed < RUSH_SITE_COOLDOWN_SEC) {
      const reason = 'Site rush cooldown active (min 20s between rushes).';
      return {
        ok: false,
        code: 'governance_limit',
        reason,
        message: reason,
        retryAfterSec: Math.ceil(RUSH_SITE_COOLDOWN_SEC - siteElapsed),
      };
    }

    // 3. Per-player 30 game-minutes (30s) cooldown
    const playerElapsed = this.elapsedSec(world, this.lastPlayerRush.get(clientId), nowMs);
    if (playerElapsed < RUSH_PLAYER_COOLDOWN_SEC) {
      const reason = 'Player rush cooldown active (1 per 30s).';
      return {
        ok: false,
        code: 'governance_limit',
        reason,
        message: reason,
        retryAfterSec: Math.ceil(RUSH_PLAYER_COOLDOWN_SEC - playerElapsed),
      };
    }

    const nowStamp = this.stamp(world, nowMs);
    this.lastSiteRush = nowStamp;
    this.lastPlayerRush.set(clientId, nowStamp);
    const count = rushWave(world);
    return { ok: true, message: `Rush wave started (${count} orders posted).` };
  }

  public tryP0(world: World, clientId: string, nowMs: number = Date.now()): GovernanceResult {
    // 1. Site-wide max 4 open P0 orders on floor
    const openP0 = world.orders.filter((o) => o.p0 && o.state !== 'done').length;
    if (openP0 >= MAX_OPEN_P0_ON_FLOOR) {
      const reason = `Site already has ${openP0} open P0 orders (max ${MAX_OPEN_P0_ON_FLOOR}).`;
      return {
        ok: false,
        code: 'governance_limit',
        reason,
        message: reason,
      };
    }

    // 2. Per-player 15 game-minutes (15s) cooldown
    const playerElapsed = this.elapsedSec(world, this.lastPlayerP0.get(clientId), nowMs);
    if (playerElapsed < P0_PLAYER_COOLDOWN_SEC) {
      const reason = 'Player P0 cooldown active (1 per 15s).';
      return {
        ok: false,
        code: 'governance_limit',
        reason,
        message: reason,
        retryAfterSec: Math.ceil(P0_PLAYER_COOLDOWN_SEC - playerElapsed),
      };
    }

    const order = postP0(world);
    if (!order) {
      const reason = 'No free rack slot for a P0 right now.';
      return {
        ok: false,
        code: 'governance_limit',
        reason,
        message: reason,
      };
    }

    this.lastPlayerP0.set(clientId, this.stamp(world, nowMs));
    return { ok: true, message: `Posted P0 order #${order.id}.` };
  }

  public tryToggleCone(
    world: World,
    clientId: string,
    x: number,
    y: number,
    nowMs: number = Date.now(),
  ): GovernanceResult {
    this.expireCones(world, nowMs);

    const playerElapsed = this.elapsedSec(world, this.lastPlayerConeToggle.get(clientId), nowMs);
    if (playerElapsed < CONE_TOGGLE_COOLDOWN_SEC) {
      const reason = 'Cone toggle cooldown active (1 per 2s).';
      return {
        ok: false,
        code: 'governance_limit',
        reason,
        message: reason,
        retryAfterSec: Math.ceil(CONE_TOGGLE_COOLDOWN_SEC - playerElapsed),
      };
    }

    const key = `${x},${y}`;
    const isRemoving = world.cones.has(key);

    if (isRemoving) {
      world.cones.delete(key);
      this.coneMeta.delete(key);
      this.lastPlayerConeToggle.set(clientId, this.stamp(world, nowMs));
      return { ok: true, message: `Removed cone at (${x}, ${y}).` };
    }

    // Validate open floor / not adjacent to docks/chargers/bays/racks
    if (!canPlaceConeOnFloor(world, x, y)) {
      const reason =
        'Cones can only be placed on open aisle tiles away from docks, bays, and chargers.';
      return {
        ok: false,
        code: 'parse_invalid',
        reason,
        message: reason,
      };
    }

    // Per-player live cone cap (6)
    const playerCones = this.getPlayerConeCount(world, clientId, nowMs);
    if (playerCones >= MAX_CONES_PER_PLAYER) {
      const reason = `Player already has ${playerCones} active cones (max ${MAX_CONES_PER_PLAYER}).`;
      return {
        ok: false,
        code: 'governance_limit',
        reason,
        message: reason,
      };
    }

    // Site-wide live cone cap (24)
    if (world.cones.size >= MAX_CONES_ON_FLOOR) {
      const reason = `Floor already has ${world.cones.size} active cones (max ${MAX_CONES_ON_FLOOR}).`;
      return {
        ok: false,
        code: 'governance_limit',
        reason,
        message: reason,
      };
    }

    const err = toggleCone(world, x, y);
    if (err) {
      return {
        ok: false,
        code: 'parse_invalid',
        reason: err,
        message: err,
      };
    }

    const nowStamp = this.stamp(world, nowMs);
    this.lastPlayerConeToggle.set(clientId, nowStamp);
    this.coneMeta.set(key, {
      key,
      x,
      y,
      clientId,
      placedAt: nowStamp,
    });
    return { ok: true, message: `Placed cone at (${x}, ${y}).` };
  }

  public tryFleetChange(
    world: World,
    clientId: string,
    delta: 1 | -1,
    nowMs: number = Date.now(),
  ): GovernanceResult {
    const playerElapsed = this.elapsedSec(world, this.lastPlayerFleet.get(clientId), nowMs);
    if (playerElapsed < FLEET_PLAYER_COOLDOWN_SEC) {
      const reason = 'Fleet adjustment cooldown active (1 per 30s).';
      return {
        ok: false,
        code: 'governance_limit',
        reason,
        message: reason,
        retryAfterSec: Math.ceil(FLEET_PLAYER_COOLDOWN_SEC - playerElapsed),
      };
    }

    const autonomousCount = world.vehicles.filter((v) => !v.human && !v.isPlayerVehicle).length;

    if (delta === 1) {
      if (autonomousCount >= MAX_AUTONOMOUS_AGENTS) {
        const reason = `Autonomous fleet is at maximum capacity (${MAX_AUTONOMOUS_AGENTS}).`;
        return {
          ok: false,
          code: 'governance_limit',
          reason,
          message: reason,
        };
      }
      const added = addVehicle(world);
      if (!added) {
        const reason = 'Unable to spawn an additional autonomous agent right now.';
        return {
          ok: false,
          code: 'governance_limit',
          reason,
          message: reason,
        };
      }
      this.lastPlayerFleet.set(clientId, this.stamp(world, nowMs));
      return { ok: true, message: `Added ${added.id} to fleet.` };
    }

    // delta === -1
    if (autonomousCount <= MIN_AUTONOMOUS_AGENTS) {
      const reason = `Autonomous fleet is at minimum capacity (${MIN_AUTONOMOUS_AGENTS}).`;
      return {
        ok: false,
        code: 'governance_limit',
        reason,
        message: reason,
      };
    }

    let removed = removeVehicle(world);
    if (!removed) {
      // Allow removing base non-human autonomous agents down to MIN_AUTONOMOUS_AGENTS (never player-driven)
      for (let i = world.vehicles.length - 1; i >= 0; i--) {
        const v = world.vehicles[i];
        if (v.human || v.isPlayerVehicle) continue;
        // Release any claimed orders back to open
        for (const o of [...v.cargo, ...v.orders]) {
          if (o.state !== 'done') {
            o.state = 'open';
            o.claimant = null;
          }
        }
        world.vehicles.splice(i, 1);
        world.pendingDecisions = world.pendingDecisions.filter((r) => r.agentId !== v.id);
        removed = v;
        break;
      }
    }

    if (!removed) {
      const reason = 'No removable autonomous agent available.';
      return {
        ok: false,
        code: 'governance_limit',
        reason,
        message: reason,
      };
    }

    this.lastPlayerFleet.set(clientId, this.stamp(world, nowMs));
    return { ok: true, message: `Removed ${removed.id} from fleet.` };
  }

  public tryVoteDifficulty(
    world: World,
    clientId: string,
    level: DifficultyInput | number | string,
    _nowMs: number = Date.now(),
  ): GovernanceResult {
    const err = voteDifficulty(world, clientId, level as DifficultyInput | string);
    if (err) {
      return {
        ok: false,
        code: 'parse_invalid',
        reason: err,
        message: err,
      };
    }
    const targetDiff = world.difficultyVotes[clientId];
    if (targetDiff) {
      setDifficulty(world, targetDiff);
    } else {
      setDifficulty(world, level as DifficultyInput | string);
    }
    return { ok: true, message: `Difficulty mode set.` };
  }

  public executeVoteDifficulty(
    world: World,
    clientId: string,
    level: DifficultyInput | number | string,
    nowMs: number = Date.now(),
  ): GovernanceResult {
    return this.tryVoteDifficulty(world, clientId, level, nowMs);
  }

  public getDispatchCooldownLeftMs(
    world: World,
    clientId: string,
    nowMs: number = Date.now(),
  ): number {
    const prev = this.lastPlayerDispatch.get(clientId);
    if (!prev) return 0;
    const elapsed = this.elapsedSec(world, prev, nowMs);
    if (elapsed >= DISPATCH_PLAYER_COOLDOWN_SEC) return 0;
    return Math.ceil((DISPATCH_PLAYER_COOLDOWN_SEC - elapsed) * 1000);
  }

  public tryDispatch(
    world: World,
    clientId: string,
    dispatch?: DispatchParams,
    nowMs: number = Date.now(),
  ): GovernanceResult {
    const playerElapsed = this.elapsedSec(world, this.lastPlayerDispatch.get(clientId), nowMs);
    if (playerElapsed < DISPATCH_PLAYER_COOLDOWN_SEC) {
      const retrySec = Math.ceil(DISPATCH_PLAYER_COOLDOWN_SEC - playerElapsed);
      const reason = `Player dispatch cooldown active (1 per ${DISPATCH_PLAYER_COOLDOWN_SEC}s; ${retrySec}s left).`;
      return {
        ok: false,
        code: 'governance_limit',
        reason,
        message: reason,
        retryAfterSec: retrySec,
      };
    }

    const params: DispatchParams = dispatch ?? {
      sourceZone: 'haz',
      targetBay: 'RET',
      priority: 'p0',
      count: 3,
      mode: 'reroute_and_spawn',
    };
    const res = dispatchOrderRoute(world, params);
    if (res.rerouted === 0 && res.spawned === 0) {
      const reason = `No orders or rack slots available in ${params.sourceZone} right now.`;
      return {
        ok: false,
        code: 'governance_limit',
        reason,
        message: reason,
      };
    }

    this.lastPlayerDispatch.set(clientId, this.stamp(world, nowMs));
    return {
      ok: true,
      message: res.summary,
    };
  }

  public executeManagerOp(
    world: World,
    clientId: string,
    op: ManagerOp,
    coords?: { x?: number; y?: number; dispatch?: DispatchParams },
    nowMs: number = Date.now(),
  ): GovernanceResult {
    switch (op) {
      case 'rush':
        return this.tryRush(world, clientId, nowMs);
      case 'p0':
        return this.tryP0(world, clientId, nowMs);
      case 'cone': {
        if (typeof coords?.x !== 'number' || typeof coords?.y !== 'number') {
          const reason = 'Cone toggle requires integer x and y coordinates.';
          return {
            ok: false,
            code: 'parse_invalid',
            reason,
            message: reason,
          };
        }
        return this.tryToggleCone(world, clientId, coords.x, coords.y, nowMs);
      }
      case 'fleetAdd':
        return this.tryFleetChange(world, clientId, 1, nowMs);
      case 'fleetRemove':
        return this.tryFleetChange(world, clientId, -1, nowMs);
      case 'dispatch':
        return this.tryDispatch(world, clientId, coords?.dispatch, nowMs);
    }
  }

  public tryAcquireNlSlot(): boolean {
    if (this.inFlightNlCommands >= MAX_CONCURRENT_NL_COMMANDS) {
      return false;
    }
    this.inFlightNlCommands++;
    return true;
  }

  public releaseNlSlot(): void {
    this.inFlightNlCommands = Math.max(0, this.inFlightNlCommands - 1);
  }

  public getInFlightNlCommands(): number {
    return this.inFlightNlCommands;
  }
}
