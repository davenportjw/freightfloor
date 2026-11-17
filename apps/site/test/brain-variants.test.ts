import { describe, expect, it } from 'vitest';
import type { Decisions } from '@google/genai';
import {
  BrainDecisionMessageSchema,
  GEMINI_DECISION_MODEL,
  ServerMessageSchema,
  VehicleDecisionSchema,
} from '@warehouse/protocol';
import {
  BLITZ_DURATION_MIN,
  createWorld,
  dealShiftCards,
  detectDispatchersCallSituation,
  emitContractRequestIfNeeded,
  emitHazardRequestIfNeeded,
  emitTacticsRequest,
  postOrder,
  spawnPlayerVehicle,
  spawnSpill,
  startBlitzClock,
} from '@warehouse/sim';
import {
  AgentBrainScheduler,
  GeminiDecisionsBatchClient,
  GeminiDecisionsBrainClient,
  HybridBrainClient,
  PERSONA_RUBRICS,
  PERSONA_SYSTEM_INSTRUCTIONS,
  probeDecisionsAdcSupport,
  renderDecisionPrompt,
  resolveBrainVariant,
  SdkDecisionsApiTransport,
  setDecisionsAdcProbeResultForTesting,
  startDailyDecisionsAdcMonitor,
  type BrainDecisionBroadcast,
  type BrainModelClient,
  type DecisionsApiTransport,
} from '../src/brain.js';
import {
  buildDispatchersCallCandidates,
  buildDispatchersCallTelemetry,
  DecisionsDispatchersCallClient,
  DispatchersCallCoordinator,
  type DispatchersCallOffer,
} from '../src/dispatchersCall.js';
import {
  estimateGeminiDecisionCostUsd,
  estimateModelCallCostUsd,
  InMemoryPersistenceStore,
} from '../src/persistence.js';

/**
 * Deterministic test-only transport implementing the exact `@google/genai` Decisions API
 * wire shape (`noul`, `choice`, `score` answers + `usage.total_input_tokens`).
 */
class DeterministicDecisionsTransport implements DecisionsApiTransport {
  public calls: Decisions.CreateDecisionRequest[] = [];
  private readonly overrideConfidence?: number;

  constructor(opts?: { confidence?: number }) {
    this.overrideConfidence = opts?.confidence;
  }

  async create(params: Decisions.CreateDecisionRequest): Promise<Decisions.CreateDecisionResponse> {
    this.calls.push(params);
    const answers: NonNullable<Decisions.CreateDecisionResponse['answers']> = {};

    for (const [key, q] of Object.entries(params.questions)) {
      if (q.type === 'choice') {
        const optionKeys = Object.keys(q.criteria).sort();
        const winner = optionKeys[0]!;
        const winConf = this.overrideConfidence ?? 0.86;
        const rest = optionKeys.length > 1 ? (1 - winConf) / (optionKeys.length - 1) : 0;
        const probabilities: Record<string, number> = {};
        for (const k of optionKeys) {
          probabilities[k] = k === winner ? winConf : Number(rest.toFixed(4));
        }
        answers[key] = {
          type: 'choice',
          choice: winner,
          probabilities,
          confidence: winConf,
        };
      } else if (q.type === 'noul') {
        const pYes = key.endsWith('_batch') ? 0.82 : 0.78;
        const conf = this.overrideConfidence ?? Math.max(pYes, 1 - pYes);
        answers[key] = {
          type: 'noul',
          noul: pYes,
          confidence: conf,
        };
      } else if (q.type === 'score') {
        const levels = q.criteria.length;
        const midIdx = Math.min(levels - 1, Math.floor(levels / 2));
        const legend: Record<string, string> = {};
        const probabilities: Record<string, number> = {};
        q.criteria.forEach((desc, idx) => {
          legend[String(idx)] = desc;
          probabilities[String(idx)] = idx === midIdx ? 0.8 : 0.2 / Math.max(1, levels - 1);
        });
        answers[key] = {
          type: 'score',
          score: midIdx + 0.15,
          legend,
          probabilities,
          confidence: this.overrideConfidence ?? 0.8,
        };
      }
    }

    const inputChars =
      typeof params.input === 'string' ? params.input.length : JSON.stringify(params.input).length;
    const estTokens = Math.max(80, Math.round((inputChars + JSON.stringify(params.questions).length) / 4));

    return {
      answers,
      usage: {
        total_input_tokens: estTokens,
        total_output_tokens: 0,
        total_tokens: estTokens,
      },
    };
  }
}

