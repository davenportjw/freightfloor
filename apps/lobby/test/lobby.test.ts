import { describe, expect, it } from 'vitest';
import { LeaderboardEntrySchema, SiteStatusSchema, verifyTicket } from '@warehouse/protocol';
import {
  buildLobbyServer,
  CSP_HEADER,
  InMemoryLobbyStore,
  MAX_DRIVERS_PER_SITE,
  normalizePpm,
  publicIdFor,
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
        role: 'driver',
        jti: expect.any(String),
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

  it('9. Assigns non-overlapping Adj-Noun callsigns, supports finding/switching to existing callsigns or resume codes, and rejects adding new custom names', async () => {
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

    // Passing a custom name in `name` is ignored for human players (server assigns its own callsign)
    const join2 = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'client-human-202', name: 'Custom-New-Handle' },
    });
    expect(join2.statusCode).toBe(200);
    const body2 = join2.json();
    expect(body2.name).not.toBe('Custom-New-Handle');
    expect(body2.name).not.toBe(body1.name);

    // Searching existing callsigns via GET /api/callsigns returns matching existing human callsigns
    const searchRes = await app.inject({
      method: 'GET',
      url: `/api/callsigns?q=${encodeURIComponent(body1.name.slice(0, 5))}`,
    });
    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.json().callsigns).toContain(body1.name);

    // Typing an existing callsign in `resume` finds and returns that existing callsign
    const lookupRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'new-browser-session-id', resume: body1.name.toUpperCase() },
    });
    expect(lookupRes.statusCode).toBe(200);
    expect(lookupRes.json().name).toBe(body1.name);
    expect(lookupRes.json().clientId).toBe('client-human-101');

    // Resuming with the secret resume code from a new browser session also restores client-human-101
    expect(body1.resumeToken).toMatch(/^wr1_[A-Za-z0-9_-]{32}$/);
    const resumeRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'new-browser-session-id', resume: body1.resumeToken },
    });
    expect(resumeRes.statusCode).toBe(200);
    const resumed = resumeRes.json();
    expect(resumed.name).toBe(body1.name);
    expect(resumed.clientId).toBe('client-human-101');

    // Attempting to enter a non-existent callsign returns 404 invalid_resume_code and never adds it
    const unknownRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'new-browser-session-id', resume: 'Nonexistent-Callsign' },
    });
    expect(unknownRes.statusCode).toBe(404);
    expect(unknownRes.json().error).toBe('invalid_resume_code');
    const afterUnknownSearch = await app.inject({
      method: 'GET',
      url: '/api/callsigns?q=Nonexistent',
    });
    expect(afterUnknownSearch.json().callsigns).toEqual([]);

    // Malformed / injection resume lookups are rejected with 400 invalid_name before querying the store
    let lookups = 0;
    const originalResolve = store.resolvePlayerIdentity.bind(store);
    store.resolvePlayerIdentity = async (params) => {
      lookups += 1;
      return originalResolve(params);
    };
    for (const bad of ['<script>alert(1)</script>', 'https://evil.example', 'bad!@#name']) {
      const blockedRes = await app.inject({
        method: 'POST',
        url: '/api/join',
        payload: { clientId: 'new-browser-session-id', resume: bad },
      });
      expect(blockedRes.statusCode).toBe(400);
      expect(blockedRes.json().error).toBe('invalid_name');
    }
    expect(lookups).toBe(0);

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

  it('11. /api/network passes through nonnegative ppm from player stats and omits missing/invalid values', async () => {
    const store = new InMemoryLobbyStore(
      [makeSite('den-1', { drivers: 2 })],
      [
        { clientId: 'h-ppm', name: 'Ada Lovelace', siteId: 'den-1', points: 900, deliveries: 40, ppm: 3.4 },
        { clientId: 'h-zero', name: 'Grace Hopper', siteId: 'den-1', points: 500, deliveries: 2, ppm: 0 },
        { clientId: 'h-none', name: 'Alan Turing', siteId: 'den-1', points: 300, deliveries: 9 },
        { clientId: 'h-neg', name: 'Edsger Dijkstra', siteId: 'den-1', points: 100, deliveries: 1, ppm: -2 },
      ],
    );
    const app = await buildLobbyServer({ store, ticketSecret: TEST_SECRET, now: () => NOW });

    const res = await app.inject({ method: 'GET', url: '/api/network' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const byId = new Map<string, Record<string, unknown>>(
      body.leaderboard.map((p: Record<string, unknown>) => [p.clientId as string, p]),
    );
    // Leaderboard rows are keyed by the opaque publicId, never the raw clientId.
    const pub = (id: string) => publicIdFor(id, TEST_SECRET);
    expect(byId.get(pub('h-ppm'))?.ppm).toBe(3.4);
    expect(byId.get(pub('h-zero'))?.ppm).toBe(0);
    expect(byId.get(pub('h-none'))).not.toHaveProperty('ppm');
    expect(byId.get(pub('h-neg'))).not.toHaveProperty('ppm');
    expect(byId.has('h-ppm')).toBe(false);
    for (const entry of body.leaderboard) {
      expect(LeaderboardEntrySchema.safeParse(entry).success).toBe(true);
    }

    expect(normalizePpm(1.5)).toBe(1.5);
    expect(normalizePpm(Number.NaN)).toBeUndefined();
    expect(normalizePpm('4')).toBeUndefined();

    await app.close();
  });

  it('12. /healthz/ trailing-slash alias returns lobby health JSON (GFE intercepts exact /healthz on *.a.run.app)', async () => {
    const store = new InMemoryLobbyStore([makeSite('den-1')]);
    const app = await buildLobbyServer({ store, ticketSecret: TEST_SECRET, now: () => NOW });
    for (const url of ['/healthz', '/healthz/']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, service: 'lobby' });
    }
    await app.close();
  });

  it('13. Stage 2B Test 1 — >128 Player Queue Admission: 129th POST /api/join returns spectator with queue.state=queued, position=1, totalQueued=1, and valid seatLeaseId', async () => {
    const store = new InMemoryLobbyStore([
      makeSite('den-1', { drivers: 32 }),
      makeSite('slc-2', { drivers: 32 }),
      makeSite('phx-3', { drivers: 32 }),
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
        clientId: 'client-queue-129',
        name: 'Player129',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.role).toBe('spectator');
    expect(body.queue).toBeDefined();
    expect(body.queue.state).toBe('queued');
    expect(body.queue.position).toBe(1);
    expect(body.queue.totalQueued).toBe(1);
    expect(typeof body.queue.seatLeaseId).toBe('string');
    expect(body.queue.seatLeaseId.length).toBeGreaterThanOrEqual(8);

    const verified = verifyTicket(body.ticket, TEST_SECRET, NOW + 1_000);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.role).toBe('spectator');
      expect(verified.payload.jti).toEqual(expect.any(String));
    }

    const netRes = await app.inject({ method: 'GET', url: '/api/network' });
    expect(netRes.statusCode).toBe(200);
    expect(netRes.json().queueSize).toBe(1);

    await app.close();
  });

  it('14. Stage 2B Test 2 — Strict FIFO Promotion & Seat Lease Reservation: promotes position #1 to ready when a seat opens while #2 and #3 remain queued, then claims driver ticket', async () => {
    let clock = NOW;
    const store = new InMemoryLobbyStore([
      makeSite('den-1', { drivers: 32 }),
      makeSite('slc-2', { drivers: 32 }),
      makeSite('phx-3', { drivers: 32 }),
      makeSite('abq-4', { drivers: 32 }),
    ]);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => clock,
    });

    // Enqueue 3 players in FIFO order
    const joinA = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'client-fifo-a', name: 'Alpha' },
    });
    clock += 100;
    const joinB = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'client-fifo-b', name: 'Bravo' },
    });
    clock += 100;
    const joinC = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'client-fifo-c', name: 'Charlie' },
    });

    expect(joinA.json().queue.position).toBe(1);
    expect(joinB.json().queue.position).toBe(2);
    expect(joinC.json().queue.position).toBe(3);

    // 1 driver seat opens on den-1 (31/32)
    store.setSite(makeSite('den-1', { drivers: 31, updatedAt: clock }));

    // Poll status for #1 -> promoted to ready on den-1
    const statusA = await app.inject({
      method: 'GET',
      url: '/api/queue/status?clientId=client-fifo-a',
    });
    expect(statusA.statusCode).toBe(200);
    const statusABody = statusA.json();
    expect(statusABody.state).toBe('ready');
    expect(statusABody.assignedSiteId).toBe('den-1');
    expect(statusABody.leaseExpiresAt).toBe(clock + 20_000);

    // #2 and #3 remain queued at positions 1 and 2
    const statusB = await app.inject({
      method: 'GET',
      url: '/api/queue/status?clientId=client-fifo-b',
    });
    const statusC = await app.inject({
      method: 'GET',
      url: '/api/queue/status?clientId=client-fifo-c',
    });
    expect(statusB.json().state).toBe('queued');
    expect(statusB.json().position).toBe(1);
    expect(statusC.json().state).toBe('queued');
    expect(statusC.json().position).toBe(2);

    // Player #1 claims their reserved seat via POST /api/queue/claim
    const claimA = await app.inject({
      method: 'POST',
      url: '/api/queue/claim',
      payload: {
        clientId: 'client-fifo-a',
        seatLeaseId: statusABody.seatLeaseId,
      },
    });
    expect(claimA.statusCode).toBe(200);
    const claimABody = claimA.json();
    expect(claimABody.role).toBe('driver');
    expect(claimABody.siteId).toBe('den-1');
    expect(claimABody.queue.state).toBe('claimed');

    const verifiedClaim = verifyTicket(claimABody.ticket, TEST_SECRET, clock + 1_000);
    expect(verifiedClaim.ok).toBe(true);
    if (verifiedClaim.ok) {
      expect(verifiedClaim.payload.role).toBe('driver');
      expect(verifiedClaim.payload.seatLeaseId).toBe(statusABody.seatLeaseId);
      expect(verifiedClaim.payload.jti).toEqual(expect.any(String));
    }

    await app.close();
  });

  it('15. Stage 2B Test 3 — Lease Expiration & Re-Allocation: expires un-claimed ready lease after 20s and promotes next player in FIFO queue', async () => {
    let clock = NOW;
    const store = new InMemoryLobbyStore([
      makeSite('den-1', { drivers: 32 }),
      makeSite('slc-2', { drivers: 32 }),
      makeSite('phx-3', { drivers: 32 }),
      makeSite('abq-4', { drivers: 32 }),
    ]);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => clock,
      seatClaimLeaseMs: 20_000,
      queueHeartbeatTtlMs: 60_000,
    });

    const join1 = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'client-lease-1', name: 'LeaseOne' },
    });
    clock += 50;
    await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'client-lease-2', name: 'LeaseTwo' },
    });

    // Open 1 seat on slc-2
    store.setSite(makeSite('slc-2', { drivers: 31, updatedAt: clock }));

    // Player 1 becomes ready
    const readyRes1 = await app.inject({
      method: 'GET',
      url: '/api/queue/status?clientId=client-lease-1',
    });
    expect(readyRes1.json().state).toBe('ready');
    expect(readyRes1.json().assignedSiteId).toBe('slc-2');
    const leaseId1 = join1.json().queue.seatLeaseId;

    // Advance clock past 20s lease TTL without Player 1 claiming; keep slc-2 heartbeat fresh
    clock += 21_000;
    for (const id of ['den-1', 'phx-3', 'abq-4'] as const) {
      store.setSite(makeSite(id, { drivers: 32, updatedAt: clock }));
    }
    store.setSite(makeSite('slc-2', { drivers: 31, updatedAt: clock }));

    // Player 2 polls status -> Player 1's expired lease is pruned and Player 2 is promoted to ready on slc-2
    const readyRes2 = await app.inject({
      method: 'GET',
      url: '/api/queue/status?clientId=client-lease-2',
    });
    expect(readyRes2.statusCode).toBe(200);
    expect(readyRes2.json().state).toBe('ready');
    expect(readyRes2.json().assignedSiteId).toBe('slc-2');

    // Player 1 attempting to claim the expired lease gets 410 Gone
    const lateClaim1 = await app.inject({
      method: 'POST',
      url: '/api/queue/claim',
      payload: {
        clientId: 'client-lease-1',
        seatLeaseId: leaseId1,
      },
    });
    expect(lateClaim1.statusCode).toBe(410);
    expect(lateClaim1.json().error).toBe('lease_expired');

    await app.close();
  });

  it('16. Stage 2B Test 4 — Re-Queue After Eviction (4010ShiftEnded / 4009IdleTimeout): POST /api/join with requeue: true places player at tail of FIFO queue or admits immediately if seats open with fresh jti and seatLeaseId', async () => {
    let clock = NOW;
    const store = new InMemoryLobbyStore([
      makeSite('den-1', { drivers: 32 }),
      makeSite('slc-2', { drivers: 32 }),
      makeSite('phx-3', { drivers: 32 }),
      makeSite('abq-4', { drivers: 32 }),
    ]);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => clock,
    });

    // Enqueue Player A (#1) and Player B (#2)
    const firstA = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'client-evict-a', name: 'EvictedDriver' },
    });
    clock += 100;
    await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'client-evict-b', name: 'WaitingDriver' },
    });

    const firstBodyA = firstA.json();
    const firstVerifiedA = verifyTicket(firstBodyA.ticket, TEST_SECRET, clock);
    expect(firstVerifiedA.ok).toBe(true);

    // Player A calls POST /api/join with requeue: true when all sites are full -> placed at tail (#2 behind B) with fresh jti & seatLeaseId
    clock += 100;
    const requeueFullA = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'client-evict-a', name: 'EvictedDriver', requeue: true },
    });
    expect(requeueFullA.statusCode).toBe(200);
    const requeueBodyA = requeueFullA.json();
    expect(requeueBodyA.role).toBe('spectator');
    expect(requeueBodyA.queue.state).toBe('queued');
    expect(requeueBodyA.queue.position).toBe(2);
    expect(requeueBodyA.queue.seatLeaseId).not.toBe(firstBodyA.queue.seatLeaseId);

    const secondVerifiedA = verifyTicket(requeueBodyA.ticket, TEST_SECRET, clock);
    expect(secondVerifiedA.ok).toBe(true);
    if (firstVerifiedA.ok && secondVerifiedA.ok) {
      expect(secondVerifiedA.payload.jti).not.toBe(firstVerifiedA.payload.jti);
    }

    // Now clear queue and open seats on den-1 -> requeue: true admits immediately as driver
    await app.inject({
      method: 'POST',
      url: '/api/queue/leave',
      payload: { clientId: 'client-evict-b' },
    });
    store.setSite(makeSite('den-1', { drivers: 20, updatedAt: clock }));

    const requeueOpenA = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'client-evict-a', name: 'EvictedDriver', requeue: true },
    });
    expect(requeueOpenA.statusCode).toBe(200);
    expect(requeueOpenA.json().role).toBe('driver');
    expect(requeueOpenA.json().siteId).toBe('den-1');

    await app.close();
  });

  it('17. Stage 2B Test 5 — Elastic Overflow Warehouse Scaling: wakes den-2 when queued players reach queueScaleThreshold, includes den-2 in /api/network, and promotes queued players to ready on den-2', async () => {
    let clock = NOW;
    const store = new InMemoryLobbyStore([
      makeSite('den-1', { drivers: 32 }),
      makeSite('slc-2', { drivers: 32 }),
      makeSite('phx-3', { drivers: 32 }),
      makeSite('abq-4', { drivers: 32 }),
    ]);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => clock,
      maxWarehouses: 8,
      queueScaleThreshold: 4,
    });

    const clientIds = ['scale-p1', 'scale-p2', 'scale-p3', 'scale-p4'];
    for (const cid of clientIds) {
      clock += 50;
      const res = await app.inject({
        method: 'POST',
        url: '/api/join',
        payload: { clientId: cid },
      });
      expect(res.statusCode).toBe(200);
    }

    // Verify lobby auto-scaler woke overflow shard den-2
    expect(store.wokenSites).toContain('den-2');

    // Verify GET /api/network includes den-2 as a live warehouse
    const netRes = await app.inject({ method: 'GET', url: '/api/network' });
    expect(netRes.statusCode).toBe(200);
    const netBody = netRes.json();
    expect(netBody.maxWarehouses).toBe(8);
    const den2 = netBody.sites.find((s: { id: string }) => s.id === 'den-2');
    expect(den2).toBeDefined();
    expect(den2.state).toBe('live');

    // Verify all 4 queued players are promoted to state: 'ready' with assignedSiteId: 'den-2'
    for (const cid of clientIds) {
      const statusRes = await app.inject({
        method: 'GET',
        url: `/api/queue/status?clientId=${cid}`,
      });
      expect(statusRes.statusCode).toBe(200);
      const statusBody = statusRes.json();
      expect(statusBody.state).toBe('ready');
      expect(statusBody.assignedSiteId).toBe('den-2');
    }

    await app.close();
  });

  it('18. POST /api/join with runMode: "freerange" (without mode) mints a ticket with runMode === "freerange" and applies Free Range capacity routing', async () => {
    const store = new InMemoryLobbyStore([
      makeSite('den-1', { drivers: 27 }),
      makeSite('slc-2', { drivers: 8 }),
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
        clientId: 'client-freerange-runmode',
        name: 'Runner Run 2',
        runMode: 'freerange',
        requeue: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Free Range soft-cap (drivers >= 26 on den-1) routes to slc-2
    expect(body.siteId).toBe('slc-2');
    expect(body.role).toBe('driver');

    const verified = verifyTicket(body.ticket, TEST_SECRET, NOW);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.runMode).toBe('freerange');
    }

    await app.close();
  });
});



