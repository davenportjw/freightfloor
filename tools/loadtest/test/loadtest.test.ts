import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SITE_IDS, type SiteId } from '@warehouse/protocol';
import { inspectPromptLocally, type ModelArmorClient } from '@warehouse/armor';
import {
  buildLobbyServer,
  type LobbyStore,
  type StoredPlayerDoc,
  type StoredSiteDoc,
} from '@warehouse/lobby';
import { createSiteServer, type SiteServerInstance } from '@warehouse/site';
import {
  LOADTEST_VERSION,
  computeSteeringControls,
  evaluatePassCriteria,
  runLoadtest,
  runLoadtestTeardown,
  GeminiPilotAgent,
  PilotBudgetTracker,
  type PilotHudContext,
  type PilotModelClient,
  type TeardownStore,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('@warehouse/loadtest — 128-client full-flow load & Gemini pilot harness', () => {
  const ticketSecret = 'loadtest-hmac-secret-key-2026-verified-32bytes';
  const sites = new Map<SiteId, { instance: SiteServerInstance; wsUrl: string }>();
  let lobbyServer: Awaited<ReturnType<typeof buildLobbyServer>>;
  let lobbyUrl = '';

  const localArmorClient: ModelArmorClient = {
    async sanitizeUserPrompt(text: string) {
      return inspectPromptLocally(text);
    },
    async sanitizeModelResponse(text: string) {
      return inspectPromptLocally(text);
    },
  };

  beforeAll(async () => {
    for (let i = 0; i < SITE_IDS.length; i++) {
      const siteId = SITE_IDS[i]!;
      const instance = await createSiteServer({
        siteId,
        seed: 2026 + i,
        initialAgents: 4,
        enableIntervals: false,
        ticketSecret,
        brainClient: {
          async generateDecision() {
            return {
              text: JSON.stringify({
                assignments: [{ agent: 'A1', order: 1, reason: 'steady dispatch' }],
                ops: [],
              }),
              tokensIn: 120,
              tokensOut: 40,
            };
          },
        },
        armorClient: localArmorClient,
        nlParser: {
          async parseOrder({ userPrompt }: { systemInstruction: string; userPrompt: string }) {
            return {
              text: JSON.stringify({
                action: 'createOrder',
                sku: 'Water',
                bay: 'E2',
                priority: userPrompt.toLowerCase().includes('urgent') ? 'P0' : 'normal',
                quantity: 1,
                note: 'Parsed pilot NL order',
              }),
              tokensIn: 80,
              tokensOut: 30,
            };
          },
        },
      });
      await instance.app.listen({ port: 0, host: '127.0.0.1' });
      const addr = instance.app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const wsUrl = `ws://127.0.0.1:${port}/ws`;
      sites.set(siteId, { instance, wsUrl });
    }

    // Live LobbyStore reading active driver & spectator counts from the 4 site shards
    const liveStore: LobbyStore = {
      async getSites(): Promise<StoredSiteDoc[]> {
        const now = Date.now();
        return SITE_IDS.map((id) => {
          const entry = sites.get(id)!;
          let drivers = 0;
          let spectators = 0;
          for (const c of entry.instance.clients) {
            if (!c.authenticated) continue;
            if (c.role === 'driver' && c.vid !== null) {
              drivers++;
            } else {
              spectators++;
            }
          }
          return {
            id,
            state: 'online',
            phase: entry.instance.world.phase,
            drivers,
            spectators,
            tier: entry.instance.world.UnlockedTier ?? 0,
            shipped: entry.instance.world.shipped ?? 0,
            wsUrl: entry.wsUrl,
            updatedAt: now,
          };
        });
      },
      async getTopPlayers(): Promise<StoredPlayerDoc[]> {
        return [];
      },
    };

    lobbyServer = await buildLobbyServer({
      store: liveStore,
      ticketSecret,
      armorClient: localArmorClient,
      rateLimitPerMin: 2000,
    });
    await lobbyServer.listen({ port: 0, host: '127.0.0.1' });
    const lAddr = lobbyServer.server.address();
    const lPort = typeof lAddr === 'object' && lAddr ? lAddr.port : 0;
    lobbyUrl = `http://127.0.0.1:${lPort}`;
  });

  afterAll(async () => {
    if (lobbyServer) await lobbyServer.close();
    for (const { instance } of sites.values()) {
      await instance.close();
    }
  });

  it('maintains strict full-flow isolation (zero imports of @warehouse/sim in tools/loadtest/src)', () => {
    expect(LOADTEST_VERSION).toBe(1);
    const srcDir = join(__dirname, '..', 'src');
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const content = readFileSync(join(srcDir, file), 'utf8');
      expect(content).not.toContain('@warehouse/sim');
    }
  });

  it('computes highway-aware steering waypoints and reverse-unstick controls purely client-side', () => {
    const steer = computeSteeringControls({
      vx: 10,
      vy: 11.5,
      angle: 0,
      speedNow: 2,
      targetX: 30,
      targetY: 11,
      stuckTicks: 0,
    });
    expect(steer.controls.up).toBe(true);
    expect(steer.controls.down).toBe(false);

    const unstuck = computeSteeringControls({
      vx: 10,
      vy: 11.5,
      angle: 0,
      speedNow: 0.01,
      targetX: 30,
      targetY: 11,
      stuckTicks: 4,
    });
    expect(unstuck.controls.down).toBe(true);
  });

  it('connects 128 clients (112 protocol bots + 16 Gemini pilots) across 4 shards with 32 drivers per shard', async () => {
    let planCallCount = 0;
    const testPilotModelClient: PilotModelClient = {
      async generatePlan(hud: PilotHudContext) {
        planCallCount++;
        const firstOrder = hud.topOpenOrders[0];
        if (planCallCount % 8 === 0) {
          return {
            text: JSON.stringify({
              action: 'typeOrder',
              text: 'Urgent pallet to E2',
              reason: 'Create high-value P0 order',
            }),
            tokensIn: 110,
            tokensOut: 35,
          };
        }
        if (planCallCount % 9 === 0) {
          return {
            text: JSON.stringify({
              action: 'vote',
              level: 'normal',
              reason: 'Maintain balanced throughput',
            }),
            tokensIn: 100,
            tokensOut: 30,
          };
        }
        return {
          text: JSON.stringify({
            action: 'deliverOrder',
            orderId: String(firstOrder?.id ?? '1'),
            pickupX: firstOrder?.pickupX ?? 12,
            pickupY: firstOrder?.pickupY ?? 11,
            dropX: firstOrder?.dropX ?? 58,
            dropY: firstOrder?.dropY ?? 15,
            reason: 'Deliver nearest open order',
          }),
          tokensIn: 140,
          tokensOut: 45,
        };
      },
    };

    // Step the 4 site worlds at 10 Hz during the loadtest window
    const tickSamplesMs: number[] = [];
    const tickTimer = setInterval(() => {
      for (const { instance } of sites.values()) {
        const t0 = performance.now();
        void instance.stepTick(Date.now());
        tickSamplesMs.push(performance.now() - t0);
      }
    }, 100);

    try {
      const report = await runLoadtest({
        lobbyUrl,
        protocolBotsCount: 112,
        pilotAgentsCount: 16,
        durationMs: 220,
        inputIntervalMs: 80,
        planIntervalMs: 180,
        joinConcurrency: 1,
        pilotModelClient: testPilotModelClient,
        siteTickSamplesMs: tickSamplesMs,
        requirePilotDeliveries: false,
      });

      expect(report.totalClients).toBe(128);
      expect(report.driversPerSite).toEqual({
        'den-1': 32,
        'slc-2': 32,
        'phx-3': 32,
        'abq-4': 32,
      });
      expect(report.unexpectedDisconnects).toBe(0);
      expect(report.ackRttP95Ms).toBeLessThan(250);
      expect(report.siteTickP95Ms).toBeLessThan(40);
      expect(report.avgDeltaKbPerSec).toBeLessThan(6);
      expect(report.pilotErrorsTotal).toBe(0);
      expect(report.pilotBudgetSpentUsd).toBeGreaterThan(0);
      expect(report.evaluation.ok).toBe(true);
    } finally {
      clearInterval(tickTimer);
    }
  });

  it('enforces strict no-mock error holding when Gemini pilot fails or exhausts budget', async () => {
    const failingModelClient: PilotModelClient = {
      async generatePlan() {
        throw new Error('Vertex AI transient quota error');
      },
    };

    const pilot = new GeminiPilotAgent({
      pilotIndex: 99,
      lobbyUrl,
      inputIntervalMs: 50,
      planIntervalMs: 1000,
      modelClient: failingModelClient,
    });

    await pilot.start();
    await new Promise((r) => setTimeout(r, 120));
    await pilot.stop();

    expect(pilot.metrics.pilotErrors).toBeGreaterThanOrEqual(1);
    expect(pilot.metrics.holdingPositionOnError).toBe(true);
    expect(pilot.metrics.plansSucceeded).toBe(0);

    // Also test budget exhaustion ($0.00 cap)
    const zeroBudget = new PilotBudgetTracker(0);
    const budgetPilot = new GeminiPilotAgent({
      pilotIndex: 98,
      lobbyUrl,
      inputIntervalMs: 50,
      planIntervalMs: 1000,
      budgetTracker: zeroBudget,
      modelClient: {
        async generatePlan() {
          return {
            text: JSON.stringify({
              action: ' vote',
              level: 'normal',
              reason: 'never reached',
            }),
            tokensIn: 10,
            tokensOut: 10,
          };
        },
      },
    });

    await budgetPilot.start();
    await new Promise((r) => setTimeout(r, 80));
    await budgetPilot.stop();

    expect(budgetPilot.metrics.pilotErrors).toBeGreaterThanOrEqual(1);
    expect(budgetPilot.metrics.holdingPositionOnError).toBe(true);
  });

  it('cleans up loadtest-*, pilot-*, and smoke-* player docs while preserving real human players', async () => {
    const players = new Map<string, { id: string; name?: string; clientId?: string }>([
      ['loadtest-001-abc', { id: 'loadtest-001-abc', name: 'loadtest-001' }],
      ['pilot-04-xyz', { id: 'pilot-04-xyz', name: 'pilot-04' }],
      ['smoke-probe-1', { id: 'smoke-probe-1', name: 'smoke-driver' }],
      ['human-1', { id: 'human-1', name: 'AlexForklift' }],
    ]);
    let resetCalls = 0;

    const customStore: TeardownStore = {
      async listPlayers() {
        return Array.from(players.values());
      },
      async deletePlayers(ids: string[]) {
        for (const id of ids) {
          players.delete(id);
        }
      },
      async resetSiteSnapshots(siteIds: readonly string[]) {
        resetCalls = siteIds.length;
        return resetCalls;
      },
    };

    const report = await runLoadtestTeardown({ customStore });
    expect(report.deletedPlayerDocs).toBe(3);
    expect(report.resetSnapshotDocs).toBe(4);
    expect(players.size).toBe(1);
    expect(players.has('human-1')).toBe(true);

    const evalFail = evaluatePassCriteria({
      driversPerSite: { 'den-1': 33, 'slc-2': 32, 'phx-3': 32, 'abq-4': 31 },
      siteTickP95Ms: 45,
      ackRttP95Ms: 300,
      avgDeltaKbPerSec: 7.5,
      unexpectedDisconnects: 1,
      pilotsWithDelivery: 8,
      totalPilots: 16,
      requirePilotDeliveries: true,
      armorLimitBypasses: 1,
    });
    expect(evalFail.ok).toBe(false);
    expect(evalFail.failures.length).toBe(7);
  });
});
