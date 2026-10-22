/**
 * Dispatcher's Call — an A2UI minigame behind a feature flag (default ON).
 *
 * Once per human Blitz run, near the midpoint, when a REAL qualifying floor situation
 * exists (sim `detectDispatchersCallSituation`), the site asks Gemini (Vertex AI, ADC,
 * `responseSchema`-constrained, ~4 s timeout, budget-accounted, armor-sanitised) for a
 * short dispatch question with 2–3 concrete `DispatchParams` options plus its own hidden
 * pick. The player gets an A2UI screen with an 8 s deadline; the pick executes a real
 * `dispatchOrderRoute`; the sim scores the real outcome. If the model call fails there is
 * no minigame — the error is logged and the run's call is skipped. Nothing is fabricated.
 *
 * Everything here is pure or takes injected dependencies so it can be unit tested; the
 * Gemini client is passed in through `DispatchersCallModelClient`.
 */
import { GoogleGenAI } from '@google/genai';
import { assertNoUntrustedText, sanitiseOutputText } from '@warehouse/armor';
import {
  DISPATCH_MAX_COUNT,
  DISPATCH_MODES,
  DISPATCH_PRIORITIES,
  DISPATCH_SOURCE_ZONES,
  DISPATCH_TARGET_BAYS,
  type A2uiScreenMessage,
  type DispatchersCallMinigame,
  type DispatchersCallRevealMessage,
} from '@warehouse/protocol';
import {
  BLITZ_DURATION_MIN,
  detectDispatchersCallSituation,
  DISPATCHERS_CALL_MAX_OPTIONS,
  DISPATCHERS_CALL_MIN_OPTIONS,
  DISPATCHERS_CALL_PICK_MIN,
  dispatchersCallWindow,
  offerDispatchersCall,
  resolveDispatchersCallPick,
  skipDispatchersCall,
  type DispatchParams,
  type DispatchersCallSituation,
  type DispatchResult,
  type SimEvent,
  type Vehicle,
  type World,
} from '@warehouse/sim';
import {
  DEFAULT_GCP_PROJECT,
  DEFAULT_GEMINI_LOCATION,
  DEFAULT_GEMINI_MODEL,
  type RawBrainResponse,
} from './brain.js';
import { REAL_MS_PER_GAME_MIN } from './governance.js';
import type { PersistenceStore } from './persistence.js';

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

/**
 * `ENABLE_DISPATCHERS_CALL` — default ON; `0|false|off|no` switches it off cleanly
 * (no detection, no model calls, no screens).
 */
