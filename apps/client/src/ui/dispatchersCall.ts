/**
 * Dispatcher's Call (client side): flag override, minigame card state and the reveal line.
 *
 * The site sends an `a2uiScreen` with `minigame` to the driver it is for. The card shows the
 * question, 2–3 option chips and an 8 s countdown ring. A pick sends
 * `a2uiAction { screenId: id, actionId: 'dc-opt-<idx>' }` (the server executes its stored
 * option). The `dispatchersCallReveal` message then shows whether you and Gemini agreed;
 * the scored outcome arrives later as the `dispatchers_call_result` event popup.
 */
import type { A2uiScreenMessage, DispatchersCallMinigame, DispatchersCallRevealMessage } from '@warehouse/protocol';

export const DISPATCHERS_CALL_KEY = 'warehouse.feature.dispatchersCall';
export const DISPATCHERS_CALL_ACTION_PREFIX = 'dc-opt-';
/** How long the card lingers showing the reveal (ms). */
export const DC_REVEAL_MS = 5000;
/** Grace after the deadline before an unrevealed card closes (ms). */
export const DC_GRACE_MS = 3000;

/** `?dispatch=1|0` beats localStorage; null = follow the server (`welcome.limits.dispatchersCall`). */
export function readDispatchersCallOverride(): boolean | null {
  try {
    if (typeof window !== 'undefined' && window.location?.search) {
      const q = new URLSearchParams(window.location.search).get('dispatch');
      if (q === '1' || q === 'true') return true;
      if (q === '0' || q === 'false') return false;
    }
  } catch {
    /* ignore URL parsing errors */
  }
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem(DISPATCHERS_CALL_KEY);
      if (v === '1') return true;
      if (v === '0') return false;
    }
  } catch {
    /* storage unavailable */
  }
  return null;
}

export function saveDispatchersCallPref(on: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(DISPATCHERS_CALL_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

export interface DispatchersCallCard {
  minigame: DispatchersCallMinigame;
  /** Wall-clock ms the screen arrived (the deadline counts from here). */
  receivedAt: number;
  picked: number | null;
  reveal: DispatchersCallRevealMessage | null;
  revealAt: number | null;
}

export function isDispatchersCallScreen(
  msg: A2uiScreenMessage,
): msg is A2uiScreenMessage & { minigame: DispatchersCallMinigame } {
  return msg.minigame?.kind === 'dispatchers_call';
}

export function newDispatchersCallCard(minigame: DispatchersCallMinigame, now: number): DispatchersCallCard {
  return { minigame, receivedAt: now, picked: null, reveal: null, revealAt: null };
}

/** Remaining fraction of the pick window, 1 → 0. */
export function dcTimeLeft(card: DispatchersCallCard, now: number): number {
  const d = Math.max(1, card.minigame.deadlineMs);
  return Math.max(0, Math.min(1, 1 - (now - card.receivedAt) / d));
}

/** Seconds left on the pick window (ceil), for the ring label. */
export function dcSecondsLeft(card: DispatchersCallCard, now: number): number {
  return Math.max(0, Math.ceil((card.minigame.deadlineMs - (now - card.receivedAt)) / 1000));
}

/** Can the player still pick? */
export function dcCanPick(card: DispatchersCallCard, now: number): boolean {
  return card.picked == null && card.reveal == null && dcTimeLeft(card, now) > 0;
}

/** Should the card still be on screen? */
export function dcVisible(card: DispatchersCallCard, now: number): boolean {
  if (card.revealAt != null) return now - card.revealAt < DC_REVEAL_MS;
  return now - card.receivedAt < card.minigame.deadlineMs + DC_GRACE_MS;
}

/** Attach a reveal if it belongs to this card. */
export function dcApplyReveal(
  card: DispatchersCallCard | null,
  reveal: DispatchersCallRevealMessage,
  now: number,
): DispatchersCallCard | null {
  if (!card || card.minigame.id !== reveal.id) return card;
  return { ...card, reveal, revealAt: now, picked: reveal.playerIdx ?? card.picked };
}

/** "You and Gemini agreed" / "Gemini would have picked X: reason". */
export function dcRevealLine(reveal: DispatchersCallRevealMessage): string {
  if (reveal.agreed) return `You and Gemini agreed: ${reveal.geminiReason}`;
  const lead = reveal.timedOut ? "Time's up. " : '';
  return `${lead}Gemini would have picked “${reveal.geminiLabel}”: ${reveal.geminiReason}`;
}

export function dcActionId(idx: number): string {
  return `${DISPATCHERS_CALL_ACTION_PREFIX}${idx}`;
}
