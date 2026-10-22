/**
 * Notification routing (ui/notify.ts): event kind × HUD mode → popup / alert / feed / order line /
 * banner / drop, plus the alert line's newest-wins + auto-clear rules and the feed's dedupe cap.
 */
import type { SimEvent } from '@warehouse/sim';
import { describe, expect, it } from 'vitest';
import { calloutFor } from '../../src/render/fx.js';
import { dedupeByText } from '../../src/ui/floorView.js';
import {
  activeAlert,
  ALERT_ACTION_MS,
  ALERT_ERROR_MS,
  ALERT_MS,
  errorKind,
  noticeAlert,
  ORDER_REFUSAL_WINDOW_MS,
  pushFeedNote,
  routeNotice,
  routeSimEvent,
  type NoticeKind,
} from '../../src/ui/notify.js';
import { alertView, COND_REARM_MS, shouldRaiseCond, shownAlert } from '../../src/ui/objective.js';

const ev = (type: string, extra: Record<string, unknown> = {}): SimEvent => ({ t: 10, type, text: `${type} text`, ...extra }) as SimEvent;
const ME = 'FL-01';
const KEY = 'client-me';

describe('routeSimEvent — DRIVE', () => {
  const r = (e: SimEvent) => routeSimEvent(e, 'driving', ME, KEY);
  it('my scoring/run events → world popup', () => {
    expect(r(ev('fare', { vid: ME, rating: 'speedy', pts: 20, combo: 1 }))).toBe('popup');
    expect(r(ev('combo_reset', { vid: ME, reason: 'crash' }))).toBe('popup');
    expect(r(ev('trailer_closer', { vid: ME, pts: 5 }))).toBe('popup');
    expect(r(ev('card', { vid: ME, text: 'Contract done: Speed Demon. +40 pts (perk unlocked!)' }))).toBe('popup');
    expect(r(ev('incident', { vid: ME }))).toBe('popup');
    expect(r(ev('poach', { vid: 'TU-09', owner: KEY, cardId: 'c1' }))).toBe('popup');
  });
  it('my own interact hint → alert line', () => {
    expect(r(ev('hint', { vid: ME }))).toBe('alert');
  });
  it("everything else is dropped (other trucks, trailers, poaching, transfers, others' runs)", () => {
    expect(r(ev('fare', { vid: 'TU-02', rating: 'speedy', pts: 20 }))).toBe('drop');
    expect(r(ev('trailer_closer', { vid: 'TU-02' }))).toBe('drop');
    expect(r(ev('poach', { vid: 'TU-02', owner: 'client-other', cardId: 'c2' }))).toBe('drop');
    expect(r(ev('transfer_out', {}))).toBe('drop');
    expect(r(ev('transfer_in', {}))).toBe('drop');
    expect(r(ev('truck', {}))).toBe('drop');
    expect(r(ev('shift', { text: 'velvet-packet-38 completed 5-Minute Blitz with 124 pts' }))).toBe('drop');
    expect(r(ev('hint', { vid: 'TU-02' }))).toBe('drop');
    expect(r(ev('hint', {}))).toBe('drop');
    expect(r(ev('drive', { vid: ME }))).toBe('drop');
    expect(r(ev('decision', { vid: ME }))).toBe('drop');
    expect(r(ev('nearmiss', { vid: ME }))).toBe('drop');
  });
});

describe('routeSimEvent — FLOOR', () => {
  const r = (e: SimEvent) => routeSimEvent(e, 'floor', null, KEY);
  it('sim events → the feed', () => {
    for (const t of ['fare', 'trailer_closer', 'poach', 'transfer_out', 'truck', 'shift', 'incident', 'card']) {
      expect(r(ev(t, { vid: 'TU-02' }))).toBe('feed');
    }
  });
  it('decisions / near-misses / per-driver hints are dropped', () => {
    expect(r(ev('decision', { vid: 'TU-02' }))).toBe('drop');
    expect(r(ev('nearmiss', { vid: 'TU-02' }))).toBe('drop');
    expect(r(ev('hint', { vid: 'TU-02' }))).toBe('drop');
  });
  it('a floor-wide hint (answer to a Floor order) → the order line', () => {
    expect(r(ev('hint', { text: 'No free rack slot for a P0 right now.' }))).toBe('orderLine');
  });
});

describe('routeNotice (client notices)', () => {
  const table: Array<[NoticeKind, string, string]> = [
    ['error', 'alert', 'feed'],
    ['refusal', 'alert', 'feed'],
    ['hint', 'alert', 'feed'],
    ['orderRefusal', 'alert', 'orderLine'],
    ['relocation', 'alert', 'drop'],
    ['status', 'drop', 'feed'],
    ['runSummary', 'popup', 'banner'],
  ];
  it.each(table)('%s → drive %s · floor %s', (kind, drive, floor) => {
    expect(routeNotice(kind, 'driving')).toBe(drive);
    expect(routeNotice(kind, 'floor')).toBe(floor);
  });
  it('server error right after a Floor order is that order’s refusal (FLOOR only)', () => {
    const now = 100_000;
    expect(errorKind('floor', now, now - 500)).toBe('orderRefusal');
    expect(errorKind('floor', now, now - ORDER_REFUSAL_WINDOW_MS - 1)).toBe('error');
    expect(errorKind('floor', now, null)).toBe('error');
    expect(errorKind('driving', now, now - 500)).toBe('error');
  });
});

