import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  DISPATCH_MAX_COUNT,
  DeltaMessageSchema,
  FloorOrdersStatusSchema,
  WelcomeMessageSchema,
  signTicket,
  type DeltaMessage,
  type ServerMessage,
  type WelcomeMessage,
} from '@warehouse/protocol';
import { createWorld, tick, type World } from '@warehouse/sim';
import { ArmorGuard, MUTE_DURATION_MS, PLAYER_RATE_LIMIT_PER_MIN, RATE_WINDOW_MS } from '@warehouse/armor';
import {
  CONE_EXPIRY_SEC,
  DEFAULT_TICKET_SECRET,
  DISPATCH_PLAYER_COOLDOWN_SEC,
  FLEET_PLAYER_COOLDOWN_SEC,
  FacilityGovernor,
  MAX_CONES_PER_PLAYER,
  MAX_OPEN_P0_ON_FLOOR,
  MIN_AUTONOMOUS_AGENTS,
  P0_PLAYER_COOLDOWN_SEC,
  REAL_MS_PER_GAME_MIN,
  RUSH_PLAYER_COOLDOWN_SEC,
  SITE_LIMITS,
  canPlaceConeOnFloor,
  createSiteServer,
  type SiteServerInstance,
} from '../src/index.js';

/**
 * Floor-order status (`welcome.floorOrders` / `delta.floorOrders`): every value is read
 * from the real FacilityGovernor limiter state and the real ArmorGuard `nlCommand` window.
 */

const T0 = 1_700_000_000_000;
const IP = '203.0.113.7';

function openP0(world: World): number {
  return world.orders.filter((o) => o.p0 && o.state !== 'done').length;
}

function autonomous(world: World): number {
  return world.vehicles.filter((v) => !v.human && !v.isPlayerVehicle).length;
}

function firstConeTile(world: World): { x: number; y: number } {
  for (let y = 2; y < world.map.h - 2; y++) {
    for (let x = 6; x < world.map.w - 6; x++) {
      if (canPlaceConeOnFloor(world, x, y)) return { x, y };
    }
  }
  throw new Error('no placeable cone tile');
}

