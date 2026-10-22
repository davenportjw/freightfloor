/**
 * Notification routing (replaces the old toast stack). Each event or client notice goes to exactly
 * one place, chosen by HUD mode:
 *
 *  - DRIVE: your own scoring/run events → the world popup over your forklift (`calloutFor`, plus
 *    the contracts card's row flash). Things you must act on (low battery, a spill on your route,
 *    relocation offers, server refusals/errors, your own interact hints) → the single alert line
 *    under the objective (`#alert`): one at a time, newest wins, auto-clears. Everything else
 *    (other trucks, trailers, poaching between others, transfers, other players' runs) is dropped.
 *  - FLOOR: one stream, the 3-item fading feed (`#feed`); client notices are merged into it
 *    (deduped). Floor-order refusals get one transient line above the orders bar (`#orderNote`,
 *    the cone-hint spot). Your own run summary lives in the floor banner (derived from state).
 *
 * Pure functions only; main.ts delivers the result.
 */
import type { SimEvent } from '@warehouse/sim';
import { calloutFor } from '../render/fx.js';
import type { HudMode } from './mode.js';

export type NoticeRoute = 'popup' | 'alert' | 'feed' | 'orderLine' | 'banner' | 'drop';

/**
 * Client-side notice kinds (things that used to be toasts but are not sim events):
 * `error` server/network failure · `refusal` the server said no (commandEcho not executed, a
 * blocked pick) · `hint` you must do something · `orderRefusal` a Floor order was refused ·
 * `relocation` surge relocation offer · `status` informational (resumed, starting a run, sent)
 * · `runSummary` your own run-complete summary.
 */
export type NoticeKind = 'error' | 'refusal' | 'hint' | 'orderRefusal' | 'relocation' | 'status' | 'runSummary';

export type AlertTone = 'bad' | 'warn';

/** Alert line lifetime (ms): ~4 s, errors ~5 s, the relocation offer (it has buttons) 8 s. */
export const ALERT_MS = 4000;
export const ALERT_ERROR_MS = 5000;
export const ALERT_ACTION_MS = 8000;
/** Floor-order refusal line lifetime (ms). */
export const ORDER_NOTE_MS = 4000;
/** A server `error` this soon after a Floor order (manager op) is treated as that order's refusal. */
export const ORDER_REFUSAL_WINDOW_MS = 3000;

export interface AlertState {
  text: string;
  tone: AlertTone;
  /** Wall-clock ms it was raised / expires. */
  at: number;
  until: number;
  /** Condition alerts (battery / spill) keep their category so the text can stay live. */
  cond?: string;
  /** Relocation alerts render Accept / dismiss buttons. */
  action?: 'relocation';
}

export interface FeedNote {
  text: string;
  tone: 'bad' | 'warn' | '';
  at: number;
}

/** Route a client notice by kind × mode. */
export function routeNotice(kind: NoticeKind, mode: HudMode): NoticeRoute {
  if (mode === 'driving') {
    switch (kind) {
      case 'error':
      case 'refusal':
      case 'hint':
      case 'orderRefusal':
      case 'relocation':
        return 'alert';
      case 'runSummary':
        return 'popup';
      default:
        return 'drop';
    }
  }
  switch (kind) {
    case 'orderRefusal':
      return 'orderLine';
    case 'runSummary':
      return 'banner';
    case 'relocation':
      // The relocation pill already shows in FLOOR; the feed would only duplicate it.
      return 'drop';
    default:
      return 'feed';
  }
}

/** In FLOOR, a server error shortly after a Floor order is that order's refusal. */
export function errorKind(mode: HudMode, now: number, lastOrderAt: number | null): NoticeKind {
  if (mode === 'floor' && lastOrderAt !== null && now - lastOrderAt <= ORDER_REFUSAL_WINDOW_MS) return 'orderRefusal';
  return 'error';
}

/**
 * Route a sim event. DRIVE: popup when it is one of *my* scoring/run events (has a callout),
 * alert for my own interact hints, otherwise drop. FLOOR: the feed (minus decisions / near-misses
 * / per-driver hints), except a floor-wide hint (no vehicle, e.g. "No free rack slot for a P0"),
 * which is the answer to a Floor order → the order line.
 */
export function routeSimEvent(
  ev: SimEvent,
  mode: HudMode,
  myVid: string | null,
  myKey: string | null,
): NoticeRoute {
  const vid = typeof ev.vid === 'string' ? ev.vid : null;
  if (mode === 'driving') {
    if (ev.type === 'hint') return vid !== null && vid === myVid ? 'alert' : 'drop';
    return calloutFor(ev, myVid, myKey) ? 'popup' : 'drop';
  }
  if (ev.type === 'hint') return vid === null ? 'orderLine' : 'drop';
  if (ev.type === 'nearmiss' || ev.type === 'decision') return 'drop';
  return 'feed';
}

/** Build the alert for a notice (newest wins: the caller just replaces the current one). */
export function noticeAlert(kind: NoticeKind, text: string, now: number): AlertState {
  const ms = kind === 'error' ? ALERT_ERROR_MS : kind === 'relocation' ? ALERT_ACTION_MS : ALERT_MS;
  return {
    text,
    tone: kind === 'error' || kind === 'refusal' ? 'bad' : 'warn',
    at: now,
    until: now + ms,
    action: kind === 'relocation' ? 'relocation' : undefined,
  };
}

/** The alert to show now (null once it expired). */
export function activeAlert(a: AlertState | null, now: number): AlertState | null {
  return a && now < a.until ? a : null;
}

/** Feed notes: newest first, deduped by text (a repeat refreshes it), at most `max`. */
export function pushFeedNote(notes: ReadonlyArray<FeedNote>, note: FeedNote, max = 3): FeedNote[] {
  return [note, ...notes.filter((n) => n.text !== note.text)].slice(0, max);
}

/** Feed tone for a client notice. */
export function noticeTone(kind: NoticeKind): FeedNote['tone'] {
  return kind === 'error' || kind === 'refusal' || kind === 'orderRefusal' ? 'bad' : kind === 'hint' ? 'warn' : '';
}

/** Join a notice's headline and detail into one line. */
export function noticeText(text: string, extra?: string): string {
  return extra ? `${text} — ${extra}` : text;
}

/**
 * Short player-facing copy for server `error` codes whose raw message is not meant for players.
 * Unknown codes keep the server's own message (it is already written for the HUD).
 */
export const SERVER_ERROR_COPY: Readonly<Record<string, string>> = {
  internal_error: 'Something went wrong on the site. Try again.',
  spectator_forbidden: 'Spectators cannot send floor commands. Take a forklift first.',
  vehicle_changed: 'Your forklift changed before the Co-Pilot answered. Send it again.',
};

export function serverErrorText(code: string, message: string): string {
  return SERVER_ERROR_COPY[code] ?? message;
}
