import { describe, expect, it, afterEach } from 'vitest';
import { buildLobbyServer, InMemoryLobbyStore } from '@warehouse/lobby';
import {
  createSiteServer,
  type SiteServerInstance,
  type BrainModelClient,
  type ModelArmorClient,
  type NlOrderParserClient,
} from '@warehouse/site';
import { runLiveSmoke, runArmorSmoke, ADVERSARIAL_INJECTIONS } from '../src/index.js';

const SHARED_TICKET_SECRET = 'smoke-test-shared-hmac-secret-2026';

describe('@warehouse/smoke end-to-end verification (in-process Lobby + 2 Sites)', () => {
  const siteServers: SiteServerInstance[] = [];
  let closeLobby: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closeLobby) {
      await closeLobby().catch(() => undefined);
      closeLobby = null;
    }
    for (const s of siteServers.splice(0)) {
      await s.close().catch(() => undefined);
    }
  });

  async function bootCluster() {
    const brainClient: BrainModelClient = {
      async generateDecision(req) {
        if (req.kind === 'cards') {
          const match = req.prompt.match(/"id":\s*"([^"]+)"/);
          return {
            text: JSON.stringify({ keep: [match?.[1] ?? 'turbo'], reason: 'Keep card' }),
            tokensIn: 32,
            tokensOut: 14,
          };
        }
        if (req.kind === 'contract') {
          const match = req.prompt.match(/"orderId":\s*"?(\d+)"?/);
          return {
            text: JSON.stringify({ orderIds: [match?.[1] ?? '1'], reason: 'Pick order' }),
            tokensIn: 32,
            tokensOut: 14,
          };
        }
        if (req.kind === 'hazard') {
          return {
            text: JSON.stringify({ choice: 'reroute', reason: 'Reroute around spill' }),
            tokensIn: 32,
            tokensOut: 14,
          };
        }
        return {
          text: JSON.stringify({
            speed: 1.0,
            buffer: 2,
            respect: 0.6,
            chargeAt: 20,
            batch: 1,
            note: 'Smoke test brain decision',
          }),
          tokensIn: 32,
          tokensOut: 14,
        };
      },
    };

    const armorClient: ModelArmorClient = {
      async sanitizeUserPrompt(text: string) {
        const lower = text.toLowerCase();
        if (
          lower.includes('ignore previous') ||
          lower.includes('system:') ||
          lower.includes('</order-') ||
          lower.includes('system instruction') ||
          lower.includes('<script>') ||
          lower.includes('9999')
        ) {
          return {
            flagged: true,
            reasonCode: 'armor_blocked',
            detail: 'Adversarial prompt injection blocked by Model Armor',
          };
        }
        return { flagged: false };
      },
      async sanitizeModelResponse() {
        return { flagged: false };
      },
    };

    const parserClient: NlOrderParserClient = {
      async parseOrder(req) {
        const lower = req.userPrompt.toLowerCase();
        if (lower.includes('rush')) {
          return {
            text: JSON.stringify({
              action: 'rush',
              echo: 'Triggering rush wave',
            }),
            tokensIn: 30,
            tokensOut: 10,
          };
        }
        return {
          text: JSON.stringify({
            action: 'refuse',
            refuse: 'Refused unrecognized command',
          }),
          tokensIn: 30,
          tokensOut: 10,
        };
      },
    };

    const den1 = await createSiteServer({
      siteId: 'den-1',
      seed: 101,
      initialAgents: 8,
      enableIntervals: true,
      tickIntervalMs: 50,
      ticketSecret: SHARED_TICKET_SECRET,
      brainClient,
      armorClient,
      nlParser: parserClient,
    });
    siteServers.push(den1);
    const den1HttpUrl = await den1.app.listen({ port: 0, host: '127.0.0.1' });
    const den1WsUrl = den1HttpUrl.replace(/^http/, 'ws') + '/ws';

    const slc2 = await createSiteServer({
      siteId: 'slc-2',
      seed: 202,
      initialAgents: 8,
      enableIntervals: true,
      tickIntervalMs: 50,
      ticketSecret: SHARED_TICKET_SECRET,
      brainClient,
      armorClient,
      nlParser: parserClient,
    });
    siteServers.push(slc2);
    const slc2HttpUrl = await slc2.app.listen({ port: 0, host: '127.0.0.1' });
    const slc2WsUrl = slc2HttpUrl.replace(/^http/, 'ws') + '/ws';

    const lobbyStore = new InMemoryLobbyStore([
      {
        id: 'den-1',
        state: 'live',
        phase: 'running',
        drivers: 0,
        spectators: 0,
        tier: 0,
        shipped: 0,
        wsUrl: den1WsUrl,
        updatedAt: Date.now(),
      },
      {
        id: 'slc-2',
        state: 'break',
        phase: 'break',
        drivers: 0,
        spectators: 0,
        tier: 0,
        shipped: 0,
        wsUrl: slc2WsUrl,
        updatedAt: Date.now(),
      },
    ]);

    const lobbyApp = await buildLobbyServer({
      store: lobbyStore,
      ticketSecret: SHARED_TICKET_SECRET,
      rateLimitPerMin: 200,
      armorClient: {
        async sanitizeUserPrompt(text: string) {
          return armorClient.sanitizeUserPrompt(text);
        },
        async sanitizeModelResponse(text: string) {
          return armorClient.sanitizeModelResponse(text);
        },
      },
    });
    closeLobby = async () => {
      await lobbyApp.close();
    };
    const lobbyUrl = await lobbyApp.listen({ port: 0, host: '127.0.0.1' });

    return { lobbyUrl, den1HttpUrl, slc2HttpUrl };
  }

  it('runs both live smoke and armor smoke end-to-end in < 3s', async () => {
    const startMs = Date.now();
    const { lobbyUrl } = await bootCluster();

    const liveReport = await runLiveSmoke({
      lobbyUrl,
      driveDurationMs: 250,
      inputIntervalMs: 40,
      secondarySiteId: 'slc-2',
      cleanupFirestore: false,
      silent: true,
    });

    expect(liveReport.errors).toEqual([]);
    expect(liveReport.ok).toBe(true);
    expect(liveReport.lobbyHealthOk).toBe(true);
    expect(liveReport.joinedSiteId).toBe('den-1');
    expect(liveReport.secondarySiteId).toBe('slc-2');
    expect(liveReport.welcomeReceived).toBe(true);
    expect(liveReport.acksReceived).toBeGreaterThan(0);
    expect(liveReport.deltasReceived).toBeGreaterThan(0);
    expect(liveReport.brainModel).toBe('gemini-3.5-flash-lite');
    expect(liveReport.transferVerified).toBe(true);

    const armorReport = await runArmorSmoke({
      lobbyUrl,
      cleanupFirestore: false,
      silent: true,
    });

    expect(armorReport.errors).toEqual([]);
    expect(armorReport.ok).toBe(true);
    expect(armorReport.results.length).toBe(ADVERSARIAL_INJECTIONS.length + 1);
    const advResults = armorReport.results.filter((r) => r.isAdversarial);
    expect(advResults.length).toBe(ADVERSARIAL_INJECTIONS.length);
    expect(advResults.every((r) => r.passed && r.refused && !r.executed)).toBe(true);
    expect(armorReport.journalVerified).toBe(true);
    expect(armorReport.journalArmorEntriesCount).toBeGreaterThan(0);

    const elapsedMs = Date.now() - startMs;
    expect(elapsedMs).toBeLessThan(3000);
  });
});
