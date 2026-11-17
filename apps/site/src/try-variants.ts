/**
 * Side-by-side Brain Variant Lab (`npm run brain:variants -w @warehouse/site`).
 *
 * Spins up an identical warehouse floor scenario (4 simultaneous AI requests across
 * `contract`, `Batcher` 2-slot `contract`, `hazard`, and `tactics` + human rival target +
 * nearly-full 7/8 trailer) and executes all 4 variants:
 *   1. `vertex-flash`    — Per-agent Vertex AI `gemini-3.5-flash-lite`
 *   2. `decisions`       — Per-agent `gemini-decision-1` (`POST /v1beta/decisions`)
 *   3. `decisions-batch` — Tick-batched `gemini-decision-1` (1 HTTP call for all 4 trucks)
 *   4. `hybrid`          — `gemini-decision-1` Chooser + Confidence Cascade to `gemini-3.5-flash-lite`
 *
 * Pass `--live` to hit live Vertex AI (ADC) and/or Gemini Decisions API (`GEMINI_API_KEY`).
 * Without `--live`, runs deterministically offline using calibrated reference transports so
 * you can inspect exact prompts, question schemas, HUD pill strings, and cost math immediately.
 */
import type { Decisions } from '@google/genai';
import {
  createWorld,
  emitContractRequestIfNeeded,
  emitHazardRequestIfNeeded,
  emitTacticsRequest,
  postOrder,
  spawnPlayerVehicle,
  spawnSpill,
  type World,
} from '@warehouse/sim';
import {
  AgentBrainScheduler,
  VertexGeminiBrainClient,
  type BrainDecisionBroadcast,
  type BrainModelClient,
  type BrainVariant,
  type DecisionsApiTransport,
} from './brain.js';
import {
  estimateModelCallCostUsd,
  InMemoryPersistenceStore,
} from './persistence.js';

class OfflineReferenceDecisionsTransport implements DecisionsApiTransport {
  public httpCalls = 0;

  async create(params: Decisions.CreateDecisionRequest): Promise<Decisions.CreateDecisionResponse> {
    this.httpCalls++;
    const answers: NonNullable<Decisions.CreateDecisionResponse['answers']> = {};
    for (const [key, q] of Object.entries(params.questions)) {
      if (q.type === 'choice') {
        const entries = Object.entries(q.criteria);
        // Score candidates heuristically from their factual description so offline runs pick realistically
        const scored = entries.map(([optKey, desc]) => {
          let w = 1;
          if (/p0=1/.test(desc)) w += 3;
          if (/rivalTarget=1/.test(desc)) w += 1.5;
          if (/fill=7\/8/.test(desc)) w += 2.5;
          if (/Choice reroute/.test(desc)) w += 2.5;
          return { optKey, w };
        });
        const sum = scored.reduce((a, b) => a + b.w, 0);
        scored.sort((a, b) => b.w - a.w);
        const probabilities = Object.fromEntries(
          scored.map((s) => [s.optKey, Number((s.w / sum).toFixed(4))]),
        );
        const top = scored[0]!;
        const topProb = probabilities[top.optKey] ?? 0.5;
        answers[key] = {
          type: 'choice',
          choice: top.optKey,
          probabilities,
          confidence: topProb,
        };
      } else if (q.type === 'noul') {
        answers[key] = { type: 'noul', noul: 0.84, confidence: 0.84 };
      } else if (q.type === 'score') {
        const mid = Math.min(q.criteria.length - 1, 2);
        const legend: Record<string, string> = {};
        const probabilities: Record<string, number> = {};
        q.criteria.forEach((c, i) => {
          legend[String(i)] = c;
          probabilities[String(i)] = i === mid ? 0.78 : 0.22 / Math.max(1, q.criteria.length - 1);
        });
        answers[key] = { type: 'score', score: mid + 0.2, legend, probabilities, confidence: 0.78 };
      }
    }
    const chars =
      (typeof params.input === 'string' ? params.input.length : JSON.stringify(params.input).length) +
      JSON.stringify(params.questions).length;
    const tokens = Math.round(chars / 4);
    return {
      answers,
      usage: { total_input_tokens: tokens, total_output_tokens: 0, total_tokens: tokens },
    };
  }
}