describe('alert line', () => {
  it('auto-clears after ~4 s (errors ~5 s, relocation 8 s)', () => {
    const a = noticeAlert('hint', 'Nothing to drop here', 0);
    expect(a.until).toBe(ALERT_MS);
    expect(activeAlert(a, ALERT_MS - 1)).toBe(a);
    expect(activeAlert(a, ALERT_MS)).toBeNull();
    expect(noticeAlert('error', 'x', 0).until).toBe(ALERT_ERROR_MS);
    expect(noticeAlert('error', 'x', 0).tone).toBe('bad');
    expect(noticeAlert('relocation', 'x', 0)).toMatchObject({ until: ALERT_ACTION_MS, action: 'relocation' });
  });
  it('condition alerts keep live text and vanish with their condition; relocation with its offer', () => {
    const me = { battery: 15, tile: { x: 0, y: 0 } };
    const cond = alertView(me, []);
    expect(cond?.cond).toBe('low');
    const a = { text: 'old', tone: 'bad' as const, at: 0, until: ALERT_MS, cond: 'low' };
    expect(shownAlert(a, alertView({ ...me, battery: 12 }, []), false, 10)?.text).toContain('12%');
    expect(shownAlert(a, null, false, 10)).toBeNull();
    const reloc = noticeAlert('relocation', 'surge', 0);
    expect(shownAlert(reloc, null, true, 10)).toBe(reloc);
    expect(shownAlert(reloc, null, false, 10)).toBeNull();
  });
  it('relocation alert can be replaced by a newer alert (newest wins — single slot)', () => {
    let slot = noticeAlert('relocation', 'surge', 0);
    slot = noticeAlert('error', 'Order choice rate limit', 100);
    expect(shownAlert(slot, null, true, 200)?.text).toBe('Order choice rate limit');
  });
  it('a condition flapping at the radius edge raises once; re-arms only after COND_REARM_MS absent', () => {
    const seen = new Map<string, number>();
    expect(shouldRaiseCond(seen, 'spill', 0)).toBe(true);
    expect(shouldRaiseCond(seen, 'spill', 100)).toBe(false); // still present
    expect(shouldRaiseCond(seen, null, 5_000)).toBe(false); // gone briefly
    expect(shouldRaiseCond(seen, 'spill', 10_000)).toBe(false); // back within the re-arm window
    expect(shouldRaiseCond(seen, 'low', 10_100)).toBe(true); // a different category raises
    expect(shouldRaiseCond(seen, 'spill', 10_000 + COND_REARM_MS + 1)).toBe(true); // absent long enough
  });
});

describe('floor feed notes', () => {
  it('dedupes by text (repeat refreshes) and caps at 3', () => {
    let notes = pushFeedNote([], { text: 'a', tone: '', at: 1 });
    notes = pushFeedNote(notes, { text: 'b', tone: '', at: 2 });
    notes = pushFeedNote(notes, { text: 'a', tone: 'bad', at: 3 });
    expect(notes.map((n) => n.text)).toEqual(['a', 'b']);
    notes = pushFeedNote(notes, { text: 'c', tone: '', at: 4 });
    notes = pushFeedNote(notes, { text: 'd', tone: '', at: 5 });
    expect(notes.map((n) => n.text)).toEqual(['d', 'c', 'a']);
  });
  it('merged rows keep the newest of identical texts', () => {
    expect(dedupeByText([{ text: 'x', at: 3 }, { text: 'y', at: 2 }, { text: 'x', at: 1 }])).toEqual([
      { text: 'x', at: 3 },
      { text: 'y', at: 2 },
    ]);
  });
});

describe('own-event popups', () => {
  it('contract results, crash and skid', () => {
    expect(calloutFor(ev('card', { vid: ME, text: 'Contract done: Speed Demon. +40 pts (perk unlocked!)' }), ME)).toEqual({ text: 'CONTRACT DONE +40', tone: 'good' });
    expect(calloutFor(ev('card', { vid: ME, text: 'Contract failed: X. why' }), ME)).toEqual({ text: 'CONTRACT FAILED', tone: 'bad' });
    expect(calloutFor(ev('card', { vid: ME, text: 'Last Call: +12 pts', pts: 12 }), ME)).toEqual({ text: 'LAST CALL +12', tone: 'good' });
    expect(calloutFor(ev('card', { vid: ME, text: 'Contracts accepted: A · B' }), ME)).toBeNull();
    expect(calloutFor(ev('incident', { vid: ME }), ME)?.tone).toBe('bad');
    expect(calloutFor(ev('hazard', { vid: ME }), ME)?.text).toBe('SKID!');
    expect(calloutFor(ev('incident', { vid: 'TU-02' }), ME)).toBeNull();
  });
});
