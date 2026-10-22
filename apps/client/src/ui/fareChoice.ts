/**
 * Pure view-model helpers for the manual driver's order choice (`QuantisedVehicleDelta.fareOffer`),
 * the rival pill and the rival's Gemini card-draft pill. Everything here is derived from real
 * server data (deltas / hands / decisions); no DOM.
 */
import type { FareClass, FareOffer, VehicleDecision } from '@warehouse/protocol';
import { FARE_CHOICE_TIMEOUT_MIN, XDOCK_BONUS as XDOCK_BONUS_PTS, type CardHand } from '@warehouse/sim';

/** Order colour classes, readable on the sepia HUD: short green, cross amber, long red, contract purple. */
export const FARE_CLASS_COLORS: Readonly<Record<FareClass, string>> = {
  short: '#15803D',
  cross: '#B45309',
  long: '#B91C1C',
  contract: '#7E22CE',
};

export const FARE_CLASS_LABELS: Readonly<Record<FareClass, string>> = {
  short: 'Short hop',
  cross: 'Cross-floor',
  long: 'Long haul',
  contract: 'Contract',
};

/** Key that cycles the highlighted option / key that confirms it. */
export const FARE_CYCLE_KEY = 'Q';
export const FARE_CONFIRM_KEY = 'F';

export interface FarePillView {
  orderId: number;
  /** '#42 → E2' */
  label: string;
  farClass: FareClass;
  classLabel: string;
  classColor: string;
  value: number;
  valueText: string;
  /** 'par 12s + 30s' (empty leg + loaded leg; 1 game-min = 1 real second). */
  parText: string;
  tiles: number;
  tilesText: string;
  isCopilot: boolean;
  carpool: boolean;
  p0: boolean;
  highlighted: boolean;
  /** Tooltip with the full breakdown. */
  title: string;
}

function fmtPar(p: number | null): string {
  return p == null ? '—' : `${Math.max(0, Math.round(p))}s`;
}

/** Wrap an index forward over `n` items (0 when there is nothing to cycle). */
export function cycleIndex(i: number, n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const cur = Number.isFinite(i) ? Math.trunc(i) : 0;
  return (((cur + 1) % n) + n) % n;
}

/** Clamp a highlighted index into the offer's option range. */
export function clampIndex(i: number, n: number): number {
  if (n <= 0) return 0;
  return Math.max(0, Math.min(n - 1, Number.isFinite(i) ? Math.trunc(i) : 0));
}

/** Whole seconds until the Co-Pilot auto-reserves (or a carpool offer lapses). Mirrors the sim. */
export function secondsLeft(
  offer: Pick<FareOffer, 'since'>,
  nowT: number,
  timeoutMin: number = FARE_CHOICE_TIMEOUT_MIN,
): number {
  return Math.max(0, Math.ceil(timeoutMin - (nowT - offer.since)));
}

/** 'Co-Pilot picks in 4s' / 'Carpool lapses in 4s'. */
export function countdownText(offer: Pick<FareOffer, 'since' | 'carpool'>, nowT: number): string {
  const s = secondsLeft(offer, nowT);
  return offer.carpool ? `Carpool lapses in ${s}s` : `Co-Pilot picks in ${s}s`;
}

/** Identity of an offer: the highlight resets when this changes. */
export function fareOfferKey(offer: FareOffer | null | undefined): string | null {
  if (!offer || !offer.options.length) return null;
  return `${offer.since}|${offer.carpool ? 1 : 0}|${offer.options.map((o) => o.orderId).join(',')}`;
}

/** Up to 3 option pills (server order: Co-Pilot pick first). */
export function optionPills(offer: FareOffer | null | undefined, highlightedIdx: number): FarePillView[] {
  if (!offer) return [];
  const hi = clampIndex(highlightedIdx, offer.options.length);
  return offer.options.map((o, i) => {
    const isCopilot = o.orderId === offer.copilotId;
    const parText = `par ${fmtPar(o.parEmpty)} + ${fmtPar(o.parLoaded)}`;
    const value = Math.round(o.value);
    const xdock = o.putaway && o.xdockBay && o.xdockLeft != null ? ` · ⇄ ${o.xdockBay} +${XDOCK_BONUS_PTS} · ${o.xdockLeft}s` : '';
    const dest = o.putaway ? `rack ${o.putawayRack ?? '?'}` : `bay ${o.bay}`;
    return {
      orderId: o.orderId,
      label: o.putaway ? `Inbound #${o.orderId} → ${o.putawayRack ?? 'rack'}${xdock}` : `#${o.orderId} → ${o.bay}`,
      farClass: o.farClass,
      classLabel: FARE_CLASS_LABELS[o.farClass],
      classColor: FARE_CLASS_COLORS[o.farClass],
      value,
      valueText: `${value} pts`,
      parText,
      tiles: o.tiles,
      tilesText: `${o.tiles} tiles`,
      isCopilot,
      carpool: o.carpool,
      p0: o.p0,
      highlighted: i === hi,
      title:
        `${FARE_CLASS_LABELS[o.farClass]}${o.p0 ? ' · P0' : ''}${o.carpool ? ' · Carpool' : ''} · ` +
        `${o.putaway ? 'Inbound ' : ''}#${o.orderId} → ${dest} · ${value} pts · ${o.tiles} tiles · ` +
        `empty-leg par ${fmtPar(o.parEmpty)}, loaded-leg par ${fmtPar(o.parLoaded)}` +
        (xdock ? ` · or cross-dock to bay ${o.xdockBay} within ${o.xdockLeft}s for +${XDOCK_BONUS_PTS}` : '') +
        `${isCopilot ? ' · ★ Co-Pilot pick' : ''}`,
    };
  });
}

/**
 * 'Rival FL-03 · 120 pts' from the rival vehicle's live sPts, or null when unknown / gone.
 * When our own live points are known, appends the head-to-head gap: '· you +5' / '· you −15' / '· tied'.
 */
export function rivalPillText(
  rivalId: string | null | undefined,
  vehicles: ReadonlyArray<{ id: string; sPts: number }>,
  myPts?: number | null,
): string | null {
  if (!rivalId) return null;
  const r = vehicles.find((v) => v.id === rivalId);
  if (!r) return null;
  const base = `Rival ${r.id} · ${Math.round(r.sPts)} pts`;
  if (myPts == null || !Number.isFinite(myPts)) return base;
  const gap = Math.round(myPts) - Math.round(r.sPts);
  return `${base} · ${gap === 0 ? 'tied' : `you ${gap > 0 ? '+' : '−'}${Math.abs(gap)}`}`;
}

/**
 * 'Rival drafted: <reason> (model)' once we hold active cards and no offer is pending, using the
 * rival's last REAL `cards` brain decision. Null when any piece is missing.
 */
export function rivalDraftText(
  hand: Pick<CardHand, 'offer' | 'cards'> | null | undefined,
  decision: Pick<VehicleDecision, 'kind' | 'reason' | 'model'> | null | undefined,
): string | null {
  if (!hand || (hand.offer && hand.offer.length)) return null;
  if (!hand.cards.some((c) => c.status === 'active')) return null;
  if (!decision || decision.kind !== 'cards' || !decision.reason) return null;
  return `Rival drafted: ${decision.reason}${decision.model ? ` (${decision.model})` : ''}`;
}
