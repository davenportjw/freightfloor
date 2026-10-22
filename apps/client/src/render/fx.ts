/**
 * Pure helpers for driver feedback effects: the overhead guide-arrow colour and the
 * floating callout text derived from sim events (fare / combo / trailer / poach / stop).
 * No canvas or DOM here so everything is unit-testable.
 */
import type { SimEvent } from '@warehouse/sim';

export type GuideKind = 'pick' | 'drop' | 'charge' | 'wait';

/** Palette (matches the renderer / styles.css accents). */
export const FX_COLORS = {
  pick: '#16A34A',
  drop: '#2563EB',
  p0: '#D97706',
  late: '#DC2626',
  charge: '#0D9488',
  wait: '#64748B',
} as const;

/** Minutes-left threshold under which the arrow turns red. */
export const LATE_MINUTES = 15;

/**
 * Overhead arrow colour. For pick/drop targets: red when the order has < 15 game-min
 * left, else gold for P0, else green (pick) / blue (drop). Charge = teal, wait = grey.
 */
export function arrowColor(kind: GuideKind | string, opts: { p0?: boolean; minutesLeft?: number | null } = {}): string {
  if (kind === 'pick' || kind === 'drop') {
    if (opts.minutesLeft != null && opts.minutesLeft < LATE_MINUTES) return FX_COLORS.late;
    if (opts.p0) return FX_COLORS.p0;
    return kind === 'pick' ? FX_COLORS.pick : FX_COLORS.drop;
  }
  if (kind === 'charge') return FX_COLORS.charge;
  return FX_COLORS.wait;
}

interface UrgencyOrder {
  id: number;
  p0: boolean;
  due: number;
  bay: string;
  slot: { ax: number; ay: number };
}

/**
 * P0 flag and minutes left for the order behind a pick/drop guide target. Pick: the
 * pallet at the target slot (or `guide.order.id`). Drop: the most urgent carried pallet
 * for the target bay (any carried pallet when the bay is unknown).
 */
export function guideUrgency(
  g: { kind: string; x?: number | null; y?: number | null; order?: { id: number; bay?: string } | null },
  t: number,
  orders: readonly UrgencyOrder[],
  cargo: readonly UrgencyOrder[],
  bayAt?: string | null,
): { p0: boolean; minutesLeft: number | null } {
  let pool: readonly UrgencyOrder[] = [];
  if (g.kind === 'pick') {
    const o = g.order
      ? orders.find((x) => x.id === g.order!.id)
      : orders.find((x) => x.slot.ax === g.x && x.slot.ay === g.y);
    pool = o ? [o] : [];
  } else if (g.kind === 'drop') {
    const bay = g.order?.bay ?? bayAt ?? null;
    const forBay = bay ? cargo.filter((o) => o.bay === bay) : [];
    pool = forBay.length ? forBay : cargo;
  }
  if (!pool.length) return { p0: false, minutesLeft: null };
  const minDue = Math.min(...pool.map((o) => o.due));
  return {
    p0: pool.some((o) => o.p0),
    minutesLeft: Number.isFinite(minDue) ? minDue - t : null,
  };
}

export type CalloutTone = 'good' | 'bad' | 'info';
export interface Callout {
  text: string;
  tone: CalloutTone;
}

/** How long a callout floats above the forklift (ms). */
export const CALLOUT_MS = 1500;

const RESET_REASON: Record<string, string> = {
  slow: 'SLOW TRIP',
  crash: 'CRASH',
  drop: 'PALLET DROPPED',
  skid: 'SKID',
};

function fmtCombo(c: number): string {
  return `×${Number.isInteger(c) ? c.toFixed(1) : String(c)}`;
}

/** Trimmed multiplier / points number: 1.5 → "1.5", 2 → "2", 1.25 → "1.25", 8.04 → "8". */
function trimNum(n: number, digits = 2): string {
  return String(Math.round(n * 10 ** digits) / 10 ** digits);
}

