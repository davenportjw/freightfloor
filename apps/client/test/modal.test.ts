import { describe, expect, it } from 'vitest';
import { activeOverlay } from '../src/ui/mode.js';
import { blocksDriving, LAYER_PRIORITY, topLayer } from '../src/ui/modal.js';
import { hotkeyLayer, resolveHotkey, type HotkeyContext, type HotkeyEvent } from '../src/ui/hotkeys.js';

const key = (code: string, k = code): HotkeyEvent => ({ code, key: k });

const BASE: HotkeyContext = {
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

describe('single modal policy: topLayer', () => {
  it('follows the documented priority list', () => {
    expect(LAYER_PRIORITY).toEqual([
      'intro',
      'results',
      'pick',
      'agentDesigner',
      'leaderboard',
      'dispatchersCall',
      'a2ui',
      'chat',
      'standings',
      'menu',
    ]);
    const everything = {
      helpOpen: true,
      overlay: 'results' as const,
      agentDesignerOpen: true,
      leaderboardModalOpen: true,
      dispatchersCallOpen: true,
      a2uiOpen: true,
    };
    expect(topLayer(everything)).toBe('intro');
    expect(topLayer({ ...everything, helpOpen: false })).toBe('results');
    expect(topLayer({ ...everything, helpOpen: false, overlay: 'pick' })).toBe('pick');
    expect(topLayer({ ...everything, helpOpen: false, overlay: null })).toBe('agentDesigner');
    expect(topLayer({ ...everything, helpOpen: false, overlay: null, agentDesignerOpen: false })).toBe('leaderboard');
    expect(topLayer({ helpOpen: false, dispatchersCallOpen: true, a2uiOpen: true, overlay: 'chat' })).toBe('dispatchersCall');
    expect(topLayer({ helpOpen: false, a2uiOpen: true, overlay: 'menu' })).toBe('a2ui');
    expect(topLayer({ helpOpen: false, overlay: 'standings' })).toBe('standings');
    expect(topLayer({ helpOpen: false })).toBeNull();
  });

  it('blocks driving only under intro / results / pick / designer / leaderboard', () => {
    const blocking = LAYER_PRIORITY.filter((l) => blocksDriving(l));
    expect(blocking).toEqual(['intro', 'results', 'pick', 'agentDesigner', 'leaderboard']);
    expect(blocksDriving(null)).toBe(false);
  });

  it('a modal opened over a sheet suspends the sheet (Enter cannot hit an invisible sheet)', () => {
    const base = { mode: 'driving' as const, hand: null, dealMinimizedKey: null, overlay: null };
    expect(activeOverlay({ ...base, runEndOpen: true })).toBe('results');
    expect(activeOverlay({ ...base, runEndOpen: true, modalOpen: true })).toBeNull();
    const ctx: HotkeyContext = { ...BASE, overlay: null, leaderboardModalOpen: true };
    expect(hotkeyLayer(ctx)).toBe('leaderboard');
    expect(resolveHotkey(key('Enter'), ctx)).toBeNull();
  });
});

describe('single modal policy: resolveHotkey gating', () => {
  it('results sheet: only Enter (Run again) and Esc; nothing fires behind it', () => {
    const ctx: HotkeyContext = { ...BASE, overlay: 'results' };
    expect(resolveHotkey(key('Enter'), ctx)).toBe('results:again');
    expect(resolveHotkey(key('Escape'), ctx)).toBe('closeOverlay');
    for (const code of ['KeyC', 'KeyM', 'KeyG', 'KeyL', 'KeyQ', 'KeyF', 'KeyH', 'KeyV', 'Tab', 'Digit1']) {
      expect(resolveHotkey(key(code), ctx), code).toBeNull();
    }
  });

  it('pick sheet: Enter keeps, 1 2 3 toggle, other hotkeys swallowed', () => {
    const ctx: HotkeyContext = { ...BASE, overlay: 'pick' };
    expect(resolveHotkey(key('Enter'), ctx)).toBe('pick:keep');
    expect(resolveHotkey(key('Digit2', '2'), ctx)).toBe('pick:2');
    expect(resolveHotkey(key('KeyC'), ctx)).toBeNull();
    expect(resolveHotkey(key('KeyM'), ctx)).toBeNull();
  });

  it('intro: Enter starts, Esc closes, nothing else', () => {
    const ctx: HotkeyContext = { ...BASE, helpOpen: true, overlay: 'pick' };
    expect(resolveHotkey(key('Enter'), ctx)).toBe('intro:start');
    expect(resolveHotkey(key('Escape'), ctx)).toBe('closeHelp');
    expect(resolveHotkey(key('Digit1', '1'), ctx)).toBeNull();
  });

  it("Dispatcher's Call card and A2UI screen: Esc closes them, other hotkeys do not fire", () => {
    const dc: HotkeyContext = { ...BASE, dispatchersCallOpen: true };
    expect(resolveHotkey(key('Escape'), dc)).toBe('closeDispatchersCall');
    expect(resolveHotkey(key('KeyC'), dc)).toBeNull();
    const a2ui: HotkeyContext = { ...BASE, a2uiOpen: true };
    expect(resolveHotkey(key('Escape'), a2ui)).toBe('closeA2ui');
    expect(resolveHotkey(key('KeyM'), a2ui)).toBeNull();
    // Esc still closes the A2UI screen while its text field has focus.
    expect(resolveHotkey(key('Escape'), { ...a2ui, typing: true })).toBe('closeA2ui');
    expect(resolveHotkey(key('Escape'), { ...BASE, typing: true })).toBeNull();
  });

  it('Agent Designer / Leaderboard: only their toggle key and Esc', () => {
    const ad: HotkeyContext = { ...BASE, agentDesignerOpen: true };
    expect(resolveHotkey(key('KeyG'), ad)).toBe('agentDesigner');
    expect(resolveHotkey(key('Escape'), ad)).toBe('closeAgentDesigner');
    expect(resolveHotkey(key('KeyL'), ad)).toBeNull();
    const lb: HotkeyContext = { ...BASE, leaderboardModalOpen: true };
    expect(resolveHotkey(key('KeyL'), lb)).toBe('leaderboardModal');
    expect(resolveHotkey(key('KeyG'), lb)).toBeNull();
  });
});
