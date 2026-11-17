/**
 * Real-AI insight helpers (pure, unit-tested):
 *   - the DRIVE rival reasoning pill (`FL-03 Sprinter: "<note>" · 410 ms`) from the server's
 *     `brainDecision` broadcast for MY rival (`me.rivalId`);
 *   - the results-sheet "You vs Gemini" recap (top rival decisions + my Co-Pilot directive echoes);
 *   - the 🛡 shield card for a Model-Armor-blocked command (`commandEcho.armor`).
 *
 * STRICT NEVER-MOCK: every string here is built from a real server message (verbatim model note,
 * measured latency, real armor layer / filter). When the data is absent the helpers return null /
 * empty and the UI shows nothing.
 */
import type { BrainDecisionMessage, CommandEchoMessage, DecisionKind } from '@warehouse/protocol';

/** A `brainDecision` resolved to a full vehicle id, stamped with client receive time. */
export interface RivalDecision {
  vid: string;
  reqId: number;
  kind: DecisionKind;
  note: string;
  latencyMs: number;
  model: string;
  decision: Record<string, unknown>;
  /** Calibrated confidence (0..1) when returned by a decision model. */
  confidence?: number;
  /** Calibrated per-option / per-level probabilities when returned by Decisions API. */
  probabilities?: Record<string, number>;
  /** `Date.now()` when the client received it (recency tie-break). */
  at: number;
}

/** One Co-Pilot directive / command echo from the server (`commandEcho`). */
export interface DirectiveEcho {
  text: string;
  executed: boolean;
  /** Server reason code when refused (e.g. `armor_blocked`). */
  reason?: string;
  summary?: string;
  at: number;
}

/** Per-run log the recap is built from (reset when a new run starts). */
export interface RunAiLog {
  runKey: string;
  rivalDecisions: RivalDecision[];
  directives: DirectiveEcho[];
  /** Order ids this run offered to / carried by me (contract decisions that touch them matter). */
  myOrderIds: Set<string>;
}

export const RUN_AI_LOG_CAP = 60;

export function createRunAiLog(runKey: string): RunAiLog {
  return { runKey, rivalDecisions: [], directives: [], myOrderIds: new Set() };
}

/** Push with a cap (oldest dropped). */
export function pushCapped<T>(list: T[], item: T, cap = RUN_AI_LOG_CAP): void {
  list.push(item);
  if (list.length > cap) list.splice(0, list.length - cap);
}

/**
 * Full vehicle id for a `brainDecision`: the message's `vid` when the server includes it, else the
 * AI vehicle whose id digits equal `agentId` (`FL-03` → 3; AI sequence numbers are site-unique).
 */
export function resolveDecisionVid(
  msg: Pick<BrainDecisionMessage, 'agentId' | 'vid'>,
  vehicles: ReadonlyArray<{ id: string; human?: boolean }>,
): string | null {
  if (typeof msg.vid === 'string' && msg.vid) return msg.vid;
  for (const v of vehicles) {
    if (v.human) continue;
    const digits = v.id.replace(/\D+/g, '');
    if (digits && Number.parseInt(digits, 10) === msg.agentId) return v.id;
  }
  return null;
}

/** Trim the model note for a one-line pill (verbatim text, just whitespace-collapsed + clipped). */
export function clipNote(note: string, max = 90): string {
  const t = note.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * Extract the concrete structured output from a `decision` payload (e.g. `#42`, `#42 + #19`,
 * `reroute`, `keep C1, C2`, `spd 1.15 · buf 2 · bat 20%`). Returns null when `decision` is empty.
 */
export function formatDecisionOutput(
  kind: DecisionKind | undefined,
  decision: Record<string, unknown> | null | undefined,
): string | null {
  if (!decision || typeof decision !== 'object') return null;
  if (typeof decision.output === 'string' && decision.output.trim().length > 0) {
    return decision.output.trim();
  }
  const ids = Array.isArray(decision.orderIds)
    ? decision.orderIds.filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => `#${String(x).replace(/^#/, '')}`)
    : decision.orderId !== undefined
      ? [`#${String(decision.orderId).replace(/^#/, '')}`]
      : [];
  if (ids.length > 0 && (!kind || kind === 'contract')) {
    return ids.join(' + ');
  }
  const choice = decision.choice ?? decision.action;
  if (typeof choice === 'string' && choice.trim().length > 0 && (!kind || kind === 'hazard')) {
    return choice.trim();
  }
  const keep = Array.isArray(decision.keep)
    ? decision.keep.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  if (keep.length > 0 && (!kind || kind === 'cards')) {
    return `keep ${keep.join(', ')}`;
  }
  if (typeof decision.speed === 'number' && Number.isFinite(decision.speed) && (!kind || kind === 'tactics')) {
    const buf = typeof decision.buffer === 'number' ? ` · buf ${decision.buffer}` : '';
    const bat = typeof decision.chargeAt === 'number' ? ` · bat ${Math.round(decision.chargeAt)}%` : '';
    return `spd ${decision.speed.toFixed(2)}${buf}${bat}`;
  }
  return null;
}

