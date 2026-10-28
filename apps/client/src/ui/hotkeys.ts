/**
 * Global hotkeys (pure resolver + documented table). Driving keys (WASD / arrows / E / Shift)
 * are handled by input.ts and only while driving.
 *
 * HUD v3: the same key can mean different things in the two modes —
 * DRIVE (holding a wheel) vs FLOOR (watching / managing the floor) — and while a sheet
 * (contract pick, results) is open.
 *
 * Every key is gated by the single modal policy (ui/modal.ts `topLayer`): whatever layer is on
 * top only gets its own keys (Esc closes it; Enter acts on it only while it is visible).
 */
import { topLayer, type TopLayer } from './modal.js';

export type HotkeyAction =
  | 'handBack'
  | 'toggleCopilot'
  | 'intro:start'
  | 'closeAgentDesigner'
  | 'closeHelp'
  | 'closeLeaderboardModal'
  | 'closeDispatchersCall'
  | 'closeA2ui'
  | 'closeOverlay'
  | 'closeDrawer'
  | 'exitCone'
  | 'deselect'
  | 'takeWheel'
  | 'agentDesigner'
  | 'drawer'
  | 'leaderboardModal'
  | 'board'
  | 'menu'
  | 'standings'
  | 'chat'
  | 'hudMinimal'
  | 'driveCamera'
  | 'cabView'
  | 'drive'
  | 'pick:1'
  | 'pick:2'
  | 'pick:3'
  | 'pick:keep'
  | 'results:again'
  | 'dispatch:send'
  | 'order:rush'
  | 'order:p0'
  | 'order:cones'
  | 'order:dispatch'
  | 'fare:cycle'
  | 'fare:confirm'
  | 'help';

/** Documented in docs/gameplay.md (a test keeps the two in sync). */
export const HOTKEYS: ReadonlyArray<{ key: string; action: string }> = [
  { key: 'W A S D / arrows', action: 'Drive (instant manual takeover from Co-Pilot; only while driving)' },
  { key: 'Shift / Space', action: 'Boost (+120% speed; collisions drop carried pallets!) — or hold the Boost meter' },
  { key: 'E', action: 'Pick up / drop / charge (only while driving)' },
  { key: 'Q', action: 'Cycle the highlighted order option (while an order choice is open)' },
  { key: 'F', action: 'Driving: reserve the highlighted order option · Floor view: 🚜 Drive (jump back in)' },
  { key: 'Enter', action: 'Open chat (Co-Pilot / Floor) · intro: Start driving · pick sheet: Start run · results: Run again · dispatch: Send' },
  { key: 'Tab', action: 'Hold to show the Standings sheet (drivers, gap to next, difficulty vote)' },
  { key: 'C', action: 'Co-Pilot on / off (hand the wheel to your Co-Pilot, or take it back; only while driving)' },
  { key: 'M', action: 'Open / close the ☰ menu' },
  { key: 'V', action: 'HUD Full / Minimal (minimal hides hints and the contracts card)' },
  { key: 'R', action: 'Drive camera: Fixed floor vs Forklift up (rotate floor while driving)' },
  { key: 'P', action: 'Cab View on / off: first-person from the forklift seat (while driving; turns Lift Mode on)' },
  { key: '1 2 3', action: 'Contract pick sheet: toggle card 1 / 2 / 3' },
  { key: '1 2 3 4', action: 'Floor view: Floor orders — 1 Rush · 2 ★ P0 · 3 🚧 Cones · 4 📦 Dispatch' },
  { key: 'B', action: 'Floor view: open / close Team Standings' },
  { key: 'G', action: 'Open / close Tune Co-Pilot (Co-Pilot & Agent Designer)' },
  { key: 'T', action: 'Take the wheel of the selected vehicle' },
  { key: 'H', action: 'Open / close the day history drawer' },
  { key: 'L', action: 'Open / close the full Leaderboard & Silly Awards modal' },
  { key: 'Esc', action: 'Close things only: the open sheet / menu / modal, finish cone placing, hand back an AI vehicle, deselect, or close the drawer' },
  { key: '?', action: 'Open How to play (Esc closes it)' },
];

