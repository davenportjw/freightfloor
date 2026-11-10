/**
 * Shareable result card (retention spec §3). Pure text builder plus a share fallback chain:
 * native share sheet → clipboard → caller shows a selectable text field. Never fails silently.
 *
 * The tape is the exact server `runTape` from the private `runSummary` message. Card titles are
 * never included (no spoilers).
 */
import type { RunMode } from '@warehouse/protocol';

/** Squares shown on the card; the rest are summarised as `+N`. */
export const SHARE_TAPE_CAP = 20;
/** Squares per line. */
export const SHARE_TAPE_WRAP = 10;
export const SHARE_DEFAULT_ORIGIN = 'https://freightfloor.com';

const SQUARE: Record<string, string> = { O: '🟩', L: '🟨', X: '🟥' };

export interface ShareDailyInfo {
  number: number;
  modifierLabel: string;
  /** Today's rank and entrants, once the server recorded the run. */
  rank?: number;
  of?: number;
  /** Current streak after this run. */
  streak?: number;
}

export interface ShareInput {
  runMode: RunMode;
  /** Server run tape (`O`/`L`/`X`). */
  tape: string;
  pts: number;
  deliveries: number;
  /** Present for Daily runs only. */
  daily?: ShareDailyInfo | null;
  /** Page origin used for the link (defaults to the public site). */
  origin?: string;
}

export interface ShareText {
  text: string;
  url: string;
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Tape rows: one square per event, capped at `SHARE_TAPE_CAP`, wrapped at `SHARE_TAPE_WRAP`. */
export function tapeRows(tape: string): string[] {
  const events = [...tape].filter((c) => c in SQUARE);
  const shown = events.slice(0, SHARE_TAPE_CAP);
  const rows: string[] = [];
  for (let i = 0; i < shown.length; i += SHARE_TAPE_WRAP) {
    rows.push(shown.slice(i, i + SHARE_TAPE_WRAP).map((c) => SQUARE[c]).join(''));
  }
  const extra = events.length - shown.length;
  if (extra > 0 && rows.length) rows[rows.length - 1] += ` +${extra}`;
  return rows;
}

function shareUrl(input: ShareInput): string {
  const origin = (input.origin || SHARE_DEFAULT_ORIGIN).replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (input.runMode === 'daily' && input.daily) params.set('daily', String(input.daily.number));
  params.set('utm_source', 'share');
  return `${origin}/?${params.toString()}`;
}

/**
 * Inbound share link `/?daily=N`: true when the page was opened from a Daily share (any number;
 * the client always plays today's Daily, so an old link still lands on today's).
 */
export function isDailyLink(search: string): boolean {
  const v = new URLSearchParams(search).get('daily');
  return v !== null && /^\d{1,6}$/.test(v);
}

const MODE_LABEL: Record<RunMode, string> = { blitz: 'Blitz', freerange: 'Free Range', daily: 'Daily' };

/** Builds the share text and link. Pure. */
export function buildShareText(input: ShareInput): ShareText {
  const url = shareUrl(input);
  const isDaily = input.runMode === 'daily' && Boolean(input.daily);
  const lines: string[] = [];
  if (isDaily && input.daily) {
    lines.push(`Freight Floor Daily #${input.daily.number} · ${input.daily.modifierLabel}`);
  } else {
    lines.push(`Freight Floor · ${MODE_LABEL[input.runMode] ?? 'Blitz'} run`);
  }
  lines.push(...tapeRows(input.tape));
  const stats = [`${fmt(input.pts)} pts`];
  if (isDaily && input.daily) {
    if (input.daily.rank && input.daily.of) stats.push(`#${fmt(input.daily.rank)} of ${fmt(input.daily.of)}`);
    if (input.daily.streak && input.daily.streak > 0) stats.push(`🔥${input.daily.streak}`);
  } else {
    stats.push(`${fmt(input.deliveries)} ${input.deliveries === 1 ? 'delivery' : 'deliveries'}`);
  }
  lines.push(stats.join(' · '));
  lines.push(url.replace(/^https?:\/\//, ''));
  return { text: lines.join('\n'), url };
}

/** Browser capabilities the share chain uses (injected for tests). */
export interface ShareNavigator {
  share?: (data: { text?: string; url?: string; title?: string }) => Promise<void>;
  clipboard?: { writeText?: (text: string) => Promise<void> };
}

export type ShareOutcome =
  /** Native share sheet completed. */
  | { status: 'shared' }
  /** User dismissed the share sheet; nothing else to do. */
  | { status: 'cancelled' }
  /** Text copied to the clipboard. */
  | { status: 'copied' }
  /** Neither worked: the caller must show `text` in a selectable field. */
  | { status: 'manual'; text: string; error: string };

const errText = (err: unknown): string => (err instanceof Error ? err.message || err.name : String(err));

/** Share sheet → clipboard → manual. */
export async function shareResult(share: ShareText, nav: ShareNavigator | undefined): Promise<ShareOutcome> {
  const errors: string[] = [];
  if (nav && typeof nav.share === 'function') {
    try {
      // The link is already the last line of the text; passing it again duplicates it on some targets.
      await nav.share({ text: share.text });
      return { status: 'shared' };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return { status: 'cancelled' };
      errors.push(`share: ${errText(err)}`);
    }
  }
  if (nav?.clipboard && typeof nav.clipboard.writeText === 'function') {
    try {
      await nav.clipboard.writeText(share.text);
      return { status: 'copied' };
    } catch (err) {
      errors.push(`clipboard: ${errText(err)}`);
    }
  }
  return {
    status: 'manual',
    text: share.text,
    error: errors.length ? errors.join('; ') : 'Sharing is not available in this browser.',
  };
}
