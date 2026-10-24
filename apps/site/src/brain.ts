import { GoogleGenAI } from '@google/genai';
import { assertNoUntrustedText, sanitiseOutputText } from '@warehouse/armor';
import {
  ALLOWED_GEMINI_MODELS,
  type AllowedGeminiModel,
  CardsDecisionSchema,
  ContractDecisionSchema,
  GEMINI_RESPONSE_SCHEMAS,
  HazardDecisionSchema,
  TacticsDecisionSchema,
  type BrainHealthMessage,
  type DecisionKind,
  type SiteId,
} from '@warehouse/protocol';
import {
  applyDecision,
  clearBrainError,
  markBrainError,
  SKILLS,
  type CardOption,
  type ContractOption,
  type Decision,
  type DecisionRequest,
  type HazardOption,
  type TacticsOption,
  type World,
} from '@warehouse/sim';
import {
  AGENT_DAILY_BUDGET_USD,
  JOURNAL_TTL_MS,
  type DecisionJournalEntry,
  type PersistenceStore,
} from './persistence.js';

/** Card types built around beating the planner; never shown to AI agents. */
export const HUMAN_ONLY_CARD_TYPES: ReadonlySet<string> = new Set(
  SKILLS.filter((s) => s.humanOnly).map((s) => s.type),
);

export { ALLOWED_GEMINI_MODELS, type AllowedGeminiModel };
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

/**
 * Validate a configured Gemini model name against the protocol allow-list.
 * Unset/blank values fall back to {@link DEFAULT_GEMINI_MODEL}; anything else
 * that is not allow-listed throws so a misconfigured deploy fails loudly at
 * startup instead of failing every brain/NL call at runtime.
 */
export function resolveGeminiModel(value?: string | null): AllowedGeminiModel {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_GEMINI_MODEL;
  if ((ALLOWED_GEMINI_MODELS as readonly string[]).includes(trimmed)) {
    return trimmed as AllowedGeminiModel;
  }
  throw new Error(
    `GEMINI_MODEL=${JSON.stringify(trimmed)} is not allowed; expected one of: ${ALLOWED_GEMINI_MODELS.join(', ')}`,
  );
}
export const DEFAULT_GEMINI_LOCATION = 'global';
export const DEFAULT_GCP_PROJECT =
  process.env.GCP_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  'davenporter-freightfloor';
export const MAX_CONCURRENT_BRAIN_CALLS =
  Number(process.env.MAX_CONCURRENT_BRAIN_CALLS) > 0
    ? Number(process.env.MAX_CONCURRENT_BRAIN_CALLS)
    : 8;
/** Maximum Gemini brain calls per minute per shard (sliding 60 s window). */
export const BRAIN_MAX_CALLS_PER_MIN =
  Number(process.env.BRAIN_MAX_RPM) > 0 ? Number(process.env.BRAIN_MAX_RPM) : 120;
/**
 * Per-attempt Gemini timeout for brain decisions. Flash-Lite with `thinkingBudget: 0` and a
 * 120-token JSON answer returns well under a second, so 4 s bounds a hung call without
 * cutting off healthy ones. With 1 retry the worst case per decision is ~8 s.
 */
export const BRAIN_CALL_TIMEOUT_MS = 4_000;
/** Total model attempts per decision (1 initial + 1 retry). */
export const BRAIN_MAX_ATTEMPTS = 2;
export const BRAIN_ERROR_BACKOFF_MS = 3000;
export const BRAIN_ERROR_BACKOFF_GAME_MIN = 3.0;

export interface BrainHealth {
  ok: boolean;
  model: string;
  calls1m: number;
  p50Ms: number;
  p50ms: number;
  p95Ms: number;
  errors1m: number;
  tokensIn1m: number;
  tokensOut1m: number;
  armorBlocks1h: number;
  budgetLeftUsd: number;
  budgetPaused: boolean;
}

export interface BrainDecisionBroadcast {
  type: 'brainDecision';
  reqId: number;
  agentId: number;
  /** Vehicle id the decision is for (lets the client pin the insight without digit-matching). */
  vid?: string;
  kind: DecisionKind;
  decision: Record<string, unknown>;
  note: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

const KIND_PRIORITY: Record<DecisionKind, number> = {
  hazard: 0,
  contract: 1,
  cards: 2,
  tactics: 3,
};

export interface RawBrainResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  model?: string;
}

