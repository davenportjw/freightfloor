/**
 * Resume codes (pure, unit-tested). The lobby returns `resumeToken` (`wr1_` + 32 base64url chars)
 * on human joins; the client keeps it in localStorage and shows it as the player's "resume code".
 * Pasting it on another browser/device (sent in the join request's `resume` field) restores the
 * identity; the response's `clientId` is then adopted. A bare callsign only resumes on the same
 * browser that already owns it.
 */
import { RESUME_TOKEN_PATTERN } from '@warehouse/protocol';

export const RESUME_CODE_KEY = 'warehouse.resumeCode';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isResumeCode(value: unknown): value is string {
  return typeof value === 'string' && RESUME_TOKEN_PATTERN.test(value);
}

export function loadResumeCode(storage: KeyValueStorage | null): string | null {
  try {
    const v = storage?.getItem(RESUME_CODE_KEY) ?? null;
    return isResumeCode(v) ? v : null;
  } catch {
    return null;
  }
}

/** Persist a lobby-issued code; ignores anything that is not a well-formed code. */
export function saveResumeCode(storage: KeyValueStorage | null, code: unknown): boolean {
  if (!isResumeCode(code)) return false;
  try {
    storage?.setItem(RESUME_CODE_KEY, code);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate what the player typed into a Resume field before calling the lobby. Returns an error
 * message, or null when it may be sent (`resume` accepts 2–64 chars).
 */
export function resumeInputError(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'Enter an existing callsign or paste your resume code.';
  if (RESUME_TOKEN_PATTERN.test(v)) return null;
  if (/^wr1_/i.test(v)) return 'That resume code looks incomplete. Paste the whole code (it starts with wr1_).';
  if (v.length < 2 || v.length > 64) return 'Enter an existing callsign or paste your resume code (it starts with wr1_).';
  return null; // an existing callsign lookup: the lobby resolves it if it exists in the game
}

/** Human-readable lobby error for a failed `/api/join` or `/api/queue*` response. */
export function lobbyErrorMessage(status: number, body: { error?: string; message?: string } | null): string {
  const code = body?.error;
  if (code === 'invalid_resume_code') {
    return (
      body?.message ||
      'No existing driver callsign matches that name. Leave it blank to keep your assigned callsign, or enter an existing callsign / resume code.'
    );
  }
  if (code === 'queue_unavailable') {
    return `${body?.message || 'The waiting line is temporarily unavailable.'} (queue_unavailable, HTTP ${status}) Try again in a moment.`;
  }
  return body?.message || code || `HTTP ${status}`;
}
