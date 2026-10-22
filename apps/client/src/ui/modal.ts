/**
 * Single modal policy (pure, unit-tested): which layer is on top of the HUD right now.
 *
 * Priority (highest first):
 *   intro (`#help`) > results sheet > contract pick sheet > Agent Designer / Leaderboard modal >
 *   Dispatcher's Call card > A2UI builder > chat / standings / menu.
 *
 * Every hotkey (ui/hotkeys.ts `resolveHotkey`) and the driving keys (main.ts keydown) are gated by
 * this one function, so nothing fires behind whatever the player is looking at.
 *
 * Visual stacking invariant (kept by main.ts + ui/mode.ts): opening the results sheet closes the
 * Agent Designer and Leaderboard, and a modal opened *over* a sheet (e.g. "Full standings" on the
 * results sheet) suspends that sheet until the modal closes (`activeOverlay` reports no sheet
 * while `modalOpen`). So the layer named here is always the one actually visible on top, and
 * Enter never acts on an invisible sheet.
 */
import type { ActiveOverlay } from './mode.js';

export type TopLayer =
  | 'intro'
  | 'results'
  | 'pick'
  | 'agentDesigner'
  | 'leaderboard'
  | 'dispatchersCall'
  | 'a2ui'
  | 'chat'
  | 'standings'
  | 'menu'
  | null;

/** The documented priority list (highest first). */
export const LAYER_PRIORITY: readonly Exclude<TopLayer, null>[] = [
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
];

export interface TopLayerInput {
  /** Intro / How to play (`ui.helpOpen`). */
  helpOpen: boolean;
  /** `store.activeOverlay()` — already suspends sheets while a full-screen modal is open. */
  overlay?: ActiveOverlay;
  agentDesignerOpen?: boolean;
  leaderboardModalOpen?: boolean;
  /** A Dispatcher's Call minigame card is on screen. */
  dispatchersCallOpen?: boolean;
  /** A (non-minigame) A2UI clarification screen is on screen. */
  a2uiOpen?: boolean;
}

export function topLayer(s: TopLayerInput): TopLayer {
  const ov = s.overlay ?? null;
  if (s.helpOpen) return 'intro';
  if (ov === 'results') return 'results';
  if (ov === 'pick') return 'pick';
  if (s.agentDesignerOpen) return 'agentDesigner';
  if (s.leaderboardModalOpen) return 'leaderboard';
  if (s.dispatchersCallOpen) return 'dispatchersCall';
  if (s.a2uiOpen) return 'a2ui';
  if (ov === 'chat' || ov === 'standings' || ov === 'menu') return ov;
  return null;
}

/**
 * Layers that swallow the driving keys (WASD / arrows / E / Shift / Space). Chat, standings
 * (held Tab), menu, the Dispatcher's Call card and A2UI screens are in-HUD cards shown while you
 * drive (the Dispatcher's Call card has an 8 s timer), so driving continues under them.
 */
export function blocksDriving(layer: TopLayer): boolean {
  return (
    layer === 'intro' ||
    layer === 'results' ||
    layer === 'pick' ||
    layer === 'agentDesigner' ||
    layer === 'leaderboard'
  );
}