/**
 * Fare breakdown from the real `fare` event fields (`pts = base × ratingMul × combo × payoutMul`):
 * `8 → ×1.5 Speedy → ×1.5 combo = 18`. Multipliers equal to 1 are omitted; returns null when the
 * event lacks `base` / `ratingMul` (older server) or nothing multiplies — the caller keeps the
 * plain popup then.
 */
export function fareBreakdown(ev: SimEvent): string | null {
  if (typeof ev.base !== 'number' || typeof ev.ratingMul !== 'number') return null;
  const pts = Math.round(typeof ev.pts === 'number' ? ev.pts : 0);
  const rating = typeof ev.rating === 'string' ? ev.rating : 'normal';
  const combo = typeof ev.combo === 'number' ? ev.combo : 1;
  const payout = typeof ev.payoutMul === 'number' ? ev.payoutMul : 1;
  const parts: string[] = [];
  if (ev.ratingMul !== 1) parts.push(`×${trimNum(ev.ratingMul)} ${rating.charAt(0).toUpperCase()}${rating.slice(1)}`);
  if (combo !== 1) parts.push(`×${trimNum(combo)} combo`);
  if (payout !== 1) parts.push(`×${trimNum(payout)} cards`);
  if (!parts.length) return null;
  return `${trimNum(ev.base, 1)} → ${parts.join(' → ')} = ${pts}`;
}

/**
 * Callout for one sim event, or null when the event is not about this driver.
 * `myKey` is this client's card-hand key (clientId) so a card-poach against our
 * hand is shown even though the event's `vid` is the thief.
 */
export function calloutFor(ev: SimEvent, myVid: string | null, myKey?: string | null): Callout | null {
  if (!myVid && !myKey) return null;
  const vid = typeof ev.vid === 'string' ? ev.vid : null;
  if (ev.type === 'poach' && typeof ev.cardId === 'string') {
    const owner = typeof ev.owner === 'string' ? ev.owner : null;
    if (owner && (owner === myKey || owner === myVid)) return { text: 'CONTRACT POACHED!', tone: 'bad' };
    if (vid && vid === myVid) return { text: 'CONTRACT STOLEN!', tone: 'good' };
    return null;
  }
  // A collision names the at-fault driver as `vid`; the victim only gets the CRASH popup when the
  // sim judged it at fault too (`victimAtFault`). An innocent victim sees nothing.
  if (ev.type === 'incident' && myVid && ev.victim === myVid && vid !== myVid) {
    return ev.victimAtFault === true ? { text: 'CRASH!', tone: 'bad' } : null;
  }
  if (!vid || vid !== myVid) return null;
  switch (ev.type) {
    case 'fare': {
      const rating = typeof ev.rating === 'string' ? ev.rating : 'normal';
      const pts = Math.round(typeof ev.pts === 'number' ? ev.pts : 0);
      const combo = typeof ev.combo === 'number' ? ev.combo : 1;
      const text = fareBreakdown(ev) ?? `+${pts} ${rating.toUpperCase()}${combo > 1 ? ` ${fmtCombo(combo)}` : ''}`;
      return { text, tone: rating === 'speedy' ? 'good' : rating === 'slow' ? 'bad' : 'info' };
    }
    case 'combo_reset': {
      const reason = typeof ev.reason === 'string' ? (RESET_REASON[ev.reason] ?? ev.reason.toUpperCase()) : '';
      return { text: reason ? `COMBO RESET · ${reason}` : 'COMBO RESET', tone: 'bad' };
    }
    case 'trailer_closer': {
      const pts = Math.round(typeof ev.pts === 'number' ? ev.pts : 5);
      return { text: `TRAILER CLOSED +${pts}`, tone: 'good' };
    }
    case 'precision_stop':
      return { text: 'CRAZY STOP!', tone: 'good' };
    case 'fare_choice': {
      const id = typeof ev.orderId === 'number' ? `#${ev.orderId}` : '';
      if (ev.auto === true) return { text: `CO-PILOT PICKED ${id}`.trim(), tone: 'info' };
      return { text: `${ev.carpool === true ? 'CARPOOL' : 'RESERVED'} ${id}`.trim(), tone: 'good' };
    }
    case 'rival_snipe': {
      const rival = typeof ev.rival === 'string' ? ev.rival : 'RIVAL';
      const id = typeof ev.orderId === 'number' ? ` #${ev.orderId}` : '';
      return { text: `${rival} SNIPED${id}`, tone: 'bad' };
    }
    case 'dispatchers_call_result': {
      // The reveal already covered a timeout; only a scored pick gets a popup.
      if (ev.timedOut === true) return null;
      const pts = Math.round(typeof ev.pts === 'number' ? ev.pts : 0);
      return { text: `+${pts} DISPATCHER'S CALL`, tone: pts > 0 ? 'good' : 'info' };
    }
    case 'rival_taunt': {
      const rival = typeof ev.rival === 'string' ? ev.rival : 'RIVAL';
      const score =
        typeof ev.theirs === 'number' && typeof ev.mine === 'number' ? ` ${ev.theirs}–${ev.mine}` : '';
      return { text: `${rival} WINS GRUDGE${score}`, tone: 'bad' };
    }
    case 'card': {
      // My own contract results (contract row flash happens in the contracts card).
      const text = typeof ev.text === 'string' ? ev.text : '';
      const pts = typeof ev.pts === 'number' ? Math.round(ev.pts) : Number(/\+(\d+) pts/.exec(text)?.[1] ?? NaN);
      const plus = Number.isFinite(pts) ? ` +${pts}` : '';
      if (text.startsWith('Contract done')) return { text: `CONTRACT DONE${plus}`, tone: 'good' };
      if (text.startsWith('Contract failed')) return { text: 'CONTRACT FAILED', tone: 'bad' };
      if (text.startsWith('Last Call')) return { text: `LAST CALL${plus}`, tone: 'good' };
      return null;
    }
    case 'incident':
      return { text: 'CRASH!', tone: 'bad' };
    case 'hazard':
      return { text: 'SKID!', tone: 'bad' };
    default:
      return null;
  }
}

