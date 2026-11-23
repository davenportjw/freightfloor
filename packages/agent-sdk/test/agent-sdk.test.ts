import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { signTicket } from '@warehouse/protocol';
import { buildLobbyServer, InMemoryLobbyStore } from '@warehouse/lobby';
import { createSiteServer, InMemoryPersistenceStore, type SiteServerInstance } from '@warehouse/site';
import {
  FreightFloorAgentClient,
  PilotLoop,
  registerAgent,
} from '../src/index.js';

const TEST_SECRET = 'test-hmac-secret-key-for-agent-sdk-e2e-2026';

describe('@warehouse/agent-sdk: E2E BYO external agent', () => {
  const lobbies: FastifyInstance[] = [];
  const sites: SiteServerInstance[] = [];

  afterEach(async () => {
    while (sites.length > 0) {
      await sites.pop()!.gracefulShutdown();
    }
    while (lobbies.length > 0) {
      await lobbies.pop()!.close();
    }
  });

  it('registers, joins, drives via PilotLoop, and is blocked from triggering server-side LLMs', async () => {
    let brainCalls = 0;
    const persistence = new InMemoryPersistenceStore();
    const site = await createSiteServer({
      siteId: 'den-1',
      ticketSecret: TEST_SECRET,
      persistence,
      brainClient: {
        async generateDecision() {
          brainCalls += 1;
          return { text: '{}', tokensIn: 1, tokensOut: 1 };
        },
      },
      enableIntervals: false,
      restoreFromPersistence: false,
      subscribeTransfers: false,
      requireProxyAuth: false,
    });
    sites.push(site);
    const siteAddr = await site.app.listen({ port: 0, host: '127.0.0.1' });
    const siteWsUrl = siteAddr.replace(/^http/, 'ws') + '/ws';

    const now = Date.now();
    const lobbyStore = new InMemoryLobbyStore([
      {
        id: 'den-1',
        state: 'live',
        phase: 'running',
        drivers: 0,
        spectators: 0,
        tier: 1,
        shipped: 0,
        maxDrivers: 32,
        wsUrl: siteWsUrl,
        updatedAt: now,
      },
    ]);
    const lobby = await buildLobbyServer({
      store: lobbyStore,
      ticketSecret: TEST_SECRET,
      gaMeasurementId: null,
    });
    lobbies.push(lobby);
    const lobbyAddress = await lobby.listen({ port: 0, host: '127.0.0.1' });

    // 1. Register a BYO agent key
    const reg = await registerAgent(lobbyAddress, {
      name: 'SdkDriver',
      model: 'local-heuristic',
    });
    expect(reg.apiKey.startsWith('ffa_')).toBe(true);

    // 2. Connect directly to the site using the lobby-issued ticket
    const errorFrames: Array<{ code: string; message: string }> = [];
    const client = new FreightFloorAgentClient({
      lobbyUrl: lobbyAddress,
      apiKey: reg.apiKey,
      prefer: 'den-1',
      model: 'local-heuristic',
      wsUrlOverride: siteWsUrl,
      onErrorFrame: (e) => errorFrames.push(e),
    });

    const joined = await client.connect();
    expect(joined.externalAgent).toBe(true);
    expect(joined.siteId).toBe('den-1');

    // Step the site a few ticks so deltas arrive
    await site.stepTick(Date.now());
    const initialObs = client.getObservation();
    expect(initialObs).not.toBeNull();
    expect(initialObs?.self).not.toBeNull();

    // 3. Verify ALL server-side LLM / autopilot / relocation commands are hard-blocked for external agents
    client.sendRaw({ type: 'nlCommand', text: 'prioritize zone A' });
    client.sendRaw({ type: 'agentCommand', text: 'go faster and focus zone B' });
    client.sendRaw({ type: 'agentCommand', mode: 'autopilot' });
    client.sendRaw({ type: 'agentCommand', directive: { strategy: 'Strategist' } });
    client.sendRaw({ type: 'acceptRelocation', toSite: 'slc-2' });
    client.sendRaw({ type: 'transferSite', siteId: 'slc-2' });
    await new Promise((r) => setTimeout(r, 80));
    expect(errorFrames.filter((e) => e.code === 'external_agent_llm_disabled')).toHaveLength(4);
    expect(errorFrames.filter((e) => e.code === 'external_agent_forbidden')).toHaveLength(2);

    // Confirm the external agent's forklift did NOT enter autopilot
    const agentVehicle = site.world.vehicles.find((v) => v.ownerClientId === reg.agentId);
    expect(agentVehicle).toBeDefined();
    expect(agentVehicle?.autopilot).toBe(false);

    // 4. Drive with PilotLoop and verify vehicle moves + heartbeat tracks externalAgentClientIds
    const startX = initialObs!.self!.x;
    const startY = initialObs!.self!.y;
    const pilot = new PilotLoop(client, {
      decide: () => ({ action: 'driveTo', x: startX + 8, y: startY, boost: true }),
      decisionIntervalMs: 250,
      steeringIntervalMs: 50,
    });
    pilot.start();

    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 30));
      await site.stepTick(Date.now());
    }
    pilot.stop();

    const afterObs = client.getObservation();
    const movedDist = Math.hypot(
      (afterObs?.self?.x ?? startX) - startX,
      (afterObs?.self?.y ?? startY) - startY,
    );
    expect(movedDist).toBeGreaterThan(0.1);

    // Heartbeat should report this agent in externalAgentClientIds
    await site.flushHeartbeat(Date.now());
    const heartbeats = await persistence.getHeartbeats();
    expect(heartbeats[0]?.externalAgentClientIds).toContain(reg.agentId);

    // Server-side house-bot Gemini brain must stay paused when only external agents are connected
    expect(brainCalls).toBe(0);

    // Mixed human + external-agent shard: connect a real human spectator so the brain is NOT paused,
    // push a real-shape DecisionRequest targeting the external agent's vehicle (`agentVehicle.id`),
    // and prove defense-in-depth drops it before drainQueue ever calls brainClient.
    const humanTicket = signTicket(
      {
        clientId: 'human-observer-1',
        name: 'HumanWatcher',
        siteId: 'den-1',
        isBot: false,
        role: 'spectator',
        exp: Date.now() + 60_000,
      },
      TEST_SECRET,
    );
    const humanWs = new WebSocket(siteWsUrl);
    await new Promise<void>((resolve, reject) => {
      humanWs.on('open', () => humanWs.send(JSON.stringify({ type: 'hello', ticket: humanTicket })));
      humanWs.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === 'welcome') resolve();
      });
      humanWs.on('error', reject);
    });

    site.world.pendingDecisions = [
      {
        id: 99999,
        agentId: agentVehicle!.id,
        kind: 'tactics',
        tIssued: site.world.t,
        deadline: site.world.t + 60,
        persona: 'Strategist',
        context: {
          agentId: agentVehicle!.id,
          persona: 'Strategist',
          x: agentVehicle!.x,
          y: agentVehicle!.y,
          battery: agentVehicle!.battery,
          cargo: agentVehicle!.cargo.length,
          shiftProgress: 0.2,
          backlog: 5,
          p0Count: 1,
          hazardsCount: 0,
          nearbyDrivers: 1,
          nearbyAgents: 1,
        },
        options: [],
      },
    ];
    await site.stepTick(Date.now());
    expect(site.world.pendingDecisions.some((r) => r.agentId === agentVehicle!.id)).toBe(false);
    expect(brainCalls).toBe(0);

    humanWs.close();
    client.close();
  });
});
