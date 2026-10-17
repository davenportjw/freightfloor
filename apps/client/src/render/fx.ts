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
  g: { kind: string; x?: number | null; y?: number | null; order?: { id: number; bay: string } | null },
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
  if (!vid || vid !== myVid) return null;
  switch (ev.type) {
    case 'fare': {
      const rating = typeof ev.rating === 'string' ? ev.rating : 'normal';
      const pts = Math.round(typeof ev.pts === 'number' ? ev.pts : 0);
      const combo = typeof ev.combo === 'number' ? ev.combo : 1;
      const text = `+${pts} ${rating.toUpperCase()}${combo > 1 ? ` ${fmtCombo(combo)}` : ''}`;
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
    default:
      return null;
  }
}

/** Text colour for a callout tone. */
export function calloutColor(tone: CalloutTone): string {
  return tone === 'good' ? '#15803D' : tone === 'bad' ? '#B91C1C' : '#1D4ED8';
}
