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
    expect(body.wsUrl).toBe('ws://localhost:80/ws?site=den-1');

    const verified = verifyTicket(body.ticket, TEST_SECRET, NOW + 1_000);
    expect(verified).toEqual({
      ok: true,
      payload: {
        clientId: 'client-alice-1',
        name: body.name,
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

  it('8. FirestoreLobbyStore removes pending drivers on cross-site reassignment and expires stale pending entries once a newer heartbeat arrives', async () => {
    const { FirestoreLobbyStore } = await import('../src/index.js');
    const docs = new Map<string, Record<string, unknown>>([
      [
        'den-1',
        {
          id: 'den-1',
          state: 'live',
          phase: 'running',
          drivers: 0,
          spectators: 0,
          driverClientIds: [],
          updatedAt: 1_000,
        },
      ],
      [
        'slc-2',
        {
          id: 'slc-2',
          state: 'live',
          phase: 'running',
          drivers: 0,
          spectators: 0,
          driverClientIds: [],
          updatedAt: 1_000,
        },
      ],
    ]);

    const fakeDb = {
      collection: () => ({
        get: async () => ({
          forEach: (cb: (doc: { id: string; data: () => Record<string, unknown> }) => void) => {
            for (const [id, data] of docs.entries()) {
              cb({ id, data: () => data });
            }
          },
        }),
      }),
    };

    const store = new FirestoreLobbyStore(fakeDb as never);

    // Assign client-1 to den-1 at t=1000
    store.recordAssignment('den-1', 'client-1', 'driver', 1_000);
    let sites = await store.getSites(1_100);
    expect(sites.find((s) => s.id === 'den-1')?.drivers).toBe(1);
    expect(sites.find((s) => s.id === 'slc-2')?.drivers).toBe(0);

    // Client-1 immediately switches to slc-2 at t=1200 -> removed from den-1 pendingDrivers
    store.recordAssignment('slc-2', 'client-1', 'driver', 1_200);
    sites = await store.getSites(1_300);
    expect(sites.find((s) => s.id === 'den-1')?.drivers).toBe(0);
    expect(sites.find((s) => s.id === 'slc-2')?.drivers).toBe(1);

    // Suppose client-1 disconnects and slc-2 flushes a heartbeat at t=4000 (> 1200 + 2000) with driverClientIds: []
    docs.set('slc-2', {
      ...docs.get('slc-2')!,
      drivers: 0,
      driverClientIds: [],
      updatedAt: 4_000,
    });
    sites = await store.getSites(4_100);
    expect(sites.find((s) => s.id === 'slc-2')?.drivers).toBe(0);
  });

  it('9. Assigns non-overlapping Adj-Noun callsigns to human players and supports resuming a previous callsign', async () => {
    const store = new InMemoryLobbyStore([makeSite('den-1', { drivers: 1 })]);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => NOW,
    });

    // Join without specifying a name -> server assigns a valid Adj-Noun callsign
    const join1 = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'client-human-101' },
    });
    expect(join1.statusCode).toBe(200);
    const body1 = join1.json();
    expect(body1.name).toMatch(/^[a-z]+-[a-z]+-\d{2}$/i);
    expect(body1.clientId).toBe('client-human-101');

    // Re-joining with the same clientId keeps the same assigned callsign
    const join1Again = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'client-human-101' },
    });
    expect(join1Again.statusCode).toBe(200);
    expect(join1Again.json().name).toBe(body1.name);

    // Another client attempting to claim body1.name gets a different non-overlapping callsign
    const join2 = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'client-human-202', name: body1.name },
    });
    expect(join2.statusCode).toBe(200);
    const body2 = join2.json();
    expect(body2.name).not.toBe(body1.name);

    // Resuming body1.name from a new browser session restores client-human-101 and its callsign
    const resumeRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'new-browser-session-id', resume: body1.name },
    });
    expect(resumeRes.statusCode).toBe(200);
    const resumed = resumeRes.json();
    expect(resumed.name).toBe(body1.name);
    expect(resumed.clientId).toBe('client-human-101');

    // Resuming an unknown callsign returns 404 unknown_callsign
    const unknownRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'new-browser-session-id', resume: 'Nonexistent-Callsign' },
    });
    expect(unknownRes.statusCode).toBe(404);
    expect(unknownRes.json().error).toBe('unknown_callsign');


    await app.close();
  });

  it('10. Free Range soft-cap (drivers >= 26) routes freerange joiners to warmer/break shards while reserving 4-6 slots for Blitz drop-ins', async () => {
    const store = new InMemoryLobbyStore([
      makeSite('den-1', { drivers: 27 }),
      makeSite('slc-2', { drivers: 8 }),
      makeSite('phx-3', { drivers: 0, phase: 'on_break', state: 'break' }),
      makeSite('abq-4', { drivers: 0, state: 'offline', updatedAt: NOW - 60_000 }),
    ]);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => NOW,
    });

    // Free Range joiner is routed away from den-1 (27 >= 26 soft cap) to slc-2 (8 < 26)
    const freeRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: {
        clientId: 'client-freerange-1',
        preferredSite: 'den-1',
        mode: 'freerange',
      },
    });
    expect(freeRes.statusCode).toBe(200);
    const freeBody = freeRes.json();
    expect(freeBody.siteId).toBe('slc-2');
    expect(freeBody.role).toBe('driver');
    const verifiedFree = verifyTicket(freeBody.ticket, TEST_SECRET, NOW + 1_000);
    expect(verifiedFree.ok).toBe(true);
    if (verifiedFree.ok) {
      expect(verifiedFree.payload.runMode).toBe('freerange');
    }

    // Blitz joiner can still drop into den-1 (27 < 30 blitz soft cap / 32 hard cap)
    const blitzRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: {
        clientId: 'client-blitz-1',
        preferredSite: 'den-1',
        mode: 'blitz',
      },
    });
    expect(blitzRes.statusCode).toBe(200);
    const blitzBody = blitzRes.json();
    expect(blitzBody.siteId).toBe('den-1');
    expect(blitzBody.role).toBe('driver');
    const verifiedBlitz = verifyTicket(blitzBody.ticket, TEST_SECRET, NOW + 1_000);
    expect(verifiedBlitz.ok).toBe(true);
    if (verifiedBlitz.ok) {
      expect(verifiedBlitz.payload.runMode).toBe('blitz');
    }

    // If slc-2 also reaches 26 drivers, Free Range joiner wakes phx-3 (break site)
    store.setSite(makeSite('slc-2', { drivers: 26 }));
    const wakeRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: {
        clientId: 'client-freerange-2',
        mode: 'freerange',
      },
    });
    expect(wakeRes.statusCode).toBe(200);
    expect(wakeRes.json().siteId).toBe('phx-3');
    expect(store.wokenSites).toContain('phx-3');

    await app.close();
  });
});


