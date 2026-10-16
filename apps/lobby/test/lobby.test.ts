import { describe, expect, it } from 'vitest';
import { SiteStatusSchema, verifyTicket } from '@warehouse/protocol';
import {
  buildLobbyServer,
  CSP_HEADER,
  InMemoryLobbyStore,
  MAX_DRIVERS_PER_SITE,
  type StoredSiteDoc,
} from '../src/index.js';

const TEST_SECRET = 'test-hmac-secret-key-for-warehouse-lobby-2026';
const NOW = 1_700_000_000_000;

function makeSite(
  id: StoredSiteDoc['id'],
  overrides: Partial<StoredSiteDoc> = {},
): StoredSiteDoc {
  return {
    id,
    state: 'live',
    phase: 'running',
    drivers: 0,
    spectators: 0,
    tier: 1,
    shipped: 42,
    wsUrl: `wss://${id}.warehouse.example/ws`,
    updatedAt: NOW - 2_000,
    ...overrides,
  };
}

describe('@warehouse/lobby — M6 placement, ticket signing, and network directory', () => {
  it('1. 0 players anywhere -> joins den-1 as driver', async () => {
    const store = new InMemoryLobbyStore([
      makeSite('den-1', { drivers: 0 }),
      makeSite('slc-2', { drivers: 0 }),
      makeSite('phx-3', { drivers: 0 }),
      makeSite('abq-4', { drivers: 0 }),
    ]);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => NOW,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: {
        name: 'Alice',
        clientId: 'client-alice-1',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(CSP_HEADER);
    const body = res.json();
    expect(body.siteId).toBe('den-1');
    expect(body.role).toBe('driver');
    expect(body.isBot).toBe(false);
    expect(body.wsUrl).toBe('wss://den-1.warehouse.example/ws');

    const verified = verifyTicket(body.ticket, TEST_SECRET, NOW + 1_000);
    expect(verified).toEqual({
      ok: true,
      payload: {
        clientId: 'client-alice-1',
        name: 'Alice',
        siteId: 'den-1',
        isBot: false,
        exp: NOW + 60_000,
      },
    });

    await app.close();
  });

  it('2. 3 players on den-1, 0 on slc-2 -> joins den-1 as driver (casual players land together)', async () => {
    const store = new InMemoryLobbyStore([
      makeSite('den-1', { drivers: 3 }),
      makeSite('slc-2', { drivers: 0 }),
      makeSite('phx-3', { drivers: 1 }),
      makeSite('abq-4', { drivers: 0 }),
    ]);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => NOW,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: {
        name: 'Bob',
        clientId: 'client-bob-2',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.siteId).toBe('den-1');
    expect(body.role).toBe('driver');
    await app.close();
  });

  it('3. All live sites full (drivers = 32), one site on on_break -> wakes the break site (role: driver)', async () => {
    const store = new InMemoryLobbyStore([
      makeSite('den-1', { drivers: 32 }),
      makeSite('slc-2', { drivers: 32 }),
      makeSite('phx-3', { drivers: 0, phase: 'on_break', state: 'break' }),
      makeSite('abq-4', { drivers: 32 }),
    ]);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => NOW,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: {
        name: 'Charlie',
        clientId: 'client-charlie-3',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.siteId).toBe('phx-3');
    expect(body.role).toBe('driver');
    expect(store.wokenSites).toContain('phx-3');

    await app.close();
  });

  it('4. Stale site (updatedAt > 15s ago) is skipped during placement; full live sites fall back to spectator', async () => {
    const store = new InMemoryLobbyStore([
      // den-1 has 5 drivers (highest) and is preferred, but its heartbeat is 20s old (>15s stale)
      makeSite('den-1', { drivers: 5, updatedAt: NOW - 20_000 }),
      // slc-2 is fresh and has 2 drivers
      makeSite('slc-2', { drivers: 2, updatedAt: NOW - 3_000 }),
      makeSite('phx-3', { drivers: 0, updatedAt: NOW - 25_000 }),
      makeSite('abq-4', { drivers: 0, updatedAt: NOW - 30_000 }),
    ]);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => NOW,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: {
        name: 'Dana',
        preferredSite: 'den-1',
        clientId: 'client-dana-4',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.siteId).toBe('slc-2');
    expect(body.role).toBe('driver');

    // Also verify Step 4: when all 4 sites are fresh and full (drivers >= 32), returns spectator
    for (const id of ['den-1', 'slc-2', 'phx-3', 'abq-4'] as const) {
      store.setSite(makeSite(id, { drivers: 32, updatedAt: NOW - 1_000 }));
    }
    const specRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: {
        name: 'Eve',
        preferredSite: 'phx-3',
        clientId: 'client-eve-5',
      },
    });
    expect(specRes.statusCode).toBe(200);
    expect(specRes.json()).toMatchObject({
      siteId: 'phx-3',
      role: 'spectator',
    });

    await app.close();
  });

  it('5. Display name <script>x</script> or invalid characters -> HTTP 400; loadtest- prefix sets isBot=true', async () => {
    const store = new InMemoryLobbyStore([makeSite('den-1', { drivers: 1 })]);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => NOW,
    });

    const xssRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: {
        name: '<script>x</script>',
        clientId: 'client-xss-1',
      },
    });
    expect(xssRes.statusCode).toBe(400);

    const botRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: {
        name: 'loadtest-bot-01',
        clientId: 'client-bot-1',
      },
    });
    expect(botRes.statusCode).toBe(200);
    const botBody = botRes.json();
    expect(botBody.isBot).toBe(true);
    const verifiedBot = verifyTicket(botBody.ticket, TEST_SECRET, NOW);
    expect(verifiedBot.ok).toBe(true);
    if (verifiedBot.ok) {
      expect(verifiedBot.payload.isBot).toBe(true);
    }

    await app.close();
  });

  it('6. /api/network excludes isBot: true entries from public leaderboard and marks stale sites offline', async () => {
    const store = new InMemoryLobbyStore(
      [
        makeSite('den-1', { drivers: 4, spectators: 1, tier: 2, shipped: 120 }),
        makeSite('slc-2', { drivers: 0, phase: 'on_break', state: 'break', shipped: 85 }),
        makeSite('phx-3', { drivers: 3, updatedAt: NOW - 45_000, shipped: 50 }), // stale
      ],
      [
        {
          clientId: 'human-1',
          name: 'Ada Lovelace',
          siteId: 'den-1',
          points: 450,
          deliveries: 30,
          isBot: false,
        },
        {
          clientId: 'bot-1',
          name: 'loadtest-runner-1',
          siteId: 'den-1',
          points: 9999,
          deliveries: 500,
          isBot: true,
        },
        {
          clientId: 'bot-2',
          name: 'pilot-agent-2',
          siteId: 'slc-2',
          points: 5000,
          deliveries: 250,
          isBot: false, // Even if isBot flag was omitted, reserved prefix is filtered
        },
        {
          clientId: 'human-2',
          name: 'Grace Hopper',
          siteId: 'slc-2',
          points: 620,
          deliveries: 41,
          isBot: false,
        },
      ],
    );

    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => NOW,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/network',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sites).toHaveLength(4);
    const den = body.sites.find((s: { id: string }) => s.id === 'den-1');
    const slc = body.sites.find((s: { id: string }) => s.id === 'slc-2');
    const phx = body.sites.find((s: { id: string }) => s.id === 'phx-3');
    const abq = body.sites.find((s: { id: string }) => s.id === 'abq-4');

    expect(den.state).toBe('live');
    expect(den.drivers).toBe(4);
    expect(slc.state).toBe('break');
    expect(phx.state).toBe('offline');
    expect(phx.drivers).toBe(0);
    expect(abq.state).toBe('offline');

    expect(body.leaderboard).toHaveLength(2);
    expect(body.leaderboard.map((p: { name: string }) => p.name)).toEqual([
      'Grace Hopper',
      'Ada Lovelace',
    ]);

    await app.close();
  });

  it('7. /api/network reports maxDrivers from the site heartbeat, falling back to the lobby cap', async () => {
    const store = new InMemoryLobbyStore([
      makeSite('den-1', { drivers: 2, maxDrivers: 24 }),
      makeSite('slc-2', { drivers: 1 }),
    ]);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => NOW,
    });

    const res = await app.inject({ method: 'GET', url: '/api/network' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const byId = new Map<string, Record<string, unknown>>(
      body.sites.map((s: Record<string, unknown>) => [s.id as string, s]),
    );
    expect(byId.get('den-1')?.maxDrivers).toBe(24);
    expect(byId.get('slc-2')?.maxDrivers).toBe(MAX_DRIVERS_PER_SITE);
    expect(byId.get('abq-4')?.maxDrivers).toBe(MAX_DRIVERS_PER_SITE);
    for (const s of body.sites) {
      expect(SiteStatusSchema.safeParse(s).success).toBe(true);
    }

    await app.close();
  });
});