export function parseDispatchersCallFlag(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.ENABLE_DISPATCHERS_CALL;
  if (raw == null || raw.trim() === '') return true;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DISPATCHERS_CALL_MODEL_TIMEOUT_MS = 4000;
/** Player deadline in real ms (sim enforces `DISPATCHERS_CALL_PICK_MIN` game-min). */
export const DISPATCHERS_CALL_DEADLINE_MS = DISPATCHERS_CALL_PICK_MIN * REAL_MS_PER_GAME_MIN;
export const DISPATCHERS_CALL_QUESTION_MAX = 90;
export const DISPATCHERS_CALL_REASON_MAX = 90;
export const DISPATCHERS_CALL_LABEL_MAX = 48;
export const DISPATCHERS_CALL_SCREEN_TITLE = "Dispatcher's Call";

const RACK_ZONES = ['A', 'B', 'C', 'D', 'E', 'U', 'W', 'X', 'Z'] as const;

const ZONE_LABELS: Record<DispatchParams['sourceZone'], string> = {
  haz: 'Hazmat',
  cold: 'Cold',
  bulk: 'Bulk',
  high: 'High-value',
  general: 'General',
  any: 'Any zone',
  A: 'Zone A',
  B: 'Zone B',
  C: 'Zone C',
  D: 'Zone D',
  E: 'Zone E',
  U: 'High-value (U)',
  W: 'Cold (W)',
  X: 'Bulk (X)',
  Z: 'Hazmat (Z)',
};

const MODE_LABELS: Record<NonNullable<DispatchParams['mode']>, string> = {
  reroute_and_spawn: 'reroute + spawn',
  reroute_only: 'reroute only',
  spawn_only: 'spawn only',
};

// ---------------------------------------------------------------------------
// Telemetry + prompt (numeric / enum only — never player text)
// ---------------------------------------------------------------------------

export interface DispatchersCallTelemetry {
  situation: DispatchersCallSituation;
  runElapsedMin: number;
  runLeftMin: number;
  runPts: number;
  runDeliveries: number;
  runOnTime: number;
  /** Not-yet-delivered outbound orders per rack zone. */
  openByZone: Record<string, number>;
  bays: Array<{ id: string; load: number; cap: number; departing: boolean }>;
  /** Bay ids the model may target (existing, dispatchable bays plus `auto`). */
  targetBays: string[];
}

export function buildDispatchersCallTelemetry(
  w: World,
  v: Vehicle,
  situation: DispatchersCallSituation,
): DispatchersCallTelemetry {
  const openByZone: Record<string, number> = {};
  for (const z of RACK_ZONES) openByZone[z] = 0;
  for (const o of w.orders) {
    if (o.state === 'done' || o.putaway) continue;
    const z = o.slot.zone;
    if (z in openByZone) openByZone[z]++;
  }
  const allowed = new Set<string>(DISPATCH_TARGET_BAYS);
  const bays = w.bays
    .filter((b) => !b.isTransferBay && allowed.has(b.id))
    .map((b) => ({ id: b.id, load: b.load, cap: b.cap, departing: w.t < b.departUntil }));
  const started = v.runStartedAt ?? w.t;
  const ends = v.runEndsAt ?? started + BLITZ_DURATION_MIN;
  return {
    situation,
    runElapsedMin: Math.round((w.t - started) * 10) / 10,
    runLeftMin: Math.max(0, Math.round((ends - w.t) * 10) / 10),
    runPts: Math.round(v.runPts ?? 0),
    runDeliveries: v.runDeliveries ?? 0,
    runOnTime: v.runOnTime ?? 0,
    openByZone,
    bays,
    targetBays: [...bays.map((b) => b.id), 'auto'],
  };
}

export const DISPATCHERS_CALL_SYSTEM_INSTRUCTION = [
  'You are the floor dispatcher in a warehouse forklift game.',
  'Given live numeric telemetry about ONE real floor situation, write a short multiple-choice dispatch question for the driver.',
  `Rules: question <= ${DISPATCHERS_CALL_QUESTION_MAX} chars; 2 or 3 options; each option label <= ${DISPATCHERS_CALL_LABEL_MAX} chars;`,
  'each option is a concrete, meaningfully different dispatch (sourceZone, targetBay, priority, count, mode) that addresses the situation;',
  `count is 1-${DISPATCH_MAX_COUNT}; targetBay must be one of the listed target bays;`,
  `geminiPick is the 0-based index of the option you would choose; reason <= ${DISPATCHERS_CALL_REASON_MAX} chars explains your pick.`,
  'Return JSON only. Plain words, no markdown, no URLs.',
].join(' ');

/**
 * Render the model prompt from numeric telemetry. `untrusted` (player display names,
 * client ids) is asserted absent from the rendered text.
 */
export function renderDispatchersCallPrompt(
  t: DispatchersCallTelemetry,
  untrusted: readonly string[] = [],
): { systemInstruction: string; prompt: string } {
  const s = t.situation;
  const lines = [
    `situation=${s.kind}`,
    `spills=${s.spills} openP0=${s.openP0} hazmatOpen=${s.hazmatOpen} dockPutawayOpen=${s.dockOpen}`,
    `fullestLoadingBay=${s.bayId ?? 'none'} load=${s.bayLoad}/${s.bayCap}`,
    `run elapsed=${t.runElapsedMin}min left=${t.runLeftMin}min pts=${t.runPts} delivered=${t.runDeliveries} onTime=${t.runOnTime}`,
    `openByZone ${Object.entries(t.openByZone)
      .map(([z, n]) => `${z}=${n}`)
      .join(' ')}`,
    `bays ${t.bays.map((b) => `${b.id}=${b.load}/${b.cap}${b.departing ? '(departing)' : ''}`).join(' ')}`,
    `targetBays=${t.targetBays.join(',')}`,
    `sourceZones=${DISPATCH_SOURCE_ZONES.join(',')}`,
  ];
  const prompt = lines.join('\n');
  const list = untrusted.filter((x): x is string => typeof x === 'string' && x.length > 0);
  assertNoUntrustedText(DISPATCHERS_CALL_SYSTEM_INSTRUCTION, list);
  assertNoUntrustedText(prompt, list);
  return { systemInstruction: DISPATCHERS_CALL_SYSTEM_INSTRUCTION, prompt };
}

// ---------------------------------------------------------------------------
// Response schema + validation
// ---------------------------------------------------------------------------

/** Gemini `responseSchema` (OpenAPI subset); `targetBays` narrows the bay enum to this floor. */
export function dispatchersCallResponseSchema(targetBays: readonly string[]): Record<string, unknown> {
  return {
    type: 'OBJECT',
    properties: {
      question: { type: 'STRING', maxLength: String(DISPATCHERS_CALL_QUESTION_MAX) },
      options: {
        type: 'ARRAY',
        minItems: String(DISPATCHERS_CALL_MIN_OPTIONS),
        maxItems: String(DISPATCHERS_CALL_MAX_OPTIONS),
        items: {
          type: 'OBJECT',
          properties: {
            label: { type: 'STRING', maxLength: String(DISPATCHERS_CALL_LABEL_MAX) },
            sourceZone: { type: 'STRING', format: 'enum', enum: [...DISPATCH_SOURCE_ZONES] },
            targetBay: { type: 'STRING', format: 'enum', enum: [...targetBays] },
            priority: { type: 'STRING', format: 'enum', enum: [...DISPATCH_PRIORITIES] },
            count: { type: 'INTEGER', minimum: 1, maximum: DISPATCH_MAX_COUNT },
            mode: { type: 'STRING', format: 'enum', enum: [...DISPATCH_MODES] },
          },
          required: ['label', 'sourceZone', 'targetBay', 'priority', 'count', 'mode'],
          propertyOrdering: ['label', 'sourceZone', 'targetBay', 'priority', 'count', 'mode'],
        },
      },
      geminiPick: { type: 'INTEGER', minimum: 0, maximum: DISPATCHERS_CALL_MAX_OPTIONS - 1 },
      reason: { type: 'STRING', maxLength: String(DISPATCHERS_CALL_REASON_MAX) },
    },
    required: ['question', 'options', 'geminiPick', 'reason'],
    propertyOrdering: ['question', 'options', 'geminiPick', 'reason'],
  };
}

export interface DispatchersCallOption {
  idx: number;
  label: string;
  action: Required<DispatchParams>;
}

export interface DispatchersCallProposal {
  question: string;
  options: DispatchersCallOption[];
  geminiIdx: number;
  reason: string;
}

export type ParseResult =
  | { ok: true; value: DispatchersCallProposal }
  | { ok: false; error: string };

function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

/**
 * Strictly validate a model response: enums must match (bay must exist on this floor),
 * count is clamped to 1..DISPATCH_MAX_COUNT, text is armor-sanitised and length-capped,
 * options must be distinct actions. Any violation rejects the whole proposal.
 */
export function parseDispatchersCallResponse(
  text: string,
  targetBays: readonly string[],
): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'not_object' };
  const r = raw as Record<string, unknown>;
  const question = sanitiseOutputText(String(r.question ?? ''), DISPATCHERS_CALL_QUESTION_MAX);
  if (!question) return { ok: false, error: 'empty_question' };
  const reason = sanitiseOutputText(String(r.reason ?? ''), DISPATCHERS_CALL_REASON_MAX);
  if (!reason) return { ok: false, error: 'empty_reason' };
  if (!Array.isArray(r.options)) return { ok: false, error: 'options_missing' };
  if (r.options.length < DISPATCHERS_CALL_MIN_OPTIONS || r.options.length > DISPATCHERS_CALL_MAX_OPTIONS) {
    return { ok: false, error: 'option_count' };
  }
  const options: DispatchersCallOption[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < r.options.length; i++) {
    const o = r.options[i] as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') return { ok: false, error: `option_${i}_shape` };
    const label = sanitiseOutputText(String(o.label ?? ''), DISPATCHERS_CALL_LABEL_MAX);
    if (!label) return { ok: false, error: `option_${i}_label` };
    if (!oneOf(DISPATCH_SOURCE_ZONES, o.sourceZone)) return { ok: false, error: `option_${i}_zone` };
    if (!oneOf(DISPATCH_TARGET_BAYS, o.targetBay) || !targetBays.includes(o.targetBay)) {
      return { ok: false, error: `option_${i}_bay` };
    }
    if (!oneOf(DISPATCH_PRIORITIES, o.priority)) return { ok: false, error: `option_${i}_priority` };
    if (!oneOf(DISPATCH_MODES, o.mode)) return { ok: false, error: `option_${i}_mode` };
    const n = Number(o.count);
    if (!Number.isFinite(n)) return { ok: false, error: `option_${i}_count` };
    const action: Required<DispatchParams> = {
      sourceZone: o.sourceZone,
      targetBay: o.targetBay,
      priority: o.priority,
      count: Math.max(1, Math.min(DISPATCH_MAX_COUNT, Math.round(n))),
      mode: o.mode,
    };
    const key = JSON.stringify(action);
    if (seen.has(key)) return { ok: false, error: 'duplicate_options' };
    seen.add(key);
    options.push({ idx: i, label, action });
  }
  const pick = Number(r.geminiPick);
  if (!Number.isInteger(pick) || pick < 0 || pick >= options.length) {
    return { ok: false, error: 'gemini_pick' };
  }
  return { ok: true, value: { question, options, geminiIdx: pick, reason } };
}

