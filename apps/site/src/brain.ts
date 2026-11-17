import { GoogleGenAI } from '@google/genai';
import { assertNoUntrustedText, sanitiseOutputText } from '@warehouse/armor';
import {
  ALLOWED_GEMINI_MODELS,
  type AllowedGeminiModel,
  type BrainVariant,
  CardsDecisionSchema,
  ContractDecisionSchema,
  GEMINI_DECISION_MODEL,
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
  type Archetype,
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
  estimateModelCallCostUsd,
  JOURNAL_TTL_MS,
  type DecisionJournalEntry,
  type PersistenceStore,
} from './persistence.js';
import {
  BRAIN_CALL_TIMEOUT_MS,
  buildDecisionQuestionsForRequest,
  collectUntrustedPlayerStrings,
  DECISIONS_ADC_CHECK_INTERVAL_MS,
  DECISIONS_STANDBY_COOLDOWN_MS,
  DEFAULT_BRAIN_VARIANT,
  DEFAULT_DECISIONS_BRAIN_VARIANT,
  DEFAULT_GCP_PROJECT,
  DEFAULT_GEMINI_LOCATION,
  DEFAULT_HYBRID_CONFIDENCE_THRESHOLD,
  GeminiDecisionsBatchClient,
  GeminiDecisionsBrainClient,
  getLastDecisionsAdcProbeResult,
  hasDecisionsCredentials,
  HUMAN_ONLY_CARD_TYPES,
  HybridBrainClient,
  isDecisionsProviderUnavailableError,
  loadDecisionsApiKeyFromSecretManager,
  mapDecisionAnswersForRequest,
  PERSONA_RUBRICS,
  probeDecisionsAdcSupport,
  resolveBrainVariant,
  resolveDecisionsApiKey,
  SdkDecisionsApiTransport,
  setDecisionsAdcProbeResultForTesting,
  startDailyDecisionsAdcMonitor,
  type DecisionsAdcMode,
  type DecisionsAdcProbeOptions,
  type DecisionsAdcProbeResult,
  type DecisionsApiTransport,
} from './brain-decisions.js';

export {
  BRAIN_CALL_TIMEOUT_MS,
  buildDecisionQuestionsForRequest,
  DECISIONS_ADC_CHECK_INTERVAL_MS,
  DECISIONS_STANDBY_COOLDOWN_MS,
  DEFAULT_BRAIN_VARIANT,
  DEFAULT_DECISIONS_BRAIN_VARIANT,
  DEFAULT_GCP_PROJECT,
  DEFAULT_GEMINI_LOCATION,
  DEFAULT_HYBRID_CONFIDENCE_THRESHOLD,
  GeminiDecisionsBatchClient,
  GeminiDecisionsBrainClient,
  getLastDecisionsAdcProbeResult,
  hasDecisionsCredentials,
  HUMAN_ONLY_CARD_TYPES,
  HybridBrainClient,
  isDecisionsProviderUnavailableError,
  loadDecisionsApiKeyFromSecretManager,
  mapDecisionAnswersForRequest,
  PERSONA_RUBRICS,
  probeDecisionsAdcSupport,
  resolveBrainVariant,
  resolveDecisionsApiKey,
  SdkDecisionsApiTransport,
  setDecisionsAdcProbeResultForTesting,
  startDailyDecisionsAdcMonitor,
  type BrainVariant,
  type DecisionsAdcMode,
  type DecisionsAdcProbeOptions,
  type DecisionsAdcProbeResult,
  type DecisionsApiTransport,
};

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
export const MAX_CONCURRENT_BRAIN_CALLS =
  Number(process.env.MAX_CONCURRENT_BRAIN_CALLS) > 0
    ? Number(process.env.MAX_CONCURRENT_BRAIN_CALLS)
    : 8;
/** Maximum Gemini brain calls per minute per shard (sliding 60 s window). */
export const BRAIN_MAX_CALLS_PER_MIN =
  Number(process.env.BRAIN_MAX_RPM) > 0 ? Number(process.env.BRAIN_MAX_RPM) : 120;
/** Total model attempts per decision (1 initial + 1 retry). */
export const BRAIN_MAX_ATTEMPTS = 2;
export const BRAIN_ERROR_BACKOFF_MS = 3000;
export const BRAIN_ERROR_BACKOFF_GAME_MIN = 3.0;

