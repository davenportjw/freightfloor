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

/** `FL-03 Sprinter: "<note>" · 410 ms` — null when there is no rival decision or its note is empty. */
export function rivalReasonText(
  rival: { id: string; strategy?: string | null } | null | undefined,
  decision: Pick<RivalDecision, 'vid' | 'note' | 'latencyMs'> | null | undefined,
): string | null {
  if (!rival || !decision || decision.vid !== rival.id) return null;
  const note = clipNote(decision.note ?? '');
  if (!note) return null;
  const who = rival.strategy ? `${rival.id} ${rival.strategy}` : rival.id;
  return `${who}: "${note}" · ${Math.round(decision.latencyMs)} ms`;
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
 * Top `max` rival decisions with a non-empty note, most consequential first (ties → most recent).
 * Returned in that order; empty when the log has none.
 */
export function selectRecapDecisions(
  decisions: readonly RivalDecision[],
  myOrderIds: ReadonlySet<string>,
  max = 3,
): RivalDecision[] {
  return decisions
    .filter((d) => clipNote(d.note ?? '').length > 0)
    .map((d, i) => ({ d, i, w: decisionWeight(d, myOrderIds) }))
    .sort((a, b) => b.w - a.w || b.d.at - a.d.at || b.i - a.i)
    .slice(0, max)
    .map((x) => x.d);
}

export interface AiRecap {
  rival: Array<{ vid: string; strategy?: string; kind: DecisionKind; note: string; latencyMs: number }>;
  directives: DirectiveEcho[];
}

/** The results-sheet recap, or null when there is nothing real to show (section omitted). */
export function buildAiRecap(
  log: RunAiLog | null | undefined,
  strategyOf: (vid: string) => string | undefined,
  maxDirectives = 5,
): AiRecap | null {
  if (!log) return null;
  const rival = selectRecapDecisions(log.rivalDecisions, log.myOrderIds).map((d) => ({
    vid: d.vid,
    strategy: strategyOf(d.vid),
    kind: d.kind,
    note: clipNote(d.note, 160),
    latencyMs: Math.round(d.latencyMs),
  }));
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

/** Recap line for one rival decision: `FL-03 Sprinter · contract: "<note>" · 410 ms`. */
export function recapDecisionText(r: AiRecap['rival'][number]): string {
  const who = r.strategy ? `${r.vid} ${r.strategy}` : r.vid;
  return `${who} · ${r.kind}: "${r.note}" · ${r.latencyMs} ms`;
}

/** Recap line for one Co-Pilot directive echo: `"stay left" → executed` / `→ not executed (reason)`. */
export function recapDirectiveText(d: DirectiveEcho): string {
  return `“${d.text}” → ${d.executed ? 'executed' : `not executed${d.reason ? ` (${d.reason})` : ''}`}`;
}
