/**
 * HUD v3 mode + overlay resolution (pure, unit-tested).
 *
 * - `driving`: we hold a wheel (manual or Co-Pilot) and have not walked away from a finished run.
 * - `floor`: spectating / managing the floor (no wheel, or "Watch the floor" after a run).
 *
 * Overlay priority: results sheet > contract pick sheet > explicit overlay (chat / standings / menu).
 * A full-screen modal (Agent Designer / Leaderboard) opened over a sheet suspends the sheet until
 * it closes (see ui/modal.ts for the full single-modal policy).
 */
import type { CardHand } from '@warehouse/sim';
import type { UiOverlay } from '../state.js';
import { offerKey } from './cards.js';

export type HudMode = 'driving' | 'floor';
export type ActiveOverlay = 'results' | 'pick' | UiOverlay | null;

export interface ModeInput {
  driving: boolean;
  myVid: string | null;
  runFinished: boolean;
  runEndDismissedVid: string | null;
}

export function hudMode(s: ModeInput): HudMode {
  if (!s.driving) return 'floor';
  if (s.runFinished && s.myVid && s.runEndDismissedVid === s.myVid) return 'floor';
  return 'driving';
}

export interface OverlayInput {
  mode: HudMode;
  runEndOpen: boolean;
  hand: Pick<CardHand, 'offer' | 'pick'> | null;
  dealMinimizedKey: string | null;
  overlay: UiOverlay | null;
  /** Agent Designer or Leaderboard modal is open: sheets underneath are suspended (not active). */
  modalOpen?: boolean;
}

/** The initial deal (no `pick` → keep 1–3) is the pick SHEET; replacement draws live in the contracts card. */
export function pickSheetOpen(s: Pick<OverlayInput, 'mode' | 'hand' | 'dealMinimizedKey'>): boolean {
  if (s.mode !== 'driving' || !s.hand) return false;
  const offer = s.hand.offer;
  if (!offer || !offer.length || s.hand.pick != null) return false;
  return s.dealMinimizedKey !== offerKey(offer);
}

export function activeOverlay(s: OverlayInput): ActiveOverlay {
  if (s.modalOpen) return s.overlay;
  if (s.runEndOpen) return 'results';
  if (pickSheetOpen(s)) return 'pick';
  return s.overlay;
}
