import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { GoogleGenAI, type Decisions } from '@google/genai';
import { GoogleAuth } from 'google-auth-library';
import { assertNoUntrustedText } from '@warehouse/armor';
import {
  BRAIN_VARIANTS,
  GEMINI_DECISION_MODEL,
  type BrainVariant,
} from '@warehouse/protocol';
import {
  SKILLS,
  type Archetype,
  type CardOption,
  type ContractOption,
  type DecisionRequest,
  type HazardOption,
  type TacticsOption,
  type Vehicle,
  type World,
} from '@warehouse/sim';
import type { BrainModelClient, RawBrainResponse } from './brain.js';

export const DEFAULT_GEMINI_LOCATION = 'global';
export const DEFAULT_GCP_PROJECT =
  process.env.GCP_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  'davenporter-freightfloor';
export const BRAIN_CALL_TIMEOUT_MS = 4_000;
/** Card types built around beating the planner; never shown to AI agents. */
export const HUMAN_ONLY_CARD_TYPES: ReadonlySet<string> = new Set(
  SKILLS.filter((s) => s.humanOnly).map((s) => s.type),
);

/** Cooldown before re-probing `gemini-decision-1` after a provider billing/auth/availability error. */
export const DECISIONS_STANDBY_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Classifies upstream `gemini-decision-1` provider errors (e.g. HTTP 402 AI Studio prepay
 * credits depleted, 401/403 key restriction, 404 model rollout, 429/5xx, network timeout)
 * that warrant seamless hot-standby failover to Vertex AI `gemini-3.5-flash-lite`.
 */
export function isDecisionsProviderUnavailableError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (
    typeof status === 'number' &&
    (status === 401 ||
      status === 402 ||
      status === 403 ||
      status === 404 ||
      status === 429 ||
      status >= 500)
  ) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(401|402|403|404|429|500|502|503|504)\b|prepayment credits|RESOURCE_EXHAUSTED|PERMISSION_DENIED|UNAUTHENTICATED|API_KEY_INVALID|NOT_FOUND|fetch failed|ECONNRESET|ETIMEDOUT|timed out/i.test(
    msg,
  );
}

/** Primary fleet variant when Decisions API credentials (API key exception or ADC) are available. */
export const DEFAULT_DECISIONS_BRAIN_VARIANT: BrainVariant = 'decisions-batch';
/** Fallback variant (`gemini-3.5-flash-lite` on Vertex AI ADC) when no Decisions key/ADC is active. */
export const DEFAULT_BRAIN_VARIANT: BrainVariant = 'vertex-flash';
export const DEFAULT_HYBRID_CONFIDENCE_THRESHOLD = 0.45;
export const DECISIONS_ADC_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DECISIONS_REST_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';

/**
 * Explicit warehouse strategy rubrics for each AI archetype, shared between the
 * generative Vertex prompt cache (`brain.ts`) and the Decisions API (`gemini-decision-1`).
 */
export const PERSONA_RUBRICS: Readonly<Record<Archetype, string>> = {
  Sprinter:
    'Prioritize P0 urgent orders, tight-slack deadlines, nearby pickups, closing nearly-full trailers (bayFill near cap), and contesting rival targets; push or take short detours at spills.',
  Steady:
    'Prioritize uncontested open orders with comfortable slack, low aisle congestion, Clean Shift safety, and waiting or safe detours around spills; never push through spills.',
  Batcher:
    'When capacity >= 2, prioritize pairing 2 orders bound for the exact same outbound bay or cross-site transfer dock; favor Trailer Closer bays and batch/reach skill cards.',
  Opportunist:
    'Prioritize highest point value, RET hazmat containment (+6 bonus), closing nearly-full trailers (+5 bonus), poaching distant soft claims when closer, and sniping rival targets.',
  Strategist:
    'Optimize shift standings, cross-site transfers, active skill-card completion goals, combo preservation, and adaptive speed/buffer/chargeAt tuning based on backlog and incidents.',
};

export type DecisionsAdcMode = 'vertex' | 'oauth-adc';

export interface DecisionsAdcProbeResult {
  supported: boolean;
  mode: DecisionsAdcMode | null;
  checkedAt: number;
  detail: string;
}

let lastDecisionsAdcProbe: DecisionsAdcProbeResult | null = null;

export function getLastDecisionsAdcProbeResult(): DecisionsAdcProbeResult | null {
  return lastDecisionsAdcProbe;
}

export function setDecisionsAdcProbeResultForTesting(
  result: DecisionsAdcProbeResult | null,
): void {
  lastDecisionsAdcProbe = result;
}

export function resolveDecisionsApiKey(
  env: Record<string, string | undefined> = process.env,
  explicitKey?: string,
): string | null {
  const key =
    explicitKey?.trim() ||
    env.GEMINI_DECISIONS_API_KEY?.trim() ||
    env.GEMINI_API_KEY?.trim() ||
    env.GOOGLE_API_KEY?.trim();
  return key || null;
}

export function hasDecisionsCredentials(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(resolveDecisionsApiKey(env) || lastDecisionsAdcProbe?.supported);
}

/**
 * Resolves the active `BrainVariant`.
 * When `BRAIN_VARIANT` is unset or `'auto'`:
 *   - Uses `'decisions-batch'` (`gemini-decision-1`, $0.10/1M in, $0 out) whenever the
 *     Secret Manager / env Decisions API key exception is present OR daily ADC probing
 *     confirmed native ADC support.
 *   - Otherwise falls back to `'vertex-flash'` (`gemini-3.5-flash-lite` on Vertex AI ADC).
 */
export function resolveBrainVariant(
  value?: string | null,
  env: Record<string, string | undefined> = process.env,
): BrainVariant {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed || trimmed === 'auto') {
    return hasDecisionsCredentials(env)
      ? DEFAULT_DECISIONS_BRAIN_VARIANT
      : DEFAULT_BRAIN_VARIANT;
  }
  if ((BRAIN_VARIANTS as readonly string[]).includes(trimmed)) {
    return trimmed as BrainVariant;
  }
  throw new Error(
    `BRAIN_VARIANT=${JSON.stringify(value)} is not allowed; expected 'auto' or one of: ${BRAIN_VARIANTS.join(', ')}`,
  );
}

