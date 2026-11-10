/**
 * Forklift livery helpers (pure, unit-tested).
 *
 * Liveries are cosmetic only. The site owns the unlock rules and the equipped value; the client
 * just paints what deltas carry (`livery` wire index) and lists the catalog in the Garage.
 */
import { LIVERIES, LIVERY_IDS, liveryFromIndex, type LiveryDef, type LiveryId } from '@warehouse/protocol';

/** Palette for a vehicle, or null to keep the default team colour (AI, unset, or `standard`). */
export function liveryPaletteFor(v: { human?: boolean; livery?: number | null }): LiveryDef | null {
  if (!v.human) return null;
  if (typeof v.livery !== 'number' || v.livery <= 0) return null;
  const id = liveryFromIndex(v.livery);
  if (id === 'standard') return null;
  return LIVERIES[id];
}

export interface GarageCard {
  id: LiveryId;
  name: string;
  rule: string;
  locked: boolean;
  equipped: boolean;
  primary: string;
  accent: string | null;
}

/** Garage grid in catalog order. With no status yet, only `standard` shows as unlocked + equipped. */
export function garageCards(status: { equipped: LiveryId; unlocked: readonly LiveryId[] } | null): GarageCard[] {
  const equipped = status?.equipped ?? 'standard';
  const unlocked = new Set<LiveryId>(status?.unlocked ?? []);
  unlocked.add('standard');
  return LIVERY_IDS.map((id) => {
    const d = LIVERIES[id];
    return {
      id,
      name: d.name,
      rule: d.rule,
      locked: !unlocked.has(id),
      equipped: id === equipped,
      primary: d.primary,
      accent: d.accent ?? null,
    };
  });
}

/**
 * Which unlocks have not been announced on this device yet.
 * `stored` is the raw localStorage JSON (array of ids). A null/garbled store means first load on
 * this device: everything is marked seen silently so returning players are not spammed.
 */
export function diffSeenUnlocks(stored: string | null, unlocked: readonly LiveryId[]): { fresh: LiveryId[]; next: string } {
  const current = unlocked.filter((id) => id !== 'standard');
  let seen: string[] | null = null;
  if (stored != null) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) seen = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      seen = null;
    }
  }
  if (seen == null) return { fresh: [], next: JSON.stringify(current) };
  const fresh = current.filter((id) => !seen!.includes(id));
  const next = Array.from(new Set([...seen, ...current]));
  return { fresh, next: JSON.stringify(next) };
}

/** Equip button state for one Garage card. */
export function garageButton(
  c: Pick<GarageCard, 'id' | 'locked' | 'equipped'>,
  driving: boolean,
  pending: LiveryId | null,
): { label: string; disabled: boolean } {
  const label = c.equipped ? 'Equipped' : pending === c.id ? 'Equipping…' : c.locked ? 'Locked' : 'Equip';
  return { label, disabled: c.locked || c.equipped || !driving || pending != null };
}
