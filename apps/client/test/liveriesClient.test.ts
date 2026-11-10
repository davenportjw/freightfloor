/**
 * Forklift liveries, client side (retention spec §4): palette resolution for the renderer, the
 * Garage card model, the "unseen unlock" diff behind the unlock toast, store application of the
 * private `liveryStatus` / `liveryUnlocked` messages, the delta merge of `livery`, the Garage
 * equip button state, and the GA4 events.
 */
import { describe, expect, it } from 'vitest';
import { LIVERIES, liveryIndex, quantiseCoord, type LiveryId } from '@warehouse/protocol';
import { createWorld } from '@warehouse/sim';
import { applyQuantisedDelta, ClientStore, FLYOUT_IDS } from '../src/state.js';
import type { RenderVehicleOverlay } from '../src/renderer.js';
import { diffSeenUnlocks, garageButton, garageCards, liveryPaletteFor } from '../src/ui/liveries.js';
import { eventForClientMessage, unlockEvents } from '../src/analytics.js';
import { vehicleParts } from '../src/render/vehicles.js';

describe('liveryPaletteFor', () => {
  it('keeps the default team colour for AI, unset and standard', () => {
    expect(liveryPaletteFor({ human: false, livery: liveryIndex('night_shift') })).toBeNull();
    expect(liveryPaletteFor({ human: true })).toBeNull();
    expect(liveryPaletteFor({ human: true, livery: 0 })).toBeNull();
  });
  it('resolves a human vehicle wire index to the catalog entry', () => {
    expect(liveryPaletteFor({ human: true, livery: liveryIndex('gold_fork') })).toBe(LIVERIES.gold_fork);
  });
  it('treats an unknown index as standard', () => {
    expect(liveryPaletteFor({ human: true, livery: 999 })).toBeNull();
  });
});

describe('garageCards', () => {
  it('lists the whole catalog with only standard unlocked before status arrives', () => {
    const cards = garageCards(null);
    expect(cards.map((c) => c.id)).toEqual(Object.keys(LIVERIES));
    expect(cards.filter((c) => !c.locked).map((c) => c.id)).toEqual(['standard']);
    expect(cards.find((c) => c.equipped)?.id).toBe('standard');
  });
  it('marks unlocked and equipped from liveryStatus', () => {
    const cards = garageCards({ equipped: 'hi_vis', unlocked: ['standard', 'hi_vis', 'regional_den'] });
    const by = new Map(cards.map((c) => [c.id, c]));
    expect(by.get('hi_vis')).toMatchObject({ locked: false, equipped: true });
    expect(by.get('regional_den')).toMatchObject({ locked: false, equipped: false });
    expect(by.get('champion')).toMatchObject({ locked: true, rule: LIVERIES.champion.rule });
  });
});

describe('diffSeenUnlocks', () => {
  it('first load on a device marks everything seen silently', () => {
    const r = diffSeenUnlocks(null, ['standard', 'night_shift']);
    expect(r.fresh).toEqual([]);
    expect(JSON.parse(r.next)).toEqual(['night_shift']);
  });
  it('announces only ids not seen before, never standard', () => {
    const r = diffSeenUnlocks(JSON.stringify(['night_shift']), ['standard', 'night_shift', 'champion']);
    expect(r.fresh).toEqual(['champion']);
    expect(JSON.parse(r.next)).toEqual(['night_shift', 'champion']);
  });
  it('treats a garbled store like a first load', () => {
    expect(diffSeenUnlocks('{nope', ['gold_fork']).fresh).toEqual([]);
  });
});

describe('ClientStore livery state', () => {
  it('applyLiveryStatus replaces state and settles a pending equip', () => {
    const s = new ClientStore();
    s.liveryPending = 'hi_vis';
    s.liveryError = 'old';
    s.applyLiveryStatus({ type: 'liveryStatus', equipped: 'hi_vis', unlocked: ['standard', 'hi_vis'] });
    expect(s.livery).toEqual({ equipped: 'hi_vis', unlocked: ['standard', 'hi_vis'] });
    expect(s.liveryPending).toBeNull();
    expect(s.liveryError).toBeNull();
  });
  it('applyLiveryUnlocked merges without duplicates and keeps equipped', () => {
    const s = new ClientStore();
    s.applyLiveryStatus({ type: 'liveryStatus', equipped: 'standard', unlocked: ['standard', 'night_shift'] });
    s.applyLiveryUnlocked({ type: 'liveryUnlocked', ids: ['night_shift', 'gold_fork'] });
    expect(s.livery).toEqual({ equipped: 'standard', unlocked: ['standard', 'night_shift', 'gold_fork'] });
  });
  it('applyLiveryError surfaces the message and clears pending', () => {
    const s = new ClientStore();
    s.liveryPending = 'champion';
    s.applyLiveryError('Champion: win a weekly league.');
    expect(s.liveryError).toBe('Champion: win a weekly league.');
    expect(s.liveryPending).toBeNull();
  });
  it('has a garage flyout', () => {
    expect(FLYOUT_IDS).toContain('garage');
  });
});