export interface BrainModelClient {
  generateDecision(params: {
    kind: DecisionKind;
    systemInstruction: string;
    prompt: string;
    responseSchema: unknown;
  }): Promise<RawBrainResponse>;
}

export type GeminiBrainClient = BrainModelClient;

/**
 * Production Vertex AI Gemini 3.5 Flash-Lite client using Application Default Credentials (ADC).
 * Never reads or checks GEMINI_API_KEY.
 */
export class VertexGeminiBrainClient implements BrainModelClient {
  private readonly ai: GoogleGenAI;
  public readonly model: string;

  constructor(opts?: { projectId?: string; location?: string; model?: string }) {
    const project = opts?.projectId ?? process.env.GCP_PROJECT_ID ?? DEFAULT_GCP_PROJECT;
    const location = opts?.location ?? process.env.GEMINI_LOCATION ?? DEFAULT_GEMINI_LOCATION;
    this.model = opts?.model ?? resolveGeminiModel(process.env.GEMINI_MODEL);
    this.ai = new GoogleGenAI({
      vertexai: true,
      project,
      location,
    });
  }

  async generateDecision(params: {
    kind: DecisionKind;
    systemInstruction: string;
    prompt: string;
    responseSchema: unknown;
  }): Promise<RawBrainResponse> {
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: params.prompt,
      config: {
        systemInstruction: params.systemInstruction,
        temperature: 0.2,
        maxOutputTokens: 120,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
        // Structured output keeps the decision JSON parseable (same as the NL parser).
        responseSchema: params.responseSchema as Record<string, unknown>,
        abortSignal: AbortSignal.timeout(BRAIN_CALL_TIMEOUT_MS),
      },
    });

    const text = res.text ?? '';
    if (!text) {
      throw new Error(`Empty response text from ${this.model}`);
    }

    const tokensIn = res.usageMetadata?.promptTokenCount ?? 0;
    const tokensOut = res.usageMetadata?.candidatesTokenCount ?? 0;
    return {
      text,
      tokensIn,
      tokensOut,
      model: this.model,
    };
  }
}

export function numericAgentId(agentId: string | number): number {
  if (typeof agentId === 'number') return agentId;
  const digits = agentId.replace(/\D+/g, '');
  return digits ? Number.parseInt(digits, 10) : 0;
}

/**
 * Renders a strictly numeric/enum prompt for an agent DecisionRequest.
 * Never interpolates player display names or any untrusted user text.
 */