/**
 * Loads the approved Secret Manager API-key exception (`GEMINI_DECISIONS_SECRET_NAME`,
 * e.g. `projects/<project>/secrets/gemini-decisions-api-key/versions/latest`) at startup
 * when `GEMINI_DECISIONS_API_KEY` is not already set in the environment.
 * Missing secret versions (before operator upload) log a warning and fall back cleanly to
 * `gemini-3.5-flash-lite` on Vertex AI ADC.
 */
export async function loadDecisionsApiKeyFromSecretManager(opts?: {
  secretName?: string;
  siteId?: string;
}): Promise<string | null> {
  const existing = resolveDecisionsApiKey(process.env);
  if (existing) return existing;

  const secretName = opts?.secretName?.trim() || process.env.GEMINI_DECISIONS_SECRET_NAME?.trim();
  if (!secretName) return null;

  const tag = opts?.siteId ?? 'site';
  try {
    const sm = new SecretManagerServiceClient();
    const [version] = await sm.accessSecretVersion({ name: secretName });
    const raw = version.payload?.data;
    const decoded =
      typeof raw === 'string'
        ? raw.trim()
        : raw
          ? Buffer.from(raw).toString('utf8').trim()
          : '';
    if (decoded) {
      process.env.GEMINI_DECISIONS_API_KEY = decoded;
      console.log(
        `[${tag}] Loaded Gemini Decisions API key from Secret Manager (${secretName}); defaulting to BRAIN_VARIANT=decisions-batch`,
      );
      return decoded;
    }
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[${tag}] Gemini Decisions secret (${secretName}) unavailable (${msg}); running on Vertex AI gemini-3.5-flash-lite until secret version is added or ADC is enabled`,
    );
    return null;
  }
}

export interface DecisionsAdcProbeOptions {
  projectId?: string;
  location?: string;
  timeoutMs?: number;
  nowMs?: number;
  /** Injectable probes for deterministic unit testing. */
  tryVertex?: () => Promise<boolean>;
  tryOauthAdc?: () => Promise<boolean>;
}

/**
 * Probes whether Google Cloud Application Default Credentials (ADC) now support
 * `gemini-decision-1` (`POST /v1beta/decisions`), checking:
 *   1. Vertex AI SDK (`vertexai: true`, `apiVersion: 'v1beta'`)
 *   2. Google Cloud OAuth2 ADC Bearer token on `generativelanguage.googleapis.com/v1beta/decisions`
 *
 * Costs ~$0.0000015 (~15 input tokens, 0 output tokens) when it reaches the model.
 * Once `supported === true`, `SdkDecisionsApiTransport` automatically switches off the API key to ADC.
 */
export async function probeDecisionsAdcSupport(
  opts: DecisionsAdcProbeOptions = {},
): Promise<DecisionsAdcProbeResult> {
  const projectId = opts.projectId ?? process.env.GCP_PROJECT_ID ?? DEFAULT_GCP_PROJECT;
  const location = opts.location ?? process.env.GEMINI_LOCATION ?? DEFAULT_GEMINI_LOCATION;
  const timeoutMs = opts.timeoutMs ?? 4_000;
  const checkedAt = opts.nowMs ?? Date.now();

  const probePayload: Decisions.CreateDecisionRequest = {
    model: GEMINI_DECISION_MODEL,
    input: 'ok',
    questions: {
      adc_ping: {
        type: 'noul',
        instructions: 'Does input equal ok?',
      },
    },
  };

  const errors: string[] = [];

  // Path 1: Vertex AI endpoint (`vertexai: true`)
  try {
    const ok = opts.tryVertex
      ? await opts.tryVertex()
      : await (async () => {
          const vertexAi = new GoogleGenAI({
            vertexai: true,
            project: projectId,
            location,
            apiVersion: 'v1beta',
          });
          const res = await vertexAi.decisions.create(
            { ...probePayload, api_version: 'v1beta' },
            { timeout_ms: timeoutMs },
          );
          return Boolean(res.answers?.adc_ping);
        })();
    if (ok) {
      const result: DecisionsAdcProbeResult = {
        supported: true,
        mode: 'vertex',
        checkedAt,
        detail: `Vertex AI ADC (${projectId}/${location}) now supports ${GEMINI_DECISION_MODEL}`,
      };
      lastDecisionsAdcProbe = result;
      return result;
    }
  } catch (err) {
    errors.push(`vertex: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Path 2: Google Cloud OAuth2 ADC Bearer token on generativelanguage.googleapis.com
  try {
    const ok = opts.tryOauthAdc
      ? await opts.tryOauthAdc()
      : await (async () => {
          const auth = new GoogleAuth({
            scopes: [
              'https://www.googleapis.com/auth/cloud-platform',
              'https://www.googleapis.com/auth/generative-language',
            ],
          });
          const client = await auth.getClient();
          const tokenRes = await client.getAccessToken();
          const token = typeof tokenRes === 'string' ? tokenRes : tokenRes?.token;
          if (!token) throw new Error('No ADC OAuth2 access token available');
          const res = await fetch(DECISIONS_REST_ENDPOINT, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'x-goog-user-project': projectId,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(probePayload),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) {
            const bodyText = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${bodyText.slice(0, 140)}`);
          }
          const json = (await res.json()) as Decisions.CreateDecisionResponse;
          return Boolean(json.answers?.adc_ping);
        })();
    if (ok) {
      const result: DecisionsAdcProbeResult = {
        supported: true,
        mode: 'oauth-adc',
        checkedAt,
        detail: `OAuth2 ADC Bearer token (${projectId}) now supports ${GEMINI_DECISION_MODEL}`,
      };
      lastDecisionsAdcProbe = result;
      return result;
    }
  } catch (err) {
    errors.push(`oauth-adc: ${err instanceof Error ? err.message : String(err)}`);
  }

  const result: DecisionsAdcProbeResult = {
    supported: false,
    mode: null,
    checkedAt,
    detail: errors.join(' | ').slice(0, 280) || 'ADC not yet supported for gemini-decision-1',
  };
  lastDecisionsAdcProbe = result;
  return result;
}

/**
 * Starts a background 24-hour check for `gemini-decision-1` ADC support.
 * Timer is `.unref()`'d so it never blocks graceful exit; returns a cleanup function.
 */
export function startDailyDecisionsAdcMonitor(opts?: {
  siteId?: string;
  projectId?: string;
  location?: string;
  intervalMs?: number;
  probeOpts?: DecisionsAdcProbeOptions;
  onResult?: (res: DecisionsAdcProbeResult) => void;
}): () => void {
  const tag = opts?.siteId ?? 'site';
  const intervalMs = opts?.intervalMs ?? DECISIONS_ADC_CHECK_INTERVAL_MS;

  const runOnce = async () => {
    try {
      const res = await probeDecisionsAdcSupport({
        projectId: opts?.projectId,
        location: opts?.location,
        ...opts?.probeOpts,
      });
      if (res.supported) {
        console.log(
          `[${tag}] [brain] ACTIONABLE: ${res.detail}! Switched ${GEMINI_DECISION_MODEL} transport to ADC; API key exception can now be retired.`,
        );
      } else {
        console.log(
          `[${tag}] [brain] Daily ${GEMINI_DECISION_MODEL} ADC check: still requires API key (${res.detail})`,
        );
      }
      opts?.onResult?.(res);
    } catch (err) {
      console.warn(
        `[${tag}] [brain] Daily ${GEMINI_DECISION_MODEL} ADC check errored: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  void runOnce();
  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

export interface DecisionsApiTransport {
  readonly authMode?: 'adc-vertex' | 'adc-oauth' | 'api-key';
  create(
    params: Decisions.CreateDecisionRequest,
    signal?: AbortSignal,
  ): Promise<Decisions.CreateDecisionResponse>;
}

/**
 * Production `@google/genai` (>= 3.2) `v1beta` transport for `POST /v1beta/decisions`.
 * Automatically prefers Google Cloud ADC (`vertex` or `oauth-adc`) the moment the daily
 * ADC probe confirms support; otherwise uses the approved `GEMINI_DECISIONS_API_KEY` / `GEMINI_API_KEY` exception.
 */
export class SdkDecisionsApiTransport implements DecisionsApiTransport {
  private readonly apiKeyAi?: GoogleGenAI;
  private readonly vertexAi?: GoogleGenAI;
  private readonly oauthAuth?: GoogleAuth;
  private readonly projectId: string;

  constructor(opts?: { apiKey?: string; projectId?: string; location?: string }) {
    this.projectId = opts?.projectId ?? process.env.GCP_PROJECT_ID ?? DEFAULT_GCP_PROJECT;
    const location = opts?.location ?? process.env.GEMINI_LOCATION ?? DEFAULT_GEMINI_LOCATION;
    const apiKey = resolveDecisionsApiKey(process.env, opts?.apiKey);

    if (!apiKey && !lastDecisionsAdcProbe?.supported) {
      throw new Error(
        'Gemini Decisions API (gemini-decision-1) requires GEMINI_DECISIONS_API_KEY / GEMINI_API_KEY until Google Cloud ADC support is enabled.',
      );
    }

    if (apiKey) {
      this.apiKeyAi = new GoogleGenAI({
        apiKey,
        apiVersion: 'v1beta',
      });
    }
    this.vertexAi = new GoogleGenAI({
      vertexai: true,
      project: this.projectId,
      location,
      apiVersion: 'v1beta',
    });
    this.oauthAuth = new GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/generative-language',
      ],
    });
  }

  public get authMode(): 'adc-vertex' | 'adc-oauth' | 'api-key' {
    if (lastDecisionsAdcProbe?.supported) {
      return lastDecisionsAdcProbe.mode === 'vertex' ? 'adc-vertex' : 'adc-oauth';
    }
    return 'api-key';
  }

  async create(
    params: Decisions.CreateDecisionRequest,
    signal?: AbortSignal,
  ): Promise<Decisions.CreateDecisionResponse> {
    if (lastDecisionsAdcProbe?.supported && lastDecisionsAdcProbe.mode === 'vertex' && this.vertexAi) {
      return this.vertexAi.decisions.create(
        { ...params, api_version: 'v1beta' },
        {
          timeout_ms: BRAIN_CALL_TIMEOUT_MS,
          ...(signal ? { fetchOptions: { signal } } : {}),
        },
      );
    }

    if (lastDecisionsAdcProbe?.supported && lastDecisionsAdcProbe.mode === 'oauth-adc' && this.oauthAuth) {
      const client = await this.oauthAuth.getClient();
      const tokenRes = await client.getAccessToken();
      const token = typeof tokenRes === 'string' ? tokenRes : tokenRes?.token;
      if (token) {
        const res = await fetch(DECISIONS_REST_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'x-goog-user-project': this.projectId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(params),
          signal: signal ?? AbortSignal.timeout(BRAIN_CALL_TIMEOUT_MS),
        });
        if (res.ok) {
          return (await res.json()) as Decisions.CreateDecisionResponse;
        }
      }
    }

    if (!this.apiKeyAi) {
      throw new Error('No active ADC path or API key available for gemini-decision-1');
    }

    return this.apiKeyAi.decisions.create(
      { ...params, api_version: 'v1beta' },
      {
        timeout_ms: BRAIN_CALL_TIMEOUT_MS,
        ...(signal ? { fetchOptions: { signal } } : {}),
      },
    );
  }
}

export function collectUntrustedPlayerStrings(
  world: World,
  extraUntrustedStrings: readonly string[] = [],
): string[] {
  const untrusted: string[] = [...extraUntrustedStrings];
  for (const session of world.players.values()) {
    if (
      session.name &&
      session.name.trim().length >= 2 &&
      !/^P\d+$/i.test(session.name.trim())
    ) {
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
  return untrusted;
}

export function formatDirectiveLine(vehicle: Vehicle | undefined): string | null {
  const dir = vehicle?.directive;
  if (!dir) return null;
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
  if (dirParts.length === 0) return null;
  return dirParts.join(' ');
}

export interface CompiledDecisionQuestions {
  contextBlock: string;
  questions: Decisions.CreateDecisionRequest['questions'];
}

function safePrefix(rawPrefix: string): string {
  const cleaned = rawPrefix.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24);
  return cleaned ? `${cleaned}_` : '';
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, Number(n.toFixed(4))));
}

function formatPct(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return `${Math.round(n * 100)}% conf`;
}

const TACTICS_PROTOCOL_BOUNDS: Record<
  TacticsOption['param'],
  { min: number; max: number; integer: boolean }
> = {
  speed: { min: 0.6, max: 1.5, integer: false },
  buffer: { min: 1, max: 4, integer: true },
  respect: { min: 0.2, max: 1.0, integer: false },
  chargeAt: { min: 10, max: 45, integer: true },
  batch: { min: 1, max: 2, integer: true },
};

const TACTICS_RUBRIC_GUIDANCE: Record<
  TacticsOption['param'],
  readonly [string, string, string, string, string]
> = {
  speed: [
    'Cautious crawl: safest in heavy congestion or after crashes; lowest battery drain.',
    'Conservative pace: prioritizes collision-free Clean Shift over raw trip speed.',
    'Standard shift cruise: balanced throughput, aisle safety, and battery efficiency.',
    'Brisk sprint: clears backlog and P0 surges faster when incident count is low.',
    'Maximum overdrive: highest P0 & rival-race speed when aisles are clear and crash-free.',
  ],
  buffer: [
    '1-tile tight buffer: aggressive close following through busy aisles; higher near-miss risk.',
    '2-tile standard buffer: balanced spacing for normal warehouse traffic.',
    '3-tile wide buffer: defensive spacing that prevents collisions in dense intersections.',
    '4-tile maximum buffer: ultra-cautious yield distance after incidents or near-misses.',
    '4-tile maximum buffer: ultra-cautious yield distance.',
  ],
  respect: [
    'Low claim respect: aggressively poaches/contests soft claims and takes priority.',
    'Moderate-low respect: yields occasionally while pressing urgent deliveries.',
    'Balanced respect: cooperates with nearby fleet claims unless much closer.',
    'High respect: honors soft claims and yields cleanly at aisle bottlenecks.',
    'Full respect: strictly honors all teammate claims and yields right-of-way.',
  ],
  chargeAt: [
    'Deep-cycle (10%): maximizes continuous floor uptime before pit-stopping.',
    'Low threshold (~19%): runs long shifts, charging only when battery gets low.',
    'Balanced threshold (~28%): charges comfortably between contract waves.',
    'Conservative (~36%): keeps healthy battery reserve against Limp Mode.',
    'Early top-off (45%): prioritizes Juice Saver / high-battery safety reserve.',
  ],
  batch: [
    'Single-pallet (1): immediate point-to-point delivery with zero detour delay.',
    'Two-pallet batching (2): pairs compatible same-bay orders to double drop throughput.',
    'Two-pallet batching (2): pairs compatible same-bay orders.',
    'Two-pallet batching (2): pairs compatible same-bay orders.',
    'Two-pallet batching (2): pairs compatible same-bay orders.',
  ],
};

function buildLinearRubricLevels(
  param: TacticsOption['param'],
  minVal: number,
  maxVal: number,
  integer: boolean,
): { values: number[]; criteria: string[] } {
  const hints = TACTICS_RUBRIC_GUIDANCE[param];
  if (integer && maxVal - minVal <= 4) {
    const values: number[] = [];
    for (let v = Math.round(minVal); v <= Math.round(maxVal); v++) values.push(v);
    const criteria = values.map((v, idx) => `${param}=${v}: ${hints[Math.min(idx, hints.length - 1)]}`);
    return { values, criteria };
  }
  const steps = 5;
  const values: number[] = [];
  for (let i = 0; i < steps; i++) {
    const raw = minVal + (i / (steps - 1)) * (maxVal - minVal);
    values.push(integer ? Math.round(raw) : Number(raw.toFixed(2)));
  }
  const criteria = values.map((v, i) => `${param}=${v}: ${hints[i]}`);
  return { values, criteria };
}

function semanticOrderSignals(
  o: ContractOption,
  bayCounts: ReadonlyMap<string, number>,
  activeGoals: readonly string[] | undefined,
): string {
  const tags: string[] = [];
  if (o.p0) tags.push('P0_CRITICAL');
  if (o.slack <= 18) tags.push('DEADLINE_IMMINENT');
  else if (o.slack <= 35) tags.push('TIGHT_SLACK');
  else tags.push('SAFE_SLACK');

  if (o.distance <= 10) tags.push('VERY_CLOSE');
  else if (o.distance <= 22) tags.push('MEDIUM_DIST');
  else tags.push('LONG_HAUL');

  if (o.bayLoad !== undefined && o.bayCap !== undefined && o.bayCap > 0) {
    if (o.bayLoad >= o.bayCap - 1) tags.push('CLOSES_TRAILER_PLUS_5');
    else if (o.bayLoad / o.bayCap >= 0.75) tags.push('BAY_NEAR_FULL');
  }
  if (o.bay === 'RET') tags.push('RET_CONTAINMENT_PLUS_6');
  if ((bayCounts.get(o.bay) ?? 0) >= 2) tags.push('SAME_BAY_BATCH_PAIRABLE');
  if (o.claimant && o.claimant !== 'none') tags.push(`CLAIMED_BY_${o.claimant}_POACH`);
  else tags.push('UNCLAIMED_OPEN');
  if (o.isRivalTarget) tags.push('CONTESTS_RIVAL');

  if (activeGoals?.length) {
    const zone = (o.zone ?? '').toUpperCase();
    const matchesGoal = activeGoals.some((g) => {
      if (g.startsWith('trailer_closer:') && o.bayLoad !== undefined && o.bayCap !== undefined && o.bayLoad >= o.bayCap - 1) {
        return true;
      }
      if (g.startsWith('batch:') && (bayCounts.get(o.bay) ?? 0) >= 2) return true;
      if (g.startsWith(`route(${zone}->${o.bay}):`)) return true;
      return false;
    });
    if (matchesGoal) tags.push('ADVANCES_ACTIVE_CARD');
  }
  return tags.join(',');
}

/**
 * Compiles one `DecisionRequest` into a numeric context block and closed-set
 * `gemini-decision-1` questions (`choice`, `noul`, `score`).
 * Enforces `assertNoUntrustedText` across the context block, instructions, and criteria.
 */
export function buildDecisionQuestionsForRequest(
  world: World,
  req: DecisionRequest,
  keyPrefix = 'q',
  extraUntrustedStrings: readonly string[] = [],
): CompiledDecisionQuestions {
  const ctx = req.context;
  const pfx = safePrefix(keyPrefix);
  const rubric = PERSONA_RUBRICS[ctx.persona];
  const vehicle = world.vehicles.find((x) => x.id === req.agentId);
  const dirLine = formatDirectiveLine(vehicle);

  const headerLines = [
    `[${req.id}] agent=${ctx.agentId} persona=${ctx.persona} vehicle=${ctx.vehicleType} tile=(${ctx.tile.x},${ctx.tile.y}) battery=${Math.round(ctx.battery)}% cap=${ctx.capacity} cargo=${ctx.cargoCount} combo=${ctx.combo ?? 1}`,
    `standings: pts=${Math.round(ctx.shiftPts)} shipped=${ctx.shiftShipped} incidents=${ctx.incidents} nearMisses=${ctx.nearMisses} difficulty=${ctx.difficulty}${ctx.rivalScoreGap != null ? ` rivalGap=${ctx.rivalScoreGap >= 0 ? `+${ctx.rivalScoreGap}` : ctx.rivalScoreGap}` : ''}`,
    ...(ctx.activeGoals?.length ? [`activeGoals: ${ctx.activeGoals.join(', ')}`] : []),
    ...(dirLine ? [`activeDirective: ${dirLine}`] : []),
  ];

  const questions: Decisions.CreateDecisionRequest['questions'] = {};

  if (req.kind === 'contract') {
    const opts = req.options as ContractOption[];
    const criteria: Record<string, string> = {};
    const orderLines: string[] = [];
    const bayCounts = new Map<string, number>();

    for (const o of opts) {
      bayCounts.set(o.bay, (bayCounts.get(o.bay) ?? 0) + 1);
    }

    for (const o of opts) {
      const bayFill =
        o.bayLoad !== undefined && o.bayCap !== undefined ? `${o.bayLoad}/${o.bayCap}` : 'n/a';
      const signals = semanticOrderSignals(o, bayCounts, ctx.activeGoals);
      const desc = `Order ${o.orderId} [${signals}]: bay=${o.bay} (fill=${bayFill}) zone=${o.zone ?? o.district} district=${o.district} dist=${o.distance} slackMin=${o.slack} val=${o.value} p0=${o.p0 ? 1 : 0} xfer=${o.isTransfer ? 1 : 0} cong=${o.congestion} claimant=${o.claimant ?? 'none'} rivalTarget=${o.isRivalTarget ? 1 : 0}.`;
      criteria[String(o.orderId)] = desc;
      orderLines.push(`- ${desc}`);
    }

    headerLines.push('candidateOrders:', ...orderLines);

    if (opts.length >= 2) {
      questions[`${pfx}primary`] = {
        type: 'choice',
        instructions: `For [${req.id}] (${ctx.persona}: ${rubric}), which single orderId from [${req.id}]'s candidateOrders should vehicle ${ctx.agentId} claim first?`,
        criteria,
      };
    } else if (opts.length === 1) {
      // Choice requires >=2 options per Decisions API limits; single candidate uses a noul confirmation.
      questions[`${pfx}single`] = {
        type: 'noul',
        instructions: `For [${req.id}] (${ctx.persona}), is order ${opts[0].orderId} viable to claim right now?`,
      };
    }

    const canBatchSameBay =
      ctx.capacity >= 2 && [...bayCounts.values()].some((count) => count >= 2);
    if (canBatchSameBay) {
      questions[`${pfx}batch`] = {
        type: 'noul',
        instructions: `For [${req.id}] (${ctx.persona}: ${rubric}), should vehicle ${ctx.agentId} pair a second compatible same-bay order from [${req.id}]'s candidateOrders on this trip?`,
        criteria: {
          true_description:
            'Vehicle has capacity >= 2, sufficient slack/battery, and batching two same-bay pallets improves throughput.',
          false_description:
            'Single-pallet urgent sprint is safer due to tight P0 slack, low battery, or persona preference.',
        },
      };
    }
  } else if (req.kind === 'hazard') {
    const rawOpts = req.options as HazardOption[];
    const validOpts = rawOpts.filter(
      (o) => !(o.choice === 'reroute' && o.detourLen === null),
    );
    const opts = validOpts.length > 0 ? validOpts : rawOpts;
    const criteria: Record<string, string> = {};
    for (const o of opts) {
      criteria[o.choice] =
        `Choice ${o.choice}: detourTiles=${o.detourLen ?? 'none'}, spillClearsInMin=${o.timeLeft}, skidRisk=${o.skidRisk}.`;
    }
    headerLines.push(
      `hazard: spill #${ctx.hazardId ?? 0} at (${ctx.hazardTile?.x ?? 0},${ctx.hazardTile?.y ?? 0}) slackMin=${ctx.slack ?? 'none'}`,
      ...Object.values(criteria).map((c) => `- ${c}`),
    );
    questions[`${pfx}hazard`] = {
      type: 'choice',
      instructions: `For [${req.id}] (${ctx.persona}: ${rubric}), which hazard action should vehicle ${ctx.agentId} take for spill #${ctx.hazardId ?? 0}?`,
      criteria,
    };
  } else if (req.kind === 'cards') {
    const opts = (req.options as CardOption[]).filter(
      (o) => !HUMAN_ONLY_CARD_TYPES.has(o.cardType),
    );
    headerLines.push(
      'offeredCards:',
      ...opts.map((o) => {
        const perk =
          o.perk && Object.keys(o.perk).length
            ? ` perk=${Object.entries(o.perk)
                .map(([k, n]) => `${k}:${n}`)
                .join(',')}`
            : '';
        return `- id=${o.id} type=${o.cardType} rarity=${o.rarity ?? 'common'} pts=${o.pts} goal=${o.goal}${perk} title="${o.title}"`;
      }),
    );
    opts.forEach((o, idx) => {
      questions[`${pfx}card_${idx}`] = {
        type: 'noul',
        instructions: `For [${req.id}] (${ctx.persona}: ${rubric}), should vehicle ${ctx.agentId} keep shift card ${o.id} (${o.title}, type=${o.cardType}, rarity=${o.rarity ?? 'common'}, pts=${o.pts}, goal=${o.goal})?`,
      };
    });
  } else {
    // tactics: 5 linear rubric score questions
    const opts = req.options as TacticsOption[];
    headerLines.push(
      `currentTactics: ${opts.map((o) => `${o.param}=${o.current}[${o.min}..${o.max}]`).join(' ')}`,
    );
    for (const o of opts) {
      const protoBounds = TACTICS_PROTOCOL_BOUNDS[o.param];
      const minVal = Math.max(o.min, protoBounds.min);
      const maxVal = Math.min(o.max, protoBounds.max);
      const { criteria } = buildLinearRubricLevels(
        o.param,
        minVal,
        maxVal,
        protoBounds.integer,
      );
      questions[`${pfx}tac_${o.param}`] = {
        type: 'score',
        instructions: `For [${req.id}] (${ctx.persona}: ${rubric}), rate the optimal ${o.param} setting for vehicle ${ctx.agentId} given its shift metrics and incidents.`,
        criteria,
      };
    }
  }

  const contextBlock = headerLines.join('\n');
  const untrusted = collectUntrustedPlayerStrings(world, extraUntrustedStrings);
  assertNoUntrustedText(contextBlock, untrusted);
  assertNoUntrustedText(JSON.stringify(questions), untrusted);

  return { contextBlock, questions };
}

export interface MappedDecisionResult {
  text: string;
  output: string;
  confidence: number;
  probabilities?: Record<string, number>;
}

/**
 * Maps `CreateDecisionResponse.answers` for one `DecisionRequest` back into the canonical
 * JSON format consumed by `parseAndMapDecision` plus real `output`, `confidence`, and `probabilities`.
 */
export function mapDecisionAnswersForRequest(
  req: DecisionRequest,
  answers: NonNullable<Decisions.CreateDecisionResponse['answers']>,
  keyPrefix = 'q',
): MappedDecisionResult {
  const pfx = safePrefix(keyPrefix);

  if (req.kind === 'contract') {
    const opts = req.options as ContractOption[];
    if (opts.length === 0) {
      throw new Error('No contract options available');
    }
    let primaryId = String(opts[0].orderId);
    let confidence = 0.5;
    let probabilities: Record<string, number> | undefined;

    if (opts.length === 1) {
      const single = answers[`${pfx}single`];
      if (!single || single.type !== 'noul') {
        throw new Error(`Missing noul answer for ${pfx}single`);
      }
      confidence = clamp01(single.confidence);
      probabilities = { [primaryId]: clamp01(single.noul) };
    } else {
      const primary = answers[`${pfx}primary`];
      if (!primary || primary.type !== 'choice') {
        throw new Error(`Missing choice answer for ${pfx}primary`);
      }
      primaryId = primary.choice;
      confidence = clamp01(primary.confidence);
      probabilities = Object.fromEntries(
        Object.entries(primary.probabilities).map(([k, v]) => [k, clamp01(v)]),
      );
    }

    const orderIds: string[] = [primaryId];
    const primaryOpt = opts.find((o) => String(o.orderId) === primaryId) ?? opts[0];

    const batchAns = answers[`${pfx}batch`];
    if (
      batchAns &&
      batchAns.type === 'noul' &&
      batchAns.noul >= 0.5 &&
      req.context.capacity >= 2 &&
      probabilities
    ) {
      const partner = opts
        .filter((o) => String(o.orderId) !== primaryId && o.bay === primaryOpt.bay)
        .sort(
          (a, b) =>
            (probabilities?.[String(b.orderId)] ?? 0) -
            (probabilities?.[String(a.orderId)] ?? 0),
        )[0];
      if (partner) {
        orderIds.push(String(partner.orderId));
      }
    }

    const output = orderIds.map((id) => `#${id}`).join(' + ');
    const runnerUp = probabilities
      ? Object.entries(probabilities)
          .filter(([k]) => !orderIds.includes(k))
          .sort((a, b) => b[1] - a[1])[0]
      : undefined;
    const runnerText =
      runnerUp && runnerUp[1] >= 0.05 ? ` (vs #${runnerUp[0]} ${Math.round(runnerUp[1] * 100)}%)` : '';
    const reason = `${output} -> ${primaryOpt.bay} · ${formatPct(confidence)}${runnerText}`;

    return {
      text: JSON.stringify({ orderIds, reason }),
      output,
      confidence,
      ...(probabilities ? { probabilities } : {}),
    };
  }

  if (req.kind === 'hazard') {
    const ans = answers[`${pfx}hazard`];
    if (!ans || ans.type !== 'choice') {
      throw new Error(`Missing choice answer for ${pfx}hazard`);
    }
    const confidence = clamp01(ans.confidence);
    const probabilities = Object.fromEntries(
      Object.entries(ans.probabilities).map(([k, v]) => [k, clamp01(v)]),
    );
    const output = ans.choice;
    const reason = `${output} · ${formatPct(confidence)}`;
    return {
      text: JSON.stringify({ choice: ans.choice, reason }),
      output,
      confidence,
      probabilities,
    };
  }

  if (req.kind === 'cards') {
    const opts = (req.options as CardOption[]).filter(
      (o) => !HUMAN_ONLY_CARD_TYPES.has(o.cardType),
    );
    if (opts.length === 0) {
      throw new Error('No valid AI cards in offer');
    }
    const scored = opts.map((o, idx) => {
      const ans = answers[`${pfx}card_${idx}`];
      if (!ans || ans.type !== 'noul') {
        throw new Error(`Missing noul answer for ${pfx}card_${idx}`);
      }
      return { opt: o, prob: clamp01(ans.noul), conf: clamp01(ans.confidence) };
    });
    scored.sort((a, b) => b.prob - a.prob);

    const kept: CardOption[] = [scored[0].opt];
    let hasWild = scored[0].opt.rarity === 'wild';
    for (const cand of scored.slice(1)) {
      if (kept.length >= 2) break;
      if (cand.prob < 0.5) continue;
      if (cand.opt.rarity === 'wild' && hasWild) continue;
      kept.push(cand.opt);
      if (cand.opt.rarity === 'wild') hasWild = true;
    }

    const keep = kept.map((c) => c.id);
    const probabilities = Object.fromEntries(scored.map((s) => [s.opt.id, s.prob]));
    const confidence = clamp01(
      scored.slice(0, kept.length).reduce((acc, s) => acc + s.conf, 0) / kept.length,
    );
    const output = `keep ${keep.join(', ')}`;
    const reason = `${output} · ${formatPct(confidence)}`;
    return {
      text: JSON.stringify({ keep, reason }),
      output,
      confidence,
      probabilities,
    };
  }

  // tactics
  const opts = req.options as TacticsOption[];
  const values: Record<string, number> = {};
  const confidences: number[] = [];
  const probabilities: Record<string, number> = {};

  for (const o of opts) {
    const ans = answers[`${pfx}tac_${o.param}`];
    if (!ans || ans.type !== 'score') {
      throw new Error(`Missing score answer for ${pfx}tac_${o.param}`);
    }
    const protoBounds = TACTICS_PROTOCOL_BOUNDS[o.param];
    const minVal = Math.max(o.min, protoBounds.min);
    const maxVal = Math.min(o.max, protoBounds.max);
    const { values: levelValues } = buildLinearRubricLevels(
      o.param,
      minVal,
      maxVal,
      protoBounds.integer,
    );
    const maxIdx = Math.max(1, levelValues.length - 1);
    const norm = Math.max(0, Math.min(1, ans.score / maxIdx));
    const rawVal = minVal + norm * (maxVal - minVal);
    values[o.param] = protoBounds.integer
      ? Math.round(rawVal)
      : Number(rawVal.toFixed(2));
    confidences.push(clamp01(ans.confidence));
    probabilities[o.param] = clamp01(ans.confidence);
  }

  const confidence = clamp01(
    confidences.reduce((acc, c) => acc + c, 0) / Math.max(1, confidences.length),
  );
  const speed = values.speed ?? 1.0;
  const buffer = values.buffer ?? 2;
  const respect = values.respect ?? 0.8;
  const chargeAt = values.chargeAt ?? 22;
  const batch = values.batch ?? 1;
  const output = `spd ${speed.toFixed(2)} · buf ${buffer} · bat ${chargeAt}%`;
  const note = `${output} · ${formatPct(confidence)}`;

  return {
    text: JSON.stringify({ speed, buffer, respect, chargeAt, batch, note }),
    output,
    confidence,
    probabilities,
  };
}

function extractTotalInputTokens(res: Decisions.CreateDecisionResponse): number {
  const usage = res.usage as
    | { total_input_tokens?: number; total_tokens?: number }
    | undefined;
  return usage?.total_input_tokens ?? usage?.total_tokens ?? 0;
}

/**
 * Variant 2 (`BRAIN_VARIANT=decisions`): Per-agent Gemini Decisions API client (`gemini-decision-1`).
 */
export class GeminiDecisionsBrainClient implements BrainModelClient {
  public readonly model = GEMINI_DECISION_MODEL;
  private readonly transport: DecisionsApiTransport;

  constructor(opts?: { apiKey?: string; transport?: DecisionsApiTransport }) {
    this.transport = opts?.transport ?? new SdkDecisionsApiTransport({ apiKey: opts?.apiKey });
  }

  async generateDecision(params: {
    kind: DecisionRequest['kind'];
    systemInstruction: string;
    prompt: string;
    responseSchema: unknown;
    world?: World;
    req?: DecisionRequest;
    extraUntrustedStrings?: readonly string[];
  }): Promise<RawBrainResponse> {
    if (!params.world || !params.req) {
      throw new Error('GeminiDecisionsBrainClient requires world and DecisionRequest context');
    }
    const compiled = buildDecisionQuestionsForRequest(
      params.world,
      params.req,
      'q0',
      params.extraUntrustedStrings,
    );
    const res = await this.transport.create(
      {
        model: this.model,
        input: compiled.contextBlock,
        questions: compiled.questions,
      },
      AbortSignal.timeout(BRAIN_CALL_TIMEOUT_MS),
    );
    if (!res.answers) {
      throw new Error('Empty answers map from gemini-decision-1');
    }
    const mapped = mapDecisionAnswersForRequest(params.req, res.answers, 'q0');
    return {
      text: mapped.text,
      tokensIn: extractTotalInputTokens(res),
      tokensOut: 0,
      model: this.model,
      output: mapped.output,
      confidence: mapped.confidence,
      probabilities: mapped.probabilities,
    };
  }
}

/**
 * Variant 3 (`BRAIN_VARIANT=decisions-batch`): Tick-level multi-agent batching over `gemini-decision-1`.
 * Evaluates all ready `DecisionRequest`s on a tick in a SINGLE forward pass (`1` shared warehouse
 * header + per-agent sections, up to 1,000 questions).
 */
export class GeminiDecisionsBatchClient implements BrainModelClient {
  public readonly model = GEMINI_DECISION_MODEL;
  private readonly transport: DecisionsApiTransport;
  private readonly singleFallback: GeminiDecisionsBrainClient;

  constructor(opts?: { apiKey?: string; transport?: DecisionsApiTransport }) {
    this.transport = opts?.transport ?? new SdkDecisionsApiTransport({ apiKey: opts?.apiKey });
    this.singleFallback = new GeminiDecisionsBrainClient({ transport: this.transport });
  }

  async generateDecision(params: Parameters<BrainModelClient['generateDecision']>[0]): Promise<RawBrainResponse> {
    return this.singleFallback.generateDecision(params);
  }

  async generateBatchDecisions(params: {
    world: World;
    requests: readonly DecisionRequest[];
    extraUntrustedStrings?: readonly string[];
  }): Promise<Map<string, RawBrainResponse>> {
    const { world, requests, extraUntrustedStrings = [] } = params;
    const out = new Map<string, RawBrainResponse>();
    if (requests.length === 0) return out;

    const untrusted = collectUntrustedPlayerStrings(world, extraUntrustedStrings);
    const openP0 = world.orders.filter((o) => o.state !== 'done' && !o.putaway && o.p0).length;
    const baySummary = world.bays
      .filter((b) => !b.isTransferBay && b.cap > 0)
      .map((b) => `${b.id}:${b.load}/${b.cap}`)
      .join(' ');
    const sharedFloorHeader = `warehouseFloor t=${Math.round(world.t * 10) / 10} difficulty=${world.difficulty} openOrders=${world.orders.filter((o) => o.state === 'open').length} openP0=${openP0} spills=${world.spills.length} bays=[${baySummary}]`;
    assertNoUntrustedText(sharedFloorHeader, untrusted);

    const blocks: string[] = [sharedFloorHeader];
    const allQuestions: Decisions.CreateDecisionRequest['questions'] = {};
    const prefixes = new Map<string, string>();

    requests.forEach((req, idx) => {
      const pfx = `r${idx}`;
      prefixes.set(req.id, pfx);
      const compiled = buildDecisionQuestionsForRequest(world, req, pfx, extraUntrustedStrings);
      blocks.push(compiled.contextBlock);
      Object.assign(allQuestions, compiled.questions);
    });

    const res = await this.transport.create(
      {
        model: this.model,
        input: blocks.join('\n\n'),
        questions: allQuestions,
      },
      AbortSignal.timeout(BRAIN_CALL_TIMEOUT_MS),
    );
    if (!res.answers) {
      throw new Error('Empty answers map from batched gemini-decision-1 call');
    }

    const totalIn = extractTotalInputTokens(res);
    const perReqBase = Math.floor(totalIn / requests.length);
    let remainder = totalIn - perReqBase * requests.length;

    for (const req of requests) {
      const pfx = prefixes.get(req.id)!;
      const mapped = mapDecisionAnswersForRequest(req, res.answers, pfx);
      const shareIn = perReqBase + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      out.set(req.id, {
        text: mapped.text,
        tokensIn: shareIn,
        tokensOut: 0,
        model: this.model,
        output: mapped.output,
        confidence: mapped.confidence,
        probabilities: mapped.probabilities,
      });
    }

    return out;
  }
}

/**
 * Variant 4 (`BRAIN_VARIANT=hybrid`): Industry Planner + Chooser architecture.
 * - Fast path (Chooser): Tick-batched `gemini-decision-1` handles `hazard`, `contract`, and `cards`.
 * - Slow/Cognitive path (Planner + Confidence Cascade): Escalates to `planner` (`gemini-3.5-flash-lite`)
 *   for strategic `tactics` tuning AND whenever `gemini-decision-1` confidence falls below `confidenceThreshold`.
 */
export class HybridBrainClient implements BrainModelClient {
  public readonly model: string;
  public readonly confidenceThreshold: number;
  private readonly chooser: GeminiDecisionsBatchClient;
  private readonly planner: BrainModelClient;

  constructor(opts: {
    chooser: GeminiDecisionsBatchClient;
    planner: BrainModelClient;
    plannerModelName?: string;
    confidenceThreshold?: number;
  }) {
    this.chooser = opts.chooser;
    this.planner = opts.planner;
    this.confidenceThreshold =
      opts.confidenceThreshold ?? DEFAULT_HYBRID_CONFIDENCE_THRESHOLD;
    this.model = `hybrid(${GEMINI_DECISION_MODEL}+${opts.plannerModelName ?? 'gemini-3.5-flash-lite'})`;
  }

  async generateDecision(
    params: Parameters<BrainModelClient['generateDecision']>[0],
  ): Promise<RawBrainResponse> {
    if (params.kind === 'tactics' || !params.world || !params.req) {
      return this.planner.generateDecision(params);
    }
    const fast = await this.chooser.generateDecision(params);
    if (
      typeof fast.confidence === 'number' &&
      fast.confidence < this.confidenceThreshold
    ) {
      const escalated = await this.planner.generateDecision(params);
      return {
        ...escalated,
        tokensIn: fast.tokensIn + escalated.tokensIn,
        tokensOut: fast.tokensOut + escalated.tokensOut,
      };
    }
    return fast;
  }

  async generateBatchDecisions(params: {
    world: World;
    requests: readonly DecisionRequest[];
    extraUntrustedStrings?: readonly string[];
    renderPlannerParams: (req: DecisionRequest) => {
      systemInstruction: string;
      prompt: string;
      responseSchema: unknown;
    };
  }): Promise<Map<string, RawBrainResponse>> {
    const out = new Map<string, RawBrainResponse>();
    const fastReqs = params.requests.filter((r) => r.kind !== 'tactics');
    const plannerReqs = params.requests.filter((r) => r.kind === 'tactics');

    if (fastReqs.length > 0) {
      const batchMap = await this.chooser.generateBatchDecisions({
        world: params.world,
        requests: fastReqs,
        extraUntrustedStrings: params.extraUntrustedStrings,
      });
      for (const req of fastReqs) {
        const fast = batchMap.get(req.id);
        if (!fast) continue;
        if (
          typeof fast.confidence === 'number' &&
          fast.confidence < this.confidenceThreshold
        ) {
          plannerReqs.push(req);
          // Carry forward fast chooser input tokens so budget accounting stays exact.
          out.set(req.id, fast);
        } else {
          out.set(req.id, fast);
        }
      }
    }

    if (plannerReqs.length > 0) {
      await Promise.all(
        plannerReqs.map(async (req) => {
          const priorFast = out.get(req.id);
          const rendered = params.renderPlannerParams(req);
          const escalated = await this.planner.generateDecision({
            kind: req.kind,
            ...rendered,
            world: params.world,
            req,
            extraUntrustedStrings: params.extraUntrustedStrings,
          });
          out.set(req.id, {
            ...escalated,
            tokensIn: (priorFast?.tokensIn ?? 0) + escalated.tokensIn,
            tokensOut: (priorFast?.tokensOut ?? 0) + escalated.tokensOut,
          });
        }),
      );
    }

    return out;
  }
}