export interface BrainHealth {
  ok: boolean;
  model: string;
  variant?: BrainVariant;
  decisionsAuthMode?: 'adc-vertex' | 'adc-oauth' | 'api-key' | 'vertex-flash';
  decisionsAdcSupported?: boolean;
  decisionsAdcCheckedAt?: number;
  decisionsStandbyReason?: string;
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
  confidence?: number;
  probabilities?: Record<string, number>;
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
  output?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface BrainModelClient {
  generateDecision(params: {
    kind: DecisionKind;
    systemInstruction: string;
    prompt: string;
    responseSchema: unknown;
    world?: World;
    req?: DecisionRequest;
    extraUntrustedStrings?: readonly string[];
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
        // Decisions are ~20-35 output tokens (ids/enums + a <=40-char reason); 80 leaves
        // headroom for the tactics object without letting a runaway reply bill 120 tokens.
        maxOutputTokens: 80,
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
 * Static cached system instruction per archetype (never includes `agentId` or dynamic state,
 * maximizing implicit prefix cache hits across all 20 fleet vehicles on a shard).
 */
export const PERSONA_SYSTEM_INSTRUCTIONS: Readonly<Record<Archetype, string>> = {
  Sprinter: [
    'You are the onboard autonomous warehouse brain for a Sprinter archetype forklift.',
    `Strategy: ${PERSONA_RUBRICS.Sprinter}`,
    'Choose strictly from the provided options and return compact JSON matching the requested format.',
    'Keep reason/note under 40 characters, plain ASCII, no URLs or markdown.',
  ].join(' '),
  Steady: [
    'You are the onboard autonomous warehouse brain for a Steady archetype forklift.',
    `Strategy: ${PERSONA_RUBRICS.Steady}`,
    'Choose strictly from the provided options and return compact JSON matching the requested format.',
    'Keep reason/note under 40 characters, plain ASCII, no URLs or markdown.',
  ].join(' '),
  Batcher: [
    'You are the onboard autonomous warehouse brain for a Batcher archetype forklift.',
    `Strategy: ${PERSONA_RUBRICS.Batcher}`,
    'Choose strictly from the provided options and return compact JSON matching the requested format.',
    'Keep reason/note under 40 characters, plain ASCII, no URLs or markdown.',
  ].join(' '),
  Opportunist: [
    'You are the onboard autonomous warehouse brain for an Opportunist archetype forklift.',
    `Strategy: ${PERSONA_RUBRICS.Opportunist}`,
    'Choose strictly from the provided options and return compact JSON matching the requested format.',
    'Keep reason/note under 40 characters, plain ASCII, no URLs or markdown.',
  ].join(' '),
  Strategist: [
    'You are the onboard autonomous warehouse brain for a Strategist archetype forklift.',
    `Strategy: ${PERSONA_RUBRICS.Strategist}`,
    'Choose strictly from the provided options and return compact JSON matching the requested format.',
    'Keep reason/note under 40 characters, plain ASCII, no URLs or markdown.',
  ].join(' '),
};

export function personaSystemInstruction(persona: Archetype): string {
  return PERSONA_SYSTEM_INSTRUCTIONS[persona] ?? PERSONA_SYSTEM_INSTRUCTIONS.Steady;
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
  const systemInstruction = personaSystemInstruction(ctx.persona);

  const stateTags: string[] = [];
  if (ctx.combo !== undefined && ctx.combo > 1) stateTags.push(`combo=${ctx.combo}`);
  if (ctx.rivalScoreGap != null) {
    stateTags.push(`rivalGap=${ctx.rivalScoreGap >= 0 ? `+${ctx.rivalScoreGap}` : ctx.rivalScoreGap}`);
  }
  const stateSuffix = stateTags.length ? ` ${stateTags.join(' ')}` : '';
  const goalsLine =
    ctx.activeGoals && ctx.activeGoals.length > 0
      ? `ActiveGoals: ${ctx.activeGoals.join(', ')}`
      : null;

  let body = '';
  if (req.kind === 'contract') {
    const opts = req.options as ContractOption[];
    const lines = opts.map((o) => {
      const bayFill =
        o.bayLoad !== undefined && o.bayCap !== undefined ? ` bayFill=${o.bayLoad}/${o.bayCap}` : '';
      const rival = o.isRivalTarget ? ' rivalTarget=1' : '';
      return `- orderId="${o.orderId}" bay=${o.bay}${bayFill} zone=${o.zone ?? o.district} dist=${o.distance} slackMin=${o.slack} val=${o.value} p0=${o.p0 ? 1 : 0} xfer=${o.isTransfer ? 1 : 0} cong=${o.congestion} claimant=${o.claimant ?? 'none'}${rival}`;
    });
    body = [
      `Decision: contract`,
      `Agent: ${ctx.agentId} (${ctx.persona}, ${ctx.vehicleType}) at (${ctx.tile.x},${ctx.tile.y}) battery=${Math.round(ctx.battery)}% cap=${ctx.capacity} cargo=${ctx.cargoCount}${stateSuffix}`,
      ...(goalsLine ? [goalsLine] : []),
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
      `Agent: ${ctx.agentId} (${ctx.persona}, ${ctx.vehicleType}) at (${ctx.tile.x},${ctx.tile.y}) battery=${Math.round(ctx.battery)}% cargo=${ctx.cargoCount} slackMin=${ctx.slack ?? 'none'}${stateSuffix}`,
      `Spill #${ctx.hazardId ?? 0} ahead at (${ctx.hazardTile?.x ?? 0},${ctx.hazardTile?.y ?? 0}). Allowed choices:`,
      ...lines,
      `Output JSON format: {"choice":${choiceUnion},"reason":"short reason"}`,
    ].join('\n');
  } else if (req.kind === 'tactics') {
    const opts = req.options as TacticsOption[];
    const bounds = opts.map((o) => `${o.param}[${o.min}..${o.max},cur=${o.current}]`).join(' ');
    body = [
      `Decision: tactics`,
      `Agent: ${ctx.agentId} (${ctx.persona}, ${ctx.vehicleType}) shiftShipped=${ctx.shiftShipped} shiftPts=${Math.round(ctx.shiftPts)} incidents=${ctx.incidents} nearMisses=${ctx.nearMisses} difficulty=${ctx.difficulty}${stateSuffix}`,
      ...(goalsLine ? [goalsLine] : []),
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
      `Agent: ${ctx.agentId} (${ctx.persona}, ${ctx.vehicleType}) difficulty=${ctx.difficulty}`,
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

  const untrusted = collectUntrustedPlayerStrings(world, extraUntrustedStrings);

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
): { simDecision: Decision; wireDecision: Record<string, unknown>; note: string; output: string } {
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
    const output = orderIds.map((id) => `#${id}`).join(' + ');
    return {
      simDecision: { kind: 'contract', orderIds, reason: note },
      wireDecision: {
        orderIds: orderIds.map(String),
        orderId: orderIds[0],
        ...(orderIds[1] ? { secondOrderId: orderIds[1] } : {}),
        output,
        reason: note,
        note,
      },
      note,
      output,
    };
  }

  if (req.kind === 'hazard') {
    const normalized = {
      choice: parsed.choice ?? parsed.action,
      reason: String(parsed.reason ?? parsed.note ?? `Hazard: ${String(parsed.choice ?? parsed.action)}`),
    };
    const valid = HazardDecisionSchema.parse(normalized);
    const note = sanitiseOutputText(valid.reason, 120) || `Hazard: ${valid.choice}`;
    const output = valid.choice;
    return {
      simDecision: { kind: 'hazard', choice: valid.choice, reason: note },
      wireDecision: { choice: valid.choice, action: valid.choice, output, reason: note, note },
      note,
      output,
    };
  }

  if (req.kind === 'tactics') {
    const normalized = {
      ...parsed,
      note: String(parsed.note ?? parsed.reason ?? 'Retuned tactics'),
    };
    const valid = TacticsDecisionSchema.parse(normalized);
    const note = sanitiseOutputText(valid.note, 120) || 'Retuned tactics';
    const output = `spd ${valid.speed.toFixed(2)} · buf ${valid.buffer} · bat ${valid.chargeAt}%`;
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
        output,
        note,
      },
      note,
      output,
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
  const output = `keep ${valid.keep.join(', ')}`;
  return {
    simDecision: { kind: 'cards', keep: valid.keep, reason: note },
    wireDecision: { keep: valid.keep, keepIds: valid.keep, output, reason: note, note },
    note,
    output,
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
  /** Optional Vertex AI hot-standby client when `gemini-decision-1` returns 402/401/403/429/5xx. */
  standbyClient?: BrainModelClient | null;
  standbyCooldownMs?: number;
  variant?: BrainVariant;
  decisionsTransport?: DecisionsApiTransport;
  decisionsApiKey?: string;
  hybridConfidenceThreshold?: number;
  persistence: PersistenceStore;
  modelName?: string;
  maxConcurrent?: number;
  maxCallsPerMin?: number;
  retryDelayMs?: number;
  getArmorBlocks1h?: (nowMs: number) => number;
  onDecisionBroadcast?: (msg: BrainDecisionBroadcast) => void;
  onHealthBroadcast?: (health: BrainHealthMessage) => void;
}

export class AgentBrainScheduler {
  private readonly siteId: SiteId;
  private readonly client: BrainModelClient;
  private readonly batchClient?: GeminiDecisionsBatchClient;
  private readonly hybridClient?: HybridBrainClient;
  private readonly standbyClient?: BrainModelClient;
  private readonly standbyCooldownMs: number;
  public readonly variant: BrainVariant;
  private readonly persistence: PersistenceStore;
  public readonly modelName: string;
  public readonly plannerModelName: string;
  private readonly maxConcurrent: number;
  private readonly maxCallsPerMin: number;
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
  private decisionsStandbyUntilMs = 0;
  private decisionsStandbyReason?: string;
  private decisionsAdcStandbyBypassedAt = 0;

  constructor(opts: AgentBrainSchedulerOptions) {
    this.siteId = opts.siteId;
    this.variant = opts.variant ?? resolveBrainVariant(process.env.BRAIN_VARIANT);
    const plannerModelName = opts.modelName ?? resolveGeminiModel(process.env.GEMINI_MODEL);
    this.plannerModelName = plannerModelName;
    this.standbyCooldownMs = opts.standbyCooldownMs ?? DECISIONS_STANDBY_COOLDOWN_MS;

    if (opts.client) {
      this.client = opts.client;
      this.modelName =
        this.variant === 'decisions' || this.variant === 'decisions-batch'
          ? GEMINI_DECISION_MODEL
          : plannerModelName;
      if (opts.standbyClient) {
        this.standbyClient = opts.standbyClient;
      }
    } else if (this.variant === 'decisions') {
      this.client = new GeminiDecisionsBrainClient({
        apiKey: opts.decisionsApiKey,
        transport: opts.decisionsTransport,
      });
      this.modelName = GEMINI_DECISION_MODEL;
      if (opts.standbyClient !== null && (opts.standbyClient || !opts.decisionsTransport)) {
        this.standbyClient = opts.standbyClient ?? new VertexGeminiBrainClient({ model: plannerModelName });
      }
    } else if (this.variant === 'decisions-batch') {
      this.batchClient = new GeminiDecisionsBatchClient({
        apiKey: opts.decisionsApiKey,
        transport: opts.decisionsTransport,
      });
      this.client = this.batchClient;
      this.modelName = GEMINI_DECISION_MODEL;
      if (opts.standbyClient !== null && (opts.standbyClient || !opts.decisionsTransport)) {
        this.standbyClient = opts.standbyClient ?? new VertexGeminiBrainClient({ model: plannerModelName });
      }
    } else if (this.variant === 'hybrid') {
      const chooser = new GeminiDecisionsBatchClient({
        apiKey: opts.decisionsApiKey,
        transport: opts.decisionsTransport,
      });
      const planner = new VertexGeminiBrainClient({ model: plannerModelName });
      this.hybridClient = new HybridBrainClient({
        chooser,
        planner,
        plannerModelName,
        confidenceThreshold: opts.hybridConfidenceThreshold,
      });
      this.client = this.hybridClient;
      this.modelName = this.hybridClient.model;
      if (opts.standbyClient !== null && (opts.standbyClient || !opts.decisionsTransport)) {
        this.standbyClient = opts.standbyClient ?? planner;
      }
    } else {
      this.client = new VertexGeminiBrainClient({ model: plannerModelName });
      this.modelName = plannerModelName;
    }

    this.persistence = opts.persistence;
    this.maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT_BRAIN_CALLS;
    this.maxCallsPerMin = opts.maxCallsPerMin ?? BRAIN_MAX_CALLS_PER_MIN;
    this.retryDelayMs = opts.retryDelayMs ?? 120;
    this.getArmorBlocks1h = opts.getArmorBlocks1h;
    this.onDecisionBroadcast = opts.onDecisionBroadcast;
    this.onHealthBroadcast = opts.onHealthBroadcast;
  }

  public isStandbyActive(nowMs: number = Date.now()): boolean {
    if (!this.standbyClient || this.decisionsStandbyUntilMs <= nowMs) {
      return false;
    }
    const adcProbe = getLastDecisionsAdcProbeResult();
    if (adcProbe?.supported && adcProbe.checkedAt > this.decisionsAdcStandbyBypassedAt) {
      this.decisionsAdcStandbyBypassedAt = adcProbe.checkedAt;
      this.decisionsStandbyUntilMs = 0;
      this.decisionsStandbyReason = undefined;
      return false;
    }
    return true;
  }

  private enterStandby(rawReason: string, nowMs: number): void {
    const cleanReason = sanitiseOutputText(rawReason, 120) || 'Decisions API unavailable';
    const wasActive = this.decisionsStandbyUntilMs > nowMs;
    this.decisionsStandbyUntilMs = nowMs + this.standbyCooldownMs;
    this.decisionsStandbyReason = cleanReason;
    if (!wasActive) {
      console.warn(
        `[${this.siteId}] [brain] gemini-decision-1 unavailable (${cleanReason}); failing over to Vertex AI ${this.plannerModelName} standby for ${Math.round(this.standbyCooldownMs / 1000)}s.`,
      );
    }
  }

  private clearStandby(): void {
    if (this.decisionsStandbyUntilMs > 0 || this.decisionsStandbyReason) {
      this.decisionsStandbyUntilMs = 0;
      this.decisionsStandbyReason = undefined;
    }
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

    const adcProbe = getLastDecisionsAdcProbeResult();
    const onStandby = this.isStandbyActive(nowMs);
    const decisionsAuthMode: BrainHealth['decisionsAuthMode'] =
      this.variant === 'vertex-flash' || onStandby
        ? 'vertex-flash'
        : adcProbe?.supported
          ? adcProbe.mode === 'vertex'
            ? 'adc-vertex'
            : 'adc-oauth'
          : 'api-key';

    return {
      ok: !this.budgetPaused && errors1m === 0,
      model: onStandby ? this.plannerModelName : this.modelName,
      variant: this.variant,
      decisionsAuthMode,
      ...(adcProbe
        ? {
            decisionsAdcSupported: adcProbe.supported,
            decisionsAdcCheckedAt: adcProbe.checkedAt,
          }
        : {}),
      ...(onStandby && this.decisionsStandbyReason
        ? { decisionsStandbyReason: this.decisionsStandbyReason }
        : {}),
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

    this.pruneSamples(nowMs);

    // Tick-batched path for `decisions-batch` and `hybrid` variants when not on Vertex standby.
    if ((this.batchClient || this.hybridClient) && !this.isStandbyActive(nowMs) && candidates.length > 0) {
      if (this.inFlightReqIds.size < this.maxConcurrent && this.callSamples.length < this.maxCallsPerMin) {
        const batchSlice = candidates.slice(0, Math.max(1, this.maxConcurrent * 2));
        for (const r of batchSlice) this.inFlightReqIds.add(r.id);
        const batchPromise = this.executeBatchRequests(world, batchSlice, nowMs, extraUntrustedStrings)
          .catch((err) => {
            console.error(
              `[brain] batch(${batchSlice.length}) failed outside decision path: ${err instanceof Error ? err.message : String(err)}`,
            );
          })
          .finally(() => {
            for (const r of batchSlice) this.inFlightReqIds.delete(r.id);
          });
        if (opts.wait !== false) {
          await batchPromise;
        }
      }
      return;
    }

    const activeClientOverride = this.isStandbyActive(nowMs) ? this.standbyClient : undefined;
    const dispatched: Promise<void>[] = [];
    for (const req of candidates) {
      if (this.inFlightReqIds.size >= this.maxConcurrent) {
        break;
      }
      if (this.callSamples.length + this.inFlightReqIds.size >= this.maxCallsPerMin) {
        break;
      }
      dispatched.push(this.dispatchOne(world, req, nowMs, extraUntrustedStrings, activeClientOverride));
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
    clientOverride?: BrainModelClient,
  ): Promise<void> {
    this.inFlightReqIds.add(req.id);
    return this.executeRequest(world, req, nowMs, extraUntrustedStrings, clientOverride)
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
  private async recordUsageSafe(
    tokensIn: number,
    tokensOut: number,
    nowMs: number,
    modelForPricing?: string,
  ): Promise<void> {
    if (tokensIn <= 0 && tokensOut <= 0) return;
    try {
      const costUsd = estimateModelCallCostUsd(modelForPricing ?? this.modelName, tokensIn, tokensOut);
      const updatedBudget = await this.persistence.recordUsage('agent', tokensIn, tokensOut, costUsd, nowMs);
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

  private async executeBatchRequests(
    world: World,
    requests: readonly DecisionRequest[],
    nowMs: number,
    extraUntrustedStrings: readonly string[],
  ): Promise<void> {
    if (world.phase !== 'running' || requests.length === 0) return;

    const budget = await this.persistence.checkBudget('agent', nowMs);
    this.budgetPaused = !budget.allowed;
    this.lastBudgetLeftUsd = Math.max(0, Number((budget.capUsd - budget.spentUsd).toFixed(4)));
    if (!budget.allowed) {
      const errMsg = `Daily agent budget exhausted ($${budget.spentUsd.toFixed(2)}/$${budget.capUsd.toFixed(2)})`;
      for (const req of requests) {
        await this.recordBrainFailure(world, req, errMsg, 0, nowMs);
      }
      return;
    }

    const startMs = Date.now();
    let results: Map<string, RawBrainResponse>;
    try {
      if (this.hybridClient) {
        results = await this.hybridClient.generateBatchDecisions({
          world,
          requests,
          extraUntrustedStrings,
          renderPlannerParams: (req) => ({
            ...renderDecisionPrompt(world, req, extraUntrustedStrings),
            responseSchema: GEMINI_RESPONSE_SCHEMAS[req.kind],
          }),
        });
      } else if (this.batchClient) {
        results = await this.batchClient.generateBatchDecisions({
          world,
          requests,
          extraUntrustedStrings,
        });
      } else {
        return;
      }
      this.clearStandby();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (this.standbyClient && isDecisionsProviderUnavailableError(err)) {
        this.enterStandby(errMsg, nowMs);
        const fallbackSlice = requests.slice(0, this.maxConcurrent);
        await Promise.all(
          fallbackSlice.map((req) =>
            this.executeRequest(world, req, nowMs, extraUntrustedStrings, this.standbyClient),
          ),
        );
        return;
      }
      const latencyMs = Math.max(1, Date.now() - startMs);
      for (const req of requests) {
        await this.recordBrainFailure(world, req, errMsg, latencyMs, nowMs);
      }
      return;
    }

    const latencyMs = Math.max(1, Date.now() - startMs);
    let totalIn = 0;
    let totalOut = 0;
    let totalCostUsd = 0;
    const claimedInBatch = new Set<number>();

    // Apply hazard/cards/tactics first, then Sprinter P0 snipers, then 2-slot Batchers
    // (preserving compatible same-bay pairs before 1-slot trucks split them), then remaining archetypes.
    const archetypeOrder: Record<string, number> = {
      Sprinter: 0,
      Batcher: 1,
      Opportunist: 2,
      Strategist: 3,
      Steady: 4,
    };
    const orderedRequests = [...requests].sort((a, b) => {
      if (a.kind !== 'contract' && b.kind === 'contract') return -1;
      if (a.kind === 'contract' && b.kind !== 'contract') return 1;
      if (a.kind !== 'contract' && b.kind !== 'contract') return 0;
      const ra = archetypeOrder[a.context.persona] ?? 5;
      const rb = archetypeOrder[b.context.persona] ?? 5;
      return ra - rb;
    });

    for (const req of orderedRequests) {
      let raw = results.get(req.id);
      if (!raw) {
        await this.recordBrainFailure(world, req, 'Missing decision in batch response', latencyMs, nowMs);
        continue;
      }
      totalIn += raw.tokensIn;
      totalOut += raw.tokensOut;
      totalCostUsd += estimateModelCallCostUsd(raw.model ?? this.modelName, raw.tokensIn, raw.tokensOut);

      try {
        let mapped = parseAndMapDecision(req, raw.text);
        // Intra-batch probability de-confliction: when multiple trucks in the same forward pass
        // rank the same order #1 (or a non-poaching truck lands on an already soft-claimed order),
        // assign their highest-probability unclaimed open candidate from `gemini-decision-1`.
        const allowsPoach = req.context.persona === 'Opportunist' || req.context.persona === 'Sprinter';
        const hasConflict =
          req.kind === 'contract' &&
          raw.probabilities &&
          mapped.simDecision.kind === 'contract' &&
          mapped.simDecision.orderIds.some((id) => {
            const oid = Number(id);
            if (claimedInBatch.has(oid)) return true;
            if (!allowsPoach) {
              const wo = world.orders.find((o) => o.id === oid);
              if (wo?.claimant && wo.claimant !== req.agentId) return true;
            }
            return false;
          });
        if (hasConflict && raw.probabilities && mapped.simDecision.kind === 'contract') {
          const opts = req.options as ContractOption[];
          const rankedOpen = Object.entries(raw.probabilities)
            .filter(([oidStr]) => {
              const oid = Number(oidStr);
              if (claimedInBatch.has(oid)) return false;
              const worldOrder = world.orders.find((o) => o.id === oid);
              if (!worldOrder) return false;
              if (worldOrder.state === 'open') return true;
              return allowsPoach && worldOrder.state === 'claimed';
            })
            .sort((a, b) => {
              const woA = world.orders.find((o) => o.id === Number(a[0]));
              const woB = world.orders.find((o) => o.id === Number(b[0]));
              const unclaimedA = !woA?.claimant || woA.claimant === req.agentId ? 1 : 0;
              const unclaimedB = !woB?.claimant || woB.claimant === req.agentId ? 1 : 0;
              if (unclaimedA !== unclaimedB) return unclaimedB - unclaimedA;
              return b[1] - a[1];
            });
          if (rankedOpen.length > 0) {
            const [altId, altProb] = rankedOpen[0]!;
            const nextIds: string[] = [altId];
            if (mapped.simDecision.orderIds.length >= 2 && req.context.capacity >= 2) {
              const primaryOpt = opts.find((o) => String(o.orderId) === altId);
              const partnerEntry = rankedOpen.slice(1).find(([pid]) => {
                const pOpt = opts.find((o) => String(o.orderId) === pid);
                return Boolean(primaryOpt && pOpt && pOpt.bay === primaryOpt.bay);
              });
              if (partnerEntry) nextIds.push(partnerEntry[0]);
            }
            const altOutput = nextIds.map((id) => `#${id}`).join(' + ');
            const altConf = Math.max(0, Math.min(1, Number(altProb.toFixed(4))));
            const altReason = `${altOutput} · ${Math.round(altConf * 100)}% conf (batch de-conflicted)`;
            raw = {
              ...raw,
              text: JSON.stringify({ orderIds: nextIds, reason: altReason }),
              output: altOutput,
              confidence: altConf,
            };
            mapped = parseAndMapDecision(req, raw.text);
          }
        }

        const applied = applyDecision(world, req.id, mapped.simDecision, {
          model: raw.model ?? this.modelName,
          latencyMs,
          inputTokens: raw.tokensIn,
          outputTokens: raw.tokensOut,
          output: raw.output ?? mapped.output,
          confidence: raw.confidence,
        });
        if (!applied.ok) {
          if (applied.error === 'stale') continue;
          throw new Error(applied.detail || `Illegal ${req.kind} decision`);
        }
        if (mapped.simDecision.kind === 'contract') {
          for (const oid of mapped.simDecision.orderIds) claimedInBatch.add(Number(oid));
        }
        await this.recordAppliedDecision(req, raw, mapped, latencyMs, `[batch] ${req.kind}`, nowMs);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.recordBrainFailure(world, req, errMsg, latencyMs, nowMs);
      }
    }

    if (totalIn > 0 || totalOut > 0) {
      try {
        const updatedBudget = await this.persistence.recordUsage(
          'agent',
          totalIn,
          totalOut,
          totalCostUsd,
          nowMs,
        );
        this.lastBudgetLeftUsd = Math.max(
          0,
          Number((updatedBudget.agentCapUsd - updatedBudget.agentSpentUsd).toFixed(4)),
        );
        this.budgetPaused = updatedBudget.agentSpentUsd >= updatedBudget.agentCapUsd;
      } catch (err) {
        console.error(
          `[brain] batch usage record failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async recordAppliedDecision(
    req: DecisionRequest,
    raw: RawBrainResponse,
    mapped: ReturnType<typeof parseAndMapDecision>,
    latencyMs: number,
    promptSummary: string,
    nowMs: number,
  ): Promise<void> {
    this.callSamples.push({
      atMs: nowMs,
      latencyMs,
      tokensIn: raw.tokensIn,
      tokensOut: raw.tokensOut,
    });

    const numericReqId =
      Number.parseInt(req.id.replace(/\D+/g, ''), 10) || ++this.reqCounter;
    const agentNum = numericAgentId(req.agentId);
    const resolvedOutput = raw.output ?? mapped.output;

    const journalEntry: DecisionJournalEntry = {
      id: `${this.siteId}-${req.id}-${nowMs}`,
      siteId: this.siteId,
      reqId: numericReqId,
      agentId: agentNum,
      agentName: req.agentId,
      kind: req.kind,
      promptSummary: promptSummary.slice(0, 240),
      decision: mapped.wireDecision,
      note: mapped.note,
      model: raw.model ?? this.modelName,
      latencyMs,
      tokensIn: raw.tokensIn,
      tokensOut: raw.tokensOut,
      output: resolvedOutput,
      ...(raw.confidence !== undefined ? { confidence: raw.confidence } : {}),
      ...(raw.probabilities ? { probabilities: raw.probabilities } : {}),
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
        ...(raw.confidence !== undefined ? { confidence: raw.confidence } : {}),
        ...(raw.probabilities ? { probabilities: raw.probabilities } : {}),
      });
    }
  }

  private async executeRequest(
    world: World,
    req: DecisionRequest,
    nowMs: number,
    extraUntrustedStrings: readonly string[],
    clientOverride?: BrainModelClient,
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
    let activeClient: BrainModelClient = clientOverride ?? this.client;

    // Bounded retry: BRAIN_MAX_ATTEMPTS model calls with jittered backoff. Only the model call,
    // parse and sim apply are inside the loop; usage is recorded once after it.
    for (let attempt = 0; attempt < BRAIN_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0 && this.retryDelayMs > 0) {
        const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(this.retryDelayMs / 2)));
        await new Promise((r) => setTimeout(r, this.retryDelayMs + jitter));
      }

      try {
        let raw: RawBrainResponse;
        try {
          raw = await activeClient.generateDecision({
            kind: req.kind,
            systemInstruction,
            prompt,
            responseSchema,
            world,
            req,
            extraUntrustedStrings,
          });
          if (activeClient === this.client && this.variant !== 'vertex-flash') {
            this.clearStandby();
          }
        } catch (callErr) {
          if (
            activeClient === this.client &&
            this.standbyClient &&
            this.standbyClient !== activeClient &&
            isDecisionsProviderUnavailableError(callErr)
          ) {
            const errMsg = callErr instanceof Error ? callErr.message : String(callErr);
            this.enterStandby(errMsg, nowMs);
            activeClient = this.standbyClient;
            raw = await activeClient.generateDecision({
              kind: req.kind,
              systemInstruction,
              prompt,
              responseSchema,
              world,
              req,
              extraUntrustedStrings,
            });
          } else {
            throw callErr;
          }
        }
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
          output: raw.output ?? mapped.output,
          confidence: raw.confidence,
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
    await this.recordUsageSafe(usedTokensIn, usedTokensOut, nowMs, success?.raw.model);

    if (stale) return;

    if (success) {
      const { raw, mapped, latencyMs } = success;
      await this.recordAppliedDecision(req, raw, mapped, latencyMs, prompt, nowMs);
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