export function renderDecisionPrompt(
  world: World,
  req: DecisionRequest,
  extraUntrustedStrings: readonly string[] = [],
): { systemInstruction: string; prompt: string } {
  const ctx = req.context;
  const systemInstruction = [
    `You are the onboard Gemini 3.5 Flash-Lite brain for autonomous warehouse vehicle ${ctx.agentId}.`,
    `Persona archetype: ${ctx.persona}. Vehicle type: ${ctx.vehicleType}.`,
    `Choose strictly from the provided options and return compact JSON matching the requested format.`,
    `Keep reason/note under 90 characters, plain ASCII, no URLs or markdown.`,
  ].join(' ');

  let body = '';
  if (req.kind === 'contract') {
    const opts = req.options as ContractOption[];
    const lines = opts.map(
      (o) =>
        `- orderId="${o.orderId}" bay=${o.bay} zone=${o.district} dist=${o.distance} slackMin=${o.slack} val=${o.value} p0=${o.p0 ? 1 : 0} xfer=${o.isTransfer ? 1 : 0} cong=${o.congestion} claimant=${o.claimant ?? 'none'}`,
    );
    body = [
      `Decision: contract`,
      `Agent: ${ctx.agentId} (${ctx.persona}) at (${ctx.tile.x},${ctx.tile.y}) battery=${Math.round(ctx.battery)}% cap=${ctx.capacity} cargo=${ctx.cargoCount}`,
      `Candidate orders (MUST pick 1 to ${Math.min(2, Math.max(1, ctx.capacity))} orderId strings from this list):`,
      ...lines,
      `Output JSON format: {"orderIds":["${opts[0]?.orderId ?? 1000}"],"reason":"short reason"}`,
    ].join('\n');
  } else if (req.kind === 'hazard') {
    const rawOpts = req.options as HazardOption[];
    const validOpts = rawOpts.filter(
      (o) => !(o.choice === 'reroute' && o.detourLen === null),
    );
    const opts = validOpts.length > 0 ? validOpts : rawOpts;
    const lines = opts.map(
      (o) =>
        `- choice="${o.choice}" detourLen=${o.detourLen ?? 'none'} spillClearsInMin=${o.timeLeft} skidRisk=${o.skidRisk}`,
    );
    const choiceUnion =
      opts.map((o) => `"${o.choice}"`).join('|') || '"reroute"|"wait"|"push"';
    body = [
      `Decision: hazard`,
      `Agent: ${ctx.agentId} (${ctx.persona}) at (${ctx.tile.x},${ctx.tile.y}) battery=${Math.round(ctx.battery)}% cargo=${ctx.cargoCount} slackMin=${ctx.slack ?? 'none'}`,
      `Spill #${ctx.hazardId ?? 0} ahead at (${ctx.hazardTile?.x ?? 0},${ctx.hazardTile?.y ?? 0}). Allowed choices:`,
      ...lines,
      `Output JSON format: {"choice":${choiceUnion},"reason":"short reason"}`,
    ].join('\n');
  } else if (req.kind === 'tactics') {
    const opts = req.options as TacticsOption[];
    const bounds = opts.map((o) => `${o.param}[${o.min}..${o.max},cur=${o.current}]`).join(' ');
    body = [
      `Decision: tactics`,
      `Agent: ${ctx.agentId} (${ctx.persona}) shiftShipped=${ctx.shiftShipped} shiftPts=${Math.round(ctx.shiftPts)} incidents=${ctx.incidents} nearMisses=${ctx.nearMisses} difficulty=${ctx.difficulty}`,
      `Tune parameters within bounds: ${bounds}`,
      `Output JSON format: {"speed":1.05,"buffer":2,"respect":0.7,"chargeAt":20,"batch":1,"note":"short note"}`,
    ].join('\n');
  } else {
    // humanOnly cards are never dealt to AI by the sim; filter again so the model can't see them.
    const opts = (req.options as CardOption[]).filter((o) => !HUMAN_ONLY_CARD_TYPES.has(o.cardType));
    const lines = opts.map((o) => {
      const perk = o.perk && Object.keys(o.perk).length
        ? ` perk=${Object.entries(o.perk).map(([k, n]) => `${k}:${n}`).join(',')}`
        : '';
      return `- id="${o.id}" type=${o.cardType} rarity=${o.rarity ?? 'common'} pts=${o.pts} goal=${o.goal}${perk} title="${o.title}"`;
    });
    body = [
      `Decision: cards`,
      `Agent: ${ctx.agentId} (${ctx.persona}) difficulty=${ctx.difficulty}`,
      `Offered shift cards (keep 1 to 2 valid id strings from this list; at most one wild):`,
      ...lines,
      `Output JSON format: {"keep":["${opts[0]?.id ?? 'C1'}"],"reason":"short reason"}`,
    ].join('\n');
  }

  const vehicle = world.vehicles.find((x) => x.id === req.agentId);
  const dir = vehicle?.directive;
  if (dir) {
    const dirParts: string[] = [];
    if (dir.strategy) dirParts.push(`persona=${dir.strategy}`);
    if (dir.priority) dirParts.push(`priority=${dir.priority}`);
    const zones = dir.focusZones?.length ? dir.focusZones : dir.preferredZones;
    if (zones?.length) dirParts.push(`zone=${zones.join(',')}`);
    const bays = dir.focusBays?.length ? dir.focusBays : dir.preferredBays;
    if (bays?.length) dirParts.push(`bay=${bays.join(',')}`);
    if (dir.immediateTask) {
      if (typeof dir.immediateTask === 'string') {
        dirParts.push(`task=${dir.immediateTask}`);
      } else {
        dirParts.push(
          `task=${dir.immediateTask.kind}${dir.immediateTask.target ? `:${dir.immediateTask.target}` : ''}`,
        );
      }
    }
    if (dir.tactics) {
      const t = dir.tactics;
      if (t.speed !== undefined) dirParts.push(`speed=${t.speed}`);
      if (t.respect !== undefined) dirParts.push(`respect=${t.respect}`);
      if (t.buffer !== undefined) dirParts.push(`buffer=${t.buffer}`);
      if (t.chargeAt !== undefined) dirParts.push(`chargeAt=${t.chargeAt}`);
      if (t.batch !== undefined) dirParts.push(`batch=${t.batch}`);
      if (t.preemptForP0 !== undefined) dirParts.push(`preemptP0=${t.preemptForP0 ? 1 : 0}`);
      if (t.poach !== undefined) dirParts.push(`poach=${t.poach ? 1 : 0}`);
    }
    if (dirParts.length > 0) {
      body += `\nActiveDirective: ${dirParts.join(' ')}`;
    }
  }

  // Collect all connected player display names to enforce the untrusted-text isolation invariant
  const untrusted: string[] = [...extraUntrustedStrings];
  for (const session of world.players.values()) {
    if (session.name && session.name.trim().length >= 2 && !/^P\d+$/i.test(session.name.trim())) {
      untrusted.push(session.name);
    }
  }
  for (const v of world.vehicles) {
    if (
      v.human &&
      v.driver &&
      v.driver !== 'you' &&
      v.driver.trim().length >= 2 &&
      !/^P\d+$/i.test(v.driver.trim())
    ) {
      untrusted.push(v.driver);
    }
  }

  assertNoUntrustedText(systemInstruction, untrusted);
  assertNoUntrustedText(body, untrusted);

  return { systemInstruction, prompt: body };
}

