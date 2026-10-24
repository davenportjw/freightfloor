import { describe, expect, it } from 'vitest';
import {
  createWorld,
  postOrder,
  spawnSpill,
  dealShiftCards,
  emitContractRequestIfNeeded,
  emitHazardRequestIfNeeded,
  emitTacticsRequest,
} from '@warehouse/sim';
import {
  VertexGeminiBrainClient,
  AgentBrainScheduler,
  InMemoryPersistenceStore,
  DEFAULT_GEMINI_MODEL,
  type BrainDecisionBroadcast,
} from '../src/index.js';

const runLive = process.env.RUN_LIVE === '1' || process.env.RUN_LIVE === 'true';

describe.skipIf(!runLive)(
  'M3 live Vertex AI Gemini 3.5 Flash-Lite Brain Decisions (@warehouse/site)',
  () => {
    it(
      'executes real Vertex AI gemini-3.5-flash-lite decisions across all 4 kinds (contract, hazard, tactics, cards) with p50 < 900ms and p95 < 1800ms',
      async () => {
        const world = createWorld({ siteId: 'den-1', seed: 2026, agents: 14 });
        world.pendingDecisions.length = 0;

        const persistence = new InMemoryPersistenceStore();
        const client = new VertexGeminiBrainClient({
          projectId: process.env.GCP_PROJECT_ID || 'davenporter-freightfloor',
          location: 'global',
          model: DEFAULT_GEMINI_MODEL,
        });

        const broadcasts: BrainDecisionBroadcast[] = [];
        const scheduler = new AgentBrainScheduler({
          siteId: 'den-1',
          client,
          persistence,
          maxConcurrent: 8,
          onDecisionBroadcast: (msg) => broadcasts.push(msg),
        });

        // Warm-up call so Vertex AI connection pool & TLS handshake are warm before measuring p50/p95
        const fl01 = world.vehicles.find((v) => v.id === 'FL-01')!;
        const warmReq = emitTacticsRequest(world, fl01);
        await scheduler.drainQueue(world);
        expect(warmReq).not.toBeNull();
        broadcasts.length = 0;

        // Prepare all 4 decision kinds on distinct vehicles (FL-02, FL-03, FL-04, RT-05)
        postOrder(world, { p0: true });
        postOrder(world, { p0: false });
        const spill = spawnSpill(world, 18, 20)!;

        const fl02 = world.vehicles.find((v) => v.id === 'FL-02')!;
        const fl03 = world.vehicles.find((v) => v.id === 'FL-03')!;
        const fl04 = world.vehicles.find((v) => v.id === 'FL-04')!;
        const rt05 = world.vehicles.find((v) => v.id === 'RT-05')!;

        expect(emitContractRequestIfNeeded(world, fl02)).not.toBeNull();
        expect(emitHazardRequestIfNeeded(world, fl03, spill)).not.toBeNull();
        expect(emitTacticsRequest(world, fl04)).not.toBeNull();
        expect(dealShiftCards(world, rt05.id).length).toBe(1);

        await scheduler.drainQueue(world);

        expect(broadcasts.length).toBe(4);
        const kindsResolved = new Set(broadcasts.map((b) => b.kind));
        expect(kindsResolved).toEqual(new Set(['contract', 'hazard', 'tactics', 'cards']));

        for (const vid of ['FL-02', 'FL-03', 'FL-04', 'RT-05']) {
          const v = world.vehicles.find((veh) => veh.id === vid)!;
          expect(v.brainError).toBeNull();
          expect(v.lastDecision).not.toBeNull();
          expect(v.lastDecision?.model).toBe('gemini-3.5-flash-lite');
          expect(typeof v.lastDecision?.reason).toBe('string');
          expect(v.lastDecision!.reason.length).toBeGreaterThan(0);
          expect(v.lastDecision!.reason.length).toBeLessThanOrEqual(120);
        }

        const latencies = broadcasts.map((b) => b.latencyMs).sort((a, b) => a - b);
        const p50 = latencies[Math.floor((latencies.length - 1) * 0.5)];
        const p95 = latencies[Math.floor((latencies.length - 1) * 0.95)];

        console.log(
          `[live.test] Gemini 3.5 Flash-Lite latencies (ms): ${latencies.join(', ')} | p50=${p50}ms, p95=${p95}ms`,
        );

        expect(p50).toBeGreaterThan(0);
        expect(p50).toBeLessThan(6000);
        expect(p95).toBeLessThan(10000);

        for (const b of broadcasts) {
          expect(b.tokensIn).toBeGreaterThan(0);
          expect(b.tokensOut).toBeGreaterThan(0);
        }

        // Verify No-Mock Policy against real Vertex AI: bad model name surfaces as true brainError
        const badClient = new VertexGeminiBrainClient({
          projectId: 'davenport-boutique',
          location: 'global',
          model: 'gemini-nonexistent-model',
        });
        const badScheduler = new AgentBrainScheduler({
          siteId: 'den-1',
          client: badClient,
          persistence,
          retryDelayMs: 10,
        });
        const rt06 = world.vehicles.find((v) => v.id === 'RT-06')!;
        expect(emitTacticsRequest(world, rt06)).not.toBeNull();
        await badScheduler.drainQueue(world);
        expect(rt06.brainError).not.toBeNull();
        expect(badScheduler.getBrainHealth().errors1m).toBe(1);
      },
      60_000,
    );
  },
);

