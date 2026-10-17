/**
 * Global hotkeys (pure resolver + documented table). Driving keys (WASD / arrows / E) are
 * handled by input.ts and only while driving.
 */

export type HotkeyAction =
  | 'hideHud'
  | 'handBack'
  | 'engageCopilot'
  | 'closeAgentDesigner'
  | 'closeHelp'
  | 'closeLeaderboardModal'
  | 'closeDrawer'
  | 'exitCone'
  | 'deselect'
  | 'takeWheel'
  | 'agentDesigner'
  | 'drawer'
  | 'leaderboardModal'
  | 'board'
  | 'layer:routes'
  | 'layer:traffic'
  | 'layer:labels'
  | 'cones'
  | 'help';

/** Documented in docs/gameplay.md (a test keeps the two in sync). */
export const HOTKEYS: ReadonlyArray<{ key: string; action: string }> = [
  { key: 'W A S D / arrows', action: 'Drive (instant manual takeover from Co-Pilot; only while driving)' },
  { key: 'Shift / Space', action: 'Speed boost (+65% speed; collisions drop carried pallets!)' },
  { key: 'E', action: 'Pick up / drop / charge (only while driving)' },
  { key: 'G', action: 'Open / close Co-Pilot & Agent Designer modal' },
  { key: 'T', action: 'Take the wheel of the selected vehicle' },
  { key: 'Esc', action: 'Close modal, hand back AI vehicle, or engage Co-Pilot Autopilot if driving manually' },
  { key: 'Tab', action: 'Hide / show all panels' },
  { key: 'L', action: 'Open / close the full Leaderboard & Silly Awards modal' },
  { key: 'H', action: 'Open / close the history drawer' },
  { key: 'B', action: 'Fold / unfold the Strategy Board' },
  { key: '1', action: 'Toggle the Routes layer' },
  { key: '2', action: 'Toggle the Traffic layer' },
  { key: '3', action: 'Toggle the Labels layer' },
  { key: 'C', action: 'Toggle cone mode' },
  { key: '?', action: 'Show help' },
];

export interface HotkeyEvent {
  key: string;
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

export interface HotkeyContext {
  typing: boolean;
  canHandBack: boolean;
  helpOpen: boolean;
  agentDesignerOpen?: boolean;
  leaderboardModalOpen?: boolean;
  drawerOpen: boolean;
  coneMode: boolean;
  selectedVid: string | null;
  driving: boolean;
  autopilot?: boolean;
}

export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const t = target as { tagName?: string; isContentEditable?: boolean };
  const tag = (t.tagName ?? '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
}

export function resolveHotkey(ev: HotkeyEvent, ctx: HotkeyContext): HotkeyAction | null {
  if (ctx.typing) return null;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  if (ev.code === 'Escape') {
    if (ctx.agentDesignerOpen) return 'closeAgentDesigner';
    if (ctx.canHandBack) return 'handBack';
    if (ctx.helpOpen) return 'closeHelp';
    if (ctx.leaderboardModalOpen) return 'closeLeaderboardModal';
    if (ctx.coneMode) return 'exitCone';
    if (ctx.driving && !ctx.autopilot) return 'engageCopilot';
    if (ctx.selectedVid) return 'deselect';
    if (ctx.drawerOpen) return 'closeDrawer';
    return null;
  }
  if (ev.repeat) return null;
  if (ev.key === '?') return 'help';
  switch (ev.code) {
    case 'Tab':
      return 'hideHud';
    case 'KeyG':
      return 'agentDesigner';
    case 'KeyT':
      return ctx.selectedVid && !ctx.canHandBack ? 'takeWheel' : null;
    case 'KeyL':
      return 'leaderboardModal';
    case 'KeyH':
      return 'drawer';
    case 'KeyB':
      return 'board';
    case 'Digit1':
      return 'layer:routes';
    case 'Digit2':
      return 'layer:traffic';
    case 'Digit3':
      return 'layer:labels';
    case 'KeyC':
      return 'cones';
    default:
      return null;
  }
}
