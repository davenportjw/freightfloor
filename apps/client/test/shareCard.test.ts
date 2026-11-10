/**
 * Share card (retention spec §3): pure text builder and the share fallback chain. The navigator
 * objects below are test doubles for browser APIs, not production fallbacks.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildShareText,
  isDailyLink,
  shareResult,
  SHARE_TAPE_CAP,
  tapeRows,
  type ShareNavigator,
} from '../src/ui/shareCard.js';

describe('tapeRows', () => {
  it('maps O/L/X to green/yellow/red squares in order', () => {
    expect(tapeRows('OLX')).toEqual(['🟩🟨🟥']);
  });

  it('wraps at 10 squares per row', () => {
    const rows = tapeRows('O'.repeat(10) + 'L'.repeat(3));
    expect(rows).toEqual(['🟩'.repeat(10), '🟨'.repeat(3)]);
  });

  it(`caps at ${SHARE_TAPE_CAP} squares and summarises the rest as +N`, () => {
    const rows = tapeRows('O'.repeat(26));
    expect(rows).toEqual(['🟩'.repeat(10), `${'🟩'.repeat(10)} +6`]);
  });

  it('returns no rows for an empty tape and ignores unknown chars', () => {
    expect(tapeRows('')).toEqual([]);
    expect(tapeRows('O?L')).toEqual(['🟩🟨']);
  });
});

describe('buildShareText', () => {
  it('builds the Daily card with rank, streak and the share link', () => {
    const { text, url } = buildShareText({
      runMode: 'daily',
      tape: 'OOLOXOOO',
      pts: 1840,
      deliveries: 7,
      daily: { number: 42, modifierLabel: 'Cold Chain Day', rank: 7, of: 213, streak: 6 },
      origin: 'https://freightfloor.com',
    });
    expect(text).toBe(
      [
        'Freight Floor Daily #42 · Cold Chain Day',
        '🟩🟩🟨🟩🟥🟩🟩🟩',
        '1,840 pts · #7 of 213 · 🔥6',
        'freightfloor.com/?daily=42&utm_source=share',
      ].join('\n'),
    );
    expect(url).toBe('https://freightfloor.com/?daily=42&utm_source=share');
  });

  it('omits rank and streak until the server recorded the Daily', () => {
    const { text } = buildShareText({
      runMode: 'daily',
      tape: 'O',
      pts: 12,
      deliveries: 1,
      daily: { number: 3, modifierLabel: 'Eco Run' },
    });
    expect(text.split('\n')[2]).toBe('12 pts');
  });

  it('builds the "Share run" variant for Blitz and Free Range without a daily line', () => {
    const blitz = buildShareText({ runMode: 'blitz', tape: 'OL', pts: 12345, deliveries: 1, origin: 'http://localhost:5173/' });
    expect(blitz.text).toBe(
      ['Freight Floor · Blitz run', '🟩🟨', '12,345 pts · 1 delivery', 'localhost:5173/?utm_source=share'].join('\n'),
    );
    const free = buildShareText({ runMode: 'freerange', tape: '', pts: 0, deliveries: 0 });
    expect(free.text).toBe(['Freight Floor · Free Range run', '0 pts · 0 deliveries', 'freightfloor.com/?utm_source=share'].join('\n'));
    expect(free.text).not.toContain('daily=');
  });

  it('never includes card titles', () => {
    const { text } = buildShareText({
      runMode: 'daily',
      tape: 'OOO',
      pts: 1,
      deliveries: 3,
      daily: { number: 1, modifierLabel: 'Long Haul' },
    });
    for (const title of ['Speed Demon', 'Overdrive', 'Long Reach', 'Eco Cell', 'Trailer Closer', 'Clean Shift']) {
      expect(text).not.toContain(title);
    }
  });
});

describe('shareResult fallback chain', () => {
  const share = { text: 'hello', url: 'https://freightfloor.com/?utm_source=share' };

  it('uses the native share sheet when available', async () => {
    const nav: ShareNavigator = { share: vi.fn(async () => undefined), clipboard: { writeText: vi.fn(async () => undefined) } };
    await expect(shareResult(share, nav)).resolves.toEqual({ status: 'shared' });
    expect(nav.share).toHaveBeenCalledWith({ text: 'hello' });
    expect(nav.clipboard?.writeText).not.toHaveBeenCalled();
  });

  it('treats a dismissed share sheet as cancelled (no clipboard write)', async () => {
    const abort = Object.assign(new Error('dismissed'), { name: 'AbortError' });
    const nav: ShareNavigator = { share: vi.fn(async () => Promise.reject(abort)), clipboard: { writeText: vi.fn(async () => undefined) } };
    await expect(shareResult(share, nav)).resolves.toEqual({ status: 'cancelled' });
    expect(nav.clipboard?.writeText).not.toHaveBeenCalled();
  });

  it('falls back to the clipboard when share is missing or fails', async () => {
    const writeText = vi.fn(async () => undefined);
    await expect(shareResult(share, { clipboard: { writeText } })).resolves.toEqual({ status: 'copied' });
    expect(writeText).toHaveBeenCalledWith('hello');
    const failing: ShareNavigator = { share: vi.fn(async () => Promise.reject(new Error('NotAllowed'))), clipboard: { writeText } };
    await expect(shareResult(share, failing)).resolves.toEqual({ status: 'copied' });
  });

  it('returns manual with the text and the real errors when both fail', async () => {
    const nav: ShareNavigator = {
      share: vi.fn(async () => Promise.reject(new Error('share blocked'))),
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('clipboard denied'))) },
    };
    await expect(shareResult(share, nav)).resolves.toEqual({
      status: 'manual',
      text: 'hello',
      error: 'share: share blocked; clipboard: clipboard denied',
    });
    await expect(shareResult(share, undefined)).resolves.toMatchObject({ status: 'manual', text: 'hello' });
  });
});

describe('isDailyLink', () => {
  it('detects /?daily=N share links', () => {
    expect(isDailyLink('?daily=42&utm_source=share')).toBe(true);
    expect(isDailyLink('?daily=')).toBe(false);
    expect(isDailyLink('?daily=abc')).toBe(false);
    expect(isDailyLink('')).toBe(false);
  });
});