describe('livery on vehicle deltas', () => {
  it('creates and merges the livery index; absent keeps the last value', () => {
    const w = createWorld({ seed: 7, siteId: 'den-1' });
    const v = w.vehicles[0];
    const overlays = new Map<string, RenderVehicleOverlay>();
    const q = { qx: quantiseCoord(v.px), qy: quantiseCoord(v.py) };
    applyQuantisedDelta(w, [{ id: v.id, ...q, livery: liveryIndex('cold_chain') }], null, overlays);
    expect(w.vehicles.find((x) => x.id === v.id)?.livery).toBe(liveryIndex('cold_chain'));
    applyQuantisedDelta(w, [{ id: v.id, ...q }], null, overlays);
    expect(w.vehicles.find((x) => x.id === v.id)?.livery).toBe(liveryIndex('cold_chain'));
    applyQuantisedDelta(w, [{ id: 'new-1', ...q, livery: liveryIndex('hi_vis') }], null, overlays);
    expect(w.vehicles.find((x) => x.id === 'new-1')?.livery).toBe(liveryIndex('hi_vis'));
  });
});

describe('livery rendering', () => {
  const pose = { x: 5, y: 5, a: 0 };
  it('paints the counterweight with the livery primary and adds the accent decal', () => {
    const w = createWorld({ seed: 7, siteId: 'den-1' });
    const v = { ...w.vehicles[0], human: true, type: 'counterbalance', livery: liveryIndex('night_shift') };
    const hexes = vehicleParts(v as never, pose, 0).map((p) => p.hex);
    expect(hexes).toContain(LIVERIES.night_shift.primary);
    expect(hexes).toContain(LIVERIES.night_shift.accent);
  });
  it('leaves AI vehicles unchanged even with a livery field', () => {
    const w = createWorld({ seed: 7, siteId: 'den-1' });
    const base = { ...w.vehicles[0], human: false, type: 'counterbalance' };
    const a = vehicleParts(base as never, pose, 0);
    const b = vehicleParts({ ...base, livery: liveryIndex('night_shift') } as never, pose, 0);
    expect(b).toEqual(a);
  });
});

describe('garageButton', () => {
  const card = (id: LiveryId, locked: boolean, equipped: boolean) => ({ id, locked, equipped });
  it('spectators cannot equip', () => {
    expect(garageButton(card('hi_vis', false, false), false, null)).toEqual({ label: 'Equip', disabled: true });
  });
  it('drivers can equip unlocked, not locked or equipped', () => {
    expect(garageButton(card('hi_vis', false, false), true, null)).toEqual({ label: 'Equip', disabled: false });
    expect(garageButton(card('champion', true, false), true, null)).toEqual({ label: 'Locked', disabled: true });
    expect(garageButton(card('standard', false, true), true, null)).toEqual({ label: 'Equipped', disabled: true });
  });
  it('a pending equip disables every card and labels its own', () => {
    expect(garageButton(card('hi_vis', false, false), true, 'hi_vis')).toEqual({ label: 'Equipping…', disabled: true });
    expect(garageButton(card('night_shift', false, false), true, 'hi_vis').disabled).toBe(true);
  });
});

describe('livery analytics', () => {
  it('livery_equip carries the catalog id only', () => {
    expect(eventForClientMessage({ type: 'setLivery', id: 'hi_vis' })).toEqual({
      name: 'livery_equip',
      params: { livery_id: 'hi_vis' },
    });
    expect(eventForClientMessage({ type: 'setLivery', id: 'free text' })).toBeNull();
  });
  it('unlock_achievement per newly announced livery', () => {
    expect(unlockEvents(['champion'])).toEqual([
      { name: 'unlock_achievement', params: { achievement_id: 'livery_champion' } },
    ]);
  });
});
