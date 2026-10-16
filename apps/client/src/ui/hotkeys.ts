/**
 * Global hotkeys (pure resolver + documented table). Driving keys (WASD / arrows / E) are
 * handled by input.ts and only while driving.
 */

export type HotkeyAction =
  | 'hideHud'
  | 'handBack'
  | 'closeHelp'
  | 'closeDrawer'
  | 'exitCone'
  | 'deselect'
  | 'takeWheel'
  | 'drawer'
  | 'board'
  | 'layer:routes'
  | 'layer:traffic'
  | 'layer:labels'
  | 'cones'
  | 'help';

/** Documented in docs/gameplay.md (a test keeps the two in sync). */
export const HOTKEYS: ReadonlyArray<{ key: string; action: string }> = [
  { key: 'W A S D / arrows', action: 'Drive (only while driving)' },
  { key: 'E', action: 'Pick up / drop / charge (only while driving)' },
  { key: 'T', action: 'Take the wheel of the selected vehicle' },
  { key: 'Esc', action: 'Hand back if driving an agent, else close help, else exit cone mode, else deselect' },
  { key: 'Tab', action: 'Hide / show all panels' },
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
  drawerOpen: boolean;
  coneMode: boolean;
  selectedVid: string | null;
  driving: boolean;
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
    if (ctx.canHandBack) return 'handBack';
    if (ctx.helpOpen) return 'closeHelp';
    if (ctx.coneMode) return 'exitCone';
    if (ctx.selectedVid) return 'deselect';
    if (ctx.drawerOpen) return 'closeDrawer';
    return null;
  }
  if (ev.repeat) return null;
  if (ev.key === '?') return 'help';
  switch (ev.code) {
    case 'Tab':
      return 'hideHud';
    case 'KeyT':
      return ctx.selectedVid && !ctx.canHandBack ? 'takeWheel' : null;
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
