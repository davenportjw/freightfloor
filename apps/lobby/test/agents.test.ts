import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AGENT_KEY_PATTERN, verifyTicket } from '@warehouse/protocol';
import {
  buildLobbyServer,
  hashAgentKey,
  InMemoryLobbyStore,
  type StoredPlayerDoc,
  type StoredSiteDoc,
} from '../src/index.js';

const TEST_SECRET = 'test-hmac-secret-key-for-byo-agents-2026';

function liveSite(id: 'den-1' | 'slc-2' | 'phx-3' | 'abq-4', now: number, extra: Partial<StoredSiteDoc> = {}): StoredSiteDoc {
  return {
    id,
    state: 'live',
    phase: 'running',
    drivers: 2,
    spectators: 0,
    tier: 1,
    shipped: 10,
    maxDrivers: 32,
    wsUrl: `ws://127.0.0.1:8080/ws?site=${id}`,
    updatedAt: now,
    ...extra,
  };
}

describe('@warehouse/lobby: BYO external agents API', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    while (apps.length > 0) {
      await apps.pop()!.close();
    }
  });

  it('registers an agent key (stored hashed only), joins with Bearer auth, and signs externalAgent ticket', async () => {
    const now = 1_750_000_000_000;
    const store = new InMemoryLobbyStore([liveSite('den-1', now)]);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => now,
      gaMeasurementId: null,
    });
    apps.push(app);

    const regRes = await app.inject({
      method: 'POST',
      url: '/api/agents/register',
      payload: { name: 'ForkPilot', model: 'gemini-3.5-flash' },
    });
    expect(regRes.statusCode).toBe(201);
    const reg = regRes.json();
    expect(reg.apiKey).toMatch(AGENT_KEY_PATTERN);
    expect(reg.name).toBe('ForkPilot');
    expect(reg.model).toBe('gemini-3.5-flash');

    // Stored record is keyed by SHA-256 hash, never raw key
    expect(await store.lookupAgentKey(reg.apiKey)).toBeNull();
    const stored = await store.lookupAgentKey(hashAgentKey(reg.apiKey));
    expect(stored?.agentId).toBe(reg.agentId);
    expect(stored?.name).toBe('ForkPilot');

    // Join works even with a crawler-like User-Agent (unlike human /api/join)
    const joinRes = await app.inject({
      method: 'POST',
      url: '/api/agents/join',
      headers: {
        authorization: `Bearer ${reg.apiKey}`,
        'user-agent': 'MyForkliftBot/1.0 (+https://example.com)',
      },
      payload: { prefer: 'den-1', mode: 'blitz' },
    });
    expect(joinRes.statusCode).toBe(200);
    const joined = joinRes.json();
    expect(joined.siteId).toBe('den-1');
    expect(joined.isBot).toBe(true);
    expect(joined.externalAgent).toBe(true);
    expect(joined.agentModel).toBe('gemini-3.5-flash');

    const verified = verifyTicket(joined.ticket, TEST_SECRET, now);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.clientId).toBe(reg.agentId);
      expect(verified.payload.isBot).toBe(true);
      expect(verified.payload.externalAgent).toBe(true);
      expect(verified.payload.agentModel).toBe('gemini-3.5-flash');
      expect(verified.payload.role).toBe('driver');
    }
  });

  it('rejects missing, invalid, or revoked keys with 401', async () => {
    const now = 1_750_000_000_000;
    const store = new InMemoryLobbyStore([liveSite('den-1', now)]);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => now,
      gaMeasurementId: null,
    });
    apps.push(app);

    const noAuth = await app.inject({ method: 'POST', url: '/api/agents/join', payload: {} });
    expect(noAuth.statusCode).toBe(401);

    const badKey = await app.inject({
      method: 'POST',
      url: '/api/agents/join',
      headers: { authorization: 'Bearer not-a-valid-key' },
      payload: {},
    });
    expect(badKey.statusCode).toBe(401);

    const reg = (
      await app.inject({
        method: 'POST',
        url: '/api/agents/register',
        payload: { name: 'Revokable' },
      })
    ).json();
    store.revokeAgentKey(hashAgentKey(reg.apiKey), now);

    const revoked = await app.inject({
      method: 'POST',
      url: '/api/agents/join',
      headers: { authorization: `Bearer ${reg.apiKey}` },
      payload: {},
    });
    expect(revoked.statusCode).toBe(401);
  });

  it('enforces 1 active forklift per key (409) and per-site external agent cap (503)', async () => {
    const now = 1_750_000_000_000;
    const store = new InMemoryLobbyStore([liveSite('den-1', now)]);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => now,
      gaMeasurementId: null,
      maxExternalAgentsPerSite: 2,
      agentRegisterRatePerMin: 20,
    });
    apps.push(app);

    const reg1 = (await app.inject({ method: 'POST', url: '/api/agents/register', payload: { name: 'AgentOne' } })).json();
    const reg2 = (await app.inject({ method: 'POST', url: '/api/agents/register', payload: { name: 'AgentTwo' } })).json();
    const reg3 = (await app.inject({ method: 'POST', url: '/api/agents/register', payload: { name: 'AgentThree' } })).json();

    // First join succeeds
    expect(
      (await app.inject({ method: 'POST', url: '/api/agents/join', headers: { authorization: `Bearer ${reg1.apiKey}` }, payload: {} })).statusCode,
    ).toBe(200);

    // Duplicate join with same key returns 409 agent_already_active
    const dup = await app.inject({
      method: 'POST',
      url: '/api/agents/join',
      headers: { authorization: `Bearer ${reg1.apiKey}` },
      payload: {},
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('agent_already_active');

    // Second key takes slot 2/2
    expect(
      (await app.inject({ method: 'POST', url: '/api/agents/join', headers: { authorization: `Bearer ${reg2.apiKey}` }, payload: {} })).statusCode,
    ).toBe(200);

    // Third key hits per-site cap (503 agent_capacity_full)
    const capHit = await app.inject({
      method: 'POST',
      url: '/api/agents/join',
      headers: { authorization: `Bearer ${reg3.apiKey}` },
      payload: {},
    });
    expect(capHit.statusCode).toBe(503);
    expect(capHit.json().error).toBe('agent_capacity_full');
  });

  it('keeps external agents on /api/agents/leaderboard and out of the human /api/network leaderboard', async () => {
    const now = 1_750_000_000_000;
    const players: StoredPlayerDoc[] = [
      { clientId: 'human-1', name: 'HumanAce', points: 900, bestBlitzPts: 900, deliveries: 12, isBot: false },
      {
        clientId: 'agent_abc123',
        name: 'AStarBot',
        points: 1400,
        bestBlitzPts: 1400,
        ppm: 4.5,
        deliveries: 20,
        isBot: true,
        externalAgent: true,
        agentModel: 'rust-astar',
      },
      { clientId: 'house-bot-1', name: 'Bot Alpha', points: 2000, deliveries: 30, isBot: true },
    ];
    const store = new InMemoryLobbyStore([liveSite('den-1', now)], players);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => now,
      gaMeasurementId: null,
    });
    apps.push(app);

    const net = (await app.inject({ method: 'GET', url: '/api/network' })).json();
    expect(net.leaderboard.map((e: { name: string }) => e.name)).toEqual(['HumanAce']);

    const agentLb = (await app.inject({ method: 'GET', url: '/api/agents/leaderboard' })).json();
    expect(agentLb.leaderboard).toHaveLength(1);
    expect(agentLb.leaderboard[0]).toMatchObject({
      name: 'AStarBot',
      bestBlitzPts: 1400,
      ppm: 4.5,
      isBot: true,
      externalAgent: true,
      agentModel: 'rust-astar',
    });
  });

  it('rejects prompt-injection agent names and enforces registration rate limit', async () => {
    const now = 1_750_000_000_000;
    const store = new InMemoryLobbyStore([liveSite('den-1', now)]);
    const app = await buildLobbyServer({
      store,
      ticketSecret: TEST_SECRET,
      now: () => now,
      gaMeasurementId: null,
      agentRegisterRatePerMin: 2,
    });
    apps.push(app);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/agents/register',
      payload: { name: '<script>alert(1)</script>' },
    });
    expect(bad.statusCode).toBe(400);

    expect((await app.inject({ method: 'POST', url: '/api/agents/register', payload: { name: 'PilotOne' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/agents/register', payload: { name: 'PilotTwo' } })).statusCode).toBe(429);
  });
});