export interface HotkeyEvent {
  key: string;
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

/** Overlay currently covering the HUD (see ui/mode.ts `activeOverlay`). */
export type HotkeyOverlay = 'results' | 'pick' | 'chat' | 'standings' | 'menu' | null;

export interface HotkeyContext {
  typing: boolean;
  canHandBack: boolean;
  helpOpen: boolean;
  agentDesignerOpen?: boolean;
  leaderboardModalOpen?: boolean;
  drawerOpen: boolean;
  coneMode: boolean;
  selectedVid: string | null;
  /** HUD mode is DRIVE (holding a wheel and the run is not dismissed). */
  driving: boolean;
  autopilot?: boolean;
  /** An order choice (`fareOffer`) is open on the driven vehicle. */
  fareOpen?: boolean;
  /** Active overlay sheet/menu (null = none). */
  overlay?: HotkeyOverlay;
  /** A menu flyout (Team Standings, Fleet, …) is open. */
  flyoutOpen?: boolean;
  /** The Floor-orders dispatch popover is open. */
  dispatchOpen?: boolean;
  /** A Dispatcher's Call minigame card is on screen. */
  dispatchersCallOpen?: boolean;
  /** A (non-minigame) A2UI screen is on screen. */
  a2uiOpen?: boolean;
}

/** The top layer for a hotkey context (see ui/modal.ts). */
export function hotkeyLayer(ctx: HotkeyContext): TopLayer {
  return topLayer({
    helpOpen: ctx.helpOpen,
    overlay: ctx.overlay ?? null,
    agentDesignerOpen: ctx.agentDesignerOpen,
    leaderboardModalOpen: ctx.leaderboardModalOpen,
    dispatchersCallOpen: ctx.dispatchersCallOpen,
    a2uiOpen: ctx.a2uiOpen,
  });
}

const isEnter = (ev: HotkeyEvent): boolean => ev.code === 'Enter' || ev.code === 'NumpadEnter';

export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const t = target as { tagName?: string; isContentEditable?: boolean };
  const tag = (t.tagName ?? '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
}

const PICK_DIGITS: Record<string, HotkeyAction> = { Digit1: 'pick:1', Digit2: 'pick:2', Digit3: 'pick:3' };
const ORDER_DIGITS: Record<string, HotkeyAction> = {
  Digit1: 'order:rush',
  Digit2: 'order:p0',
  Digit3: 'order:cones',
  Digit4: 'order:dispatch',
};

export function resolveHotkey(ev: HotkeyEvent, ctx: HotkeyContext): HotkeyAction | null {
  // Typing swallows every hotkey except Esc on an A2UI screen (its text field is usually focused).
  if (ctx.typing) return ev.code === 'Escape' && hotkeyLayer(ctx) === 'a2ui' ? 'closeA2ui' : null;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  const layer = hotkeyLayer(ctx);
  // From here on `overlay` is only ever a non-blocking card (chat / standings / menu) or null.
  const overlay = layer === 'chat' || layer === 'standings' || layer === 'menu' ? layer : null;
  if (ev.code === 'Escape') {
    switch (layer) {
      case 'intro':
        return 'closeHelp';
      case 'results':
      case 'pick':
        return 'closeOverlay';
      case 'agentDesigner':
        return 'closeAgentDesigner';
      case 'leaderboard':
        return 'closeLeaderboardModal';
      case 'dispatchersCall':
        return 'closeDispatchersCall';
      case 'a2ui':
        return 'closeA2ui';
      default:
        break;
    }
    if (overlay || ctx.flyoutOpen || ctx.dispatchOpen) return 'closeOverlay';
    if (ctx.coneMode) return 'exitCone';
    if (ctx.canHandBack) return 'handBack';
    if (ctx.selectedVid) return 'deselect';
    if (ctx.drawerOpen) return 'closeDrawer';
    return null;
  }
  if (ev.repeat) return null;
  // Blocking layers only get their own keys; nothing else fires behind them.
  switch (layer) {
    case 'intro':
      return isEnter(ev) ? 'intro:start' : null;
    case 'results':
      return isEnter(ev) ? 'results:again' : null;
    case 'pick':
      if (isEnter(ev)) return 'pick:keep';
      return PICK_DIGITS[ev.code] ?? null;
    case 'agentDesigner':
      return ev.code === 'KeyG' ? 'agentDesigner' : null;
    case 'leaderboard':
      return ev.code === 'KeyL' ? 'leaderboardModal' : null;
    case 'dispatchersCall':
    case 'a2ui':
      return null;
    default:
      break;
  }
  if (ev.key === '?') return 'help';
  switch (ev.code) {
    case 'Tab':
      return 'standings';
    case 'Enter':
    case 'NumpadEnter':
      if (ctx.dispatchOpen) return 'dispatch:send';
      return 'chat';
    case 'KeyM':
      return 'menu';
    case 'KeyV':
      return 'hudMinimal';
    case 'KeyR':
      return 'driveCamera';
    case 'KeyP':
      return 'cabView';
    case 'KeyC':
      return ctx.driving && !overlay ? 'toggleCopilot' : null;
    case 'KeyG':
      return 'agentDesigner';
    case 'KeyT':
      return ctx.selectedVid && !ctx.canHandBack ? 'takeWheel' : null;
    case 'KeyL':
      return 'leaderboardModal';
    case 'KeyH':
      return 'drawer';
    case 'KeyB':
      return ctx.driving ? null : 'board';
    case 'KeyQ':
      return ctx.driving && ctx.fareOpen ? 'fare:cycle' : null;
    case 'KeyF':
      if (ctx.driving) return ctx.fareOpen ? 'fare:confirm' : null;
      return 'drive';
    case 'Digit1':
    case 'Digit2':
    case 'Digit3':
    case 'Digit4':
      if (!ctx.driving && !overlay) return ORDER_DIGITS[ev.code] ?? null;
      return null;
    default:
      return null;
  }
}