class OfflineReferenceFlashClient implements BrainModelClient {
  public httpCalls = 0;

  async generateDecision(params: Parameters<BrainModelClient['generateDecision']>[0]) {
    this.httpCalls++;
    const tokensIn = Math.round((params.systemInstruction.length + params.prompt.length) / 4) + 55;
    const tokensOut = 28;
    const req = params.req;
    if (params.kind === 'hazard') {
      return {
        text: JSON.stringify({ choice: 'reroute', reason: 'Safe detour around spill' }),
        tokensIn,
        tokensOut,
        model: 'gemini-3.5-flash-lite',
      };
    }
    if (params.kind === 'tactics') {
      return {
        text: JSON.stringify({
          speed: 1.15,
          buffer: 2,
          respect: 0.85,
          chargeAt: 22,
          batch: 1,
          note: 'Balanced pace for P0 wave',
        }),
        tokensIn,
        tokensOut,
        model: 'gemini-3.5-flash-lite',
      };
    }
    const opts = (req?.options ?? []) as Array<{ orderId?: number; bay?: string }>;
    const pickIds =
      req?.context.capacity && req.context.capacity >= 2 && opts.length >= 2 && opts[0]?.bay === opts[1]?.bay
        ? [String(opts[0]!.orderId), String(opts[1]!.orderId)]
        : [String(opts[0]?.orderId ?? 1001)];
    return {
      text: JSON.stringify({ orderIds: pickIds, reason: 'Close 7/8 E1 trailer + P0' }),
      tokensIn,
      tokensOut,
      model: 'gemini-3.5-flash-lite',
    };
  }
}

function buildScenarioWorld(): World {
  const w = createWorld({ siteId: 'den-1', seed: 4242, agents: 10 });
  w.pendingDecisions.length = 0;
  for (const v of w.vehicles) {
    v.battery = 90;
    v.state = 'idle';
    v.orders = [];
    v.cargo = [];
  }
  w.orders = [];

  const e1 = w.bays.find((b) => b.id === 'E1')!;
  e1.load = e1.cap - 1; // 7/8 nearly full -> Trailer Closer!

  const o1 = postOrder(w, { zone: 'A', bayId: 'E1', p0: true, force: true })!;
  postOrder(w, { zone: 'B', bayId: 'E1', force: true });
  postOrder(w, { zone: 'W', bayId: 'E2', force: true });

  const human = spawnPlayerVehicle(w, 'lab-driver', 'Turbo-Badger-42', 'blitz')!;
  const sprinter = w.vehicles.find((v) => v.strategy === 'Sprinter')!;
  const batcher = w.vehicles.find((v) => v.strategy === 'Batcher')!;
  const steady = w.vehicles.find((v) => v.strategy === 'Steady')!;
  const strategist = w.vehicles.find((v) => v.strategy === 'Strategist')!;

  human.rivalId = sprinter.id;
  human.orders = [o1];

  emitContractRequestIfNeeded(w, sprinter);
  emitContractRequestIfNeeded(w, batcher);
  const spill = spawnSpill(w, { x: 10, y: 10 })!;
  emitHazardRequestIfNeeded(w, steady, spill);
  emitTacticsRequest(w, strategist);

  return w;
}

