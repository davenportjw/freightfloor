import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOTKEYS, resolveHotkey, type HotkeyContext, type HotkeyEvent } from '../src/ui/hotkeys.js';

/**
 * Keeps docs/gameplay.md § Hotkeys, the in-app help table (`HOTKEYS`) and the real key
 * resolver (`resolveHotkey`) in sync, in both directions.
 */

const GAMEPLAY_MD = resolve(__dirname, '../../../docs/gameplay.md');

/** Driving keys are handled by input.ts (only while driving), not by resolveHotkey. */
const DRIVING_TOKENS = new Set(['W', 'A', 'S', 'D', 'arrows', 'Shift', 'Space', 'E']);

function tokens(keyCell: string): string[] {
  return keyCell
    .replace(/`/g, '')
    .split('/')
    .flatMap((part) => part.trim().split(/\s+/))
    .filter(Boolean);
}

function docHotkeyRows(): Array<{ key: string; action: string }> {
  const md = readFileSync(GAMEPLAY_MD, 'utf8');
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '### Hotkeys');
  expect(start, 'docs/gameplay.md has a "### Hotkeys" section').toBeGreaterThanOrEqual(0);
  const rows: Array<{ key: string; action: string }> = [];
  let inTable = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#')) break;
    if (!line.startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2 || cells[0] === 'Key' || /^-+$/.test(cells[0])) continue;
    rows.push({ key: cells[0], action: cells[1] });
  }
  return rows;
}

function eventFor(token: string): HotkeyEvent {
  if (token === 'Esc') return { key: 'Escape', code: 'Escape' };
  if (token === 'Tab') return { key: 'Tab', code: 'Tab' };
  if (token === 'Enter') return { key: 'Enter', code: 'Enter' };
  if (token === '?') return { key: '?', code: 'Slash' };
  if (/^[0-9]$/.test(token)) return { key: token, code: `Digit${token}` };
  if (/^[A-Z]$/.test(token)) return { key: token.toLowerCase(), code: `Key${token}` };
  throw new Error(`No key event mapping for documented hotkey token "${token}"`);
}

/** Context where every contextual hotkey is live (driving manually, offer open, vehicle selected). */
const LIVE_CTX: HotkeyContext = {
  typing: false,
  canHandBack: false,
  helpOpen: false,
  agentDesignerOpen: false,
  leaderboardModalOpen: false,
  drawerOpen: false,
  coneMode: false,
  selectedVid: 'FL-01',
  driving: true,
  autopilot: false,
  fareOpen: true,
};
/** FLOOR view (not holding a wheel): floor orders, F = Drive, B = Team Standings. */
const FLOOR_CTX: HotkeyContext = { ...LIVE_CTX, driving: false, fareOpen: false, selectedVid: 'FL-01' };
/** Contract pick sheet open: 1 2 3 toggle cards, Enter starts the run. */
const PICK_CTX: HotkeyContext = { ...LIVE_CTX, overlay: 'pick' };
/** LIVE_CTX first: the driving-key collision check uses index 0. */
const ALL_CTX: HotkeyContext[] = [LIVE_CTX, FLOOR_CTX, PICK_CTX];

describe('hotkeys: docs/gameplay.md ⇄ HOTKEYS ⇄ resolveHotkey', () => {
  const docRows = docHotkeyRows();
  const docTokens = new Set(docRows.flatMap((r) => tokens(r.key)));
  const helpTokens = new Set(HOTKEYS.flatMap((h) => tokens(h.key)));

  it('parses the documented table', () => {
    expect(docRows.length).toBeGreaterThanOrEqual(10);
  });

  it('every documented key is in the in-app HOTKEYS table and vice versa', () => {
    expect([...docTokens].filter((t) => !helpTokens.has(t))).toEqual([]);
    expect([...helpTokens].filter((t) => !docTokens.has(t))).toEqual([]);
  });

  it('every documented non-driving key resolves to an action (in DRIVE, FLOOR or the pick sheet); driving keys do not collide', () => {
    for (const t of docTokens) {
      if (t === 'arrows' || t === 'Shift' || t === 'Space') continue;
      const actions = ALL_CTX.map((ctx) => resolveHotkey(eventFor(t), ctx));
      if (DRIVING_TOKENS.has(t)) expect(actions[0], `driving key ${t}`).toBeNull();
      else expect(actions.some((a) => a !== null), `documented hotkey ${t}`).toBe(true);
    }
  });

  it('every key the resolver handles is documented', () => {
    const candidates: Array<{ token: string; ev: HotkeyEvent }> = [
      { token: 'Esc', ev: eventFor('Esc') },
      { token: 'Tab', ev: eventFor('Tab') },
      { token: 'Enter', ev: eventFor('Enter') },
      { token: '?', ev: eventFor('?') },
    ];
    for (let c = 65; c <= 90; c++) {
      const L = String.fromCharCode(c);
      candidates.push({ token: L, ev: eventFor(L) });
    }
    for (let d = 0; d <= 9; d++) candidates.push({ token: String(d), ev: eventFor(String(d)) });
    const undocumented = candidates
      .filter(({ ev }) => ALL_CTX.some((ctx) => resolveHotkey(ev, ctx) !== null))
      .map(({ token }) => token)
      .filter((t) => !docTokens.has(t) || !helpTokens.has(t));
    expect(undocumented).toEqual([]);
  });

  it('mode-dependent keys: F drives from the floor, digits are floor orders / pick toggles', () => {
    expect(resolveHotkey(eventFor('F'), FLOOR_CTX)).toBe('drive');
    expect(resolveHotkey(eventFor('4'), FLOOR_CTX)).toBe('order:dispatch');
    expect(resolveHotkey(eventFor('4'), LIVE_CTX)).toBeNull();
    expect(resolveHotkey(eventFor('2'), PICK_CTX)).toBe('pick:2');
    expect(resolveHotkey(eventFor('Enter'), PICK_CTX)).toBe('pick:keep');
    expect(resolveHotkey(eventFor('B'), LIVE_CTX)).toBeNull();
    expect(resolveHotkey(eventFor('B'), FLOOR_CTX)).toBe('board');
  });
});