/** Format a calibrated `[0, 1]` confidence score as `88% conf` (null when absent). */
export function formatDecisionConfidence(confidence: number | null | undefined): string | null {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  const clamped = Math.max(0, Math.min(1, confidence));
  return `${Math.round(clamped * 100)}% conf`;
}

function isDistinctProseNote(note: string, output: string | null): boolean {
  if (!note) return false;
  if (/\b\d{1,3}%\s*conf\b/i.test(note)) return false;
  if (output && note.toLowerCase().startsWith(output.toLowerCase())) return false;
  return true;
}

/**
 * Formats my rival's decision pill:
 *   - Decision output + confidence: `FL-03 Sprinter → #42 · 88% conf · 180 ms`
 *   - Output + prose note: `FL-03 Sprinter → #42: "Grab the P0 at B2 first" · 410 ms`
 *   - Note only: `FL-03 Sprinter: "Grab the P0 at B2 first" · 410 ms`
 */
export function rivalReasonText(
  rival: { id: string; strategy?: string | null } | null | undefined,
  decision:
    | (Pick<RivalDecision, 'vid' | 'note' | 'latencyMs'> &
        Partial<Pick<RivalDecision, 'kind' | 'decision' | 'confidence'>>)
    | null
    | undefined,
): string | null {
  if (!rival || !decision || decision.vid !== rival.id) return null;
  const output = formatDecisionOutput(decision.kind, decision.decision);
  const conf = formatDecisionConfidence(decision.confidence);
  const note = clipNote(decision.note ?? '');
  if (!output && !conf && !note) return null;
  const who = rival.strategy ? `${rival.id} ${rival.strategy}` : rival.id;
  const ms = Math.round(decision.latencyMs);
  const head = [output, conf].filter(Boolean).join(' · ');
  if (head) {
    if (isDistinctProseNote(note, output)) {
      return `${who} → ${head}: "${note}" · ${ms} ms`;
    }
    return `${who} → ${head} · ${ms} ms`;
  }
  return `${who}: "${note}" · ${ms} ms`;
}

const KIND_WEIGHT: Record<DecisionKind, number> = { contract: 3, cards: 2, hazard: 2, tactics: 1 };