describe('Brain Variants: vertex-flash, decisions, decisions-batch, and hybrid', () => {
  it('defaults to decisions-batch when API key exception or ADC is active, else falls back to vertex-flash (gemini-3.5-flash-lite)', () => {
    setDecisionsAdcProbeResultForTesting(null);
    expect(resolveBrainVariant(undefined, {})).toBe('vertex-flash');
    expect(resolveBrainVariant('auto', {})).toBe('vertex-flash');
    expect(resolveBrainVariant(undefined, { GEMINI_DECISIONS_API_KEY: 'test-key' })).toBe(
      'decisions-batch',
    );
    expect(resolveBrainVariant('auto', { GEMINI_API_KEY: 'test-key' })).toBe('decisions-batch');
    expect(resolveBrainVariant('decisions', {})).toBe('decisions');
    expect(resolveBrainVariant('HYBRID', {})).toBe('hybrid');
    expect(() => resolveBrainVariant('unknown-mode', {})).toThrow(/BRAIN_VARIANT/);

    expect(estimateGeminiDecisionCostUsd(1_000_000)).toBeCloseTo(0.1, 6);
    expect(estimateModelCallCostUsd('gemini-decision-1', 500_000, 999)).toBeCloseTo(0.05, 6);
    expect(estimateModelCallCostUsd('gemini-3.5-flash-lite', 1_000_000, 1_000_000)).toBeCloseTo(2.8, 5);
  });

  it('uses static per-archetype system instructions (without agentId) for prefix cache hits and enforces untrusted-text fence', () => {
    const w = createWorld({ siteId: 'den-1', seed: 9101, agents: 10 });
    w.pendingDecisions.length = 0;
    for (const v of w.vehicles) {
      v.battery = 90;
      v.state = 'idle';
      v.orders = [];
      v.cargo = [];
    }
    postOrder(w, { zone: 'A', bayId: 'E1', force: true });
    const sprinters = w.vehicles.filter((v) => !v.human && v.strategy === 'Sprinter');
    const sprinter1 = sprinters[0]!;
    const sprinter2 = sprinters[1] ?? sprinter1;
    spawnPlayerVehicle(w, 'evil-client', 'InjectedCallsign99', 'blitz');

    const req1 = emitContractRequestIfNeeded(w, sprinter1)!;
    const rendered1 = renderDecisionPrompt(w, req1);
    expect(rendered1.systemInstruction).toBe(PERSONA_SYSTEM_INSTRUCTIONS.Sprinter);
    expect(rendered1.systemInstruction).toContain(PERSONA_RUBRICS.Sprinter);
    expect(rendered1.systemInstruction).not.toContain(sprinter1.id);
    expect(rendered1.prompt).toContain(`Agent: ${sprinter1.id}`);
    expect(rendered1.prompt).toContain('bayFill=');
    expect(rendered1.prompt).not.toContain('InjectedCallsign99');

    if (sprinter2 !== sprinter1) {
      const req2 = emitContractRequestIfNeeded(w, sprinter2)!;
      const rendered2 = renderDecisionPrompt(w, req2);
      expect(rendered2.systemInstruction).toBe(rendered1.systemInstruction);
    }
  });

  it('Variant 2 (decisions): evaluates contract (including 2-pallet Batcher), hazard, cards, and tactics with calibrated confidence', async () => {
    const w = createWorld({ siteId: 'den-1', seed: 9202, agents: 10 });
    w.pendingDecisions.length = 0;
    for (const v of w.vehicles) {
      v.battery = 90;
      v.state = 'idle';
      v.orders = [];
      v.cargo = [];
    }
    const transport = new DeterministicDecisionsTransport();
    const persistence = new InMemoryPersistenceStore();
    const broadcasts: BrainDecisionBroadcast[] = [];

    const scheduler = new AgentBrainScheduler({
      siteId: 'den-1',
      variant: 'decisions',
      decisionsTransport: transport,
      persistence,
      onDecisionBroadcast: (msg) => broadcasts.push(msg),
    });

    // 1. Batcher 2-pallet same-bay contract
    const batcher = w.vehicles.find((v) => v.strategy === 'Batcher')!;
    batcher.tactics.batch = 2;
    w.orders = [];
    const o1 = postOrder(w, { zone: 'A', bayId: 'E1', p0: true, force: true })!;
    const o2 = postOrder(w, { zone: 'B', bayId: 'E1', force: true })!;
    postOrder(w, { zone: 'C', bayId: 'E2', force: true });
    const contractReq = emitContractRequestIfNeeded(w, batcher)!;
    expect(contractReq).toBeTruthy();

    // 2. Spill hazard
    const steady = w.vehicles.find((v) => v.strategy === 'Steady')!;
    const spill = spawnSpill(w, { x: 10, y: 10 })!;
    const hazardReq = emitHazardRequestIfNeeded(w, steady, spill)!;
    expect(hazardReq).toBeTruthy();

    // 3. Shift cards
    const sprinter = w.vehicles.find((v) => v.strategy === 'Sprinter')!;
    const cardReqs = dealShiftCards(w, sprinter.id);
    expect(cardReqs.length).toBeGreaterThanOrEqual(1);

    // 4. Strategist tactics
    const strategist = w.vehicles.find((v) => v.strategy === 'Strategist')!;
    const tacticsReq = emitTacticsRequest(w, strategist)!;
    expect(tacticsReq).toBeTruthy();

    w.pendingDecisions.length = 0;
    w.pendingDecisions.push(contractReq, hazardReq, cardReqs[0]!, tacticsReq);

    await scheduler.drainQueue(w, Date.now(), [], { wait: true });

    expect(transport.calls.length).toBe(4);
    expect(broadcasts.length).toBe(4);

    // Batcher paired both E1 orders in a single pass (choice + noul)
    expect(batcher.orders.map((o) => o.id).sort()).toEqual([o1.id, o2.id].sort());
    expect(batcher.lastDecision?.model).toBe(GEMINI_DECISION_MODEL);
    expect(batcher.lastDecision?.confidence).toBeCloseTo(0.86, 2);
    expect(batcher.lastDecision?.output).toContain('#');

    // Every broadcast validates against BrainDecisionMessageSchema & VehicleDecisionSchema
    for (const b of broadcasts) {
      expect(() => BrainDecisionMessageSchema.parse(b)).not.toThrow();
      expect(() => ServerMessageSchema.parse(b)).not.toThrow();
      expect(b.model).toBe(GEMINI_DECISION_MODEL);
      expect(b.tokensOut).toBe(0);
      expect(b.confidence).toBeGreaterThan(0.5);
    }
    const wireVehicleDec = {
      kind: batcher.lastDecision!.kind,
      model: batcher.lastDecision!.model,
      latencyMs: batcher.lastDecision!.latencyMs,
      reason: batcher.lastDecision!.reason,
      t: batcher.lastDecision!.t,
      output: batcher.lastDecision!.output,
      confidence: batcher.lastDecision!.confidence,
    };
    expect(() => VehicleDecisionSchema.parse(wireVehicleDec)).not.toThrow();
  });

  it('Variant 3 (decisions-batch): coalesces multiple pending fleet decisions into ONE single forward pass', async () => {
    const w = createWorld({ siteId: 'den-1', seed: 9303, agents: 8 });
    w.pendingDecisions.length = 0;
    for (const v of w.vehicles) {
      v.battery = 90;
      v.state = 'idle';
      v.orders = [];
      v.cargo = [];
    }
    w.orders = [];
    postOrder(w, { zone: 'A', bayId: 'E1', force: true });
    postOrder(w, { zone: 'B', bayId: 'E2', force: true });
    postOrder(w, { zone: 'C', bayId: 'E3', force: true });
    postOrder(w, { zone: 'D', bayId: 'E4', force: true });
    const transport = new DeterministicDecisionsTransport();
    const persistence = new InMemoryPersistenceStore();
    const broadcasts: BrainDecisionBroadcast[] = [];

    const scheduler = new AgentBrainScheduler({
      siteId: 'den-1',
      variant: 'decisions-batch',
      decisionsTransport: transport,
      persistence,
      onDecisionBroadcast: (msg) => broadcasts.push(msg),
    });

    for (const v of w.vehicles.slice(0, 4)) {
      emitContractRequestIfNeeded(w, v);
    }
    expect(w.pendingDecisions).toHaveLength(4);

    await scheduler.drainQueue(w, Date.now(), [], { wait: true });

    // All 4 vehicles resolved in a SINGLE transport.create() HTTP round-trip!
    expect(transport.calls).toHaveLength(1);
    expect(broadcasts).toHaveLength(4);
    expect(w.pendingDecisions).toHaveLength(0);
    const budget = await persistence.getBudget();
    expect(budget.agentTokensOut).toBe(0);
    expect(budget.agentCalls).toBe(1);
  });

  it('Variant 4 (hybrid): fast-paths high-confidence choices on gemini-decision-1 and escalates low-confidence + tactics to planner', async () => {
    const w = createWorld({ siteId: 'den-1', seed: 9404, agents: 8 });
    w.pendingDecisions.length = 0;
    for (const v of w.vehicles) {
      v.battery = 90;
      v.state = 'idle';
      v.orders = [];
      v.cargo = [];
    }
    w.orders = [];
    postOrder(w, { zone: 'A', bayId: 'E1', force: true });
    postOrder(w, { zone: 'B', bayId: 'E2', force: true });
    postOrder(w, { zone: 'C', bayId: 'E3', force: true });
    postOrder(w, { zone: 'D', bayId: 'E4', force: true });

    // 1. High confidence (0.86 >= 0.45): contract uses chooser only; tactics uses planner
    const hiTransport = new DeterministicDecisionsTransport({ confidence: 0.86 });
    let plannerCalls = 0;
    const stubPlanner: BrainModelClient = {
      async generateDecision(params) {
        plannerCalls++;
        if (params.kind === 'tactics') {
          return {
            text: JSON.stringify({
              speed: 1.15,
              buffer: 2,
              respect: 0.8,
              chargeAt: 22,
              batch: 1,
              note: 'Planner tuned pace',
            }),
            tokensIn: 200,
            tokensOut: 28,
            model: 'gemini-3.5-flash-lite',
          };
        }
        const firstOrder = (params.req?.options[0] as any)?.orderId ?? 1001;
        return {
          text: JSON.stringify({ orderIds: [String(firstOrder)], reason: 'Planner tie-break' }),
          tokensIn: 240,
          tokensOut: 24,
          model: 'gemini-3.5-flash-lite',
        };
      },
    };

    const chooserHi = new GeminiDecisionsBatchClient({ transport: hiTransport });
    const hybridHi = new HybridBrainClient({
      chooser: chooserHi,
      planner: stubPlanner,
      confidenceThreshold: 0.45,
    });

    const cReq = emitContractRequestIfNeeded(w, w.vehicles[0]!)!;
    const tReq = emitTacticsRequest(w, w.vehicles[1]!)!;
    const hiResults = await hybridHi.generateBatchDecisions({
      world: w,
      requests: [cReq, tReq],
      renderPlannerParams: (req) => ({
        ...renderDecisionPrompt(w, req),
        responseSchema: {},
      }),
    });

    expect(hiTransport.calls).toHaveLength(1);
    expect(plannerCalls).toBe(1); // Only tactics hit the planner!
    expect(hiResults.get(cReq.id)?.model).toBe(GEMINI_DECISION_MODEL);
    expect(hiResults.get(tReq.id)?.model).toBe('gemini-3.5-flash-lite');

    // 2. Low confidence (0.34 < 0.45): Confidence Cascade escalates contract to planner!
    const loTransport = new DeterministicDecisionsTransport({ confidence: 0.34 });
    plannerCalls = 0;
    const hybridLo = new HybridBrainClient({
      chooser: new GeminiDecisionsBatchClient({ transport: loTransport }),
      planner: stubPlanner,
      confidenceThreshold: 0.45,
    });
    const loRes = await hybridLo.generateBatchDecisions({
      world: w,
      requests: [cReq],
      renderPlannerParams: (req) => ({
        ...renderDecisionPrompt(w, req),
        responseSchema: {},
      }),
    });
    expect(loTransport.calls).toHaveLength(1);
    expect(plannerCalls).toBe(1); // Escalated!
    expect(loRes.get(cReq.id)?.model).toBe('gemini-3.5-flash-lite');
    expect(loRes.get(cReq.id)?.text).toContain('Planner tie-break');
  });

  it('DecisionsDispatchersCallClient evaluates deterministic situational candidates with calibrated confidence', async () => {
    const w = createWorld({ seed: 9505, agents: 0 });
    const drv = spawnPlayerVehicle(w, 'dc-decisions', 'Pilot-One', 'blitz')!;
    startBlitzClock(w, drv);
    drv.runStartedAt = w.t - 96;
    drv.runEndsAt = Math.round((drv.runStartedAt + BLITZ_DURATION_MIN) * 10) / 10;
    postOrder(w, { p0: true, force: true });
    postOrder(w, { p0: true, force: true });

    const sit = detectDispatchersCallSituation(w)!;
    const telemetry = buildDispatchersCallTelemetry(w, drv, sit);
    const candidates = buildDispatchersCallCandidates(telemetry);
    expect(candidates.length).toBeGreaterThanOrEqual(2);

    const transport = new DeterministicDecisionsTransport({ confidence: 0.91 });
    const dcClient = new DecisionsDispatchersCallClient({ transport });
    const budget = new InMemoryPersistenceStore();
    const offers: DispatchersCallOffer[] = [];
    const coord = new DispatchersCallCoordinator({
      enabled: true,
      client: dcClient,
      budget,
      onOffer: (o) => offers.push(o),
    });

    await coord.poll(w);
    expect(offers).toHaveLength(1);
    const pickRes = coord.handlePick(w, drv, offers[0]!.screen.screenId, 0);
    expect(pickRes.ok).toBe(true);
    if (pickRes.ok) {
      expect(pickRes.reveal.geminiReason).toContain('91% conf');
    }
  });

  it('probes daily for ADC support and automatically cuts SdkDecisionsApiTransport over from api-key to ADC', async () => {
    try {
      setDecisionsAdcProbeResultForTesting(null);

      // 1. Before ADC parity: requires API key and reports authMode = 'api-key'
      const notYet = await probeDecisionsAdcSupport({
        nowMs: 1_700_000_000_000,
        tryVertex: async () => false,
        tryOauthAdc: async () => false,
      });
      expect(notYet.supported).toBe(false);
      expect(notYet.mode).toBeNull();

      const sdkTransport = new SdkDecisionsApiTransport({ apiKey: 'temp-exception-key' });
      expect(sdkTransport.authMode).toBe('api-key');

      const scheduler = new AgentBrainScheduler({
        siteId: 'den-1',
        variant: 'decisions-batch',
        decisionsTransport: new DeterministicDecisionsTransport(),
        persistence: new InMemoryPersistenceStore(),
      });
      expect(scheduler.getBrainHealth().decisionsAuthMode).toBe('api-key');
      expect(scheduler.getBrainHealth().decisionsAdcSupported).toBe(false);

      // 2. Daily monitor detects Vertex ADC support -> transport & default variant cut over to ADC!
      let seenSupported = false;
      const stop = startDailyDecisionsAdcMonitor({
        siteId: 'den-1',
        intervalMs: 60_000,
        probeOpts: {
          nowMs: 1_700_086_400_000,
          tryVertex: async () => true,
        },
        onResult: (r) => {
          seenSupported = r.supported;
        },
      });
      await new Promise((r) => setTimeout(r, 15));
      stop();

      expect(seenSupported).toBe(true);
      expect(sdkTransport.authMode).toBe('adc-vertex');
      // Even without any API key in env, auto variant now selects decisions-batch via ADC!
      expect(resolveBrainVariant(undefined, {})).toBe('decisions-batch');
      expect(scheduler.getBrainHealth().decisionsAuthMode).toBe('adc-vertex');
      expect(scheduler.getBrainHealth().decisionsAdcSupported).toBe(true);
    } finally {
      setDecisionsAdcProbeResultForTesting(null);
    }
  });

  it('hot-standby failover: seamlessly serves via Vertex gemini-3.5-flash-lite on 402 prepay depletion with zero brainErrors and recovers automatically', async () => {
    const w = createWorld({ siteId: 'den-1', seed: 9606, agents: 6 });
    w.pendingDecisions.length = 0;
    for (const v of w.vehicles) {
      v.battery = 90;
      v.state = 'idle';
      v.orders = [];
      v.cargo = [];
    }
    w.orders = [];
    postOrder(w, { zone: 'A', bayId: 'E1', p0: true, force: true });
    postOrder(w, { zone: 'B', bayId: 'E2', force: true });

    let shouldFail402 = true;
    const healthyTransport = new DeterministicDecisionsTransport({ confidence: 0.89 });
    const flakyDecisionsTransport: DecisionsApiTransport = {
      async create(params, signal) {
        if (shouldFail402) {
          const err = new Error('402 Your prepayment credits are depleted. RESOURCE_EXHAUSTED');
          (err as Error & { status?: number }).status = 402;
          throw err;
        }
        return healthyTransport.create(params, signal);
      },
    };

    let standbyCalls = 0;
    const standbyFlash: BrainModelClient = {
      async generateDecision(params) {
        const idx = standbyCalls++;
        const opts = (params.req?.options as Array<{ orderId?: number }> | undefined) ?? [];
        const picked = opts[idx % Math.max(1, opts.length)]?.orderId ?? 1001;
        return {
          text: JSON.stringify({ orderIds: [String(picked)], reason: 'Vertex standby P0' }),
          tokensIn: 210,
          tokensOut: 22,
          model: 'gemini-3.5-flash-lite',
        };
      },
    };

    const persistence = new InMemoryPersistenceStore();
    const broadcasts: BrainDecisionBroadcast[] = [];
    const scheduler = new AgentBrainScheduler({
      siteId: 'den-1',
      variant: 'decisions-batch',
      decisionsTransport: flakyDecisionsTransport,
      standbyClient: standbyFlash,
      standbyCooldownMs: 5_000,
      persistence,
      onDecisionBroadcast: (msg) => broadcasts.push(msg),
    });

    const t0 = 1_700_100_000_000;
    emitContractRequestIfNeeded(w, w.vehicles[0]!);
    emitContractRequestIfNeeded(w, w.vehicles[1]!);

    await scheduler.drainQueue(w, t0, [], { wait: true });

    // Zero forklift brainErrors; both vehicles received real standby decisions in the same tick!
    expect(standbyCalls).toBe(2);
    expect(broadcasts).toHaveLength(2);
    expect(w.vehicles.every((v) => !v.brainError)).toBe(true);
    const hStandby = scheduler.getBrainHealth(t0 + 100);
    expect(hStandby.ok).toBe(true);
    expect(hStandby.model).toBe('gemini-3.5-flash-lite');
    expect(hStandby.decisionsStandbyReason).toContain('prepayment credits');

    // Once cooldown expires and credits/ADC are restored, scheduler cuts back to gemini-decision-1!
    shouldFail402 = false;
    w.vehicles[2]!.state = 'idle';
    w.vehicles[2]!.orders = [];
    postOrder(w, { zone: 'C', bayId: 'E3', force: true });
    emitContractRequestIfNeeded(w, w.vehicles[2]!);

    await scheduler.drainQueue(w, t0 + 6_000, [], { wait: true });

    const hRecovered = scheduler.getBrainHealth(t0 + 6_100);
    expect(hRecovered.ok).toBe(true);
    expect(hRecovered.model).toBe(GEMINI_DECISION_MODEL);
    expect(hRecovered.decisionsStandbyReason).toBeUndefined();
    expect(broadcasts.at(-1)?.model).toBe(GEMINI_DECISION_MODEL);
    expect(broadcasts.at(-1)?.confidence).toBeCloseTo(0.89, 2);
  });
});