async function runVariant(variant: BrainVariant, live: boolean) {
  const w = buildScenarioWorld();
  const persistence = new InMemoryPersistenceStore();
  const broadcasts: BrainDecisionBroadcast[] = [];
  const offlineDecisions = new OfflineReferenceDecisionsTransport();
  const offlineFlash = new OfflineReferenceFlashClient();

  const hasApiKey = Boolean(
    process.env.GEMINI_DECISIONS_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  );

  if (live && variant !== 'vertex-flash' && !hasApiKey) {
    return {
      variant,
      skipped: 'Set GEMINI_API_KEY to run live Decisions API variants',
    };
  }

  let scheduler: AgentBrainScheduler;
  if (live) {
    scheduler = new AgentBrainScheduler({
      siteId: 'den-1',
      variant,
      persistence,
      onDecisionBroadcast: (m) => broadcasts.push(m),
    });
  } else if (variant === 'vertex-flash') {
    scheduler = new AgentBrainScheduler({
      siteId: 'den-1',
      variant: 'vertex-flash',
      client: offlineFlash,
      persistence,
      onDecisionBroadcast: (m) => broadcasts.push(m),
    });
  } else if (variant === 'hybrid') {
    const { GeminiDecisionsBatchClient, HybridBrainClient } = await import('./brain.js');
    const hybrid = new HybridBrainClient({
      chooser: new GeminiDecisionsBatchClient({ transport: offlineDecisions }),
      planner: offlineFlash,
      confidenceThreshold: 0.45,
    });
    scheduler = new AgentBrainScheduler({
      siteId: 'den-1',
      variant: 'hybrid',
      client: hybrid,
      persistence,
      onDecisionBroadcast: (m) => broadcasts.push(m),
    });
    // Use hybrid batch path directly in offline mode
    (scheduler as unknown as { hybridClient: unknown }).hybridClient = hybrid;
  } else {
    scheduler = new AgentBrainScheduler({
      siteId: 'den-1',
      variant,
      decisionsTransport: offlineDecisions,
      persistence,
      onDecisionBroadcast: (m) => broadcasts.push(m),
    });
  }

  const t0 = Date.now();
  await scheduler.drainQueue(w, t0, [], { wait: true });
  const wallMs = Math.max(1, Date.now() - t0);
  const budget = await persistence.getBudget(t0);
  const httpCalls = live
    ? budget.agentCalls
    : offlineDecisions.httpCalls + offlineFlash.httpCalls;

  const totalCost = broadcasts.reduce(
    (sum, b) => sum + estimateModelCallCostUsd(b.model, b.tokensIn, b.tokensOut),
    0,
  );

  const health = scheduler.getBrainHealth(Date.now());
  return {
    variant,
    activeModel: health.model,
    standbyReason: health.decisionsStandbyReason,
    httpCalls,
    wallMs,
    tokensIn: budget.agentTokensIn,
    tokensOut: budget.agentTokensOut,
    costPer1kTicksUsd: Number((totalCost * 1000).toFixed(4)),
    decisions: broadcasts.map((b) => ({
      vid: b.vid,
      kind: b.kind,
      output: (b.decision.output as string | undefined) ?? JSON.stringify(b.decision),
      confidence: b.confidence !== undefined ? `${Math.round(b.confidence * 100)}%` : 'n/a',
      model: b.model,
    })),
  };
}

async function main() {
  const live = process.argv.includes('--live');
  // Suppress unused import lint while keeping VertexGeminiBrainClient linked for live runs
  void VertexGeminiBrainClient;

  console.log(
    `\n=== Freightfloor Brain Variant Lab (${live ? 'LIVE API MODE' : 'OFFLINE CALIBRATED LAB — pass --live for cloud calls'}) ===\n`,
  );

  const variants: BrainVariant[] = ['vertex-flash', 'decisions', 'decisions-batch', 'hybrid'];
  for (const v of variants) {
    const res = await runVariant(v, live);
    if ('skipped' in res) {
      console.log(`[${res.variant}] SKIPPED — ${res.skipped}\n`);
      continue;
    }
    const standbyNote = res.standbyReason ? ` | standby=${res.activeModel} (${res.standbyReason})` : '';
    console.log(
      `[${res.variant}] HTTP calls=${res.httpCalls} | tokensIn=${res.tokensIn} tokensOut=${res.tokensOut} | est $/1k ticks=$${res.costPer1kTicksUsd}${standbyNote}`,
    );
    for (const d of res.decisions) {
      console.log(
        `   • ${d.vid} (${d.kind}) -> ${d.output} | conf=${d.confidence} | model=${d.model}`,
      );
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