function decisionOrderIds(d: Record<string, unknown>): string[] {
  const ids = d.orderIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

/** How consequential a rival decision was for me (kind weight + touching my orders). */
export function decisionWeight(d: RivalDecision, myOrderIds: ReadonlySet<string>): number {
  let w = KIND_WEIGHT[d.kind] ?? 0;
  if (decisionOrderIds(d.decision).some((id) => myOrderIds.has(id))) w += 3;
  return w;
}

/**
 * Top `max` rival decisions with real content (note, structured output, or confidence),
 * most consequential first (ties → most recent). Returned in that order; empty when none.
 */
export function selectRecapDecisions(
  decisions: readonly RivalDecision[],
  myOrderIds: ReadonlySet<string>,
  max = 3,
): RivalDecision[] {
  return decisions
    .filter(
      (d) =>
        clipNote(d.note ?? '').length > 0 ||
        formatDecisionOutput(d.kind, d.decision) !== null ||
        formatDecisionConfidence(d.confidence) !== null,
    )
    .map((d, i) => ({ d, i, w: decisionWeight(d, myOrderIds) }))
    .sort((a, b) => b.w - a.w || b.d.at - a.d.at || b.i - a.i)
    .slice(0, max)
    .map((x) => x.d);
}

export interface AiRecap {
  rival: Array<{
    vid: string;
    strategy?: string;
    kind: DecisionKind;
    note: string;
    latencyMs: number;
    output?: string;
    confidence?: number;
  }>;
  directives: DirectiveEcho[];
}

/** The results-sheet recap, or null when there is nothing real to show (section omitted). */
export function buildAiRecap(
  log: RunAiLog | null | undefined,
  strategyOf: (vid: string) => string | undefined,
  maxDirectives = 5,
): AiRecap | null {
  if (!log) return null;
  const rival = selectRecapDecisions(log.rivalDecisions, log.myOrderIds).map((d) => {
    const output = formatDecisionOutput(d.kind, d.decision);
    return {
      vid: d.vid,
      strategy: strategyOf(d.vid),
      kind: d.kind,
      note: clipNote(d.note, 160),
      latencyMs: Math.round(d.latencyMs),
      ...(output ? { output } : {}),
      ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
    };
  });
  const directives = log.directives.slice(-maxDirectives);
  if (!rival.length && !directives.length) return null;
  return { rival, directives };
}

/** A Co-Pilot directive echo from a real `commandEcho` (null when it carries no text). */
export function directiveEchoFrom(msg: CommandEchoMessage, at: number): DirectiveEcho | null {
  const text = (msg.text ?? '').trim();
  if (!text) return null;
  const executed = msg.executed ?? msg.status === 'executed';
  return {
    text,
    executed: Boolean(executed),
    ...(msg.reason ? { reason: msg.reason } : {}),
    ...(msg.summary ? { summary: msg.summary } : {}),
    at,
  };
}

export interface ShieldCard {
  title: string;
  detail: string;
  strikes: number;
  muted: boolean;
}

/**
 * 🛡 card for a Model-Armor-blocked command: `🛡 Blocked · L2 input · pi_and_jailbreak`. Only for a
 * refused echo whose reason is `armor_blocked`; layer / filter come from the server's `armor`
 * field (when an older server omits it, the detail is just the reason code). `sessionStrikes` is
 * the client's per-session block count INCLUDING this one; the server's own strike count wins.
 */
export function shieldCardFor(msg: CommandEchoMessage, sessionStrikes: number): ShieldCard | null {
  const executed = msg.executed ?? msg.status === 'executed';
  if (executed || msg.reason !== 'armor_blocked') return null;
  const a = msg.armor;
  const detail = a ? `L${a.layer} ${a.stage === 'sanitizeModelResponse' ? 'output' : 'input'} · ${a.filter}` : 'armor_blocked';
  const strikes = Math.max(sessionStrikes, a?.strikes ?? 0);
  return { title: `🛡 Blocked · ${detail}`, detail, strikes, muted: Boolean(a?.muted) };
}

/** Recap line for one rival decision, surfacing decision output + confidence alongside any note. */
export function recapDecisionText(r: AiRecap['rival'][number]): string {
  const who = r.strategy ? `${r.vid} ${r.strategy}` : r.vid;
  const conf = formatDecisionConfidence(r.confidence);
  const head = [r.output, conf].filter(Boolean).join(' · ');
  if (head) {
    if (isDistinctProseNote(r.note, r.output ?? null)) {
      return `${who} · ${r.kind} → ${head}: "${r.note}" · ${r.latencyMs} ms`;
    }
    return `${who} · ${r.kind} → ${head} · ${r.latencyMs} ms`;
  }
  return `${who} · ${r.kind}: "${r.note}" · ${r.latencyMs} ms`;
}

/** Recap line for one Co-Pilot directive echo: `"stay left" → executed` / `→ not executed (reason)`. */
export function recapDirectiveText(d: DirectiveEcho): string {
  return `“${d.text}” → ${d.executed ? 'executed' : `not executed${d.reason ? ` (${d.reason})` : ''}`}`;
}