/** How long a rival speech bubble stays over the rival's forklift (ms). */
export const BUBBLE_MS = 5000;

export interface RivalBubble {
  /** Vehicle the bubble floats over (the rival). */
  vid: string;
  text: string;
}

/**
 * Speech bubble over the rival for a `rival_snipe` / `rival_taunt` aimed at this driver: the
 * rival's real Gemini `reason` when present, else the event text. Never invents a quote.
 */
export function rivalBubbleFor(ev: SimEvent, myVid: string | null): RivalBubble | null {
  if (ev.type !== 'rival_snipe' && ev.type !== 'rival_taunt') return null;
  if (!myVid || ev.vid !== myVid) return null;
  if (typeof ev.rival !== 'string' || !ev.rival) return null;
  const reason = typeof ev.reason === 'string' ? ev.reason.trim() : '';
  const text = reason ? `“${reason}”` : (ev.text ?? '').trim();
  return text ? { vid: ev.rival, text } : null;
}

/** Greedy word wrap into at most `maxLines` lines of ≤ `maxChars` (last line ellipsised). */
export function wrapBubbleText(text: string, maxChars = 36, maxLines = 3): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w0 of words) {
    const w = w0.length > maxChars ? `${w0.slice(0, maxChars - 1)}…` : w0;
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars) {
      cur = next;
      continue;
    }
    if (lines.length === maxLines - 1) {
      // Out of lines: ellipsise the last one.
      lines.push(`${cur.length >= maxChars ? cur.slice(0, maxChars - 1) : cur}…`);
      return lines;
    }
    lines.push(cur);
    cur = w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Text colour for a callout tone. */
export function calloutColor(tone: CalloutTone): string {
  return tone === 'good' ? '#15803D' : tone === 'bad' ? '#B91C1C' : '#1D4ED8';
}
