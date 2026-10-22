/**
 * Contract card helpers (pure). The hand is `world.cards[you.clientId]`; "Keep N" sends every
 * selected id in one keepCards message. HUD v3 renders them in ui/contracts.ts (the right-hand
 * contracts card) and ui/contractPick.ts (the start-of-run pick sheet).
 */
import { HAND_LIMIT, PERK_CAPS, type Card } from '@warehouse/sim';

/** Identity of an offer (a new deal resets the selection). */
export function offerKey(offer: readonly Card[] | null | undefined): string | null {
  return offer && offer.length ? offer.map((c) => c.id).join(',') : null;
}

/** Starter card preselected (else the first card), like the mock. */
export function initialOfferSel(offer: readonly Card[] | null | undefined): Set<string> {
  if (!offer || !offer.length) return new Set();
  return new Set([(offer.find((c) => c.starter) ?? offer[0]).id]);
}

/**
 * Toggle a card in the offer selection. With `maxKeep === 1` (replacement draw:
 * "pick 1 of 2") selecting a card replaces the previous choice.
 */
export function toggleOfferSel(sel: ReadonlySet<string>, id: string, maxKeep?: number | null): Set<string> {
  if (maxKeep === 1) return sel.has(id) ? new Set() : new Set([id]);
  const next = new Set(sel);
  if (next.has(id)) next.delete(id);
  else if (maxKeep == null || next.size < maxKeep) next.add(id);
  return next;
}

/**
 * Pick-sheet toggle: keep 1..HAND_LIMIT cards (minus cards already active) with at most one wild
 * across the hand — the same rules the sim's keepCards enforces. Returns the unchanged selection
 * (and a reason) when the toggle would break a rule.
 */
export function togglePickSel(
  offer: readonly Pick<Card, 'id' | 'rarity'>[],
  sel: ReadonlySet<string>,
  id: string,
  opts: { pick?: number | null; activeCount?: number; activeWilds?: number } = {},
): { sel: Set<string>; blocked: string | null } {
  if (opts.pick === 1) return { sel: sel.has(id) ? new Set() : new Set([id]), blocked: null };
  const next = new Set(sel);
  if (next.has(id)) {
    next.delete(id);
    return { sel: next, blocked: null };
  }
  const card = offer.find((c) => c.id === id);
  if (!card) return { sel: next, blocked: null };
  const cap = Math.max(0, (opts.pick ?? HAND_LIMIT) - (opts.pick != null ? 0 : (opts.activeCount ?? 0)));
  if (next.size >= cap) return { sel: next, blocked: `You can keep at most ${cap} card${cap === 1 ? '' : 's'}.` };
  if (card.rarity === 'wild') {
    const wilds = (opts.activeWilds ?? 0) + offer.filter((c) => next.has(c.id) && c.rarity === 'wild').length;
    if (wilds >= 1) return { sel: next, blocked: 'You can hold at most one Wild card.' };
  }
  next.add(id);
  return { sel: next, blocked: null };
}

/** Ids to send, in offer order, restricted to cards still on offer. */
export function keepIds(offer: readonly Card[], sel: ReadonlySet<string>): string[] {
  return offer.filter((c) => sel.has(c.id)).map((c) => c.id);
}

export function keepLabel(n: number): string {
  return `Keep ${n} card${n === 1 ? '' : 's'}`;
}

/** Keep is allowed with 1..pick cards (pick unset → any number ≥ 1). */
export function canKeep(n: number, pick?: number | null): boolean {
  return n >= 1 && (pick == null || n <= pick);
}

/** Deal-panel heading: 'Pick 1 of 2' on replacement draws, else 'New contracts'. */
export function dealTitle(offer: readonly Card[], pick?: number | null): string {
  return pick != null ? `Pick ${pick} of ${offer.length}` : 'New contracts';
}

const pct = (x: number): string => `${Math.round(Math.abs(x) * 100)}%`;