describe('FacilityGovernor.getFloorOrdersStatus', () => {
  it('fresh player: everything ready, no cones, full nl budget, real counts', () => {
    const world = createWorld({ siteId: 'den-1', seed: 7, agents: 14 });
    const gov = new FacilityGovernor();
    const guard = new ArmorGuard();
    const s = gov.getFloorOrdersStatus(world, 'p1', guard, IP, T0);
    expect(FloorOrdersStatusSchema.safeParse(s).success).toBe(true);
    expect(s).toEqual({
      rush: { readyInMs: 0 },
      p0: { open: openP0(world), readyInMs: 0 },
      cones: { mine: [] },
      dispatch: { readyInMs: 0 },
      fleet: { addReadyInMs: 0, removable: Math.max(0, autonomous(world) - MIN_AUTONOMOUS_AGENTS) },
      nl: { left: PLAYER_RATE_LIMIT_PER_MIN, resetInMs: 0 },
    });
  });

  it('rush: readyInMs covers per-player cooldown, site cooldown and the active wave', () => {
    const world = createWorld({ siteId: 'den-1', seed: 7, agents: 14 });
    const gov = new FacilityGovernor();
    const guard = new ArmorGuard();
    expect(gov.tryRush(world, 'p1', T0).ok).toBe(true);

    const activeMs = Math.ceil((world.rushUntil - world.t) * REAL_MS_PER_GAME_MIN);
    const mine = gov.getFloorOrdersStatus(world, 'p1', guard, IP, T0);
    expect(mine.rush.readyInMs).toBe(Math.max(activeMs, RUSH_PLAYER_COOLDOWN_SEC * 1000));
    // Another player is blocked by the site-wide state too (active wave ≥ site cooldown).
    const other = gov.getFloorOrdersStatus(world, 'p2', guard, IP, T0);
    expect(other.rush.readyInMs).toBeGreaterThan(0);
    expect(gov.tryRush(world, 'p2', T0 + 1_000).ok).toBe(false);

    // Advance the real sim past the wave and every cooldown: ready again and actually allowed.
    const ticks = Math.ceil(Math.max(world.rushUntil - world.t, RUSH_PLAYER_COOLDOWN_SEC) * 10) + 5;
    for (let i = 0; i < ticks; i++) tick(world);
    const later = T0 + ticks * 100;
    expect(gov.getFloorOrdersStatus(world, 'p1', guard, IP, later).rush.readyInMs).toBe(0);
    expect(gov.tryRush(world, 'p1', later).ok).toBe(true);
  });

  it('p0 / dispatch / fleet cooldowns and counts track real governor state', () => {
    const world = createWorld({ siteId: 'den-1', seed: 7, agents: 14 });
    const gov = new FacilityGovernor();
    const guard = new ArmorGuard();
    world.orders = world.orders.filter((o) => !o.p0);
    const before = gov.getFloorOrdersStatus(world, 'p1', guard, IP, T0);
    expect(before.p0.open).toBe(0);

    expect(gov.tryP0(world, 'p1', T0).ok).toBe(true);
    const afterP0 = gov.getFloorOrdersStatus(world, 'p1', guard, IP, T0);
    expect(afterP0.p0).toEqual({ open: 1, readyInMs: P0_PLAYER_COOLDOWN_SEC * 1000 });
    expect(afterP0.p0.open).toBeLessThanOrEqual(MAX_OPEN_P0_ON_FLOOR);
    // Per-player: another player's p0 is still ready, but sees the site-wide open count.
    expect(gov.getFloorOrdersStatus(world, 'p2', guard, IP, T0).p0).toEqual({ open: 1, readyInMs: 0 });
    // Countdown shrinks with wall time.
    expect(gov.getFloorOrdersStatus(world, 'p1', guard, IP, T0 + 5_000).p0.readyInMs).toBe(
      (P0_PLAYER_COOLDOWN_SEC - 5) * 1000,
    );

    expect(gov.tryDispatch(world, 'p1', undefined, T0).ok).toBe(true);
    expect(gov.getFloorOrdersStatus(world, 'p1', guard, IP, T0).dispatch.readyInMs).toBe(
      DISPATCH_PLAYER_COOLDOWN_SEC * 1000,
    );

    const removableBefore = gov.getFloorOrdersStatus(world, 'p1', guard, IP, T0).fleet.removable;
    expect(gov.tryFleetChange(world, 'p1', 1, T0).ok).toBe(true);
    const fleet = gov.getFloorOrdersStatus(world, 'p1', guard, IP, T0).fleet;
    expect(fleet.addReadyInMs).toBe(FLEET_PLAYER_COOLDOWN_SEC * 1000);
    expect(fleet.removable).toBe(removableBefore + 1);
    expect(fleet.removable).toBe(autonomous(world) - MIN_AUTONOMOUS_AGENTS);
  });

  it('cones: mine lists only this player’s live cones and drops them after expiry without mutating', () => {
    const world = createWorld({ siteId: 'den-1', seed: 7, agents: 14 });
    const gov = new FacilityGovernor();
    const guard = new ArmorGuard();
    const { x, y } = firstConeTile(world);
    expect(gov.tryToggleCone(world, 'p1', x, y, T0).ok).toBe(true);
    const key = `${x},${y}`;

    expect(gov.getFloorOrdersStatus(world, 'p1', guard, IP, T0).cones.mine).toEqual([key]);
    expect(gov.getFloorOrdersStatus(world, 'p2', guard, IP, T0).cones.mine).toEqual([]);
    expect(gov.getPlayerConeCount(world, 'p1', T0)).toBe(1);
    expect(MAX_CONES_PER_PLAYER).toBe(SITE_LIMITS.conesPerPlayer);

    const expired = T0 + CONE_EXPIRY_SEC * 1000;
    expect(gov.getFloorOrdersStatus(world, 'p1', guard, IP, expired).cones.mine).toEqual([]);
    expect(world.cones.has(key)).toBe(true); // status is read-only; expiry is the governor's job
    gov.expireCones(world, expired);
    expect(world.cones.has(key)).toBe(false);
  });

  it('nl: budget decrements with real nlCommand consumption, resets with the window, 0 while muted', () => {
    const world = createWorld({ siteId: 'den-1', seed: 7, agents: 14 });
    const gov = new FacilityGovernor();
    const guard = new ArmorGuard();
    expect(guard.consumeRequest('p1', IP, T0).ok).toBe(true);
    expect(guard.consumeRequest('p1', IP, T0 + 1_000).ok).toBe(true);
    expect(gov.getFloorOrdersStatus(world, 'p1', guard, IP, T0 + 2_000).nl).toEqual({
      left: PLAYER_RATE_LIMIT_PER_MIN - 2,
      resetInMs: RATE_WINDOW_MS - 2_000,
    });
    for (let i = 2; i < PLAYER_RATE_LIMIT_PER_MIN; i++) {
      expect(guard.consumeRequest('p1', IP, T0 + 2_000).ok).toBe(true);
    }
    expect(gov.getFloorOrdersStatus(world, 'p1', guard, IP, T0 + 2_000).nl.left).toBe(0);
    expect(guard.consumeRequest('p1', IP, T0 + 2_000).ok).toBe(false);
    // peek never consumes
    expect(gov.getFloorOrdersStatus(world, 'p1', guard, IP, T0 + 2_000).nl.left).toBe(0);
    expect(gov.getFloorOrdersStatus(world, 'p1', guard, IP, T0 + RATE_WINDOW_MS + 2_001).nl).toEqual({
      left: PLAYER_RATE_LIMIT_PER_MIN,
      resetInMs: 0,
    });

    const muted = new ArmorGuard();
    for (let i = 0; i < 3; i++) muted.recordStrike('p3', IP, T0);
    expect(gov.getFloorOrdersStatus(world, 'p3', muted, IP, T0).nl).toEqual({
      left: 0,
      resetInMs: MUTE_DURATION_MS,
    });
  });
});

