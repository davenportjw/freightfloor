import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  DeltaMessageSchema,
  HEAT_INTERVAL_MS,
  HEAT_MIN_VALUE,
  MAX_PATH_WAYPOINTS,
  WelcomeMessageSchema,
  signTicket,
  type DeltaMessage,
  type ServerMessage,
  type WelcomeMessage,
} from '@warehouse/protocol';
import {
  BASE_FLEET,
  FLEET_CAP,
  MAX_TIER,
  TIER_STEP,
  emitTacticsRequest,
  tick,
} from '@warehouse/sim';
import {
  AgentBrainScheduler,
  DEFAULT_TICKET_SECRET,
  InMemoryPersistenceStore,
  MAX_AUTONOMOUS_AGENTS,
  MAX_DRIVERS,
  MAX_DRIVERS_PER_CLIENT,
  MIN_AUTONOMOUS_AGENTS,
  SITE_LIMITS,
  createSiteServer,
  type BrainModelClient,
  type SiteServerInstance,
} from '../src/index.js';

/**
 * Server wiring for the UI-parity protocol additions: limits, recipient-only hands,
 * Strategy Board, incremental series/history, opt-in heat layer, and inspector detail
 * (tactics/path/decision) carried only on full deltas. All data comes from the real sim.
 */

interface Client {
  ws: WebSocket;
  raw: string[];
  messages: ServerMessage[];
  deltas: () => DeltaMessage[];
  welcome: () => WelcomeMessage | undefined;
  send: (m: unknown) => void;
  close: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(wsUrl: string, clientId: string, name: string): Promise<Client> {
  const ticket = signTicket(
    { clientId, siteId: 'den-1', name, exp: Date.now() + 60_000, isBot: false },
    DEFAULT_TICKET_SECRET,
  );
  const ws = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`);
  const raw: string[] = [];
  const messages: ServerMessage[] = [];
  ws.on('message', (d) => {
    const s = d.toString('utf8');
    raw.push(s);
    messages.push(JSON.parse(s) as ServerMessage);
  });
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
    raw,
    messages,
    deltas: () => messages.filter((m): m is DeltaMessage => m.type === 'delta'),
    welcome: () => messages.find((m): m is WelcomeMessage => m.type === 'welcome'),
    send: (m) => ws.send(JSON.stringify(m)),
    close: () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once('close', () => resolve());
        ws.close();
      }),
  };
}

/** Waits until every socket has received `n` deltas in total. */
async function waitForDeltas(clients: Client[], n: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (clients.some((c) => c.deltas().length < n)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} deltas`);
    await sleep(5);
  }
}