/** Deterministic one-line description of a dispatch action (for the option button). */
export function describeDispatchAction(a: Required<DispatchParams>): string {
  const bay = a.targetBay === 'auto' ? 'best bay' : a.targetBay;
  const prio = a.priority === 'p0' ? 'P0' : a.priority === 'urgent' ? 'Urgent' : 'Standard';
  return `${ZONE_LABELS[a.sourceZone]} → ${bay} · ${prio} · ${a.count} pallet${a.count === 1 ? '' : 's'} · ${MODE_LABELS[a.mode]}`;
}

// ---------------------------------------------------------------------------
// Model client
// ---------------------------------------------------------------------------

export interface DispatchersCallModelClient {
  readonly model: string;
  generate(params: {
    systemInstruction: string;
    prompt: string;
    responseSchema: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<RawBrainResponse>;
}

/** Production Vertex AI client (ADC; never reads an API key). */
export class VertexDispatchersCallClient implements DispatchersCallModelClient {
  private readonly ai: GoogleGenAI;
  public readonly model: string;

  constructor(opts?: { projectId?: string; location?: string; model?: string }) {
    this.model = opts?.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
    this.ai = new GoogleGenAI({
      vertexai: true,
      project: opts?.projectId ?? process.env.GCP_PROJECT_ID ?? DEFAULT_GCP_PROJECT,
      location: opts?.location ?? process.env.GEMINI_LOCATION ?? DEFAULT_GEMINI_LOCATION,
    });
  }

  async generate(params: {
    systemInstruction: string;
    prompt: string;
    responseSchema: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<RawBrainResponse> {
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: params.prompt,
      config: {
        systemInstruction: params.systemInstruction,
        temperature: 0.4,
        maxOutputTokens: 400,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
        responseSchema: params.responseSchema,
        abortSignal: params.signal,
      },
    });
    const text = res.text ?? '';
    if (!text) throw new Error(`Empty response text from ${this.model}`);
    return {
      text,
      tokensIn: res.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: res.usageMetadata?.candidatesTokenCount ?? 0,
      model: this.model,
    };
  }
}

/** Run `fn` with an AbortSignal that fires after `ms`; rejects with a timeout error. */
export async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`Dispatcher's Call model timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([fn(ac.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Screen / reveal payloads
// ---------------------------------------------------------------------------

export type { DispatchersCallMinigame };

/**
 * `a2uiScreen` carrying the minigame. `recommendedDispatch` is required by the schema; it
 * is option 0, NOT Gemini's pick (that stays hidden until the reveal) and the client
 * does not render it for minigame screens.
 */
export type DispatchersCallScreen = A2uiScreenMessage & { minigame: DispatchersCallMinigame };

export type DispatchersCallReveal = DispatchersCallRevealMessage;

export const DISPATCHERS_CALL_OPTION_PREFIX = 'dc-opt-';

function situationPills(s: DispatchersCallSituation): DispatchersCallScreen['telemetry'] {
  const pills: DispatchersCallScreen['telemetry'] = [];
  if (s.spills > 0) pills.push({ id: 'spills', label: 'Spills', value: String(s.spills), tone: 'red' });
  if (s.openP0 > 0) pills.push({ id: 'p0', label: 'Open P0', value: String(s.openP0), tone: 'red' });
  if (s.bayId && s.bayCap > 0) {
    pills.push({
      id: 'bay',
      label: `Bay ${s.bayId}`,
      value: `${s.bayLoad}/${s.bayCap}`,
      tone: s.bayLoad / s.bayCap >= 0.75 ? 'amber' : 'neutral',
    });
  }
  if (s.hazmatOpen > 0) pills.push({ id: 'haz', label: 'Hazmat', value: String(s.hazmatOpen), tone: 'amber' });
  if (s.dockOpen > 0) pills.push({ id: 'dock', label: 'Dock', value: String(s.dockOpen), tone: 'neutral' });
  return pills;
}

export function buildDispatchersCallScreen(
  id: string,
  situation: DispatchersCallSituation,
  proposal: DispatchersCallProposal,
  deadlineT: number,
): DispatchersCallScreen {
  const options = proposal.options.map((o) => ({
    idx: o.idx,
    label: o.label,
    desc: describeDispatchAction(o.action),
    action: o.action,
  }));
  return {
    type: 'a2uiScreen',
    screenId: id,
    title: DISPATCHERS_CALL_SCREEN_TITLE,
    subtitle: proposal.question,
    telemetry: situationPills(situation),
    selectors: [],
    presets: options.map((o) => ({
      id: `${DISPATCHERS_CALL_OPTION_PREFIX}${o.idx}`,
      label: o.label,
      desc: o.desc,
      dispatch: o.action,
    })),
    recommendedDispatch: options[0].action,
    minigame: {
      id,
      kind: 'dispatchers_call',
      deadlineMs: DISPATCHERS_CALL_DEADLINE_MS,
      deadlineT,
      situation: situation.kind,
      question: proposal.question,
      options,
    },
  };
}

/** Parse an `a2uiAction.actionId` like `dc-opt-1` → 1 (null if not a minigame pick). */
export function parseDispatchersCallActionId(actionId: string): number | null {
  if (!actionId.startsWith(DISPATCHERS_CALL_OPTION_PREFIX)) return null;
  const n = Number(actionId.slice(DISPATCHERS_CALL_OPTION_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Coordinator (lifecycle)
// ---------------------------------------------------------------------------

export interface DispatchersCallLogger {
  error(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface DispatchersCallOffer {
  vid: string;
  clientId: string | null;
  screen: DispatchersCallScreen;
}

interface ActiveChallenge {
  id: string;
  vid: string;
  proposal: DispatchersCallProposal;
  model: string;
  latencyMs: number;
}

export type DispatchersCallPickOutcome =
  | { ok: true; reveal: DispatchersCallReveal; dispatch: DispatchResult }
  | { ok: false; error: 'no_challenge' | 'not_owner' | 'stale' | 'bad_option' };

export interface DispatchersCallCoordinatorOptions {
  enabled: boolean;
  client: DispatchersCallModelClient;
  budget: Pick<PersistenceStore, 'checkBudget' | 'recordUsage'>;
  logger?: DispatchersCallLogger;
  timeoutMs?: number;
  now?: () => number;
  /** Extra per-vehicle gate (e.g. live, non-bot connection that has not opted out). */
  eligible?: (v: Vehicle) => boolean;
  onOffer?: (offer: DispatchersCallOffer) => void;
}

/**
 * Drives detect → ask Gemini → offer screen → pick/timeout → reveal. Call `poll(world)`
 * from the site loop (e.g. once per game-minute), `handlePick` on an `a2uiAction`, and
 * `onSimEvent` for each sim event (turns a timeout result into a reveal).
 */
export class DispatchersCallCoordinator {
  private readonly inFlight = new Set<string>();
  private readonly active = new Map<string, ActiveChallenge>();
  private readonly logger: DispatchersCallLogger;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: DispatchersCallCoordinatorOptions) {
    this.logger = opts.logger ?? {
      error: (m, meta) => console.error(`[dispatchers-call] ${m}`, meta ?? {}),
      warn: (m, meta) => console.warn(`[dispatchers-call] ${m}`, meta ?? {}),
    };
    this.timeoutMs = opts.timeoutMs ?? DISPATCHERS_CALL_MODEL_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** Active (offered / awaiting reveal) challenge ids — for tests and health. */
  activeIds(): string[] {
    return [...this.active.keys()];
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  /**
   * Scan humans: skip runs whose window closed with nothing qualifying, and start a
   * model call for runs in the window with a real situation. Resolves when every call
   * started by this poll has finished.
   */
  poll(w: World): Promise<void> {
    if (!this.opts.enabled || w.phase !== 'running') return Promise.resolve();
    const tasks: Promise<void>[] = [];
    for (const v of w.vehicles) {
      if (!v.human || this.inFlight.has(v.id)) continue;
      const win = dispatchersCallWindow(w, v);
      if (win === 'closed') {
        skipDispatchersCall(w, v, 'no_situation');
        continue;
      }
      if (win !== 'open') continue;
      if (this.opts.eligible && !this.opts.eligible(v)) continue;
      const situation = detectDispatchersCallSituation(w);
      if (!situation) continue;
      this.inFlight.add(v.id);
      tasks.push(
        this.ask(w, v, situation)
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error('call failed; no minigame this run', { vid: v.id, error: message });
            skipDispatchersCall(w, v, 'error');
          })
          .finally(() => {
            this.inFlight.delete(v.id);
          }),
      );
    }
    return Promise.all(tasks).then(() => undefined);
  }

  private async ask(w: World, v: Vehicle, situation: DispatchersCallSituation): Promise<void> {
    const runKey = v.runStartedAt;
    const budget = await this.opts.budget.checkBudget('agent', this.now());
    if (!budget.allowed) {
      this.logger.warn('agent budget exhausted; skipping', { vid: v.id });
      skipDispatchersCall(w, v, 'budget_exhausted');
      return;
    }
    const telemetry = buildDispatchersCallTelemetry(w, v, situation);
    const untrusted = [v.driver, v.ownerClientId, v.controlledByClientId].filter(
      (x): x is string => typeof x === 'string',
    );
    const started = this.now();
    let proposal: DispatchersCallProposal;
    let model = this.opts.client.model;
    try {
      const { systemInstruction, prompt } = renderDispatchersCallPrompt(telemetry, untrusted);
      const responseSchema = dispatchersCallResponseSchema(telemetry.targetBays);
      const raw = await withTimeout(this.timeoutMs, (signal) =>
        this.opts.client.generate({ systemInstruction, prompt, responseSchema, signal }),
      );
      model = raw.model ?? model;
      // Budget ledger failures are logged, never treated as a model failure (no re-call).
      try {
        await this.opts.budget.recordUsage('agent', raw.tokensIn, raw.tokensOut, undefined, this.now());
      } catch (usageErr) {
        this.logger.warn('usage record failed', {
          vid: v.id,
          error: usageErr instanceof Error ? usageErr.message : String(usageErr),
        });
      }
      const parsed = parseDispatchersCallResponse(raw.text, telemetry.targetBays);
      if (!parsed.ok) throw new Error(`invalid model response: ${parsed.error}`);
      proposal = parsed.value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('model call failed; no minigame this run', { vid: v.id, model, error: message });
      if (v.runStartedAt === runKey) skipDispatchersCall(w, v, 'model_error');
      return;
    }
    // The world kept ticking during the call: the run must be the same, the window still
    // open and the situation still real, otherwise no minigame.
    if (v.runStartedAt !== runKey || dispatchersCallWindow(w, v) !== 'open') return;
    const live = detectDispatchersCallSituation(w);
    if (!live) {
      skipDispatchersCall(w, v, 'situation_cleared');
      return;
    }
    const state = offerDispatchersCall(w, v, {
      situation: live,
      optionCount: proposal.options.length,
      geminiIdx: proposal.geminiIdx,
    });
    if (!state) return;
    this.active.set(state.id, {
      id: state.id,
      vid: v.id,
      proposal,
      model,
      latencyMs: Math.max(1, this.now() - started),
    });
    const screen = buildDispatchersCallScreen(
      state.id,
      live,
      proposal,
      Math.round((state.offeredAt + DISPATCHERS_CALL_PICK_MIN) * 10) / 10,
    );
    this.opts.onOffer?.({
      vid: v.id,
      clientId: v.controlledByClientId ?? v.ownerClientId ?? null,
      screen,
    });
  }

  /**
   * Resolve a player's pick for challenge `id` from vehicle `v` (the sender's vehicle).
   * The executed action is the server-stored option — client-supplied dispatch params
   * are ignored.
   */
  handlePick(w: World, v: Vehicle, id: string, optionIdx: number): DispatchersCallPickOutcome {
    const ch = this.active.get(id);
    if (!ch) return { ok: false, error: 'no_challenge' };
    if (ch.vid !== v.id) return { ok: false, error: 'not_owner' };
    const opt = ch.proposal.options[optionIdx];
    if (!opt) return { ok: false, error: 'bad_option' };
    const res = resolveDispatchersCallPick(w, v, id, { optionIdx, params: opt.action });
    if (!res.ok) {
      if (res.error !== 'bad_option') this.active.delete(id);
      return { ok: false, error: res.error };
    }
    this.active.delete(id);
    return {
      ok: true,
      dispatch: res.dispatch!,
      reveal: this.reveal(ch, optionIdx, res.dispatch!, res.state.evalUntil),
    };
  }

  /**
   * Feed sim events. A timed-out `dispatchers_call_result` for an active challenge yields
   * the reveal (Gemini's pick + reason, no dispatch). Other results just clear state.
   */
  onSimEvent(ev: SimEvent): DispatchersCallReveal | null {
    if (ev.type !== 'dispatchers_call_result' || typeof ev.id !== 'string') return null;
    const ch = this.active.get(ev.id);
    if (!ch) return null;
    this.active.delete(ev.id);
    if (ev.timedOut !== true) return null;
    return this.reveal(ch, null, null, null);
  }

  private reveal(
    ch: ActiveChallenge,
    playerIdx: number | null,
    dispatch: DispatchResult | null,
    evalUntil: number | null,
  ): DispatchersCallReveal {
    const g = ch.proposal.options[ch.proposal.geminiIdx];
    return {
      type: 'dispatchersCallReveal',
      id: ch.id,
      playerIdx,
      geminiIdx: ch.proposal.geminiIdx,
      geminiLabel: g.label,
      geminiReason: ch.proposal.reason,
      agreed: playerIdx != null && playerIdx === ch.proposal.geminiIdx,
      timedOut: playerIdx == null,
      summary: dispatch ? dispatch.summary : null,
      orderIds: dispatch ? dispatch.orderIds.slice() : [],
      evalUntil,
    };
  }
}