describe('SITE_LIMITS Floor-order fields', () => {
  it('are populated from the real enforcement constants', () => {
    expect(SITE_LIMITS.maxOpenP0).toBe(MAX_OPEN_P0_ON_FLOOR);
    expect(SITE_LIMITS.conesPerPlayer).toBe(MAX_CONES_PER_PLAYER);
    expect(SITE_LIMITS.coneTtlGameMin).toBe(CONE_EXPIRY_SEC);
    expect(SITE_LIMITS.dispatchMaxCount).toBe(DISPATCH_MAX_COUNT);
    expect(SITE_LIMITS.nlPerMinute).toBe(PLAYER_RATE_LIMIT_PER_MIN);
  });
});

describe('floorOrders on the wire', () => {
  const servers: SiteServerInstance[] = [];
  const sockets: WebSocket[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.close();
    for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  });

  async function connect(wsUrl: string, clientId: string) {
    const ticket = signTicket(
      { clientId, siteId: 'den-1', name: clientId, exp: Date.now() + 60_000, isBot: false },
      DEFAULT_TICKET_SECRET,
    );
    const ws = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`);
    sockets.push(ws);
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString('utf8')) as ServerMessage));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const deadline = Date.now() + 3000;
    while (!messages.some((m) => m.type === 'welcome')) {
      if (Date.now() > deadline) throw new Error('no welcome');
      await sleep(10);
    }
    return {
      ws,
      messages,
      welcome: () => messages.find((m): m is WelcomeMessage => m.type === 'welcome')!,
      deltas: () => messages.filter((m): m is DeltaMessage => m.type === 'delta'),
    };
  }

  it('welcome carries the recipient’s status; full deltas carry only the recipient’s own changed status', async () => {
    const server = await createSiteServer({
      siteId: 'den-1',
      seed: 42,
      initialAgents: 0,
      enableIntervals: false,
    });
    servers.push(server);
    const addr = await server.app.listen({ port: 0, host: '127.0.0.1' });
    const wsUrl = addr.replace(/^http/, 'ws') + '/ws';
    const a = await connect(wsUrl, 'fo-alpha');
    const b = await connect(wsUrl, 'fo-bravo');

    const wa = a.welcome();
    expect(WelcomeMessageSchema.safeParse(wa).success).toBe(true);
    expect(wa.floorOrders!.p0.readyInMs).toBe(0);
    expect(wa.floorOrders!.nl.left).toBe(PLAYER_RATE_LIMIT_PER_MIN);
    expect(wa.limits!.nlPerMinute).toBe(PLAYER_RATE_LIMIT_PER_MIN);

    // Unchanged status is not re-sent on the next full delta.
    await server.stepTick(Date.now());
    const deadline0 = Date.now() + 3000;
    while (a.deltas().length < 1 || b.deltas().length < 1) {
      if (Date.now() > deadline0) throw new Error('no delta');
      await sleep(5);
    }
    expect(a.deltas()[0].floorOrders).toBeUndefined();

    // Alpha issues a real P0 Floor order through the websocket.
    server.world.orders = server.world.orders.filter((o) => !o.p0);
    a.ws.send(JSON.stringify({ type: 'manager', op: 'p0' }));
    const deadline1 = Date.now() + 3000;
    while (!server.world.orders.some((o) => o.p0)) {
      if (Date.now() > deadline1) throw new Error('p0 not applied');
      await sleep(5);
    }
    const nA = a.deltas().length;
    const nB = b.deltas().length;
    await server.stepTick(Date.now());
    const deadline2 = Date.now() + 3000;
    while (a.deltas().length <= nA || b.deltas().length <= nB) {
      if (Date.now() > deadline2) throw new Error('no delta after p0');
      await sleep(5);
    }
    const da = a.deltas()[nA];
    const db = b.deltas()[nB];
    expect(DeltaMessageSchema.safeParse(da).success).toBe(true);
    expect(da.floorOrders!.p0.readyInMs).toBeGreaterThan(0);
    expect(da.floorOrders!.p0.open).toBe(1);
    // Bravo's own p0 stays ready; only the site-wide open count changed for them.
    expect(db.floorOrders!.p0).toEqual({ open: 1, readyInMs: 0 });
  });
});