describe('UI-parity protocol additions (server wiring)', () => {
  const servers: SiteServerInstance[] = [];
  const clients: Client[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => undefined);
    for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  });

  const tacticsBrain: BrainModelClient = {
    async generateDecision() {
      return {
        text: JSON.stringify({
          speed: 1.1,
          buffer: 2,
          respect: 0.7,
          chargeAt: 25,
          batch: 2,
          note: 'Balanced flow',
          reason: 'Balanced flow',
        }),
        tokensIn: 40,
        tokensOut: 12,
      };
    },
  };

  async function boot(opts: Parameters<typeof createSiteServer>[0] = {}) {
    const server = await createSiteServer({
      siteId: 'den-1',
      seed: 42,
      initialAgents: 14,
      enableIntervals: false,
      brainClient: tacticsBrain,
      ...opts,
    });
    servers.push(server);
    const addr = await server.app.listen({ port: 0, host: '127.0.0.1' });
    return { server, baseUrl: addr, wsUrl: addr.replace(/^http/, 'ws') + '/ws' };
  }

  async function two(wsUrl: string): Promise<[Client, Client]> {
    const a = await connect(wsUrl, 'client-ui-alpha', 'Alpha');
    clients.push(a);
    const b = await connect(wsUrl, 'client-ui-bravo', 'Bravo');
    clients.push(b);
    return [a, b];
  }

  it('welcome carries real limits and a snapshot without other players’ hands; HTTP snapshots strip human hands', async () => {
    const { server, baseUrl, wsUrl } = await boot();
    const [a, b] = await two(wsUrl);

    // Both humans were dealt a hand keyed by clientId.
    expect(server.world.cards['client-ui-alpha']).toBeDefined();
    expect(server.world.cards['client-ui-bravo']).toBeDefined();

    const wb = b.welcome()!;
    expect(WelcomeMessageSchema.safeParse(wb).success).toBe(true);
    expect(wb.limits).toEqual(SITE_LIMITS);
    expect(wb.limits).toEqual({
      maxDrivers: MAX_DRIVERS,
      maxDriversPerClient: MAX_DRIVERS_PER_CLIENT,
      fleetCap: FLEET_CAP,
      maxTier: MAX_TIER,
      baseFleet: BASE_FLEET,
      tierStep: TIER_STEP,
      minAutonomousAgents: MIN_AUTONOMOUS_AGENTS,
      maxAutonomousAgents: MAX_AUTONOMOUS_AGENTS,
    });
    const cards = wb.snapshot.cards as Record<string, { ai?: boolean }>;
    expect(cards['client-ui-bravo']).toBeDefined();
    expect(cards['client-ui-alpha']).toBeUndefined();
    for (const [k, h] of Object.entries(cards)) {
      if (k !== 'client-ui-bravo') expect(h.ai).toBe(true);
    }
    expect(a.welcome()!.snapshot.cards['client-ui-bravo']).toBeUndefined();

    // Re-hello re-welcomes with the same scoping.
    b.send({ type: 'hello', ticket: 'ignored-when-authenticated' });
    const deadline = Date.now() + 3000;
    while (b.messages.filter((m) => m.type === 'welcome').length < 2) {
      if (Date.now() > deadline) throw new Error('no re-welcome');
      await sleep(10);
    }
    const rewelcome = b.messages.filter((m): m is WelcomeMessage => m.type === 'welcome')[1];
    expect(rewelcome.limits).toEqual(SITE_LIMITS);
    expect(rewelcome.snapshot.cards['client-ui-alpha']).toBeUndefined();

    for (const path of ['/api/state', '/api/status']) {
      const json = (await (await fetch(`${baseUrl}${path}`)).json()) as {
        snapshot: { cards: Record<string, { ai?: boolean }> };
      };
      for (const h of Object.values(json.snapshot.cards)) expect(h.ai).toBe(true);
    }
  });

  it('full deltas carry only the recipient’s own hand, a Strategy Board, and inspector detail; light deltas stay lean', async () => {
    const { server, wsUrl } = await boot();
    const [a, b] = await two(wsUrl);

    await server.stepTick(Date.now());
    await waitForDeltas([a, b], 1);

    for (const [c, own, other] of [
      [a, 'client-ui-alpha', 'client-ui-bravo'],
      [b, 'client-ui-bravo', 'client-ui-alpha'],
    ] as const) {
      const d = c.deltas()[0];
      expect(DeltaMessageSchema.safeParse(d).success).toBe(true);
      expect(Object.keys(d.hands ?? {})).toEqual([own]);
      expect(d.hands![own]).toEqual(JSON.parse(JSON.stringify(server.world.cards[own])));
      expect(c.raw.some((r) => r.includes(other) && r.includes('"hands"') && JSON.parse(r).hands?.[other])).toBe(false);

      const boardRows = d.stats!.board!;
      expect(boardRows.length).toBeGreaterThan(0);
      for (const row of boardRows) {
        expect(typeof row.strat).toBe('string');
        expect(row.vehicles).toBeGreaterThanOrEqual(0);
      }

      const fl = d.vehicles.find((v) => !v.human)!;
      const simV = server.world.vehicles.find((v) => v.id === fl.id)!;
      expect(fl.incidents).toBe(simV.incidents);
      expect(fl.nearMisses).toBe(simV.nearMisses);
      expect(fl.tactics).toMatchObject({
        flatPath: simV.tactics.flatPath,
        poach: simV.tactics.poach,
        preemptForP0: simV.tactics.preemptForP0,
      });
      expect(fl.tactics!.speed).toBeCloseTo(simV.tactics.speed, 2);
      expect(fl.path!.length % 2).toBe(0);
      expect(fl.path!.length).toBeLessThanOrEqual(MAX_PATH_WAYPOINTS * 2);
      expect(typeof fl.extra).toBe('boolean');
    }

    // Background tick 1 of 10 → light delta, no detail and no stats/hands.
    await server.stepTick(Date.now(), true);
    await waitForDeltas([a, b], 2);
    const light = a.deltas()[1];
    expect(light.stats).toBeUndefined();
    expect(light.hands).toBeUndefined();
    for (const v of light.vehicles) {
      for (const k of ['tactics', 'path', 'decision', 'incidents', 'nearMisses', 'extra']) {
        expect(k in v).toBe(false);
      }
    }
  });

  it('seriesAppend and history are incremental per connection, driven by real sim ticks', async () => {
    const { server, wsUrl } = await boot();
    const [a, b] = await two(wsUrl);
    const welcomeSeries = a.welcome()!.snapshot.valueSeries as Array<{ t: number }>;
    const welcomeSeriesLen = welcomeSeries.length;
    const heldT = new Set(welcomeSeries.map((s) => s.t));

    const N = 120; // > 2 sample periods (sampleValue runs every 50 ticks)
    const base = Date.now();
    for (let i = 0; i < N; i++) await server.stepTick(base + i * 100);
    await waitForDeltas([a, b], N);

    for (const c of [a, b]) {
      const appended = c.deltas().flatMap((d) => d.stats?.seriesAppend ?? []);
      expect(appended.length).toBeGreaterThanOrEqual(2);
      const ts = appended.map((s) => s.t);
      expect(new Set(ts).size).toBe(ts.length); // never repeated
      for (const t of ts) expect(heldT.has(t)).toBe(false); // never re-sends welcome samples
      // Exactly the samples the sim produced since the welcome.
      expect(appended).toEqual(
        JSON.parse(JSON.stringify(server.world.valueSeries.slice(welcomeSeriesLen))),
      );
      // Unchanged history / hall are not re-sent.
      expect(c.deltas().some((d) => d.stats?.history !== undefined)).toBe(false);
      expect(c.deltas().some((d) => d.stats?.hall !== undefined)).toBe(false);
    }

    // Advance the real sim to just before the day boundary, then cross it via stepTick.
    const world = server.world;
    const historyLen = world.history.length;
    while (world.t < 1439.5) tick(world);
    const before = a.deltas().length;
    for (let i = 0; i < 10; i++) await server.stepTick(base + (N + i) * 100);
    await waitForDeltas([a, b], before + 10);
    expect(world.history.length).toBe(historyLen + 1);

    for (const c of [a, b]) {
      const withHistory = c.deltas().slice(before).filter((d) => d.stats?.history !== undefined);
      expect(withHistory).toHaveLength(1);
      const sent = withHistory[0].stats!.history!;
      expect(sent[sent.length - 1].day).toBe(world.history[world.history.length - 1].day);
    }
  });

  it('heat layer goes only to subscribers, at most every HEAT_INTERVAL_MS, as sparse real heat', async () => {
    const { server, wsUrl } = await boot();
    const [a, b] = await two(wsUrl);

    // Warm the real heat map so cells exceed HEAT_MIN_VALUE.
    for (let i = 0; i < 60; i++) tick(server.world);

    a.send({ type: 'layers', traffic: true });
    await sleep(100);

    const t0 = Date.now();
    await server.stepTick(t0);
    await server.stepTick(t0 + HEAT_INTERVAL_MS / 2);
    await server.stepTick(t0 + HEAT_INTERVAL_MS);
    await waitForDeltas([a, b], 3);

    const ah = a.deltas().map((d) => d.stats?.heat);
    expect(ah[0]).toBeDefined();
    expect(ah[1]).toBeUndefined();
    expect(ah[2]).toBeDefined();
    expect(b.deltas().every((d) => d.stats?.heat === undefined)).toBe(true);

    const heat = ah[2]!;
    expect(heat.w).toBe(server.world.map.w);
    expect(heat.h).toBe(server.world.map.h);
    expect(heat.cells.length).toBeGreaterThan(0);
    for (const [idx, val] of heat.cells) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(heat.w * heat.h);
      expect(val).toBeGreaterThanOrEqual(HEAT_MIN_VALUE);
      expect(Math.abs(server.world.heat[idx] - val)).toBeLessThanOrEqual(0.05 + 1e-9);
    }

    // Unsubscribing stops the layer.
    a.send({ type: 'layers', traffic: false });
    await sleep(100);
    await server.stepTick(t0 + HEAT_INTERVAL_MS * 3);
    await waitForDeltas([a], 4);
    expect(a.deltas()[3].stats?.heat).toBeUndefined();
  });

  it('decision appears on a vehicle only after a real applied brain call, with measured latency and model', async () => {
    const persistence = new InMemoryPersistenceStore();
    const scheduler = new AgentBrainScheduler({
      siteId: 'den-1',
      client: tacticsBrain,
      persistence,
      modelName: 'gemini-3.8-flash',
    });
    const { server, wsUrl } = await boot({ persistence, brainScheduler: scheduler });
    const [a] = await two(wsUrl);

    const world = server.world;
    world.pendingDecisions.length = 0;
    const fl = world.vehicles.find((v) => !v.human)!;
    expect(fl.lastDecision ?? null).toBeNull();
    expect(emitTacticsRequest(world, fl)).not.toBeNull();
    await scheduler.drainQueue(world, Date.now(), []);
    expect(fl.lastDecision?.kind).toBe('tactics');

    await server.stepTick(Date.now());
    await waitForDeltas([a], 1);
    const v = a.deltas()[a.deltas().length - 1].vehicles.find((x) => x.id === fl.id)!;
    expect(v.decision).toEqual({
      kind: 'tactics',
      model: 'gemini-3.8-flash',
      latencyMs: Math.round(fl.lastDecision!.latencyMs),
      reason: fl.lastDecision!.reason,
      t: fl.lastDecision!.t,
    });
    expect(v.decision!.latencyMs).toBeGreaterThanOrEqual(1);

    // Vehicles without an applied decision never get a synthesised one.
    for (const other of a.deltas()[a.deltas().length - 1].vehicles) {
      const sim = world.vehicles.find((x) => x.id === other.id)!;
      if (!sim.lastDecision) expect(other.decision).toBeUndefined();
    }
  });
});

// Compile-time parity: wire shapes must stay assignable to the sim types the client stores them as.
type _HandParity = import('@warehouse/protocol').CardHand extends import('@warehouse/sim').CardHand ? true : never;
type _BoardParity = import('@warehouse/protocol').BoardRow extends Omit<import('@warehouse/sim').BoardRow, 'strat'> ? true : never;
const _typeParity: [_HandParity, _BoardParity] = [true, true];
void _typeParity;