/** Human-readable perk list, e.g. 'Perk: +8% speed · −15% battery drain'; null when the card has no perk. */
export function perkText(c: Pick<Card, 'perk'>): string | null {
  const p = c.perk;
  if (!p) return null;
  const parts: string[] = [];
  for (const [k, raw] of Object.entries(p)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    switch (k) {
      case 'speedMul':
        if (raw !== 1) parts.push(`${raw > 1 ? '+' : '−'}${pct(raw - 1)} speed`);
        break;
      case 'reachBonus':
        if (raw) parts.push(`+${Math.round(raw * 100) / 100} tile reach`);
        break;
      case 'batteryDrainMul':
        if (raw !== 1) parts.push(`${raw < 1 ? '−' : '+'}${pct(1 - raw)} battery drain`);
        break;
      case 'drainMul':
        if (raw !== 1) parts.push(`${raw < 1 ? '−' : '+'}${pct(1 - raw)} boost drain`);
        break;
      case 'forkLiftMul':
        if (raw !== 1) parts.push(`${raw > 1 ? '+' : '−'}${pct(raw - 1)} fork speed`);
        break;
      case 'chargeBonus':
        if (raw > 0) parts.push(`+${Math.round(raw)}%/s charge speed`);
        break;
      case 'comboFloor':
        if (raw > 0) parts.push(`combo resets only to ×${[1.0, 1.2, 1.5, 2.0][Math.min(3, Math.round(raw))].toFixed(1)}`);
        break;
      default:
        if (raw) parts.push(`${k} ${raw > 0 ? '+' : ''}${raw}`);
    }
  }
  return parts.length ? `Perk: ${parts.join(' · ')}` : null;
}

/** Aggregate unlocked perks across all completed cards in the driver's hand. */
export function activePerksSummary(cards: readonly Card[] | null | undefined): string | null {
  if (!cards || !cards.length) return null;
  const doneCards = cards.filter((c) => c.status === 'done' && c.perk);
  if (!doneCards.length) return null;
  let speedMul = 1;
  let reachBonus = 0;
  let batteryDrainMul = 1;
  let drainMul = 1;
  let chargeBonus = 0;
  let forkLiftMul = 1;
  let comboFloor = 0;
  for (const c of doneCards) {
    const p = c.perk;
    if (!p) continue;
    if (typeof p.speedMul === 'number') speedMul *= p.speedMul;
    if (typeof p.reachBonus === 'number') reachBonus += p.reachBonus;
    if (typeof p.batteryDrainMul === 'number') batteryDrainMul *= p.batteryDrainMul;
    if (typeof p.drainMul === 'number') drainMul *= p.drainMul;
    if (typeof p.chargeBonus === 'number') chargeBonus += p.chargeBonus;
    if (typeof p.forkLiftMul === 'number') forkLiftMul *= p.forkLiftMul;
    if (typeof p.comboFloor === 'number') comboFloor = Math.max(comboFloor, p.comboFloor);
  }
  // Same caps the sim applies in getCardModifiers.
  speedMul = Math.min(PERK_CAPS.speedMul, speedMul);
  reachBonus = Math.min(PERK_CAPS.reachBonus, reachBonus);
  batteryDrainMul = Math.max(PERK_CAPS.batteryDrainMul, batteryDrainMul);
  drainMul = Math.max(PERK_CAPS.boostDrainMul, drainMul);
  chargeBonus = Math.min(PERK_CAPS.chargeBonus, chargeBonus);
  forkLiftMul = Math.min(PERK_CAPS.forkLiftMul, forkLiftMul);
  comboFloor = Math.min(PERK_CAPS.comboFloor, comboFloor);
  const summary = perkText({
    perk: {
      ...(speedMul !== 1 ? { speedMul } : {}),
      ...(reachBonus > 0 ? { reachBonus } : {}),
      ...(batteryDrainMul !== 1 ? { batteryDrainMul } : {}),
      ...(drainMul !== 1 ? { drainMul } : {}),
      ...(chargeBonus > 0 ? { chargeBonus } : {}),
      ...(forkLiftMul !== 1 ? { forkLiftMul } : {}),
      ...(comboFloor > 0 ? { comboFloor } : {}),
    },
  });
  return summary ? summary.replace(/^Perk:\s*/, 'Active Perks: ') : null;
}

/** Route cards: the owner's pallets are reserved for 90 game-min (≈ 90 s), then anyone can poach them. */
export const ROUTE_RESERVE_HINT = 'Your pallets are reserved for 90 s, then rivals can poach them.';

export function cardColor(c: Card): string {
  return c.status === 'done' ? '#16A34A' : c.status === 'active' ? (c.rarity === 'wild' ? '#B45309' : '#7C3AED') : '#94A3B8';
}

export function cardKind(c: Card): string {
  const base = c.starter ? 'Starter' : c.type === 'route' ? 'Route' : 'Skill';
  return c.rarity === 'wild' ? `Wild · ${base}` : base;
}