/**
 * Parses and validates the JSON response from Gemini (or test stub) and maps it to @warehouse/sim Decision.
 */
export function parseAndMapDecision(
  req: DecisionRequest,
  rawJsonText: string,
): { simDecision: Decision; wireDecision: Record<string, unknown>; note: string } {
  const parsed = JSON.parse(rawJsonText) as Record<string, unknown>;

  if (req.kind === 'contract') {
    // Support both protocol schema ({ orderIds: string[], reason }) and legacy ({ orderId, secondOrderId?, note })
    let rawIds: unknown[] = [];
    if (Array.isArray(parsed.orderIds)) {
      rawIds = parsed.orderIds;
    } else if (parsed.orderId !== undefined) {
      rawIds = [
        parsed.orderId,
        ...(parsed.secondOrderId !== undefined ? [parsed.secondOrderId] : []),
      ];
    }
    const normalized = {
      orderIds: rawIds.map((id) => String(id).replace(/^#/, '')),
      reason: String(parsed.reason ?? parsed.note ?? 'Claimed contract'),
    };
    const valid = ContractDecisionSchema.parse(normalized);
    if (valid.orderIds.length === 0) {
      throw new Error('Contract decision must select at least 1 orderId');
    }
    const note = sanitiseOutputText(valid.reason, 120) || 'Claimed contract';
    const offeredIds = new Set((req.options as ContractOption[]).map((o) => o.orderId));
    const firstId = Number.parseInt(valid.orderIds[0], 10);
    if (!Number.isFinite(firstId)) {
      throw new Error(`Invalid numeric orderId "${valid.orderIds[0]}"`);
    }
    const orderIds: number[] = [firstId];
    if (valid.orderIds.length > 1 && req.context.capacity >= 2) {
      const secondId = Number.parseInt(valid.orderIds[1], 10);
      if (Number.isFinite(secondId) && secondId !== firstId && offeredIds.has(secondId)) {
        orderIds.push(secondId);
      }
    }
    return {
      simDecision: { kind: 'contract', orderIds, reason: note },
      wireDecision: {
        orderIds: orderIds.map(String),
        orderId: orderIds[0],
        ...(orderIds[1] ? { secondOrderId: orderIds[1] } : {}),
        reason: note,
        note,
      },
      note,
    };
  }

  if (req.kind === 'hazard') {
    const normalized = {
      choice: parsed.choice ?? parsed.action,
      reason: String(parsed.reason ?? parsed.note ?? `Hazard: ${String(parsed.choice ?? parsed.action)}`),
    };
    const valid = HazardDecisionSchema.parse(normalized);
    const note = sanitiseOutputText(valid.reason, 120) || `Hazard: ${valid.choice}`;
    return {
      simDecision: { kind: 'hazard', choice: valid.choice, reason: note },
      wireDecision: { choice: valid.choice, action: valid.choice, reason: note, note },
      note,
    };
  }

  if (req.kind === 'tactics') {
    const normalized = {
      ...parsed,
      note: String(parsed.note ?? parsed.reason ?? 'Retuned tactics'),
    };
    const valid = TacticsDecisionSchema.parse(normalized);
    const note = sanitiseOutputText(valid.note, 120) || 'Retuned tactics';
    return {
      simDecision: {
        kind: 'tactics',
        speed: valid.speed,
        buffer: valid.buffer,
        respect: valid.respect,
        chargeAt: valid.chargeAt,
        batch: valid.batch,
        note,
        reason: note,
      },
      wireDecision: {
        speed: valid.speed,
        buffer: valid.buffer,
        respect: valid.respect,
        chargeAt: valid.chargeAt,
        batch: valid.batch,
        note,
      },
      note,
    };
  }

  // cards
  const rawKeep = Array.isArray(parsed.keep)
    ? parsed.keep
    : Array.isArray(parsed.keepIds)
      ? parsed.keepIds
      : [];
  const normalized = {
    keep: rawKeep.slice(0, 2).map(String),
    reason: String(parsed.reason ?? parsed.note ?? 'Selected shift cards'),
  };
  const valid = CardsDecisionSchema.parse(normalized);
  const note = sanitiseOutputText(valid.reason ?? 'Selected shift cards', 120) || 'Selected shift cards';
  return {
    simDecision: { kind: 'cards', keep: valid.keep, reason: note },
    wireDecision: { keep: valid.keep, keepIds: valid.keep, reason: note, note },
    note,
  };
}

interface CallSample {
  atMs: number;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
}

interface ErrorSample {
  atMs: number;
  message: string;
}

interface ErrorBackoffState {
  atMs: number;
  gameMin: number;
}

export interface AgentBrainSchedulerOptions {
  siteId: SiteId;
  client?: BrainModelClient;
  persistence: PersistenceStore;
  modelName?: string;
  maxConcurrent?: number;
  retryDelayMs?: number;
  getArmorBlocks1h?: (nowMs: number) => number;
  onDecisionBroadcast?: (msg: BrainDecisionBroadcast) => void;
  onHealthBroadcast?: (health: BrainHealthMessage) => void;
}

export class AgentBrainScheduler {
  private readonly siteId: SiteId;
  private readonly client: BrainModelClient;
  private readonly persistence: PersistenceStore;
  public readonly modelName: string;
  private readonly maxConcurrent: number;
  private readonly retryDelayMs: number;
  private readonly getArmorBlocks1h?: (nowMs: number) => number;
  private readonly onDecisionBroadcast?: (msg: BrainDecisionBroadcast) => void;
  private readonly onHealthBroadcast?: (health: BrainHealthMessage) => void;

  private readonly inFlightReqIds = new Set<string>();
  private readonly callSamples: CallSample[] = [];
  private readonly errorSamples: ErrorSample[] = [];
  private readonly agentErrorBackoff = new Map<string, ErrorBackoffState>();
  private budgetPaused = false;
  private lastBudgetLeftUsd = AGENT_DAILY_BUDGET_USD;
  private reqCounter = 0;

  constructor(opts: AgentBrainSchedulerOptions) {
    this.siteId = opts.siteId;
    this.modelName = opts.modelName ?? resolveGeminiModel(process.env.GEMINI_MODEL);
    this.client = opts.client ?? new VertexGeminiBrainClient({ model: this.modelName });
    this.persistence = opts.persistence;
    this.maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT_BRAIN_CALLS;
    this.retryDelayMs = opts.retryDelayMs ?? 120;
    this.getArmorBlocks1h = opts.getArmorBlocks1h;
    this.onDecisionBroadcast = opts.onDecisionBroadcast;
    this.onHealthBroadcast = opts.onHealthBroadcast;
  }

  public getInFlightCount(): number {
    return this.inFlightReqIds.size;
  }

  private pruneSamples(nowMs: number): void {
    const cutoff = nowMs - 60_000;
    while (this.callSamples.length > 0 && this.callSamples[0].atMs < cutoff) {
      this.callSamples.shift();
    }
    while (this.errorSamples.length > 0 && this.errorSamples[0].atMs < cutoff) {
      this.errorSamples.shift();
    }
  }

  public getBrainHealth(nowMs: number = Date.now()): BrainHealth {
    this.pruneSamples(nowMs);
    const latencies = this.callSamples.map((s) => s.latencyMs).sort((a, b) => a - b);
    const p50Ms =
      latencies.length > 0 ? Math.round(latencies[Math.floor((latencies.length - 1) * 0.5)]) : 0;
    const p95Ms =
      latencies.length > 0 ? Math.round(latencies[Math.floor((latencies.length - 1) * 0.95)]) : 0;
    const tokensIn1m = this.callSamples.reduce((acc, s) => acc + s.tokensIn, 0);
    const tokensOut1m = this.callSamples.reduce((acc, s) => acc + s.tokensOut, 0);
    const errors1m = this.errorSamples.length;

    return {
      ok: !this.budgetPaused && errors1m === 0,
      model: this.modelName,
      calls1m: this.callSamples.length,
      p50Ms,
      p50ms: p50Ms,
      p95Ms,
      errors1m,
      tokensIn1m,
      tokensOut1m,
      armorBlocks1h: this.getArmorBlocks1h ? this.getArmorBlocks1h(nowMs) : 0,
      budgetLeftUsd: this.lastBudgetLeftUsd,
      budgetPaused: this.budgetPaused,
    };
  }

  public getBrainHealthMessage(
    nowMs: number = Date.now(),
    armorBlocks1hOverride?: number,
  ): BrainHealthMessage {
    const h = this.getBrainHealth(nowMs);
    return {
      type: 'brainHealth',
      ok: h.ok,
      model: h.model,
      errors1m: h.errors1m,
      p50ms: h.p50ms,
      budgetLeftUsd: h.budgetLeftUsd,
      armorBlocks1h: armorBlocks1hOverride ?? h.armorBlocks1h,
    };
  }

  /**
   * Clears expired agent brainError holds after the 3s backoff window so the agent can retry on the next cycle.
   */
  public recoverErroredAgents(world: World, nowMs: number = Date.now()): void {
    for (const v of world.vehicles) {
      if (!v.brainError) {
        this.agentErrorBackoff.delete(v.id);
        continue;
      }
      const stamp = this.agentErrorBackoff.get(v.id);
      if (!stamp) {
        this.agentErrorBackoff.set(v.id, { atMs: nowMs, gameMin: world.t });
        continue;
      }
      const wallElapsed = nowMs - stamp.atMs;
      const gameElapsed = world.t - stamp.gameMin;
      if (wallElapsed >= BRAIN_ERROR_BACKOFF_MS || gameElapsed >= BRAIN_ERROR_BACKOFF_GAME_MIN) {
        this.agentErrorBackoff.delete(v.id);
        clearBrainError(world, v.id);
      }
    }
  }

  /**
   * Dispatches pending decisions from `world.pendingDecisions` in priority order
   * (`hazard` > `contract` > `cards` > `tactics`) into free concurrency slots (`maxConcurrent`, 8).
   * Each request runs independently and frees its own slot when it settles, so one slow or hung
   * Gemini call never blocks the others or the next drain. With `wait: true` (default) the
   * promise resolves once the requests dispatched by THIS call settle (tests, foreground ticks);
   * the live server calls it with `wait: false` on every background tick.
   * Zero Gemini calls when `world.phase !== 'running'`. Never rejects.
   */
  public async drainQueue(
    world: World,
    nowMs: number = Date.now(),
    extraUntrustedStrings: readonly string[] = [],
    opts: { wait?: boolean } = {},
  ): Promise<void> {
    if (world.phase !== 'running') {
      return;
    }

    this.recoverErroredAgents(world, nowMs);

    // Drop expired requests whose deadline < world.t
    for (let i = world.pendingDecisions.length - 1; i >= 0; i--) {
      const req = world.pendingDecisions[i];
      if (req.deadline < world.t && !this.inFlightReqIds.has(req.id)) {
        world.pendingDecisions.splice(i, 1);
      }
    }

    // Sort available (not yet in-flight) requests by priority (hazard > contract > cards > tactics), then tIssued
    const candidates = world.pendingDecisions
      .filter((r) => !this.inFlightReqIds.has(r.id))
      .sort((a, b) => {
        const pa = KIND_PRIORITY[a.kind] ?? 99;
        const pb = KIND_PRIORITY[b.kind] ?? 99;
        if (pa !== pb) return pa - pb;
        return a.tIssued - b.tIssued;
      });

    const dispatched: Promise<void>[] = [];
    for (const req of candidates) {
      if (this.inFlightReqIds.size >= this.maxConcurrent) {
        break;
      }
      dispatched.push(this.dispatchOne(world, req, nowMs, extraUntrustedStrings));
    }

    if (opts.wait !== false && dispatched.length > 0) {
      await Promise.all(dispatched);
    }
  }

  /** Runs one request in its own slot; the slot is released as soon as this request settles. */
  private dispatchOne(
    world: World,
    req: DecisionRequest,
    nowMs: number,
    extraUntrustedStrings: readonly string[],
  ): Promise<void> {
    this.inFlightReqIds.add(req.id);
    return this.executeRequest(world, req, nowMs, extraUntrustedStrings)
      .catch((err) => {
        // executeRequest records its own failures; this only catches a failure while recording.
        console.error(
          `[brain] ${req.kind} ${req.id} failed outside the decision path: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.inFlightReqIds.delete(req.id);
      });
  }

  /** Record agent spend; a ledger failure is logged and never triggers another model call. */
  private async recordUsageSafe(tokensIn: number, tokensOut: number, nowMs: number): Promise<void> {
    if (tokensIn <= 0 && tokensOut <= 0) return;
    try {
      const updatedBudget = await this.persistence.recordUsage('agent', tokensIn, tokensOut, undefined, nowMs);
      this.lastBudgetLeftUsd = Math.max(
        0,
        Number((updatedBudget.agentCapUsd - updatedBudget.agentSpentUsd).toFixed(4)),
      );
      this.budgetPaused = updatedBudget.agentSpentUsd >= updatedBudget.agentCapUsd;
    } catch (err) {
      console.error(
        `[brain] agent usage record failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async executeRequest(
    world: World,
    req: DecisionRequest,
    nowMs: number,
    extraUntrustedStrings: readonly string[],
  ): Promise<void> {
    if (world.phase !== 'running') {
      return;
    }

    let systemInstruction: string;
    let prompt: string;
    let responseSchema: unknown;
    try {
      // Check daily agent budget BEFORE calling Gemini
      const budget = await this.persistence.checkBudget('agent', nowMs);
      this.budgetPaused = !budget.allowed;
      this.lastBudgetLeftUsd = Math.max(0, Number((budget.capUsd - budget.spentUsd).toFixed(4)));
      if (!budget.allowed) {
        const errMsg = `Daily agent budget exhausted ($${budget.spentUsd.toFixed(2)}/$${budget.capUsd.toFixed(2)})`;
        await this.recordBrainFailure(world, req, errMsg, 0, nowMs);
        return;
      }

      ({ systemInstruction, prompt } = renderDecisionPrompt(world, req, extraUntrustedStrings));
      responseSchema = GEMINI_RESPONSE_SCHEMAS[req.kind];
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.recordBrainFailure(world, req, `Brain pre-call failed: ${errMsg}`, 0, nowMs);
      return;
    }

    const startMs = Date.now();
    let lastError: Error | null = null;
    let usedTokensIn = 0;
    let usedTokensOut = 0;
    let success:
      | { raw: RawBrainResponse; mapped: ReturnType<typeof parseAndMapDecision>; latencyMs: number }
      | null = null;
    let stale = false;

    // Bounded retry: BRAIN_MAX_ATTEMPTS model calls with jittered backoff. Only the model call,
    // parse and sim apply are inside the loop; usage is recorded once after it.
    for (let attempt = 0; attempt < BRAIN_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0 && this.retryDelayMs > 0) {
        const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(this.retryDelayMs / 2)));
        await new Promise((r) => setTimeout(r, this.retryDelayMs + jitter));
      }

      try {
        const raw = await this.client.generateDecision({
          kind: req.kind,
          systemInstruction,
          prompt,
          responseSchema,
        });
        usedTokensIn += raw.tokensIn;
        usedTokensOut += raw.tokensOut;
        const latencyMs = Math.max(1, Date.now() - startMs);
        const mapped = parseAndMapDecision(req, raw.text);

        // Apply decision to simulation
        const applied = applyDecision(world, req.id, mapped.simDecision, {
          model: raw.model ?? this.modelName,
          latencyMs,
          inputTokens: raw.tokensIn,
          outputTokens: raw.tokensOut,
        });

        if (!applied.ok) {
          if (applied.error === 'stale') {
            // Order/spill changed while request was in flight; not a brain error
            stale = true;
            break;
          }
          throw new Error(applied.detail || `Illegal ${req.kind} decision`);
        }
        success = { raw, mapped, latencyMs };
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    // Every billed model call is recorded exactly once, outside the retry loop.
    await this.recordUsageSafe(usedTokensIn, usedTokensOut, nowMs);

    if (stale) return;

    if (success) {
      const { raw, mapped, latencyMs } = success;
      this.callSamples.push({
        atMs: nowMs,
        latencyMs,
        tokensIn: raw.tokensIn,
        tokensOut: raw.tokensOut,
      });

      const numericReqId =
        Number.parseInt(req.id.replace(/\D+/g, ''), 10) || ++this.reqCounter;
      const agentNum = numericAgentId(req.agentId);

      const journalEntry: DecisionJournalEntry = {
        id: `${this.siteId}-${req.id}-${nowMs}`,
        siteId: this.siteId,
        reqId: numericReqId,
        agentId: agentNum,
        agentName: req.agentId,
        kind: req.kind,
        promptSummary: prompt.slice(0, 240),
        decision: mapped.wireDecision,
        note: mapped.note,
        model: raw.model ?? this.modelName,
        latencyMs,
        tokensIn: raw.tokensIn,
        tokensOut: raw.tokensOut,
        createdAt: nowMs,
        expireAt: nowMs + JOURNAL_TTL_MS,
      };
      try {
        await this.persistence.appendDecisionJournal(this.siteId, journalEntry);
      } catch (err) {
        console.error(
          `[brain] decision journal write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (this.onDecisionBroadcast) {
        this.onDecisionBroadcast({
          type: 'brainDecision',
          reqId: numericReqId,
          agentId: agentNum,
          vid: req.agentId,
          kind: req.kind,
          decision: mapped.wireDecision,
          note: mapped.note,
          latencyMs,
          tokensIn: raw.tokensIn,
          tokensOut: raw.tokensOut,
          model: raw.model ?? this.modelName,
        });
      }
      return;
    }

    // Strict No-Mock Policy: never synthesize a rule-based fallback decision.
    const latencyMs = Math.max(1, Date.now() - startMs);
    const errorMsg = lastError ? lastError.message : 'Gemini decision failed';
    await this.recordBrainFailure(world, req, errorMsg, latencyMs, nowMs);
  }

  private async recordBrainFailure(
    world: World,
    req: DecisionRequest,
    errorMsg: string,
    latencyMs: number,
    nowMs: number,
  ): Promise<void> {
    this.errorSamples.push({ atMs: nowMs, message: errorMsg });
    this.agentErrorBackoff.set(req.agentId, { atMs: nowMs, gameMin: world.t });
    markBrainError(world, req.agentId, req.id, errorMsg);

    const numericReqId =
      Number.parseInt(req.id.replace(/\D+/g, ''), 10) || ++this.reqCounter;
    const agentNum = numericAgentId(req.agentId);

    await this.persistence.appendDecisionJournal(this.siteId, {
      id: `${this.siteId}-${req.id}-err-${nowMs}`,
      siteId: this.siteId,
      reqId: numericReqId,
      agentId: agentNum,
      agentName: req.agentId,
      kind: req.kind,
      promptSummary: `ERROR: ${errorMsg}`,
      decision: null,
      note: `Brain error: ${errorMsg}`.slice(0, 120),
      model: this.modelName,
      latencyMs,
      tokensIn: 0,
      tokensOut: 0,
      error: errorMsg,
      createdAt: nowMs,
      expireAt: nowMs + JOURNAL_TTL_MS,
    });

    if (this.onHealthBroadcast) {
      this.onHealthBroadcast(this.getBrainHealthMessage(nowMs));
    }
  }
}
